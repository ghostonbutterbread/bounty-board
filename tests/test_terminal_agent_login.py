"""Sandbox login set from Settings (POST /api/agent/login, /api/agent/logout) and the
optional ``note`` on a poc_format task. Every token here is fake; nothing reaches Anthropic
(the relay talks to tests/fake_model_upstream.py)."""
import http.client
import json
import os
import shutil
import stat
import sys
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_report_agent as ra  # noqa: E402
import terminal_relay as tr  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
import terminal_service as ts  # noqa: E402
from tests import fake_model_upstream as fu  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402

BOARD = '127.0.0.1:18904'
ORIGIN = f'http://{BOARD}'
FAKE_CLI = Path(__file__).resolve().parent / 'fake_agent_cli.py'
# Sentinels: fake setup tokens whose distinctive parts are greppable everywhere.
SENTINEL_A = 'sk-ant-oat01-SENTINELalphaQ7x9-FAKEFAKEFAKE_0123456789abcdef'
SENTINEL_B = 'sk-ant-oat01-SENTINELbravoK2m4-FAKEFAKEFAKE_fedcba9876543210'
MARKS = ('SENTINEL', 'FAKEFAKEFAKE', 'Q7x9', 'K2m4')


def leaked(text):
    return [m for m in MARKS if m in text]


class TokenFileWriteTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('login-unit')
        self.root = self.base / 'root'
        self.root.mkdir()
        self.conf = self.base / 'conf'
        self.conf.mkdir(mode=0o700)
        os.chmod(self.conf, 0o700)
        self.path = self.conf / 'report-agent.token'

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def code(self, fn):
        with self.assertRaises(tr.TokenError) as caught:
            fn()
        self.assertEqual(leaked(str(caught.exception)), [])
        return caught.exception.code

    def test_save_writes_0600_and_reads_back(self):
        token = tr.TokenFile(self.path, self.root)
        token.save(SENTINEL_A)
        info = os.lstat(self.path)
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(token.read(), SENTINEL_A)
        self.assertIsInstance(token.saved_at(), int)
        token.save(SENTINEL_B)
        self.assertEqual(token.read(), SENTINEL_B)
        self.assertEqual(stat.S_IMODE(os.lstat(self.path).st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.conf)), ['report-agent.token'], 'no temp file left')

    def test_bad_shapes_are_refused(self):
        token = tr.TokenFile(self.path, self.root)
        for bad in ('', 'sk-ant-api03-' + 'a' * 40, 'sk-ant-oat01-short', 'sk-ant-oat01-' + 'a' * 600,
                    'sk-ant-oat01-has space-' + 'a' * 30, 'sk-ant-oat01-' + 'a' * 30 + '\n', 'x' + SENTINEL_A, None, 7):
            self.assertEqual(self.code(lambda: token.save(bad)), 'invalid', repr(bad)[:40])
        self.assertFalse(self.path.exists())

    def test_refusals_symlinks_root_and_unsafe_dirs(self):
        # symlinked target
        elsewhere = self.base / 'elsewhere'
        elsewhere.write_text('keep\n')
        os.symlink(elsewhere, self.path)
        token = tr.TokenFile(self.path, self.root)
        self.assertEqual(self.code(lambda: token.save(SENTINEL_A)), 'symlink')
        self.assertEqual(self.code(token.remove), 'symlink')
        self.assertEqual(elsewhere.read_text(), 'keep\n', 'the link target is never written or removed')
        os.unlink(self.path)
        # symlinked directory
        linkdir = self.base / 'linkdir'
        os.symlink(self.conf, linkdir)
        self.assertEqual(self.code(lambda: tr.TokenFile(linkdir / 'report-agent.token', self.root).save(SENTINEL_A)), 'dir_symlink')
        # inside the root, directly and through a symlinked parent
        (self.root / 'cfg').mkdir(mode=0o700)
        self.assertEqual(self.code(lambda: tr.TokenFile(self.root / 'cfg' / 't', self.root).save(SENTINEL_A)), 'inside_root')
        sneaky = self.base / 'sneaky'
        os.symlink(self.root / 'cfg', sneaky)
        self.assertEqual(self.code(lambda: tr.TokenFile(sneaky / 't', self.root).save(SENTINEL_A)), 'inside_root')
        # group- or other-writable directory
        open_dir = self.base / 'open'
        open_dir.mkdir()
        os.chmod(open_dir, 0o770)
        self.assertEqual(self.code(lambda: tr.TokenFile(open_dir / 't', self.root).save(SENTINEL_A)), 'dir_unsafe')
        # the parent is never created
        self.assertEqual(self.code(lambda: tr.TokenFile(self.base / 'nope' / 't', self.root).save(SENTINEL_A)), 'dir_missing')
        self.assertFalse((self.base / 'nope').exists())
        # not configured
        self.assertEqual(self.code(lambda: tr.TokenFile(None, self.root).save(SENTINEL_A)), 'not_configured')
        # a directory at the target name
        self.path.mkdir()
        self.assertEqual(self.code(lambda: token.save(SENTINEL_A)), 'not_a_file')
        self.assertEqual(self.code(token.remove), 'not_a_file')
        for path in (self.root, self.conf, self.base):
            for dirpath, _, files in os.walk(path):
                for name in files:
                    self.assertEqual(leaked(Path(dirpath, name).read_text(errors='replace')), [], name)

    def test_remove_only_that_file(self):
        token = tr.TokenFile(self.path, self.root)
        token.save(SENTINEL_A)
        neighbour = self.conf / 'terminal.hash'
        neighbour.write_text('other\n')
        token.remove()
        self.assertFalse(self.path.exists())
        self.assertEqual(neighbour.read_text(), 'other\n')
        token.remove()  # already gone: fine
        self.assertEqual(token.status(), (False, 'missing'))

    def test_concurrent_saves_never_leave_a_partial_file(self):
        token = tr.TokenFile(self.path, self.root)
        token.save(SENTINEL_A)
        tokens = [f'sk-ant-oat01-FAKE{i:03d}' + chr(97 + i % 26) * (40 + i * 7) for i in range(24)]
        stop = threading.Event()
        bad = []

        def reader():
            while not stop.is_set():
                try:
                    value = token.read()
                except tr.TokenError as error:
                    bad.append(error.code)
                    continue
                if value not in tokens and value != SENTINEL_A:
                    bad.append(len(value))

        readers = [threading.Thread(target=reader) for _ in range(3)]
        writers = [threading.Thread(target=token.save, args=(t,)) for t in tokens * 3]
        for thread in readers + writers:
            thread.start()
        for thread in writers:
            thread.join()
        stop.set()
        for thread in readers:
            thread.join()
        self.assertEqual(bad, [], 'every read saw one whole token')
        self.assertIn(token.read(), tokens)
        self.assertEqual(sorted(os.listdir(self.conf)), ['report-agent.token'])


class LoginServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = fx.tmp_base('login')
        cls.root = fx.make_root(cls.base)
        cls.cert, cls.key = fu.make_cert(cls.base / 'tls')
        cls.upstream = fu.FakeUpstream(cls.cert, cls.key)
        cls.conf = cls.base / 'conf'
        cls.conf.mkdir(mode=0o700)
        os.chmod(cls.conf, 0o700)
        cls.token_path = cls.conf / 'report-agent.token'
        cls.logs = []
        cls.hub = ra.ReportAgentHub(enabled=True, root=cls.root, state_dir=cls.base / 'state', clis={'claude': str(FAKE_CLI)},
                                    token_file=cls.token_path, relay_upstream=('127.0.0.1', cls.upstream.port),
                                    relay_ssl_context=fu.client_context(cls.cert), stop_grace=1.0, log=cls.logs.append)
        cls.server = ts.make_service(cls.root, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'],
                                     state_dir=cls.base / 'state', backend=sb.LocalBackend(cls.base / 'local'),
                                     reap_interval=0, min_free_memory=0, report_agent=cls.hub)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.raw = []   # every response body, for the leak check

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.upstream.close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        if self.token_path.exists():
            os.unlink(self.token_path)

    def tearDown(self):
        self.request('POST', '/terminal/api/agent/stop', {'selector': fx.selector()})
        captured = '\n'.join(self.raw) + '\n'.join(self.logs)
        self.assertEqual(leaked(captured), [], 'a token reached a response or a log line')

    def request(self, method, path, body=None, tailnet=True, origin=True, csrf=True, raw_body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=60)
        headers = {'Host': BOARD}
        if tailnet:
            headers['Tailscale-User-Login'] = 'ryu@example.test'
        if origin:
            headers['Origin'] = ORIGIN
        data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else b'')
        if body is not None or raw_body is not None:
            headers['Content-Type'] = 'application/json'
            if csrf:
                headers['X-Requested-With'] = 'Bounty-Board'
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for key, value in headers.items():
            conn.putheader(key, value)
        conn.putheader('Content-Length', str(len(data)))
        conn.endheaders(data)
        response = conn.getresponse()
        text = response.read().decode('utf-8', 'replace')
        conn.close()
        self.raw.append(text)
        return response.status, json.loads(text)

    def login(self, token, **extra):
        return self.request('POST', '/terminal/api/agent/login', {'cli': 'claude', 'token': token}, **extra)

    def test_save_config_and_logout(self):
        status, config = self.request('GET', '/terminal/api/agent/config')
        self.assertEqual(config['login'], {'ready': False, 'reason': 'missing', 'message': tr.TOKEN_REASONS['missing'],
                                           'saved_at': None, 'editable': True})
        status, payload = self.login('  ' + SENTINEL_A + '\n')   # stripped
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {'login'})
        self.assertEqual(set(payload['login']), {'ready', 'reason', 'message', 'saved_at', 'editable'})
        self.assertTrue(payload['login']['ready'])
        self.assertAlmostEqual(payload['login']['saved_at'], time.time(), delta=5)
        self.assertNotIn('sk-ant', json.dumps(payload))
        self.assertEqual(stat.S_IMODE(os.lstat(self.token_path).st_mode), 0o600)
        self.assertEqual(self.token_path.read_text(), SENTINEL_A + '\n')
        status, config = self.request('GET', '/terminal/api/agent/config')
        self.assertTrue(config['login']['ready'] and config['login']['editable'])
        neighbour = self.conf / 'keep.txt'
        neighbour.write_text('keep\n')
        status, payload = self.request('POST', '/terminal/api/agent/logout', {'cli': 'claude'})
        self.assertEqual((status, payload['login']['ready'], payload['login']['reason']), (200, False, 'missing'))
        self.assertFalse(self.token_path.exists())
        self.assertEqual(neighbour.read_text(), 'keep\n')
        neighbour.unlink()

    def test_bad_shapes_and_bodies_are_refused_without_echo(self):
        for token in ('sk-ant-api03-' + 'a' * 40, 'Bearer ' + SENTINEL_A, SENTINEL_A[:20], SENTINEL_A + ' extra',
                      SENTINEL_A.replace('-', '‮', 1), 'SENTINEL-not-a-token'):
            status, payload = self.login(token)
            self.assertEqual((status, payload['error']), (400, 'bad_token'), token[:24])
            self.assertEqual(payload['message'], 'That is not a Claude setup token. Run claude setup-token on Hoster and paste the whole token.')
        for body in ({'cli': 'claude'}, {'token': SENTINEL_A}, {'cli': 'codex', 'token': SENTINEL_A},
                     {'cli': 'claude', 'token': SENTINEL_A, 'extra': 1}, {'cli': 'claude', 'token': ['x']}):
            status, payload = self.request('POST', '/terminal/api/agent/login', body)
            self.assertEqual((status, payload['error']), (400, 'bad_request'))
        big = json.dumps({'cli': 'claude', 'token': SENTINEL_A + 'a' * 4100}).encode()
        status, payload = self.request('POST', '/terminal/api/agent/login', raw_body=big)
        self.assertEqual((status, payload['error']), (400, 'length'), 'body cap 4 KiB')
        self.assertEqual(self.request('POST', '/terminal/api/agent/logout', {'cli': 'claude', 'x': 1})[0], 400)
        self.assertFalse(self.token_path.exists())

    def test_gate_refuses_before_anything_is_written(self):
        self.assertEqual(self.login(SENTINEL_A, origin=False)[0], 403)
        self.assertEqual(self.login(SENTINEL_A, csrf=False)[0], 403)
        self.assertEqual(self.login(SENTINEL_A, tailnet=False)[0], 401)
        self.assertEqual(self.request('POST', '/terminal/api/agent/login', raw_body=b'{"cli":"claude","token":"' + SENTINEL_A.encode() + b'"}',
                                      csrf=True, origin=False)[0], 403)
        self.assertFalse(self.token_path.exists())
        self.login(SENTINEL_A)
        for extra in ({'origin': False}, {'csrf': False}, {'tailnet': False}):
            self.assertIn(self.request('POST', '/terminal/api/agent/logout', {'cli': 'claude'}, **extra)[0], (401, 403))
        self.assertTrue(self.token_path.exists(), 'logout refused without the gate')

    def test_refusals_symlink_target(self):
        target = self.base / 'target.txt'
        target.write_text('keep\n')
        os.symlink(target, self.token_path)
        try:
            status, payload = self.login(SENTINEL_A)
            self.assertEqual((status, payload['error'], payload['reason']), (409, 'login_not_saved', 'symlink'))
            status, payload = self.request('POST', '/terminal/api/agent/logout', {'cli': 'claude'})
            self.assertEqual((status, payload['reason']), (409, 'symlink'))
            self.assertEqual(target.read_text(), 'keep\n')
        finally:
            os.unlink(self.token_path)

    def test_replaced_login_applies_to_the_next_model_call(self):
        def bearer_after_start():
            before = len(self.upstream.requests)
            status, _ = self.request('POST', '/terminal/api/agent/start',
                                     {'selector': fx.selector(), 'task': {'kind': 'poc_format', 'format': 'curl'}})
            self.assertEqual(status, 200)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and len(self.upstream.requests) <= before:
                time.sleep(0.1)
            self.assertGreater(len(self.upstream.requests), before, 'the fake CLI made a model call')
            value = self.upstream.requests[-1]['headers']['authorization'][0]
            self.request('POST', '/terminal/api/agent/stop', {'selector': fx.selector()})
            return value

        self.login(SENTINEL_A)
        self.assertEqual(bearer_after_start(), f'Bearer {SENTINEL_A}')
        self.login(SENTINEL_B)   # no restart
        self.assertEqual(bearer_after_start(), f'Bearer {SENTINEL_B}')
        self.upstream.requests.clear()   # they hold the fake bearer by design; nothing else may


