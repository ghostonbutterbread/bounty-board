"""Synthetic tests for deleting report artifacts (disposable roots only)."""
import json
import os
import threading
import unittest
from unittest import mock
from urllib.parse import urlencode

import artifact_uploads as au
from tests import test_artifact_uploads as tu

SELECT, F1 = tu.SELECT, tu.F1


class DeleteFixture(tu.Fixture):
    def delete(self, artifact, size=None, modified=None, path=F1, headers=None, query=None, body=None, **extra):
        target = '/api/report-artifact-delete?' + (
            query if query is not None else urlencode({**SELECT, 'path': path, 'artifact': artifact, **extra}))
        if body is None:
            if size is None:
                info = (self.lane / artifact).lstat()
                size, modified = info.st_size, int(info.st_mtime)
            body = json.dumps({'size': size, 'modified': modified}).encode()
        base = {'Origin': self.origin, 'X-Requested-With': 'Bounty-Board', 'Content-Type': 'application/json',
                'Content-Length': str(len(body)), 'Sec-Fetch-Site': 'same-origin'}
        items = headers(base) if headers is not None else list(base.items())
        status, response_headers, payload, _ = self.raw('POST', target, items, body)
        return status, response_headers, json.loads(payload) if payload else None

    def entry(self, relative, path=F1):
        return next((a for a in self.listing(path)['artifacts'] if a['relative'] == relative), None)


class DeleteDisabledTests(DeleteFixture):
    enabled = False

    def test_flag_off(self):
        (self.folder / 'x.txt').write_text('x')
        status, headers, body = self.delete('reports/F1/x.txt')
        self.assertEqual((status, body), (404, {'error': 'uploads_disabled'}))
        self.assertEqual(headers.get('connection'), 'close')
        self.assertTrue((self.folder / 'x.txt').exists())
        listing = self.listing()
        self.assertFalse(listing['upload']['delete'])
        self.assertTrue(listing['artifacts'])
        self.assertFalse(any(a['deletable'] for a in listing['artifacts']))


