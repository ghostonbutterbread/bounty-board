import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server


class MetadataConflictTests(unittest.TestCase):
    def test_stale_finding_is_refused_before_writer_invocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lane = root / 'web_bounty/fictional/web'
            (lane / 'ledgers').mkdir(parents=True)
            (lane / 'reports').mkdir()
            ledger = lane / 'ledgers/ledger.json'
            ledger.write_text(json.dumps({'findings': [{'fid': 'F01', 'severity': 'LOW'}]}))
            marker = root / 'writer-invoked'
            writer = root / 'bbh'
            writer.write_text('#!/bin/sh\nif [ "$2" = "--help" ]; then echo "--edit-finding --patch-file --root --family --lane"; else touch "' + str(marker) + '"; fi\n')
            writer.chmod(0o700)
            server = make_test_server(root, 0, writer=writer, accept_uncoordinated_writes=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(method, path, payload=None):
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                headers = {'Origin': f'http://127.0.0.1:{server.server_port}', 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
                conn.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=headers)
                response = conn.getresponse()
                body = json.loads(response.read())
                conn.close()
                return response.status, body
            try:
                _, data = request('GET', '/api/data')
                finding = data['programs'][0]['lanes'][0]['findings'][0]
                payload = {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'F01', 'patch': {'severity': 'HIGH'}, 'expected_revision': finding.get('metadata_revision'), 'root_instance': data.get('root_instance')}
                self.assertIsInstance(payload['expected_revision'], str)
                self.assertIsInstance(payload['root_instance'], str)
                for key in ('expected_revision', 'root_instance'):
                    with self.subTest(missing=key):
                        missing = {k: v for k, v in payload.items() if k != key}
                        self.assertEqual(request('PATCH', '/api/finding', missing)[0], 400)
                    with self.subTest(mismatched=key):
                        bad = {**payload, key: '0' * 64}
                        self.assertEqual(request('PATCH', '/api/finding', bad)[0], 409)
                self.assertEqual(request('PATCH', '/api/finding', {**payload, 'fid': 'F02'})[0], 404)
                self.assertFalse(marker.exists())
                replacement = ledger.with_name('replacement.json')
                replacement.write_bytes(ledger.read_bytes())
                replacement.replace(ledger)
                self.assertEqual(request('PATCH', '/api/finding', payload)[0], 409)
                _, data = request('GET', '/api/data')
                payload['expected_revision'] = data['programs'][0]['lanes'][0]['findings'][0]['metadata_revision']
                ledger.write_text(json.dumps({'findings': [{'fid': 'F01', 'severity': 'MEDIUM'}]}))
                status, body = request('PATCH', '/api/finding', payload)
                self.assertEqual(status, 409, body)
                self.assertEqual(body['error'], 'finding_changed')
                for patch in ({'class_name': 'ssrf'}, {'status': 'dormant'}, {'severity_rationale': 'pending'}):
                    with self.subTest(patch=patch):
                        status, body = request('PATCH', '/api/finding', {**payload, 'patch': patch})
                        self.assertEqual(status, 409, body)
                        self.assertEqual(body['error'], 'finding_changed')
                self.assertFalse(marker.exists())
                self.assertEqual(json.loads(ledger.read_text())['findings'][0]['severity'], 'MEDIUM')
                ledger.write_text(json.dumps({'findings': []}))
                self.assertEqual(request('PATCH', '/api/finding', payload)[0], 404)
                displaced = root.with_name(root.name + '-away')
                root.rename(displaced)
                try:
                    self.assertEqual(request('PATCH', '/api/finding', payload)[0], 409)
                finally:
                    displaced.rename(root)
                self.assertFalse(marker.exists())
            finally:
                server.shutdown()
                thread.join()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
