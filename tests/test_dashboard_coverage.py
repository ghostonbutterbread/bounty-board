"""Synthetic coverage contract exercised through the real HTTP endpoint."""
import json
import sqlite3
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

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
