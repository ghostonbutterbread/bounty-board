import json
import os
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

import app


class UserPreferencesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root = base / 'root'
        self.root.mkdir()
        self.config = base / 'config' / 'bountyboard' / 'user.conf'
        self.server = app.make_server(self.root, 0, user_config=self.config)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method, payload=None, override=None):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        headers = {'Origin': f'http://127.0.0.1:{self.server.server_port}',
                   'X-Requested-With': 'Bounty-Board', 'Content-Type': 'application/json'}
        headers.update(override or {})
        conn.request(method, '/api/user-preferences', json.dumps(payload) if payload is not None else None, headers)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def test_absent_then_persist(self):
        self.assertEqual(self.request('GET'), (200, {'preferences': {}}))
        self.assertFalse(self.config.exists())
        self.assertEqual(self.request('POST', {'set': {'bounty-board-theme': 'dark'}})[0], 200)
        self.assertEqual(self.request('GET')[1]['preferences']['bounty-board-theme'], 'dark')
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)

    def test_migration_fills_missing_only(self):
        self.request('POST', {'set': {'bounty-board-theme': 'dark'}})
        status, body = self.request('POST', {'migrate': {'bounty-board-theme': 'light', 'terminal.dock': 'left'}})
        self.assertEqual(status, 200)
        self.assertEqual(body['preferences'], {'bounty-board-theme': 'dark', 'terminal.dock': 'left'})

    def test_concurrent_distinct_keys_are_preserved(self):
        barrier = threading.Barrier(3)
        results = []
        def write(values):
            barrier.wait()
            results.append(self.request('POST', {'set': values})[0])
        a = threading.Thread(target=write, args=({'bounty-board-theme': 'dusk'},))
        b = threading.Thread(target=write, args=({'terminal.dock': 'right'},))
        a.start(); b.start(); barrier.wait(); a.join(); b.join()
        self.assertEqual(sorted(results), [200, 200])
        self.assertEqual(self.request('GET')[1]['preferences'], {'bounty-board-theme': 'dusk', 'terminal.dock': 'right'})

    def test_corrupt_file_is_not_overwritten(self):
        self.config.parent.mkdir(parents=True)
        self.config.write_text('{broken')
        self.assertEqual(self.request('GET')[0], 503)
        self.assertNotEqual(self.request('POST', {'set': {'bounty-board-theme': 'dark'}})[0], 200)
        self.assertEqual(self.config.read_text(), '{broken')

    @unittest.skipIf(os.geteuid() == 0, 'root can read mode-000 files')
    def test_unreadable_file_is_not_overwritten(self):
        self.config.parent.mkdir(parents=True)
        self.config.write_text('{"bounty-board-theme":"dark"}')
        self.config.chmod(0)
        try:
            self.assertEqual(self.request('GET')[0], 503)
            self.assertNotEqual(self.request('POST', {'set': {'bounty-board-theme': 'light'}})[0], 200)
        finally:
            self.config.chmod(0o600)
        self.assertEqual(self.config.read_text(), '{"bounty-board-theme":"dark"}')

    def test_rejects_cross_site_and_non_preference_keys(self):
        self.assertEqual(self.request('POST', {'set': {'bounty-board-theme': 'dark'}}, {'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('POST', {'set': {'bounty-board-theme': 'dark'}}, {'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.request('POST', {'set': {'draft': 'secret'}})[0], 400)
        self.assertEqual(self.request('POST', {'set': {'bounty-board-last-program': '{"content":"report text"}'}})[0], 400)
        self.assertEqual(self.request('POST', {'set': {'bounty-board-theme': 'dark'}}, {'Content-Length': str(2 * 1024 * 1024 + 1)})[0], 400)
        self.assertFalse(self.config.exists())

    def test_symlink_directory_is_not_followed(self):
        outside = Path(self.temp.name) / 'elsewhere'
        outside.mkdir()
        self.config.parent.parent.mkdir()
        self.config.parent.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.request('GET')[0], 503)
        self.assertNotEqual(self.request('POST', {'set': {'bounty-board-theme': 'dark'}})[0], 200)
        self.assertFalse((outside / 'user.conf').exists())

    def test_symlink_file_is_not_read_or_replaced(self):
        outside = Path(self.temp.name) / 'outside'
        outside.write_text('sentinel')
        self.config.parent.mkdir(parents=True)
        self.config.symlink_to(outside)
        self.assertEqual(self.request('GET')[0], 503)
        self.assertNotEqual(self.request('POST', {'set': {'bounty-board-theme': 'dark'}})[0], 200)
        self.assertTrue(self.config.is_symlink())
        self.assertEqual(outside.read_text(), 'sentinel')

    def test_config_inside_data_root_is_refused(self):
        with self.assertRaises(ValueError):
            app.make_server(self.root, 0, user_config=self.root / 'preferences' / 'user.conf')


if __name__ == '__main__':
    unittest.main()
