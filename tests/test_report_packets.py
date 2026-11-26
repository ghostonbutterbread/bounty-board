"""One report per finding packet (synthetic, disposable roots only).

Covers the shared helper (report_packets.plan: tiers, tie-breaks, the
report_path rule, vuln-type shapes, packet files, _meta, legacy copies, two
folders sharing an FID, packet time), app.reports() (/api/data,
/api/lane-reports), SearchIndex Recent and search membership, finding links to
the main report, no content read of packet files, and incremental refresh.
"""
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

import app
import report_packets
from report_packets import plan, tier
from tests.search_fixture import write_lane
from tests.test_search import make_index

FAMILY, PROGRAM, LANE = 'web_bounty', 'demo', 'web'
OTHER_HOST = f'/srv/elsewhere/{FAMILY}/{PROGRAM}/{LANE}'
LANE_PATH = Path('/data') / FAMILY / PROGRAM / LANE


def run(files, findings=(), other=(), evidence=()):
    """plan() over {rel: mtime} with a synthetic lane path."""
    return plan(list(files.items()), list(findings), LANE_PATH, list(other), list(evidence))


def main_of(packets, folder):
    return next((rel for rel, info in packets.mains.items() if info['packet'] == folder), None)


class TierTests(unittest.TestCase):
    def test_vuln_type_shapes(self):
        accepted = ['api-target-io-ssrf-D15.md', 'github-com-stored-xss-D04.md', 'a-b-c-D15.md',
                    'one-two-three-four-five-six-seven-eight-nine-D15.md', 'API-Target-IO-SSRF-d15.MD']
        for name in accepted:
            self.assertEqual(tier(name, 'D15' if 'D04' not in name else 'D04'), 1, name)
        rejected = {
            'JUDGE-RECEIPT-D15.md': 5,          # two tokens, sidecar word
            'EVIDENCE-D15.md': 5,               # one token
            'SUBMISSION-D15.md': 3,             # its own tier
            'target-ssrf-D15.md': 5,            # only two prefix tokens
            'report-a-b-D15.md': 5,             # sidecar first token
            'judge-review-x-D15.md': 5,
            'poc-a-b-D15.md': 5,
            'notes-a-b-D15.md': 5,
            'readme-a-b-D15.md': 5,
            'draft-a-b-D15.md': 5,
            'finding-a-b-D15.md': 5,
            'evidence-a-b-D15.md': 5,
            'submission-a-b-D15.md': 5,
            'api.target-io-ssrf-D15.md': 5,     # a "." in the stem
            'api-target-io-ssrf-D15.pre-rewrite-1.md': 5,
            'api-target-io-ssrf-D16.md': 5,     # another FID
            'api-target-io-ssrf-D150.md': 5,
            'api-target-io-ssrf.md': 5,
        }
        for name, expected in rejected.items():
            self.assertEqual(tier(name, 'D15'), expected, name)

    def test_named_tiers(self):
        self.assertEqual(tier('SUBMISSION.md', 'D15'), 2)
        self.assertEqual(tier('submission.md', 'D15'), 2)
        self.assertEqual(tier('Submission-d15.md', 'D15'), 3)
        for name in ('REPORT.md', 'D15-REPORT.md', 'REPORT-D15.md', 'D15.md', 'd15-report.md'):
            self.assertEqual(tier(name, 'D15'), 4, name)
        for name in ('POC.md', 'NOTES.md', 'FINDING.md', 'JUDGE.md', 'PACKAGE.md', 'evidence-report.md', 'REPORT-DRAFT.md'):
            self.assertEqual(tier(name, 'D15'), 5, name)
        self.assertIsNone(tier('.hidden.md', 'D15'))
        self.assertIsNone(tier('request.txt', 'D15'))

    def test_tier_order(self):
        files = {'D15/api-target-io-ssrf-D15.md': 1, 'D15/SUBMISSION.md': 9, 'D15/SUBMISSION-D15.md': 9,
                 'D15/REPORT.md': 9, 'D15/POC.md': 9}
        expected = ['D15/api-target-io-ssrf-D15.md', 'D15/SUBMISSION.md', 'D15/SUBMISSION-D15.md', 'D15/REPORT.md', 'D15/POC.md']
        for want in expected:
            packets = run(files)
            self.assertEqual(main_of(packets, 'D15'), want)
            self.assertEqual(set(packets.files), set(files) - {want})
            files.pop(want)

    def test_tie_breaks_within_a_tier(self):
        # Newest wins.
        packets = run({'D15/a-b-c-D15.md': 1, 'D15/x-y-z-D15.md': 2})
        self.assertEqual(main_of(packets, 'D15'), 'D15/x-y-z-D15.md')
        # Same mtime: the name decides.
        packets = run({'D15/x-y-z-D15.md': 2, 'D15/a-b-c-D15.md': 2})
        self.assertEqual(main_of(packets, 'D15'), 'D15/a-b-c-D15.md')
        # A report_path wins within the tier over a newer file (case-insensitive).
        packets = run({'D15/a-b-c-D15.md': 1, 'D15/x-y-z-D15.md': 2},
                      [{'fid': 'D15', 'report_path': 'reports/d15/A-B-C-D15.md'}])
        self.assertEqual(main_of(packets, 'D15'), 'D15/a-b-c-D15.md')
        # Old FID reports: REPORT.md and REPORT-<FID>.md tie; newest wins.
        packets = run({'D15/REPORT.md': 1, 'D15/REPORT-D15.md': 2})
        self.assertEqual(main_of(packets, 'D15'), 'D15/REPORT-D15.md')

    def test_report_path_never_overrides_the_order(self):
        packets = run({'D15/REPORT.md': 9, 'D15/SUBMISSION.md': 1}, [{'fid': 'D15', 'report_path': 'reports/D15/REPORT.md'}])
        self.assertEqual(main_of(packets, 'D15'), 'D15/SUBMISSION.md')
        self.assertEqual(packets.files['D15/REPORT.md'], {'packet': 'D15', 'main': 'D15/SUBMISSION.md', 'group': 'files'})
        self.assertEqual(packets.mains['D15/SUBMISSION.md']['owner_fids'], ['D15'])
        self.assertEqual(packets.mains['D15/SUBMISSION.md']['finding'], ('D15', 'report_path'))
        self.assertEqual(packets.main_for('D15/REPORT.md'), 'D15/SUBMISSION.md')

    def test_fallback(self):
        # The ledger report_path when it is a top-level file of the packet...
        packets = run({'D15/POC.md': 1, 'D15/NOTES.md': 5}, [{'fid': 'D15', 'report_path': 'reports/D15/POC.md'}])
        self.assertEqual(main_of(packets, 'D15'), 'D15/POC.md')
        # ...else the only candidate...
        self.assertEqual(main_of(run({'D15/NOTES.md': 5, 'D15/poc/README.md': 9}), 'D15'), 'D15/NOTES.md')
        # ...else the newest.
        self.assertEqual(main_of(run({'D15/POC.md': 1, 'D15/NOTES.md': 5}), 'D15'), 'D15/NOTES.md')

    def test_report_path_under_underscore_folder_is_never_main(self):
        findings = [{'fid': 'D15', 'report_path': 'reports/D15/_archive/a-b-c-D15.md'}]
        packets = run({'D15/_archive/a-b-c-D15.md': 9, 'D15/NOTES.md': 1}, findings)
        self.assertEqual(main_of(packets, 'D15'), 'D15/NOTES.md')
        self.assertEqual(packets.files['D15/_archive/a-b-c-D15.md']['group'], 'archive')
        # The finding still maps to the packet through its report_path.
        self.assertEqual(packets.mains['D15/NOTES.md']['finding'], ('D15', 'report_path'))
        # No top-level candidate: no main, nothing changes.
        packets = run({'D15/_archive/a-b-c-D15.md': 9, 'D15/poc/README.md': 1}, findings)
        self.assertEqual((packets.mains, packets.files), ({}, {}))

    def test_packet_files_groups_and_meta(self):
        files = {'D15/a-b-c-D15.md': 1, 'D15/SUBMISSION.md': 1, 'D15/poc/README.md': 1, 'D15/evidence/raw.md': 1,
                 'D15/new report/draft.md': 1, 'D15/_archive/a-b-c-D15.pre-rewrite-1.md': 1, 'D15/_drafts/x.md': 1,
                 'D15/_retracted/y.md': 1, 'D15/_meta/notes.md': 1, 'D15/_meta/deep/z.md': 1}
        packets = run(files)
        groups = {rel: info['group'] for rel, info in packets.files.items()}
        self.assertEqual(groups, {'D15/SUBMISSION.md': 'files', 'D15/poc/README.md': 'files', 'D15/evidence/raw.md': 'files',
                                  'D15/new report/draft.md': 'files', 'D15/_archive/a-b-c-D15.pre-rewrite-1.md': 'archive',
                                  'D15/_drafts/x.md': 'archive', 'D15/_retracted/y.md': 'archive'})
        self.assertTrue(report_packets.is_meta('D15/_meta/notes.md'))

    def test_evidence_only_packet_has_no_main(self):
        packets = run({}, evidence=[('D18-x/EVIDENCE.md', 5)], other=[('D18-x/shot.png', 6)])
        self.assertEqual(packets.mains, {})

    def test_two_folders_sharing_a_fid(self):
        packets = run({'D20-a/REPORT.md': 1, 'D20-a/POC.md': 1, 'D20-b/REPORT.md': 1, 'D20-b/NOTES.md': 1},
                      [{'fid': 'D20'}])
        self.assertEqual(main_of(packets, 'D20-a'), 'D20-a/REPORT.md')
        self.assertEqual(main_of(packets, 'D20-b'), 'D20-b/REPORT.md')
        self.assertEqual(packets.files['D20-a/POC.md']['main'], 'D20-a/REPORT.md')
        self.assertEqual(packets.files['D20-b/NOTES.md']['main'], 'D20-b/REPORT.md')

    def test_legacy_copies(self):
        files = {'D19-x/a-b-c-D19.md': 1, 'findings/high/D19 - Old title.md': 1,
                 'D20-a/REPORT.md': 1, 'D20-b/REPORT.md': 1, 'findings/high/D20 - Twice.md': 1,
                 'D21-a/REPORT.md': 1, 'D21-b/REPORT.md': 1, 'findings/low/D21 - Pinned.md': 1,
                 'findings/low/D22 - No packet.md': 1, 'findings/low/D99 - Not in ledger.md': 1}
        findings = [{'fid': 'D19'}, {'fid': 'D20'}, {'fid': 'D21', 'report_path': 'reports/D21-b/REPORT.md'}, {'fid': 'D22'}]
        packets = run(files, findings)
        self.assertEqual(packets.files['findings/high/D19 - Old title.md'], {'packet': 'D19-x', 'main': 'D19-x/a-b-c-D19.md', 'group': 'older'})
        # Two D20 folders and no report_path: ambiguous, the copy stays as it is.
        self.assertNotIn('findings/high/D20 - Twice.md', packets.files)
        # Two D21 folders, but the report_path picks the packet.
        self.assertEqual(packets.files['findings/low/D21 - Pinned.md']['main'], 'D21-b/REPORT.md')
        self.assertNotIn('findings/low/D22 - No packet.md', packets.files)
        self.assertNotIn('findings/low/D99 - Not in ledger.md', packets.files)
        # Duplicate ledger FIDs never map.
        packets = run(files, findings + [{'fid': 'D19'}])
        self.assertNotIn('findings/high/D19 - Old title.md', packets.files)

    def test_report_registered_to_another_fid_stays_out_of_the_packet(self):
        # D16's registered report filed inside D15's folder is D16's report (review F1).
        files = {'D15-xss/acme-com-xss-D15.md': 100, 'D15-xss/acme-com-idor-D16.md': 200,
                 'D15-xss/SUBMISSION.md': 50, 'findings/high/D16 - Idor.md': 1}
        findings = [{'fid': 'D15', 'report_path': 'reports/D15-xss/acme-com-xss-D15.md'},
                    {'fid': 'D16', 'report_path': 'reports/D15-xss/acme-com-idor-D16.md'}]
        packets = run(files, findings)
        info = packets.mains['D15-xss/acme-com-xss-D15.md']
        self.assertNotIn('D15-xss/acme-com-idor-D16.md', packets.files)
        self.assertNotIn('D15-xss/acme-com-idor-D16.md', packets.mains)
        self.assertEqual((info['owner_fids'], info['finding']), (['D15'], ('D15', 'report_path')))
        self.assertEqual((info['modified'], info['updated_file']), (100, None), 'the foreign file lends no time')
        self.assertEqual(packets.files['D15-xss/SUBMISSION.md']['main'], 'D15-xss/acme-com-xss-D15.md')
        self.assertNotIn('findings/high/D16 - Idor.md', packets.files, "D16's legacy copy never joins D15's packet")
        # A file registered to the folder's own finding as well stays in the packet.
        packets = run(files, [findings[1], {'fid': 'D15', 'report_path': 'reports/D15-xss/acme-com-idor-D16.md'}])
        self.assertIn('D15-xss/acme-com-idor-D16.md', packets.files)

    def test_navigation_page_is_never_the_fallback_main(self):
        files = {'F12-x/nav.md': 900, 'F12-x/acme.example-xss-F12.md': 100, 'F13/nav.md': 900, 'F13/REPORT.md': 1}
        asked = []
        def is_navigation(rel):
            asked.append(rel)
            return rel.endswith('/nav.md')
        packets = plan(list(files.items()), [], LANE_PATH, is_navigation=is_navigation)
        self.assertEqual(main_of(packets, 'F12-x'), 'F12-x/acme.example-xss-F12.md')
        self.assertNotIn('F12-x/nav.md', packets.files, 'a navigation page stays as it is today')
        self.assertEqual(main_of(packets, 'F13'), 'F13/REPORT.md')
        self.assertEqual(sorted(asked), ['F12-x/acme.example-xss-F12.md', 'F12-x/nav.md'],
                         'read only when a packet has nothing but fallback candidates')
        # A packet holding only a navigation page has no main.
        packets = plan([('F14/nav.md', 1)], [], LANE_PATH, is_navigation=is_navigation)
        self.assertEqual((packets.mains, packets.files), ({}, {}))

    def test_cross_host_absolute_report_path(self):
        findings = [{'fid': 'D21', 'report_path': OTHER_HOST + '/reports/D21-x/REPORT.md'}]
        packets = run({'D21-x/REPORT.md': 1, 'D21-x/REPORT-D21.md': 5}, findings)
        self.assertEqual(main_of(packets, 'D21-x'), 'D21-x/REPORT.md')
        self.assertEqual(packets.mains['D21-x/REPORT.md']['finding'], ('D21', 'report_path'))

    def test_packet_time(self):
        files = {'D15/a-b-c-D15.md': 100, 'D15/SUBMISSION.md': 150}
        packets = run(files, other=[('D15/poc/shot.png', 300), ('D15/upload.tmp', 900), ('D15/.board-draft', 900),
                                    ('D15/.cache/x.png', 900), ('D15/_meta/state.json', 900), ('elsewhere.png', 999)],
                      evidence=[('D15/EVIDENCE.md', 200)])
        info = packets.mains['D15/a-b-c-D15.md']
        self.assertEqual((info['modified'], info['updated_file']), (300, 'poc/shot.png'))
        self.assertEqual(info['evidence'], ['D15/EVIDENCE.md'])
        packets = run(files)
        info = packets.mains['D15/a-b-c-D15.md']
        self.assertEqual((info['modified'], info['updated_file']), (150, 'SUBMISSION.md'))
        packets = run({'D15/a-b-c-D15.md': 500, 'D15/SUBMISSION.md': 150})
        info = packets.mains['D15/a-b-c-D15.md']
        self.assertEqual((info['modified'], info['updated_file']), (500, None))

    def test_flat_and_underscore_reports_outside_packets_are_untouched(self):
        packets = run({'notes.md': 1, '_retracted/old.md': 1, 'confirmed/xss.md': 1, 'index/D15.md': 1, 'D15.md': 1})
        self.assertEqual((packets.mains, packets.files), ({}, {}))


