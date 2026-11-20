import errno
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import draft_store


class DraftFailureTests(unittest.TestCase):
    def test_directory_sync_failure_does_not_claim_save_and_retry_recovers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'drafts'
            draft_store.save_draft(root, 'report', 'first', 'rev', 'one')
            original_fsync = os.fsync

            def fail_directory(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError(errno.EIO, 'injected directory sync failure')
                return original_fsync(fd)

            with patch.object(draft_store.os, 'fsync', side_effect=fail_directory):
                with self.assertRaises(OSError):
                    draft_store.save_draft(root, 'report', 'second', 'rev', 'two')
            # The failed call did not acknowledge success; publication may exist.
            # A retry must validate the exact bytes and sync before succeeding.
            recovered = draft_store.save_draft(root, 'report', 'second', 'rev', 'two')
            self.assertEqual(recovered['content'], 'second')
            self.assertEqual({x['content'] for x in draft_store.list_drafts(root, 'report')}, {'first', 'second'})


if __name__ == '__main__':
    unittest.main()
