"""Evidence files are artifacts, not reports (synthetic, disposable roots only).

Covers the shared classifier (report_evidence), app.reports() (/api/data and
/api/lane-reports), SearchIndex Recent and search exclusion with finding links,
and the artifacts panel listing EVIDENCE.md beside the submission report.
"""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

import app
import report_evidence
from report_evidence import is_evidence, recorded_paths, reports_relative
from tests.search_fixture import write_lane
from tests.test_search import make_index

FAMILY, PROGRAM, LANE = 'web_bounty', 'demo', 'web'
OTHER_HOST = f'/srv/elsewhere/{FAMILY}/{PROGRAM}/{LANE}'

FINDINGS = [
    # BBH packet: submission report plus EVIDENCE.md in one folder.
    {'fid': 'F01', 'title': 'Packet xss', 'severity': 'HIGH', 'class_name': 'xss', 'status': 'confirmed',
     'report_path': 'reports/F01-xss/demo-xss-F01.md', 'evidence_path': 'reports/F01-xss/EVIDENCE.md',
     'report_dir': 'reports/F01-xss'},
    # Evidence only, no submission report yet (absolute path on this host).
    {'fid': 'F02', 'title': 'Evidence only idor', 'severity': 'CRITICAL', 'class_name': 'idor', 'status': 'raw',
     'evidence_path': '<lane>/reports/F02-idor/EVIDENCE.md'},
    # evidence_path names a file with another name.
    {'fid': 'F04', 'title': 'Capture ssrf', 'severity': 'LOW', 'class_name': 'ssrf', 'status': 'raw',
     'evidence_path': 'reports/proof/F04-capture.md'},
    # A report_path that names EVIDENCE.md keeps it a report.
    {'fid': 'F05', 'title': 'Odd naming', 'severity': 'MEDIUM', 'class_name': 'xss', 'status': 'raw',
     'report_path': 'reports/F05/EVIDENCE.md'},
    # Absolute evidence_path recorded on another host, matched by its lane segment.
    {'fid': 'F07', 'title': 'Trace on other host', 'severity': 'INFO', 'class_name': 'info', 'status': 'raw',
     'evidence_path': OTHER_HOST + '/reports/proof/F07-trace.md'},
    # Absolute path with x/../ before reports/: both sides normalise before the lane-segment match.
    {'fid': 'F09', 'title': 'Dotted path on other host', 'severity': 'INFO', 'class_name': 'info', 'status': 'raw',
     'evidence_path': OTHER_HOST + '/x/../reports/proof/F09-notes.md'},
]
REPORTS = {
    'F01-xss/demo-xss-F01.md': '# Submission F01\n\nStored xss in the bio.\n',
    'F01-xss/EVIDENCE.md': '# Evidence F01\n\nRequest and response, word zebra.\n',
    'F01-xss/poc/request.txt': 'GET / HTTP/1.1\n',
    'F02-idor/EVIDENCE.md': '# Evidence F02\n\nzebra invoice ids.\n',
    'F03-loose/evidence.md': '# lower-case name, no owner\n\nzebra\n',
    'F03-loose/notes/deep/EVIDENCE.md': '# nested, no owner\n\nzebra\n',
    'proof/F04-capture.md': '# Capture F04\n\nzebra capture.\n',
    'proof/F07-trace.md': '# Trace F07\n\nzebra trace.\n',
    'proof/F09-notes.md': '# Notes F09\n\nzebra dotted.\n',
    'F05/EVIDENCE.md': '# Registered F05\n\nzebra but a real report.\n',
    'notes.md': '# Notes\n\nzebra notes.\n',
}
EVIDENCE = {'F01-xss/EVIDENCE.md', 'F02-idor/EVIDENCE.md', 'F03-loose/evidence.md',
            'F03-loose/notes/deep/EVIDENCE.md', 'proof/F04-capture.md', 'proof/F07-trace.md', 'proof/F09-notes.md'}
REPORT_FILES = {'F01-xss/demo-xss-F01.md', 'F05/EVIDENCE.md', 'notes.md'}


def build(root):
    lane = Path(root) / FAMILY / PROGRAM / LANE
    findings = [{**f, 'evidence_path': f['evidence_path'].replace('<lane>', str(lane))} if 'evidence_path' in f else f
                for f in FINDINGS]
    write_lane(root, FAMILY, PROGRAM, LANE, findings, REPORTS)
    return lane


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='evidence-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        self.root.mkdir()
        self.lane = build(self.root)


