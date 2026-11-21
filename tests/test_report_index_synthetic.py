"""Disposable regression for lane-scoped report ownership discovery."""
import tempfile
import unittest
from pathlib import Path

import app


class CountingFinding(dict):
    reads = 0

    def get(self, key, default=None):
        type(self).reads += 1
        return super().get(key, default)


class ReportIndexTests(unittest.TestCase):
    def test_exact_path_ownership_and_evidence_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            lane = Path(tmp) / 'lane'
            base = lane / 'reports'
            base.mkdir(parents=True)
            for name in ('owned.md', 'evidence.md', 'unregistered.md'):
                (base / name).write_text('text\n')
            findings = [
                {'fid': 'A', 'report_path': 'reports/owned.md', 'extra': {'keep': 1}},
                {'fid': 'B', 'report_path': str(base / 'owned.md')},
                {'fid': 'C', 'evidence_path': 'reports/owned.md'},
                {'fid': 'D', 'evidence_path': 'reports/evidence.md'},
                {'fid': 'NOT-EXACT', 'report_path': 'reports/../reports/unregistered.md'},
            ]
            items = {item['path']: item for item in app.reports(lane, [], findings)}
            self.assertEqual((items['owned.md']['kind'], items['owned.md']['owner_fids']), ('registered_report', ['A', 'B']))
            self.assertEqual((items['evidence.md']['kind'], items['evidence.md']['owner_fids']), ('generated_evidence', ['D']))
            self.assertEqual((items['unregistered.md']['kind'], items['unregistered.md']['owner_fids']), ('unregistered', []))
            self.assertEqual(findings[0]['extra'], {'keep': 1})

    def test_ownership_is_indexed_once_per_finding(self):
        with tempfile.TemporaryDirectory() as tmp:
            lane = Path(tmp) / 'lane'
            base = lane / 'reports'
            base.mkdir(parents=True)
            for n in range(100):
                (base / f'{n}.md').write_text('report\n')
            findings = [CountingFinding(fid=f'F{n}', report_path=f'reports/{n}.md', unknown='kept') for n in range(100)]
            findings.extend([CountingFinding(fid='SECOND', report_path='reports/0.md'),
                             CountingFinding(fid='EVIDENCE', evidence_path='reports/0.md')])
            CountingFinding.reads = 0
            items = app.reports(lane, [], findings)
            first = next(item for item in items if item['path'] == '0.md')
            self.assertEqual(first['kind'], 'registered_report')
            self.assertEqual(first['owner_fids'], ['F0', 'SECOND'])
            self.assertLess(CountingFinding.reads, 1000, 'ownership lookup must scale with findings, not findings * reports')
