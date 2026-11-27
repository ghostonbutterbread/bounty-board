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
from tests.fixture_preferences import make_server as make_test_server
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
        finding = items['confirmed/xss-profile.md']['finding']
        self.assertEqual({k: finding[k] for k in ('fid', 'severity', 'title', 'status', 'match', 'submission', 'submission_status')},
                         {'fid': 'AC-1', 'severity': 'HIGH', 'title': 'Stored XSS in profile bio', 'status': 'confirmed',
                          'match': 'report_path', 'submission': None, 'submission_status': None})
        self.assertRegex(finding['metadata_revision'], r'^[0-9a-f]{64}$')
        self.assertEqual(items['confirmed/xss-profile.md']['report_kind'], 'registered_report')
        # AC-3's evidence file is an artifact: never a Recent item, so it cannot read as a second finding.
        self.assertNotIn('raw/redirect/EVIDENCE.md', items)
        self.assertIsNone(items['raw/redirect-evidence.md']['finding'])
        self.assertEqual(items['raw/redirect-evidence.md']['report_kind'], 'unregistered')
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
        self.server = make_test_server(self.root, port=0)
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



NAV = '<!-- generated: bounty-core-report-navigation -->\n# Nav\n'


def mapping_root(root):
    """One lane exercising every report -> finding mapping rule (synthetic)."""
    findings = [
        {'fid': 'F012', 'title': 'Packet XSS', 'severity': 'HIGH', 'status': 'confirmed',
         'submission': {'state': 'submitted', 'result': 'valid', 'report': 'R-1'}, 'submission_status': 'submitted'},
        {'fid': 'F020', 'title': 'Registered', 'severity': 'LOW', 'status': 'raw', 'report_path': 'reports/reg/report.md'},
        {'fid': 'F030', 'title': 'Evidence', 'severity': 'MEDIUM', 'status': 'raw', 'evidence_path': 'reports/ev/e.md'},
        {'fid': 'F040', 'title': 'Legacy', 'severity': 'CRITICAL', 'status': 'raw', 'submission': 'not-a-dict'},
        {'fid': 'F050', 'title': 'Dup one', 'severity': 'LOW'},
        {'fid': 'F050', 'title': 'Dup two', 'severity': 'LOW'},
        # A registered report wins over the packet folder it sits in.
        {'fid': 'F060', 'title': 'Owner wins', 'severity': 'INFO', 'report_path': 'reports/F012-xss/owned.md'},
    ]
    reports = {
        'F012-xss/EVIDENCE.md': '# Evidence\n',
        'F012-xss/acme.example-xss-F012.md': '# Submission\n',
        'F012-xss/_meta/x.md': '# Meta\n',
        'F012-xss/_meta/deep/y.md': '# Deeper meta\n',
        'scratch/_meta/z.md': '# Not a packet\n',
        'F012/notes.md': '# Notes\n',
        'F012-xss/owned.md': '# Owned\n',
        'F012-xss/nav.md': NAV,
        'reg/report.md': '# Registered\n',
        'ev/e.md': '# Evidence 30\n',
        'findings/high/F040 - Legacy title.md': '# Legacy\n',
        'F050-dup/a.md': '# Dup\n',
        'F099-missing/a.md': '# Missing\n',
        'F099 - Not in ledger.md': '# Missing legacy\n',
        'active.md': '# Active\n',
        'F012.md': '# Top-level file named like a FID\n',
        'index/F012.md': '# F012\n',
    }
    write_lane(root, 'web_bounty', 'mapco', 'web', findings, reports)
    return root


class MappingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recent-map-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        mapping_root(self.root)
        self.index = make_index(self.root)
        self.addCleanup(self.index.close)
        self.index.refresh()

    def items(self, **kw):
        return {i['path']: i for i in self.index.recent(limit=200, **kw)['items']}

    def mapped(self, **kw):
        return {p: (i['finding']['fid'], i['finding']['match']) if i['finding'] else None for p, i in self.items(**kw).items()}

    def test_mapping_rules(self):
        # Evidence files (F012-xss/EVIDENCE.md by name, ev/e.md by evidence_path)
        # are artifacts and never Recent items; the dict equality proves absence.
        self.assertEqual(self.mapped(), {
            'F012-xss/acme.example-xss-F012.md': ('F012', 'packet'),
            'F012/notes.md': ('F012', 'packet'),
            'F012-xss/owned.md': ('F060', 'report_path'),
            'reg/report.md': ('F020', 'report_path'),
            'findings/high/F040 - Legacy title.md': ('F040', 'legacy'),
            'F050-dup/a.md': None,
            'F099-missing/a.md': None,
            'F099 - Not in ledger.md': None,
            'active.md': None,
            'F012.md': None,
            'scratch/_meta/z.md': None,
        })

    def test_packet_meta_hidden_like_navigation(self):
        # Hidden from Recent by default, shown (and still mapped) with the navigation toggle.
        hidden = self.items()
        self.assertNotIn('F012-xss/_meta/x.md', hidden)
        self.assertNotIn('F012-xss/_meta/deep/y.md', hidden)
        self.assertFalse(hidden['scratch/_meta/z.md']['packet_meta'], 'only _meta/ inside a finding packet')
        shown = self.items(include_navigation=True)
        self.assertEqual((shown['F012-xss/_meta/x.md']['finding']['fid'], shown['F012-xss/_meta/x.md']['packet_meta']), ('F012', True))
        self.assertTrue(shown['F012-xss/_meta/deep/y.md']['packet_meta'])
        # Two packet _meta files and two navigation stubs (F012-xss/nav.md, index/F012.md).
        self.assertEqual(self.index.recent(limit=1)['total_reports'] + 4, self.index.recent(limit=1, include_navigation=True)['total_reports'])
        # Search never lists them, like generated navigation.
        found = [r['path'] for r in self.index.search('meta', limit=50)['results']['reports']]
        self.assertIn('scratch/_meta/z.md', found)
        self.assertFalse([p for p in found if '/_meta/' in p and p.startswith('F012')])

    def test_navigation_never_maps(self):
        items = self.items(include_navigation=True)
        self.assertIsNone(items['F012-xss/nav.md']['finding'])
        self.assertEqual(items['F012-xss/nav.md']['report_kind'], 'generated_navigation')

    def test_finding_payload(self):
        items = self.items()
        self.assertEqual({k: v for k, v in items['F012-xss/acme.example-xss-F012.md']['finding'].items() if k != 'metadata_revision'},
                         {'fid': 'F012', 'title': 'Packet XSS', 'severity': 'HIGH', 'status': 'confirmed',
                          'submission': {'state': 'submitted', 'result': 'valid'}, 'submission_status': 'submitted', 'match': 'packet',
                          # feat/board-recent-facets: additive facet fields.
                          'severity_key': 'high', 'class': {'raw': None, 'category': 'unclassified', 'subclass': None,
                                                            'label': 'Unclassified', 'subclass_label': None}})
        self.assertEqual(items['F012-xss/acme.example-xss-F012.md']['submission_key'], 'valid')
        self.assertEqual(items['active.md']['submission_key'], 'none')
        self.assertIsNone(items['findings/high/F040 - Legacy title.md']['finding']['submission'])

    def test_duplicate_owner_maps_to_nothing(self):
        lane = self.root / 'web_bounty/mapco/web/ledgers/ledger.json'
        data = json.loads(lane.read_text())
        data['findings'][4]['report_path'] = 'reports/active.md'
        lane.write_text(json.dumps(data))
        self.index.refresh()
        self.assertIsNone(self.mapped()['active.md'])

    def test_touch_makes_a_ledger_change_visible_without_waiting(self):
        index = make_index(self.root)
        self.addCleanup(index.close)
        index.interval = 3600  # never stale on its own
        self.assertEqual(index.recent(fresh_wait=3)['index_state'], 'ready')
        ledger = self.root / 'web_bounty/mapco/web/ledgers/ledger.json'
        data = json.loads(ledger.read_text())
        data['findings'][0]['severity'] = 'LOW'
        tmp = ledger.with_name('ledger.tmp')
        tmp.write_text(json.dumps(data))
        tmp.replace(ledger)
        stale = {i['path']: i for i in index.recent(fresh_wait=3)['items']}
        self.assertEqual(stale['F012/notes.md']['finding']['severity'], 'HIGH', 'interval not elapsed: cached')
        index.touch()
        fresh = {i['path']: i for i in index.recent(fresh_wait=3)['items']}
        self.assertEqual(fresh['F012/notes.md']['finding']['severity'], 'LOW')