class ClassifierTests(unittest.TestCase):
    lane = Path('/data/root') / FAMILY / PROGRAM / LANE

    def test_recorded_paths_map_to_reports_relative(self):
        rel = lambda value: reports_relative(value, self.lane)
        self.assertEqual(rel('reports/F1/EVIDENCE.md'), 'F1/EVIDENCE.md')
        self.assertEqual(rel('./reports/a/../F1/EVIDENCE.md'), 'F1/EVIDENCE.md')
        self.assertEqual(rel(str(self.lane / 'reports/F1/EVIDENCE.md')), 'F1/EVIDENCE.md')
        self.assertEqual(rel(OTHER_HOST + '/reports/F1/EVIDENCE.md'), 'F1/EVIDENCE.md', 'other host, by lane segment')
        self.assertEqual(rel(OTHER_HOST + '/x/../reports/F1/EVIDENCE.md'), 'F1/EVIDENCE.md', 'normalised before the segment match')
        self.assertEqual(rel('/../' + OTHER_HOST.lstrip('/') + '/reports/F1/EVIDENCE.md'), 'F1/EVIDENCE.md', '.. above the root is clamped')
        for value in (None, '', '  ', 'notes/x.md', 'reports/../ledgers/x.md', 'reports/', '/elsewhere/x/reports/a.md',
                      f'/srv/{FAMILY}/other/{LANE}/reports/a.md', 'reports/a\0.md', 12):
            self.assertIsNone(rel(value), value)

    def test_is_evidence_rules(self):
        reports, evidence = recorded_paths([
            {'fid': 'A', 'report_path': 'reports/A/EVIDENCE.md'},
            {'fid': 'B', 'evidence_path': 'reports/B/capture.md'},
            {'fid': 'C', 'report_path': 'reports/C/report.md', 'evidence_path': 'reports/C/report.md'},
            'not a finding',
        ], self.lane)
        self.assertEqual(reports, {'A/EVIDENCE.md', 'C/report.md'})
        self.assertEqual(evidence, {'B/capture.md', 'C/report.md'})
        check = lambda path: is_evidence(path, reports, evidence)
        self.assertTrue(check('X/EVIDENCE.md'), 'unowned EVIDENCE.md')
        self.assertTrue(check('X/evidence.md'), 'case-insensitive')
        self.assertTrue(check('X/Evidence.MD'))
        self.assertTrue(check('X/deep/nested/EVIDENCE.md'), 'nested folder')
        self.assertTrue(check('EVIDENCE.md'), 'reports root')
        self.assertTrue(check('B/capture.md'), 'evidence_path only, another name')
        self.assertFalse(check('A/EVIDENCE.md'), 'a report_path named EVIDENCE.md stays a report')
        self.assertFalse(check('C/report.md'), 'report_path wins over evidence_path')
        self.assertFalse(check('X/EVIDENCE.md.bak.md'))
        self.assertFalse(check('X/notes.md'))


class LaneReportsTests(Base):
    def test_reports_skip_evidence_before_reading(self):
        findings = app.ledger(self.lane, [])
        read = []
        original = app.read_file

        def tracking(root, relative, **kw):
            read.append(relative)
            return original(root, relative, **kw)
        with mock.patch.object(app, 'read_file', tracking):
            items = app.reports(self.lane, [], findings)
        paths = {item['path'] for item in items}
        self.assertEqual(paths, REPORT_FILES)
        self.assertFalse(EVIDENCE & {r[len('reports/'):] for r in read}, 'evidence is never read')
        by_path = {item['path']: item for item in items}
        self.assertEqual((by_path['F05/EVIDENCE.md']['kind'], by_path['F05/EVIDENCE.md']['owner_fids']),
                         ('registered_report', ['F05']))
        self.assertEqual(by_path['F01-xss/demo-xss-F01.md']['kind'], 'registered_report')
        self.assertFalse(any(item['kind'] == 'generated_evidence' for item in items))

    def test_without_a_ledger_evidence_is_still_skipped_by_name(self):
        items = app.reports(self.lane, [], None)
        paths = {item['path'] for item in items}
        self.assertNotIn('F01-xss/EVIDENCE.md', paths)
        self.assertNotIn('F05/EVIDENCE.md', paths, 'no ledger: nothing names it as a report')
        self.assertIn('proof/F04-capture.md', paths, 'no ledger: no evidence_path to match')


