import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

import app


class PortfolioCacheTests(unittest.TestCase):
    def test_completed_scans_get_distinct_opaque_source_tokens(self):
        import queue
        finished = queue.Queue()
        class ObservableCache(app.PortfolioCache):
            def _scan(self, generation):
                try:
                    super()._scan(generation)
                finally:
                    finished.put(True)
        with tempfile.TemporaryDirectory() as root, patch.object(app, 'discover', return_value={'programs': [], 'warnings': []}):
            cache = ObservableCache(Path(root))
            cache.get()
            finished.get(timeout=3)
            first, status = cache.get()
            self.assertEqual(status['state'], 'ready')
            self.assertIn('source_token', first)
            token = first['source_token']
            self.assertIsInstance(token, str)
            self.assertTrue(token)
            self.assertNotIn(root, token)
            cache.get(refresh=True)
            finished.get(timeout=3)
            second, status = cache.get()
            self.assertEqual(status['state'], 'ready')
            self.assertEqual(first['root_identity'], second['root_identity'])
            self.assertNotEqual(token, second['source_token'])

    def test_report_rejects_a_previous_scan_token_on_the_same_root(self):
        import queue
        finished = queue.Queue()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            reports = root / 'web_bounty/demo/web/reports'
            reports.mkdir(parents=True)
            (reports / 'report.md').write_text('synthetic')
            with patch.object(app, 'discover', return_value={'programs': [], 'warnings': []}):
                server = app.make_server(root, port=0)
                scan = server.portfolio._scan
                def observed(generation):
                    try: scan(generation)
                    finally: finished.put(True)
                server.portfolio._scan = observed
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                def request(path, headers=None):
                    conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    try:
                        conn.request('GET', path, headers=headers or {})
                        response = conn.getresponse()
                        return response.status, json.loads(response.read())
                    finally: conn.close()
                try:
                    request('/api/data'); finished.get(timeout=3)
                    old = server.portfolio.get()[0]['source_token']
                    path = '/api/report?family=web_bounty&program=demo&lane=web&path=report.md'
                    self.assertEqual(request(path, {'X-Portfolio-Source': old})[0], 200)
                    request('/api/data', {'X-Portfolio-Refresh': '1'}); finished.get(timeout=3)
                    new = server.portfolio.get()[0]['source_token']
                    self.assertEqual(request(path, {'X-Portfolio-Source': old})[0], 409)
                    self.assertEqual(request(path, {'X-Portfolio-Source': new})[0], 200)
                    self.assertEqual(request(path)[0], 409)
                finally:
                    server.shutdown(); thread.join(); server.server_close()

    def test_report_requires_ready_snapshot_and_matching_current_root(self):
        import time
        entered, release = threading.Event(), threading.Event()
        calls = []
        def discover(root):
            calls.append(root)
            if len(calls) == 2:
                entered.set()
                if not release.wait(5): raise RuntimeError('barrier timed out')
            return {'programs': [{'id': root.name}], 'warnings': []}
        def request(port, path, headers=None):
            conn = HTTPConnection('127.0.0.1', port, timeout=3)
            try:
                conn.request('GET', path, headers=headers or {})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally: conn.close()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); a = base / 'a'; b = base / 'b'
            for root in (a, b):
                reports = root / 'web_bounty/demo/web/reports'; reports.mkdir(parents=True)
                (reports / 'report.md').write_text(root.name)
            link = base / 'root'; link.symlink_to(a, target_is_directory=True)
            with patch.object(app, 'discover', discover):
                server = app.make_server(link, port=0)
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                path = '/api/report?family=web_bounty&program=demo&lane=web&path=report.md'
                try:
                    request(server.server_port, '/api/data')
                    deadline = time.monotonic() + 3
                    while server.portfolio.get()[1]['state'] != 'ready' and time.monotonic() < deadline: time.sleep(.005)
                    data, _ = server.portfolio.get(); old = data['source_token']
                    self.assertEqual(request(server.server_port, path, {'X-Portfolio-Source': old})[1]['content'], 'a')
                    link.unlink(); link.symlink_to(b, target_is_directory=True)
                    self.assertEqual(request(server.server_port, path, {'X-Portfolio-Source': old})[0], 409)
                    request(server.server_port, '/api/data', {'X-Portfolio-Refresh': '1'})
                    self.assertTrue(entered.wait(2))
                    status, retained = request(server.server_port, '/api/data')
                    self.assertEqual((status, retained['portfolio']['state'], retained['programs'][0]['id']), (200, 'refreshing', 'a'))
                    self.assertEqual(request(server.server_port, path, {'X-Portfolio-Source': old})[0], 409)
                    release.set(); deadline = time.monotonic() + 3
                    while server.portfolio.get()[1]['state'] != 'ready' and time.monotonic() < deadline: time.sleep(.005)
                    new = server.portfolio.get()[0]['source_token']
                    self.assertNotEqual(old, new)
                    self.assertEqual(request(server.server_port, path, {'X-Portfolio-Source': old})[0], 409)
                    self.assertEqual(request(server.server_port, path, {'X-Portfolio-Source': new})[1]['content'], 'b')
                finally:
                    release.set(); server.shutdown(); thread.join(); server.server_close()

    def test_symlink_switch_during_scan_never_publishes_wrong_root(self):
        import time
        entered, release = threading.Event(), threading.Event()
        seen = []
        def discover(root):
            seen.append(root)
            entered.set()
            self.assertTrue(release.wait(5))
            return {'programs': [{'id': (root / 'marker').read_text()}], 'warnings': []}
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); a = base / 'a'; b = base / 'b'
            a.mkdir(); b.mkdir(); (a / 'marker').write_text('A'); (b / 'marker').write_text('B')
            link = base / 'root'; link.symlink_to(a, target_is_directory=True)
            with patch.object(app, 'discover', discover):
                cache = app.PortfolioCache(link)
                try:
                    cache.get(); self.assertTrue(entered.wait(2))
                    link.unlink(); link.symlink_to(b, target_is_directory=True)
                    release.set()
                    deadline = time.monotonic() + 3
                    while cache.get()[1]['state'] in ('loading', 'refreshing') and time.monotonic() < deadline: time.sleep(.005)
                    data, status = cache.get()
                    self.assertEqual(seen[0], a.resolve())
                    self.assertNotIn('programs', data)
                    self.assertEqual(status['state'], 'error')
                finally:
                    release.set()

    def test_root_vanishing_during_scan_retains_prior_snapshot_as_error(self):
        import time
        entered, release = threading.Event(), threading.Event()
        calls = []
        def discover(root):
            calls.append(1)
            if len(calls) == 2:
                entered.set()
                self.assertTrue(release.wait(5))
            return {'programs': [{'id': str(len(calls))}], 'warnings': []}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            with patch.object(app, 'discover', discover):
                cache = app.PortfolioCache(root)
                cache.get(); deadline = time.monotonic() + 3
                while cache.get()[1]['state'] == 'loading' and time.monotonic() < deadline: time.sleep(.005)
                self.assertEqual(cache.get()[0]['programs'], [{'id': '1'}])
                try:
                    cache.get(refresh=True); self.assertTrue(entered.wait(2))
                    root.rmdir(); release.set()
                    deadline = time.monotonic() + 3
                    while cache.get()[1]['state'] == 'refreshing' and time.monotonic() < deadline: time.sleep(.005)
                    data, status = cache.get()
                    self.assertEqual(status['state'], 'error')
                    self.assertEqual(data['programs'], [{'id': '1'}])
                finally:
                    release.set()

    def test_failed_scan_is_retryable_without_fabricating_data(self):
        import time
        calls = []
        def discover(root):
            calls.append(1)
            if len(calls) == 1: raise OSError('synthetic failure')
            return {'programs': [{'id':'recovered'}], 'warnings': []}
        with tempfile.TemporaryDirectory() as root, patch.object(app, 'discover', discover):
            cache = app.PortfolioCache(Path(root))
            with self.assertLogs(level='ERROR'):
                cache.get()
                deadline = time.monotonic() + 3
                while cache.get()[1]['state'] == 'loading' and time.monotonic() < deadline: time.sleep(.005)
            data, status = cache.get()
            self.assertNotIn('programs', data)
            self.assertEqual(status['state'], 'error')
            cache.get(refresh=True)
            while cache.get()[1]['state'] == 'loading' and time.monotonic() < deadline: time.sleep(.005)
            data, status = cache.get()
            self.assertEqual(status['state'], 'ready')
            self.assertEqual(data['programs'], [{'id':'recovered'}])

    def test_invalidation_during_scan_discards_old_result_without_overlap(self):
        import time
        entered = [threading.Event(), threading.Event()]
        release = [threading.Event(), threading.Event()]
        calls = []
        def discover(root):
            index = len(calls); calls.append(index); entered[index].set()
            if not release[index].wait(5): raise RuntimeError('test barrier timed out')
            return {'programs': [{'id': str(index)}], 'warnings': []}
        with tempfile.TemporaryDirectory() as root, patch.object(app, 'discover', discover):
            cache = app.PortfolioCache(Path(root))
            try:
                cache.get(); self.assertTrue(entered[0].wait(2))
                cache.invalidate(); cache.invalidate()
                self.assertFalse(entered[1].is_set())
                release[0].set(); self.assertTrue(entered[1].wait(2))
                data, status = cache.get()
                self.assertNotIn('programs', data)
                self.assertEqual(status['state'], 'loading')
                self.assertEqual(len(calls), 2)
                release[1].set()
                deadline = time.monotonic() + 3
                while cache.get()[1]['state'] == 'loading' and time.monotonic() < deadline: time.sleep(.005)
                data, status = cache.get()
                self.assertEqual(status['state'], 'ready')
                self.assertEqual(data['programs'], [{'id':'1'}])
            finally:
                for event in release: event.set()

    def test_incomplete_refresh_keeps_previous_snapshot_and_reports_stale(self):
        import time
        calls = []
        def discover(root):
            calls.append(1)
            return {'programs': [{'id': 'old'}] if len(calls) == 1 else [],
                    'warnings': [] if len(calls) == 1 else ['discovery_incomplete']}
        with tempfile.TemporaryDirectory() as root, patch.object(app, 'discover', discover):
            cache = app.PortfolioCache(Path(root))
            cache.get()
            deadline = time.monotonic() + 3
            while cache.get()[1]['state'] == 'loading' and time.monotonic() < deadline: time.sleep(.005)
            self.assertEqual(cache.get()[0]['programs'], [{'id':'old'}])
            cache.get(refresh=True)
            while cache.get()[1]['state'] == 'refreshing' and time.monotonic() < deadline: time.sleep(.005)
            data, status = cache.get()
            self.assertEqual(data['programs'], [{'id':'old'}])
            self.assertEqual(status['state'], 'error')
            self.assertIn('incomplete', status['error'].lower())

    def test_concurrent_clients_share_one_scan(self):
        started, release = threading.Event(), threading.Event()
        calls = []
        def discover(root):
            calls.append(1); started.set()
            self.assertTrue(release.wait(5))
            return {'programs': [], 'warnings': []}
        with tempfile.TemporaryDirectory() as root, patch.object(app, 'discover', discover):
            server = app.make_server(Path(root), port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                from concurrent.futures import ThreadPoolExecutor
                def request(_):
                    conn = HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                    try:
                        conn.request('GET', '/api/data', headers={'X-Portfolio-Refresh': '1'})
                        response = conn.getresponse(); response.read()
                        return response.status
                    finally:
                        conn.close()
                with ThreadPoolExecutor(max_workers=12) as pool:
                    statuses = list(pool.map(request, range(12)))
                self.assertEqual(statuses, [202] * 12)
                self.assertTrue(started.wait(2))
                self.assertEqual(len(calls), 1)
            finally:
                release.set(); server.shutdown(); thread.join(); server.server_close()

    def test_initial_request_returns_loading_while_scan_is_blocked(self):
        started, release = threading.Event(), threading.Event()
        def discover(root):
            started.set()
            self.assertTrue(release.wait(5))
            return {'programs': [], 'warnings': []}
        with tempfile.TemporaryDirectory() as root, patch.object(app, 'discover', discover):
            server = app.make_server(Path(root), port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                conn.request('GET', '/api/data')
                response = conn.getresponse()
                body = json.loads(response.read())
                self.assertEqual(response.status, 202)
                self.assertEqual(body['portfolio']['state'], 'loading')
                self.assertNotIn('programs', body)
                self.assertTrue(started.wait(2))
                conn.close()
            finally:
                release.set()
                server.shutdown(); thread.join(); server.server_close()
