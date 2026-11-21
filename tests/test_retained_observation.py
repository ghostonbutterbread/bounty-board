"""Synthetic tests for retained-inode observations; no source publication."""
import tempfile
import unittest
from pathlib import Path

from collaborative_engine import CollaborationStore


class RetainedObservationTests(unittest.TestCase):
    def test_disjoint_retained_edit_merges_and_retry_is_idempotent_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp) / 'private'
            store = CollaborationStore(private)
            base = store.observe_source('report', 'one\ntwo\nthree\n')['revision']
            store.submit('report', base, 'ONE\ntwo\nthree\n', 'browser')
            result = store.observe_retained('report', 'operation-1', base, 'one\ntwo\nTHREE\n', 'snapshot-1')
            self.assertEqual((result['status'], result['content']), ('merged', 'ONE\ntwo\nTHREE\n'))
            reopened = CollaborationStore(private)
            self.assertEqual(reopened.observe_retained('report', 'operation-1', base, 'one\ntwo\nTHREE\n', 'snapshot-1'), result)
            history = reopened.history_page('report')['history']
            self.assertEqual([e['kind'] for e in history].count('retained:merged'), 1)
            self.assertEqual(reopened.version('report', result['incoming_revision'])['content'], 'one\ntwo\nTHREE\n')
            self.assertEqual(reopened.current('report')['content'], 'ONE\ntwo\nTHREE\n')


    def test_conflicting_snapshot_provenance_and_retry_after_newer_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp) / 'private'
            store = CollaborationStore(private)
            base = store.observe_source('report', 'original\n')['revision']
            store.submit('report', base, 'browser\n', 'browser')
            first = store.observe_retained('report', 'operation-1', base, 'outside\n', 'snapshot-1')
            self.assertEqual(first['status'], 'conflict')
            event_id = first['conflict_id']
            self.assertEqual(store.retained_provenance('report', event_id),
                             {'operation': 'operation-1', 'request_id': 'snapshot-1', 'base': base})
            newer = store.observe_retained('report', 'operation-1', base, 'outside later\n', 'snapshot-2')
            self.assertEqual(newer['status'], 'conflict')
            reopened = CollaborationStore(private)
            self.assertEqual(reopened.observe_retained('report', 'operation-1', base, 'outside\n', 'snapshot-1'), first)
            self.assertEqual(reopened.unresolved_count('report'), 2)
            self.assertEqual(reopened.current('report')['content'], 'browser\n')
            self.assertEqual(reopened.version('report', first['incoming_revision'])['content'], 'outside\n')
            with self.assertRaises(ValueError):
                reopened.observe_retained('report', 'operation-1', base, 'changed\n', 'snapshot-1')
            with self.assertRaises(ValueError):
                reopened.retained_provenance('other', event_id)


    def test_identical_successive_observations_do_not_duplicate_conflicts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'base\n')['revision']
            store.submit('report', base, 'browser\n', 'browser')
            first = store.observe_retained('report', 'operation', base, 'outside\n', 'observation-1')
            repeat = store.observe_retained('report', 'operation', base, 'outside\n', 'observation-2')
            self.assertEqual(repeat, first)
            self.assertEqual(store.unresolved_count('report'), 1)
            self.assertEqual(store.retained_provenance('report', first['conflict_id'])['request_id'], 'observation-1')
            self.assertEqual(store.observe_retained('report', 'operation', base, 'outside\n', 'observation-2'), first)

    def test_old_descriptor_write_after_exchange_is_retained_and_conflicts(self):
        import ctypes
        import os
        import select
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, retained = root / 'report.md', root / 'displaced.md'
            source.write_text('original\n')
            retained.write_text('browser\n')
            store = CollaborationStore(root / 'private')
            base = store.observe_source('report', source.read_text())['revision']
            store.submit('report', base, 'browser\n', 'browser')
            code = ("import os,sys; f=open(sys.argv[1], 'r+'); print('open',flush=True); "
                    "sys.stdin.readline(); f.seek(0); f.truncate(); f.write('outside late\\n'); "
                    "f.flush(); os.fsync(f.fileno()); print('written',flush=True); f.close()")
            child = subprocess.Popen([sys.executable, '-c', code, str(source)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertTrue(select.select([child.stdout], [], [], 10)[0], 'writer did not open source')
                self.assertEqual(child.stdout.readline().strip(), 'open')
                libc = ctypes.CDLL(None, use_errno=True)
                if not hasattr(libc, 'renameat2'):
                    self.skipTest('renameat2 unavailable')
                exchange = libc.renameat2
                exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
                exchange.restype = ctypes.c_int
                rc = exchange(-100, os.fsencode(source), -100, os.fsencode(retained), 2)
                if rc:
                    raise OSError(ctypes.get_errno(), 'exchange failed')
                self.assertEqual(retained.read_text(), 'original\n')
                store.observe_retained('report', 'exchange-1', base, retained.read_text(), 'before-late-write')
                child.stdin.write('\n'); child.stdin.flush()
                self.assertTrue(select.select([child.stdout], [], [], 10)[0], 'writer did not finish')
                self.assertEqual(child.stdout.readline().strip(), 'written')
                stdout, stderr = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, stderr)
                result = store.observe_retained('report', 'exchange-1', base, retained.read_text(), 'after-late-write')
                self.assertEqual(result['status'], 'conflict')
                self.assertEqual(store.version('report', result['incoming_revision'])['content'], 'outside late\n')
                self.assertEqual(store.current('report')['content'], 'browser\n')
                self.assertEqual(source.read_text(), 'browser\n')
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate()

    def test_failure_rolls_back_snapshot_and_exact_retry(self):
        import sqlite3
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            store = CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'before\n')['revision']
            original = store._change
            def fail_after_change(*args):
                original(*args)
                raise sqlite3.OperationalError('injected failure')
            with mock.patch.object(store, '_change', side_effect=fail_after_change):
                with self.assertRaises(sqlite3.OperationalError):
                    store.observe_retained('report', 'operation', base, 'after\n', 'snapshot')
            self.assertEqual(store.current('report')['revision'], base)
            self.assertEqual(len(store.history_page('report')['history']), 1)
            result = store.observe_retained('report', 'operation', base, 'after\n', 'snapshot')
            self.assertEqual(store.observe_retained('report', 'operation', base, 'after\n', 'snapshot'), result)
            self.assertEqual(store.current('report')['content'], 'after\n')


if __name__ == '__main__':
    unittest.main()
