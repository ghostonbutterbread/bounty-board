"""Synthetic HTTP tests for live report editing (loopback, disposable roots)."""
import http.client
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server

LANE = 'web_bounty/alpha/web'
QUERY = 'family=web_bounty&program=alpha&lane=web&path='


class LiveAPITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='live-api-')
        self.addCleanup(self.tmp.cleanup)
        top = Path(self.tmp.name)
        self.root = top / 'root'
        reports = self.root / LANE / 'reports'
        (reports / 'index').mkdir(parents=True)
        (self.root / LANE / 'ledgers').mkdir()
        (self.root / LANE / 'ledgers/ledger.json').write_text(json.dumps({'findings': []}))
        self.report = reports / 'report.md'
        self.report.write_text('# Report\n\nfirst\n\nsecond\n')
        (reports / 'index/xss.md').write_text('# Xss\n')
        self.server = make_test_server(self.root, port=0, live_edit_dir=top / 'state')
        self.server.live.poll_interval = 0.05
        self.port = self.server.server_port
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        base = {'Host': f'127.0.0.1:{self.port}'}
        if body is not None:
            base.update({'Origin': f'http://127.0.0.1:{self.port}', 'X-Requested-With': 'Bounty-Board',
                         'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin'})
        base.update(headers or {})
        data = None if body is None else json.dumps(body).encode()
        conn.request(method, path, body=data, headers=base)
        response = conn.getresponse()
        payload = json.loads(response.read() or b'null')
        conn.close()
        return response.status, payload

    def test_capability_open_save_and_history(self):
        status, data = self.request('GET', '/api/data')
        self.assertEqual(status, 200)
        self.assertTrue(data['capabilities']['live_edit'])
        status, opened = self.request('GET', f'/api/live/report?{QUERY}report.md')
        self.assertEqual(status, 200)
        self.assertTrue(opened['editable'])
        status, saved = self.request('POST', f'/api/live/save?{QUERY}report.md',
                                     {'base': opened['revision'], 'content': opened['content'] + 'third\n', 'client': 'tab-1'})
        self.assertEqual((status, saved['status']), (200, 'saved'))
        self.assertTrue(self.report.read_text().endswith('third\n'))
        status, history = self.request('GET', f'/api/live/history?{QUERY}report.md')
        self.assertEqual([e['kind'] for e in history['events']], ['board', 'observed'])
        status, old = self.request('GET', f"/api/live/revision?{QUERY}report.md&revision={opened['revision']}")
        self.assertEqual(old['content'], opened['content'])

    def test_writes_require_same_origin_marker_and_json(self):
        _, opened = self.request('GET', f'/api/live/report?{QUERY}report.md')
        body = {'base': opened['revision'], 'content': 'evil\n', 'client': 'x'}
        for headers in ({'X-Requested-With': ''}, {'Origin': 'https://evil.example'}, {'Content-Type': 'text/plain'},
                        {'Sec-Fetch-Site': 'cross-site'}):
            status, _ = self.request('POST', f'/api/live/save?{QUERY}report.md', body, headers)
            self.assertEqual(status, 403, headers)
        self.assertEqual(self.report.read_text(), '# Report\n\nfirst\n\nsecond\n')

    def test_invalid_selectors_and_generated_navigation(self):
        for path in ('../ledgers/ledger.json', '../../beta/web/reports/x.md', 'report.txt', '/etc/passwd.md'):
            status, _ = self.request('GET', f'/api/live/report?{QUERY}{path}')
            self.assertEqual(status, 400, path)
        status, nav = self.request('GET', f'/api/live/report?{QUERY}index/xss.md')
        self.assertEqual(status, 200)
        self.assertFalse(nav['editable'])
        status, body = self.request('POST', f'/api/live/save?{QUERY}index/xss.md',
                                    {'base': nav['revision'], 'content': 'changed\n', 'client': 'x'})
        self.assertEqual((status, body['error']), (403, 'not_editable'))
        status, _ = self.request('GET', f'/api/live/report?{QUERY}missing.md')
        self.assertEqual(status, 404)

    def test_conflict_and_marker_rejection(self):
        _, opened = self.request('GET', f'/api/live/report?{QUERY}report.md')
        self.report.write_text('# Report\n\nfirst (agent)\n\nsecond\n')
        _, result = self.request('POST', f'/api/live/save?{QUERY}report.md',
                                 {'base': opened['revision'], 'content': '# Report\n\nfirst (me)\n\nsecond\n', 'client': 'a'})
        self.assertEqual(result['status'], 'conflict')
        status, body = self.request('POST', f'/api/live/save?{QUERY}report.md',
                                    {'base': result['revision'], 'content': result['content'], 'client': 'a'})
        self.assertEqual((status, body['error']), (422, 'unresolved_conflict'))
        self.assertEqual(self.report.read_text(), '# Report\n\nfirst (agent)\n\nsecond\n')

    def test_event_stream_announces_outside_change(self):
        self.request('GET', f'/api/live/report?{QUERY}report.md')
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        self.addCleanup(sock.close)
        sock.sendall(f'GET /api/live/events?{QUERY}report.md HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n'.encode())
        stream = sock.makefile('rb')
        self.assertIn(b'200', stream.readline())
        while stream.readline() not in (b'\r\n', b''):
            pass
        self.assertEqual(stream.readline(), b'retry: 2000\n')
        self.report.write_text('# Report\n\nchanged by an agent\n')
        lines = []
        while not lines or lines[-1] != b'\n':
            line = stream.readline()
            if line.startswith(b':') or (line == b'\n' and not lines):
                continue  # keep-alives and the retry block's terminator
            lines.append(line)
        self.assertEqual(lines[0], b'event: changed\n')
        self.assertIn(b'Changed outside the Board', lines[1])

    def test_event_stream_for_missing_report_is_refused_without_leaking_a_slot(self):
        for _ in range(40):  # more than the stream limit: a leaked slot would turn into 503
            status, payload = self.request('GET', f'/api/live/events?{QUERY}missing.md')
            self.assertEqual((status, payload['error']), (404, 'report_not_found_or_unavailable'))
        self.assertNotIn(f'{LANE}/reports/missing.md', self.server.live.docs)

    def test_live_edit_excludes_old_publication_modes(self):
        state = Path(self.tmp.name) / 'other'
        with self.assertRaises(ValueError):
            make_test_server(self.root, port=0, live_edit_dir=state, collaboration_dir=Path(self.tmp.name) / 'collab')
        with self.assertRaises(SystemExit):
            app.parse_config(['--root', str(self.root), '--live-edit', '--report-autosave'])
        args = app.parse_config(['--root', str(self.root), '--live-edit', '--live-edit-dir', str(state)])
        self.assertTrue(args.live_edit)

    def test_disabled_by_default(self):
        server = make_test_server(self.root, port=0)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
        conn.request('GET', f'/api/live/report?{QUERY}report.md', headers={'Host': f'127.0.0.1:{server.server_port}'})
        self.assertEqual(conn.getresponse().status, 404)
        conn.close()


if __name__ == '__main__':
    unittest.main()