# ---- a lane on disk -----------------------------------------------------------
FINDINGS = [
    # Vuln-type main, ledger still names REPORT.md.
    {'fid': 'D15', 'title': 'SSRF in importer', 'severity': 'HIGH', 'class_name': 'ssrf', 'status': 'confirmed',
     'report_path': 'reports/D15-ssrf/REPORT.md', 'evidence_path': 'reports/D15-ssrf/EVIDENCE.md'},
    # SUBMISSION.md beats the registered REPORT.md.
    {'fid': 'D16', 'title': 'IDOR on invoices', 'severity': 'CRITICAL', 'class_name': 'idor', 'status': 'raw',
     'report_path': 'reports/D16/REPORT.md'},
    # Only an old REPORT.md.
    {'fid': 'D17', 'title': 'Open redirect', 'severity': 'LOW', 'class_name': 'redirect', 'status': 'raw',
     'report_path': 'reports/D17-redirect/REPORT.md'},
    # Evidence only.
    {'fid': 'D18', 'title': 'Evidence only', 'severity': 'MEDIUM', 'class_name': 'xss', 'status': 'raw',
     'evidence_path': 'reports/D18-x/EVIDENCE.md'},
    # Legacy copy beside a packet.
    {'fid': 'D19', 'title': 'Stored xss', 'severity': 'HIGH', 'class_name': 'xss', 'status': 'raw'},
    # Two folders, distinct vulnerabilities.
    {'fid': 'D20', 'title': 'Two folders', 'severity': 'LOW', 'class_name': 'misc', 'status': 'raw'},
    # Cross-host absolute report_path.
    {'fid': 'D21', 'title': 'Other host', 'severity': 'INFO', 'class_name': 'info', 'status': 'raw',
     'report_path': OTHER_HOST + '/reports/D21-x/REPORT.md'},
]
REPORTS = {
    'D15-ssrf/REPORT.md': '# Old D15 report\n\nzebra old.\n',
    'D15-ssrf/SUBMISSION.md': '# D15 submission\n\nzebra submission.\n',
    'D15-ssrf/api-target-io-ssrf-D15.md': '# SSRF in importer\n\nzebra main.\n',
    'D15-ssrf/POC.md': '# PoC\n\nzebra poc.\n',
    'D15-ssrf/JUDGE-RECEIPT-D15.md': '# Judge\n\nzebra judge.\n',
    'D15-ssrf/poc/README.md': '# PoC readme\n\nzebra readme.\n',
    'D15-ssrf/poc/request.txt': 'GET / HTTP/1.1\n',
    'D15-ssrf/EVIDENCE.md': '# Evidence D15\n\nzebra evidence.\n',
    'D15-ssrf/_archive/api-target-io-ssrf-D15.pre-rewrite-1.md': '# Archived\n\nzebra archive.\n',
    'D15-ssrf/_meta/notes.md': '# Meta\n\nzebra meta.\n',
    'D16/REPORT.md': '# D16 old\n\nzebra.\n',
    'D16/SUBMISSION.md': '# D16 submission\n\nzebra.\n',
    'D16/SUBMISSION-D16.md': '# D16 submission copy\n\nzebra.\n',
    'D16/EVIDENCE-D16.md': '# D16 evidence-ish sidecar\n\nzebra.\n',
    'D17-redirect/REPORT.md': '# D17 report\n\nzebra.\n',
    'D17-redirect/EVIDENCE.md': '# D17 evidence\n\nzebra.\n',
    'D18-x/EVIDENCE.md': '# D18 evidence\n\nzebra.\n',
    'D19-xss/github-com-stored-xss-D19.md': '# D19 main\n\nzebra.\n',
    'findings/high/D19 - Stored xss.md': '# Legacy D19\n\nzebra legacy.\n',
    'D20-a/REPORT.md': '# D20 a\n\nzebra.\n',
    'D20-b/REPORT.md': '# D20 b\n\nzebra.\n',
    'findings/low/D20 - Two folders.md': '# Legacy D20\n\nzebra.\n',
    'D21-x/REPORT.md': '# D21 registered\n\nzebra.\n',
    'D21-x/REPORT-D21.md': '# D21 newer\n\nzebra.\n',
    'notes.md': '# Flat notes\n\nzebra flat.\n',
    '_retracted/old.md': '# Retracted\n\nzebra retracted.\n',
}
MAINS = {'D15-ssrf/api-target-io-ssrf-D15.md', 'D16/SUBMISSION.md', 'D17-redirect/REPORT.md',
         'D19-xss/github-com-stored-xss-D19.md', 'D20-a/REPORT.md', 'D20-b/REPORT.md', 'D21-x/REPORT.md'}
