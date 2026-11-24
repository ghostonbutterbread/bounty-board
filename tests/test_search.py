"""Synthetic tests for the search index and /api/search (loopback, disposable roots)."""
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
from search_index import SearchIndex, fold, parse_terms, ranges_for
from tests.search_fixture import small_root, write_lane


def make_index(root):
    from report_publisher import generated_navigation

    def snapshot():
        try:
            canonical = Path(root).resolve(strict=True)
            stat = canonical.stat()
            return canonical, 'id', f'{canonical}:{stat.st_dev}:{stat.st_ino}'
        except OSError:
            return None
    return SearchIndex(snapshot, app.FAMILIES, app.read_file, app.ledger, generated_navigation, interval=0.05)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='search-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        self.root.mkdir()
        small_root(self.root)


class IndexTests(Base):
    def setUp(self):
        super().setUp()
        self.index = make_index(self.root)
        self.addCleanup(self.index.close)
        self.index.refresh()

    def titles(self, query, group, **kw):
        return [r.get('title') or r.get('name') for r in self.index.search(query, **kw)['results'][group]]

    def test_ready_state_and_groups(self):
        out = self.index.search('xss')
        self.assertEqual(out['index_state'], 'ready')
        self.assertEqual(out['results']['findings'][0]['fid'], 'AC-1')
        self.assertTrue(any(r['path'] == 'confirmed/xss-profile.md' for r in out['results']['reports']))

    def test_finding_links_to_report_and_evidence(self):
        f = self.index.search('AC-1')['results']['findings'][0]
        self.assertEqual(f['report']['path'], 'confirmed/xss-profile.md')
        self.assertEqual(f['report']['kind'], 'report')
        self.assertEqual(f['target'], {'program': 'web_bounty/acme', 'lane': 'web', 'section': 'findings', 'finding': 'AC-1'})
        self.assertEqual(f['report']['target']['report'], 'confirmed/xss-profile.md')
        e = self.index.search('open redirect')['results']['findings'][0]
        self.assertEqual(e['report']['kind'], 'evidence')
        self.assertIsNone(self.index.search('invoices')['results']['findings'][0]['report'])

    def test_report_lists_owner_findings_and_kind(self):
        r = [x for x in self.index.search('profile xss')['results']['reports'] if x['path'] == 'confirmed/xss-profile.md'][0]
        self.assertEqual(r['owner_fids'], ['AC-1'])
        self.assertEqual(r['report_kind'], 'registered_report')
        unowned = self.index.search('zebra')['results']['reports'][0]
        self.assertEqual(unowned['report_kind'], 'unregistered')

    def test_navigation_stubs_not_searchable(self):
        self.assertNotIn('index/xss.md', [r['path'] for r in self.index.search('xss')['results']['reports']])

    def test_ranking_exact_over_prefix_over_content(self):
        write_lane(self.root, 'web_bounty', 'rank', 'web', [
            {'fid': 'R-1', 'title': 'sqli', 'severity': 'LOW', 'class_name': 'x', 'status': 'raw'},
            {'fid': 'R-2', 'title': 'sqli in login', 'severity': 'LOW', 'class_name': 'x', 'status': 'raw'},
            {'fid': 'R-3', 'title': 'blind sqli', 'severity': 'LOW', 'class_name': 'x', 'status': 'raw'},
            {'fid': 'R-4', 'title': 'unrelated', 'severity': 'LOW', 'class_name': 'sqli', 'status': 'raw'},
        ], {})
        self.index.refresh()
        fids = [f['fid'] for f in self.index.search('sqli', program='rank')['results']['findings']]
        self.assertEqual(fids[:3], ['R-1', 'R-2', 'R-3'])
        self.assertEqual(fids[3], 'R-4')

    def test_title_beats_content_and_recency_breaks_ties(self):
        base = write_lane(self.root, 'web_bounty', 'rec', 'web', [], {
            'old.md': '# Notes\n\nmentions pivot once\n', 'new.md': '# Notes\n\nmentions pivot once\n',
            'pivot.md': '# Other\n\nnothing\n'})
        os.utime(base / 'reports/old.md', (1_000_000, 1_000_000))
        self.index.refresh()
        paths = [r['path'] for r in self.index.search('pivot', program='rec')['results']['reports']]
        self.assertEqual(paths, ['pivot.md', 'new.md', 'old.md'])

    def test_all_terms_required_and_program_kind_filters(self):
        self.assertEqual(self.titles('stored zzz', 'findings'), [])
        self.assertEqual(self.titles('stored xss', 'findings'), ['Stored XSS in profile bio'])
        self.assertEqual(self.titles('globex', 'programs'), ['globex'])
        out = self.index.search('acme')
        self.assertEqual(out['results']['programs'][0]['id'], 'web_bounty/acme')
        self.assertEqual(sorted(out['results']['programs'][0]['lanes']), ['api', 'web'])
        only = self.index.search('xss', kinds=('report',))
        self.assertEqual(only['results']['findings'], [])
        scoped = self.index.search('leak', program='initech')
        self.assertEqual([f['fid'] for f in scoped['results']['findings']], ['IN-1'])
        self.assertEqual(self.index.search('leak', program='web_bounty/globex')['results']['findings'], [])

    def test_severity_and_status_and_class_match(self):
        self.assertEqual(self.titles('critical', 'findings'), ['IDOR on invoices'])
        self.assertEqual(self.titles('dormant', 'findings'), ['Exported activity leak'])
        self.assertEqual(self.titles('sqli', 'findings'), ['SQL injection in search'])

    def test_snippet_is_plain_text_with_ranges(self):
        r = self.index.search('onerror')['results']['reports'][0]
        self.assertIn('<img src=x onerror=alert(1)>', r['snippet'])  # raw text; client escapes
        self.assertNotIn('\n', r['snippet'])
        s, e = r['snippet_ranges'][0]
        self.assertEqual(r['snippet'][s:e].lower(), 'onerror')

    def test_snippet_strips_control_chars_and_bounds_length(self):
        write_lane(self.root, 'web_bounty', 'ctl', 'web', [], {'c.md': '# C\n\n' + 'a\x00b\x1b[31m needle ' + 'z' * 5000})
        self.index.refresh()
        r = self.index.search('needle', program='ctl')['results']['reports'][0]
        self.assertLess(len(r['snippet']), 260)
        self.assertNotRegex(r['snippet'], r'[\x00-\x08\x0b-\x1f]')

    def test_incremental_reindex_reads_only_changed_files(self):
        reads = []
        original = self.index._read_file
        self.index._read_file = lambda lane, rel: (reads.append(rel), original(lane, rel))[1]
        self.index.refresh()
        self.assertEqual(reads, [])
        path = self.root / 'web_bounty/acme/web/reports/raw/unowned.md'
        path.write_text('# Scratch\n\nnow mentions quokka and more words\n')
        self.index.refresh()
        self.assertEqual(reads, ['reports/raw/unowned.md'])
        self.assertEqual(self.index.search('quokka')['results']['reports'][0]['path'], 'raw/unowned.md')
        self.assertEqual(self.index.search('zebra')['results']['reports'], [])

    def test_ledger_change_new_and_deleted_files(self):
        ledger = self.root / 'web_bounty/globex/web/ledgers/ledger.json'
        ledger.write_text(json.dumps({'findings': [{'fid': 'GX-2', 'title': 'Brand new finding', 'severity': 'LOW',
                                                    'class_name': 'x', 'status': 'raw'}]}))
        (self.root / 'web_bounty/globex/web/reports/sqli.md').unlink()
        self.index.refresh()
        self.assertEqual(self.titles('brand', 'findings'), ['Brand new finding'])
        self.assertEqual(self.titles('sql', 'findings'), [])
        self.assertEqual(self.index.search('union')['results']['reports'], [])

    def test_symlinks_are_not_followed(self):
        outside = Path(self.tmp.name) / 'outside.md'
        outside.write_text('# Secret\n\nsymlinkneedle\n')
        os.symlink(outside, self.root / 'web_bounty/acme/web/reports/link.md')
        os.symlink(Path(self.tmp.name), self.root / 'web_bounty/linked-program')
        self.index.refresh()
        self.assertEqual(self.index.search('symlinkneedle')['results']['reports'], [])
        self.assertEqual(self.index.search('linked-program')['results']['programs'], [])

    def test_content_caps_mark_partial(self):
        index = make_index(self.root)
        index.max_report_chars = 20
        index.max_total_chars = 60
        self.addCleanup(index.close)
        index.refresh()
        self.assertEqual(index.state(), 'partial')
        self.assertLessEqual(index._chars, 60 + 20)
        # Titles and paths stay searchable even when content was dropped.
        self.assertTrue(index.search('profile')['results']['reports'])

    def test_root_change_drops_and_rebuilds(self):
        self.assertTrue(self.index.search('acme')['results']['programs'])
        other = Path(self.tmp.name) / 'other'
        other.mkdir()
        write_lane(other, 'web_bounty', 'zulu', 'web', [{'fid': 'Z-1', 'title': 'Zulu thing', 'severity': 'LOW', 'class_name': 'x', 'status': 'raw'}], {})
        moved = Path(self.tmp.name) / 'root-old'
        self.root.rename(moved)
        other.rename(self.root)
        out = self.index.search('acme')
        self.assertEqual(out['results']['programs'], [])
        self.assertIn(out['index_state'], ('building', 'ready'))  # rebuild may finish inside the grace wait
        self.index.refresh()
        self.assertEqual(self.index.search('zulu')['results']['findings'][0]['fid'], 'Z-1')
        self.assertEqual(self.index.search('acme')['results']['programs'], [])

    def test_unavailable_root(self):
        index = make_index(Path(self.tmp.name) / 'missing')
        self.addCleanup(index.close)
        index.refresh()
        out = index.search('x')
        self.assertEqual(out['results']['findings'], [])
        self.assertEqual(out['warnings'], ['root_unavailable'])

    def test_invalid_ledger_is_partial_not_fatal(self):
        (self.root / 'web_bounty/acme/api/ledgers/ledger.json').write_text('{not json')
        self.index.refresh()
        self.assertEqual(self.index.state(), 'partial')
        self.assertTrue(self.index.search('xss')['results']['findings'])

    def test_helpers(self):
        self.assertEqual(parse_terms('  Foo   BAR '), ['foo', 'bar'])
        self.assertEqual(ranges_for('aXbxc', ['x']), [[1, 2], [3, 4]])
        self.assertEqual(len(fold('İstanbul')), len('İstanbul'))

    def test_search_during_refresh_is_not_blocked(self):
        gate = threading.Event()
        original = self.index._read_file

        def slow(lane, rel):
            gate.wait(5)
            return original(lane, rel)
        self.index._read_file = slow
        (self.root / 'web_bounty/acme/web/reports/raw/unowned.md').write_text('# Scratch\n\nchanged text\n')
        worker = threading.Thread(target=self.index.refresh)
        worker.start()
        time.sleep(0.1)
        started = time.perf_counter()
        out = self.index.search('xss')
        self.assertLess(time.perf_counter() - started, 0.5)
        self.assertTrue(out['results']['findings'])
        gate.set()
        worker.join(5)


