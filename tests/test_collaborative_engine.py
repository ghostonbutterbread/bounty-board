"""Synthetic, offline tests for the unintegrated collaboration prototype."""
import tempfile
import unittest
from pathlib import Path


class CollaborationEngineTests(unittest.TestCase):
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
            history = reopened.history('report/a.md')
            self.assertIn(a['content'], [v['content'] for v in history])
            self.assertIn(b['content'], [v['head_content'] for v in history])
            self.assertIsNone(reopened.current('report/b.md'))

    def test_non_text_merge_is_retained_as_a_conflict(self):
        import collaborative_engine
        with tempfile.TemporaryDirectory() as tmp:
            store = collaborative_engine.CollaborationStore(Path(tmp) / 'private')
            base = store.observe_source('report', 'original\x00\n')
            store.submit('report', base['revision'], 'first\x00\n')
            result = store.submit('report', base['revision'], 'second\x00\n')
            self.assertEqual(result['status'], 'conflict')
            self.assertIn('second\x00\n', [v['content'] for v in store.history('report')])

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
            self.assertIn(incoming, [v['content'] for v in store.history('report')])

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
            history = reopened.history('report')
            self.assertIn('second\n', [item['content'] for item in history if item['kind'] == 'client:conflict'])
            undone = reopened.restore('report', accepted['revision'], base['revision'])
            self.assertEqual(undone['content'], 'original\n')
            self.assertIn('first\n', [item['content'] for item in reopened.history('report')])


if __name__ == '__main__':
    unittest.main()