class NaIndexTests(Base):
    KEYS = {'web_bounty/globex/web/sqli.md', 'web_bounty/acme/web/raw/redirect-evidence.md'}

    def setUp(self):
        super().setUp()
        self.index = make_index(self.root)
        self.addCleanup(self.index.close)
        self.index.refresh()

    def test_flags_without_hiding(self):
        out = self.index.recent(na_keys=self.KEYS)
        self.assertTrue(out['na_available'])
        self.assertEqual({i['path'] for i in out['items'] if i['na']}, {'sqli.md', 'raw/redirect-evidence.md'})
        self.assertEqual((out['total'], out['na_hidden'], out['na_hidden_page']), (5, 0, 0))

    def test_store_unavailable(self):
        out = self.index.recent(na_keys=None, hide_na=True)
        self.assertFalse(out['na_available'])
        self.assertEqual(out['total'], 5)
        self.assertFalse(any(i['na'] for i in out['items']))

    def test_hide_na_with_counts_and_facets(self):
        # Newest first: sqli(NA), xss-profile, notes, redirect(NA), unowned.
        out = self.index.recent(na_keys=self.KEYS, hide_na=True)
        self.assertEqual([i['path'] for i in out['items']], ['confirmed/xss-profile.md', 'notes.md', 'raw/unowned.md'])
        self.assertEqual((out['total'], out['na_hidden'], out['na_hidden_page']), (3, 2, 2))
        self.assertNotIn('web_bounty/globex', {p['id'] for p in out['facets']['programs']})
        page = self.index.recent(na_keys=self.KEYS, hide_na=True, limit=1)
        self.assertEqual((page['na_hidden'], page['na_hidden_page']), (2, 1))  # sqli precedes xss-profile
        page = self.index.recent(na_keys=self.KEYS, hide_na=True, limit=1, offset=1)
        self.assertEqual(page['na_hidden_page'], 0)  # nothing between xss-profile and notes
        page = self.index.recent(na_keys=self.KEYS, hide_na=True, limit=1, offset=2)
        self.assertEqual(page['na_hidden_page'], 1)  # redirect between notes and unowned
        page = self.index.recent(na_keys=self.KEYS, hide_na=True, offset=9)
        self.assertEqual((page['items'], page['na_hidden_page'], page['na_hidden']), ([], 0, 2))
        # na_hidden respects the other filters.
        self.assertEqual(self.index.recent(na_keys=self.KEYS, hide_na=True, programs=['binaries/initech'])['na_hidden'], 0)
        self.assertEqual(self.index.recent(na_keys=self.KEYS, hide_na=True, within=DAY)['na_hidden'], 1)


