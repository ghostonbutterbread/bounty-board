"""Synthetic loopback HTTP checks for the optional read-only projection."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

import app
from tests.fixture_preferences import make_server as make_test_server


class ProgressiveAPI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='board-progressive-')
        self.root = Path(self.tmp.name) / 'source'
        self.lane = self.root / 'web_bounty/alpha/web'
        (self.lane / 'ledgers').mkdir(parents=True)
        (self.lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'A'}]}))
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=5)
            self.assertFalse(self.thread.is_alive())
        self.tmp.cleanup()

    def start(self, **kwargs):
        self.server = make_test_server(self.root, port=0, **kwargs)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def get(self, query=''):
        with urlopen(f'http://127.0.0.1:{self.server.server_port}/api/data{query}', timeout=5) as response:
            return json.load(response)

    def test_summary_missing_reports_then_complete_reports_unavailable(self):
        self.start()
        summary = self.get('?phase=summary')
        lane = summary['programs'][0]['lanes'][0]
        self.assertIsNone(lane['findings'])
        self.assertTrue(lane['unscanned'])
        with urlopen(f'http://127.0.0.1:{self.server.server_port}/api/lane?root_instance={summary["root_instance"]}&family=web_bounty&program=alpha&lane=web', timeout=5) as response:
            self.assertEqual(json.load(response)['lane']['findings'][0]['fid'], 'A')
        self.assertIsNone(lane['reports'])
        self.assertNotIn('reports_missing', lane['warnings'])
        self.assertFalse(summary['capabilities']['source_authoritative'])
        self.assertFalse(summary['capabilities']['finding_metadata'])
        full = self.get('?phase=complete&root_instance=' + summary['root_instance'])
        lane = full['programs'][0]['lanes'][0]
        self.assertIsNone(lane['reports'])
        self.assertIn('reports_missing', lane['warnings'])
        self.assertFalse(full['reports_loading'])
        self.assertIsNone(self.get()['programs'][0]['lanes'][0]['reports'])

    def test_existing_empty_report_directory_is_complete_zero(self):
        (self.lane / 'reports').mkdir()
        self.start()
        summary = self.get('?phase=summary')
        full = self.get('?phase=complete&root_instance=' + summary['root_instance'])
        self.assertEqual(full['programs'][0]['lanes'][0]['reports'], [])
        self.assertNotIn('reports_missing', full['programs'][0]['lanes'][0]['warnings'])

    def test_root_replacement_invalidates_instance(self):
        self.start()
        summary = self.get('?phase=summary')
        self.root.rename(self.root.with_name('old'))
        self.root.mkdir()
        with self.assertRaises(HTTPError) as error:
            self.get('?phase=complete&root_instance=' + summary['root_instance'])
        self.assertEqual(error.exception.code, 409)
        self.assertNotEqual(self.get('?phase=identity')['root_instance'], summary['root_instance'])

    def test_writer_mode_ignores_summary_and_remains_full(self):
        (self.lane / 'reports').mkdir()
        (self.lane / 'reports/test.md').write_text('# Test')
        with patch.object(app, 'writer_available', return_value=True):
            self.start(writer=Path(self.tmp.name) / 'fake-writer', accept_uncoordinated_writes=True)
        result = self.get('?phase=summary')
        self.assertNotIn('reports_loading', result)
        self.assertTrue(result['capabilities']['finding_metadata'])
        self.assertEqual(len(result['programs'][0]['lanes'][0]['reports']), 1)
        self.assertEqual(result, self.get())

    def test_collaboration_autosave_summary_and_selected_reports(self):
        (self.lane / 'reports').mkdir()
        (self.lane / 'reports/test.md').write_text('# Test')
        (self.lane / 'reports/nav.md').write_text('<!-- generated: bounty-core-report-navigation -->\n# Index')
        self.start(collaboration_dir=Path(self.tmp.name) / 'collaboration', report_autosave=True)
        summary = self.get('?phase=summary')
        self.assertTrue(summary['reports_loading'])
        self.assertFalse(summary['capabilities']['source_authoritative'])
        self.assertTrue(summary['capabilities']['collaboration'])
        self.assertTrue(summary['capabilities']['report_autosave'])
        base = f'http://127.0.0.1:{self.server.server_port}'
        query = f'root_instance={summary["root_instance"]}&family=web_bounty&program=alpha&lane=web'
        with urlopen(base + '/api/lane?' + query, timeout=5) as response:
            selected = json.load(response)
            self.assertEqual(selected['lane']['findings'][0]['fid'], 'A')
            self.assertTrue(selected['source_authoritative'])
        with urlopen(base + '/api/lane-reports?' + query, timeout=5) as response:
            selected_reports = json.load(response)
            self.assertTrue(selected_reports['source_authoritative'])
            indexed = {r['path']: r for r in selected_reports['reports']}
        self.assertTrue(indexed['test.md']['editable'])
        self.assertFalse(indexed['nav.md']['editable'])
        self.assertFalse(indexed['nav.md']['collaboration_editable'])
        with urlopen(base + '/api/report?' + query + '&path=test.md', timeout=5) as response:
            body = json.load(response)
        self.assertTrue(body['source_authoritative'])
        self.assertTrue(body['editable'])
        self.assertEqual(body['root_instance'], summary['root_instance'])
        full = self.get('?phase=complete&root_instance=' + summary['root_instance'])
        self.assertTrue(full['capabilities']['source_authoritative'])
        indexed = {r['path']: r for r in full['programs'][0]['lanes'][0]['reports']}
        self.assertTrue(indexed['test.md']['editable'])
        self.assertFalse(indexed['nav.md']['editable'])
        self.assertNotIn('reports_loading', self.get())

    def test_missing_root_uses_existing_unavailable_response(self):
        self.root.rename(self.root.with_name('old'))
        self.start()
        self.assertEqual(self.get('?phase=summary'), self.get())
        self.assertIn('root_unavailable', self.get()['warnings'])


if __name__ == '__main__':
    unittest.main()