class SearchIndexTests(Base):
    def setUp(self):
        super().setUp()
        self.index = make_index(self.root)
        self.addCleanup(self.index.close)

    def test_recent_and_search_exclude_evidence(self):
        self.index.refresh()
        recent = self.index.recent(limit=100, include_navigation=True)
        self.assertEqual({item['path'] for item in recent['items']}, REPORT_FILES)
        self.assertEqual(recent['total_reports'], len(REPORT_FILES))
        self.assertFalse(any(item['report_kind'] == 'generated_evidence' for item in recent['items']))
        hits = self.index.search('zebra', limit=50)
        self.assertEqual({r['path'] for r in hits['results']['reports']}, {'F05/EVIDENCE.md', 'notes.md'})
        self.assertEqual(hits['counts']['report'], 2)
        program = self.index.search('demo')['results']['programs'][0]
        self.assertEqual(program['report_count'], len(REPORT_FILES))

    def test_finding_hits_keep_matching_and_link_evidence(self):
        self.index.refresh()
        links = {}
        for query in ('F01', 'F02', 'F04', 'F05', 'F07', 'F09'):
            hit = self.index.search(query, kinds=('finding',))['results']['findings'][0]
            self.assertEqual(hit['fid'], query)
            links[query] = hit['report'] and (hit['report']['path'], hit['report']['kind'], hit['report']['target'])
        target = lambda path: {'program': f'{FAMILY}/{PROGRAM}', 'lane': LANE, 'section': 'reports', 'report': path}
        self.assertEqual(links['F01'], ('F01-xss/demo-xss-F01.md', 'report', target('F01-xss/demo-xss-F01.md')))
        self.assertEqual(links['F02'], ('F02-idor/EVIDENCE.md', 'evidence', target('F02-idor/EVIDENCE.md')))
        self.assertEqual(links['F04'], ('proof/F04-capture.md', 'evidence', target('proof/F04-capture.md')))
        self.assertEqual(links['F05'], ('F05/EVIDENCE.md', 'report', target('F05/EVIDENCE.md')))
        self.assertEqual(links['F07'], ('proof/F07-trace.md', 'evidence', target('proof/F07-trace.md')))
        self.assertEqual(links['F09'], ('proof/F09-notes.md', 'evidence', target('proof/F09-notes.md')))
        self.assertEqual(self.index.search('Evidence only idor')['results']['findings'][0]['report']['title'], 'Evidence')

    def test_evidence_costs_no_read_or_budget(self):
        read = []

        def tracking(root, relative, **kw):
            read.append(relative)
            return app.read_file(root, relative, **kw)
        self.index._read_file = tracking
        self.index.refresh()
        self.assertFalse(EVIDENCE & {r.split('/reports/', 1)[-1] for r in read if '/reports/' in r or r.startswith('reports/')})
        self.assertEqual(self.index._report_count, len(REPORT_FILES))

    def test_a_new_evidence_file_never_appears(self):
        self.index.refresh()
        (self.lane / 'reports/F09-new').mkdir()
        (self.lane / 'reports/F09-new/EVIDENCE.md').write_text('# New evidence\n')
        self.index.refresh()
        self.assertNotIn('F09-new/EVIDENCE.md', {i['path'] for i in self.index.recent(limit=100)['items']})


class EndpointTests(Base):
    def setUp(self):
        super().setUp()
        self.server = app.make_server(self.root, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def get(self, endpoint, **query):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        conn.request("GET", endpoint + ("?" + urlencode(query) if query else ""),
                     headers={'Host': f'127.0.0.1:{self.server.server_port}'})
        response = conn.getresponse()
        body = json.loads(response.read() or b'null')
        conn.close()
        return response.status, body

    def test_api_lists_exclude_evidence(self):
        status, data = self.get('/api/data')
        self.assertEqual(status, 200)
        self.assertEqual({r['path'] for r in data['programs'][0]['lanes'][0]['reports']}, REPORT_FILES)
        instance = self.get('/api/data', phase='identity')[1]['root_instance']
        status, lane = self.get('/api/lane-reports', root_instance=instance, family=FAMILY, program=PROGRAM, lane=LANE)
        self.assertEqual(status, 200, lane)
        self.assertEqual({r['path'] for r in lane['reports']}, REPORT_FILES)
        status, recent = self.get('/api/recent-reports', limit='100')
        self.assertEqual(status, 200, recent)
        self.assertEqual({i['path'] for i in recent['items']}, REPORT_FILES)
        status, found = self.get('/api/search', q='zebra')
        self.assertEqual(status, 200, found)
        self.assertFalse(EVIDENCE & {r['path'] for r in found['results']['reports']})

    def test_evidence_content_and_artifacts_stay_available(self):
        status, body = self.get('/api/report', family=FAMILY, program=PROGRAM, lane=LANE, path='F01-xss/EVIDENCE.md')
        self.assertEqual(status, 200)
        self.assertIn('Evidence F01', body['content'])
        # The submission report's artifacts panel lists EVIDENCE.md (folder rule).
        status, listing = self.get('/api/report-artifacts', family=FAMILY, program=PROGRAM, lane=LANE,
                                   path='F01-xss/demo-xss-F01.md')
        self.assertEqual(status, 200, listing)
        names = {a['relative']: a for a in listing['artifacts']}
        self.assertEqual(names['reports/F01-xss/EVIDENCE.md']['source_reason'], 'report_folder')
        self.assertEqual(names['reports/F01-xss/EVIDENCE.md']['category'], 'data')
        self.assertIn('reports/F01-xss/poc/request.txt', names)
        # The evidence view's own panel (path = EVIDENCE.md) lists the folder's other files.
        status, listing = self.get('/api/report-artifacts', family=FAMILY, program=PROGRAM, lane=LANE,
                                   path='F01-xss/EVIDENCE.md')
        self.assertEqual(status, 200, listing)
        listed = {a['relative'] for a in listing['artifacts']}
        self.assertEqual(listed, {'reports/F01-xss/demo-xss-F01.md', 'reports/F01-xss/poc/request.txt'})


class ModuleTests(unittest.TestCase):
    def test_both_indexes_import_the_shared_classifier(self):
        import search_index
        self.assertIs(search_index.is_evidence, report_evidence.is_evidence)
        source = Path(app.__file__).read_text()
        self.assertIn('from report_evidence import is_evidence, recorded_paths', source)


if __name__ == '__main__':
    unittest.main()
