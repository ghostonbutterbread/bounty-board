"""Recovery of stored collaboration data after a synthetic source disappears."""
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode

import app


class MissingSourceTests(unittest.TestCase):
    def test_recover_after_deletion_restart_and_exact_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True)
            report.write_text('initial\n')
            store = Path(tmp) / 'private'
            identity = dict(family='web_bounty', program='example', lane='web', path='report.md',
                            root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest())
            def start():
                server = app.make_server(root, 0, collaboration_dir=store)
                thread = threading.Thread(target=server.serve_forever); thread.start()
                return server, thread
            server, thread = start()
            def request(method='GET', payload=None, endpoint='', params=None, origin=None):
                host = f'127.0.0.1:{server.server_port}'
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    conn.request(method, '/api/collaboration'+endpoint+'?'+urlencode({**identity, **(params or {})}),
                                 json.dumps(payload) if payload is not None else None,
                                 {'Host':host, 'Origin':origin or 'http://'+host,
                                  'Content-Type':'application/json', 'X-Requested-With':'Bounty-Board'})
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
                finally: conn.close()
            try:
                # Recovery lookup never observes an existing, previously unseen source.
                unseen = report.parent / 'never.md'; unseen.write_text('unseen')
                identity['path'] = 'never.md'
                self.assertEqual(request(endpoint='/recovery')[0], 404)
                unseen.unlink()
                self.assertEqual(request()[0], 404)
                identity['path'] = 'report.md'
                base = request()[1]['revision']
                payload = {'base': base, 'content': 'saved\n', 'request_id': 'once'}
                receipt = request('POST', payload)[1]
                report.unlink()
                server.shutdown(); thread.join(); server.server_close()
                server, thread = start()
                status, state = request()
                self.assertEqual(status, 200, state)
                self.assertEqual((state['source_status'], state['content']), ('source_unavailable', 'saved\n'))
                self.assertEqual(request(endpoint='/history')[1]['source_status'], 'source_unavailable')
                self.assertEqual(request(endpoint='/version', params={'revision': base})[1]['content'], 'initial\n')
                self.assertEqual(request('POST', payload), (200, receipt))
                self.assertEqual(request('POST', {**payload, 'content':'different'})[0], 409)
                self.assertEqual(request('POST', {**payload, 'request_id':'new'})[1]['error'], 'source_unavailable')
                self.assertEqual(request(origin='http://evil.test')[0], 403)
                root_id = identity['root_identity']; identity['root_identity'] = '0' * 64
                self.assertNotEqual(request(endpoint='/recovery')[0], 200)
                identity['root_identity'] = root_id
                identity['lane'] = 'api'
                self.assertNotEqual(request(endpoint='/recovery')[0], 200)
                identity['lane'] = 'web'
                identity['path'] = 'missing.md'
                self.assertNotEqual(request()[0], 200)
                identity['path'] = '../report.md'
                self.assertNotEqual(request()[0], 200)
                identity['path'] = 'report.md'
                self.assertFalse(report.exists())
                outside = Path(tmp) / 'outside.md'; outside.write_text('outside secret')
                report.symlink_to(outside)
                self.assertNotEqual(request()[0], 200)
                self.assertNotEqual(request('POST', payload)[0], 200)
                self.assertEqual(outside.read_text(), 'outside secret')
                report.unlink()
                report.parent.rename(report.parent.with_name('renamed-reports'))
                self.assertEqual(request()[1]['source_status'], 'source_unavailable')
                self.assertFalse(report.exists())
            finally:
                server.shutdown(); thread.join(); server.server_close()
