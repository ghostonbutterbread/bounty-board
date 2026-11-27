"""Board-only N/A marks on report files: store and POST /api/report-na (synthetic data only)."""
import json
import os
import stat
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

import app
from tests.fixture_preferences import make_server as make_test_server
from tests import test_ledger_actions
from tests.search_fixture import write_lane


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='report-na-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / 'state'
        self.store = app.ReportNaState(self.dir)

    def test_missing_file_is_empty(self):
        self.assertEqual(self.store.keys(), set())

    def test_set_unset_and_modes(self):
        marked = self.store.set('web_bounty', 'p', 'web', 'a/b.md', True)
        self.assertRegex(marked, r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual(self.store.keys(), {'web_bounty/p/web/a/b.md'})
        on_disk = json.loads(self.store.path.read_text())
        self.assertEqual(on_disk['web_bounty/p/web/a/b.md'], {'family': 'web_bounty', 'program': 'p', 'lane': 'web',
                                                              'path': 'a/b.md', 'marked_at': marked})
        self.assertEqual(stat.S_IMODE(self.store.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.dir.stat().st_mode), 0o700)
        self.assertEqual([p.name for p in self.dir.iterdir()], ['report-na.json'], 'no temporary files left')
        self.assertIsNone(self.store.set('web_bounty', 'p', 'web', 'a/b.md', False))
        self.assertEqual(self.store.keys(), set())
        self.assertIsNone(self.store.set('web_bounty', 'p', 'web', 'never.md', False))

    def test_bounded_dropping_oldest(self):
        self.store.MAX = 3
        data = {f'web_bounty/p/web/r{i}.md': {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'path': f'r{i}.md',
                                              'marked_at': f'2026-01-0{i}T00:00:00Z'} for i in range(1, 4)}
        self.store.write(data)
        self.store.set('web_bounty', 'p', 'web', 'new.md', True)
        self.assertEqual(self.store.keys(), {'web_bounty/p/web/r2.md', 'web_bounty/p/web/r3.md', 'web_bounty/p/web/new.md'})

    def test_path_length_cap(self):
        with self.assertRaises(ValueError):
            self.store.set('web_bounty', 'p', 'web', 'a' * 1022 + '.md', True)
        self.store.set('web_bounty', 'p', 'web', 'a' * 1021 + '.md', True)

    def test_invalid_entries_are_ignored(self):
        self.dir.mkdir()
        self.store.path.write_text(json.dumps({
            'web_bounty/p/web/a.md': {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'path': 'a.md', 'marked_at': 'x'},
            'web_bounty/p/web/b.md': {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'path': 'other.md', 'marked_at': 'x'},
            'web_bounty/p/web/c.md': {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'path': 'c.md', 'marked_at': 1},
            'web_bounty/p/web/d.md': 'nope'}))
        self.assertEqual(self.store.keys(), {'web_bounty/p/web/a.md'})

    def test_corrupt_file_unavailable_for_display_then_set_aside_on_update(self):
        for content in ('{not json', '[1, 2]'):
            with self.subTest(content=content):
                self.dir.mkdir(exist_ok=True)
                for old in self.dir.iterdir():
                    old.unlink()
                self.store.path.write_text(content)
                self.assertIsNone(self.store.keys())
                self.store.set('web_bounty', 'p', 'web', 'a.md', True)
                self.assertEqual(self.store.keys(), {'web_bounty/p/web/a.md'})
                aside = list(self.dir.glob('report-na.json.corrupt-*'))
                self.assertEqual(len(aside), 1)
                self.assertEqual(aside[0].read_text(), content)

    def test_read_error_never_overwrites(self):
        self.store.set('web_bounty', 'p', 'web', 'a.md', True)
        before = self.store.path.read_bytes()
        real = Path.read_text

        def failing(path, *args, **kwargs):
            if path == self.store.path:
                raise PermissionError('simulated')
            return real(path, *args, **kwargs)
        with mock.patch.object(Path, 'read_text', failing):
            self.assertIsNone(self.store.keys())
            with self.assertRaises(OSError):
                self.store.set('web_bounty', 'p', 'web', 'b.md', True)
            with self.assertRaises(OSError):
                self.store.set('web_bounty', 'p', 'web', 'a.md', False)
        self.assertEqual(self.store.path.read_bytes(), before)

    def test_file_replaced_by_a_directory_is_an_os_error(self):
        self.dir.mkdir()
        self.store.path.mkdir()
        self.assertIsNone(self.store.keys())
        with self.assertRaises(OSError):
            self.store.set('web_bounty', 'p', 'web', 'a.md', True)
        self.assertTrue(self.store.path.is_dir())


class PruneTests(unittest.TestCase):
    """Marks for reports that no longer exist are dropped when a lane is listed."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='report-na-prune-')
        self.addCleanup(self.tmp.cleanup)
        self.store = app.ReportNaState(Path(self.tmp.name) / 'state')
        for path in ('a.md', 'b.md', 'c.md'):
            self.store.set('web_bounty', 'p', 'web', path, True)
        self.store.set('web_bounty', 'other', 'web', 'a.md', True)

    def test_drops_only_confirmed_missing_in_listed_lanes(self):
        asked = []
        def missing(family, program, lane, path):
            asked.append(path)
            return path == 'b.md'
        self.assertEqual(self.store.prune([('web_bounty', 'p', 'web', {'a.md'})], missing), 1)
        self.assertEqual(sorted(asked), ['b.md', 'c.md'], 'only unlisted marks of the listed lane are checked')
        self.assertEqual(self.store.keys(), {'web_bounty/p/web/a.md', 'web_bounty/p/web/c.md', 'web_bounty/other/web/a.md'})

    def test_nothing_to_do_writes_nothing(self):
        before = self.store.path.stat().st_mtime_ns
        with mock.patch.object(self.store, 'write') as write:
            self.assertEqual(self.store.prune([('web_bounty', 'p', 'web', {'a.md', 'b.md', 'c.md'})], lambda *a: True), 0)
            self.assertEqual(self.store.prune([('web_bounty', 'p', 'web', {'a.md'})], lambda *a: False), 0)
            write.assert_not_called()
        self.assertEqual(self.store.path.stat().st_mtime_ns, before)

    def test_bounded_per_call(self):
        with mock.patch.object(app.ReportNaState, 'MAX_PRUNE', 1):
            self.assertEqual(self.store.prune([('web_bounty', 'p', 'web', set())], lambda *a: True), 1)
        self.assertEqual(len(self.store.keys()), 3)

    def test_never_on_a_read_error(self):
        self.store.path.write_text('{not json')
        self.assertEqual(self.store.prune([('web_bounty', 'p', 'web', set())], lambda *a: True), 0)
        self.assertEqual(self.store.path.read_text(), '{not json', 'a corrupt store is not set aside or replaced by pruning')
        with mock.patch.object(Path, 'read_text', side_effect=PermissionError('denied')):
            self.assertEqual(self.store.prune([('web_bounty', 'p', 'web', set())], lambda *a: True), 0)

    def test_update_read_error_keeps_the_file(self):
        real = app.ReportNaState.read
        def flaky(store, for_update=False):
            if for_update:
                raise OSError('transient')
            return real(store, for_update)
        before = self.store.path.read_text()
        with mock.patch.object(app.ReportNaState, 'read', flaky):
            self.assertEqual(self.store.prune([('web_bounty', 'p', 'web', set())], lambda *a: True), 0)
        self.assertEqual(self.store.path.read_text(), before)

    def test_incomplete_listings_are_skipped(self):
        listings = app.report_na_listings([
            ('web_bounty', 'p', 'web', [{'path': 'a.md'}], []),
            ('web_bounty', 'q', 'web', [{'path': 'a.md'}], ['reports_unavailable_or_invalid']),
            ('web_bounty', 'r', 'web', None, ['reports_missing'])])
        self.assertEqual(listings, [('web_bounty', 'p', 'web', {'a.md'})])


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='report-na-api-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'root'
        self.state = self.base / 'state'
        self.lane = write_lane(self.root, 'web_bounty', 'acme', 'web', [], {
            'F012-xss/submission.md': '# Evidence\n', 'notes.md': '# Notes\n', 'plain.txt.md': '# x\n'})
        (self.lane / 'reports/notes.txt').write_text('not markdown')
        (self.lane / 'reports/dir.md').mkdir()
        (self.lane / 'outside.md').write_text('# Outside reports\n')
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'secret.md').write_text('# Secret\n')
        os.symlink(outside / 'secret.md', self.lane / 'reports/link.md')
        os.symlink(outside, self.lane / 'reports/linkdir')
        self.server = None

    def tearDown(self):
        self.stop()

    def start(self, state=True):
        self.server = make_test_server(self.root, 0, state_dir=self.state if state else None)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.thread.join()
            self.server.server_close()
            self.server = None

    def request(self, method, path, payload=None, headers=None, raw=None):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        base = {'Origin': f'http://127.0.0.1:{self.server.server_port}', 'Content-Type': 'application/json',
                'X-Requested-With': 'Bounty-Board'}
        base.update(headers or {})
        body = raw if raw is not None else (json.dumps(payload) if payload is not None else None)
        conn.request(method, path, body=body, headers={k: v for k, v in base.items() if v is not None})
        response = conn.getresponse()
        data = json.loads(response.read() or b'null')
        conn.close()
        return response.status, data

    def mark(self, path='notes.md', na=True, **extra):
        payload = {'family': 'web_bounty', 'program': 'acme', 'lane': 'web', 'path': path, 'na': na, **extra}
        return self.request('POST', '/api/report-na', payload)

    def test_mark_and_unmark_with_writer_off(self):
        self.start()
        self.assertFalse(self.server.writer_enabled)
        status, body = self.mark('F012-xss/submission.md')
        self.assertEqual(status, 200, body)
        self.assertEqual((body['path'], body['na']), ('F012-xss/submission.md', True))
        self.assertRegex(body['marked_at'], r'Z$')
        self.assertEqual(self.server.report_na.keys(), {'web_bounty/acme/web/F012-xss/submission.md'})
        self.assertEqual(self.mark('F012-xss/submission.md', False), (200, {'path': 'F012-xss/submission.md', 'na': False, 'marked_at': None}))
        self.assertEqual(self.server.report_na.keys(), set())
        self.assertFalse(any('report-na' in p.name for p in self.root.rglob('*')), 'never under the data root')

    def test_persists_across_restart(self):
        self.start()
        self.assertEqual(self.mark()[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.server.report_na.keys(), {'web_bounty/acme/web/notes.md'})
        _, data = self.request('GET', '/api/data')
        report = next(r for r in data['programs'][0]['lanes'][0]['reports'] if r['path'] == 'notes.md')
        self.assertTrue(report['na'])

    def test_unmark_of_a_deleted_file_is_allowed(self):
        self.start()
        self.assertEqual(self.mark()[0], 200)
        (self.lane / 'reports/notes.md').unlink()
        self.assertEqual(self.mark(na=True)[0], 404)
        self.assertEqual(self.mark(na=False)[0], 200)
        self.assertEqual(self.server.report_na.keys(), set())
        self.assertEqual(self.mark('../x.md', na=False)[0], 400, 'syntax is still validated')

    def test_listing_drops_marks_of_moved_or_deleted_reports(self):
        self.start()
        for path in ('notes.md', 'F012-xss/submission.md', 'plain.txt.md'):
            self.assertEqual(self.mark(path)[0], 200)
        (self.lane / 'reports/notes.md').unlink()
        (self.lane / 'reports/plain.txt.md').rename(self.lane / 'reports/renamed.md')
        _, summary = self.request('GET', '/api/data')
        self.assertEqual(self.server.report_na.keys(), {'web_bounty/acme/web/F012-xss/submission.md'}, '/api/data listing pruned')
        self.assertEqual(self.mark('plain.txt.md', False)[0], 200)
        (self.lane / 'reports/renamed.md').rename(self.lane / 'reports/plain.txt.md')
        self.assertEqual(self.mark('plain.txt.md')[0], 200)
        (self.lane / 'reports/plain.txt.md').rename(self.lane / 'reports/renamed.md')
        status, body = self.request('GET', f"/api/lane-reports?root_instance={self.request('GET', '/api/data?phase=identity')[1]['root_instance']}&family=web_bounty&program=acme&lane=web")
        self.assertEqual(status, 200, body)
        self.assertEqual(self.server.report_na.keys(), {'web_bounty/acme/web/F012-xss/submission.md'}, 'lane listing pruned')
        self.assertEqual([r['path'] for r in body['reports'] if r['na']], ['F012-xss/submission.md'])
        self.assertFalse(next(r for r in body['reports'] if r['path'] == 'renamed.md')['na'], 'a renamed report loses its mark')
        (self.lane / 'reports/F012-xss/submission.md').unlink()
        self.request('GET', '/api/data')
        self.assertEqual(self.server.report_na.keys(), set())

    def test_missing_check_keeps_marks_on_doubt(self):
        self.start()
        handler = self.server.RequestHandlerClass.__new__(self.server.RequestHandlerClass)
        self.assertFalse(handler.report_missing('web_bounty', 'acme', 'web', 'notes.md'))
        self.assertTrue(handler.report_missing('web_bounty', 'acme', 'web', 'gone.md'))
        self.assertTrue(handler.report_missing('web_bounty', 'acme', 'web', 'link.md'), 'a symlink is not a report')
        self.assertTrue(handler.report_missing('web_bounty', 'acme', 'web', 'dir.md'), 'a directory is not a report')
        with mock.patch('os.open', side_effect=PermissionError(13, 'denied')):
            self.assertFalse(handler.report_missing('web_bounty', 'acme', 'web', 'gone.md'), 'permission errors keep the mark')

    def test_store_unavailable(self):
        self.start(state=False)
        self.assertEqual(self.mark(), (503, {'error': 'report_na_unavailable'}))
        _, data = self.request('GET', '/api/data')
        self.assertEqual(data['capabilities']['report_na'], {'enabled': False})
        self.assertFalse(any(r['na'] for r in data['programs'][0]['lanes'][0]['reports']))
        _, recent = self.request('GET', '/api/recent-reports')
        self.assertFalse(recent['na_available'])

    def test_unreadable_store(self):
        self.start()
        self.state.mkdir()
        (self.state / 'report-na.json').mkdir()
        self.assertEqual(self.mark(), (503, {'error': 'report_na_unavailable'}))
        _, data = self.request('GET', '/api/data')
        self.assertEqual(data['capabilities']['report_na'], {'enabled': False})
        _, recent = self.request('GET', '/api/recent-reports')
        self.assertFalse(recent['na_available'])
        instance = self.request('GET', '/api/data?phase=identity')[1]['root_instance']
        status, lane = self.request('GET', f'/api/lane-reports?root_instance={instance}&family=web_bounty&program=acme&lane=web')
        self.assertEqual((status, lane['na_available']), (200, False))

    def test_trust_failures(self):
        self.start()
        port = self.server.server_port
        good = {'family': 'web_bounty', 'program': 'acme', 'lane': 'web', 'path': 'notes.md', 'na': True}
        cases = {
            'no origin': {'Origin': None},
            'wrong origin': {'Origin': 'http://evil.example'},
            'cross-site': {'Sec-Fetch-Site': 'cross-site'},
            'same-site': {'Sec-Fetch-Site': 'same-site'},
            'no x-requested-with': {'X-Requested-With': None},
            'wrong x-requested-with': {'X-Requested-With': 'XMLHttpRequest'},
            'wrong content type': {'Content-Type': 'text/plain'},
            'content type params': {'Content-Type': 'application/json; charset=utf-8'},
            'wrong host': {'Host': 'evil.example', 'Origin': f'http://127.0.0.1:{port}'},
        }
        for name, headers in cases.items():
            with self.subTest(name):
                self.assertEqual(self.request('POST', '/api/report-na', good, headers), (403, {'error': 'untrusted_origin'}))
        self.assertEqual(self.server.report_na.keys(), set())

    def test_invalid_payloads(self):
        self.start()
        good = {'family': 'web_bounty', 'program': 'acme', 'lane': 'web', 'path': 'notes.md', 'na': True}
        bad = [
            {k: v for k, v in good.items() if k != 'na'},
            {**good, 'extra': 1},
            {**good, 'na': 1}, {**good, 'na': 'true'}, {**good, 'na': None},
            {**good, 'family': 'other'}, {**good, 'lane': 'apk'}, {**good, 'program': '_private'},
            {**good, 'program': '../acme'}, {**good, 'program': ''}, {**good, 'path': 7},
            [good], 'notes.md',
        ]
        for payload in bad:
            with self.subTest(payload=payload):
                self.assertEqual(self.request('POST', '/api/report-na', payload), (400, {'error': 'invalid_report_na'}))
        self.assertEqual(self.request('POST', '/api/report-na', raw='{not json'), (400, {'error': 'invalid_report_na'}))
        oversize = json.dumps({**good, 'path': 'a/' * 2100 + 'x.md'})
        self.assertEqual(self.request('POST', '/api/report-na', raw=oversize)[0], 400)

    def test_path_validation(self):
        self.start()
        for path in ('../x.md', '/abs.md', 'a/./b.md', 'a//b.md', 'a\\b.md', 'notes', 'notes.txt', 'nul\x00.md',
                     'tab\t.md', 'line\u2028.md', '', 'a/', '.md/..', 'a' * 1022 + '.md'):
            with self.subTest(path=path[:40]):
                self.assertEqual(self.mark(path), (400, {'error': 'invalid_report_na'}))
        for path in ('link.md', 'linkdir/secret.md', 'missing.md', 'dir.md', 'x/outside.md'):
            with self.subTest(path=path):
                self.assertEqual(self.mark(path), (404, {'error': 'report_not_found'}))
        self.assertEqual(self.mark('NOTES.MD')[0], 404)  # case matters on disk
        os.rename(self.lane / 'reports/notes.md', self.lane / 'reports/UPPER.MD')
        self.assertEqual(self.mark('UPPER.MD')[0], 200)
        self.assertEqual(self.server.report_na.keys(), {'web_bounty/acme/web/UPPER.MD'})

    def test_symlinked_lane_component_is_not_followed(self):
        other = write_lane(self.base / 'other', 'web_bounty', 'real', 'web', [], {'r.md': '# R\n'})
        os.symlink(other.parent, self.root / 'web_bounty/linked')
        self.start()
        status, _ = self.request('POST', '/api/report-na', {'family': 'web_bounty', 'program': 'linked', 'lane': 'web',
                                                            'path': 'r.md', 'na': True})
        self.assertEqual(status, 404)

    def test_state_dir_inside_root_is_refused(self):
        with self.assertRaises(ValueError):
            make_test_server(self.root, 0, state_dir=self.root / 'state')


class WriterTouchTests(test_ledger_actions.LedgerActionTests):
    """A successful BBH write makes Recent re-read the ledger without waiting for the interval."""

    def test_patch_is_visible_in_recent_immediately(self):
        (self.root / 'web_bounty/fictional/web/reports/D01').mkdir()
        # D01's submission report (packet folder mapping); its EVIDENCE.md is an artifact, not a Recent item.
        (self.root / 'web_bounty/fictional/web/reports/D01/fictional-xss-D01.md').write_text('# Submission\n')
        self.start()
        self.server.search_index.interval = 3600
        def recent():
            return self.request('GET', '/api/recent-reports')[1]['items'][0]['finding']
        self.assertEqual(recent()['severity'], 'LOW')
        data = self.data()
        finding = data['programs'][0]['lanes'][0]['findings'][0]
        status, body = self.request('PATCH', '/api/finding', {
            'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'D01', 'patch': {'severity': 'HIGH'},
            'expected_revision': finding['metadata_revision'], 'root_instance': data['root_instance']})
        self.assertEqual(status, 200, body)
        after = recent()
        self.assertEqual(after['severity'], 'HIGH')
        self.assertEqual(after['metadata_revision'], body['finding']['metadata_revision'])
        self.assertEqual(after['submission'], {'state': 'not_submitted', 'result': None})
        payload = self.submission_payload(state='submitted', result='valid')
        self.assertEqual(self.request('POST', '/api/finding/submission', payload)[0], 200)
        self.assertEqual(recent()['submission'], {'state': 'submitted', 'result': 'valid'})


for _name in dir(test_ledger_actions.LedgerActionTests):
    if _name.startswith('test_'):
        setattr(WriterTouchTests, _name, None)

if __name__ == '__main__':
    unittest.main()
