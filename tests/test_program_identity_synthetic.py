"""Synthetic program identity compatibility and traversal boundaries."""
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode

import app


class ProgramIdentityTests(unittest.TestCase):
    def test_discovery_names_exact_binding_and_hostile_components(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            names = ['Acme Corp', 'Acme\u2003Café', '名 前', ' a ', 'x\\y']
            for name in names:
                report = root / 'web_bounty' / name / 'web/reports/report.md'
                report.parent.mkdir(parents=True)
                report.write_text('source for ' + name)
            outside = Path(tmp) / 'outside'
            (outside / 'web/reports').mkdir(parents=True)
            (outside / 'web/reports/report.md').write_text('outside secret')
            (root / 'web_bounty' / 'link').symlink_to(outside, target_is_directory=True)
            root_id = hashlib.sha256(str(root.resolve()).encode()).hexdigest()
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private')
            thread = threading.Thread(target=server.serve_forever); thread.start()
            def get(program, view=''):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    query = urlencode(dict(family='web_bounty', program=program, lane='web', path='report.md', root_identity=root_id))
                    conn.request('GET', '/api/collaboration'+view+'?'+query)
                    response = conn.getresponse(); return response.status, json.loads(response.read())
                finally: conn.close()
            try:
                discovered = {p['name'] for p in app.discover(root)['programs']}
                self.assertTrue(set(names) <= discovered)
                self.assertNotIn('link', discovered)
                for name in names:
                    status, state = get(name)
                    self.assertEqual(status, 200, (name, state))
                    self.assertEqual(state['content'], 'source for ' + name)
                for name in ['', '.', '..', '../Acme Corp', 'Acme Corp/..', '_private', 'link', 'Acme Corp\0x']:
                    self.assertNotEqual(get(name)[0], 200, name)
                # A previously observed identity must not become a symlink-based read.
                parent = root / 'web_bounty' / names[0]
                parent.rename(parent.with_name('moved'))
                parent.symlink_to(outside, target_is_directory=True)
                self.assertNotEqual(get(names[0], '/recovery')[0], 200)
                self.assertEqual((outside / 'web/reports/report.md').read_text(), 'outside secret')
            finally:
                server.shutdown(); thread.join(); server.server_close()
