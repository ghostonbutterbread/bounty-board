import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

import app


class RootIdentityTests(unittest.TestCase):
    def test_canonical_root_identity_is_stable_distinct_and_path_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            root = parent / 'private-root-name'
            other = parent / 'other-root'
            root.mkdir(); other.mkdir()
            report_dir = root / 'web_bounty' / 'fictional' / 'web' / 'reports'
            report_dir.mkdir(parents=True)
            (report_dir / 'same.md').write_text('PRIVATE SYNTHETIC SOURCE CONTENT')
            (parent / 'alias').symlink_to(root, target_is_directory=True)

            def read(path):
                server = app.make_server(path, 0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    conn.request('GET', '/api/data')
                    response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    body = response.read().decode()
                    conn.close()
                    self.assertNotIn(str(parent), body)
                    self.assertNotIn('PRIVATE SYNTHETIC SOURCE CONTENT', body)
                    return json.loads(body)['root_identity']
                finally:
                    server.shutdown(); thread.join(); server.server_close()

            first = read(root)
            self.assertRegex(first, r'^[0-9a-f]{64}$')
            self.assertEqual(first, read(parent / 'alias'))
            self.assertEqual(first, read(parent / 'other-root' / '..' / 'private-root-name'))
            self.assertNotEqual(first, read(other))
            self.assertIsNone(read(parent / 'missing'))
