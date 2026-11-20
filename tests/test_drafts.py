import importlib.util
import tempfile
import unittest
from pathlib import Path

class DraftStorageTests(unittest.TestCase):
    def test_draft_storage_module_exists(self):
        self.assertIsNotNone(importlib.util.find_spec('draft_store'))

    def test_versions_are_durable_and_bound_to_report(self):
        import draft_store
        self.assertTrue(hasattr(draft_store, 'save_draft'))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'drafts'
            report = 'web_bounty/example/web/reports/findings/report.md'
            first = draft_store.save_draft(root, report, 'First draft', 'base-a', 'request-1')
            second = draft_store.save_draft(root, report, 'Second draft', 'base-a', 'request-2')
            versions = draft_store.list_drafts(root, report)
            self.assertEqual({v['content'] for v in versions}, {'First draft', 'Second draft'})
            self.assertEqual(first['report_key'], report)
            self.assertEqual(second['base_revision'], 'base-a')
            self.assertEqual(draft_store.list_drafts(root, 'other-report'), [])

    def test_idempotent_retry_cannot_overwrite_an_existing_version(self):
        import draft_store
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'drafts'
            first = draft_store.save_draft(root, 'report', 'original', 'rev', 'same-id')
            retry = draft_store.save_draft(root, 'report', 'original', 'rev', 'same-id')
            self.assertEqual(first, retry)
            with self.assertRaises(draft_store.DraftConflictError):
                draft_store.save_draft(root, 'report', 'different', 'rev', 'same-id')
            self.assertEqual([d['content'] for d in draft_store.list_drafts(root, 'report')], ['original'])

    def test_rejects_symlinked_or_public_draft_directory(self):
        import draft_store
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            actual = parent / 'actual'
            actual.mkdir(mode=0o700)
            link = parent / 'link'
            link.symlink_to(actual, target_is_directory=True)
            with self.assertRaises(OSError):
                draft_store.save_draft(link, 'report', 'text', 'rev', 'id')
            public = parent / 'public'
            public.mkdir(mode=0o755)
            with self.assertRaises(PermissionError):
                draft_store.save_draft(public, 'report', 'text', 'rev', 'id')
            self.assertEqual(list(actual.iterdir()), [])

    def test_detects_a_corrupted_retained_version(self):
        import draft_store
        import json
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'drafts'
            draft_store.save_draft(root, 'report', 'original', 'rev', 'id')
            path = next(root.glob('*/*.json'))
            record = json.loads(path.read_text())
            record['content'] = 'modified without updated digest'
            path.write_text(json.dumps(record))
            with self.assertRaises(ValueError):
                draft_store.list_drafts(root, 'report')

    def test_simultaneous_distinct_saves_preserve_both_versions(self):
        import draft_store
        import threading
        from concurrent.futures import ThreadPoolExecutor
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'drafts'
            barrier = threading.Barrier(2)
            def save(index):
                barrier.wait(timeout=3)
                return draft_store.save_draft(root, 'report', f'draft-{index}', 'rev', f'id-{index}')
            with ThreadPoolExecutor(max_workers=2) as pool:
                self.assertEqual(len(list(pool.map(save, [1, 2]))), 2)
            self.assertEqual({x['content'] for x in draft_store.list_drafts(root, 'report')}, {'draft-1', 'draft-2'})
            self.assertTrue(all((p.stat().st_mode & 0o077) == 0 for p in root.glob('*/*.json')))

if __name__ == '__main__':
    unittest.main()
