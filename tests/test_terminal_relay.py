"""terminal_relay: model relay over a Unix socket to a fake TLS upstream (127.0.0.1 only, fake tokens)."""
import os
import shutil
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_relay as tr  # noqa: E402
from tests import fake_model_upstream as fu  # noqa: E402

FAKE_TOKEN = 'sk-ant-oat01-FAKE-test-token-0123456789abcdefghij'
BODY = b'{"model": "claude-test", "stream": true, "max_tokens": 8, "messages": []}'


def request(path, extra=b'', body=BODY, method=b'POST', target=b'/v1/messages?beta=true', length=None):
    head = (method + b' ' + target + b' HTTP/1.1\r\nHost: 127.0.0.1:3129\r\nContent-Type: application/json\r\n'
            b'Authorization: Bearer dummy-from-cli\r\nx-api-key: leaked\r\nCookie: a=b\r\nProxy-Authorization: p\r\n'
            b'anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14\r\nanthropic-version: 2023-06-01\r\n'
            b'x-stainless-lang: js\r\nx-claude-code-session-id: 1234\r\nX-Unknown: drop-me\r\n' + extra +
            b'Content-Length: ' + str(len(body) if length is None else length).encode() + b'\r\n\r\n')
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(20)
    sock.connect(path)
    sock.sendall(head + body)
    return sock