OTHERS = {'findings/low/D20 - Two folders.md', 'notes.md', '_retracted/old.md'}
LISTED = MAINS | OTHERS
PACKET_FILES = {
    'D15-ssrf/REPORT.md': ('D15-ssrf/api-target-io-ssrf-D15.md', 'files'),
    'D15-ssrf/SUBMISSION.md': ('D15-ssrf/api-target-io-ssrf-D15.md', 'files'),
    'D15-ssrf/POC.md': ('D15-ssrf/api-target-io-ssrf-D15.md', 'files'),
    'D15-ssrf/JUDGE-RECEIPT-D15.md': ('D15-ssrf/api-target-io-ssrf-D15.md', 'files'),
    'D15-ssrf/poc/README.md': ('D15-ssrf/api-target-io-ssrf-D15.md', 'files'),
    'D15-ssrf/_archive/api-target-io-ssrf-D15.pre-rewrite-1.md': ('D15-ssrf/api-target-io-ssrf-D15.md', 'archive'),
    'D16/REPORT.md': ('D16/SUBMISSION.md', 'files'),
    'D16/SUBMISSION-D16.md': ('D16/SUBMISSION.md', 'files'),
    'D16/EVIDENCE-D16.md': ('D16/SUBMISSION.md', 'files'),
    'findings/high/D19 - Stored xss.md': ('D19-xss/github-com-stored-xss-D19.md', 'older'),
    'D21-x/REPORT-D21.md': ('D21-x/REPORT.md', 'files'),
}
META = {'D15-ssrf/_meta/notes.md'}
NOW = time.time()


