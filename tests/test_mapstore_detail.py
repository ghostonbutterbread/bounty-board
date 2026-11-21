"""Real HTTP tests against disposable synthetic MapStore lanes."""
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlencode

import app


class MapDetailTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.maps = self.root / 'web_bounty/alpha/web/recon/maps'
        self.maps.mkdir(parents=True)
        self.path = '_app/observation/index.md'
        body = self.maps / self.path
        body.parent.mkdir(parents=True)
        body.write_text('Capability:\n- grants: observed\n', encoding='utf-8')
        self.entries = [{'path': self.path, 'title': 'Fixture', 'tags': ['gadget', 'residual'], 'status': 'archived'}]
        self.index()
        self.server = app.make_server(self.root, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.thread.join(); self.server.server_close(); self.tmp.cleanup()

    def index(self):
        (self.maps / 'map.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in self.entries), encoding='utf-8')

    def get(self, **changes):
        params = dict(family='web_bounty', program='alpha', lane='web', path=self.path)
        params.update(changes)
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request('GET', '/api/map-observation?' + urlencode(params, doseq=True))
        response = conn.getresponse(); result = (response.status, json.loads(response.read())); conn.close()
        self.assertNotIn(str(self.root), json.dumps(result))
        return result

    def test_indexed_observation_is_read_lazily(self):
        status, result = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(result['content'], 'Capability:\n- grants: observed\n')

    def test_nonfinite_map_values_are_isolated_from_strict_http_json(self):
        good_maps = self.root / 'web_bounty/beta/web/recon/maps'
        good_maps.mkdir(parents=True)
        good_entry = {'path': self.path, 'title': '安全 <img src=x onerror=alert(1)>',
                      'tags': ['gadget', {'nested': [1.25, -3, '鍵']}],
                      'surface': {'values': [0, 1e100, {'key': '✓'}]}}
        (good_maps / 'map.jsonl').write_text(json.dumps(good_entry, ensure_ascii=False) + '\n', encoding='utf-8')
        body = good_maps / self.path
        body.parent.mkdir(parents=True)
        body.write_text('beta <script>inert</script>', encoding='utf-8')

        def reject_constant(value):
            raise ValueError('non-standard JSON constant: ' + value)

        cases = ('{"title":1e999,"tags":["gadget"]}',
                 '{"title":"bad","tags":["gadget",{"nested":[NaN]}]}',
                 '{"title":-Infinity,"tags":[]}')
        for bad in cases:
            with self.subTest(bad=bad):
                (self.maps / 'map.jsonl').write_text(bad + '\n', encoding='utf-8')
                conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
                try:
                    conn.request('GET', '/api/data')
                    response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    payload = response.read()
                    self.assertNotIn(str(self.root).encode(), payload)
                    programs = {p['name']: p['lanes'][0] for p in
                                json.loads(payload, parse_constant=reject_constant)['programs']}
                finally:
                    conn.close()
                self.assertIsNone(programs['alpha']['map'])
                self.assertIsNone(programs['alpha']['gadgets'])
                self.assertIn('map_unavailable_or_invalid', programs['alpha']['warnings'])
                self.assertEqual(programs['beta']['map'][0]['title'], good_entry['title'])
                self.assertEqual(programs['beta']['map'][0]['surface'], good_entry['surface'])
                self.assertEqual(programs['beta']['gadgets'][0]['tags'], good_entry['tags'])
                self.assertNotIn('map_unavailable_or_invalid', programs['beta']['warnings'])
                self.assertEqual(self.get(program='beta'), (200, {'content': 'beta <script>inert</script>'}))

    def test_unindexed_duplicate_and_wrong_lane_are_refused(self):
        self.assertNotEqual(self.get(path='_app/other/index.md')[0], 200)
        self.assertNotEqual(self.get(lane='api')[0], 200)
        self.assertNotEqual(self.get(path=[self.path, self.path])[0], 200)
        self.entries.append(self.entries[0]); self.index()
        self.assertNotEqual(self.get()[0], 200)

    def test_traversal_symlink_missing_nonregular_and_invalid_files_are_refused(self):
        self.assertNotEqual(self.get(path='../map.jsonl')[0], 200)
        body = self.maps / self.path
        body.unlink()
        self.assertNotEqual(self.get()[0], 200)
        body.symlink_to(self.maps / 'map.jsonl')
        self.assertNotEqual(self.get()[0], 200)
        body.unlink(); body.mkdir()
        self.assertNotEqual(self.get()[0], 200)
        body.rmdir(); body.write_bytes(b'\xff')
        self.assertNotEqual(self.get()[0], 200)
        body.write_bytes(b'x' * 5_000_001)
        self.assertNotEqual(self.get()[0], 200)

    def test_malformed_or_missing_index_refused(self):
        (self.maps / 'map.jsonl').write_text('{bad')
        self.assertNotEqual(self.get()[0], 200)
        (self.maps / 'map.jsonl').write_text('[' * 2000 + ']' * 2000)
        self.assertNotEqual(self.get()[0], 200)
        (self.maps / 'map.jsonl').unlink()
        self.assertNotEqual(self.get()[0], 200)

    def test_deep_index_is_unavailable_without_disconnecting(self):
        deep = '[' * 15000 + '0' + ']' * 15000
        (self.maps / 'map.jsonl').write_text('{"path":' + json.dumps(self.path) + ',"tags":' + deep + '}\n')
        try:
            json.loads(deep)
        except RecursionError:
            parseable = False
        else:
            parseable = True
        status, detail = self.get()
        self.assertIn(status, (200, 404))
        if not parseable:
            self.assertEqual(status, 404)
        if status == 404:
            self.assertEqual(detail, {'error': 'observation_not_found_or_unavailable'})
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            conn.request('GET', '/api/data')
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            raw = response.read()
            self.assertNotIn(str(self.root), raw.decode())
            lane = json.loads(raw)['programs'][0]['lanes'][0]
            if status == 404:
                self.assertIsNone(lane['map'])
                self.assertIn('map_unavailable_or_invalid', lane['warnings'])
            else:
                self.assertEqual(lane['map'][0]['path'], self.path)
                self.assertNotIn('map_unavailable_or_invalid', lane['warnings'])
        finally:
            conn.close()

    def test_current_index_and_program_are_authoritative(self):
        other = self.root / 'web_bounty/beta/web/recon/maps'
        other.mkdir(parents=True)
        (other / 'map.jsonl').write_text(json.dumps({'path': self.path, 'tags': []}) + '\n')
        body = other / self.path
        body.parent.mkdir(parents=True)
        body.write_text('beta only')
        self.assertEqual(self.get(program='beta')[1]['content'], 'beta only')
        self.entries = []; self.index()
        self.assertNotEqual(self.get()[0], 200)
        self.assertEqual(self.get(program='beta')[1]['content'], 'beta only')

    def test_surface_and_url_scoped_paths_are_supported(self):
        for path in ('xss/_surface/example/index.md', 'xss/example_s_search/example/index.md'):
            with self.subTest(path=path):
                file = self.maps / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(path)
                self.entries.append({'path': path, 'tags': []})
                self.index()
                self.assertEqual(self.get(path=path), (200, {'content': path}))

    def test_symlinked_ancestor_and_unindexed_existing_file_refused(self):
        extra = self.maps / '_app/other/index.md'
        extra.parent.mkdir(parents=True)
        extra.write_text('not indexed')
        self.assertNotEqual(self.get(path='_app/other/index.md')[0], 200)
        linked = self.root / 'web_bounty/link'
        linked.symlink_to(self.root / 'web_bounty/alpha', target_is_directory=True)
        self.assertNotEqual(self.get(program='link')[0], 200)
        self.assertNotEqual(self.get(path='/_app/observation/index.md')[0], 200)
        self.assertNotEqual(self.get(path='_app//observation/index.md')[0], 200)


if __name__ == '__main__':
    unittest.main()