def read_all(sock):
    data = b''
    while True:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            break
        if not chunk:
            break
        data += chunk
    sock.close()
    return data


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = Path(tempfile.mkdtemp(prefix='relay-', dir=os.environ.get('TMPDIR')))
        cls.cert, cls.key = fu.make_cert(cls.base / 'tls')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix='r', dir=self.base))
        self.root = self.dir / 'root'
        self.root.mkdir()
        self.token_path = self.dir / 'token'
        fd = os.open(self.token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, FAKE_TOKEN.encode() + b'\n')
        os.close(fd)
        self.hold = None
        self.upstream = fu.FakeUpstream(self.cert, self.key)
        self.logs = []
        self.live = True
        self.relay = self.make_relay()
        self.sock_path = str(self.dir / 'model.sock')
        self.rs = self.relay.open_session(self.sock_path, self.gate)

    def make_relay(self, **limits):
        return tr.ModelRelay(tr.TokenFile(self.token_path, self.root), upstream=('127.0.0.1', self.upstream.port),
                             ssl_context=fu.client_context(self.cert), log=self.logs.append, **limits)

    def gate(self):
        return (tr.CLAUDE_RULE, None) if self.live else (None, (403, 'agent_not_running'))

    def tearDown(self):
        self.relay.close()
        self.upstream.close()

    def test_forwards_with_real_bearer_and_drops_cli_credentials(self):
        reply = read_all(request(self.sock_path))
        self.assertTrue(reply.startswith(b'HTTP/1.1 200'), reply[:100])
        self.assertIn(b'FAKE-REPLY-OK', reply)
        self.assertIn(b'Connection: close', reply)
        self.assertNotIn(b'keep-alive', reply.split(b'\r\n\r\n')[0].lower())
        self.assertNotIn(b'set-cookie', reply.lower())
        req = self.upstream.requests[-1]
        h = req['headers']
        self.assertEqual((req['method'], req['target']), ('POST', '/v1/messages?beta=true'))
        self.assertEqual(h['authorization'], [f'Bearer {FAKE_TOKEN}'])
        self.assertEqual(h['host'], ['127.0.0.1'] if self.upstream.port == 443 else [f'127.0.0.1:{self.upstream.port}'])
        for gone in ('x-api-key', 'cookie', 'proxy-authorization', 'x-unknown'):
            self.assertNotIn(gone, h)
        betas = h['anthropic-beta'][0].split(',')
        self.assertEqual(betas[:2], ['claude-code-20250219', 'interleaved-thinking-2025-05-14'])
        self.assertIn(tr.OAUTH_BETA, betas)
        self.assertEqual(h['accept-encoding'], ['identity'])
        self.assertEqual(h['connection'], ['close'])
        self.assertEqual(h['x-stainless-lang'], ['js'])
        self.assertEqual(h['x-claude-code-session-id'], ['1234'])
        self.assertEqual(req['body'], BODY)

    def test_response_is_streamed_not_buffered(self):
        self.upstream.close()
        hold = threading.Event()
        self.upstream = fu.FakeUpstream(self.cert, self.key, hold=hold)
        self.relay.upstream_override = ('127.0.0.1', self.upstream.port)
        sock = request(self.sock_path)
        data = b''
        while b'message_start' not in data:
            chunk = sock.recv(65536)
            self.assertTrue(chunk, 'connection closed before the first event')
            data += chunk
        self.assertNotIn(b'message_stop', data)  # upstream is still holding the rest
        hold.set()
        data += read_all(sock)
        self.assertIn(b'message_stop', data)

    def test_only_allowed_methods_paths_and_queries(self):
        cases = [(b'GET', b'/v1/messages'), (b'POST', b'/v1/models'), (b'POST', b'/v1/messages?beta=false'),
                 (b'POST', b'/v1/messages/../models'), (b'POST', b'/api/oauth/profile'), (b'PUT', b'/v1/messages'),
                 (b'POST', b'/v1/messages?beta=true&x=1')]
        for method, target in cases:
            reply = read_all(request(self.sock_path, method=method, target=target))
            self.assertTrue(reply.startswith(b'HTTP/1.1 403'), (method, target, reply[:60]))
        ok = read_all(request(self.sock_path, target=b'/v1/messages/count_tokens?beta=true',
                              body=b'{"model": "m", "messages": []}'))
        self.assertTrue(ok.startswith(b'HTTP/1.1 200'))
        self.assertEqual([r['target'] for r in self.upstream.requests], ['/v1/messages/count_tokens?beta=true'])

    def test_strict_head_parsing(self):
        bad = [
            (b'Transfer-Encoding: chunked\r\n', 400),
            (b'Content-Length: 5\r\n', 411),          # two Content-Length headers
            (b' folded: value\r\n', 400),
            (b'Bad Header: x\r\n', 400),
            (b'X-Ctl: a\x01b\r\n', 400),
        ]
        for extra, status in bad:
            reply = read_all(request(self.sock_path, extra=extra))
            self.assertTrue(reply.startswith(b'HTTP/1.1 %d' % status), (extra, reply[:60]))
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(self.sock_path)
        sock.sendall(b'POST /v1/messages HTTP/1.0\r\nContent-Length: 0\r\n\r\n')
        self.assertTrue(read_all(sock).startswith(b'HTTP/1.1 400'))
        self.assertEqual(self.upstream.requests, [])

    def test_body_cap_and_pipelining(self):
        reply = read_all(request(self.sock_path, body=b'', length=tr.BODY_MAX + 1))
        self.assertTrue(reply.startswith(b'HTTP/1.1 413'))
        sock = request(self.sock_path, body=BODY + b'GET / HTTP/1.1\r\n\r\n', length=len(BODY))
        self.assertTrue(read_all(sock).startswith(b'HTTP/1.1 400'))
        self.assertEqual(self.upstream.requests, [])

    def test_head_deadline_is_total_not_per_read(self):
        self.relay.close()
        self.relay = self.make_relay(head_deadline=1.0)
        self.rs = self.relay.open_session(self.sock_path, self.gate)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(self.sock_path)
        started = time.monotonic()
        try:
            for ch in b'POST /v1/messages HTTP/1.1\r\nHost: x\r\n':
                sock.send(bytes([ch]))
                time.sleep(0.1)
        except OSError:
            pass
        reply = read_all(sock)
        self.assertTrue(reply.startswith(b'HTTP/1.1 408'), reply[:60])
        self.assertLess(time.monotonic() - started, 6)

    def test_gate_refuses_without_a_live_agent(self):
        self.live = False
        reply = read_all(request(self.sock_path))
        self.assertTrue(reply.startswith(b'HTTP/1.1 403'))
        self.assertIn(b'agent_not_running', reply)
        self.assertEqual(self.upstream.requests, [])

    def test_missing_login_is_503_and_nothing_is_sent(self):
        os.unlink(self.token_path)
        reply = read_all(request(self.sock_path))
        self.assertTrue(reply.startswith(b'HTTP/1.1 503'))
        self.assertIn(b'login_missing', reply)
        self.assertEqual(self.upstream.requests, [])

    def test_upstream_tls_is_verified(self):
        self.relay.ssl_context = __import__('ssl').create_default_context()  # system CAs do not trust the test cert
        reply = read_all(request(self.sock_path))
        self.assertTrue(reply.startswith(b'HTTP/1.1 502'), reply[:60])
        self.assertIn(b'upstream_tls_failed', reply)

    def test_concurrency_caps(self):
        self.relay.close()
        hold = threading.Event()
        self.upstream.close()
        self.upstream = fu.FakeUpstream(self.cert, self.key, hold=hold)
        self.relay = self.make_relay(max_session=2, max_total=3)
        self.rs = self.relay.open_session(self.sock_path, self.gate)
        other_path = str(self.dir / 'other.sock')
        self.relay.open_session(other_path, self.gate)
        held = [request(self.sock_path), request(self.sock_path)]
        for sock in held:
            self.assertIn(b'message_start', sock.recv(65536) + sock.recv(65536))
        third = read_all(request(self.sock_path))
        self.assertTrue(third.startswith(b'HTTP/1.1 503'), third[:60])  # per-session cap
        held.append(request(other_path))
        self.assertIn(b'HTTP/1.1 200', held[-1].recv(65536))
        fourth = read_all(request(other_path))
        self.assertTrue(fourth.startswith(b'HTTP/1.1 503'))  # total cap
        hold.set()
        for sock in held:
            read_all(sock)
        deadline = time.monotonic() + 10
        while self.relay.total and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.relay.total, 0)

    def test_socket_is_0600_and_nothing_is_logged(self):
        self.assertEqual(stat.S_IMODE(os.lstat(self.sock_path).st_mode), 0o600)
        read_all(request(self.sock_path))
        read_all(request(self.sock_path, target=b'/v1/models'))
        joined = '\n'.join(self.logs)
        for secret in (FAKE_TOKEN, 'dummy-from-cli', 'leaked', '/v1/'):
            self.assertNotIn(secret, joined)

    def test_close_session_removes_the_listener(self):
        self.relay.close_session(self.rs)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        with self.assertRaises(OSError):
            sock.connect(self.sock_path)
            sock.sendall(b'x')
            if not sock.recv(1):
                raise ConnectionResetError
        sock.close()


class TokenFileTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix='tok-', dir=os.environ.get('TMPDIR')))
        self.root = self.dir / 'root'
        self.root.mkdir()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, path, data, mode=0o600):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        os.write(fd, data)
        os.close(fd)
        os.chmod(path, mode)

    def test_reasons(self):
        path = self.dir / 'token'
        self.assertEqual(tr.TokenFile(None, self.root).status(), (False, 'not_configured'))
        self.assertEqual(tr.TokenFile(path, self.root).status(), (False, 'missing'))
        self.write(path, FAKE_TOKEN.encode(), 0o640)
        self.assertEqual(tr.TokenFile(path, self.root).status(), (False, 'bad_mode'))
        self.write(path, b'short', 0o600)
        self.assertEqual(tr.TokenFile(path, self.root).status(), (False, 'invalid'))
        self.write(path, b'two words here and more text', 0o600)
        self.assertEqual(tr.TokenFile(path, self.root).status(), (False, 'invalid'))
        self.write(path, FAKE_TOKEN.encode() + b'\n', 0o600)
        self.assertEqual(tr.TokenFile(path, self.root).status(), (True, None))
        self.assertEqual(tr.TokenFile(path, self.root).read(), FAKE_TOKEN)
        link = self.dir / 'link'
        link.symlink_to(path)
        self.assertEqual(tr.TokenFile(link, self.root).status(), (False, 'symlink'))
        folder = self.dir / 'folder'
        folder.mkdir(mode=0o700)
        self.assertEqual(tr.TokenFile(folder, self.root).status(), (False, 'not_a_file'))
        inside = self.root / 'token'
        self.write(inside, FAKE_TOKEN.encode())
        self.assertEqual(tr.TokenFile(inside, self.root).status(), (False, 'inside_root'))
        with self.assertRaises(ValueError):
            tr.TokenFile.check_path(inside, self.root)
        sneaky = self.dir / 'via-link'
        sneaky.symlink_to(self.root)
        with self.assertRaises(ValueError):
            tr.TokenFile.check_path(sneaky / 'token', self.root)
        # A sibling whose name starts like the root is not inside it.
        sibling = self.dir / 'root2'
        sibling.mkdir()
        self.assertEqual(tr.TokenFile.check_path(sibling / 't', self.root), str(sibling / 't'))

    def test_reason_messages_never_contain_the_token(self):
        for message in tr.TOKEN_REASONS.values():
            self.assertNotIn('sk-ant', message)


if __name__ == '__main__':
    unittest.main()
