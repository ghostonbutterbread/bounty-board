"""Synthetic tests for report artifact listing and downloads (disposable roots)."""
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app  # noqa: E402
import report_artifacts as ra  # noqa: E402
from report_artifacts_fixture import LANE, build  # noqa: E402

SELECT = {'family': 'web_bounty', 'program': 'alpha', 'lane': 'web'}


class Fixture(unittest.TestCase):
    live = False

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='artifacts-')
        self.addCleanup(self.tmp.cleanup)
        top = Path(self.tmp.name)
        self.root = top / 'root'
        self.lane = build(self.root)
        options = {'live_edit_dir': top / 'live-state'} if self.live else {}
        self.server = app.make_server(self.root, port=0, **options)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def get(self, endpoint, path='F1/REPORT.md', headers=None, raw_query=None, **extra):
        query = raw_query if raw_query is not None else urlencode({**SELECT, 'path': path, **extra})
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('GET', f'{endpoint}?{query}', headers={'Host': f'127.0.0.1:{self.port}', **(headers or {})})
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, dict(response.getheaders()), body

    def listing(self, path='F1/REPORT.md'):
        status, _, body = self.get('/api/report-artifacts', path)
        self.assertEqual(status, 200, body)
        return json.loads(body)


class AssociationTests(Fixture):
    def test_dedicated_folder_from_ledger_report_dir(self):
        data = self.listing()
        names = {a['relative']: a for a in data['artifacts']}
        self.assertEqual(data['folder'], 'reports/F1')
        for expected in ('reports/F1/poc/demo.mp4', 'reports/F1/poc/exploit.py', 'reports/F1/poc/payload.js',
                         'reports/F1/evidence/screenshot.png', 'reports/F1/evidence/diagram.svg',
                         'reports/F1/evidence/page.html', 'reports/F1/EVIDENCE.md'):
            self.assertEqual(names[expected]['source_reason'], 'report_folder', expected)
        self.assertEqual(names['reports/F1/poc/demo.mp4']['display_path'], 'poc/demo.mp4')
        self.assertEqual([r['reason'] for r in names['reports/F1/poc/demo.mp4']['reasons']], ['report_folder', 'report_link'])
        # Finding field and Markdown link outside the folder but inside the lane.
        self.assertEqual(names['evidence/F1-replay.js']['reasons'], [{'reason': 'finding_field', 'detail': 'poc of finding F1'}])
        self.assertEqual(names['evidence/shared-shot.png']['source_reason'], 'report_link')

    def test_skips_report_itself_hidden_meta_cache_and_symlinks(self):
        listed = {a['relative'] for a in self.listing()['artifacts']}
        for skipped in ('reports/F1/REPORT.md', 'reports/F1/.hidden', 'reports/F1/_meta/state.json',
                        'reports/F1/__pycache__/exploit.cpython-314.pyc', 'reports/F1/evidence/escape.txt'):
            self.assertNotIn(skipped, listed)
        self.assertFalse(any('linkdir' in item or 'outside' in item or 'beta' in item for item in listed))
        self.assertFalse(any(item.startswith('ledgers/') for item in listed))

    def test_flat_shared_folder_never_lists_sibling_reports_files(self):
        f2 = self.listing('findings/confirmed/F2 - HIGH - sample.md')
        self.assertIsNone(f2['folder'])
        self.assertIn('folder_shared', f2['notes'])
        self.assertEqual([a['relative'] for a in f2['artifacts']], ['reports/findings/confirmed/F2-log.txt'])
        f3 = self.listing('findings/confirmed/F3 - LOW - other.md')
        self.assertEqual(f3['artifacts'], [])

    def test_marker_folder_without_ledger_and_loose_folder(self):
        d04 = self.listing('D04/REPORT.md')
        self.assertEqual(d04['folder'], 'reports/D04')
        self.assertEqual([a['relative'] for a in d04['artifacts']], ['reports/D04/poc.py'])
        loose = self.listing('loose/notes.md')
        self.assertIsNone(loose['folder'])
        self.assertEqual(loose['artifacts'], [])
        self.assertIn('folder_not_dedicated', loose['notes'])

    def test_metadata_categories_sensitive_and_preview(self):
        items = {a['name']: a for a in self.listing()['artifacts']}
        self.assertEqual(items['demo.mp4']['category'], 'video')
        self.assertEqual(items['demo.mp4']['preview'], 'video')
        self.assertEqual(items['screenshot.png']['preview'], 'image')
        self.assertEqual(items['diagram.svg']['preview'], 'text')  # escaped text, never inline image
        self.assertEqual(items['capture.har']['sensitive'], True)
        self.assertIsNone(items['capture.har']['preview'])
        self.assertEqual(items['exploit.py']['size'], len('print("synthetic proof of concept")\n'))
        self.assertIsInstance(items['exploit.py']['modified'], int)

    def test_unregistered_markdown_in_a_findings_folder_uses_that_folder(self):
        (self.lane / 'reports/F1/SUBMISSION.md').write_text('# Draft submission\n')
        listing = self.listing('F1/SUBMISSION.md')
        self.assertEqual(listing['folder'], 'reports/F1')
        names = {a['relative'] for a in listing['artifacts']}
        self.assertIn('reports/F1/REPORT.md', names)
        self.assertIn('evidence/F1-replay.js', names)  # owner's finding fields apply too
        self.assertNotIn('reports/F1/SUBMISSION.md', names)

    def test_shared_report_dir_claimed_by_other_finding_is_skipped(self):
        ledger = self.lane / 'ledgers/ledger.json'
        data = json.loads(ledger.read_text())
        data['findings'].append({'fid': 'F9', 'report_dir': 'reports/F1'})
        ledger.write_text(json.dumps(data))
        listing = self.listing()
        self.assertIsNone(listing['folder'])
        self.assertIn('folder_shared', listing['notes'])
        self.assertEqual({a['source_reason'] for a in listing['artifacts']}, {'finding_field', 'report_link'})

    def test_recorded_paths(self):
        rel = lambda value: ra.recorded_relative(value, 'web_bounty', 'alpha', 'web')
        for value in ('Send the request twice and compare.', '/etc/hostname', '/x/web_bounty/beta/web/reports/a.md',
                      'https://example.invalid/a.js', '../outside-secret.txt', '', None, 42):
            self.assertIsNone(rel(value), value)
        self.assertEqual(rel('/a/b/web_bounty/alpha/web/reports/F1'), 'reports/F1')
        self.assertEqual(rel('reports/F1/./poc/../poc/x.py'), 'reports/F1/poc/x.py')

    def test_list_cap(self):
        many = self.lane / 'reports/F1/poc/many'
        many.mkdir()
        for index in range(ra.MAX_LISTED + 20):
            (many / f'{index:04}.txt').write_text('x')
        listing = self.listing()
        self.assertEqual(len(listing['artifacts']), ra.MAX_LISTED)
        self.assertIn('truncated', listing['notes'])


