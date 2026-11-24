"""Synthetic tests for SearchIndex.recent and GET /api/recent-reports (disposable roots only)."""
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode

import app
from tests.search_fixture import small_root, write_lane
from tests.test_search import make_index

DAY = 86400


def touch(path, age_seconds, now):
    os.utime(path, (now - age_seconds, now - age_seconds))


def dated_root(root):
    """small_root plus fixed modification times (newest first: sqli, xss, notes, redirect, unowned)."""
    small_root(root)
    now = time.time()
    reports = {
        'web_bounty/globex/web/reports/sqli.md': 60,
        'web_bounty/acme/web/reports/confirmed/xss-profile.md': 2 * 3600,
        'binaries/initech/apk/reports/notes.md': 3 * DAY,
        'web_bounty/acme/web/reports/raw/redirect-evidence.md': 10 * DAY,
        'web_bounty/acme/web/reports/raw/unowned.md': 40 * DAY,
        'web_bounty/acme/web/reports/index/xss.md': 30,  # generated navigation stub
    }
    for rel, age in reports.items():
        touch(root / rel, age, now)
    return root


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recent-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        self.root.mkdir()
        dated_root(self.root)


class IndexTests(Base):
    def setUp(self):
        super().setUp()
        self.index = make_index(self.root)
        self.addCleanup(self.index.close)
        self.index.refresh()

    def paths(self, **kw):
        return [i['path'] for i in self.index.recent(**kw)['items']]

    def test_newest_first_across_programs_without_navigation(self):
        out = self.index.recent()
        self.assertEqual(out['index_state'], 'ready')
        self.assertEqual([i['path'] for i in out['items']],
                         ['sqli.md', 'confirmed/xss-profile.md', 'notes.md', 'raw/redirect-evidence.md', 'raw/unowned.md'])
        self.assertEqual(out['total'], 5)
        self.assertEqual(out['total_reports'], 5)
        first = out['items'][0]
        self.assertEqual(first['program'], 'web_bounty/globex')
        self.assertEqual(first['program_name'], 'globex')
        self.assertEqual(first['family'], 'web_bounty')
        self.assertEqual(first['lane'], 'web')
        self.assertEqual(first['title'], 'SQLi in search')
        self.assertEqual(first['name'], 'sqli.md')
        self.assertEqual(first['target'], {'program': 'web_bounty/globex', 'lane': 'web', 'section': 'reports', 'report': 'sqli.md'})
        self.assertGreater(first['modified'], out['items'][1]['modified'])

    def test_oldest_first_and_navigation_toggle(self):
        self.assertEqual(self.paths(order='oldest')[0], 'raw/unowned.md')
        with_nav = self.index.recent(include_navigation=True)
        self.assertEqual(with_nav['items'][0]['path'], 'index/xss.md')
        self.assertEqual(with_nav['items'][0]['report_kind'], 'generated_navigation')
        self.assertEqual(with_nav['total'], 6)

    def test_navigation_stays_hidden_when_the_content_budget_is_spent(self):
        cold = make_index(self.root)
        self.addCleanup(cold.close)
        cold.max_total_chars = 0  # no stored text for any report
        cold.refresh()
        out = cold.recent()
        self.assertNotIn('index/xss.md', [i['path'] for i in out['items']])
        self.assertEqual([i['path'] for i in cold.recent(include_navigation=True)['items']][0], 'index/xss.md')
        titles = {i['path']: i['title'] for i in out['items']}
        self.assertEqual(titles['sqli.md'], 'SQLi in search')

    def test_linked_finding_and_severity(self):
        items = {i['path']: i for i in self.index.recent()['items']}
        self.assertEqual(items['confirmed/xss-profile.md']['finding'], {'fid': 'AC-1', 'severity': 'HIGH', 'title': 'Stored XSS in profile bio'})
        self.assertEqual(items['confirmed/xss-profile.md']['report_kind'], 'registered_report')
        self.assertEqual(items['raw/redirect-evidence.md']['finding']['fid'], 'AC-3')
        self.assertEqual(items['raw/redirect-evidence.md']['report_kind'], 'generated_evidence')
        self.assertIsNone(items['raw/unowned.md']['finding'])
        self.assertEqual(items['sqli.md']['finding']['severity'], 'EXCEPTIONAL')

    def test_time_window(self):
        self.assertEqual(self.paths(within=DAY), ['sqli.md', 'confirmed/xss-profile.md'])
        self.assertEqual(self.paths(within=7 * DAY), ['sqli.md', 'confirmed/xss-profile.md', 'notes.md'])
        self.assertEqual(len(self.paths(within=30 * DAY)), 4)

    def test_program_lane_and_text_filters_with_facets(self):
        self.assertEqual(self.paths(programs=['web_bounty/acme']),
                         ['confirmed/xss-profile.md', 'raw/redirect-evidence.md', 'raw/unowned.md'])
        self.assertEqual(self.paths(programs=['web_bounty/acme', 'binaries/initech']),
                         ['confirmed/xss-profile.md', 'notes.md', 'raw/redirect-evidence.md', 'raw/unowned.md'])
        self.assertEqual(self.paths(lane='apk'), ['notes.md'])
        self.assertEqual(self.paths(query='redirect'), ['raw/redirect-evidence.md'])  # path
        self.assertEqual(self.paths(query='profile xss'), ['confirmed/xss-profile.md'])  # title + path, all terms
        self.assertEqual(self.paths(query='Profile XSS'), ['confirmed/xss-profile.md'])  # case-insensitive
        self.assertEqual(self.paths(query='zebra'), [])  # body text is not matched
        out = self.index.recent(programs=['web_bounty/acme'], lane='web')
        programs = {p['id']: p['count'] for p in out['facets']['programs']}
        lanes = {l['name']: l['count'] for l in out['facets']['lanes']}
        self.assertEqual(programs, {'web_bounty/acme': 3, 'web_bounty/globex': 1})  # ignores its own filter
        self.assertEqual(lanes, {'web': 3})  # acme has no api reports
        self.assertEqual(self.paths(programs=['web_bounty/missing']), [])

    def test_paging_is_stable(self):
        pages = [self.paths(limit=2, offset=o) for o in (0, 2, 4)]
        self.assertEqual(sum(pages, []), self.paths())
        self.assertEqual(self.index.recent(limit=2, offset=4)['total'], 5)
        self.assertEqual(self.paths(offset=99), [])

    def test_equal_mtimes_have_a_deterministic_order(self):
        now = time.time()
        for rel in ('confirmed/xss-profile.md', 'raw/unowned.md', 'raw/redirect-evidence.md'):
            touch(self.root / 'web_bounty/acme/web/reports' / rel, 5, now)
        self.index.refresh()
        first = self.paths()
        self.index.refresh()
        self.assertEqual(first, self.paths())

    def test_symlinks_and_private_programs_are_excluded(self):
        outside = Path(self.tmp.name) / 'outside'
        (outside / 'web').mkdir(parents=True)
        (outside / 'secret.md').write_text('# Outside secret\n')
        os.symlink(outside / 'secret.md', self.root / 'web_bounty/acme/web/reports/link.md')
        os.symlink(outside, self.root / 'web_bounty/acme/web/reports/linked-dir')
        os.symlink(outside, self.root / 'web_bounty/linked-program')
        write_lane(self.root, 'web_bounty', '_private', 'web', [], {'hidden.md': '# Hidden\n'})
        write_lane(self.root, 'web_bounty', 'swapped', 'web', [], {})
        os.rmdir(self.root / 'web_bounty/swapped/web/reports') if (self.root / 'web_bounty/swapped/web/reports').exists() else None
        os.symlink(outside, self.root / 'web_bounty/swapped/web/reports')
        self.index.refresh()
        out = self.index.recent(include_navigation=True)
        paths = [i['path'] for i in out['items']]
        self.assertNotIn('link.md', paths)
        self.assertFalse(any(p.startswith('linked-dir') for p in paths))
        self.assertNotIn('hidden.md', paths)
        self.assertNotIn('secret.md', paths)
        self.assertFalse({i['program'] for i in out['items']} & {'web_bounty/linked-program', 'web_bounty/_private', 'web_bounty/swapped'})

    def test_changes_appear_after_refresh(self):
        new = self.root / 'web_bounty/acme/web/reports/raw/unowned.md'
        new.write_text('# Scratch edited\n')
        self.index.refresh()
        self.assertEqual(self.paths()[0], 'raw/unowned.md')
        self.assertEqual(self.index.recent()['items'][0]['title'], 'Scratch edited')
        new.unlink()
        self.index.refresh()
        self.assertNotIn('raw/unowned.md', self.paths())

    def test_stale_index_is_refreshed_before_answering(self):
        index = make_index(self.root)
        self.addCleanup(index.close)
        index.interval = 0.2
        index.recent()  # starts the background refresher and builds
        index._last_search = time.monotonic() - 120  # nobody searched for two minutes: the refresher goes idle
        time.sleep(0.6)
        passes = index.passes
        (self.root / 'binaries/initech/apk/reports/fresh.md').write_text('# Fresh\n')
        time.sleep(0.4)
        self.assertEqual(index.passes, passes, 'refresher is idle')
        self.assertEqual(index.recent(fresh_wait=3)['items'][0]['path'], 'fresh.md')
        self.assertEqual(index.recent(fresh_wait=0)['items'][0]['path'], 'fresh.md')

    def test_recent_requests_do_not_keep_the_refresher_busy(self):
        index = make_index(self.root)
        self.addCleanup(index.close)
        index.interval = 0.1
        index.recent()
        self.assertEqual(index._last_search, 0.0, 'recent requests do not extend the active window')
        time.sleep(0.4)
        passes = index.passes
        time.sleep(0.4)
        self.assertEqual(index.passes, passes, 'idle refresher')
        (self.root / 'binaries/initech/apk/reports/later.md').write_text('# Later\n')
        self.assertEqual(index.recent()['items'][0]['path'], 'later.md', 'one on-demand pass')
        self.assertEqual(index.passes, passes + 1)

    def test_unavailable_root(self):
        index = make_index(Path(self.tmp.name) / 'missing')
        self.addCleanup(index.close)
        out = index.recent(fresh_wait=0)
        self.assertEqual((out['items'], out['total']), ([], 0))


