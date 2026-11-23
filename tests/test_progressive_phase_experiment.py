"""Non-production phase experiment; deliberately uses one thread and mock isolation.

This is not a proposed implementation: globally patching reports is unsafe in
ThreadingHTTPServer. It measures the separability of the existing reader only.
"""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class PhaseExperiment(unittest.TestCase):
    def test_ledger_projection_can_precede_report_classification(self):
        with tempfile.TemporaryDirectory(prefix='board-phase-') as directory:
            root = Path(directory)
            lane = root / 'web_bounty' / 'alpha' / 'web'
            (lane / 'ledgers').mkdir(parents=True)
            (lane / 'reports').mkdir()
            (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [
                {'fid': 'A1', 'title': 'Known synthetic finding',
                 'report_path': 'reports/0.md'}]}))
            for i in range(25):
                (lane / 'reports' / f'{i}.md').write_text('# Synthetic report\n')
            reads = []
            original = app.read_file

            def slow(lane_root, relative, **kwargs):
                if relative.startswith('reports/'):
                    reads.append(relative)
                    time.sleep(.005)
                return original(lane_root, relative, **kwargs)

            with patch.object(app, 'read_file', side_effect=slow):
                start = time.monotonic()
                with patch.object(app, 'reports', return_value=None):
                    first = app.discover(root)
                first_elapsed = time.monotonic() - start
                self.assertEqual(reads, [])
                projected = first['programs'][0]['lanes'][0]
                self.assertEqual(projected['findings'][0]['fid'], 'A1')
                self.assertIsNone(projected['reports'])
                start = time.monotonic()
                final = app.discover(root)
                full_elapsed = time.monotonic() - start
            self.assertEqual(len(reads), 25)
            finished = final['programs'][0]['lanes'][0]
            self.assertEqual(finished['findings'], projected['findings'])
            self.assertEqual(len(finished['reports']), 25)
            registered = next(r for r in finished['reports'] if r['path'] == '0.md')
            self.assertEqual(registered['owner_fids'], ['A1'])
            print(f'controlled experiment: 25 reports x 5ms; no-report phase={first_elapsed:.4f}s; full discovery={full_elapsed:.4f}s', flush=True)


if __name__ == '__main__':
    unittest.main()
