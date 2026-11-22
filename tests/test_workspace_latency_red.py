"""RED contract: a summary must not read an unrelated lane's map or coverage.

Run in a disposable network-isolated container with TMPDIR on a writable tmpfs.
These tests intentionally fail on the base branch until the projection changes.
"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError

import app


class WorkspaceSummaryBarrierTests(unittest.TestCase):
    def test_inventory_does_not_read_any_lane_source(self):
        with tempfile.TemporaryDirectory(prefix='workspace-inventory-') as tmp:
            root = Path(tmp) / 'source'
            (root / 'web_bounty/alpha/web').mkdir(parents=True)
            with patch.object(app, 'ledger', side_effect=AssertionError('ledger read')), \
                 patch.object(app, 'map_entries', side_effect=AssertionError('map read')), \
                 patch.object(app, 'coverage', side_effect=AssertionError('coverage read')), \
                 patch.object(app, 'reports', side_effect=AssertionError('reports read')):
                inventory = app.discover(root, include_reports=False, inventory_only=True)
            lane = inventory['programs'][0]['lanes'][0]
            self.assertTrue(lane['unscanned'])
            self.assertEqual(lane['warnings'], [])
            self.assertIsNone(lane['findings'])

    def test_selected_lane_rejects_root_replacement_during_read(self):
        with tempfile.TemporaryDirectory(prefix='workspace-root-') as tmp:
            root = Path(tmp) / 'source'
            lane = root / 'web_bounty/alpha/web'
            (lane / 'ledgers').mkdir(parents=True)
            (lane / 'ledgers/ledger.json').write_text('{"findings": []}')
            server = app.make_server(root, port=0)
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                with urlopen(base + '/api/data?phase=summary', timeout=5) as response:
                    token = json.load(response)['root_instance']
                query = urlencode({'root_instance': token, 'family': 'web_bounty', 'program': 'alpha', 'lane': 'web'})
                original = app.coverage
                def replace_root(path, warnings):
                    value = original(path, warnings)
                    root.rename(root.with_name('old'))
                    root.mkdir()
                    return value
                with patch.object(app, 'coverage', replace_root):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(base + '/api/lane?' + query, timeout=5)
                self.assertEqual(error.exception.code, 409)
                error.exception.close()
            finally:
                server.shutdown(); server.server_close(); serving.join(5)

    def test_selected_lane_is_read_independently(self):
        with tempfile.TemporaryDirectory(prefix='workspace-lane-') as tmp:
            root = Path(tmp) / 'source'
            for name in ('selected', 'unrelated'):
                lane = root / 'web_bounty' / name / 'web'
                (lane / 'ledgers').mkdir(parents=True)
                (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': name}]}))
            server = app.make_server(root, port=0)
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                with urlopen(base + '/api/data?phase=summary', timeout=5) as response:
                    summary = json.load(response)
                query = urlencode({'root_instance': summary['root_instance'], 'family': 'web_bounty', 'program': 'selected', 'lane': 'web'})
                with patch.object(app, 'map_entries', wraps=app.map_entries) as maps:
                    with urlopen(base + '/api/lane?' + query, timeout=5) as response:
                        selected = json.load(response)
                self.assertEqual(selected['lane']['findings'][0]['fid'], 'selected')
                self.assertEqual([c.args[0].parent.name for c in maps.call_args_list], ['selected'])
                self.assertEqual(selected['root_instance'], summary['root_instance'])
            finally:
                server.shutdown(); server.server_close(); serving.join(5)

    def check_unrelated_source(self, source):
        with tempfile.TemporaryDirectory(prefix='workspace-summary-') as tmp:
            root = Path(tmp) / 'source'
            for name in ('selected', 'unrelated'):
                lane = root / 'web_bounty' / name / 'web'
                (lane / 'ledgers').mkdir(parents=True)
                (lane / 'ledgers/ledger.json').write_text(json.dumps({
                    'findings': [{'fid': name, 'title': name + ' finding'}]
                }))
            entered, release, done = threading.Event(), threading.Event(), threading.Event()
            original = getattr(app, source)
            result, errors = [], []

            def blocked(lane, warnings):
                if lane.parent.name == 'unrelated':
                    entered.set()
                    if not release.wait(10):
                        raise TimeoutError('unreleased synthetic source barrier')
                return original(lane, warnings)

            with patch.object(app, source, blocked):
                server = app.make_server(root, port=0)
                serving = threading.Thread(target=server.serve_forever)
                serving.start()

                def read_summary():
                    try:
                        request = Request(f'http://127.0.0.1:{server.server_port}/api/data',
                                          headers={'X-Bounty-Board-Phase': 'summary'})
                        with urlopen(request, timeout=12) as response:
                            result.append(json.load(response))
                    except Exception as exc:
                        errors.append(exc)
                    finally:
                        done.set()

                reader = threading.Thread(target=read_summary)
                reader.start()
                try:
                    completed_before_release = done.wait(2)
                    reached_unrelated = entered.is_set()
                finally:
                    release.set()
                    reader.join(12)
                    server.shutdown()
                    server.server_close()
                    serving.join(5)
                self.assertFalse(reader.is_alive(), 'summary request did not terminate')
                self.assertFalse(serving.is_alive(), 'HTTP server did not terminate')
                self.assertFalse(errors, f'summary request failed: {errors!r}')
                lanes = {p['name']: p['lanes'][0] for p in result[0]['programs']}
                self.assertIsNone(lanes['selected']['findings'])
                self.assertIsNone(lanes['unrelated']['findings'])
                self.assertTrue(completed_before_release,
                                f'summary blocked on unrelated {source}; barrier entered={reached_unrelated}')
                self.assertFalse(reached_unrelated, f'summary read unrelated {source}')
                self.assertIsNone(lanes['unrelated']['map'])
                self.assertIsNone(lanes['unrelated']['coverage'])
                self.assertIsNone(lanes['unrelated']['reports'])
                self.assertNotIn('map_missing', lanes['unrelated']['warnings'])
                self.assertNotIn('coverage_missing', lanes['unrelated']['warnings'])
                self.assertFalse(result[0]['capabilities']['source_authoritative'])

    def test_summary_does_not_read_unrelated_map(self):
        self.check_unrelated_source('map_entries')

    def test_summary_does_not_read_unrelated_coverage(self):
        self.check_unrelated_source('coverage')


if __name__ == '__main__':
    unittest.main(verbosity=2)