class DeleteGateTests(DeleteFixture):
    def setUp(self):
        super().setUp()
        (self.folder / 'gate.txt').write_text('gate')

    def test_each_gate_refusal(self):
        def without(key):
            return lambda base: [(k, v) for k, v in base.items() if k != key]

        def replace(key, value):
            return lambda base: [(k, value if k == key else v) for k, v in base.items()]

        def plus(key, value):
            return lambda base: list(base.items()) + [(key, value)]
        cases = {
            'no origin': without('Origin'),
            'foreign origin': replace('Origin', 'https://evil.example'),
            'cross-site fetch': replace('Sec-Fetch-Site', 'cross-site'),
            'same-site fetch': replace('Sec-Fetch-Site', 'same-site'),
            'missing requested-with': without('X-Requested-With'),
            'wrong requested-with': replace('X-Requested-With', 'XMLHttpRequest'),
            'duplicate requested-with': plus('X-Requested-With', 'Bounty-Board'),
            'octet-stream type': replace('Content-Type', 'application/octet-stream'),
            'form type': replace('Content-Type', 'application/x-www-form-urlencoded'),
            'missing content type': without('Content-Type'),
            'duplicate content type': plus('Content-Type', 'application/json'),
            'transfer encoding': plus('Transfer-Encoding', 'chunked'),
            'missing length': without('Content-Length'),
            'bad length': replace('Content-Length', '4x'),
            'signed length': replace('Content-Length', '+4'),
            'duplicate length': plus('Content-Length', '4'),
            'length over 4096': replace('Content-Length', '4097'),
        }
        for label, headers in cases.items():
            with self.subTest(label):
                status, response_headers, body = self.delete('reports/F1/gate.txt', headers=headers)
                self.assertEqual((status, body), (403, {'error': 'untrusted_origin'}))
                self.assertEqual(response_headers.get('connection'), 'close')
        self.assertTrue((self.folder / 'gate.txt').exists())

    def test_foreign_host(self):
        body = b'{"size": 4, "modified": 0}'
        status, _, _, _ = self.raw('POST', '/api/report-artifact-delete?' + urlencode({**SELECT, 'path': F1, 'artifact': 'reports/F1/gate.txt'}),
                                   [('Origin', 'http://evil.example'), ('X-Requested-With', 'Bounty-Board'),
                                    ('Content-Type', 'application/json'), ('Content-Length', str(len(body)))], body)
        self.assertEqual(status, 403)
        self.assertTrue((self.folder / 'gate.txt').exists())

    def test_invalid_selectors_and_too_many_fields(self):
        good = {**SELECT, 'path': F1, 'artifact': 'reports/F1/gate.txt'}
        for query in (urlencode({**SELECT, 'path': F1}),
                      urlencode({**good, 'extra': '1'}),
                      urlencode(good) + '&artifact=reports/F1/gate.txt',
                      urlencode({**good, 'program': '..'}),
                      urlencode({**good, 'family': 'nope'}),
                      urlencode({**good, 'path': '../F1/REPORT.md'}),
                      urlencode({**good, 'path': 'F1/missing.md'}),
                      urlencode({**good, 'artifact': 'reports/F1/../F1/gate.txt'}),
                      urlencode({**good, 'artifact': '/reports/F1/gate.txt'}),
                      urlencode({**good, 'name': 'gate.txt'}),
                      urlencode({**good, 'root_instance': '0'}) + '&x=1&y=2&z=3'):
            with self.subTest(query):
                status, _, body = self.delete('reports/F1/gate.txt', query=query)
                self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertTrue((self.folder / 'gate.txt').exists())

    def test_invalid_body(self):
        for body in (b'{}', b'not json', b'[]', b'{"size": 4}', b'{"size": "4", "modified": 1}',
                     b'{"size": true, "modified": 1}', b'{"size": 4, "modified": 1, "x": 1}', b'{"size": -1, "modified": 1}'):
            with self.subTest(body):
                status, _, payload = self.delete('reports/F1/gate.txt', body=body)
                self.assertEqual((status, payload), (400, {'error': 'invalid_body'}))
        self.assertTrue((self.folder / 'gate.txt').exists())

    def test_root_instance(self):
        status, _, body = self.delete('reports/F1/gate.txt', root_instance='0' * 64)
        self.assertEqual((status, body), (409, {'error': 'root_changed'}))
        self.assertTrue((self.folder / 'gate.txt').exists())
        _, _, data, _ = self.raw('GET', '/api/data?phase=identity', [])
        status, _, body = self.delete('reports/F1/gate.txt', root_instance=json.loads(data)['root_instance'])
        self.assertEqual((status, body), (200, {'deleted': 'reports/F1/gate.txt'}))


class DeletableFlagTests(DeleteFixture):
    def test_flags_in_listing(self):
        (self.folder / 'notes.MARKDOWN').write_text('# draft\n')
        (self.folder / 'Draft.Md').write_text('# draft\n')
        listing = self.listing()
        self.assertTrue(listing['upload']['delete'])
        flags = {a['relative']: a['deletable'] for a in listing['artifacts']}
        for relative in ('reports/F1/poc/exploit.py', 'reports/F1/poc/demo.mp4', 'reports/F1/evidence/screenshot.png',
                         'reports/F1/evidence/capture.har'):
            self.assertTrue(flags[relative], relative)
        for relative in ('reports/F1/EVIDENCE.md', 'reports/F1/notes.MARKDOWN', 'reports/F1/Draft.Md',
                         'evidence/F1-replay.js',   # finding field, outside the folder
                         'evidence/shared-shot.png'):  # report link, outside the folder
            self.assertFalse(flags[relative], relative)
        self.assertNotIn('reports/F1/REPORT.md', flags)
        # Reports without a dedicated folder: nothing is deletable.
        for path in ('ROOT.md', 'loose/notes.md', 'findings/confirmed/F2 - HIGH - sample.md'):
            with self.subTest(path):
                other = self.listing(path)
                self.assertFalse(other['upload']['delete'])
                self.assertFalse(any(a['deletable'] for a in other['artifacts']))
        self.assertTrue(self.listing('findings/confirmed/F2 - HIGH - sample.md')['artifacts'])

    def test_upload_entry_carries_deletable(self):
        status, _, body = self.upload('new.txt', b'abc')
        self.assertEqual(status, 201, body)
        self.assertTrue(body['artifact']['deletable'])
        self.assertEqual(body['artifact'], self.entry('reports/F1/new.txt'))
        status, _, body = self.upload('new.md', b'# x')
        self.assertFalse(body['artifact']['deletable'])