def build(root):
    lane = write_lane(root, FAMILY, PROGRAM, LANE, FINDINGS, REPORTS)
    # Older ages first; the D15 PoC request is the newest file in its packet.
    for index, rel in enumerate(sorted(REPORTS)):
        os.utime(lane / 'reports' / rel, (NOW - 3600 + index, NOW - 3600 + index))
    os.utime(lane / 'reports/D15-ssrf/poc/request.txt', (NOW - 60, NOW - 60))
    os.utime(lane / 'reports/D21-x/REPORT.md', (NOW - 7200, NOW - 7200))
    return lane


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='packets-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        self.root.mkdir()
        self.lane = build(self.root)


class LaneReportsTests(Base):
    def test_items(self):
        warnings = []
        findings = app.ledger(self.lane, warnings)
        items = {i['path']: i for i in app.reports(self.lane, warnings, findings)}
        listed = {p for p, i in items.items() if i['kind'] != 'packet_file'}
        self.assertEqual(listed, LISTED | META)
        files = {p: (i['packet_main'], i['packet_group']) for p, i in items.items() if i['kind'] == 'packet_file'}
        self.assertEqual(files, PACKET_FILES)
        main = items['D15-ssrf/api-target-io-ssrf-D15.md']
        self.assertEqual((main['kind'], main['owner_fids'], main['packet'], main['packet_main']),
                         ('registered_report', ['D15'], 'D15-ssrf', 'D15-ssrf/api-target-io-ssrf-D15.md'))
        self.assertEqual(main['updated_file'], 'poc/request.txt')
        self.assertAlmostEqual(main['modified'], NOW - 60, delta=1)
        self.assertEqual(main['packet_evidence'], ['D15-ssrf/EVIDENCE.md'])
        self.assertEqual(items['D15-ssrf/REPORT.md']['owner_fids'], ['D15'])
        self.assertTrue(items['D15-ssrf/REPORT.md']['collaboration_editable'])
        self.assertEqual(items['D21-x/REPORT.md']['owner_fids'], ['D21'])
        self.assertNotIn('D18-x/EVIDENCE.md', items)

    def test_non_regular_markdown_is_skipped_like_the_search_index(self):
        # Review F2: app.reports() and SearchIndex agree on regular files only.
        fifo = self.lane / 'reports/D17-redirect/acme-com-redirect-D17.md'
        os.mkfifo(fifo)
        findings = app.ledger(self.lane, [])
        items = {i['path']: i for i in app.reports(self.lane, [], findings)}
        self.assertNotIn('D17-redirect/acme-com-redirect-D17.md', items)
        self.assertEqual(items['D17-redirect/REPORT.md']['kind'], 'registered_report')

    def test_packet_files_are_never_read(self):
        reads = []
        real = app.read_file

        def spy(root, relative, **kw):
            reads.append(relative)
            return real(root, relative, **kw)
        findings = app.ledger(self.lane, [])
        with mock.patch.object(app, 'read_file', spy):
            app.reports(self.lane, [], findings)
        self.assertEqual({r[len('reports/'):] for r in reads}, LISTED | META)


