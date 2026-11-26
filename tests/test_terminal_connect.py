"""Agent connect with a fake herdr (tests/fake_herdr.py). Never the real Herdr, never a real agent."""
import http.client
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
import terminal_connect as tc  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
import terminal_service as ts  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.terminal_ws_client import Client  # noqa: E402

BOARD = '127.0.0.1:18903'
ORIGIN = f'http://{BOARD}'
FAKE_HERDR = Path(__file__).resolve().parent / 'fake_herdr.py'


def agent(pane, terminal, ref, status, seq, cwd=None, foreground=None, kind='claude', title='Claude Code'):
    item = {'agent': kind, 'agent_session': {'agent': kind, 'kind': 'id' if kind == 'claude' else 'path',
                                             'source': f'herdr:{kind}', 'value': ref},
            'agent_status': status, 'focused': False, 'pane_id': pane, 'revision': 1, 'state_change_seq': seq,
            'tab_id': 'w1:t1', 'terminal_id': terminal, 'terminal_title': title, 'terminal_title_stripped': title,
            'workspace_id': 'w1'}
    if cwd is not None:
        item['cwd'] = cwd
    if foreground is not None:
        item['foreground_cwd'] = foreground
    return item


class ConnectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = fx.tmp_base('connect')
        cls.root = fx.make_root(cls.base)
        program = os.path.realpath(cls.root / fx.FAMILY / fx.PROGRAM)
        lane = os.path.join(program, fx.LANE)
        cls.state = cls.base / 'herdr-state.json'
        cls.log = cls.base / 'herdr-log.jsonl'
        cls.agents = [
            agent('w1:p1', 'term_a1', 'uuid-a', 'working', 10, cwd='/somewhere', foreground=lane),
            agent('w1:p2', 'term_b2', '/home/u/.omp/sessions/b.jsonl', 'idle', 30, cwd=lane + '/reports/D1-sqli-login', kind='omp'),
            agent('w1:p3', 'term_c3', 'uuid-c', 'blocked', 5, foreground=program),
            agent('w1:p4', 'term_d4', 'uuid-d', 'done', 50, foreground=program + '/web2'),   # sibling of the lane, not inside it
            agent('w1:p5', 'term_e5', 'uuid-e', 'idle', 40, foreground=os.path.join(os.path.realpath(cls.root), fx.FAMILY, 'other', 'web')),
            agent('w1:p6', 'term_f6', 'uuid-f', 'idle', 60, foreground='/etc'),
            agent('w1:p7', 'term_g7', 'uuid-g', 'idle', 20, foreground=lane, title='evil\x1b]0;x\x07‮title'),
            agent('w1:p8', 'term_h8', 'uuid-h', 'idle', 45, foreground=lane + '2'),       # string prefix of the lane only
            agent('w1:p9', 'term_i9', 'uuid-i', 'idle', 1, foreground=lane),
        ]
        cls.write_state(cls.agents, busy=['w1:p9'])
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'FAKE_HERDR_STATE': str(cls.state),
               'FAKE_HERDR_LOG': str(cls.log), 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8'}
        cls.hub = tc.ConnectHub(enabled=True, root=cls.root, herdr=tc.Herdr(FAKE_HERDR, 'test-session', env=env),
                                max_sessions=2, grace=0.5, pty_env=env)
        cls.server = ts.make_service(cls.root, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'],
                                     state_dir=cls.base / 'state', backend=sb.LocalBackend(cls.base / 'local'),
                                     reap_interval=0, min_free_memory=0, agent_connect=cls.hub)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def write_state(cls, agents, busy=()):
        cls.state.write_text(json.dumps({'agents': agents, 'busy': list(busy)}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        if self.log.exists():
            self.log.unlink()

    def tearDown(self):
        self.hub.close()
        self.write_state(self.agents, busy=['w1:p9'])

    def get(self, query, tailnet=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        headers = {'Host': BOARD, 'Origin': ORIGIN}
        if tailnet:
            headers['Tailscale-User-Login'] = 'ryu@example.test'
        conn.request('GET', '/terminal/api/agents/active?' + urlencode(query), headers=headers)
        response = conn.getresponse()
        payload = json.loads(response.read())
        conn.close()
        return response.status, payload

    def ws(self, pane, terminal, ref, origin=ORIGIN):
        headers = {'Host': BOARD, 'Origin': origin, 'Tailscale-User-Login': 'ryu@example.test'}
        query = urlencode({'kind': 'connect', 'pane': pane, 'terminal_id': terminal, 'session_ref': ref})
        return Client(self.port, f'/terminal/ws?{query}', headers)

    def log_entries(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]

    # -- listing -------------------------------------------------------------------
    def test_active_for_a_report_matches_lane_then_program(self):
        status, payload = self.get(fx.selector())
        self.assertEqual(status, 200)
        self.assertTrue(payload['enabled'])
        items = payload['agents']
        self.assertEqual([i['pane_id'] for i in items], ['w1:p1', 'w1:p3', 'w1:p8', 'w1:p2', 'w1:p7', 'w1:p9', 'w1:p4'])
        match = {i['pane_id']: i['match'] for i in items}
        # p8's folder name starts with the lane's name (web2 vs web): program, never lane.
        self.assertEqual(match, {'w1:p1': 'lane', 'w1:p2': 'lane', 'w1:p3': 'program', 'w1:p4': 'program',
                                 'w1:p7': 'lane', 'w1:p8': 'program', 'w1:p9': 'lane'})
        first = items[0]
        self.assertEqual(set(first), {'pane_id', 'terminal_id', 'session_ref', 'agent', 'status', 'cwd_relative', 'title',
                                      'state_change_seq', 'match', 'unsafe_chars', 'connected'})
        self.assertEqual(first['cwd_relative'], f'{fx.FAMILY}/{fx.PROGRAM}/{fx.LANE}')  # foreground_cwd wins over cwd
        self.assertEqual(items[3]['session_ref'], '/home/u/.omp/sessions/b.jsonl')
        evil = [i for i in items if i['pane_id'] == 'w1:p7'][0]
        self.assertEqual(evil['title'], 'evil\\x1b]0;x\\x07\\u202etitle')
        self.assertTrue(evil['unsafe_chars'])
        self.assertFalse(first['unsafe_chars'])

    def test_active_all_and_paths_outside_the_root(self):
        status, payload = self.get({'all': '1'})
        self.assertEqual(status, 200)
        items = {i['pane_id']: i for i in payload['agents']}
        self.assertEqual(len(items), len(self.agents))
        self.assertIsNone(items['w1:p6']['cwd_relative'])
        self.assertEqual(items['w1:p5']['cwd_relative'], f'{fx.FAMILY}/other/web')
        self.assertIsNone(items['w1:p6']['match'])
        self.assertEqual(self.get({'all': '1', 'x': '2'})[0], 400)
        self.assertEqual(self.get(fx.selector(), tailnet=False)[0], 401)
        self.assertEqual(self.get({**fx.selector(), 'lane': 'missing-lane'})[0], 404)

    def test_herdr_failure_is_a_plain_error(self):
        self.state.write_text('not json')
        status, payload = self.get(fx.selector())
        self.assertEqual((status, payload['error']), (502, 'herdr_failed'))

    # -- attach ---------------------------------------------------------------------
    def test_attach_shared_by_viewers_then_ended_after_grace(self):
        first = self.ws('w1:p1', 'term_a1', 'uuid-a')
        second = None
        try:
            self.assertEqual(first.status, 101)
            first.wait_output('ATTACHED w1:p1')
            hello = [m for m in first.controls if m.get('type') == 'hello'][0]
            self.assertEqual(hello['kind'], 'connect')
            second = self.ws('w1:p1', 'term_a1', 'uuid-a')
            second.wait_output('ATTACHED w1:p1')  # scrollback for the late viewer
            second.send_json({'t': 'in', 'd': 'status please\r'})
            first.wait_output('AGENT-ECHO status please')
            first.send_json({'t': 'resize', 'cols': 90, 'rows': 20})
            second.wait_output('SIZE 90x20')
            self.assertTrue([i for i in self.get(fx.selector())[1]['agents'] if i['pane_id'] == 'w1:p1'][0]['connected'])
        finally:
            first.close()
            if second is not None:
                second.close()
        entries = self.log_entries()
        attaches = [e for e in entries if 'attached' in e]
        self.assertEqual(len(attaches), 1)  # one attach client shared by both viewers
        self.assertIn({'argv': ['--session', 'test-session', 'agent', 'attach', 'w1:p1']}, entries)
        self.assertFalse([e for e in entries if 'argv' in e and '--takeover' in e['argv']])
        pid = attaches[0]['pid']
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not [e for e in self.log_entries() if e.get('signal')]:
            time.sleep(0.1)
        signals = [e for e in self.log_entries() if e.get('signal')]
        self.assertEqual(signals, [{'pid': pid, 'signal': 'SIGHUP'}])
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and self.hub.sessions:
            time.sleep(0.05)
        self.assertEqual(self.hub.sessions, {})

    def test_viewer_back_within_grace_keeps_the_client(self):
        client = self.ws('w1:p1', 'term_a1', 'uuid-a')
        client.wait_output('ATTACHED')
        client.close()
        time.sleep(0.1)
        again = self.ws('w1:p1', 'term_a1', 'uuid-a')
        try:
            again.wait_output('ATTACHED')
            time.sleep(0.8)  # past the grace: a viewer is attached, so nothing ends
            again.send_json({'t': 'in', 'd': 'still here\r'})
            again.wait_output('AGENT-ECHO still here')
        finally:
            again.close()
        self.assertEqual(len([e for e in self.log_entries() if 'attached' in e]), 1)

    def test_review_r7_grace_end_and_reattach_do_not_race(self):
        client = self.ws('w1:p1', 'term_a1', 'uuid-a')
        try:
            client.wait_output('ATTACHED')
            cs = next(iter(self.hub.sessions.values()))
            self.hub._grace_over(cs)  # a timer that fires while a viewer is attached ends nothing
            self.assertFalse(cs.closed)
            client.send_json({'t': 'in', 'd': 'alive\r'})
            client.wait_output('AGENT-ECHO alive')
        finally:
            client.close()
        deadline = time.monotonic() + 10
        while cs.pty.viewers and time.monotonic() < deadline:
            time.sleep(0.05)
        if cs.grace_timer is not None:
            cs.grace_timer.cancel()
        self.hub._grace_over(cs)
        self.assertTrue(cs.closed)
        again = self.ws('w1:p1', 'term_a1', 'uuid-a')  # a new viewer gets a new client, not the dying one
        try:
            again.wait_output('ATTACHED')
            self.assertIsNot(next(iter(self.hub.sessions.values())), cs)
        finally:
            again.close()

    def test_reused_pane_id_is_refused(self):
        client = self.ws('w1:p1', 'term_OLD', 'uuid-a')
        try:
            client.pump_until(lambda c: any(m.get('type') == 'error' for m in c.controls))
            error = [m for m in client.controls if m['type'] == 'error'][0]
            self.assertEqual(error['code'], 'agent_gone')
        finally:
            client.close()
        client = self.ws('w1:p1', 'term_a1', 'uuid-OTHER')
        try:
            client.pump_until(lambda c: any(m.get('type') == 'error' for m in c.controls))
        finally:
            client.close()
        self.assertFalse([e for e in self.log_entries() if 'attached' in e])

    def test_attach_failure_reaches_the_viewer(self):
        client = self.ws('w1:p9', 'term_i9', 'uuid-i')
        try:
            client.pump_until(lambda c: any(m.get('type') == 'exit' for m in c.controls))
            out = bytes(client.output).decode()
            self.assertIn('another client is attached', out)
            self.assertIn('Someone else may be attached', out)
        finally:
            client.close()

    def test_cap_and_bad_parameters(self):
        a = self.ws('w1:p1', 'term_a1', 'uuid-a')
        b = self.ws('w1:p2', 'term_b2', '/home/u/.omp/sessions/b.jsonl')
        try:
            a.wait_output('ATTACHED')
            b.wait_output('ATTACHED')
            c = self.ws('w1:p3', 'term_c3', 'uuid-c')
            try:
                c.pump_until(lambda cl: any(m.get('type') == 'error' for m in cl.controls))
                self.assertEqual([m for m in c.controls if m['type'] == 'error'][0]['code'], 'too_many_connections')
            finally:
                c.close()
        finally:
            a.close()
            b.close()
        bad = self.ws('w1:p1; rm', 'term_a1', 'uuid-a')
        self.assertEqual(bad.status, 400)
        bad.close()
        wrong_origin = self.ws('w1:p1', 'term_a1', 'uuid-a', origin='https://evil.example')
        self.assertEqual(wrong_origin.status, 403)
        wrong_origin.close()


class ConnectOffTests(unittest.TestCase):
    def test_off_by_default(self):
        base = fx.tmp_base('connectoff')
        root = fx.make_root(base)
        server = ts.make_service(root, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'],
                                 state_dir=base / 'state', backend=sb.LocalBackend(base / 'local'), reap_interval=0,
                                 min_free_memory=0)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
            conn.request('GET', '/terminal/api/agents/active?' + urlencode(fx.selector()),
                         headers={'Host': BOARD, 'Tailscale-User-Login': 'ryu@example.test'})
            response = conn.getresponse()
            self.assertEqual((response.status, json.loads(response.read())), (200, {'enabled': False, 'agents': []}))
            conn.close()
            client = Client(port, '/terminal/ws?' + urlencode({'kind': 'connect', 'pane': 'w1:p1', 'terminal_id': 't1',
                                                                'session_ref': 'r'}),
                            {'Host': BOARD, 'Origin': ORIGIN, 'Tailscale-User-Login': 'ryu@example.test'})
            try:
                client.pump_until(lambda c: any(m.get('type') == 'error' for m in c.controls))
                self.assertEqual([m for m in client.controls if m['type'] == 'error'][0]['code'], 'agent_connect_disabled')
            finally:
                client.close()
            unknown = Client(port, '/terminal/ws?' + urlencode({**fx.selector(), 'kind': 'other'}),
                             {'Host': BOARD, 'Origin': ORIGIN, 'Tailscale-User-Login': 'ryu@example.test'})
            self.assertEqual(unknown.status, 400)
            unknown.close()
        finally:
            server.shutdown()
            server.server_close()
            shutil.rmtree(base, ignore_errors=True)

    def test_inside_uses_a_separator_boundary(self):
        self.assertTrue(tc.inside('/a/b', '/a/b'))
        self.assertTrue(tc.inside('/a/b/c', '/a/b'))
        self.assertFalse(tc.inside('/a/bc', '/a/b'))
        self.assertFalse(tc.inside('/a', '/a/b'))


if __name__ == '__main__':
    unittest.main()
