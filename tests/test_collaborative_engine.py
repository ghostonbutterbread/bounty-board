"""Synthetic, offline tests for the unintegrated collaboration prototype."""
import tempfile
import unittest
from pathlib import Path


class CollaborationEngineTests(unittest.TestCase):
    def test_git_launch_failure_preserves_cause_and_other_os_errors(self):
        from unittest import mock
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            for cause in (FileNotFoundError('missing executable'), PermissionError('not executable')):
                with self.subTest(cause=type(cause).__name__), mock.patch.object(collaborative_engine.subprocess, 'run', side_effect=cause):
                    with self.assertRaises(collaborative_engine.GitUnavailableError) as raised:
                        store._merge('current', 'base', 'incoming')
                    self.assertIs(raised.exception.__cause__, cause)
            other = OSError('unrelated process failure')
            with mock.patch.object(collaborative_engine.subprocess, 'run', side_effect=other):
                with self.assertRaises(OSError) as raised:
                    store._merge('current', 'base', 'incoming')
                self.assertIs(raised.exception, other)

    def test_corrupt_retained_version_is_not_returned_as_confirmed(self):
        import sqlite3
        from contextlib import closing
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            revision = store.observe_source('report', 'confirmed')['revision']
            with closing(sqlite3.connect(store.path)) as db, db:
                db.execute('UPDATE versions SET content=? WHERE key=? AND revision=?', ('corrupt', 'report', revision))
            with self.assertRaises(ValueError):
                store.version('report', revision)

    def test_disk_full_during_event_rolls_back_and_retry_retains_versions(self):
        import sqlite3
        from unittest import mock
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'before')['revision']
            original = store._change
            def full_after_change(*args):
                original(*args)
                raise sqlite3.OperationalError('database or disk is full')
            with mock.patch.object(store, '_change', side_effect=full_after_change):
                with self.assertRaises(sqlite3.OperationalError):
                    store.submit('report', base, 'pending', 'request')
            self.assertEqual(store.current('report')['revision'], base)
            self.assertEqual(len(store.history_page('report')['history']), 1)
            result = store.submit('report', base, 'pending', 'request')
            self.assertEqual(store.submit('report', base, 'pending', 'request'), result)
            self.assertEqual(store.version('report', base)['content'], 'before')
            self.assertEqual(store.version('report', result['revision'])['content'], 'pending')

    def test_history_pages_are_bounded_and_versions_recoverable(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'base\x00')['revision']
            head = store.submit('report', base, 'head\x00')['revision']
            conflicts = [store.submit('report', base, f'incoming {n}\x00') for n in range(75)]
            page = store.history_page('report')
            self.assertEqual(page['unresolved_count'], 75)
            events = []
            while True:
                self.assertLessEqual(len(page['history']), 50)
                events.extend(page['history'])
                if page['next_before'] is None:
                    break
                page = store.history_page('report', before=page['next_before'])
            self.assertEqual(len(events), 77)
            self.assertEqual(len({event['id'] for event in events}), 77)
            self.assertTrue(all(set(event) == {'id', 'kind', 'revision', 'base', 'head', 'resolved_revision'} for event in events))
            event = next(e for e in events if e['id'] == conflicts[0]['conflict_id'])
            self.assertEqual(store.version('report', event['revision'])['content'], 'incoming 0\x00')
            self.assertEqual(store.version('report', event['head'])['content'], 'head\x00')
            with self.assertRaises(ValueError):
                store.version('other', head)

    def test_recent_history_keeps_older_unresolved_conflicts(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'base\n')['revision']
            store.submit('report', base, 'accepted\n')
            conflict = store.submit('report', base, 'conflicting\n')
            for n in range(101):
                head = store.current('report')['revision']
                store.submit('report', head, f'next {n}\n')
            page = store.history_page('report')
            self.assertEqual(page['unresolved_count'], 1)
            self.assertEqual(len(page['history']), 50)
            events = list(page['history'])
            while page['next_before'] is not None:
                page = store.history_page('report', page['next_before'])
                events.extend(page['history'])
            self.assertTrue(any(e['id'] == conflict['conflict_id'] for e in events))
            self.assertEqual(len(events), 104)

    def test_divergent_edits_merge_and_survive_reopening(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'private'
            store = collaborative_engine.CollaborationStore(root)
            base = store.observe_source('report/a.md', 'alpha\nbeta\ngamma\n')
            a = store.submit('report/a.md', base['revision'], 'ALPHA\nbeta\ngamma\n')
            b = store.submit('report/a.md', base['revision'], 'alpha\nbeta\nGAMMA\n')
            self.assertEqual(b['status'], 'merged')
            self.assertEqual(b['content'], 'ALPHA\nbeta\nGAMMA\n')
            reopened = collaborative_engine.CollaborationStore(root)
            self.assertEqual(reopened.current('report/a.md')['content'], b['content'])
            history = reopened.history_page('report/a.md')['history']
            self.assertIn(a['content'], [reopened.version('report/a.md', v['revision'])['content'] for v in history])
            self.assertIn(b['content'], [reopened.version('report/a.md', v['head'])['content'] for v in history])
            self.assertIsNone(reopened.current('report/b.md'))

    def test_non_text_merge_is_retained_as_a_conflict(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'original\x00\n')
            store.submit('report', base['revision'], 'first\x00\n')
            result = store.submit('report', base['revision'], 'second\x00\n')
            self.assertEqual(result['status'], 'conflict')
            self.assertEqual(store.version('report', result['incoming_revision'])['content'], 'second\x00\n')

    def test_multiple_conflict_hunks_preserve_incoming(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base_text = 'one\n' + ''.join(f'line {i}\n' for i in range(20)) + 'last\n'
            base = store.observe_source('report', base_text)
            store.submit('report', base['revision'], base_text.replace('one\n', 'first\n').replace('last\n', 'first end\n'))
            incoming = base_text.replace('one\n', 'second\n').replace('last\n', 'second end\n')
            result = store.submit('report', base['revision'], incoming)
            self.assertEqual(result['status'], 'conflict')
            self.assertEqual(store.version('report', result['incoming_revision'])['content'], incoming)

    def test_source_observation_and_stale_restore_preserve_every_version(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'synthetic.md'
            report.write_text('one\ntwo\nthree\n')
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', report.read_text())
            client = store.submit('report', base['revision'], 'ONE\ntwo\nthree\n')
            report.write_text('one\ntwo\nTHREE\n')
            observed = store.observe_source('report', report.read_text())
            self.assertEqual(observed['status'], 'merged')
            self.assertEqual(observed['content'], 'ONE\ntwo\nTHREE\n')
            with self.assertRaises(ValueError):
                store.restore('report', client['revision'], base['revision'])
            self.assertEqual(store.current('report')['content'], observed['content'])
            self.assertEqual(report.read_text(), 'one\ntwo\nTHREE\n')

    def test_distinct_process_clients_merge_against_shared_database(self):
        import collaborative_engine
        import json
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as tmp:
            root = str(Path(tmp) / 'private')
            store = collaborative_engine.CollaborationStore(root)
            base = store.observe_source('report', 'one\ntwo\nthree\n')['revision']
            code = ("import json,sys; from collaborative_engine import CollaborationStore; "
                    "s=CollaborationStore(sys.argv[1]); print('ready',flush=True); "
                    "sys.stdin.readline(); print(json.dumps(s.submit('report',sys.argv[2],sys.argv[3])),flush=True)")
            children = [subprocess.Popen([sys.executable, '-c', code, root, base, text], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                        env={**os.environ, 'TMPDIR': tmp})
                        for text in ('ONE\ntwo\nthree\n', 'one\ntwo\nTHREE\n')]
            try:
                for child in children:
                    self.assertEqual(child.stdout.readline().strip(), 'ready')
                for child in children:
                    child.stdin.write('\n'); child.stdin.flush()
                results = []
                for child in children:
                    out, err = child.communicate(timeout=15)
                    self.assertEqual(child.returncode, 0, err)
                    results.append(json.loads(out))
                self.assertEqual({r['status'] for r in results}, {'saved', 'merged'})
                self.assertEqual(collaborative_engine.CollaborationStore(root).current('report')['content'], 'ONE\ntwo\nTHREE\n')
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill(); child.communicate()

    def test_conflicts_remain_recoverable_and_undo_creates_new_head(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'original\n')
            accepted = store.submit('report', base['revision'], 'first\n')
            conflict = store.submit('report', base['revision'], 'second\n')
            self.assertEqual(conflict['status'], 'conflict')
            self.assertEqual(store.current('report')['content'], 'first\n')
            reopened = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            history = reopened.history_page('report')['history']
            self.assertIn('second\n', [reopened.version('report', item['revision'])['content'] for item in history if item['kind'] == 'client:conflict'])
            undone = reopened.restore('report', accepted['revision'], base['revision'])
            self.assertEqual(undone['content'], 'original\n')
            self.assertIn('first\n', [reopened.version('report', item['revision'])['content'] for item in reopened.history_page('report')['history']])


if __name__ == '__main__':
    unittest.main()