class SearchIndexTests(Base):
    def setUp(self):
        super().setUp()
        self.reads = []
        self.index = make_index(self.root)
        real = self.index._read_file

        def spy(lane, relative):
            self.reads.append(relative[len('reports/'):])
            return real(lane, relative)
        self.index._read_file = spy
        self.addCleanup(self.index.close)
        self.index.refresh()

    def recent(self, **kw):
        return self.index.recent(limit=200, **kw)

    def test_recent_one_row_per_packet(self):
        body = self.recent()
        items = {i['path']: i for i in body['items']}
        self.assertEqual(set(items), LISTED)
        self.assertEqual(body['total'], len(LISTED))
        self.assertEqual(body['total_reports'], len(LISTED))
        self.assertEqual(body['facets']['lanes'], [{'name': LANE, 'count': len(LISTED)}])
        main = items['D15-ssrf/api-target-io-ssrf-D15.md']
        self.assertEqual((main['updated_file'], main['packet']), ('poc/request.txt', 'D15-ssrf'))
        self.assertAlmostEqual(main['modified'], NOW - 60, delta=1)
        self.assertEqual(body['items'][0]['path'], 'D15-ssrf/api-target-io-ssrf-D15.md', 'packet time orders the row')
        self.assertEqual((main['finding']['fid'], main['finding']['match']), ('D15', 'report_path'))
        self.assertEqual(items['D16/SUBMISSION.md']['finding']['fid'], 'D16')
        self.assertEqual(items['D21-x/REPORT.md']['finding']['fid'], 'D21')
        self.assertEqual(items['D19-xss/github-com-stored-xss-D19.md']['finding']['match'], 'packet')
        self.assertEqual(items['D20-a/REPORT.md']['finding']['fid'], 'D20')
        self.assertEqual(items['D20-b/REPORT.md']['finding']['fid'], 'D20')
        self.assertIsNone(items['notes.md']['updated_file'])
        # The time window counts packets: only D15's packet changed in the last 10 minutes.
        self.assertEqual([i['path'] for i in self.recent(within=600)['items']], ['D15-ssrf/api-target-io-ssrf-D15.md'])
        # Navigation toggle adds the _meta file only.
        self.assertEqual({i['path'] for i in self.recent(include_navigation=True)['items']}, LISTED | META)

    def test_recent_na_follows_the_main(self):
        prefix = f'{FAMILY}/{PROGRAM}/{LANE}/'
        body = self.index.recent(limit=200, na_keys={prefix + 'D15-ssrf/SUBMISSION.md'}, hide_na=True)
        self.assertIn('D15-ssrf/api-target-io-ssrf-D15.md', {i['path'] for i in body['items']})
        self.assertEqual(body['na_hidden'], 0)
        body = self.index.recent(limit=200, na_keys={prefix + 'D15-ssrf/api-target-io-ssrf-D15.md'}, hide_na=True)
        self.assertNotIn('D15-ssrf/api-target-io-ssrf-D15.md', {i['path'] for i in body['items']})
        self.assertEqual(body['na_hidden'], 1)

    def test_search_hits_and_counts(self):
        found = self.index.search('zebra', limit=50, kinds=('report',))
        self.assertEqual({r['path'] for r in found['results']['reports']}, LISTED)
        self.assertEqual(found['counts']['report'], len(LISTED))
        program = self.index.search('demo', kinds=('program',))['results']['programs'][0]
        self.assertEqual(program['report_count'], len(LISTED))

    def test_finding_links_point_at_the_main(self):
        links = {}
        for fid in ('D15', 'D16', 'D17', 'D18', 'D21'):
            hit = next(f for f in self.index.search(fid, kinds=('finding',))['results']['findings'] if f['fid'] == fid)
            links[fid] = (hit['report'] or {}).get('path'), (hit['report'] or {}).get('kind')
        self.assertEqual(links, {'D15': ('D15-ssrf/api-target-io-ssrf-D15.md', 'report'), 'D16': ('D16/SUBMISSION.md', 'report'),
                                 'D17': ('D17-redirect/REPORT.md', 'report'), 'D18': ('D18-x/EVIDENCE.md', 'evidence'),
                                 'D21': ('D21-x/REPORT.md', 'report')})

    def test_packet_files_are_never_read(self):
        self.assertEqual(set(self.reads), LISTED | META)
        self.assertFalse(set(self.reads) & set(PACKET_FILES))

    def test_incremental_refresh_switches_the_main(self):
        self.assertIn('D17-redirect/REPORT.md', {i['path'] for i in self.recent()['items']})
        (self.lane / 'reports/D17-redirect/example-com-open-redirect-D17.md').write_text('# New D17 report\n\nzebra new.\n')
        self.reads.clear()
        self.index.refresh()
        items = {i['path']: i for i in self.recent()['items']}
        self.assertIn('D17-redirect/example-com-open-redirect-D17.md', items)
        self.assertNotIn('D17-redirect/REPORT.md', items)
        self.assertEqual(items['D17-redirect/example-com-open-redirect-D17.md']['finding']['fid'], 'D17')
        self.assertEqual(self.reads, ['D17-redirect/example-com-open-redirect-D17.md'])
        hit = next(f for f in self.index.search('D17', kinds=('finding',))['results']['findings'] if f['fid'] == 'D17')
        self.assertEqual(hit['report']['path'], 'D17-redirect/example-com-open-redirect-D17.md')
        found = {r['path'] for r in self.index.search('zebra', limit=50, kinds=('report',))['results']['reports']}
        self.assertNotIn('D17-redirect/REPORT.md', found)
        # The lane list agrees.
        items = {i['path']: i for i in app.reports(self.lane, [], app.ledger(self.lane, []))}
        self.assertEqual((items['D17-redirect/REPORT.md']['kind'], items['D17-redirect/REPORT.md']['packet_main']),
                         ('packet_file', 'D17-redirect/example-com-open-redirect-D17.md'))

    def test_sidecar_edit_moves_the_row_without_adding_one(self):
        target = self.lane / 'reports/D16/SUBMISSION-D16.md'
        os.utime(target, (NOW + 5, NOW + 5))
        self.index.refresh()
        body = self.recent()
        self.assertEqual(body['items'][0]['path'], 'D16/SUBMISSION.md')
        self.assertEqual(body['items'][0]['updated_file'], 'SUBMISSION-D16.md')
        self.assertEqual(body['total'], len(LISTED))


