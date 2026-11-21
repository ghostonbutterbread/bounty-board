"""Synthetic coverage contract exercised through the real HTTP endpoint."""
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

import app


class DashboardCoverageTests(unittest.TestCase):
    def test_unassessed_and_nullable_fingerprints_survive_http_read_in_wal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lane = root / 'web_bounty/synthetic/web'
            (lane / 'ledgers').mkdir(parents=True)
            (lane / 'ledgers/ledger.json').write_text('{"findings": []}')
            writer = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
            writer.execute('PRAGMA journal_mode=WAL')
            writer.executescript('''CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT);
            CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);''')
            writer.executemany('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', [
                ('a','endpoint','example.test','/assessed',None,None,None,None),
                ('b','endpoint','example.test','/<unassessed>', 'token', 'handler', None, None),
                ('c','endpoint','example.test','/no-assessment',None,None,'new',None),
                ('d','endpoint','example.test','/stale',None,None,None,'new-run')])
            writer.executemany('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', [
                ('a','xss','open',None,None,None,'[]','[]',None,'old'),
                ('c','xss','untested',None,None,None,'[]','[]',None,'old'),
                ('d','xss','open',None,None,None,'[]','[]',None,'@mapper-run:old-run')])
            writer.commit()
            server = app.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('GET', '/api/data'); response = conn.getresponse()
                self.assertEqual(response.status, 200)
                data = json.loads(response.read()); conn.close()
                value = data['programs'][0]['lanes'][0]['coverage']
                self.assertEqual(value['unclassified_surfaces'], 1)
                self.assertEqual(value['unassessed_surfaces'][0]['surface_key'], '/<unassessed>')
                items = {item['surface_id']: item for item in value['items']}
                self.assertEqual(items['a']['status'], 'open')
                self.assertEqual(items['a']['freshness'], 'unknown')
                self.assertEqual(items['c']['status'], 'no_assessment')
                self.assertEqual(items['d']['status'], 'stale')
                self.assertEqual(value['total'], 3)
            finally:
                server.shutdown(); thread.join(); server.server_close(); writer.close()


    def test_blob_values_only_disable_the_affected_lane_over_http(self):
        for bad_field in ('run_id', 'input_key'):
            with self.subTest(bad_field=bad_field), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                writers = []
                for name in ('bad', 'good'):
                    lane = root / 'web_bounty' / name / 'web'
                    (lane / 'ledgers').mkdir(parents=True)
                    (lane / 'ledgers/ledger.json').write_text('{"findings": []}')
                    db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
                    writers.append(db)
                    db.execute('PRAGMA journal_mode=WAL')
                    db.executescript('''CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT);
                    CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);''')
                    run_id = b'bad' if name == 'bad' and bad_field == 'run_id' else '実行'
                    input_key = b'bad' if name == 'bad' and bad_field == 'input_key' else '鍵'
                    db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('a','endpoint','例.test','/評価',None,None,None,run_id))
                    db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('b','endpoint','例.test','/未評価',input_key,None,None,None))
                    db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', ('a','xss','open',None,None,None,'[]','[]',None,'@mapper-run:実行'))
                    db.commit()
                server = app.make_server(root, port=0)
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                try:
                    conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    try:
                        conn.request('GET', '/api/data'); response = conn.getresponse()
                        self.assertEqual(response.status, 200)
                        programs = {p['name']: p['lanes'][0] for p in json.loads(response.read())['programs']}
                    finally:
                        conn.close()
                    self.assertIsNone(programs['bad']['coverage'])
                    self.assertIn('coverage_unavailable_or_invalid', programs['bad']['warnings'])
                    self.assertEqual(programs['bad']['findings'], [])
                    good = programs['good']['coverage']
                    self.assertNotIn('coverage_unavailable_or_invalid', programs['good']['warnings'])
                    self.assertEqual(good['items'][0]['freshness'], 'current')
                    self.assertEqual(good['items'][0]['run_id'], '実行')
                    self.assertEqual(good['unassessed_surfaces'][0]['input_key'], '鍵')
                finally:
                    server.shutdown(); thread.join(); server.server_close()
                    for db in writers: db.close()

    def test_dynamic_scalars_and_nested_json_remain_safe_over_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lane = root / 'web_bounty/synthetic/web'
            (lane / 'ledgers').mkdir(parents=True)
            db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
            db.executescript('''CREATE TABLE surfaces (id, kind, host, surface_key, input_key, consumer, fingerprint, run_id);
            CREATE TABLE assessments (surface_id, class_name, status, pressure, reason, boundary, axes_json, evidence_json, reopen_when, assessed_fingerprint);
            INSERT INTO surfaces VALUES ('a','endpoint','例.test','/評価',NULL,NULL,NULL,42);
            INSERT INTO surfaces VALUES ('b','endpoint','例.test','/未評価',3.5,NULL,NULL,NULL);
            INSERT INTO assessments VALUES ('a','xss','open',NULL,NULL,NULL,'["鍵"]','[]',NULL,'@mapper-run:42');''')
            db.commit()
            server = app.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            def get_lane():
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                try:
                    conn.request('GET', '/api/data'); response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    return json.loads(response.read())['programs'][0]['lanes'][0]
                finally:
                    conn.close()
            try:
                valid = get_lane()['coverage']
                self.assertEqual(valid['items'][0]['run_id'], 42)
                self.assertEqual(valid['items'][0]['freshness'], 'current')
                self.assertEqual(valid['items'][0]['axes'], ['鍵'])
                self.assertEqual(valid['unassessed_surfaces'][0]['input_key'], 3.5)
                cases = [
                    ('UPDATE surfaces SET kind=? WHERE id="b"', b'bad', 'UPDATE surfaces SET kind="endpoint" WHERE id="b"'),
                    ('UPDATE assessments SET reason=?', b'bad', 'UPDATE assessments SET reason=NULL'),
                    ('UPDATE assessments SET axes_json=?', '[NaN]', 'UPDATE assessments SET axes_json=\'[]\''),
                    ('UPDATE assessments SET evidence_json=?', '["\\ud800"]', 'UPDATE assessments SET evidence_json=\'[]\''),
                    ('UPDATE surfaces SET input_key=? WHERE id="b"', float('inf'), 'UPDATE surfaces SET input_key=3.5 WHERE id="b"'),
                ]
                for index, (update, value, reset) in enumerate(cases):
                    with self.subTest(case=index):
                        db.execute(update, (value,)); db.commit()
                        bad = get_lane()
                        self.assertIsNone(bad['coverage'])
                        self.assertIn('coverage_unavailable_or_invalid', bad['warnings'])
                        db.execute(reset); db.commit()
                self.assertIsNotNone(get_lane()['coverage'])
            finally:
                server.shutdown(); thread.join(); server.server_close(); db.close()

    def test_mixed_kind_keys_preserve_all_counts_without_duplicate_json_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lane = root / 'web_bounty/synthetic/web'
            (lane / 'ledgers').mkdir(parents=True)
            db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
            db.executescript('''CREATE TABLE surfaces (id, kind, host, surface_key, input_key, consumer, fingerprint, run_id);
            CREATE TABLE assessments (surface_id, class_name, status, pressure, reason, boundary, axes_json, evidence_json, reopen_when, assessed_fingerprint);''')
            for index, kind in enumerate([1, '1', '1', None, 'null', 'unknown', 1.5, '1.5']):
                db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', (str(index), kind, 'h', '/s', None, None, None, None))
            db.commit(); db.close()
            server = app.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                try:
                    conn.request('GET', '/api/data'); response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    def no_duplicates(pairs):
                        result = {}
                        for key, value in pairs:
                            self.assertNotIn(key, result, f'duplicate JSON key: {key}')
                            result[key] = value
                        return result
                    data = json.loads(response.read(), object_pairs_hook=no_duplicates)
                finally:
                    conn.close()
                kinds = data['programs'][0]['lanes'][0]['coverage']['mapped_kinds']
                self.assertEqual(kinds, {'1': 3, 'null': 2, 'unknown': 1, '1.5': 2})
                self.assertEqual(sum(kinds.values()), 8)
            finally:
                server.shutdown(); thread.join(); server.server_close()

    @unittest.skipUnless(sys.version_info[:2] == (3, 12), 'Python 3.12 encoder boundary fixture')
    def test_encoder_depth_failure_is_isolated_for_map_and_coverage(self):
        # Locate this interpreter's actual decoder limit rather than assuming
        # the C recursion limit is identical across Python 3.12 builds.
        def decodes(depth):
            try:
                json.loads('[' * depth + '0' + ']' * depth)
                return True
            except RecursionError:
                return False
        high = 1
        while high < 100000 and decodes(high):
            high *= 2
        if high >= 100000 and decodes(high):
            self.skipTest('no decoder recursion boundary found within fixture limit')
        low = high // 2
        while low + 1 < high:
            middle = (low + high) // 2
            if decodes(middle):
                low = middle
            else:
                high = middle
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lane = root / 'web_bounty/synthetic/web'
            (lane / 'ledgers').mkdir(parents=True)
            (lane / 'recon/maps').mkdir(parents=True)
            (lane / 'ledgers/ledger.json').write_text('{"findings": []}')
            db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
            db.executescript('''CREATE TABLE surfaces (id, kind, host, surface_key, input_key, consumer, fingerprint, run_id);
            CREATE TABLE assessments (surface_id, class_name, status, pressure, reason, boundary, axes_json, evidence_json, reopen_when, assessed_fingerprint);
            INSERT INTO surfaces VALUES ('a','endpoint','h','/s',NULL,NULL,NULL,NULL);
            INSERT INTO assessments VALUES ('a','xss','open',NULL,NULL,NULL,'[]','[]',NULL,NULL);''')
            db.commit()
            server = app.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            real_dumps = json.dumps
            failed = set()
            def observe_encoder(value, *args, **kwargs):
                try:
                    return real_dumps(value, *args, **kwargs)
                except RecursionError:
                    if isinstance(value, dict) and 'programs' in value:
                        lane_data = value['programs'][0]['lanes'][0]
                        failed.update(k for k in ('map', 'coverage') if k in lane_data)
                    raise
            try:
                with mock.patch.object(app.json, 'dumps', side_effect=observe_encoder):
                    # The request handler runs in a shallower Python stack than
                    # this unittest method, so probe both sides of the limit.
                    for depth in range(max(1, high - 60), high + 60):
                        deep = '[' * depth + '0' + ']' * depth
                        (lane / 'recon/maps/map.jsonl').write_text('{"path":"a/index.md","tags":' + deep + '}')
                        db.execute('UPDATE assessments SET axes_json=?', (deep,)); db.commit()
                        conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                        try:
                            conn.request('GET', '/api/data'); response = conn.getresponse()
                            self.assertEqual(response.status, 200)
                            raw = response.read()
                            self.assertNotIn(str(root).encode(), raw)
                            if 'map' in failed:
                                self.assertIn(b'map_unavailable_or_invalid', raw)
                            if 'coverage' in failed:
                                self.assertIn(b'coverage_unavailable_or_invalid', raw)
                        finally:
                            conn.close()
                        if failed == {'map', 'coverage'}:
                            break
                self.assertEqual(failed, {'map', 'coverage'})
            finally:
                server.shutdown(); thread.join(); server.server_close(); db.close()

    def test_deep_assessment_json_is_isolated_over_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deep = '[' * 15000 + '0' + ']' * 15000
            try:
                json.loads(deep)
            except RecursionError:
                parseable = False
            else:
                parseable = True
            for name in ('bad', 'good'):
                lane = root / 'web_bounty' / name / 'web'
                (lane / 'ledgers').mkdir(parents=True)
                (lane / 'ledgers/ledger.json').write_text('{"findings": []}')
                db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
                db.executescript('''CREATE TABLE surfaces (id, kind, host, surface_key, input_key, consumer, fingerprint, run_id);
                CREATE TABLE assessments (surface_id, class_name, status, pressure, reason, boundary, axes_json, evidence_json, reopen_when, assessed_fingerprint);
                INSERT INTO surfaces VALUES ('a','endpoint','h','/s',NULL,NULL,NULL,NULL);''')
                axes = deep if name == 'bad' else '[]'
                db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', ('a','xss','open',None,None,None,axes,'[]',None,None))
                db.commit(); db.close()
            server = app.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                try:
                    conn.request('GET', '/api/data'); response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    raw = response.read()
                    self.assertNotIn(str(root), raw.decode())
                    programs = {p['name']: p['lanes'][0] for p in json.loads(raw)['programs']}
                finally:
                    conn.close()
                self.assertEqual(programs['good']['coverage']['total'], 1)
                self.assertEqual(programs['bad']['findings'], [])
                if not parseable:
                    self.assertIsNone(programs['bad']['coverage'])
                if programs['bad']['coverage'] is None:
                    self.assertIn('coverage_unavailable_or_invalid', programs['bad']['warnings'])
                else:
                    self.assertEqual(programs['bad']['coverage']['total'], 1)
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_invalid_coverage_payload_is_unavailable_without_disconnecting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lane = root / 'web_bounty/synthetic/web'
            (lane / 'ledgers').mkdir(parents=True)
            db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
            db.executescript('''CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT);
            CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);
            INSERT INTO surfaces VALUES ('a','endpoint','h','/s',NULL,NULL,NULL,NULL);
            INSERT INTO assessments VALUES ('a','xss','open',NULL,NULL,NULL,NULL,'[]',NULL,NULL);''')
            db.commit(); db.close()
            server = app.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('GET', '/api/data'); response = conn.getresponse()
                self.assertEqual(response.status, 200)
                lane_data = json.loads(response.read())['programs'][0]['lanes'][0]
                conn.close()
                self.assertIsNone(lane_data['coverage'])
                self.assertIn('coverage_unavailable_or_invalid', lane_data['warnings'])
            finally:
                server.shutdown(); thread.join(); server.server_close()


if __name__ == '__main__':
    unittest.main()