class DownloadTests(Fixture):
    def test_download_headers_are_attachment_and_inert(self):
        for artifact in ('reports/F1/evidence/diagram.svg', 'reports/F1/evidence/page.html',
                         'reports/F1/poc/payload.js', 'reports/F1/poc/exploit.py', 'reports/F1/poc/demo.mp4'):
            status, headers, body = self.get('/api/report-artifact', artifact=artifact)
            self.assertEqual(status, 200, artifact)
            self.assertEqual(headers['Content-Type'], 'application/octet-stream')
            self.assertTrue(headers['Content-Disposition'].startswith('attachment; filename="'))
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(headers['Content-Security-Policy'], "sandbox; default-src 'none'")
            self.assertEqual(headers['Cross-Origin-Resource-Policy'], 'same-origin')
            self.assertEqual(body, (self.lane / artifact).read_bytes())

    def test_unicode_filename_uses_rfc5987(self):
        odd = self.lane / 'reports/F1/poc/démo "x";.py'
        odd.write_text('print(1)\n')
        status, headers, _ = self.get('/api/report-artifact', artifact='reports/F1/poc/' + odd.name)
        self.assertEqual(status, 200)
        disposition = headers['Content-Disposition']
        self.assertIn('filename="d_mo__x__.py"', disposition)
        self.assertIn("filename*=UTF-8''d%C3%A9mo%20%22x%22%3B.py", disposition)

    def test_media_only_for_raster_images_and_media(self):
        status, headers, _ = self.get('/api/report-artifact-media', artifact='reports/F1/evidence/screenshot.png')
        self.assertEqual((status, headers['Content-Type']), (200, 'image/png'))
        self.assertTrue(headers['Content-Disposition'].startswith('inline;'))
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        for artifact in ('reports/F1/evidence/diagram.svg', 'reports/F1/evidence/page.html',
                         'reports/F1/poc/payload.js', 'reports/F1/evidence/capture.har'):
            status, _, _ = self.get('/api/report-artifact-media', artifact=artifact)
            self.assertEqual(status, 415, artifact)

    def test_range_requests(self):
        artifact = 'reports/F1/evidence/notes.txt'
        data = (self.lane / artifact).read_bytes()
        status, headers, body = self.get('/api/report-artifact', artifact=artifact, headers={'Range': 'bytes=10-19'})
        self.assertEqual((status, body, headers['Content-Range']), (206, data[10:20], f'bytes 10-19/{len(data)}'))
        status, _, body = self.get('/api/report-artifact', artifact=artifact, headers={'Range': 'bytes=-5'})
        self.assertEqual((status, body), (206, data[-5:]))
        status, _, body = self.get('/api/report-artifact', artifact=artifact, headers={'Range': f'bytes={len(data) - 3}-'})
        self.assertEqual((status, body), (206, data[-3:]))
        status, headers, _ = self.get('/api/report-artifact', artifact=artifact, headers={'Range': f'bytes={len(data)}-'})
        self.assertEqual((status, headers['Content-Range']), (416, f'bytes */{len(data)}'))
        status, _, body = self.get('/api/report-artifact', artifact=artifact, headers={'Range': 'bytes=0-1,5-6'})
        self.assertEqual((status, body), (200, data))
        status, headers, body = self.get('/api/report-artifact-media', artifact='reports/F1/poc/demo.mp4', headers={'Range': 'bytes=0-15'})
        self.assertEqual((status, len(body), headers['Content-Type']), (206, 16, 'video/mp4'))

    def test_traversal_and_unassociated_paths_are_refused(self):
        for artifact in ('../../../outside-secret.txt', 'reports/F1/../../ledgers/ledger.json', '/etc/hostname',
                         'ledgers/ledger.json', 'reports/F1/REPORT.md', 'reports/F1/_meta/state.json',
                         'reports/F1/.hidden', 'reports/findings/confirmed/F3-notes.txt', 'reports//F1/poc/exploit.py',
                         'reports/F1/evidence/escape.txt', 'reports/F1/evidence/linkdir/outside-secret.txt'):
            status, _, body = self.get('/api/report-artifact', artifact=artifact)
            self.assertEqual(status, 404, artifact)
            self.assertNotIn(b'outside the lane', body)
        # F3 notes are not linked to F2 even though they share a folder.
        status, _, _ = self.get('/api/report-artifact', path='findings/confirmed/F2 - HIGH - sample.md',
                                artifact='reports/findings/confirmed/F3-notes.txt')
        self.assertEqual(status, 404)

    def test_invalid_selectors(self):
        cases = [{'path': '../ledgers/ledger.json'}, {'path': 'F1/REPORT.txt'}, {'program': '../alpha'},
                 {'program': '_hidden'}, {'lane': 'apk'}, {'family': 'other'}, {'extra': '1'}]
        for case in cases:
            status, _, _ = self.get('/api/report-artifacts', raw_query=urlencode({**SELECT, 'path': 'F1/REPORT.md', **case}))
            self.assertEqual(status, 404, case)
        status, _, _ = self.get('/api/report-artifacts', raw_query=urlencode(SELECT))
        self.assertEqual(status, 404)
        status, _, _ = self.get('/api/report-artifact', raw_query=urlencode({**SELECT, 'path': 'F1/REPORT.md'}))
        self.assertEqual(status, 404)

    def test_symlinked_lane_component_is_refused(self):
        os.symlink(self.root / 'web_bounty/alpha', self.root / 'web_bounty/alias')
        status, _, _ = self.get('/api/report-artifacts', raw_query=urlencode({**SELECT, 'program': 'alias', 'path': 'F1/REPORT.md'}))
        self.assertEqual(status, 404)

    def test_file_swapped_for_symlink_after_listing_is_refused(self):
        target = self.lane / 'reports/F1/poc/exploit.py'
        self.listing()
        target.unlink()
        os.symlink(self.root / 'outside-secret.txt', target)
        status, _, body = self.get('/api/report-artifact', artifact='reports/F1/poc/exploit.py')
        self.assertEqual(status, 404)
        self.assertNotIn(b'outside the lane', body)

    def test_cross_site_and_foreign_host_requests_are_refused(self):
        status, _, _ = self.get('/api/report-artifact', artifact='reports/F1/poc/exploit.py', headers={'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(status, 403)
        status, _, _ = self.get('/api/report-artifact', artifact='reports/F1/poc/exploit.py', headers={'Host': 'evil.example'})
        self.assertEqual(status, 403)

    def test_zip_excludes_sensitive_and_matches_listing(self):
        status, headers, body = self.get('/api/report-artifacts.zip')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/zip')
        self.assertTrue(headers['Content-Disposition'].startswith('attachment; filename="F1-artifacts.zip"'))
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        archive = zipfile.ZipFile(io.BytesIO(body))
        self.assertIsNone(archive.testzip())
        listed = {a['relative'] for a in self.listing()['artifacts'] if not a['sensitive']}
        self.assertEqual(set(archive.namelist()), listed)
        self.assertNotIn('reports/F1/evidence/capture.har', archive.namelist())
        self.assertEqual(archive.read('reports/F1/poc/exploit.py'), (self.lane / 'reports/F1/poc/exploit.py').read_bytes())

    def test_zip_size_cap(self):
        original = ra.MAX_ZIP_BYTES
        ra.MAX_ZIP_BYTES = 1000
        self.addCleanup(setattr, ra, 'MAX_ZIP_BYTES', original)
        status, _, body = self.get('/api/report-artifacts.zip')
        self.assertEqual((status, json.loads(body)['error']), (413, 'archive_too_large'))
        status, _, _ = self.get('/api/report-artifacts.zip', path='findings/confirmed/F3 - LOW - other.md')
        self.assertEqual(status, 404)

    def test_root_instance_binding(self):
        status, _, _ = self.get('/api/report-artifacts', root_instance='0' * 64)
        self.assertEqual(status, 409)


class LiveModeTests(Fixture):
    live = True

    def test_artifacts_available_with_live_editing(self):
        status, _, body = self.get('/api/data')
        self.assertTrue(json.loads(body)['capabilities']['live_edit'])
        self.assertEqual(self.listing()['folder'], 'reports/F1')


class UnitTests(unittest.TestCase):
    def test_parse_range(self):
        self.assertIsNone(ra.parse_range(None, 10))
        self.assertEqual(ra.parse_range('bytes=0-', 10), (0, 9))
        self.assertEqual(ra.parse_range('bytes=2-100', 10), (2, 9))
        self.assertEqual(ra.parse_range('bytes=-3', 10), (7, 9))
        for header in ('bytes=5-2', 'bytes=10-', 'bytes=-0', 'items=0-1', 'bytes=-'):
            self.assertEqual(ra.parse_range(header, 10), 'invalid', header)
        self.assertEqual(ra.parse_range('bytes=0-', 0), 'invalid')

    def test_markdown_targets(self):
        text = ('[a](poc/x.py) ![b](<shot one.png>) [c](https://e.invalid/x) [d](#top) [e](y.js#L3 "t") '
                '[f](//e.invalid/z) [g](a%20b.txt?raw=1)\n[ref]: ../z.mp4\n')
        self.assertEqual(ra.markdown_targets(text), ['poc/x.py', 'shot one.png', 'y.js', 'a b.txt', '../z.mp4'])

    def test_sensitive_names(self):
        for name in ('capture.har', 'cookies.json', '.env', 'prod.env', 'api_key.txt', 'req.hdr', 'id_rsa',
                     '.netrc', '.npmrc', '.pgpass', '.NETRC'):
            self.assertTrue(ra.sensitive(name), name)
        for name in ('exploit.py', 'oauth-bypass.mp4', 'token-screenshot.png', 'environment.md'):
            self.assertFalse(ra.sensitive(name), name)


if __name__ == '__main__':
    unittest.main()