class NaAPITests(Base):
    def setUp(self):
        super().setUp()
        self.state = Path(self.tmp.name) / 'state'
        self.server = make_test_server(self.root, port=0, state_dir=self.state)
        self.server.search_index.interval = 0.05
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))
        self.server.report_na.set('web_bounty', 'globex', 'web', 'sqli.md', True)

    get = APITests.get

    def test_recent_hide_na_over_http(self):
        status, body = self.get({})
        self.assertEqual(status, 200)
        self.assertTrue(body['na_available'])
        self.assertTrue(next(i for i in body['items'] if i['path'] == 'sqli.md')['na'])
        status, body = self.get({'hide_na': '1', 'limit': '8'})
        self.assertEqual((status, body['na_hidden'], body['na_hidden_page']), (200, 1, 1))
        self.assertNotIn('sqli.md', [i['path'] for i in body['items']])
        for bad in ('hide_na=2', 'hide_na=', 'hide_na=1&hide_na=0', 'hide_na=true'):
            self.assertEqual(self.get(bad)[0], 400, bad)

    def test_recent_finding_matches_api_data(self):
        _, data = self.get('', path='/api/data')
        findings = {f['fid']: f for p in data['programs'] for l in p['lanes'] for f in l['findings'] or []}
        _, body = self.get({})
        for item in body['items']:
            if item['finding']:
                source = findings[item['finding']['fid']]
                for key in ('severity', 'status', 'title', 'metadata_revision', 'submission_status'):
                    self.assertEqual(item['finding'][key], source[key], key)

    def test_data_and_lane_reports_na_flags(self):
        _, data = self.get('', path='/api/data')
        self.assertEqual(data['capabilities']['report_na'], {'enabled': True})
        flags = {(p['id'], r['path']): r['na'] for p in data['programs'] for l in p['lanes'] for r in l['reports'] or []}
        self.assertTrue(flags[('web_bounty/globex', 'sqli.md')])
        self.assertFalse(flags[('web_bounty/acme', 'raw/unowned.md')])
        instance = self.get('phase=identity', path='/api/data')[1]['root_instance']
        status, lane = self.get({'root_instance': instance, 'family': 'web_bounty', 'program': 'globex', 'lane': 'web'},
                                path='/api/lane-reports')
        self.assertEqual(status, 200)
        self.assertTrue(lane['na_available'])
        self.assertEqual([(r['path'], r['na']) for r in lane['reports']], [('sqli.md', True)])

def facet_root(root):
    """Two programs, three lanes, every submission bucket, unmapped reports (synthetic)."""
    now = time.time()
    hour = 3600
    fc = [
        {'fid': 'F101', 'title': 'Reflected XSS', 'severity': 'HIGH', 'class_name': 'xss', 'status': 'confirmed'},
        {'fid': 'F102', 'title': 'IDOR on orders', 'severity': 'CRITICAL', 'class_name': 'idor', 'status': 'confirmed',
         'submission': {'state': 'submitted'}},
        {'fid': 'F103', 'title': 'SSRF in importer', 'severity': 'MEDIUM', 'class_name': 'ssrf', 'status': 'confirmed',
         'submission': {'state': 'submitted', 'result': 'duplicate'}},
        {'fid': 'F104', 'title': 'Odd thing', 'severity': 'LOW', 'class_name': '', 'status': 'raw', 'submission': {'state': 'dropped'}},
        {'fid': 'F105', 'title': 'Stored XSS', 'severity': 'MEDIUM', 'class_name': 'stored-xss', 'status': 'raw',
         'submission': {'state': 'raw'}},
    ]
    write_lane(root, 'web_bounty', 'facetco', 'web', fc, {
        'F101-xss/facetco-xss-F101.md': '# F101\n', 'F102-idor/facetco-idor-F102.md': '# F102\n',
        'F103-ssrf/facetco-ssrf-F103.md': '# F103\n', 'F104-odd/facetco-odd-F104.md': '# F104\n',
        'F105-xss/facetco-xss-F105.md': '# F105\n', 'notes.md': '# Notes\n'})
    write_lane(root, 'web_bounty', 'facetco', 'api', [
        {'fid': 'A201', 'title': 'API XSS', 'severity': 'HIGH', 'class_name': 'xss', 'submission': {'state': 'not_submitted'}}],
        {'A201-xss/facetco-xss-A201.md': '# A201\n'})
    write_lane(root, 'web_bounty', 'otherco', 'web', [
        {'fid': 'O301', 'title': 'Other IDOR', 'severity': 'HIGH', 'class_name': 'idor', 'submission': {'state': 'submitted', 'result': 'valid'}}],
        {'O301-idor/otherco-idor-O301.md': '# O301\n', 'scratch.md': '# Scratch\n'})
    ages = {'facetco/api/reports/A201-xss/facetco-xss-A201.md': 0.5, 'facetco/web/reports/F101-xss/facetco-xss-F101.md': 1,
            'facetco/web/reports/F102-idor/facetco-idor-F102.md': 2, 'facetco/web/reports/F103-ssrf/facetco-ssrf-F103.md': 3,
            'facetco/web/reports/F104-odd/facetco-odd-F104.md': 4, 'facetco/web/reports/F105-xss/facetco-xss-F105.md': 5,
            'facetco/web/reports/notes.md': 6, 'otherco/web/reports/O301-idor/otherco-idor-O301.md': 7,
            'otherco/web/reports/scratch.md': 8}
    for rel, age in ages.items():
        touch(Path(root) / 'web_bounty' / rel, age * hour, now)
    return root