class DeleteTests(DeleteFixture):
    def test_success_removes_exactly_that_file(self):
        before = tu.tree(self.root)
        status, _, body = self.delete('reports/F1/poc/exploit.py')
        self.assertEqual((status, body), (200, {'deleted': 'reports/F1/poc/exploit.py'}))
        after = tu.tree(self.root)
        self.assertEqual(set(before) - set(after), {'web_bounty/alpha/web/reports/F1/poc/exploit.py'})
        self.assertEqual(set(after) - set(before), set())
        self.assertEqual({k: v for k, v in before.items() if k in after}, after)
        self.assertIsNone(self.entry('reports/F1/poc/exploit.py'))
        # Already gone: 404.
        status, _, body = self.delete('reports/F1/poc/exploit.py', size=1, modified=1)
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))

    def test_markdown_is_not_deletable(self):
        (self.folder / 'notes.MARKDOWN').write_text('# draft\n')
        for relative in ('reports/F1/EVIDENCE.md', 'reports/F1/notes.MARKDOWN'):
            with self.subTest(relative):
                status, _, body = self.delete(relative)
                self.assertEqual((status, body), (409, {'error': 'not_deletable'}))
                self.assertTrue((self.lane / relative).exists())
        # The report itself is never listed, so it is not found.
        status, _, body = self.delete('reports/F1/REPORT.md')
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertTrue((self.folder / 'REPORT.md').exists())

    def test_file_inside_folder_listed_only_by_link_is_not_deletable(self):
        # reports/F1/_meta is skipped by the folder rule; a link still lists it.
        (self.folder / 'REPORT.md').write_text((self.folder / 'REPORT.md').read_text() + '\n[state](_meta/state.json)\n')
        self.assertFalse(self.entry('reports/F1/_meta/state.json')['deletable'])
        status, _, body = self.delete('reports/F1/_meta/state.json')
        self.assertEqual((status, body), (409, {'error': 'not_deletable'}))
        self.assertTrue((self.folder / '_meta/state.json').exists())

    def test_associated_file_outside_folder_is_not_found(self):
        for relative in ('evidence/F1-replay.js', 'evidence/shared-shot.png'):
            with self.subTest(relative):
                self.assertIsNotNone(self.entry(relative))
                status, _, body = self.delete(relative)
                self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
                self.assertTrue((self.lane / relative).exists())
        # No dedicated folder at all: linked files stay.
        status, _, body = self.delete('reports/findings/confirmed/F2-log.txt', path='findings/confirmed/F2 - HIGH - sample.md')
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertTrue((self.lane / 'reports/findings/confirmed/F2-log.txt').exists())

    def test_changed_size_or_mtime(self):
        target = self.folder / 'poc/exploit.py'
        entry = self.entry('reports/F1/poc/exploit.py')
        content = target.read_bytes()
        status, _, body = self.delete(entry['relative'], size=entry['size'] + 1, modified=entry['modified'])
        self.assertEqual((status, body), (409, {'error': 'changed'}))
        status, _, body = self.delete(entry['relative'], size=entry['size'], modified=entry['modified'] - 5)
        self.assertEqual((status, body), (409, {'error': 'changed'}))
        os.utime(target, (entry['modified'] + 100, entry['modified'] + 100))
        status, _, body = self.delete(entry['relative'], size=entry['size'], modified=entry['modified'])
        self.assertEqual((status, body), (409, {'error': 'changed'}))
        self.assertEqual(target.read_bytes(), content)

    def test_symlink_swapped_in_after_listing(self):
        outside = self.root / 'outside-secret.txt'
        secret = outside.read_bytes()
        target = self.folder / 'poc/exploit.py'
        stale = au.ra.associate
        captured = {}

        def associate(*args, **kwargs):
            captured.setdefault('found', stale(*args, **kwargs))
            return captured['found']
        entry = self.entry('reports/F1/poc/exploit.py')
        with mock.patch.object(au.ra, 'associate', side_effect=associate):
            self.delete('reports/F1/poc/missing.txt', size=1, modified=1)  # primes the capture
            target.unlink()
            os.symlink(outside, target)
            os.utime(target, (entry['modified'], entry['modified']), follow_symlinks=False)
            status, _, body = self.delete(entry['relative'], size=entry['size'], modified=entry['modified'])
        self.assertEqual((status, body), (409, {'error': 'changed'}))
        self.assertTrue(target.is_symlink())
        self.assertEqual(outside.read_bytes(), secret)
        # Without the stale association the symlink is not listed at all.
        status, _, body = self.delete(entry['relative'], size=entry['size'], modified=entry['modified'])
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertEqual(outside.read_bytes(), secret)

    def test_folder_swapped_for_symlink(self):
        real = self.lane / 'elsewhere'
        real.mkdir()
        (real / 'x.txt').write_text('keep')
        os.symlink(real, self.lane / 'reports/LINK')
        original = au.ra.associate
        info = (real / 'x.txt').stat()

        def swapped(*args, **kwargs):
            found = original(*args, **kwargs)
            item = {**found['artifacts'][0], 'relative': 'reports/LINK/x.txt',
                    'reasons': [{'reason': 'report_folder', 'detail': 'x'}]}
            return {**found, 'folder': 'reports/LINK', 'artifacts': [item]}
        with mock.patch.object(au.ra, 'associate', side_effect=swapped):
            status, _, body = self.delete('reports/LINK/x.txt', size=info.st_size, modified=int(info.st_mtime))
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertEqual((real / 'x.txt').read_text(), 'keep')

    def test_directory_is_never_deleted(self):
        original = au.ra.associate

        def with_dir(*args, **kwargs):
            found = original(*args, **kwargs)
            item = {**found['artifacts'][0], 'relative': 'reports/F1/poc', 'name': 'poc',
                    'reasons': [{'reason': 'report_folder', 'detail': 'x'}]}
            return {**found, 'artifacts': found['artifacts'] + [item]}
        info = (self.folder / 'poc').stat()
        with mock.patch.object(au.ra, 'associate', side_effect=with_dir):
            status, _, body = self.delete('reports/F1/poc', size=info.st_size, modified=int(info.st_mtime))
        self.assertEqual((status, body), (409, {'error': 'changed'}))
        self.assertTrue((self.folder / 'poc/exploit.py').exists())

    def test_staged_upload_name_is_refused(self):
        staged = self.folder / '.syncthing.board-0123456789ab.tmp'
        staged.write_bytes(b'partial')
        self.assertIsNone(self.entry('reports/F1/.syncthing.board-0123456789ab.tmp'))
        status, _, body = self.delete('reports/F1/.syncthing.board-0123456789ab.tmp')
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertTrue(staged.exists())
        # Even if a listing ever carried it, the rule refuses dot names.
        found = {'folder': 'reports/F1', 'report': 'reports/F1/REPORT.md'}
        item = {'relative': 'reports/F1/.syncthing.board-0123456789ab.tmp', 'reasons': [{'reason': 'report_folder'}]}
        self.assertEqual(au.delete_refusal(self.server.artifact_uploads, found, item), (409, 'not_deletable'))

    def test_concurrent_upload_and_delete_of_the_same_name(self):
        for round_ in range(8):
            with self.subTest(round_):
                old = self.folder / 'race.bin'
                old.write_bytes(b'old')
                info = old.stat()
                results = {}
                go = threading.Barrier(2)

                def upload():
                    go.wait()
                    results['upload'] = self.upload('race.bin', b'new-content')

                def delete():
                    go.wait()
                    results['delete'] = self.delete('reports/F1/race.bin', size=info.st_size, modified=int(info.st_mtime))
                threads = [threading.Thread(target=upload), threading.Thread(target=delete)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(20)
                self.assertEqual(results['upload'][0], 201, results)
                self.assertEqual(results['delete'][0], 200, results)
                names = sorted(p.name for p in self.folder.iterdir() if p.name.startswith('race'))
                self.assertEqual(len(names), 1, names)
                self.assertEqual((self.folder / names[0]).read_bytes(), b'new-content')
                self.assertEqual(names[0], results['upload'][2]['artifact']['name'])
                self.assertEqual(self.staged(), [])
                (self.folder / names[0]).unlink()


if __name__ == '__main__':
    unittest.main()
