import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

import app


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.server = app.make_server(self.root, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = HTTPConnection('127.0.0.1', self.port, timeout=3)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        result = (response.status, dict(response.getheaders()), data)
        conn.close()
        return result

    def test_reads_ledger_fields_without_assuming_missing_status(self):
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'ledgers' / 'ledger.json').write_text(json.dumps({'version': 2, 'findings': [{'fid': 'F01', 'type': 'Example', 'class_name': 'xss', 'severity': 'HIGH'}]}))
        status, _, body = self.request('GET', '/api/data')
        item = json.loads(body)['programs'][0]['lanes'][0]['findings'][0]
        self.assertEqual(status, 200)
        self.assertEqual(item['fid'], 'F01')
        self.assertEqual(item['class_name'], 'xss')
        self.assertEqual(item['title'], 'Example')
        self.assertIsNone(item['status'])

    def test_map_and_gadget_index_preserves_tags_and_missing_data(self):
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        maps = lane / 'recon' / 'maps'
        maps.mkdir(parents=True)
        entry = {'title': 'Synthetic', 'surface': 'api', 'scope': 'url', 'tags': ['gadget', 'residual'], 'status': 'defended', 'path': 'api/example/index.md'}
        (maps / 'map.jsonl').write_text(json.dumps(entry) + '\n')
        _, _, body = self.request('GET', '/api/data')
        data = json.loads(body)['programs'][0]['lanes'][0]
        self.assertEqual(data['map'][0]['title'], 'Synthetic')
        self.assertEqual(data['gadgets'], data['map'])
        self.assertIsNone(data['findings'])
        self.assertIn('ledger_missing', data['warnings'])

    def test_coverage_reads_committed_wal_and_marks_stale(self):
        import sqlite3
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'ledgers').mkdir(parents=True)
        db = sqlite3.connect(lane / 'ledgers' / 'surface_coverage.sqlite')
        self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT); CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);')
        db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('S-1', 'route', 'fixture.test', '/one', 'q', 'page', 'v2', 'run'))
        db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', ('S-1', 'xss', 'exhausted', '', '', 'one input', '["encoding"]', '[]', '', 'v1'))
        db.commit()
        _, _, body = self.request('GET', '/api/data')
        coverage = json.loads(body)['programs'][0]['lanes'][0]['coverage']
        self.assertEqual(coverage['counts'], {'stale': 1})
        self.assertEqual(coverage['items'][0]['status'], 'stale')
        self.assertEqual(coverage['items'][0]['prior_status'], 'bounded_review')
        self.assertEqual(coverage['items'][0]['boundary'], 'one input')
        self.assertEqual(coverage['unclassified_surfaces'], 0)
        self.assertEqual(coverage['mapped_kinds'], {'route': 1})

    def test_report_open_revision_and_refuses_even_stale_autosaves(self):
        from urllib.parse import urlencode
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        reports = lane / 'reports' / 'raw'
        reports.mkdir(parents=True)
        report = reports / 'F01_example.md'
        report.write_text('# Original\n')
        _, _, body = self.request('GET', '/api/data')
        listing = json.loads(body)['programs'][0]['lanes'][0]['reports']
        self.assertEqual(listing[0]['path'], 'raw/F01_example.md')
        url = '/api/report?' + urlencode({'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'path': 'raw/F01_example.md'})
        status, headers, body = self.request('GET', url)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['content'], '# Original\n')
        revision = json.loads(body)['revision']
        self.assertEqual(headers['ETag'], '"' + revision + '"')
        report.write_text('# External change\n')
        for text in ('# Draft 1', '# Draft 2'):
            status, _, _ = self.request('PUT', url, json.dumps({'content': text, 'revision': revision}), {'Content-Type': 'application/json'})
            self.assertEqual(status, 403)
        self.assertEqual(report.read_text(), '# External change\n')

    def test_rejects_untrusted_host_and_cross_origin_requests(self):
        status, _, _ = self.request('GET', '/api/data', headers={'Host': 'evil.test:' + str(self.port)})
        self.assertEqual(status, 403)
        status, _, _ = self.request('GET', '/api/data', headers={'Origin': 'https://evil.test'})
        self.assertEqual(status, 403)
        status, _, _ = self.request('GET', '/api/data', headers={'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(status, 403)
        status, _, _ = self.request('GET', '/api/data', headers={'Origin': f'http://127.0.0.1:{self.port}'})
        self.assertEqual(status, 200)

    def test_report_paths_and_symlinks_cannot_escape_root(self):
        from urllib.parse import urlencode
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'reports').mkdir(parents=True)
        outside = self.root / 'outside.md'
        outside.write_text('private sentinel')
        (lane / 'reports' / 'link.md').symlink_to(outside)
        (lane / 'reports' / 'sub').symlink_to(self.root, target_is_directory=True)
        for path in ('link.md', 'sub/outside.md', '../../../outside.md', '/outside.md'):
            query = urlencode({'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'path': path})
            status, _, body = self.request('GET', '/api/report?' + query)
            self.assertEqual(status, 404)
            self.assertNotIn(b'private sentinel', body)
        _, _, body = self.request('GET', '/api/data')
        self.assertEqual(json.loads(body)['programs'][0]['lanes'][0]['reports'], [])

    def test_serves_static_files_without_exposing_sibling_paths(self):
        static = self.root / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<h1>Fixture</h1>')
        (static / 'app.js').write_text('console.log(1)')
        self.server.static_root = static
        status, headers, body = self.request('GET', '/')
        self.assertEqual(status, 200)
        self.assertIn(b'Fixture', body)
        self.assertTrue(headers['Content-Type'].startswith('text/html'))
        status, _, _ = self.request('GET', '/%2e%2e/outside.md')
        self.assertEqual(status, 404)

    def test_missing_root_is_unknown_not_empty_success(self):
        self.root.rename(self.root.with_name(self.root.name + '-renamed'))
        try:
            status, _, body = self.request('GET', '/api/data')
            self.assertEqual(status, 200)
            self.assertIn('root_unavailable', json.loads(body)['warnings'])
        finally:
            self.root.with_name(self.root.name + '-renamed').rename(self.root)

    def test_symlinked_ledgers_and_databases_are_not_read(self):
        import sqlite3
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'ledgers').mkdir(parents=True)
        secret = self.root / 'secret.json'
        secret.write_text(json.dumps({'findings': [{'fid': 'SECRET'}]}))
        (lane / 'ledgers' / 'ledger.json').symlink_to(secret)
        db_path = self.root / 'outside.sqlite'
        sqlite3.connect(db_path).close()
        (lane / 'ledgers' / 'surface_coverage.sqlite').symlink_to(db_path)
        _, _, body = self.request('GET', '/api/data')
        self.assertNotIn(b'SECRET', body)
        data = json.loads(body)['programs'][0]['lanes'][0]
        self.assertIsNone(data['findings'])
        self.assertIsNone(data['coverage'])
        self.assertIn('coverage_unavailable_or_invalid', data['warnings'])

    def test_unreadable_program_does_not_break_portfolio(self):
        program = self.root / 'web_bounty' / 'fictional'
        program.mkdir(parents=True)
        program.chmod(0)
        try:
            status, _, body = self.request('GET', '/api/data')
            self.assertEqual(status, 200)
            self.assertIn('discovery_incomplete', json.loads(body)['warnings'])
        finally:
            program.chmod(0o700)

    def test_simultaneous_autosaves_never_overwrite_external_edit(self):
        from urllib.parse import urlencode
        from concurrent.futures import ThreadPoolExecutor
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'reports').mkdir(parents=True)
        report = lane / 'reports' / 'example.md'
        report.write_text('before')
        url = '/api/report?' + urlencode({'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'path': 'example.md'})
        revision = json.loads(self.request('GET', url)[2])['revision']
        report.write_text('outside edit')
        barrier = threading.Barrier(2)
        def save(value):
            barrier.wait(timeout=3)
            return self.request('PUT', url, json.dumps({'revision': revision, 'content': value}), {'Content-Type': 'application/json'})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(save, ['draft one', 'draft two'])), [403, 403])
        self.assertEqual(report.read_text(), 'outside edit')

    def test_malformed_ledger_record_does_not_hide_incomplete_data(self):
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'ledgers' / 'ledger.json').write_text(json.dumps({'version': 2, 'findings': [{'fid': 'F01'}, 'invalid']}))
        data = json.loads(self.request('GET', '/api/data')[2])['programs'][0]['lanes'][0]
        self.assertIsNone(data['findings'])
        self.assertIn('ledger_unavailable_or_invalid', data['warnings'])

    def test_coverage_summary_uses_same_snapshot_as_questions(self):
        import sqlite3
        from unittest.mock import patch
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'ledgers').mkdir(parents=True)
        path = lane / 'ledgers' / 'surface_coverage.sqlite'
        writer = sqlite3.connect(path)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.executescript('CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT); CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);')
        writer.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('S-1', 'route', 'fixture.test', '/', '', '', 'v1', 'run'))
        writer.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', ('S-1', 'xss', 'no_assessment', '', '', '', '[]', '[]', '', ''))
        writer.commit()
        original_connect = sqlite3.connect
        class ConnectionWrapper:
            def __init__(self, conn): self.conn = conn
            @property
            def row_factory(self): return self.conn.row_factory
            @row_factory.setter
            def row_factory(self, value): self.conn.row_factory = value
            def execute(self, sql, *args):
                cursor = self.conn.execute(sql, *args)
                if 'JOIN surfaces' in sql:
                    concurrent = original_connect(path)
                    try:
                        concurrent.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('S-2', 'route', 'fixture.test', '/two', '', '', 'v1', 'run'))
                        concurrent.commit()
                    finally:
                        concurrent.close()
                return cursor
            def close(self): self.conn.close()
        try:
            with patch.object(sqlite3, 'connect', side_effect=lambda *a, **kw: ConnectionWrapper(original_connect(*a, **kw))):
                data = json.loads(self.request('GET', '/api/data')[2])['programs'][0]['lanes'][0]['coverage']
            self.assertEqual(data['total'], 1)
            self.assertEqual(data['mapped_kinds'], {'route': 1})
        finally:
            writer.close()

    def test_discovers_only_canonical_program_lanes(self):
        (self.root / 'web_bounty' / 'fictional' / 'web').mkdir(parents=True)
        (self.root / 'web_bounty' / '_internal' / 'web').mkdir(parents=True)
        (self.root / 'web_bounty' / 'fictional' / '_private').mkdir()
        status, _, body = self.request('GET', '/api/data')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual([(p['family'], p['name'], [l['name'] for l in p['lanes']]) for p in data['programs']], [('web_bounty', 'fictional', ['web'])])
        self.assertIn('warnings', data)


if __name__ == '__main__':
    unittest.main()
