"""Tests for terminal_proxy. Local listeners only (127.0.0.1 / 127.0.0.2 / Unix sockets)."""
import http.server
import ipaddress
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest

import terminal_proxy as tp
from terminal_proxy import FilteringProxy, Refused, address_allowed, resolve

ALLOWED_NET = [ipaddress.ip_network('127.0.0.2/32')]
ALLOWED_NAME = 'allowed.example.test'
STATIC = {ALLOWED_NAME: '127.0.0.2'}
TIMEOUT = 5


def _gai(*ips):
    def resolver(host, port, type=0):
        return [(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, 6, '',
                 (ip, port, 0, 0) if ':' in ip else (ip, port)) for ip in ips]
    return resolver


def _teredo(client_v4):
    obf = int(ipaddress.IPv4Address(client_v4)) ^ 0xFFFFFFFF
    return ipaddress.IPv6Address((0x20010000 << 96) | (0x4136E378 << 64) | (0x800063BF << 32) | obf)


class AddressAllowedTests(unittest.TestCase):
    REFUSED = ['127.0.0.1', '10.0.0.1', '172.17.0.1', '192.168.1.10', '100.100.100.100', '100.64.0.1',
               '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1',
               'fd7a:115c:a1e0::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
               '64:ff9b::a00:1', '2002:0a00:0001::1',
               # Review item 10: deprecated embeddings and site-local.
               '::8.8.8.8', '::10.0.0.1', '::ffff:0:10.0.0.1', '::ffff:0:8.8.8.8', 'fec0::1', 'feff::1']
    ALLOWED = ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']

    def test_table(self):
        for text in self.REFUSED + [str(_teredo('10.0.0.1'))]:
            with self.subTest(ip=text):
                self.assertFalse(address_allowed(ipaddress.ip_address(text)))
        for text in self.ALLOWED:
            with self.subTest(ip=text):
                self.assertTrue(address_allowed(ipaddress.ip_address(text)))

    def test_teredo_embedding_checked(self):
        self.assertEqual(_teredo('10.0.0.1').teredo[1], ipaddress.IPv4Address('10.0.0.1'))

    def test_override_is_exact(self):
        self.assertTrue(address_allowed(ipaddress.ip_address('127.0.0.2'), ALLOWED_NET))
        self.assertFalse(address_allowed(ipaddress.ip_address('127.0.0.1'), ALLOWED_NET))
        self.assertFalse(address_allowed(ipaddress.ip_address('::ffff:127.0.0.1'), ALLOWED_NET))


class ResolveTests(unittest.TestCase):
    def test_mixed_answer_refused(self):
        with self.assertRaises(Refused) as cm:
            resolve('mixed.test', 443, resolver=_gai('8.8.8.8', '10.0.0.1'))
        self.assertEqual(cm.exception.reason, 'blocked_address')

    def test_public_answer(self):
        self.assertEqual(resolve('pub.test', 443, resolver=_gai('8.8.8.8', '2606:4700:4700::1111')),
                         [(socket.AF_INET, ('8.8.8.8', 443)),
                          (socket.AF_INET6, ('2606:4700:4700::1111', 443, 0, 0))])

    def test_static_hosts(self):
        def no_dns(*a, **k):
            raise AssertionError('DNS used')
        self.assertEqual(resolve(ALLOWED_NAME, 80, allow_networks=ALLOWED_NET, static_hosts=STATIC,
                                 resolver=no_dns), [(socket.AF_INET, ('127.0.0.2', 80))])
        with self.assertRaises(Refused):
            resolve(ALLOWED_NAME, 80, static_hosts=STATIC, resolver=no_dns)  # no override -> refused

    def test_bad_ports(self):
        for port in (0, -1, 65536, '80', 80.0, True, None):
            with self.subTest(port=port), self.assertRaises(Refused) as cm:
                resolve('8.8.8.8', port)
            self.assertEqual(cm.exception.reason, 'bad_port')

    def test_bad_hosts(self):
        for host in ('', 'a b', 'a\0b', 'x' * 254, 'a..b'):
            with self.subTest(host=host), self.assertRaises(Refused):
                resolve(host, 80, resolver=_gai('8.8.8.8'))

    def test_ip_literal_brackets(self):
        self.assertEqual(resolve('[2606:4700:4700::1111]', 443),
                         [(socket.AF_INET6, ('2606:4700:4700::1111', 443, 0, 0))])
        for host in ('[::1]', '[fd7a:115c:a1e0::1]', '127.0.0.1'):
            with self.subTest(host=host), self.assertRaises(Refused):
                resolve(host, 80)

    def test_resolve_failure(self):
        def fail(*a, **k):
            raise socket.gaierror('nope')
        with self.assertRaises(Refused) as cm:
            resolve('nx.test', 80, resolver=fail)
        self.assertEqual(cm.exception.reason, 'resolve_failed')

    def test_rebinding_each_call_vetted(self):
        answers = iter(['8.8.8.8', '10.0.0.1'])

        def rebinding(host, port, type=0):
            return _gai(next(answers))(host, port)
        self.assertEqual(resolve('rebind.test', 80, resolver=rebinding), [(socket.AF_INET, ('8.8.8.8', 80))])
        with self.assertRaises(Refused):
            resolve('rebind.test', 80, resolver=rebinding)


