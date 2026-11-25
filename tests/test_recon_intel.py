"""Synthetic tests for recon_intel.py and GET /api/recon/* (disposable roots only)."""
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode

import app
import recon_intel as ri
from tests.recon_intel_fixture import make_js_library, make_lane, make_large_url_index, make_url_index


def service(root, artifact_root=None, **kw):
    snap = lambda: Path(root)
    svc = ri.ReconIntel(snap, lambda r: app.discover(r, inventory_only=True), app.read_file, app.ledger, app.coverage,
                        app.map_entries, artifact_root=artifact_root, **kw)
    return svc


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recon-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'root'
        self.root.mkdir()


class UrlIndexTests(Base):
    def test_small_index_is_exact(self):
        path = make_url_index(self.base / 'u.sqlite')
        r = ri.url_index_summary(path)
        self.assertEqual(r['urls'], {'value': 98, 'approximate': False})
        self.assertEqual(r['hosts']['value'], 3)
        self.assertFalse(r['hosts']['approximate'])
        self.assertEqual(r['test_runs']['value'], 4)
        self.assertEqual(r['tested_urls']['value'], 4)
        self.assertEqual(r['tested_params']['value'], 3)
        self.assertEqual(r['tests_recent'], {'last_24h': 1, 'last_7d': 2, 'all': 4})
        self.assertFalse(r['approximate'])
        d = r['detail']
        hosts = {h['host']: h for h in d['hosts']}
        self.assertEqual(hosts['app.example.test']['urls'], 60)
        self.assertEqual(hosts['app.example.test']['test_runs'], 4)
        self.assertEqual(hosts['static.example.test']['test_runs'], 0)
        self.assertEqual(r['routes']['value'], 7 + 8)
        # Newest test first; long notes are truncated.
        self.assertEqual(d['recent_tests'][0]['lane'], 'xss')
        self.assertLessEqual(max(len(t['notes'] or '') for t in d['recent_tests']), ri.TEXT_LIMIT)
        matrix = {(g['lane'], g['test_family']): g for g in d['coverage_matrix']}
        self.assertEqual(matrix[('open-redirect', 'redirect-basic')]['runs'], 1)
        # Hunt next: hinted params lacking a test in that lane (xss on q and idor on id were tested).
        untested = {p['param_key']: p['untested_lanes'] for p in d['untested_params']}
        self.assertEqual(untested, {'url': ['ssrf'], 'next': ['open-redirect'], 'file': ['lfi']})
        self.assertTrue(all(p['example_url'].startswith('https://') for p in d['untested_params']))

    def test_large_index_uses_estimates_within_budget(self):
        path = make_large_url_index(self.base / 'big.sqlite', rows=300_000, hosts=40)
        started = time.monotonic()
        r = ri.url_index_summary(path, budget=0.5, exact_limit=50_000)
        elapsed = time.monotonic() - started
        self.assertEqual(r['urls'], {'value': 300_000, 'approximate': True, 'method': 'max_id'})
        self.assertTrue(r['approximate'])
        self.assertEqual(r['routes']['method'], 'sample_scaled')
        self.assertEqual(r['hosts']['value'], 40)  # skip-scan over the host index is exact
        self.assertEqual(r['host_counts'], 'sample')
        self.assertGreater(r['sample']['rows'], 0)
        total = sum(h['urls'] or 0 for h in r['detail']['hosts'])
        self.assertAlmostEqual(total / 300_000, 1, delta=0.2)
        # Bounded: a handful of query budgets, never a full scan per statement.
        self.assertLess(elapsed, 0.5 * (ri.SAMPLE_BUDGET_FACTOR * 3 + 8))
        self.assertEqual(r['detail']['untested_params'][0]['param_key'], 'url')
        self.assertTrue(r['detail']['untested_params'][0]['observations_capped'])

    def test_query_budget_interrupts_long_statements(self):
        path = make_url_index(self.base / 'u.sqlite')
        db = ri.ReadOnlyDB(path, budget=0.2)
        try:
            started = time.monotonic()
            with self.assertRaises(ri.QueryTimeout):
                db.query('WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s) SELECT COUNT(*) FROM s')
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(db.one('SELECT COUNT(*) FROM urls'), 98)  # the connection stays usable
            with self.assertRaises(ri.SourceError):
                db.query("INSERT INTO imports (source_file, imported_at) VALUES ('x', 'y')")
        finally:
            db.close()

    def test_locked_database_reports_locked(self):
        path = make_url_index(self.base / 'u.sqlite')
        writer = sqlite3.connect(path, timeout=0)
        writer.execute('BEGIN EXCLUSIVE')
        try:
            with self.assertRaises(ri.SourceError) as caught:
                ri.url_index_summary(path, budget=0.5)
            self.assertEqual(caught.exception.code, 'locked')
        finally:
            writer.rollback()
            writer.close()

    def test_wal_reader_sees_committed_rows(self):
        path = make_url_index(self.base / 'u.sqlite')
        writer = sqlite3.connect(path)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, first_seen, last_seen) "
                       "VALUES ('https://new.example.test/', 'hn', 'r', 'p', 'new.example.test', '/', '[]', 'a', 'b')")
        writer.commit()
        try:
            r = ri.url_index_summary(path, detail=False)
            self.assertEqual(r['urls']['value'], 99)
            self.assertEqual(r['hosts']['value'], 4)
        finally:
            writer.close()

    def test_schema_drift(self):
        path = self.base / 'drift.sqlite'
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE urls (id INTEGER PRIMARY KEY, canonical_url TEXT, host TEXT)')
        db.execute('CREATE TABLE test_runs (id INTEGER PRIMARY KEY, url_id INTEGER, lane TEXT)')
        db.commit()
        db.close()
        with self.assertRaises(ri.SourceError) as caught:
            ri.url_index_summary(path)
        self.assertEqual(caught.exception.code, 'schema_mismatch')
        # Optional tables missing (no observations/parameter_observations): still summarised.
        path2 = make_url_index(self.base / 'u2.sqlite')
        db = sqlite3.connect(path2)
        db.execute('DROP TABLE observations')
        db.execute('DROP TABLE parameter_observations')
        db.commit()
        db.close()
        r = ri.url_index_summary(path2)
        self.assertEqual(r['urls']['value'], 98)
        self.assertIn('parameters', r['errors'])
        self.assertEqual(r['detail']['untested_params'], [])

    def test_not_a_database(self):
        path = self.base / 'junk.sqlite'
        path.write_bytes(b'not sqlite at all' * 100)
        with self.assertRaises(ri.SourceError) as caught:
            ri.url_index_summary(path)
        self.assertEqual(caught.exception.code, 'invalid')


