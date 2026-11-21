"""Ledger failures stay lane-local through the real HTTP endpoint."""
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

import app


class LedgerIsolationTests(unittest.TestCase):
    def test_invalid_ledger_is_unknown_without_breaking_other_program(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('bad', 'good'):
                (root / 'web_bounty' / name / 'web/ledgers').mkdir(parents=True)
            good = {'findings': [{'fid': 'F01', 'title': '安全 🌍', 'severity': 3.5,
                                  'current': {'status': 'confirmed', 'score': 42}}]}
            good_file = root / 'web_bounty/good/web/ledgers/ledger.json'
            bad_file = root / 'web_bounty/bad/web/ledgers/ledger.json'
            good_file.write_text(json.dumps(good, ensure_ascii=False), encoding='utf-8')
            server = app.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever); thread.start()
            def fetch():
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    conn.request('GET', '/api/data'); response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    body = response.read()
                    self.assertNotIn(str(root).encode(), body)
                    self.assertNotIn(b'ledger-private-canary', body)
                    def reject_constant(value):
                        raise AssertionError('non-JSON number: ' + value)
                    return {p['name']: p['lanes'][0] for p in json.loads(body, parse_constant=reject_constant)['programs']}
                finally:
                    conn.close()
            try:
                bad_file.write_text(json.dumps(good, ensure_ascii=False), encoding='utf-8')
                self.assertEqual(fetch()['bad']['findings'][0]['title'], '安全 🌍')
                cases = [
                    '{"findings":[{"title":"\\ud800"}]}',
                    '{"findings":[{"title":"bad", "current":{"score":1e400}}]}',
                    '{"findings":[{"title":"bad", "current":{"score":NaN}}]}',
                    '{"findings":[{"title":"bad", "unused":"\\udfff"}]}',
                    '{"findings":[{"title":' + '[' * 200000 + '0' + ']' * 200000 + '}]}',
                ]
                for raw in cases:
                    with self.subTest(case=raw[:60]):
                        bad_file.write_text(raw[:-1] + ',"private":"ledger-private-canary"}', encoding='utf-8')
                        lanes = fetch()
                        self.assertIsNone(lanes['bad']['findings'])
                        self.assertIn('ledger_unavailable_or_invalid', lanes['bad']['warnings'])
                        self.assertNotIn('ledger_unavailable_or_invalid', lanes['good']['warnings'])
                        finding = lanes['good']['findings'][0]
                        self.assertEqual((finding['title'], finding['severity'], finding['current']['score']), ('安全 🌍', 3.5, 42))
                bad_file.write_text(json.dumps(good, ensure_ascii=False), encoding='utf-8')
                self.assertEqual(fetch()['bad']['findings'][0]['title'], '安全 🌍')
            finally:
                server.shutdown(); thread.join(); server.server_close()