class NoFlagTests(unittest.TestCase):
    def test_not_editable_without_the_token_file_flag(self):
        base = fx.tmp_base('login-noflag')
        try:
            hub = ra.ReportAgentHub(enabled=True, root=fx.make_root(base), state_dir=base / 'state', clis={'claude': str(FAKE_CLI)})
            try:
                login = hub.config_payload()['login']
                self.assertEqual((login['ready'], login['reason'], login['editable'], login['saved_at']), (False, 'no_token_file_flag', False, None))
                with self.assertRaises(ra.AgentError) as caught:
                    hub.save_login({'cli': 'claude', 'token': SENTINEL_A})
                self.assertEqual((caught.exception.status, caught.exception.code), (409, 'no_token_file_flag'))
                with self.assertRaises(ra.AgentError):
                    hub.remove_login({'cli': 'claude'})
                off = ra.ReportAgentHub(enabled=False, root=base / 'root', state_dir=base / 'state2')
                with self.assertRaises(ra.AgentError) as caught:
                    off.save_login({'cli': 'claude', 'token': SENTINEL_A})
                self.assertEqual(caught.exception.code, 'report_agent_disabled')
            finally:
                hub.close()
        finally:
            shutil.rmtree(base, ignore_errors=True)


class NoteTests(unittest.TestCase):
    def test_note_is_optional_capped_and_filtered(self):
        task = ra.validate_task({'kind': 'poc_format', 'format': 'python', 'note': 'Keep the curl as a fallback.'})
        self.assertEqual(task['note'], 'Keep the curl as a fallback.')
        self.assertIsNone(ra.validate_task({'kind': 'poc_format', 'format': 'python'})['note'])
        for note, code in (('a' * 2049, 'task_too_large'), ('keep ‮ it', 'unsafe_chars'), ('x\ry', 'unsafe_chars'),
                           ('   ', 'bad_task'), (5, 'bad_task')):
            with self.assertRaises(ra.AgentError) as caught:
                ra.validate_task({'kind': 'poc_format', 'format': 'python', 'note': note})
            self.assertEqual(caught.exception.code, code, repr(note)[:20])
        self.assertEqual(len(ra.validate_task({'kind': 'poc_format', 'format': 'curl', 'note': 'a' * 2048})['note']), 2048)
        with self.assertRaises(ra.AgentError):
            ra.validate_task({'kind': 'ask', 'text': 'q', 'note': 'n'})

    def test_note_is_rendered_once_as_extra_instructions(self):
        template = (Path(__file__).resolve().parents[1] / 'agent_prompts' / 'report-agent.md').read_text()
        task = ra.validate_task({'kind': 'poc_format', 'format': 'python', 'note': 'Keep the curl as a fallback. {{BLOCK}}',
                                 'block': {'text': 'curl -s https://example.test', 'lang': 'bash', 'index': 1}})
        text = ra.render_prompt(template, 'r.md', task)
        self.assertIn("Ryu's extra instructions for this change (they do not override the rules above):\n\nKeep the curl as a fallback. {{BLOCK}}", text)
        self.assertEqual(text.count('Ryu picked this code block'), 1, 'text inside the note is not expanded again')
        plain = ra.render_prompt(template, 'r.md', ra.validate_task({'kind': 'poc_format', 'format': 'python'}))
        self.assertNotIn('extra instructions', plain)


if __name__ == '__main__':
    unittest.main()
