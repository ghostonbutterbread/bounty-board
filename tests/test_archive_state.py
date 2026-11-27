"""Board-side memory of a finding's status before archiving, and status tokens (synthetic data only).

The previous status lives in the Board's private state directory, never under
the data root, so Restore works from any device.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server
from tests import test_ledger_actions


class ArchiveStateTests(test_ledger_actions.LedgerActionTests):
    def setUp(self):
        super().setUp()
        self.state = self.base / 'state'

    def start(self, writer=True, state=True):
        import threading
        self.server = make_test_server(self.root, 0, writer=self.writer if writer else None, accept_uncoordinated_writes=writer,
                                      state_dir=self.state if state else None)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def finding(self, fid):
        return next(f for f in self.data()['programs'][0]['lanes'][0]['findings'] if f['fid'] == fid)

    def patch(self, fid, status):
        data = self.data()
        rev = next(f for f in data['programs'][0]['lanes'][0]['findings'] if f['fid'] == fid)['metadata_revision']
        return self.request('PATCH', '/api/finding', {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': fid,
                                                      'patch': {'status': status}, 'expected_revision': rev, 'root_instance': data['root_instance']})

    def stored(self):
        return self.request('GET', '/api/archive-state?family=web_bounty&program=fictional&lane=web')[1]

    def set_status(self, fid, status):
        data = json.loads(self.ledger.read_text())
        next(f for f in data['findings'] if f['fid'] == fid)['status'] = status
        self.ledger.write_text(json.dumps(data))

    def test_archive_records_previous_status_and_restore_forgets_it(self):
        self.set_status('D01', 'active')
        self.start()
        status, body = self.patch('D01', 'archive')
        self.assertEqual(status, 200, body)
        self.assertEqual(body['archive_state'], 'saved')
        entries = self.stored()
        self.assertTrue(entries['available'])
        self.assertEqual(entries['entries']['D01']['previous_status'], 'active')
        self.assertRegex(entries['entries']['D01']['archived_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        on_disk = json.loads((self.state / 'archive-state.json').read_text())
        self.assertEqual(on_disk['web_bounty/fictional/web/D01']['previous_status'], 'active')
        self.assertEqual([p.name for p in self.state.iterdir()], ['archive-state.json'], 'no temporary files left')
        self.assertFalse(any('archive-state' in str(p) for p in self.root.rglob('*')), 'never under the data root')
        # Restore writes back the exact previous status.
        status, body = self.patch('D01', 'active')
        self.assertEqual(status, 200, body)
        self.assertEqual(self.stored()['entries'], {})

    def test_archiving_without_a_previous_status_stores_nothing(self):
        self.start()
        status, body = self.patch('D02', 'archive')
        self.assertEqual((status, body['archive_state']), (200, 'no_previous_status'))
        self.assertEqual(self.stored()['entries'], {})

    def test_status_tokens_beyond_the_offered_list_are_written_back(self):
        self.start()
        options = self.data()['capabilities']['finding_options']['status']
        self.assertIn('active', options)
        self.assertIn('pending-review', options)
        for value in ('pending-review', 'closed', 'merged', 'a' * 40):
            status, body = self.patch('D01', value)
            self.assertEqual(status, 200, (value, body))
            self.assertEqual(self.finding('D01')['status'], value)
        for value in ('Closed', 'two words', 'a' * 41, '-lead', 'x/y', ''):
            self.assertEqual(self.patch('D01', value)[0], 400, value)

    def test_delete_forgets_the_stored_status(self):
        os.environ['FAKE_HELP'] = test_ledger_actions_help()
        self.set_status('D01', 'confirmed')
        self.start()
        self.assertEqual(self.patch('D01', 'archive')[0], 200)
        self.assertIn('D01', self.stored()['entries'])
        data = self.data()
        status, body = self.request('POST', '/api/finding/delete', {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'D01',
                                                                    'expected_revision': self.finding('D01')['metadata_revision'], 'root_instance': data['root_instance']})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.stored()['entries'], {})

    def test_no_state_dir_reports_unavailable(self):
        self.start(state=False)
        self.assertEqual(self.stored(), {'available': False, 'entries': {}})
        status, body = self.patch('D01', 'archive')
        self.assertEqual(status, 200)
        self.assertNotIn('archive_state', body)

    def test_archive_state_request_validation_and_trust(self):
        self.start()
        for query in ('family=web_bounty&program=fictional', 'family=other&program=fictional&lane=web', 'family=web_bounty&program=../x&lane=web',
                      'family=web_bounty&program=fictional&lane=apk', 'family=web_bounty&program=fictional&lane=web&extra=1',
                      'family=web_bounty&family=web_bounty&program=fictional&lane=web'):
            self.assertEqual(self.request('GET', f'/api/archive-state?{query}')[0], 400, query)
        self.assertEqual(self.request('GET', '/api/archive-state?family=web_bounty&program=fictional&lane=web', headers={'Host': 'evil.invalid'})[0], 403)

    def test_corrupt_state_file_is_tolerated_and_replaced(self):
        self.state.mkdir()
        (self.state / 'archive-state.json').write_text('{not json')
        self.set_status('D01', 'raw')
        self.start()
        self.assertEqual(self.stored()['entries'], {})
        self.assertEqual(self.patch('D01', 'archive')[1]['archive_state'], 'saved')
        self.assertEqual(self.stored()['entries']['D01']['previous_status'], 'raw')
        aside = sorted(p.name for p in self.state.glob('archive-state.json.corrupt-*'))
        self.assertEqual(len(aside), 1)
        self.assertEqual((self.state / aside[0]).read_text(), '{not json')

    def test_state_dir_inside_the_data_root_is_refused(self):
        with self.assertRaises(ValueError):
            make_test_server(self.root, 0, state_dir=self.root / 'state')

    def test_state_dir_symlinked_into_the_data_root_is_refused(self):
        (self.root / 'inside').mkdir()
        link = self.base / 'state-link'
        link.symlink_to(self.root / 'inside', target_is_directory=True)
        with self.assertRaises(ValueError):
            make_test_server(self.root, 0, state_dir=link)


class ArchiveStoreReadErrorTests(unittest.TestCase):
    def entry(self, store, fid):
        return {store.key('web_bounty', 'p', 'web', fid): {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'fid': fid,
                                                           'previous_status': 'raw', 'archived_at': '2026-01-01T00:00:00Z'}}

    def test_unreadable_file_is_never_overwritten_by_an_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = app.ArchiveState(Path(tmp))
            store.write({**self.entry(store, 'D01'), **self.entry(store, 'D02')})
            before = store.path.read_bytes()
            real_read_text = Path.read_text

            def failing(path, *args, **kwargs):
                if path == store.path:
                    raise PermissionError('simulated')
                return real_read_text(path, *args, **kwargs)
            from unittest import mock
            with mock.patch.object(Path, 'read_text', failing):
                self.assertEqual(store.lane('web_bounty', 'p', 'web'), {})  # display shows empty
                with self.assertRaises(OSError):
                    store.record('web_bounty', 'p', 'web', 'D03', 'confirmed')
                with self.assertRaises(OSError):
                    store.forget('web_bounty', 'p', 'web', 'D01')
            self.assertEqual(store.path.read_bytes(), before)
            self.assertEqual(sorted(store.lane('web_bounty', 'p', 'web')), ['D01', 'D02'])


class ArchiveStoreUnitTests(unittest.TestCase):
    def test_bounded_to_max_entries_dropping_oldest(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = app.ArchiveState(Path(tmp))
            store.MAX = 3
            data = {store.key('web_bounty', 'p', 'web', f'D0{i}'): {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'fid': f'D0{i}',
                                                                  'previous_status': 'raw', 'archived_at': f'2026-01-0{i}T00:00:00Z'} for i in range(1, 6)}
            store.write(data)
            self.assertEqual(sorted(store.lane('web_bounty', 'p', 'web')), ['D03', 'D04', 'D05'])

    def test_invalid_entries_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = app.ArchiveState(Path(tmp))
            (Path(tmp) / 'archive-state.json').write_text(json.dumps({
                'web_bounty/p/web/D01': {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'fid': 'D01', 'previous_status': 'Bad Value', 'archived_at': 'x'},
                'web_bounty/p/web/D02': {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'fid': 'D03', 'previous_status': 'raw', 'archived_at': 'x'},
                'web_bounty/p/web/D04': {'family': 'web_bounty', 'program': 'p', 'lane': 'web', 'fid': 'D04', 'previous_status': 'raw', 'archived_at': 'x'}}))
            self.assertEqual(list(store.lane('web_bounty', 'p', 'web')), ['D04'])


def test_ledger_actions_help():
    return ('--edit-finding --patch-file --root --family --lane --from-file --set-submission '
            '--submission-state --submission-result --submission-report --delete-finding --actor')


# Reuse the harness only; the inherited ledger-action tests run in their own module.
for _name in dir(test_ledger_actions.LedgerActionTests):
    if _name.startswith('test_'):
        setattr(ArchiveStateTests, _name, None)

if __name__ == '__main__':
    unittest.main()