class JsTests(Base):
    def test_library_summary(self):
        path = make_js_library(self.base / 'js_info.sqlite')
        r = ri.js_library_summary(path)
        self.assertEqual(r['files']['value'], 15)
        self.assertEqual(r['bytes']['value'], sum(1000 * n for n in range(1, 16)))
        self.assertEqual(r['source_maps']['value'], 4)
        self.assertEqual(r['observations']['value'], 4)
        self.assertEqual(r['open_observations']['value'], 2)
        self.assertEqual(r['leads']['value'], 1)
        d = r['detail']
        self.assertEqual(d['hosts'][0]['host'], 'static.example.test')
        self.assertEqual({o['observation_id'] for o in d['open_observations']}, {'o1', 'o3'})
        signals = {s['signal']: s['count'] for s in d['signals']}
        self.assertEqual(signals['sinks'], 15)
        self.assertTrue(all(f['js_url'] for f in d['source_map_files']))

    def test_js_schema_drift(self):
        path = self.base / 'js_info.sqlite'
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE js_files (sha256 TEXT PRIMARY KEY, byte_count INTEGER)')
        db.commit()
        db.close()
        with self.assertRaises(ri.SourceError) as caught:
            ri.js_library_summary(path)
        self.assertEqual(caught.exception.code, 'schema_mismatch')