class APITests(Base):
    def setUp(self):
        super().setUp()
        self.server = app.make_server(self.root, port=0)
        self.server.search_index.interval = 0.05
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def get(self, params, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        query = params if isinstance(params, str) else urlencode(params)
        conn.request('GET', f'/api/search?{query}', headers={'Host': f'127.0.0.1:{self.port}', **(headers or {})})
        response = conn.getresponse()
        return response.status, json.loads(response.read() or b'null')

    def test_search_over_http(self):
        status, body = self.get({'q': 'xss'})
        self.assertEqual(status, 200)
        self.assertEqual(body['index_state'], 'ready')
        self.assertEqual(body['results']['findings'][0]['fid'], 'AC-1')
        self.assertIn('root_instance', body)

    def test_empty_query_is_a_warmup_probe(self):
        status, body = self.get('q=')
        self.assertEqual((status, body['results']['findings']), (200, []))
        self.assertEqual(self.get('')[0], 200)

    def test_param_validation(self):
        for bad in ('q=x&limit=0', 'q=x&limit=51', 'q=x&limit=abc', 'q=x&limit=1&limit=2', 'q=x&q=y', 'q=x&kind=bogus',
                    'q=x&kind=finding,finding', 'q=x&kind=', 'q=x&unknown=1', 'q=x&program=', 'q=%00', 'q=' + 'a' * 201,
                    'q=x&program=' + 'a' * 201, 'q=%ff', 'noequals'):
            with self.subTest(bad=bad):
                self.assertEqual(self.get(bad)[0], 400)
        self.assertEqual(self.get('q=x&kind=finding,report&limit=50&program=acme')[0], 200)

    def test_untrusted_requests_rejected(self):
        self.assertEqual(self.get({'q': 'x'}, {'Origin': 'http://evil.example'})[0], 403)
        self.assertEqual(self.get({'q': 'x'}, {'Sec-Fetch-Site': 'cross-site'})[0], 403)
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('GET', '/api/search?q=x', headers={'Host': 'evil.example'})
        self.assertEqual(conn.getresponse().status, 403)

    def test_incremental_update_visible_over_http(self):
        self.get({'q': 'x'})
        (self.root / 'web_bounty/acme/web/reports/raw/unowned.md').write_text('# Scratch\n\nplatypus\n')
        deadline = time.time() + 5
        while time.time() < deadline:
            if self.get({'q': 'platypus'})[1]['results']['reports']:
                break
            time.sleep(0.1)
        else:
            self.fail('change not indexed')

    def test_concurrent_searches_and_other_endpoints(self):
        self.get({'q': 'x'})
        errors = []

        def hit():
            try:
                for _ in range(20):
                    status, _ = self.get({'q': 'xss'})
                    if status not in (200, 503):
                        errors.append(status)
            except Exception as error:  # noqa: BLE001
                errors.append(error)
        threads = [threading.Thread(target=hit) for _ in range(8)]
        for t in threads:
            t.start()
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('GET', '/api/data', headers={'Host': f'127.0.0.1:{self.port}'})
        self.assertEqual(conn.getresponse().status, 200)
        for t in threads:
            t.join(30)
        self.assertEqual(errors, [])

    def test_search_does_not_modify_root(self):
        before = {p: p.stat().st_mtime_ns for p in self.root.rglob('*') if p.is_file()}
        self.get({'q': 'xss'})
        time.sleep(0.2)
        self.get({'q': 'xss'})
        after = {p: p.stat().st_mtime_ns for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main()
