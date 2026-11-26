"""Synthetic tests for report artifact uploads (disposable roots only)."""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402
import artifact_uploads as au  # noqa: E402
from tests import report_artifacts_fixture as fixture  # noqa: E402

SELECT = {'family': 'web_bounty', 'program': 'alpha', 'lane': 'web'}
F1 = 'F1/REPORT.md'


def tree(root):
    """Every path under root with size (symlinks not followed)."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            path = Path(dirpath) / name
            out[str(path.relative_to(root))] = None if path.is_dir() and not path.is_symlink() else path.lstat().st_size
    return out


class Fixture(unittest.TestCase):
    enabled = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='uploads-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        self.lane = fixture.build(self.root)
        (self.lane / 'reports/ROOT.md').write_text('# flat root report\n')
        self.folder = self.lane / 'reports/F1'
        self.server = app.make_server(self.root, port=0, artifact_uploads=self.enabled)
        if self.enabled:
            self.server.artifact_uploads = au.Uploads(free_floor=0)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    @property
    def origin(self):
        return f'http://127.0.0.1:{self.port}'

    def raw(self, method, target, headers, body=b'', shutdown=False, timeout=10):
        """Send a hand-built request; return (status, headers, body, closed)."""
        lines = [f'{method} {target} HTTP/1.1', f'Host: 127.0.0.1:{self.port}']
        lines += [f'{k}: {v}' for k, v in headers]
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=timeout)
        try:
            sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('utf-8') + body)
            if shutdown:
                sock.shutdown(socket.SHUT_WR)
            data = b''
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
        finally:
            sock.close()
        head, _, payload = data.partition(b'\r\n\r\n')
        status_line, *header_lines = head.decode('latin-1').split('\r\n')
        parsed = {}
        for line in header_lines:
            key, _, value = line.partition(':')
            parsed[key.strip().lower()] = value.strip()
        return int(status_line.split()[1]), parsed, payload, True

    def upload(self, name, data, path=F1, headers=None, query=None, **extra):
        target = '/api/report-artifact-upload?' + (query if query is not None else urlencode({**SELECT, 'path': path, 'name': name, **extra}))
        base = {'Origin': self.origin, 'X-Requested-With': 'Bounty-Board', 'Content-Type': 'application/octet-stream',
                'Content-Length': str(len(data)), 'Sec-Fetch-Site': 'same-origin'}
        if headers is not None:
            items = headers(base)
        else:
            items = list(base.items())
        status, response_headers, body, _ = self.raw('POST', target, items, data)
        return status, response_headers, json.loads(body) if body else None

    def listing(self, path=F1):
        status, _, body, _ = self.raw('GET', '/api/report-artifacts?' + urlencode({**SELECT, 'path': path}), [])
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def download(self, relative, path=F1):
        status, _, body, _ = self.raw('GET', '/api/report-artifact?' + urlencode({**SELECT, 'path': path, 'artifact': relative}), [])
        self.assertEqual(status, 200)
        return body

    def staged(self):
        return [p for p in self.root.rglob('*') if p.name.startswith('.syncthing.board-')]


class DisabledTests(Fixture):
    enabled = False

    def test_flag_off_refuses_and_list_says_disabled(self):
        status, headers, body = self.upload('a.txt', b'x')
        self.assertEqual((status, body), (404, {'error': 'uploads_disabled'}))
        self.assertEqual(headers.get('connection'), 'close')
        self.assertFalse((self.folder / 'a.txt').exists())
        self.assertEqual(self.listing()['upload'], {'enabled': False, 'reason': 'disabled', 'max_bytes': None})
        status, _, body, _ = self.raw('GET', '/api/data', [])
        self.assertFalse(json.loads(body)['capabilities']['artifact_uploads'])


class GateTests(Fixture):
    def test_capability_and_list_state(self):
        status, _, body, _ = self.raw('GET', '/api/data', [])
        self.assertTrue(json.loads(body)['capabilities']['artifact_uploads'])
        self.assertEqual(self.listing()['upload'], {'enabled': True, 'reason': None, 'max_bytes': au.MAX_UPLOAD_BYTES})
        self.assertEqual(self.listing('loose/notes.md')['upload']['reason'], 'no_report_folder')

    def test_each_gate_refusal(self):
        def without(key):
            return lambda base: [(k, v) for k, v in base.items() if k != key]

        def replace(key, value):
            return lambda base: [(k, value if k == key else v) for k, v in base.items()]

        def plus(key, value):
            return lambda base: list(base.items()) + [(key, value)]
        cases = {
            'no origin': without('Origin'),
            'foreign origin': replace('Origin', 'https://evil.example'),
            'cross-site fetch': replace('Sec-Fetch-Site', 'cross-site'),
            'same-site fetch': replace('Sec-Fetch-Site', 'same-site'),
            'missing requested-with': without('X-Requested-With'),
            'wrong requested-with': replace('X-Requested-With', 'XMLHttpRequest'),
            'duplicate requested-with': plus('X-Requested-With', 'Bounty-Board'),
            'wrong content type': replace('Content-Type', 'multipart/form-data; boundary=x'),
            'json content type': replace('Content-Type', 'application/json'),
            'missing content type': without('Content-Type'),
            'transfer encoding': plus('Transfer-Encoding', 'chunked'),
            'missing length': without('Content-Length'),
            'bad length': replace('Content-Length', '4x'),
            'signed length': replace('Content-Length', '+4'),
            'duplicate length': plus('Content-Length', '4'),
        }
        for label, headers in cases.items():
            with self.subTest(label):
                status, response_headers, body = self.upload('gate.txt', b'data', headers=headers)
                self.assertEqual((status, body), (403, {'error': 'untrusted_origin'}))
                self.assertEqual(response_headers.get('connection'), 'close')
        self.assertFalse((self.folder / 'gate.txt').exists())
        self.assertEqual(self.staged(), [])

    def test_foreign_host_is_refused(self):
        status, _, body, _ = self.raw('POST', '/api/report-artifact-upload?' + urlencode({**SELECT, 'path': F1, 'name': 'h.txt'}),
                                      [('Origin', 'http://evil.example'), ('X-Requested-With', 'Bounty-Board'),
                                       ('Content-Type', 'application/octet-stream'), ('Content-Length', '1')], b'x')
        self.assertEqual(status, 403)

    def test_too_large_is_refused_before_reading_the_body(self):
        target = '/api/report-artifact-upload?' + urlencode({**SELECT, 'path': F1, 'name': 'big.mp4'})
        started = time.monotonic()
        # No body is sent at all: a server that tried to read it would hang until the timeout.
        status, headers, body, closed = self.raw('POST', target, [
            ('Origin', self.origin), ('X-Requested-With', 'Bounty-Board'), ('Content-Type', 'application/octet-stream'),
            ('Content-Length', str(au.MAX_UPLOAD_BYTES + 1))], timeout=5)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body), {'error': 'too_large', 'max_bytes': au.MAX_UPLOAD_BYTES})
        self.assertEqual(headers.get('connection'), 'close')
        self.assertTrue(closed)
        self.assertFalse((self.folder / 'big.mp4').exists())

    def test_invalid_selectors(self):
        for query in (urlencode({**SELECT, 'path': F1}),  # no name
                      urlencode({**SELECT, 'path': F1, 'name': 'a', 'extra': '1'}),
                      urlencode({**SELECT, 'path': F1, 'name': 'a'}) + '&name=b',
                      urlencode({**SELECT, 'program': '..', 'path': F1, 'name': 'a'}),
                      urlencode({**SELECT, 'family': 'nope', 'path': F1, 'name': 'a'}),
                      urlencode({**SELECT, 'path': '../F1/REPORT.md', 'name': 'a'}),
                      urlencode({**SELECT, 'path': 'F1/missing.md', 'name': 'a'})):
            with self.subTest(query):
                status, _, body = self.upload('a', b'x', query=query)
                self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))

    def test_root_instance_mismatch(self):
        status, _, body = self.upload('r.txt', b'x', root_instance='0' * 64)
        self.assertEqual((status, body), (409, {'error': 'root_changed'}))
        status, _, body, _ = self.raw('GET', '/api/data?phase=identity', [])
        instance = json.loads(body)['root_instance']
        status, _, body = self.upload('r.txt', b'x', root_instance=instance)
        self.assertEqual(status, 201, body)

    def test_busy(self):
        slots = self.server.artifact_uploads.slots
        slots.acquire(); slots.acquire()
        try:
            status, headers, body = self.upload('busy.txt', b'x')
        finally:
            slots.release(); slots.release()
        self.assertEqual((status, body), (503, {'error': 'uploads_busy'}))
        self.assertEqual(headers.get('retry-after'), '2')
        self.assertFalse((self.folder / 'busy.txt').exists())

    def test_insufficient_storage(self):
        with mock.patch.object(au, 'free_bytes', return_value=5):
            status, _, body = self.upload('space.txt', b'x' * 10)
        self.assertEqual((status, body), (507, {'error': 'insufficient_storage'}))
        self.server.artifact_uploads.free_floor = 990
        with mock.patch.object(au, 'free_bytes', return_value=1000):
            self.assertEqual(self.upload('space.txt', b'x' * 11)[0], 507)
            self.assertEqual(self.upload('space.txt', b'x' * 10)[0], 201)
        self.assertEqual(self.staged(), [])

    def test_default_floor_is_one_gib(self):
        self.assertEqual(au.Uploads().free_floor, 1024 ** 3)
        self.assertEqual(au.MAX_UPLOAD_BYTES, 512 * 1024 ** 2)


class NoFolderTests(Fixture):
    def test_flat_root_non_dedicated_and_shared_reports_are_refused(self):
        before = tree(self.root)
        for path, note in (('ROOT.md', 'flat_reports_root'), ('loose/notes.md', 'folder_not_dedicated'),
                           ('findings/confirmed/F2 - HIGH - sample.md', 'folder_shared')):
            with self.subTest(path):
                status, _, body = self.upload('x.txt', b'data', path=path)
                self.assertEqual((status, body), (409, {'error': 'no_report_folder', 'note': note}))
                self.assertEqual(self.listing(path)['upload']['reason'], 'no_report_folder')
        self.assertEqual(tree(self.root), before)

    def test_symlinked_report_folder_is_refused(self):
        real = self.lane / 'elsewhere'
        real.mkdir()
        (real / 'REPORT.md').write_text('# s\n')
        os.symlink(real, self.lane / 'reports/S1')
        ledger = json.loads((self.lane / 'ledgers/ledger.json').read_text())
        ledger['findings'].append({'fid': 'S1', 'report_path': 'reports/S1/REPORT.md', 'report_dir': 'reports/S1'})
        (self.lane / 'ledgers/ledger.json').write_text(json.dumps(ledger))
        status, _, _ = self.upload('x.txt', b'data', path='S1/REPORT.md')
        self.assertIn(status, (404, 409))
        self.assertEqual(sorted(p.name for p in real.iterdir()), ['REPORT.md'])

    def test_symlinked_subfolder_is_not_followed(self):
        # The ledger's report_dir is a symlink below the report: the marker
        # folder is used instead and the link target stays untouched.
        real = self.lane / 'elsewhere'
        real.mkdir()
        (self.lane / 'reports/S2').mkdir()
        (self.lane / 'reports/S2/REPORT.md').write_text('# s2\n')
        os.symlink(real, self.lane / 'reports/S2/poc')
        status, _, body = self.upload('x.txt', b'data', path='S2/REPORT.md')
        self.assertEqual(status, 201, body)
        self.assertEqual(body['artifact']['relative'], 'reports/S2/x.txt')
        self.assertEqual(list(real.iterdir()), [])

    def test_folder_swapped_for_symlink_after_association_is_refused(self):
        real = self.lane / 'elsewhere'
        real.mkdir()
        os.symlink(real, self.lane / 'reports/LINK')
        original = au.ra.associate

        def swapped(*args, **kwargs):
            return {**original(*args, **kwargs), 'folder': 'reports/LINK'}
        with mock.patch.object(au.ra, 'associate', side_effect=swapped):
            status, _, body = self.upload('x.txt', b'data')
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertEqual(list(real.iterdir()), [])

    def test_symlinked_lane_component_is_refused(self):
        program = self.root / 'web_bounty/alpha'
        moved = self.root / 'web_bounty/alpha-real'
        program.rename(moved)
        os.symlink(moved, program)
        status, _, body = self.upload('x.txt', b'data')
        self.assertEqual((status, body), (404, {'error': 'artifact_not_found_or_unavailable'}))
        self.assertFalse((moved / 'web/reports/F1/x.txt').exists())


class StoreTests(Fixture):
    def test_success_entry_matches_listing_and_downloads_identical(self):
        data = os.urandom(200_000)
        before = tree(self.root)
        status, _, body = self.upload('../../evil/../shot.png', data)
        self.assertEqual(status, 201, body)
        self.assertEqual((body['renamed'], body['requested_name']), (False, 'shot.png'))
        listed = {a['relative']: a for a in self.listing()['artifacts']}
        self.assertEqual(body['artifact'], listed['reports/F1/shot.png'])
        self.assertEqual(body['artifact']['source_reason'], 'report_folder')
        self.assertEqual(self.download('reports/F1/shot.png'), data)
        after = tree(self.root)
        self.assertEqual(set(after) - set(before), {str(Path(fixture.LANE) / 'reports/F1/shot.png')})
        self.assertEqual({k: v for k, v in after.items() if k in before}, before)
        self.assertEqual(self.staged(), [])
        mode = (self.folder / 'shot.png').stat().st_mode & 0o777
        umask = os.umask(0); os.umask(umask)
        self.assertEqual(mode, 0o666 & ~umask)
        self.assertNotEqual(mode, 0o600)

    def test_empty_file(self):
        status, _, body = self.upload('empty.txt', b'')
        self.assertEqual(status, 201, body)
        self.assertEqual((self.folder / 'empty.txt').read_bytes(), b'')

    def test_collisions_rename_including_case_insensitive(self):
        (self.folder / 'shot.png').write_bytes(b'original')
        status, _, body = self.upload('Shot.PNG', b'new')
        self.assertEqual(status, 201)
        self.assertEqual((body['renamed'], body['requested_name'], body['artifact']['name']), (True, 'Shot.PNG', 'Shot-2.PNG'))
        status, _, body = self.upload('shot.png', b'third')
        self.assertEqual(body['artifact']['name'], 'shot-3.png')
        self.assertEqual((self.folder / 'shot.png').read_bytes(), b'original')
        self.assertEqual((self.folder / 'Shot-2.PNG').read_bytes(), b'new')
        # Existing report files are never replaced either.
        status, _, body = self.upload('report.md', b'not a report')
        self.assertEqual(body['artifact']['name'], 'report-2.md')
        self.assertTrue((self.folder / 'REPORT.md').read_text().startswith('# Synthetic finding F1'))

    def test_concurrent_same_name_uploads_are_both_kept(self):
        results = []
        payloads = [os.urandom(300_000), os.urandom(300_000)]
        barrier = threading.Barrier(2)

        def send(data):
            barrier.wait()
            results.append(self.upload('race.bin', data))
        threads = [threading.Thread(target=send, args=(p,)) for p in payloads]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(r[0] for r in results), [201, 201])
        names = sorted(r[2]['artifact']['name'] for r in results)
        self.assertEqual(names, ['race-2.bin', 'race.bin'])
        self.assertEqual(sorted((self.folder / n).read_bytes() for n in names), sorted(payloads))
        self.assertEqual(self.staged(), [])

    def test_link_unsupported_falls_back_to_rename(self):
        (self.folder / 'fallback.txt').write_bytes(b'old')
        with mock.patch.object(au.os, 'link', side_effect=PermissionError(1, 'no hard links')):
            status, _, body = self.upload('FALLBACK.txt', b'new')
        self.assertEqual(status, 201, body)
        self.assertEqual(body['artifact']['name'], 'FALLBACK-2.txt')
        self.assertEqual((self.folder / 'fallback.txt').read_bytes(), b'old')
        self.assertEqual(self.staged(), [])

    def test_short_body_leaves_nothing(self):
        before = tree(self.root)
        target = '/api/report-artifact-upload?' + urlencode({**SELECT, 'path': F1, 'name': 'cut.mp4'})
        status, headers, _, _ = self.raw('POST', target, [
            ('Origin', self.origin), ('X-Requested-With', 'Bounty-Board'), ('Content-Type', 'application/octet-stream'),
            ('Content-Length', str(5 * 1024 * 1024))], b'x' * 200_000, shutdown=True)
        self.assertEqual(status, 400)
        self.assertEqual(tree(self.root), before)
        self.assertEqual(self.staged(), [])

    def test_stalled_body_times_out_and_leaves_nothing(self):
        self.server.artifact_uploads.read_timeout = 0.5
        before = tree(self.root)
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        try:
            target = '/api/report-artifact-upload?' + urlencode({**SELECT, 'path': F1, 'name': 'stall.bin'})
            sock.sendall((f'POST {target} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: {self.origin}\r\n'
                          'X-Requested-With: Bounty-Board\r\nContent-Type: application/octet-stream\r\n'
                          'Content-Length: 1000\r\n\r\n').encode() + b'x' * 10)
            data = b''
            while chunk := sock.recv(65536):
                data += chunk
        finally:
            sock.close()
        self.assertIn(b' 400 ', data.split(b'\r\n', 1)[0])
        self.assertEqual(tree(self.root), before)

    def test_uploaded_name_sanitized_end_to_end(self):
        for raw, expected in (('../../x.py', 'x.py'), ('a\\b.js', 'b.js'), ('.env', 'env'), ('_meta', 'meta')):
            with self.subTest(raw):
                status, _, body = self.upload(raw, b'1')
                self.assertEqual(status, 201)
                self.assertEqual(body['artifact']['relative'], f'reports/F1/{expected}')
                self.assertTrue((self.folder / expected).is_file())
        self.assertFalse((self.root.parent / 'x.py').exists())
        status, _, body = self.upload('bad\0name.txt', b'1')
        self.assertEqual((status, body), (400, {'error': 'invalid_name'}))

    def test_upload_never_creates_folders(self):
        status, _, body = self.upload('sub/dir/file.txt', b'1')
        self.assertEqual(body['artifact']['relative'], 'reports/F1/file.txt')
        self.assertFalse((self.folder / 'sub').exists())


class SanitizeTests(unittest.TestCase):
    def test_names(self):
        cases = {
            '../../x.py': 'x.py', 'a\\b.js': 'b.js', 'C:\\Users\\me\\shot.png': 'shot.png', '.env': 'env',
            '_meta': 'meta', '__pycache__': 'pycache__', '...': 'upload', '': 'upload', ' . _ ': 'upload',
            'a\x01b\u202e.txt': 'a_b_.txt', 'line\nbreak.txt': 'line_break.txt', 'what?*.txt': 'what__.txt',
            'trailing. . ': 'trailing', 'con.txt': 'con_.txt', 'NUL': 'NUL_', 'cafe\u0301.md': 'caf\u00e9.md',
            '.png': 'png', 'report.tar.gz': 'report.tar.gz', 'pasted image.png': 'pasted image.png',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(au.sanitize_name(raw), expected)

    def test_long_names_keep_extension_within_180_bytes(self):
        for raw in ('a' * 400 + '.png', '\u00e9' * 300 + '.txt', '\U0001f600' * 100 + '.mp4', 'b' * 500):
            with self.subTest(raw=raw[:5]):
                name = au.sanitize_name(raw)
                self.assertLessEqual(len(name.encode('utf-8')), 180)
                self.assertEqual(Path(name).suffix, Path(raw).suffix if '.' in raw else '')
                name.encode('utf-8').decode('utf-8')
                for candidate in list(au.candidates(name))[:12]:
                    self.assertLessEqual(len(candidate.encode('utf-8')), 180)
        self.assertEqual(list(au.candidates(au.sanitize_name('a' * 400 + '.png')))[1][-7:], 'a-2.png')

    def test_unfixable(self):
        for raw in ('a\0b', None, '\ud800x'):
            with self.subTest(raw=raw):
                with self.assertRaises(au.UploadError):
                    au.sanitize_name(raw)

    def test_candidates(self):
        self.assertEqual(list(au.candidates('shot.png'))[:3], ['shot.png', 'shot-2.png', 'shot-3.png'])
        self.assertEqual(list(au.candidates('README'))[:2], ['README', 'README-2'])


if __name__ == '__main__':
    unittest.main()
