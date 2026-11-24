"""terminal_service.py over real HTTP/WebSocket (test-only LocalBackend shell)."""
import http.client
import json
import shutil
import sys
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_auth as ta  # noqa: E402
import terminal_checks as tc  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
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
                                     backend=sb.LocalBackend(cls.base / 'local'), reap_interval=0)
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
        sel = fx.selector('solo/notes.md')
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

    def test_evidence_without_session_and_bad_selector(self):
        self.assertEqual(self.request('POST', '/terminal/api/evidence', fx.selector('bucket/two.md'))[0], 409)
        self.assertEqual(self.request('POST', '/terminal/api/evidence', fx.selector('../x.md'))[0], 400)
        client = self.ws(fx.selector('missing/REPORT.md'))
        client.pump_until(lambda c: any(m['type'] == 'error' for m in c.controls))
        self.assertEqual(client.controls[-1]['code'], 'report_not_found')
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