class APITests(Base):
    def setUp(self):
        super().setUp()
        self.server = app.make_server(self.root, port=0)
        self.server.search_index.interval = 0.05
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def get(self, params, headers=None, path='/api/recent-reports'):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        query = params if isinstance(params, str) else urlencode(params, doseq=True)
        conn.request('GET', f'{path}?{query}', headers={'Host': f'127.0.0.1:{self.port}', **(headers or {})})
        response = conn.getresponse()
        return response.status, json.loads(response.read() or b'null')

    def test_recent_over_http(self):
        status, body = self.get({})
        self.assertEqual(status, 200)
        self.assertEqual(body['items'][0]['path'], 'sqli.md')
        self.assertEqual(body['limit'], 50)
        self.assertIn('root_instance', body)
        self.assertIsInstance(body['now'], float)
        status, body = self.get({'program': ['web_bounty/acme', 'binaries/initech'], 'lane': 'web', 'within': str(30 * DAY),
                                 'q': 'r', 'order': 'oldest', 'limit': '1', 'offset': '0'})
        self.assertEqual(status, 200)
        self.assertEqual([i['path'] for i in body['items']], ['raw/redirect-evidence.md'])
        self.assertEqual(body['total'], 2)
        self.assertEqual(self.get({'nav': '1', 'limit': '1'})[1]['items'][0]['path'], 'index/xss.md')

    def test_param_validation_and_limits(self):
        for bad in ('limit=0', 'limit=201', 'limit=abc', 'limit=1&limit=2', 'offset=-1', 'offset=1000001', 'within=0',
                    'within=99999999999', 'lane=bogus', 'lane=', 'order=random', 'nav=2', 'q=%00', 'q=' + 'a' * 201,
                    'program=', 'program=' + 'a' * 201, '&'.join(['program=p'] * 101), 'unknown=1', 'q=%ff', 'noequals',
                    'q=x&q=y', 'limit=%EF%BC%91'):
            with self.subTest(bad=bad[:60]):
                self.assertEqual(self.get(bad)[0], 400)
        self.assertEqual(self.get('limit=200&offset=1000000&within=86400&lane=apk&order=newest&nav=0')[0], 200)
        self.assertEqual(self.get('&'.join(['program=p'] * 100))[0], 200)

    def test_untrusted_requests_rejected(self):
        self.assertEqual(self.get({}, {'Origin': 'http://evil.example'})[0], 403)
        self.assertEqual(self.get({}, {'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.get({}, {'Sec-Fetch-Site': 'same-site'})[0], 403)
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('GET', '/api/recent-reports', headers={'Host': 'evil.example'})
        self.assertEqual(conn.getresponse().status, 403)
        self.assertEqual(self.get({}, {'Origin': f'http://127.0.0.1:{self.port}', 'Sec-Fetch-Site': 'same-origin'})[0], 200)

    def test_busy_server_answers_503(self):
        # The shared search slots (4) are private to make_server; hold them with slow requests.
        slots = []
        original = self.server.search_index.recent
        gate = threading.Event()

        def slow(**kw):
            gate.wait(5)
            return original(**kw)
        self.server.search_index.recent = slow
        threads = [threading.Thread(target=lambda: slots.append(self.get({})[0])) for _ in range(4)]
        for t in threads:
            t.start()
        time.sleep(0.3)
        status, body = self.get({})
        gate.set()
        for t in threads:
            t.join()
        self.assertEqual((status, body['error']), (503, 'search_busy'))
        self.assertEqual(slots, [200] * 4)

    def test_lane_reports_carry_modified_time(self):
        status, body = self.get('', path='/api/data')
        self.assertEqual(status, 200)
        lane = next(l for p in body['programs'] if p['id'] == 'web_bounty/globex' for l in p['lanes'])
        report = lane['reports'][0]
        self.assertAlmostEqual(report['modified'], os.lstat(self.root / 'web_bounty/globex/web/reports/sqli.md').st_mtime, places=3)

    def test_does_not_modify_root(self):
        before = sorted((str(p), p.lstat().st_mtime_ns) for p in self.root.rglob('*'))
        self.get({})
        self.get({'q': 'x', 'nav': '1'})
        self.assertEqual(before, sorted((str(p), p.lstat().st_mtime_ns) for p in self.root.rglob('*')))


if __name__ == '__main__':
    unittest.main()