class EndpointTests(Base):
    def setUp(self):
        super().setUp()
        self.server = app.make_server(self.root, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def get(self, endpoint, **query):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        conn.request('GET', endpoint + ('?' + urlencode(query) if query else ''),
                     headers={'Host': f'127.0.0.1:{self.server.server_port}'})
        response = conn.getresponse()
        body = json.loads(response.read() or b'null')
        conn.close()
        return response.status, body

    def test_membership_and_counts_agree(self):
        status, data = self.get('/api/data')
        self.assertEqual(status, 200)
        listed = {r['path'] for r in data['programs'][0]['lanes'][0]['reports'] if r['kind'] != 'packet_file'}
        self.assertEqual(listed, LISTED | META)
        instance = self.get('/api/data', phase='identity')[1]['root_instance']
        status, lane = self.get('/api/lane-reports', root_instance=instance, family=FAMILY, program=PROGRAM, lane=LANE)
        self.assertEqual(status, 200, lane)
        self.assertEqual({r['path'] for r in lane['reports'] if r['kind'] != 'packet_file'}, LISTED | META)
        self.assertEqual({r['path'] for r in lane['reports'] if r['kind'] == 'packet_file'}, set(PACKET_FILES))
        status, recent = self.get('/api/recent-reports', limit='100')
        self.assertEqual(status, 200, recent)
        self.assertEqual({i['path'] for i in recent['items']}, LISTED)
        self.assertEqual(recent['total'], len(LISTED))
        status, found = self.get('/api/search', q='zebra', limit='50')
        self.assertEqual(status, 200, found)
        self.assertEqual({r['path'] for r in found['results']['reports']}, LISTED)
        self.assertEqual(found['counts']['report'], len(LISTED))

    def test_packet_file_stays_readable(self):
        status, body = self.get('/api/report', family=FAMILY, program=PROGRAM, lane=LANE, path='D15-ssrf/SUBMISSION.md')
        self.assertEqual(status, 200)
        self.assertIn('D15 submission', body['content'])


class ModuleTests(unittest.TestCase):
    def test_both_indexes_use_the_shared_helper(self):
        import search_index
        self.assertIs(search_index.packet_plan, report_packets.plan)
        self.assertIn('from report_packets import', Path(app.__file__).read_text())


if __name__ == '__main__':
    unittest.main()