class _Recorder(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_GET(self):
        type(self).seen.append((self.path, dict(self.headers)))
        body = b'hello-from-127.0.0.2'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = http.server.ThreadingHTTPServer(('127.0.0.2', 0), _Recorder)
        cls.http.daemon_threads = True
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.http_port = cls.http.server_address[1]
        cls.echo = socket.create_server(('127.0.0.2', 0))
        cls.echo_port = cls.echo.getsockname()[1]
        cls.echo_conns = []
        threading.Thread(target=cls._echo_loop, daemon=True).start()
        # Canary on 127.0.0.1: must never receive a connection.
        cls.canary = socket.create_server(('127.0.0.1', 0))
        cls.canary.setblocking(False)
        cls.canary_port = cls.canary.getsockname()[1]

    @classmethod
    def _echo_loop(cls):
        while True:
            try:
                conn, _ = cls.echo.accept()
            except OSError:
                return
            cls.echo_conns.append(conn)
            threading.Thread(target=cls._echo, args=(conn,), daemon=True).start()

    @staticmethod
    def _echo(conn):
        with conn:
            try:
                while data := conn.recv(65536):
                    conn.sendall(data)
            except OSError:
                pass

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.echo.close()
        try:
            cls.canary.accept()
            raise AssertionError('127.0.0.1 canary received a connection')
        except BlockingIOError:
            pass
        finally:
            cls.canary.close()

    def setUp(self):
        base = os.environ.get('TMPDIR') or None
        self.dir = tempfile.mkdtemp(prefix='tp', dir=base)
        self.path = os.path.join(self.dir, 's')
        self.events = []
        self.proxy = self.make_proxy()
        self.listener = self.proxy.listen_unix(self.path)

    def make_proxy(self, **kw):
        kw.setdefault('allow_networks', ALLOWED_NET)
        kw.setdefault('static_hosts', STATIC)
        kw.setdefault('connect_timeout', 2)
        kw.setdefault('idle_timeout', 10)
        return FilteringProxy(log=self.events.append, **kw)

    def tearDown(self):
        self.proxy.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def client(self, path=None):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(TIMEOUT)
        try:
            s.connect(path or self.path)
        except OSError:
            s.close()
            raise
        return s

    @staticmethod
    def read_all(s):
        out = b''
        try:
            while data := s.recv(65536):
                out += data
        except ConnectionResetError:
            pass
        return out

    @staticmethod
    def read_until(s, marker):
        out = b''
        while marker not in out:
            data = s.recv(65536)
            if not data:
                break
            out += data
        return out

    def http_exchange(self, raw):
        with self.client() as s:
            try:
                s.sendall(raw)
                s.shutdown(socket.SHUT_WR)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return self.read_all(s)

    def socks(self, s, atyp, addr, port, methods=b'\x00'):
        s.sendall(b'\x05' + bytes([len(methods)]) + methods)
        greeting = s.recv(2)
        if greeting != b'\x05\x00':
            return greeting
        s.sendall(b'\x05\x01\x00' + bytes([atyp]) + addr + port.to_bytes(2, 'big'))
        reply = b''
        while len(reply) < 10:
            data = s.recv(10 - len(reply))
            if not data:
                break
            reply += data
        return reply

    # -- allowed paths -----------------------------------------------------
    def test_listen_unix_mode(self):
        # Review item 12: owner only (the container runs as the service's UID).
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_connect_relays_both_ways(self):
        with self.client() as s:
            s.sendall(f'CONNECT {ALLOWED_NAME}:{self.echo_port} HTTP/1.1\r\nHost: x\r\n\r\nearly'.encode())
            reply = self.read_until(s, b'early')
            self.assertTrue(reply.startswith(b'HTTP/1.1 200 Connection established\r\n\r\n'), reply)
            self.assertTrue(reply.endswith(b'early'))
            s.sendall(b'ping')
            self.assertEqual(self.read_until(s, b'ping'), b'ping')

    def test_absolute_get_strips_proxy_headers(self):
        raw = (f'GET http://{ALLOWED_NAME}:{self.http_port}/x?q=1 HTTP/1.1\r\n'
               f'Host: {ALLOWED_NAME}:{self.http_port}\r\nProxy-Authorization: Basic c2VjcmV0\r\n'
               'Proxy-Connection: keep-alive\r\nConnection: keep-alive, X-Hop\r\nX-Hop: 1\r\n'
               'Keep-Alive: 5\r\nX-Keep: yes\r\n\r\n').encode()
        resp = self.http_exchange(raw)
        self.assertIn(b' 200 ', resp.split(b'\r\n', 1)[0])
        self.assertTrue(resp.endswith(b'hello-from-127.0.0.2'))
        path, headers = _Recorder.seen[-1]
        lower = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(path, '/x?q=1')
        for name in ('proxy-authorization', 'proxy-connection', 'x-hop', 'keep-alive'):
            self.assertNotIn(name, lower)
        self.assertEqual(lower['connection'], 'close')
        self.assertEqual(lower['x-keep'], 'yes')
        self.assertEqual(lower['host'], f'{ALLOWED_NAME}:{self.http_port}')
        self.assertFalse(any('c2VjcmV0' in e for e in self.events))  # no header values logged

    def test_absolute_get_adds_missing_host(self):
        resp = self.http_exchange(f'GET http://{ALLOWED_NAME}:{self.http_port}/h HTTP/1.1\r\n\r\n'.encode())
        self.assertTrue(resp.endswith(b'hello-from-127.0.0.2'))
        self.assertEqual(dict(_Recorder.seen[-1][1])['Host'], f'{ALLOWED_NAME}:{self.http_port}')

    def test_socks_domain_connect(self):
        with self.client() as s:
            name = ALLOWED_NAME.encode()
            reply = self.socks(s, 3, bytes([len(name)]) + name, self.echo_port)
            self.assertEqual(reply[:2], b'\x05\x00')
            s.sendall(b'socks-ping')
            self.assertEqual(self.read_until(s, b'socks-ping'), b'socks-ping')

    def test_proxy_connects_to_vetted_address_only(self):
        calls = []
        answers = iter(['127.0.0.2', '127.0.0.1'])

        def rebinding(host, port, type=0):
            calls.append(host)
            return _gai(next(answers))(host, port)
        self.proxy.close()
        self.proxy = self.make_proxy(static_hosts=None, resolver=rebinding)
        self.listener = self.proxy.listen_unix(self.path)
        req = f'CONNECT rebind.example.test:{self.echo_port} HTTP/1.1\r\n\r\n'.encode()
        with self.client() as s:
            s.sendall(req)
            self.assertIn(b' 200 ', self.read_until(s, b'\r\n\r\n'))
            s.sendall(b'v')
            self.assertEqual(self.read_until(s, b'v'), b'v')
        self.assertEqual(calls, ['rebind.example.test'])  # resolved once, no re-resolution
        req = f'CONNECT rebind.example.test:{self.canary_port} HTTP/1.1\r\n\r\n'.encode()
        self.assertIn(b' 403 ', self.http_exchange(req))
        self.assertEqual(len(calls), 2)  # second connection vetted independently

    def test_handle_with_socketpair(self):
        a, b = socket.socketpair()
        b.settimeout(TIMEOUT)
        t = threading.Thread(target=self.proxy.handle, args=(a,), daemon=True)
        t.start()
        b.sendall(b'\x05\x01\x01')
        self.assertEqual(b.recv(2), b'\x05\xff')
        t.join(TIMEOUT)
        self.assertFalse(t.is_alive())
        b.close()

    # -- refused paths -------------------------------------------------------
    def refused_targets(self):
        return [('127.0.0.1', self.canary_port), ('10.0.0.1', 80), ('172.17.0.1', 80),
                ('100.100.100.100', 80), ('169.254.169.254', 80), ('::1', 80), ('fd7a:115c:a1e0::1', 80)]

    def test_refused_destinations_all_protocols(self):
        for host, port in self.refused_targets():
            auth = f'[{host}]:{port}' if ':' in host else f'{host}:{port}'
            with self.subTest(proto='connect', host=host):
                resp = self.http_exchange(f'CONNECT {auth} HTTP/1.1\r\n\r\n'.encode())
                self.assertTrue(resp.startswith(b'HTTP/1.1 403 Forbidden'), resp)
                self.assertIn(b'Connection: close', resp)
                self.assertTrue(resp.endswith(b'Blocked by sandbox egress policy: blocked_address\n'))
            with self.subTest(proto='get', host=host):
                resp = self.http_exchange(f'GET http://{auth}/ HTTP/1.1\r\nHost: {auth}\r\n\r\n'.encode())
                self.assertTrue(resp.startswith(b'HTTP/1.1 403 Forbidden'), resp)
            with self.subTest(proto='socks', host=host):
                family = socket.AF_INET6 if ':' in host else socket.AF_INET
                with self.client() as s:
                    reply = self.socks(s, 4 if ':' in host else 1, socket.inet_pton(family, host), port)
                self.assertEqual(reply[:2], b'\x05\x02')
        with self.client() as s:  # domain that maps to loopback
            reply = self.socks(s, 3, b'\x09localhost', self.canary_port)
            self.assertIn(reply[1], (0x02, 0x04))

    def test_resolve_failure_status(self):
        def fail(*a, **k):
            raise socket.gaierror('nope')
        self.proxy.resolver = fail
        self.assertIn(b' 502 ', self.http_exchange(b'CONNECT nx.example.test:443 HTTP/1.1\r\n\r\n'))
        with self.client() as s:
            self.assertEqual(self.socks(s, 3, b'\x0enx.example.test', 443)[:2], b'\x05\x04')

    def test_connect_refused_status(self):
        dead = socket.create_server(('127.0.0.2', 0))
        port = dead.getsockname()[1]
        dead.close()
        self.assertIn(b' 502 ', self.http_exchange(f'CONNECT {ALLOWED_NAME}:{port} HTTP/1.1\r\n\r\n'.encode()))
        with self.client() as s:
            self.assertEqual(self.socks(s, 1, socket.inet_aton('127.0.0.2'), port)[:2], b'\x05\x05')

    def test_bad_port_refused(self):
        resp = self.http_exchange(f'CONNECT {ALLOWED_NAME}:0 HTTP/1.1\r\n\r\n'.encode())
        self.assertIn(b'403', resp.split(b'\r\n', 1)[0])

    def test_socks_without_noauth(self):
        with self.client() as s:
            self.assertEqual(self.socks(s, 1, b'', 0, methods=b'\x02'), b'\x05\xff')

    def test_socks_udp_associate(self):
        with self.client() as s:
            s.sendall(b'\x05\x01\x00')
            self.assertEqual(s.recv(2), b'\x05\x00')
            s.sendall(b'\x05\x03\x00\x01' + socket.inet_aton('8.8.8.8') + (53).to_bytes(2, 'big'))
            self.assertEqual(s.recv(10)[:2], b'\x05\x07')

    def test_oversized_head(self):
        resp = self.http_exchange(b'GET http://a.test/ HTTP/1.1\r\nX-Big: ' + b'a' * (70 * 1024) + b'\r\n\r\n')
        self.assertRegex(resp.split(b'\r\n', 1)[0], rb' (431|400) ')
        many = ''.join(f'X-{i}: v\r\n' for i in range(101))
        resp = self.http_exchange(f'GET http://a.test/ HTTP/1.1\r\n{many}\r\n'.encode())
        self.assertRegex(resp.split(b'\r\n', 1)[0], rb' (431|400) ')

    def test_https_absolute_form(self):
        self.assertIn(b' 400 ', self.http_exchange(b'GET https://allowed.example.test/ HTTP/1.1\r\n\r\n'))

    def test_origin_form(self):
        self.assertIn(b' 400 ', self.http_exchange(b'GET /x HTTP/1.1\r\nHost: allowed.example.test\r\n\r\n'))

    def test_max_connections(self):
        self.proxy.close()
        self.proxy = self.make_proxy(max_connections=1)
        self.listener = self.proxy.listen_unix(self.path)
        held = self.client()
        held.sendall(b'\x05')  # partial greeting: handler holds the slot
        time.sleep(0.1)
        with self.client() as s:
            resp = self.read_all(s)
        self.assertTrue(resp == b'' or resp.startswith(b'HTTP/1.1 503'), resp)
        held.close()
        deadline = time.monotonic() + TIMEOUT
        while True:  # slot is released once the held connection ends
            with self.client() as s:
                s.sendall(b'GET /x HTTP/1.1\r\n\r\n')
                resp = self.read_all(s)
            if b' 400 ' in resp or time.monotonic() > deadline:
                break
            time.sleep(0.05)
        self.assertIn(b' 400 ', resp)

    def test_per_listener_cap_leaves_room_for_other_sandboxes(self):
        # Review item 4: one sandbox could take every global slot.
        self.proxy.close()
        self.proxy = self.make_proxy(max_connections=10, per_listener_connections=3)
        self.listener = self.proxy.listen_unix(self.path)
        other_path = os.path.join(self.dir, 'o')
        self.proxy.listen_unix(other_path)
        held = []
        for _ in range(3):
            c = self.client()
            c.sendall(b'\x05')  # partial greeting holds the slot
            held.append(c)
        time.sleep(0.2)
        with self.client() as s:
            resp = self.read_all(s)
        self.assertTrue(resp == b'' or resp.startswith(b'HTTP/1.1 503'), resp)
        with self.client(other_path) as s:  # another sandbox still gets in
            s.sendall(b'GET /x HTTP/1.1\r\n\r\n')
            self.assertIn(b' 400 ', self.read_all(s))
        for c in held:
            c.close()

    def test_handshake_has_a_total_deadline(self):
        # Review item 5: a client trickling bytes reset the per-recv timeout forever.
        self.proxy.close()
        self.proxy = self.make_proxy(handshake_deadline=1.0, idle_timeout=10)
        self.listener = self.proxy.listen_unix(self.path)
        with self.client() as s:
            started = time.monotonic()
            closed = False
            for _ in range(40):
                try:
                    s.sendall(b'X')
                except OSError:
                    closed = True
                    break
                time.sleep(0.1)
                s.setblocking(False)
                try:
                    data = s.recv(65536)
                    if data == b'' or data.startswith(b'HTTP/1.1'):
                        closed = True
                        break
                except BlockingIOError:
                    pass
                finally:
                    s.setblocking(True)
            self.assertTrue(closed, 'connection closed by the deadline')
            self.assertLess(time.monotonic() - started, 3.5)

    def test_host_own_addresses_are_refused(self):
        # Review item 10: the sandbox must not reach host services via the host's public IP.
        self.proxy.close()
        self.proxy = self.make_proxy(host_addresses=lambda: {'127.0.0.2'})
        self.listener = self.proxy.listen_unix(self.path)
        resp = self.http_exchange(f'GET http://allowed.example.test:{self.http_port}/x HTTP/1.1\r\n\r\n'.encode())
        self.assertIn(b'403', resp.split(b'\r\n')[0])
        self.assertIn(b'host_address', resp)

    def test_local_addresses_reads_proc(self):
        from terminal_proxy import local_addresses
        found = local_addresses()
        self.assertIn('127.0.0.1', found)
        base = os.environ.get('TMPDIR') or None
        fib = os.path.join(self.dir, 'fib')
        with open(fib, 'w') as f:
            f.write('Main:\n  +-- 0.0.0.0/0 3 0 5\n     |-- 203.0.113.7\n        /32 host LOCAL\n     |-- 203.0.113.0\n        /24 link UNICAST\n')
        inet6 = os.path.join(self.dir, 'inet6')
        with open(inet6, 'w') as f:
            f.write('20010db8000000000000000000000001 02 40 00 80     eth0\n')
        self.assertEqual(local_addresses(fib, inet6), {'203.0.113.7', '2001:db8::1'})

    def test_handle_close_unlinks_and_closes_relays(self):
        s = self.client()
        s.sendall(f'CONNECT {ALLOWED_NAME}:{self.echo_port} HTTP/1.1\r\n\r\n'.encode())
        self.assertIn(b' 200 ', self.read_until(s, b'\r\n\r\n'))
        s.sendall(b'x')
        self.assertEqual(self.read_until(s, b'x'), b'x')
        self.listener.close()
        self.assertFalse(os.path.exists(self.path))
        self.assertEqual(self.read_all(s), b'')  # relay torn down
        s.close()
        with self.assertRaises(OSError):
            self.client()

    def test_listen_unix_refuses_to_replace_regular_file(self):
        other = os.path.join(self.dir, 'f')
        open(other, 'w').close()
        with self.assertRaises(OSError):
            self.proxy.listen_unix(other)
        self.assertTrue(os.path.isfile(other))
        stale = os.path.join(self.dir, 'z')
        h = FilteringProxy().listen_unix(stale)
        h.close()
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(stale)  # stale socket file left behind
        sock.close()
        h2 = self.proxy.listen_unix(stale)
        self.assertTrue(os.path.exists(stale))
        h2.close()


if __name__ == '__main__':
    unittest.main()