FID = {'A201': 'A201-xss/facetco-xss-A201.md', 'F101': 'F101-xss/facetco-xss-F101.md', 'F102': 'F102-idor/facetco-idor-F102.md',
       'F103': 'F103-ssrf/facetco-ssrf-F103.md', 'F104': 'F104-odd/facetco-odd-F104.md', 'F105': 'F105-xss/facetco-xss-F105.md',
       'notes': 'notes.md', 'O301': 'O301-idor/otherco-idor-O301.md', 'scratch': 'scratch.md'}
PATH = {v: k for k, v in FID.items()}


class FacetIndexTests(unittest.TestCase):
    """feat/board-recent-facets: severity, class and submission filters, facets and orders."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recent-facets-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        facet_root(self.root)
        self.index = make_index(self.root)
        self.addCleanup(self.index.close)
        self.index.refresh()

    def ids(self, **kw):
        return [PATH[i['path']] for i in self.index.recent(**{'limit': 200, **kw})['items']]

    def test_default_order_unchanged(self):
        self.assertEqual(self.ids(), ['A201', 'F101', 'F102', 'F103', 'F104', 'F105', 'notes', 'O301', 'scratch'])

    def test_filters_or_within_and_across(self):
        self.assertEqual(self.ids(severities=['high']), ['A201', 'F101', 'O301'])
        self.assertEqual(self.ids(submissions=['none']), ['notes', 'scratch'])
        self.assertEqual(self.ids(submissions=['not_submitted']), ['A201', 'F101'])
        self.assertEqual(self.ids(submissions=['duplicate', 'valid']), ['F103', 'O301'])
        self.assertEqual(self.ids(submissions=['other']), ['F105'])
        self.assertEqual(self.ids(submissions=['dropped']), ['F104'])
        self.assertEqual(self.ids(submissions=['submitted']), ['F102'])
        self.assertEqual(self.ids(classes=['xss', 'ssrf']), ['A201', 'F101', 'F103', 'F105'])
        self.assertEqual(self.ids(classes=['xss'], severities=['medium']), ['F105'])
        self.assertEqual(self.ids(classes=['unclassified']), ['F104'])
        self.assertEqual(self.ids(classes=['none'], severities=['none']), ['notes', 'scratch'])
        self.assertEqual(self.ids(lanes=['api']), ['A201'])
        self.assertEqual(self.ids(lanes=['web', 'api'], programs=['web_bounty/facetco'], severities=['high']), ['A201', 'F101'])
        self.assertEqual(self.ids(lane='api'), ['A201'], 'the single lane argument still works')
        self.assertEqual(self.ids(severities=['exceptional']), [])

    def test_facets_ignore_their_own_filter(self):
        out = self.index.recent(severities=['high'])
        sev = {f['key']: f['count'] for f in out['facets']['severities']}
        self.assertEqual(sev, {'exceptional': 0, 'critical': 1, 'high': 3, 'medium': 2, 'low': 1, 'info': 0, 'unknown': 0, 'none': 2})
        self.assertEqual([f['key'] for f in out['facets']['severities']],
                         ['exceptional', 'critical', 'high', 'medium', 'low', 'info', 'unknown', 'none'])
        cls = {f['key']: f['count'] for f in out['facets']['classes']}
        self.assertEqual(cls, {'broken_access_control': 1, 'xss': 2, 'ssrf': 0, 'unclassified': 0, 'none': 0},
                         'present classes stay listed with zero counts')
        self.assertEqual([f['key'] for f in out['facets']['classes']], ['broken_access_control', 'xss', 'ssrf', 'unclassified', 'none'])
        self.assertEqual(next(f for f in out['facets']['classes'] if f['key'] == 'xss')['label'], 'Cross-Site Scripting')
        sub = {f['key']: f['count'] for f in out['facets']['submissions']}
        self.assertEqual(sub, {'not_submitted': 2, 'submitted': 0, 'valid': 1, 'duplicate': 0, 'dropped': 0, 'other': 0, 'none': 0})
        self.assertEqual({p['id']: p['count'] for p in out['facets']['programs']}, {'web_bounty/facetco': 2, 'web_bounty/otherco': 1})
        self.assertEqual({l['name']: l['count'] for l in out['facets']['lanes']}, {'web': 2, 'api': 1})
        # A selected class with no rows is still listed.
        out = self.index.recent(classes=['csrf'])
        self.assertEqual(next(f for f in out['facets']['classes'] if f['key'] == 'csrf')['count'], 0)
        self.assertEqual(out['total'], 0)
        # Lanes facet ignores the lane filter but honours the others.
        out = self.index.recent(lanes=['api'], submissions=['not_submitted'])
        self.assertEqual({l['name']: l['count'] for l in out['facets']['lanes']}, {'web': 1, 'api': 1})
        self.assertEqual(out['total'], 1)

    def test_orders(self):
        self.assertEqual(self.ids(order='severity'), ['F102', 'A201', 'F101', 'O301', 'F103', 'F105', 'F104', 'notes', 'scratch'])
        self.assertEqual(self.ids(order='class'), ['F102', 'O301', 'A201', 'F101', 'F105', 'F103', 'F104', 'notes', 'scratch'])
        self.assertEqual(self.ids(order='severity', severities=['high'], limit=2), ['A201', 'F101'])
        paged = [PATH[i['path']] for off in range(0, 9, 4) for i in self.index.recent(order='class', limit=4, offset=off)['items']]
        self.assertEqual(paged, self.ids(order='class'))

    def test_item_fields(self):
        items = {PATH[i['path']]: i for i in self.index.recent(limit=200)['items']}
        self.assertEqual(items['F105']['finding']['class'], {'raw': 'stored-xss', 'category': 'xss', 'subclass': 'stored',
                                                            'label': 'Cross-Site Scripting', 'subclass_label': 'Stored'})
        self.assertEqual(items['F105']['finding']['severity_key'], 'medium')
        self.assertEqual({k: items[k]['submission_key'] for k in FID},
                         {'A201': 'not_submitted', 'F101': 'not_submitted', 'F102': 'submitted', 'F103': 'duplicate',
                          'F104': 'dropped', 'F105': 'other', 'notes': 'none', 'O301': 'valid', 'scratch': 'none'})
        self.assertIsNone(items['notes']['finding'])

    def test_na_hidden_with_facet_filters(self):
        keys = {'web_bounty/facetco/web/' + FID['F101'], 'web_bounty/otherco/web/scratch.md'}
        out = self.index.recent(na_keys=keys, hide_na=True, severities=['high'])
        self.assertEqual(([PATH[i['path']] for i in out['items']], out['na_hidden'], out['na_hidden_page']), (['A201', 'O301'], 1, 1))
        self.assertEqual(self.index.recent(na_keys=keys, hide_na=True, severities=['low'])['na_hidden'], 0)
        self.assertEqual(self.index.recent(na_keys=keys, hide_na=True, submissions=['none'])['na_hidden'], 1)
        out = self.index.recent(na_keys=keys, hide_na=True, order='severity', limit=2)
        # Severity order: F102, A201, (F101 hidden), O301 ...: F101 falls after this page.
        self.assertEqual(([PATH[i['path']] for i in out['items']], out['na_hidden_page']), (['F102', 'A201'], 0))
        out = self.index.recent(na_keys=keys, hide_na=True, order='severity', limit=1, offset=2)
        self.assertEqual(([PATH[i['path']] for i in out['items']], out['na_hidden_page']), (['O301'], 1))
        sev = {f['key']: f['count'] for f in self.index.recent(na_keys=keys, hide_na=True)['facets']['severities']}
        self.assertEqual((sev['high'], sev['none']), (2, 1), 'hidden N/A rows are left out of facets')

    def test_hidden_na_class_not_listed(self):
        # Review round 1, R2: a class seen only in a hidden N/A report is not a class option.
        key = 'web_bounty/facetco/web/' + FID['F103']
        out = self.index.recent(limit=200, na_keys={key}, hide_na=True)
        self.assertEqual(out['na_hidden'], 1)
        self.assertNotIn('ssrf', [c['key'] for c in out['facets']['classes']])
        self.assertIn('ssrf', [c['key'] for c in self.index.recent(limit=200, na_keys={key})['facets']['classes']])

    def test_normalized_once_per_ledger_change(self):
        from unittest import mock
        import search_index
        with mock.patch.object(search_index.finding_facets, 'class_info', wraps=search_index.finding_facets.class_info) as spy, \
                mock.patch.object(search_index.finding_facets, 'severity_key', wraps=search_index.finding_facets.severity_key) as sev:
            for _ in range(3):
                self.index.recent(severities=['high'], order='class')
            self.index.refresh()
            self.assertEqual((spy.call_count, sev.call_count), (0, 0), 'cached with the ledger signature')
            ledger = self.root / 'web_bounty/otherco/web/ledgers/ledger.json'
            data = json.loads(ledger.read_text())
            data['findings'][0]['severity'] = 'LOW'
            ledger.write_text(json.dumps(data) + ' ')
            self.index.refresh()
            self.assertEqual((spy.call_count, sev.call_count), (1, 1), 'only the changed lane')
        self.assertEqual(self.ids(severities=['low']), ['F104', 'O301'])


class FacetAPITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recent-facets-api-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        facet_root(self.root)
        self.server = make_test_server(self.root, port=0)
        self.server.search_index.interval = 0.05
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    get = APITests.get

    def test_filters_over_http(self):
        status, body = self.get({'severity': ['high', 'critical'], 'class': 'broken_access_control', 'lane': ['web', 'api'],
                                 'order': 'severity'})
        self.assertEqual(status, 200)
        self.assertEqual([PATH[i['path']] for i in body['items']], ['F102', 'O301'])
        self.assertEqual(set(body['facets']), {'programs', 'lanes', 'severities', 'classes', 'submissions'})
        status, body = self.get({'submission': 'none', 'order': 'class'})
        self.assertEqual((status, [PATH[i['path']] for i in body['items']]), (200, ['notes', 'scratch']))
        self.assertEqual(self.get({'lane': 'api'})[1]['total'], 1, 'single lane still accepted')
        self.assertEqual(self.get('within=604800&order=newest')[0], 200, 'canonical link parameters unchanged')

    def test_strict_parsing(self):
        for bad in ('severity=urgent', 'severity=HIGH', 'severity=', 'class=bogus', 'class=XSS', 'submission=pending',
                    'lane=web&lane=bogus', 'order=popular', '&'.join(['severity=high'] * 9), '&'.join(['lane=web'] * 6),
                    '&'.join(['submission=none'] * 8), '&'.join(['class=xss'] * 20)):
            with self.subTest(bad=bad[:60]):
                status, body = self.get(bad)
                self.assertEqual((status, body['error']), (400, 'invalid_recent_reports'))
        import finding_facets
        every = '&'.join([f'program=p{i}' for i in range(100)] + [f'severity={k}' for k, _ in finding_facets.SEVERITIES] +
                         [f'class={k}' for k, _ in finding_facets.class_options()] +
                         [f'submission={k}' for k, _ in finding_facets.SUBMISSIONS] +
                         [f'lane={k}' for k in sorted(set().union(*app.FAMILIES.values()))] + ['order=class', 'q=x', 'hide_na=1'])
        self.assertEqual(self.get(every)[0], 200, 'every option once is within the caps')


if __name__ == '__main__':
    unittest.main()
