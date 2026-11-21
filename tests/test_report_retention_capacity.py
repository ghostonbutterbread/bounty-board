"""Synthetic retention-capacity checks; all paths are disposable."""
import tempfile
import unittest
import hashlib
import http.client
import json
import multiprocessing
import os
import threading
from urllib.parse import urlencode
from unittest import mock
from pathlib import Path

import report_publisher
import app
from collaborative_engine import CollaborationStore


def _cached_competitor(root, private, gate, output):
    store = CollaborationStore(private)
    with store.observation():
        area = Path(private) / 'publication'; area.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(area, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            assert report_publisher._operation_count(fd) == 0
        finally:
            os.close(fd)
    gate.send('cached')
    if gate.recv() != 'continue':
        raise RuntimeError('invalid barrier')
    with store.observation():
        output.put(report_publisher.publish(root, 'second.md', private, 'key', 'second',
                                            'original\n', 'second\n', max_operations=1, min_free_bytes=0))


def _competing_publish(root, private, index, gate, output):
    store = CollaborationStore(private)
    gate.wait(15)
    with store.observation():
        output.put(report_publisher.publish(root, f'{index}.md', private, 'key', str(index),
                                            'original\n', f'draft {index}\n',
                                            max_operations=1, min_free_bytes=0))


class RetentionCapacityTests(unittest.TestCase):
    def test_cached_count_invalidates_after_other_process_publication(self):
        ctx = multiprocessing.get_context('spawn')
        for run in range(3):
            with self.subTest(run=run), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / 'source'; root.mkdir()
                private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
                for name in ('first.md', 'second.md'):
                    (root / name).write_text('original\n')
                store = CollaborationStore(private)
                parent, child = ctx.Pipe(); output = ctx.Queue()
                process = ctx.Process(target=_cached_competitor, args=(root, private, child, output))
                process.start(); child.close()
                try:
                    self.assertTrue(parent.poll(20)); self.assertEqual(parent.recv(), 'cached')
                    with store.observation():
                        first = report_publisher.publish(root, 'first.md', private, 'key', 'first',
                                                         'original\n', 'first\n', max_operations=1, min_free_bytes=0)
                    self.assertEqual(first['state'], 'published')
                    parent.send('continue')
                    second = output.get(timeout=20)
                    self.assertEqual(second['state'], 'capacity')
                    self.assertEqual((root / 'second.md').read_text(), 'original\n')
                finally:
                    process.join(10)
                    if process.is_alive(): process.kill(); process.join()
                    parent.close(); output.close(); output.join_thread()
                    self.assertEqual(process.exitcode, 0)

    def test_two_processes_share_one_capacity_slot_repeatedly(self):
        ctx = multiprocessing.get_context('spawn')
        for run in range(3):
            with self.subTest(run=run), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / 'source'; root.mkdir()
                private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
                for index in range(2):
                    (root / f'{index}.md').write_text('original\n')
                gate = ctx.Barrier(2); output = ctx.Queue()
                processes = [ctx.Process(target=_competing_publish, args=(root, private, i, gate, output)) for i in range(2)]
                for process in processes: process.start()
                try:
                    results = [output.get(timeout=30) for _ in processes]
                    self.assertEqual(sorted(r['state'] for r in results), ['capacity', 'published'])
                    self.assertEqual(len(list((private / 'publication').iterdir())), 1)
                    self.assertEqual(sorted((root / f'{i}.md').read_text().startswith('draft') for i in range(2)), [False, True])
                finally:
                    for process in processes:
                        process.join(10)
                        if process.is_alive(): process.kill(); process.join()
                        self.assertEqual(process.exitcode, 0)
                    output.close(); output.join_thread()

    def test_swapped_retention_directory_before_exchange_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            outside = Path(tmp) / 'outside'; outside.mkdir()
            source = root / 'report.md'; source.write_text('original\n')
            def swap(phase, _operation):
                if phase == 'before_exchange':
                    (private / 'publication').rename(private / 'old-publication')
                    (private / 'publication').symlink_to(outside, target_is_directory=True)
            result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n', hook=swap)
            self.assertNotEqual(result['state'], 'published')
            self.assertEqual(source.read_text(), 'original\n')
            self.assertEqual(list(outside.iterdir()), [])

    def test_crash_remnant_counts_and_sequential_saves_reuse_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            area = private / 'publication'; area.mkdir(mode=0o700)
            (area / 'crashed').mkdir()
            source = root / 'report.md'; source.write_text('original\n')
            with mock.patch.object(report_publisher.os, 'scandir', wraps=os.scandir) as scans:
                one = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'first\n', max_operations=3, min_free_bytes=0)
                two = report_publisher.publish(root, 'report.md', private, 'key', 'two', 'first\n', 'second\n', max_operations=3, min_free_bytes=0)
                three = report_publisher.publish(root, 'report.md', private, 'key', 'three', 'second\n', 'third\n', max_operations=3, min_free_bytes=0)
                self.assertEqual([one['state'], two['state'], three['state']], ['published', 'published', 'capacity'])
                self.assertEqual(scans.call_count, 1)
                self.assertTrue((area / 'crashed').is_dir())
                self.assertEqual(source.read_text(), 'second\n')

    def test_full_capacity_preserves_changed_retained_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            source = root / 'report.md'; source.write_text('original\n')
            with source.open('r+') as old:
                first = report_publisher.publish(root, 'report.md', private, 'key', 'first', 'original\n', 'first\n', max_operations=1, min_free_bytes=0)
                old.seek(0); old.write('late edit\n'); old.truncate(); old.flush()
                blocked = report_publisher.publish(root, 'report.md', private, 'key', 'second', 'first\n', 'second\n', max_operations=1, min_free_bytes=0)
                self.assertEqual(blocked['state'], 'capacity')
                operation = private / 'publication' / first['operation']
                self.assertEqual(report_publisher.retained_snapshot(private, first['operation'])[1], 'late edit\n')
                self.assertEqual(report_publisher.inspect(root, 'report.md', operation)['state'], 'conflict')
                self.assertEqual(source.read_text(), 'first\n')

    def test_actual_free_space_floor_refuses_before_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            source = root / 'report.md'; source.write_text('original\n')
            info = os.statvfs(private)
            floor = info.f_bavail * info.f_frsize + 1
            result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n',
                                              max_operations=1000, min_free_bytes=floor)
            self.assertEqual(result['state'], 'capacity')
            self.assertEqual(source.read_text(), 'original\n')
            self.assertEqual(list((private / 'publication').iterdir()), [])

    def test_cli_capacity_defaults_overrides_and_invalid(self):
        args = app.parse_config([])
        self.assertEqual(args.retention_max_operations, 1000)
        self.assertEqual(args.retention_min_free_bytes, 1024 ** 3)
        args = app.parse_config(['--retention-max-operations', '2', '--retention-min-free-bytes', '0'])
        self.assertEqual((args.retention_max_operations, args.retention_min_free_bytes), (2, 0))
        for flags in (['--retention-max-operations', '0'], ['--retention-min-free-bytes', '-1']):
            with self.subTest(flags=flags), self.assertRaises(SystemExit):
                app.parse_config(flags)

    def test_existing_symlink_counts_without_following(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            area = private / 'publication'; area.mkdir(mode=0o700)
            outside = Path(tmp) / 'outside'; outside.write_text('sentinel')
            (area / 'unknown').symlink_to(outside)
            source = root / 'report.md'; source.write_text('original\n')
            with mock.patch.object(report_publisher, 'DEFAULT_MAX_OPERATIONS', 1):
                result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            self.assertEqual(result['state'], 'capacity')
            self.assertEqual(source.read_text(), 'original\n')
            self.assertEqual(outside.read_text(), 'sentinel')

    def test_full_capacity_never_exchanges_and_retry_can_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            source = root / 'report.md'; source.write_text('original\n')
            one = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'first\n')
            self.assertEqual(one['state'], 'published')
            with mock.patch.object(report_publisher, 'DEFAULT_MAX_OPERATIONS', 1, create=True):
                blocked = report_publisher.publish(root, 'report.md', private, 'key', 'two', 'first\n', 'second\n')
            self.assertEqual(blocked['state'], 'capacity')
            self.assertEqual(source.read_text(), 'first\n')
            self.assertEqual((private / 'publication' / one['operation'] / 'displaced').read_text(), 'original\n')
            with mock.patch.object(report_publisher, 'DEFAULT_MAX_OPERATIONS', 2, create=True):
                retry = report_publisher.publish(root, 'report.md', private, 'key', 'two', 'first\n', 'second\n')
            self.assertEqual(retry['state'], 'published')
            self.assertEqual(source.read_text(), 'second\n')

    def test_capacity_retry_rejects_changed_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; private = Path(tmp) / 'private'
            source = root / 'web_bounty/example/web/reports/report.md'
            source.parent.mkdir(parents=True); source.write_text('original\n')
            server = app.make_server(root, 0, collaboration_dir=private, report_autosave=True,
                                     retention_max_operations=1, retention_min_free_bytes=0)
            thread = threading.Thread(target=server.serve_forever); thread.start()
            query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md',
                                   root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
            def request(method, payload=None, endpoint='', extra=''):
                host = f'127.0.0.1:{server.server_port}'
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
                try:
                    conn.request(method, '/api/collaboration' + endpoint + '?' + query + extra, json.dumps(payload) if payload else None,
                                 {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'})
                    response = conn.getresponse(); return json.loads(response.read())
                finally: conn.close()
            try:
                first_base = request('GET')['revision']
                first = request('POST', {'base': first_base, 'content': 'first\n', 'request_id': 'first'})
                payload = {'base': first['revision'], 'content': 'draft\n', 'request_id': 'blocked'}
                self.assertEqual(request('POST', payload)['publication']['state'], 'capacity')
                source.write_text('external competing edit\n')
                retry = request('POST', payload)
                self.assertEqual(retry['publication']['state'], 'conflict')
                self.assertIn('capacity_retry_changed', retry['publication']['reasons'])
                inspection = request('GET', endpoint='/recovery', extra='&request_id=blocked')
                self.assertEqual(inspection['publication']['state'], 'conflict', inspection)
                self.assertIn('capacity_retry_changed', inspection['publication']['reasons'])
                self.assertEqual(source.read_text(), 'external competing edit\n')
                self.assertEqual((private / 'publication' / first['publication']['operation'] / 'displaced').read_text(), 'original\n')
                source.unlink()
                missing = request('GET', endpoint='/recovery', extra='&request_id=blocked')
                self.assertEqual(missing['publication']['state'], 'outcome_uncertain', missing)
                self.assertIn('capacity_preconditions_unavailable', missing['publication']['reasons'])
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_http_capacity_and_exact_retry_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; private = Path(tmp) / 'private'
            source = root / 'web_bounty/example/web/reports/report.md'
            source.parent.mkdir(parents=True); source.write_text('original\n')
            query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md',
                                   root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
            def start(limit):
                server = app.make_server(root, 0, collaboration_dir=private, report_autosave=True,
                                         retention_max_operations=limit, retention_min_free_bytes=0)
                thread = threading.Thread(target=server.serve_forever); thread.start()
                return server, thread
            def request(server, method, payload=None, endpoint='', extra=''):
                host = f'127.0.0.1:{server.server_port}'
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
                try:
                    conn.request(method, '/api/collaboration' + endpoint + '?' + query + extra, json.dumps(payload) if payload else None,
                                 {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'})
                    response = conn.getresponse(); return response.status, json.loads(response.read())
                finally:
                    conn.close()
            with mock.patch.object(report_publisher, 'DEFAULT_MAX_OPERATIONS', 1):
                server, thread = start(1)
                try:
                    initial = request(server, 'GET')[1]
                    first = request(server, 'POST', {'base': initial['revision'], 'content': 'first\n', 'request_id': 'one'})[1]
                    self.assertEqual(first['publication']['state'], 'published')
                    payload = {'base': first['revision'], 'content': 'second\n', 'request_id': 'two'}
                    status, blocked = request(server, 'POST', payload)
                    self.assertEqual(status, 200)
                    self.assertTrue(blocked['store_saved'])
                    self.assertEqual(blocked['publication']['state'], 'capacity', blocked)
                    self.assertEqual(source.read_text(), 'first\n')
                    recovered = request(server, 'GET', endpoint='/recovery', extra='&request_id=two')[1]
                    self.assertTrue(recovered['store_saved'])
                    self.assertEqual(recovered['publication']['state'], 'capacity')
                    self.assertEqual(request(server, 'POST', payload)[1]['publication']['state'], 'capacity')
                    self.assertEqual(len(list((private / 'publication').iterdir())), 1)
                finally:
                    server.shutdown(); thread.join(); server.server_close()
            with mock.patch.object(report_publisher, 'DEFAULT_MAX_OPERATIONS', 2):
                server, thread = start(2)
                try:
                    status, retry = request(server, 'POST', payload)
                    self.assertEqual(status, 200)
                    self.assertEqual(retry['publication']['state'], 'published', retry)
                    self.assertEqual(source.read_text(), 'second\n')
                finally:
                    server.shutdown(); thread.join(); server.server_close()
