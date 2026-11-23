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

    def bind_finding(self, payload):
        data = json.loads(self.request('GET', '/api/data')[2])
        program = next(p for p in data['programs'] if p['family'] == payload['family'] and p['name'] == payload['program'])
        lane = next(l for l in program['lanes'] if l['name'] == payload['lane'])
        finding = next(f for f in lane['findings'] if f['fid'] == payload['fid'])
        return {**payload, 'root_instance': data['root_instance'], 'expected_revision': finding['metadata_revision']}

    def test_missing_writer_disables_writes_but_read_endpoint_works(self):
        server = app.make_server(self.root, port=0, writer=self.root / 'missing-bbh', accept_uncoordinated_writes=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        old_server, old_port = self.server, self.port
        self.server, self.port = server, server.server_port
        try:
            status, _, body = self.request('GET', '/api/data')
            self.assertEqual(status, 200)
            self.assertFalse(json.loads(body)['capabilities']['finding_metadata'])
            headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
            self.assertEqual(self.request('PATCH', '/api/finding', '{}', headers)[0], 503)
        finally:
            self.server, self.port = old_server, old_port
            server.shutdown(); thread.join(); server.server_close()

    def test_writer_requires_explicit_uncoordinated_write_acknowledgement(self):
        writer = self.root / 'fake-bbh'
        marker = self.root / 'invoked'
        writer.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nprintf "%s\\n" "--edit-finding --patch-file --root --family --lane"\n')
        writer.chmod(0o700)
        lane = self.root / 'web_bounty/fictional/web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'reports').mkdir()
        ledger = lane / 'ledgers/ledger.json'
        before = json.dumps({'findings': [{'fid': 'F01', 'severity': 'LOW'}]})
        ledger.write_text(before)
        server = app.make_server(self.root, port=0, writer=writer)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        old_server, old_port = self.server, self.port
        self.server, self.port = server, server.server_port
        try:
            data = json.loads(self.request('GET', '/api/data')[2])
            self.assertFalse(data['capabilities']['finding_metadata'])
            self.assertEqual(data['capabilities']['finding_fields'], [])
            self.assertEqual(data['capabilities']['finding_options'], {})
            self.assertIn('uncoordinated', data['capabilities']['finding_metadata_warning'].lower())
            headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
            payload = {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'F01', 'patch': {'severity': 'HIGH'}}
            self.assertEqual(self.request('PATCH', '/api/finding', json.dumps(payload), headers)[0], 503)
            self.assertFalse(marker.exists())
            self.assertEqual(ledger.read_text(), before)
        finally:
            self.server, self.port = old_server, old_port
            server.shutdown(); thread.join(); server.server_close()

    def test_capability_reports_explicit_metadata_options(self):
        writer = self.root / 'fake-bbh'
        writer.write_text('#!/bin/sh\nprintf "%s\\n" "--edit-finding --patch-file --root --family --lane"\n')
        writer.chmod(0o700)
        server = app.make_server(self.root, port=0, writer=writer, accept_uncoordinated_writes=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        old_server, old_port = self.server, self.port
        self.server, self.port = server, server.server_port
        try:
            cap = json.loads(self.request('GET', '/api/data')[2])['capabilities']
            self.assertTrue(cap['finding_metadata'])
            self.assertIn('uncoordinated', cap['finding_metadata_warning'].lower())
            self.assertIn('HIGH', cap['finding_options']['severity'])
            self.assertIn('dormant', cap['finding_options']['status'])
        finally:
            self.server, self.port = old_server, old_port
            server.shutdown(); thread.join(); server.server_close()

    def test_acknowledged_synthetic_writer_updates_finding(self):
        import sys
        writer = self.root / 'fake-bbh'
        writer.write_text(
            '#!' + sys.executable + '\n'
            'import json, sys\nfrom pathlib import Path\n'
            'if "--help" in sys.argv:\n'
            '    print("--edit-finding --patch-file --root --family --lane")\n'
            'else:\n'
            '    args = sys.argv\n'
            '    value = lambda key: args[args.index(key) + 1]\n'
            '    ledger = Path(value("--root")) / value("--family") / args[2] / value("--lane") / "ledgers/ledger.json"\n'
            '    data = json.loads(ledger.read_text())\n'
            '    data["findings"][0].update(json.loads(Path(value("--patch-file")).read_text()))\n'
            '    ledger.write_text(json.dumps(data))\n')
        writer.chmod(0o700)
        lane = self.root / 'web_bounty/fictional/web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'reports').mkdir()
        ledger = lane / 'ledgers/ledger.json'
        ledger.write_text(json.dumps({'findings': [{'fid': 'F01', 'severity': 'LOW'}]}))
        server = app.make_server(self.root, port=0, writer=writer, accept_uncoordinated_writes=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        old_server, old_port = self.server, self.port
        self.server, self.port = server, server.server_port
        try:
            payload = {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'F01', 'patch': {'severity': 'HIGH'}}
            headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
            payload = self.bind_finding(payload)
            status, _, body = self.request('PATCH', '/api/finding', json.dumps(payload), headers)
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)['finding']['severity'], 'HIGH')
            self.assertEqual(json.loads(ledger.read_text())['findings'][0]['severity'], 'HIGH')
        finally:
            self.server, self.port = old_server, old_port
            server.shutdown(); thread.join(); server.server_close()

    def test_writer_runtime_failure_disables_capability_without_affecting_reads(self):
        writer = self.root / 'fake-bbh'
        writer.write_text('#!/bin/sh\nif [ "$2" = "--help" ]; then printf "%s\\n" "--edit-finding --patch-file --root --family --lane"; exit 0; fi\nexit 1\n')
        writer.chmod(0o700)
        lane = self.root / 'web_bounty/fictional/web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'reports').mkdir()
        (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'F01', 'severity': 'LOW'}]}))
        server = app.make_server(self.root, port=0, writer=writer, accept_uncoordinated_writes=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        old_server, old_port = self.server, self.port
        self.server, self.port = server, server.server_port
        try:
            payload = {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'F01', 'patch': {'severity': 'HIGH'}}
            headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
            payload = self.bind_finding(payload)
            self.assertEqual(self.request('PATCH', '/api/finding', json.dumps(payload), headers)[0], 502)
            status, _, body = self.request('GET', '/api/data')
            data = json.loads(body)
            self.assertEqual(status, 200)
            self.assertFalse(data['capabilities']['finding_metadata'])
            self.assertEqual(data['programs'][0]['lanes'][0]['findings'][0]['severity'], 'LOW')
        finally:
            self.server, self.port = old_server, old_port
            server.shutdown(); thread.join(); server.server_close()

    def test_write_refuses_context_symlink_before_launching_writer(self):
        writer = self.root / 'fake-bbh'
        marker = self.root / 'launched'
        writer.write_text('#!/bin/sh\nif [ "$2" = "--help" ]; then printf "%s\\n" "--edit-finding --patch-file --root --family --lane"; else touch "' + str(marker) + '"; fi\n')
        writer.chmod(0o700)
        lane = self.root / 'web_bounty/fictional/web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'reports').mkdir()
        (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'F01'}]}))
        (lane / 'context').symlink_to(self.root, target_is_directory=True)
        server = app.make_server(self.root, port=0, writer=writer, accept_uncoordinated_writes=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        old_server, old_port = self.server, self.port
        self.server, self.port = server, server.server_port
        try:
            payload = {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'F01', 'patch': {'severity': 'HIGH'}}
            headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
            payload = self.bind_finding(payload)
            status, _, body = self.request('PATCH', '/api/finding', json.dumps(payload), headers)
            self.assertEqual(status, 409, body)
            self.assertFalse(marker.exists())
            (lane / 'context').unlink()
            inaccessible = lane / 'reports/private'
            inaccessible.mkdir()
            inaccessible.chmod(0)
            try:
                status, _, body = self.request('PATCH', '/api/finding', json.dumps(payload), headers)
                self.assertEqual(status, 409, body)
                self.assertFalse(marker.exists())
            finally:
                inaccessible.chmod(0o700)
        finally:
            self.server, self.port = old_server, old_port
            server.shutdown(); thread.join(); server.server_close()

    def test_write_verification_checks_v2_current_status_too(self):
        writer = self.root / 'fake-bbh'
        writer.write_text('#!/bin/sh\nif [ "$2" = "--help" ]; then printf "%s\\n" "--edit-finding --patch-file --root --family --lane"; fi\nexit 0\n')
        writer.chmod(0o700)
        lane = self.root / 'web_bounty/fictional/web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'reports').mkdir()
        (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'F01', 'status': 'dormant', 'current': {'status': 'raw'}}]}))
        server = app.make_server(self.root, port=0, writer=writer, accept_uncoordinated_writes=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        old_server, old_port = self.server, self.port
        self.server, self.port = server, server.server_port
        try:
            payload = {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'F01', 'patch': {'status': 'dormant'}}
            headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
            payload = self.bind_finding(payload)
            status, _, body = self.request('PATCH', '/api/finding', json.dumps(payload), headers)
            self.assertEqual(status, 502, body)
            self.assertEqual(json.loads(body)['error'], 'verification_failed')
            self.assertFalse(json.loads(self.request('GET', '/api/data')[2])['capabilities']['finding_metadata'])
        finally:
            self.server, self.port = old_server, old_port
            server.shutdown(); thread.join(); server.server_close()

    def test_real_bbh_metadata_write_on_disposable_fixture(self):
        import os
        import subprocess
        from unittest.mock import patch
        bbh = Path('/home/ryushe/.local/bin/bbh')
        if not bbh.exists():
            self.skipTest('real BBH runtime unavailable')
        home = self.root / 'isolated-home'
        home.mkdir()
        data_root = self.root / 'synthetic-root'
        data_root.mkdir()
        env = {'HOME': str(home), 'TMPDIR': str(self.root), 'PATH': os.environ.get('PATH', ''),
               'XDG_CONFIG_HOME': str(home / 'config'), 'XDG_DATA_HOME': str(home / 'data'), 'XDG_CACHE_HOME': str(home / 'cache')}
        note = self.root / 'note.md'
        note.write_text('Title: Synthetic fixture\nClass: xss\nSeverity: LOW\nFile: src/example.js\nDescription: Fixture only.\n')
        command = [str(bbh), 'agents/manual_hunter.py', 'fictional.example', '--family', 'web_bounty', '--lane', 'web', '--root', str(data_root), '--from-file', str(note)]
        created = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(created.returncode, 0, created.stderr)
        ledger = data_root / 'web_bounty/fictional.example/web/ledgers/ledger.json'
        before = json.loads(ledger.read_text())['findings'][0]
        report = Path(before['report_dir']) / ('synthetic-' + before['fid'] + '.md')
        report.write_text('# Human-authored report\nKeep this exact content.\n')
        registered = subprocess.run([str(bbh), 'agents/finding_report.py', 'fictional.example', before['fid'], '--family', 'web_bounty', '--lane', 'web', '--storage-root', str(data_root), '--report', str(report)], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(registered.returncode, 0, registered.stderr)
        before = json.loads(ledger.read_text())['findings'][0]
        report_before = report.read_bytes()
        with patch.dict(os.environ, env, clear=True):
            server = app.make_server(data_root, port=0, writer=bbh, accept_uncoordinated_writes=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            old_server, old_port = self.server, self.port
            self.server, self.port = server, server.server_port
            try:
                payload = {'family': 'web_bounty', 'program': 'fictional.example', 'lane': 'web', 'fid': before['fid'], 'patch': {'severity': 'HIGH', 'class_name': 'ssrf', 'status': 'dormant', 'severity_rationale': 'fixture'}}
                headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
                payload = self.bind_finding(payload)
                for invalid_headers in ({}, {**headers, 'Host': f'evil.test:{self.port}'}, {**headers, 'Origin': 'https://evil.test'}, {**headers, 'Sec-Fetch-Site': 'cross-site'}, {**headers, 'Content-Type': 'text/plain'}):
                    self.assertEqual(self.request('PATCH', '/api/finding', json.dumps(payload), invalid_headers)[0], 403)
                for key, bad in (('program', '../fictional'), ('fid', before['fid'].lower()), ('fid', '--help')):
                    invalid = {**payload, key: bad}
                    self.assertIn(self.request('PATCH', '/api/finding', json.dumps(invalid), headers)[0], (400, 404))
                invalid = {**payload, 'patch': {'submission': 'submitted'}}
                self.assertEqual(self.request('PATCH', '/api/finding', json.dumps(invalid), headers)[0], 400)
                self.assertEqual(json.loads(ledger.read_text())['findings'][0], before)
                status, _, body = self.request('PATCH', '/api/finding', json.dumps(payload), headers)
                self.assertEqual(status, 200, body)
                after = json.loads(ledger.read_text())['findings'][0]
                self.assertEqual(after['fid'], before['fid'])
                self.assertEqual(after['severity'], 'HIGH')
                self.assertEqual(after['class_name'], 'ssrf')
                self.assertEqual(after['current']['status'], 'dormant')
                self.assertEqual(after['severity_rationale'], 'fixture')
                self.assertEqual(after['submission'], before['submission'])
                self.assertEqual(report.read_bytes(), report_before)
                self.assertEqual(after['report_path'], str(report))
                self.assertEqual(json.loads(body)['finding']['status'], 'dormant')
            finally:
                self.server, self.port = old_server, old_port
                server.shutdown(); thread.join(); server.server_close()

    def test_v2_status_rationale_and_source_paths(self):
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'ledgers').mkdir(parents=True)
        findings = [
            {'fid': 'F01', 'current': {'status': 'confirmed'}, 'severity_rationale': 'verified', 'report_path': '/exact/report.md', 'evidence_path': '/exact/EVIDENCE.md', 'report_dir': '/exact'},
            {'fid': 'F02', 'status': 'candidate', 'current': {'status': 'confirmed'}},
        ]
        (lane / 'ledgers' / 'ledger.json').write_text(json.dumps({'version': 2, 'findings': findings}))
        items = json.loads(self.request('GET', '/api/data')[2])['programs'][0]['lanes'][0]['findings']
        self.assertEqual(items[0]['status'], 'confirmed')
        self.assertEqual(items[0]['current']['status'], 'confirmed')
        self.assertEqual(items[0]['severity_rationale'], 'verified')
        self.assertEqual(items[0]['report_path'], '/exact/report.md')
        self.assertEqual(items[0]['evidence_path'], '/exact/EVIDENCE.md')
        self.assertEqual(items[1]['status'], 'candidate')

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

    def test_reports_identify_exact_registered_owner_without_basename_matching(self):
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'ledgers').mkdir(parents=True)
        for rel in ('findings/one/final.md', 'findings/two/final.md', 'findings/one/EVIDENCE.md', 'raw/index.md'):
            path = lane / 'reports' / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('<!-- generated: bounty-core-report-navigation -->' if rel == 'raw/index.md' else '# Fixture')
        entries = [{'fid': 'F01', 'report_path': str(lane / 'reports/findings/one/final.md'), 'evidence_path': str(lane / 'reports/findings/one/EVIDENCE.md')}]
        (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': entries}))
        items = json.loads(self.request('GET', '/api/data')[2])['programs'][0]['lanes'][0]['reports']
        by_path = {x['path']: x for x in items}
        self.assertEqual(by_path['findings/one/final.md']['kind'], 'registered_report')
        self.assertEqual(by_path['findings/one/final.md']['owner_fids'], ['F01'])
        self.assertEqual(by_path['findings/two/final.md']['kind'], 'unregistered')
        self.assertEqual(by_path['findings/one/EVIDENCE.md']['kind'], 'generated_evidence')
        self.assertEqual(by_path['findings/one/EVIDENCE.md']['owner_fids'], ['F01'])
        self.assertEqual(by_path['raw/index.md']['kind'], 'generated_navigation')
        self.assertTrue(all(x['editable'] is False for x in items))

    def test_unreadable_report_classification_is_unknown_with_warning(self):
        from unittest.mock import patch
        lane = self.root / 'web_bounty' / 'fictional' / 'web'
        (lane / 'reports').mkdir(parents=True)
        (lane / 'ledgers').mkdir()
        (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'F01', 'report_path': str(lane / 'reports/registered.md')}]}))
        (lane / 'reports/unreadable.md').write_text('fixture')
        (lane / 'reports/oversized.md').write_bytes(b'x' * 5_000_001)
        (lane / 'reports/invalid.md').write_bytes(b'\xff')
        (lane / 'reports/registered.md').write_bytes(b'\xff')
        real_read = app.read_file
        def fail_one(root, relative, **kwargs):
            if relative == 'reports/unreadable.md':
                raise PermissionError('fixture')
            return real_read(root, relative, **kwargs)
        with patch.object(app, 'read_file', side_effect=fail_one):
            data = json.loads(self.request('GET', '/api/data')[2])['programs'][0]['lanes'][0]
        items = {item['path']: item for item in data['reports']}
        for path in ('unreadable.md', 'oversized.md', 'invalid.md'):
            self.assertEqual(items[path]['kind'], 'unknown')
        self.assertEqual(items['registered.md']['kind'], 'registered_report')
        self.assertEqual(items['registered.md']['owner_fids'], ['F01'])
        self.assertEqual(data['warnings'].count('report_content_unavailable_or_invalid'), 1)

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
