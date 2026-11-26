"""terminal_service.py over real HTTP/WebSocket (test-only LocalBackend shell)."""
import http.client
import ipaddress
import json
import os
import shutil
import sys
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_auth as ta  # noqa: E402
import terminal_checks as tc  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
import terminal_ports as tp  # noqa: E402
import terminal_service as ts  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.terminal_ws_client import Client  # noqa: E402

BOARD = '127.0.0.1:18901'
ORIGIN = f'http://{BOARD}'
PASSWORD = 'synthetic test password'


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = fx.tmp_base('service')
        cls.root = fx.make_root(cls.base)
        record = ta.hash_password(PASSWORD, n=2 ** 14)
        cls.server = ts.make_service(cls.root, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'],
                                     hash_record=record, state_dir=cls.base / 'state',
                                     backend=sb.LocalBackend(cls.base / 'local'), reap_interval=0,
                                     min_free_memory=0)  # the memory guard has its own unit tests
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.server.auth.failures = []
        self.server.auth.locked_until = 0

    def request(self, method, path, body=None, headers=None, tailnet=True, origin=True, csrf=True, host=BOARD):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        h = {'Host': host}
        if tailnet:
            h['Tailscale-User-Login'] = 'ryu@example.test'
        if origin:
            h['Origin'] = ORIGIN
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h['Content-Type'] = 'application/json'
            if csrf:
                h['X-Requested-With'] = 'Bounty-Board'
        h.update(headers or {})
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for key, value in h.items():
            conn.putheader(key, value)
        conn.putheader('Content-Length', str(len(data or b'')))
        conn.endheaders(data)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = raw
        return response.status, response, payload

    def login(self):
        status, response, _ = self.request('POST', '/terminal/api/login', {'username': 'ryushe', 'password': PASSWORD}, tailnet=False)
        self.assertEqual(status, 200)
        return response.getheader('Set-Cookie').split(';')[0]

    def ws(self, sel=None, tailnet=True, origin=ORIGIN, cookie=None, prefix='/terminal'):
        headers = {'Host': BOARD, 'Origin': origin}
        if tailnet:
            headers['Tailscale-User-Login'] = 'ryu@example.test'
        if cookie:
            headers['Cookie'] = cookie
        return Client(self.port, f'{prefix}/ws?{urlencode(sel or fx.selector())}', headers)

    # -- gate ------------------------------------------------------------------
    def test_health_and_unknown_host(self):
        self.assertEqual(self.request('GET', '/healthz', host=f'127.0.0.1:{self.port}', origin=False)[0], 200)
        self.assertEqual(self.request('GET', '/terminal/api/status', host=f'127.0.0.1:{self.port}', origin=False)[0], 403)
        self.assertEqual(self.request('GET', '/terminal/api/status', host='evil.example')[0], 403)

    def test_tailnet_header_and_prefix_with_or_without_strip(self):
        for path in ('/terminal/api/status', '/api/status'):
            status, _, payload = self.request('GET', path)
            self.assertEqual((status, payload['method']), (200, 'tailnet'))
        status, _, payload = self.request('GET', '/terminal/api/status', tailnet=False)
        self.assertEqual((status, payload['error'], payload['login_url']), (401, 'login_required', '/terminal/login'))
        other = self.request('GET', '/terminal/api/status', headers={'Tailscale-User-Login': 'stranger@example.test'}, tailnet=False)
        self.assertEqual(other[0], 401)

    def test_origin_csrf_and_no_cors(self):
        sel = {**fx.selector(), 'key': tc.block_keys(['x'])[0], 'checked': True}
        self.assertEqual(self.request('POST', '/terminal/api/checks', sel, headers={'Origin': 'https://evil.example'}, origin=False)[0], 403)
        self.assertEqual(self.request('POST', '/terminal/api/checks', sel, origin=False)[0], 403)
        self.assertEqual(self.request('POST', '/terminal/api/checks', sel, csrf=False)[0], 403)
        self.assertEqual(self.request('POST', '/terminal/api/checks', sel, headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        status, response, _ = self.request('OPTIONS', '/terminal/api/checks')
        self.assertEqual(status, 405)
        self.assertFalse([h for h in response.getheaders() if h[0].lower().startswith('access-control')])
        self.assertEqual(self.request('GET', '/terminal/api/checks?' + urlencode(fx.selector()), headers={'Origin': 'https://evil.example'}, origin=False)[0], 403)

    # -- login -----------------------------------------------------------------
    def test_login_page_is_locked_down(self):
        status, response, body = self.request('GET', '/terminal/login', tailnet=False, origin=False)
        self.assertEqual(status, 200)
        self.assertIn(b'Sign in to the terminal', body)
        self.assertIn("frame-ancestors 'none'", response.getheader('Content-Security-Policy'))
        self.assertEqual(response.getheader('X-Frame-Options'), 'DENY')

    def test_login_logout_cookie(self):
        status, response, payload = self.request('POST', '/terminal/api/login', {'username': 'ryushe', 'password': 'nope'}, tailnet=False)
        self.assertEqual((status, payload['error']), (401, 'invalid'))
        self.assertIsNone(response.getheader('Set-Cookie'))
        status, response, _ = self.request('POST', '/terminal/api/login', {'username': 'ryushe', 'password': PASSWORD}, tailnet=False)
        cookie_header = response.getheader('Set-Cookie')
        for flag in ('HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/terminal'):
            self.assertIn(flag, cookie_header)
        cookie = cookie_header.split(';')[0]
        status, _, payload = self.request('GET', '/terminal/api/status', tailnet=False, headers={'Cookie': cookie})
        self.assertEqual((status, payload['method']), (200, 'password'))
        status, response, _ = self.request('POST', '/terminal/api/logout', {}, tailnet=False, headers={'Cookie': cookie})
        self.assertIn('Max-Age=0', response.getheader('Set-Cookie'))
        self.assertEqual(self.request('GET', '/terminal/api/status', tailnet=False, headers={'Cookie': cookie})[0], 401)

    def test_lockout(self):
        for _ in range(ta.MAX_FAILURES):
            self.request('POST', '/terminal/api/login', {'username': 'ryushe', 'password': 'bad'}, tailnet=False)
        status, _, payload = self.request('POST', '/terminal/api/login', {'username': 'ryushe', 'password': PASSWORD}, tailnet=False)
        self.assertEqual((status, payload['error']), (429, 'locked'))
        # Allowlisted tailnet users are unaffected by the lockout.
        self.assertEqual(self.request('GET', '/terminal/api/status')[0], 200)

    def test_login_needs_origin_and_csrf_header(self):
        body = {'username': 'ryushe', 'password': PASSWORD}
        self.assertEqual(self.request('POST', '/terminal/api/login', body, tailnet=False, csrf=False)[0], 403)
        self.assertEqual(self.request('POST', '/terminal/api/login', body, tailnet=False, origin=False)[0], 403)

    # -- checks ----------------------------------------------------------------
    def test_checks_roundtrip(self):
        key = tc.block_keys(['echo service-check'])[0]
        sel = fx.selector(fx.SECOND)
        status, _, payload = self.request('POST', '/terminal/api/checks', {**sel, 'key': key, 'checked': True})
        self.assertEqual((status, list(payload['checks'])), (200, [key]))
        status, _, payload = self.request('GET', '/terminal/api/checks?' + urlencode(sel))
        self.assertEqual(list(payload['checks']), [key])
        self.assertEqual(self.request('POST', '/terminal/api/checks', {**sel, 'key': 'zz', 'checked': True})[0], 400)
        self.assertEqual(self.request('POST', '/terminal/api/checks', {**sel, 'key': key, 'checked': 'yes'})[0], 400)
        self.assertEqual(self.request('POST', '/terminal/api/checks', {**sel, 'key': key, 'checked': True}, tailnet=False)[0], 401)

    # -- WebSocket ---------------------------------------------------------------
    def test_ws_refusals(self):
        bad_origin = self.ws(origin='https://evil.example')
        self.assertEqual(bad_origin.status, 403)
        bad_origin.close()
        anonymous = self.ws(tailnet=False)
        self.assertEqual(anonymous.status, 401)
        anonymous.close()

    def test_ws_shared_session_scrollback_and_evidence(self):
        sel = fx.selector()
        a = self.ws(sel)
        self.assertEqual(a.status, 101)
        a.pump_until(lambda c: any(m['type'] == 'hello' for m in c.controls))
        a.send_json({'t': 'resize', 'cols': 120, 'rows': 40})
        a.send_json({'t': 'in', 'd': 'python3 poc.py; echo sum-$((20+3))\r'})
        a.wait_output('sum-23')
        self.assertIn(b'poc-ran-ok', a.output)
        cookie = self.login()
        b = self.ws(sel, tailnet=False, cookie=cookie, prefix='')  # password session, prefix stripped by Serve
        self.assertEqual(b.status, 101)
        b.wait_output('sum-23')  # scrollback
        b.send_json({'t': 'in', 'd': 'echo from-b-$((5+5))\r'})
        a.wait_output('from-b-10')
        status, _, payload = self.request('POST', '/terminal/api/evidence', sel)
        self.assertEqual(status, 200, payload)
        saved = (self.root / fx.FAMILY / fx.PROGRAM / fx.LANE / payload['relative']).read_text()
        self.assertIn('sum-23', saved)
        status, _, payload = self.request('GET', '/terminal/api/session?' + urlencode(sel))
        self.assertEqual(payload['session']['viewers'], 2)
        status, _, payload = self.request('POST', '/terminal/api/reset', sel)
        self.assertEqual(status, 200)
        a.pump_until(lambda c: any(m['type'] == 'reset' for m in c.controls))
        a.close()
        b.close()

    def test_mount_endpoint_reports_the_folder_or_why_not(self):
        def mount(path):
            status, _, payload = self.request('GET', '/terminal/api/mount?' + urlencode(fx.selector(path)))
            self.assertEqual(status, 200)
            return payload
        self.assertEqual(mount(fx.PRIMARY), {'ok': True, 'folder': 'reports/D1-sqli-login', 'fid': 'D1', 'rule': 'packet',
                                             'reason': 'finding folder'})
        legacy = mount(fx.LEGACY)
        self.assertEqual((legacy['folder'], legacy['rule']), ('reports/D10-xss', 'ledger'))
        nav = mount(fx.NAVIGATION)
        self.assertEqual(nav, {'ok': False, 'code': 'not_in_packet',
                               'message': 'This report is not inside a finding folder (reports/<FID>-…/).'})
        self.assertEqual(self.request('GET', '/terminal/api/mount?' + urlencode(fx.selector('../x.md')))[0], 400)
        self.assertEqual(self.request('GET', '/terminal/api/mount?' + urlencode(fx.selector(fx.PRIMARY)), tailnet=False)[0], 401)
        client = self.ws(fx.selector(fx.NAVIGATION))
        client.pump_until(lambda c: any(m['type'] == 'error' for m in c.controls))
        self.assertEqual(client.controls[-1]['code'], 'not_in_packet')
        client.close()
        self.assertEqual(self.request('POST', '/terminal/api/evidence', fx.selector(fx.NAVIGATION))[0], 409)

    def test_evidence_without_session_and_bad_selector(self):
        self.assertEqual(self.request('POST', '/terminal/api/evidence', fx.selector('D7-open-redirect/EVIDENCE.md'))[0], 409)
        self.assertEqual(self.request('POST', '/terminal/api/evidence', fx.selector('../x.md'))[0], 400)
        client = self.ws(fx.selector('D99-missing/x.md'))
        client.pump_until(lambda c: any(m['type'] == 'error' for m in c.controls))
        self.assertEqual(client.controls[-1]['code'], 'report_not_found')
        client.close()

    # -- preview ports off (default) ------------------------------------------------
    def test_preview_ports_off_by_default(self):
        status, _, payload = self.request('GET', '/terminal/api/settings')
        self.assertEqual((status, payload['preview_ports'], payload['ports_tailscale'], payload['tailscale_address'],
                          payload['tailscale_reason'], payload['ports_range']), (200, False, False, None, 'disabled', [9100, 9199]))
        status, _, payload = self.request('POST', '/api/settings', {'ports_tailscale': True})
        self.assertEqual((status, payload['error']), (409, 'preview_ports_disabled'))
        status, _, payload = self.request('GET', '/api/ports?' + urlencode(fx.selector()))
        self.assertEqual((status, payload), (200, {'ports': [], 'preview_ports': False, 'ports_tailscale': False}))
        status, _, payload = self.request('GET', '/terminal/api/status')
        self.assertEqual((payload['preview_ports'], payload['ports_tailscale']), (False, False))
        self.assertIsNone(self.server.ports)
        self.assertIsNone(self.server.manager.backend.ports_hub)
        self.assertFalse((self.base / 'state' / 'settings.json').exists())


class PortsServiceTests(unittest.TestCase):
    """--preview-ports on, with the TEST-ONLY loopback stand-in for the Tailscale address."""
    request, ws, login = ServiceTests.request, ServiceTests.ws, ServiceTests.login

    @classmethod
    def setUpClass(cls):
        from tests.test_terminal_ports import free_range
        cls.base = fx.tmp_base('service-ports')
        cls.root = fx.make_root(cls.base)
        cls.addresses = {'127.0.0.1'}
        tailscale = tp.TailscaleAddress('auto', networks=[ipaddress.ip_network('127.0.0.2/32')],
                                        addresses=lambda: cls.addresses, interfaces=lambda: ['tailscale0'],
                                        interface=lambda name: '127.0.0.2')  # TEST ONLY alias as "tailscale0"
        cls.range = free_range()
        cls.backend = sb.LocalBackend(cls.base / 'local')
        cls.server = ts.make_service(cls.root, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'],
                                     hash_record=ta.hash_password(PASSWORD, n=2 ** 14), state_dir=cls.base / 'state',
                                     backend=cls.backend, reap_interval=0, min_free_memory=0, preview_ports=True,
                                     ports_range=cls.range, tailscale=tailscale, ports_refresh=0)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.server.auth.failures = []
        self.server.auth.locked_until = 0

    def test_settings_routes_gates_and_conflicts(self):
        status, _, payload = self.request('GET', '/terminal/api/settings')
        self.assertEqual((status, payload), (200, {'preview_ports': True, 'ports_tailscale': False, 'tailscale_address': None,
                                                   'tailscale_reason': 'disabled', 'ports_range': list(self.range)}))
        self.assertEqual(self.request('GET', '/api/settings', tailnet=False)[0], 401)
        body = {'ports_tailscale': True}
        self.assertEqual(self.request('POST', '/api/settings', body, tailnet=False)[0], 401)
        self.assertEqual(self.request('POST', '/api/settings', body, csrf=False)[0], 403)
        self.assertEqual(self.request('POST', '/api/settings', body, origin=False)[0], 403)
        self.assertEqual(self.request('POST', '/api/settings', body, headers={'Origin': 'https://evil.example'}, origin=False)[0], 403)
        self.assertEqual(self.request('POST', '/api/settings', body, headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        for bad in ({'ports_tailscale': 'yes'}, {'ports_tailscale': 1}, {}, {'ports_tailscale': True, 'x': 1}):
            self.assertEqual(self.request('POST', '/api/settings', bad)[0], 400, bad)
        PortsServiceTests.addresses = {'127.0.0.1'}
        status, _, payload = self.request('POST', '/api/settings', body)
        self.assertEqual((status, payload['error']), (409, 'tailscale_not_found'))
        PortsServiceTests.addresses = {'127.0.0.1', '127.0.0.2'}
        status, _, payload = self.request('POST', '/terminal/api/settings', body)
        self.assertEqual((status, payload['ports_tailscale'], payload['tailscale_address'], payload['tailscale_reason']),
                         (200, True, '127.0.0.2', None))
        self.assertEqual(self.request('GET', '/api/status')[2]['ports_tailscale'], True)
        status, _, payload = self.request('POST', '/api/settings', {'ports_tailscale': False})
        self.assertEqual((status, payload['ports_tailscale'], payload['tailscale_reason']), (200, False, 'disabled'))
        self.assertEqual(self.request('GET', '/api/status')[2]['preview_ports'], True)

    def test_ports_route_and_websocket_push(self):
        from tests.test_terminal_ports import AutoAgent, EchoServer, close_all, wait
        sel = fx.selector()
        self.assertEqual(self.request('GET', '/api/ports?' + urlencode(sel))[2],
                         {'ports': [], 'preview_ports': True, 'ports_tailscale': False})
        client = self.ws(sel)
        echo = EchoServer()
        try:
            client.pump_until(lambda c: any(m['type'] == 'hello' for m in c.controls))
            hello = next(m for m in client.controls if m['type'] == 'hello')
            self.assertEqual(hello['session']['ports'], [])
            session = self.server.manager.get(sel)
            sock_path = self.backend.ports_dir(session) / 'ports.sock'
            self.assertEqual(oct(os.stat(sock_path).st_mode & 0o777), '0o600')
            agent = AutoAgent(sock_path)
            agent.ports([echo.port])
            client.pump_until(lambda c: any(m['type'] == 'ports' and m['ports'] for m in c.controls))
            pushed = [m for m in client.controls if m['type'] == 'ports'][-1]['ports']
            self.assertEqual([i['port'] for i in pushed], [echo.port])
            item = pushed[0]
            self.assertEqual(set(item), {'port', 'host_port', 'local_url', 'tailscale_url', 'state'})
            self.assertEqual(item['local_url'], f'http://127.0.0.1:{item["host_port"]}/')
            status, _, payload = self.request('GET', '/terminal/api/ports?' + urlencode(sel))
            self.assertEqual((status, payload['ports']), (200, pushed))
            self.assertEqual(self.request('GET', '/api/ports?' + urlencode(sel), tailnet=False)[0], 401)
            self.assertEqual(self.request('GET', '/api/ports?' + urlencode(fx.selector('../x.md')))[0], 400)
            self.assertEqual(self.request('GET', '/api/session?' + urlencode(sel))[2]['session']['ports'], pushed)
            import socket as socketlib
            browser = socketlib.create_connection(('127.0.0.1', item['host_port']), timeout=10)
            browser.sendall(b'through-the-service')
            self.assertEqual(browser.recv(100), b'through-the-service')
            browser.close()
            # Reset gives a fresh sandbox: the old listener is gone and the list is empty.
            self.assertEqual(self.request('POST', '/api/reset', sel)[0], 200)
            wait(lambda: self.request('GET', '/api/ports?' + urlencode(sel))[2]['ports'] == [])
            with self.assertRaises(OSError):
                socketlib.create_connection(('127.0.0.1', item['host_port']), timeout=2).close()
        finally:
            client.close()
            close_all()
            echo.close()


class HardeningTests(unittest.TestCase):
    """Regression tests for the security review of 9235727."""

    @classmethod
    def setUpClass(cls):
        cls.base = fx.tmp_base('hardening')
        cls.root = fx.make_root(cls.base)
        cls.server = ts.make_service(cls.root, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'],
                                     hash_record=ta.hash_password(PASSWORD, n=2 ** 14), state_dir=cls.base / 'state',
                                     backend=sb.LocalBackend(cls.base / 'local'), reap_interval=0, min_free_memory=0,
                                     max_connections=12, ping_interval=0.3, peer_timeout=2,
                                     max_anonymous=4, max_pending=20, request_deadline=1.5)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.server.auth.failures = []
        self.server.auth.locked_until = 0

    request = ServiceTests.request
    ws = ServiceTests.ws

    def login(self):
        status, response, _ = self.request('POST', '/terminal/api/login', {'username': 'ryushe', 'password': PASSWORD}, tailnet=False)
        self.assertEqual(status, 200)
        return response.getheader('Set-Cookie').split(';')[0]

    def test_parallel_logins_run_at_most_two_scrypt_verifications(self):
        # Review blocker 1: 100 parallel logins reached 1.48 GiB (32 MiB per scrypt verify).
        import unittest.mock
        active, peak, lock = [0], [0], threading.Lock()
        real = ta.verify_password

        def counting(record, password):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            try:
                time.sleep(0.05)
                return real(record, password)
            finally:
                with lock:
                    active[0] -= 1
        statuses = []
        with unittest.mock.patch.object(ta, 'verify_password', counting):
            def attempt():
                try:
                    statuses.append(self.request('POST', '/terminal/api/login', {'username': 'ryushe', 'password': 'wrong'},
                                                 tailnet=False)[0])
                except (ConnectionError, http.client.HTTPException):
                    statuses.append('refused')  # over the connection cap: 503 and close
            threads = [threading.Thread(target=attempt) for _ in range(50)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(60)
        self.assertLessEqual(peak[0], ta.MAX_VERIFY)
        self.assertEqual(len(statuses), 50)
        self.assertTrue(set(statuses) <= {401, 429, 503, 'refused'}, statuses)
        self.assertLessEqual(statuses.count(401), ta.MAX_FAILURES, 'never more failed guesses than the lockout budget')
        self.assertTrue(429 in statuses or 'refused' in statuses)

    def tailnet_status(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', '/terminal/api/status', headers={'Host': BOARD, 'Tailscale-User-Login': 'ryu@example.test'})
            return conn.getresponse().status
        except Exception as error:
            return type(error).__name__
        finally:
            conn.close()

    def held_post(self, identified=False):
        import socket as socket_mod
        sock = socket_mod.create_connection(('127.0.0.1', self.port), timeout=10)
        who = 'Tailscale-User-Login: ryu@example.test\r\n' if identified else ''
        sock.sendall((f'POST /terminal/api/login HTTP/1.1\r\nHost: {BOARD}\r\nOrigin: {ORIGIN}\r\n{who}'
                      'Sec-Fetch-Site: same-origin\r\nX-Requested-With: Bounty-Board\r\nContent-Type: application/json\r\n'
                      'Content-Length: 65536\r\n\r\n{').encode())
        return sock

    def test_stalled_anonymous_posts_cannot_lock_out_the_tailnet_user(self):
        # Review N1 (reviewer repro conn_cap_lockout.py): 64 slow-body POSTs held every
        # slot and the allowlisted user got 503 indefinitely.
        self.assertEqual(self.tailnet_status(), 200)
        held = [self.held_post() for _ in range(64)]
        try:
            time.sleep(0.5)
            self.assertEqual(self.tailnet_status(), 200, 'identified user still served')
            refused = 0
            for sock in held:
                sock.settimeout(0.2)
                try:
                    data = sock.recv(100)
                    if data == b'' or data.startswith(b'HTTP/1.1 503'):
                        refused += 1  # 503 from the anonymous sub-cap, or evicted while pending
                except OSError:
                    pass
            self.assertGreaterEqual(refused, 64 - 4, 'only the anonymous sub-cap stays held')
            time.sleep(2.0)  # request deadline 1.5 s: the held ones are cut
            still_open = 0
            for sock in held:
                sock.settimeout(3)
                try:
                    while sock.recv(65536):
                        pass  # drain any 503 body until the server closes
                except TimeoutError:
                    still_open += 1
                except OSError:
                    pass
            self.assertEqual(still_open, 0, 'every held request was closed by the deadline')
            self.assertEqual(self.tailnet_status(), 200)
        finally:
            for sock in held:
                sock.close()

    def test_slow_request_heads_are_evicted_not_hoarded(self):
        # Review N1: connections that never finish their head cannot fill the service.
        import socket as socket_mod
        idle = []
        try:
            for _ in range(60):  # three times max_pending
                sock = socket_mod.create_connection(('127.0.0.1', self.port), timeout=5)
                sock.sendall(b'GET /terminal/api/status HTTP/1.1\r\nHost: ')  # never finished
                idle.append(sock)
            self.assertEqual(self.tailnet_status(), 200)
            self.assertLess(threading.active_count(), 120)
        finally:
            for sock in idle:
                sock.close()

    def test_every_response_says_connection_close(self):
        # Review 2 N4: the server answers one request per connection, so a keep-alive
        # client (Tailscale Serve's reverse proxy) must be told, or its next request on
        # the reused socket fails (POSTs are not retried and surfaced as 502).
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            for path in ('/terminal/api/status', '/terminal/', '/terminal/api/status'):
                conn.request('GET', path, headers={'Host': BOARD, 'Tailscale-User-Login': 'ryu@example.test'})
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.getheader('Connection'), 'close', path)
                self.assertIn(response.status, (200, 302, 303), path)
        finally:
            conn.close()
        sock = __import__('socket').create_connection(('127.0.0.1', self.port), timeout=10)
        try:
            sock.sendall((f'GET /terminal/api/status HTTP/1.1\r\nHost: {BOARD}\r\nConnection: keep-alive\r\n\r\n').encode())
            head = b''
            while b'\r\n\r\n' not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
            self.assertIn(b'\r\nConnection: close\r\n', head.split(b'\r\n\r\n')[0] + b'\r\n')
        finally:
            sock.close()

    def test_identified_cap_still_applies(self):
        held = [self.held_post(identified=True) for _ in range(12)]
        try:
            time.sleep(0.3)
            extra = self.held_post(identified=True)
            extra.settimeout(5)
            self.assertTrue(extra.recv(100).startswith(b'HTTP/1.1 503'))
            extra.close()
        finally:
            for sock in held:
                sock.close()
        time.sleep(2)
        self.assertEqual(self.tailnet_status(), 200, 'slots are released')

    def test_stalled_viewer_is_dropped(self):
        # Review item 3: a client that stops reading used to pin its thread (and its
        # viewer slot) forever: the sender sat in sendall() holding the send lock.
        import socket as socket_mod
        sel = fx.selector(fx.SECOND)
        reader = self.ws(sel)
        reader.pump_until(lambda c: any(m['type'] == 'hello' for m in c.controls))
        stalled = self.ws(sel)
        stalled.sock.setsockopt(socket_mod.SOL_SOCKET, socket_mod.SO_RCVBUF, 4096)
        stop = threading.Event()

        def keep_reading():  # the healthy device keeps up and answers nothing else
            reader.sock.settimeout(0.5)
            while not stop.is_set():
                try:
                    reader.frame()
                except Exception:
                    pass
        drain = threading.Thread(target=keep_reading, daemon=True)
        drain.start()
        reader.send_json({'t': 'in', 'd': 'yes stall-output-line-padding-padding | head -c 20000000; echo done-$((6*7))\r'})
        deadline = time.time() + 25
        viewers = 2
        while time.time() < deadline:
            _, _, payload = self.request('GET', '/terminal/api/session?' + urlencode(sel))
            viewers = payload['session']['viewers']
            if viewers == 1:
                break
            time.sleep(0.3)
        stop.set()
        drain.join(5)
        self.assertEqual(viewers, 1, 'the stalled viewer was detached and the reading one stayed')
        stalled.close()
        reader.close()

    def test_logout_ends_the_open_websocket(self):
        # Review item 7: logout or expiry did not end an open terminal.
        cookie = self.login()
        client = self.ws(fx.selector(fx.THIRD), tailnet=False, cookie=cookie)
        self.assertEqual(client.status, 101)
        client.pump_until(lambda c: any(m['type'] == 'hello' for m in c.controls))
        self.request('POST', '/terminal/api/logout', {}, tailnet=False, headers={'Cookie': cookie})
        started = time.time()
        with self.assertRaises(EOFError):
            client.pump_until(lambda c: False, limit=1000)
        self.assertLess(time.time() - started, 5)
        client.close()

    def test_attach_error_does_not_wait_forever(self):
        # Review item 8: the error path blocked in ws.recv() until the client spoke.
        client = self.ws(fx.selector(fx.NAVIGATION))
        client.pump_until(lambda c: any(m['type'] == 'error' for m in c.controls))
        client.sock.settimeout(10)
        started = time.time()
        while True:
            try:
                if not client.sock.recv(4096):
                    break
            except OSError:
                break
        self.assertLess(time.time() - started, 8, 'server closed the connection on its own')
        client.close()


class ConfigTests(unittest.TestCase):
    def test_origin_rules(self):
        self.assertEqual(ts.parse_origin('https://node.tail1.ts.net:9001')[0], 'https://node.tail1.ts.net:9001')
        self.assertEqual(ts.parse_origin('https://node.tail1.ts.net')[1], {'node.tail1.ts.net', 'node.tail1.ts.net:443'})
        for bad in ('http://node.tail1.ts.net:9001', 'https://x/path', 'ftp://x', 'http://127.0.0.1'):
            with self.assertRaises(ValueError):
                ts.parse_origin(bad)

    def test_service_cannot_trust_itself(self):
        base = fx.tmp_base('cfg')
        with self.assertRaises(ValueError):
            ts.make_service(base, port=19011, allowed_origins=['http://127.0.0.1:19011'], state_dir=base / 's',
                            backend=sb.LocalBackend(base / 'l'), reap_interval=0)
        shutil.rmtree(base, ignore_errors=True)

    def test_board_terminal_url_flag(self):
        import app
        for good in ('/terminal/', '/a/b/'):
            self.assertTrue(app.valid_terminal_url(good))
        for bad in ('terminal/', '/terminal', 'https://x/terminal/', '//evil/', '/../', '/a b/', None):
            self.assertFalse(app.valid_terminal_url(bad))
        self.assertEqual(app.parse_config(['--terminal-url', '/terminal/']).terminal_url, '/terminal/')
        with self.assertRaises(SystemExit):
            app.parse_config(['--terminal-url', 'https://x/'])
        base = fx.tmp_base('board')
        for url, expected in ((None, None), ('/terminal/', '/terminal/')):
            server = app.make_server(base, port=0, terminal_url=url)
            try:
                threading.Thread(target=server.serve_forever, daemon=True).start()
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                conn.request('GET', '/api/data', headers={'Host': f'127.0.0.1:{server.server_port}'})
                body = json.loads(conn.getresponse().read())
                conn.close()
                self.assertEqual(body['capabilities']['terminal_url'], expected)
            finally:
                server.shutdown()
                server.server_close()
        with self.assertRaises(ValueError):
            app.make_server(base, port=0, terminal_url='http://x/')
        shutil.rmtree(base, ignore_errors=True)

    def test_lifecycle_flags_are_validated(self):
        import contextlib
        import io
        base = ['--allowed-origin', 'https://node.tail1.ts.net:9001', '--root', '/nonexistent']
        for bad in (['--max-sessions', '33'], ['--max-sessions', '0'], ['--pause-after', '600', '--remove-after', '300'],
                    ['--pause-after', '5'], ['--remove-after', '30'], ['--idle-timeout', '100', '--remove-after', '200'],
                    ['--min-free-memory', 'lots'], ['--ports-range', '80-90'], ['--ports-range', '9000-9100', '--port', '9011'],
                    ['--tailscale-address', '0.0.0.0'], ['--tailscale-address', '192.168.1.2']):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                ts.main(base + bad)
        self.assertEqual(ts.parse_size('2G'), 2 * 1024 ** 3)
        self.assertEqual(ts.parse_size('512MiB'), 512 * 1024 ** 2)
        self.assertEqual(ts.parse_size('0'), 0)

    def test_status_reports_lifecycle(self):
        base = fx.tmp_base('lifecycle-cfg')
        server = ts.make_service(base, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'], state_dir=base / 's',
                                 backend=sb.LocalBackend(base / 'l'), reap_interval=0, idle_timeout=900)
        try:
            self.assertEqual((server.manager.max_sessions, server.manager.pause_after, server.manager.remove_after,
                              server.manager.min_free_memory), (12, 300, 900, 2 * 1024 ** 3))
        finally:
            server.server_close()
            shutil.rmtree(base, ignore_errors=True)

    def test_hash_password_cli_reads_stdin(self):
        import io
        import os
        import stat
        base = fx.tmp_base('cli')
        out = base / 'h'
        old = sys.stdin
        sys.stdin = io.StringIO('a long enough password\n')
        try:
            self.assertEqual(ts.main(['hash-password', '--output', str(out)]), 0)
        finally:
            sys.stdin = old
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        self.assertTrue(ta.verify_password(ta.read_hash_file(out), 'a long enough password'))
        self.assertNotIn('a long enough password', out.read_text())
        shutil.rmtree(base, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