class FileTests(Base):
    def test_line_counts_exact_and_capped(self):
        lane = make_lane(self.root)
        out = ri.aggregates_summary(lane)
        self.assertEqual(out['files']['urls.txt'], {'value': 120, 'approximate': False})
        self.assertEqual(out['files']['hosts.txt']['value'], 3)
        self.assertNotIn('alive.txt', out['files'])
        lines, exact = ri.count_lines(lane / 'recon/aggregated/urls.txt', cap=1000)
        self.assertFalse(exact)
        self.assertAlmostEqual(lines, 120, delta=10)

    def test_symlinked_aggregate_refused(self):
        lane = make_lane(self.root)
        outside = self.base / 'outside.txt'
        outside.write_text('a\nb\n')
        os.symlink(outside, lane / 'recon/aggregated/alive.txt')
        out = ri.aggregates_summary(lane)
        self.assertEqual(out['files']['alive.txt'], {'error': 'unavailable'})


class ServiceTests(Base):
    def test_background_compute_cache_and_invalidation(self):
        lane = make_lane(self.root, js_shared=True)
        svc = service(self.root, refresh_interval=0)
        self.addCleanup(svc.close)
        first = svc.program('web_bounty', 'acme-demo', 'web')
        self.assertTrue(first['partial'])
        self.assertTrue(svc.wait_idle(30))
        started = time.monotonic()
        second = svc.program('web_bounty', 'acme-demo', 'web')
        cached = time.monotonic() - started
        self.assertFalse(second['partial'])
        self.assertLess(cached, 0.5)
        url = second['sources']['url_index']
        self.assertEqual(url['state'], 'ready')
        self.assertEqual(second['sources']['js']['origin'], 'shared')
        self.assertEqual(second['headline']['findings'], 2)
        self.assertEqual(second['headline']['js_files']['value'], 15)
        hosts = {h['host']: h for h in second['hosts']['rows']}
        self.assertTrue(hosts['static.example.test']['under_tested'])  # 12 JS files, no tests
        self.assertFalse(hosts['app.example.test']['under_tested'])
        self.assertEqual(hosts['app.example.test']['findings'], 1)  # archived finding excluded
        self.assertEqual(hosts['api.example.test']['findings'], 1)
        computed = url['computed_at']
        # Same signature: no recompute.
        svc.program('web_bounty', 'acme-demo', 'web')
        self.assertTrue(svc.wait_idle(10))
        self.assertEqual(svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']['computed_at'], computed)
        # A write changes the signature: served stale, then recomputed.
        db = sqlite3.connect(lane / 'recon/url_index/url_index.sqlite')
        db.execute("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, first_seen, last_seen) "
                   "VALUES ('https://n.example.test/', 'hn', 'r', 'p', 'n.example.test', '/', '[]', 'a', 'b')")
        db.commit()
        db.close()
        stale = svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']
        self.assertTrue(stale['stale'])
        self.assertTrue(svc.wait_idle(30))
        fresh = svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']
        self.assertGreater(fresh['computed_at'], computed)
        self.assertEqual(fresh['result']['urls']['value'], 99)

    def test_refresh_interval_limits_recompute(self):
        lane = make_lane(self.root)
        svc = service(self.root, refresh_interval=3600)
        self.addCleanup(svc.close)
        svc.program('web_bounty', 'acme-demo', 'web')
        self.assertTrue(svc.wait_idle(30))
        before = svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']['computed_at']
        os.utime(lane / 'recon/url_index/url_index.sqlite', None)
        out = svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']
        self.assertTrue(out['stale'])
        self.assertTrue(svc.wait_idle(5))
        self.assertEqual(svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']['computed_at'], before)
        # An explicit refresh overrides the interval.
        svc.program('web_bounty', 'acme-demo', 'web', refresh=True)
        self.assertTrue(svc.wait_idle(30))
        self.assertGreater(svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']['computed_at'], before)

    def test_large_index_through_service_is_partial_then_cached(self):
        lane = make_lane(self.root, url_index=False)
        make_large_url_index(lane / 'recon/url_index/url_index.sqlite', rows=250_000)
        svc = service(self.root, query_budget=0.5, exact_limit=50_000)
        self.addCleanup(svc.close)
        overview = svc.overview()
        self.assertTrue(overview['partial'])
        self.assertEqual(overview['programs'][0]['states']['url_index']['state'], 'computing')
        self.assertTrue(svc.wait_idle(60))
        row = svc.overview()['programs'][0]
        self.assertEqual(row['urls'], {'value': 250_000, 'approximate': True, 'method': 'max_id'})
        self.assertTrue(row['approximate'])
        started = time.monotonic()
        svc.overview()
        self.assertLess(time.monotonic() - started, 0.5)

    def test_missing_artifact_root(self):
        make_lane(self.root)
        svc = service(self.root, artifact_root=self.base / 'no-such-mount')
        self.addCleanup(svc.close)
        out = svc.program('web_bounty', 'acme-demo', 'web')
        self.assertFalse(out['artifact_root']['available'])
        js = out['sources']['js']
        self.assertEqual(js['state'], 'missing')
        self.assertEqual([e['origin'] for e in js['expected']], ['artifact', 'shared'])
        self.assertTrue(js['expected'][0]['path'].endswith('acme-demo/web/recon/js/_library/js_info.sqlite'))
        none = service(self.root)
        self.addCleanup(none.close)
        self.assertFalse(none.artifact_state()['configured'])

    def test_artifact_library_preferred_and_symlinks_checked(self):
        make_lane(self.root, js_shared=True)
        artifacts = self.base / 'artifacts'
        make_js_library(artifacts / 'acme-demo/web/recon/js/_library/js_info.sqlite', hosts={'cdn.example.test': 2})
        svc = service(self.root, artifact_root=artifacts)
        self.addCleanup(svc.close)
        svc.program('web_bounty', 'acme-demo', 'web')
        self.assertTrue(svc.wait_idle(30))
        out = svc.program('web_bounty', 'acme-demo', 'web')
        self.assertEqual(out['sources']['js']['origin'], 'artifact')
        self.assertEqual(out['headline']['js_files']['value'], 2)
        # A program directory symlinked outside the artifact root is refused.
        outside = self.base / 'elsewhere'
        make_js_library(outside / 'web/recon/js/_library/js_info.sqlite')
        os.rename(artifacts / 'acme-demo', artifacts / 'moved')
        os.symlink(outside, artifacts / 'acme-demo')
        svc2 = service(self.root, artifact_root=artifacts)
        self.addCleanup(svc2.close)
        js = svc2.program('web_bounty', 'acme-demo', 'web')['sources']['js']
        self.assertEqual(js['error'], {'code': 'unavailable', 'detail': 'symlink_outside_root'})
        # Inside the root it is followed.
        os.unlink(artifacts / 'acme-demo')
        os.symlink(artifacts / 'moved', artifacts / 'acme-demo')
        svc3 = service(self.root, artifact_root=artifacts)
        self.addCleanup(svc3.close)
        svc3.program('web_bounty', 'acme-demo', 'web')
        self.assertTrue(svc3.wait_idle(30))
        self.assertEqual(svc3.program('web_bounty', 'acme-demo', 'web')['sources']['js']['origin'], 'artifact')

    def test_symlinked_url_index_refused(self):
        lane = make_lane(self.root, url_index=False)
        real = make_url_index(self.base / 'real.sqlite')
        (lane / 'recon/url_index').mkdir(parents=True)
        os.symlink(real, lane / 'recon/url_index/url_index.sqlite')
        svc = service(self.root)
        self.addCleanup(svc.close)
        out = svc.program('web_bounty', 'acme-demo', 'web')
        self.assertEqual(out['sources']['url_index']['error']['code'], 'unavailable')

    def test_unknown_program_and_binaries_lanes(self):
        make_lane(self.root)
        (self.root / 'binaries/initech/apk').mkdir(parents=True)
        svc = service(self.root)
        self.addCleanup(svc.close)
        self.assertIsNone(svc.program('web_bounty', 'nope', 'web'))
        self.assertIsNone(svc.program('binaries', 'initech', 'apk'))
        self.assertIsNone(svc.program('web_bounty', '../root', 'web'))
        self.assertEqual([r['program'] for r in svc.overview()['programs']], ['acme-demo'])

    def test_missing_url_index_reports_expected_path(self):
        make_lane(self.root, url_index=False)
        svc = service(self.root)
        self.addCleanup(svc.close)
        out = svc.program('web_bounty', 'acme-demo', 'web')
        self.assertEqual(out['sources']['url_index']['state'], 'missing')
        self.assertTrue(out['sources']['url_index']['expected'].endswith('acme-demo/web/recon/url_index/url_index.sqlite'))


class HttpTests(Base):
    def setUp(self):
        super().setUp()
        make_lane(self.root, js_shared=True)
        self.server = app.make_server(self.root, port=0, artifact_root=self.base / 'absent')
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)

    def get(self, path, params=None, host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', path + (f'?{urlencode(params)}' if params else ''),
                         headers={'Host': host or f'127.0.0.1:{self.port}'})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_overview_and_program(self):
        status, body = self.get('/api/recon/overview')
        self.assertEqual(status, 200)
        self.assertIn('partial', body)
        self.assertEqual(body['programs'][0]['id'], 'web_bounty/acme-demo')
        self.assertTrue(self.server.recon.wait_idle(30))
        status, body = self.get('/api/recon/program', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web'})
        self.assertEqual(status, 200)
        self.assertTrue(self.server.recon.wait_idle(30))
        status, body = self.get('/api/recon/program', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web'})
        self.assertFalse(body['partial'])
        self.assertEqual(body['headline']['urls']['value'], 98)
        self.assertIn('computed_at', body)
        self.assertFalse(body['artifact_root']['available'])
        json.dumps(body, allow_nan=False)

    def test_rejections(self):
        self.assertEqual(self.get('/api/recon/overview', host='evil.example')[0], 403)
        self.assertEqual(self.get('/api/recon/overview', {'x': '1'})[0], 400)
        self.assertEqual(self.get('/api/recon/program', {'family': 'web_bounty', 'program': 'acme-demo'})[0], 400)
        self.assertEqual(self.get('/api/recon/program', {'family': 'web_bounty', 'program': '../../etc', 'lane': 'web'})[0], 400)
        self.assertEqual(self.get('/api/recon/program', {'family': 'web_bounty', 'program': 'other', 'lane': 'web'})[0], 404)
        self.assertEqual(self.get('/api/recon/program', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'refresh': '2'})[0], 400)


class ConfigTests(unittest.TestCase):
    def test_flags(self):
        args = app.parse_config(['--root', '/tmp', '--artifact-root', '/srv/artifacts', '--recon-query-budget', '1.5'])
        self.assertEqual(args.artifact_root, Path('/srv/artifacts'))
        self.assertEqual(args.recon_query_budget, 1.5)
        default = app.parse_config(['--root', '/tmp'])
        self.assertEqual(default.artifact_root, ri.default_artifact_root())
        with self.assertRaises(SystemExit):
            app.parse_config(['--root', '/tmp', '--recon-query-budget', '0'])


if __name__ == '__main__':
    unittest.main()
