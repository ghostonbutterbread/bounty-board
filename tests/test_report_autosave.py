"""Synthetic HTTP integration for opt-in report publication."""
import hashlib
import http.client
import json
import multiprocessing
import os
import errno
import fcntl
from unittest import mock
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode

import app
import report_publisher


def _crashing_server(root, private, pipe):
    publish = report_publisher.publish
    def crash_after_publish(*args, **kwargs):
        publish(*args, **kwargs)
        os._exit(88)
    report_publisher.publish = crash_after_publish
    server = app.make_server(root, 0, collaboration_dir=private, report_autosave=True)
    pipe.send(server.server_port)
    server.serve_forever()


def _autosave_server(root, private, pipe, pause):
    server = app.make_server(root, 0, collaboration_dir=private, report_autosave=True)
    if pause:
        exchange = report_publisher._exchange
        def delayed(*args):
            pipe.send('exchange')
            if pipe.recv() != 'continue':
                raise RuntimeError('bad barrier')
            return exchange(*args)
        report_publisher._exchange = delayed
    else:
        flock = fcntl.flock
        def signal(fd, operation):
            if operation == fcntl.LOCK_EX:
                pipe.send('locking')
            return flock(fd, operation)
        fcntl.flock = signal
    pipe.send(server.server_port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def _paused_publish(root, private, pipe, phase):
    def hook(name, _op):
        if name == phase:
            pipe.send('paused')
            if pipe.recv() != 'continue':
                raise RuntimeError('bad barrier')
    result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n', hook)
    pipe.send(result)
    pipe.close()


class PublisherTests(unittest.TestCase):
    def test_external_write_at_exchange_is_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            source = root / 'report.md'; source.write_text('original\n')
            before = source.stat().st_ino
            parent, child = multiprocessing.Pipe()
            process = multiprocessing.Process(target=_paused_publish, args=(root, private, child, 'before_exchange'))
            process.start(); child.close()
            try:
                self.assertTrue(parent.poll(10))
                self.assertEqual(parent.recv(), 'paused')
                source.write_text('late edit\n')
                parent.send('continue')
                self.assertTrue(parent.poll(10))
                result = parent.recv()
                self.assertEqual(result['state'], 'conflict', result)
                self.assertIn('displaced_changed', result['reasons'])
                old = private / 'publication' / result['operation'] / 'displaced'
                self.assertEqual(old.stat().st_ino, before)
                self.assertEqual(old.read_text(), 'late edit\n')
                self.assertEqual(source.read_text(), 'draft\n')
            finally:
                process.join(10)
                if process.is_alive():
                    process.kill(); process.join()
                parent.close()
            self.assertEqual(process.exitcode, 0)

    def test_barrier_deletion_after_exchange_change_and_crash_recovery(self):
        for phase, action in [('before_exchange', 'delete'), ('after_exchange', 'change'),
                              ('before_exchange', 'kill'), ('after_exchange', 'kill')]:
            with self.subTest(phase=phase, action=action), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / 'root'; root.mkdir()
                private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
                source = root / 'report.md'; source.write_text('original\n')
                parent, child = multiprocessing.Pipe()
                process = multiprocessing.Process(target=_paused_publish, args=(root, private, child, phase))
                process.start(); child.close()
                try:
                    self.assertTrue(parent.poll(10)); self.assertEqual(parent.recv(), 'paused')
                    if action == 'kill':
                        process.kill(); process.join(10)
                        result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
                        self.assertEqual(result['state'], 'outcome_uncertain')
                    else:
                        if action == 'delete':
                            source.unlink()
                        else:
                            source.write_text('later\n')
                        parent.send('continue')
                        self.assertTrue(parent.poll(10)); result = parent.recv()
                        self.assertEqual(result['state'], 'conflict', result)
                        if action == 'delete':
                            self.assertFalse(source.exists())
                        else:
                            self.assertIn('source_changed', result['reasons'])
                    op = private / 'publication' / result['operation']
                    self.assertEqual((op / 'board').read_text(), 'draft\n')
                finally:
                    process.join(10)
                    if process.is_alive():
                        process.kill(); process.join()
                    parent.close()

    def test_receipt_failure_never_recovers_as_published(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            (root / 'report.md').write_text('original\n')
            write = report_publisher._write_at
            def fail_after_receipt(fd, name, data, mode=0o600):
                write(fd, name, data, mode)
                if name == 'receipt.pending':
                    raise OSError(errno.EIO, 'injected fsync failure')
            with mock.patch.object(report_publisher, '_write_at', side_effect=fail_after_receipt):
                first = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            self.assertEqual(first['state'], 'outcome_uncertain')
            retry = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            self.assertEqual(retry['state'], 'outcome_uncertain')

    def test_candidate_metadata_not_preservable_refuses_exchange(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            source = root / 'report.md'; source.write_text('original\n')
            with mock.patch.object(report_publisher.os, 'listxattr', side_effect=[[], ['user.inherited']]):
                result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            self.assertEqual(result['state'], 'conflict')
            self.assertEqual(source.read_text(), 'original\n')

    def test_precondition_failure_has_durable_retry_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            (root / 'report.md').write_text('changed\n')
            first = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            second = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            self.assertEqual(first['state'], 'conflict')
            self.assertEqual(second, first)

    def test_unsupported_exchange_retains_draft_and_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            private = Path(tmp) / 'private'; private.mkdir(mode=0o700)
            source = root / 'report.md'; source.write_text('original\n')
            with mock.patch.object(report_publisher, '_exchange', side_effect=OSError(errno.ENOSYS, 'unsupported')):
                result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            self.assertEqual(result['state'], 'conflict')
            retry = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
            self.assertEqual(retry, result)
            self.assertEqual(source.read_text(), 'original\n')
            self.assertEqual((private / 'publication' / result['operation'] / 'board').read_text(), 'draft\n')

    def test_old_descriptor_change_is_reported_on_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            root.mkdir()
            source = root / 'report.md'
            source.write_text('original\n')
            source.chmod(0o640)
            private = Path(tmp) / 'private'
            private.mkdir(mode=0o700)
            with source.open('r+') as old:
                result = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
                self.assertEqual(result['state'], 'published')
                self.assertEqual(source.stat().st_mode & 0o7777, 0o640)
                old.seek(0)
                old.write('outside!\n')
                old.flush()
                retry = report_publisher.publish(root, 'report.md', private, 'key', 'one', 'original\n', 'draft\n')
                self.assertEqual(retry['state'], 'conflict')
                self.assertIn('displaced_changed', retry['reasons'])
                self.assertEqual(source.read_text(), 'draft\n')


class ReportAutosaveTests(unittest.TestCase):
    def test_crash_before_http_receipt_recovers_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; private = Path(tmp) / 'private'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True); report.write_text('original\n')
            parent, child = multiprocessing.Pipe()
            process = multiprocessing.Process(target=_crashing_server, args=(root, private, child))
            process.start(); child.close()
            self.assertTrue(parent.poll(30)); port = parent.recv()
            query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md',
                                   root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
            def request(port, method, endpoint='', payload=None, extra=''):
                host = f'127.0.0.1:{port}'; conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
                try:
                    conn.request(method, '/api/collaboration' + endpoint + '?' + query + extra,
                                 json.dumps(payload) if payload else None,
                                 {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json',
                                  'X-Requested-With': 'Bounty-Board'})
                    res = conn.getresponse(); return json.loads(res.read())
                finally: conn.close()
            try:
                base = request(port, 'GET')['revision']
                with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
                    request(port, 'POST', payload={'base': base, 'content': 'draft\n', 'request_id': 'crash'})
                process.join(30); self.assertEqual(process.exitcode, 88)
                server = app.make_server(root, 0, collaboration_dir=private, report_autosave=True)
                thread = threading.Thread(target=server.serve_forever); thread.start()
                try:
                    recovered = request(server.server_port, 'GET', '/recovery', extra='&request_id=crash')
                    self.assertEqual(recovered['publication']['state'], 'outcome_uncertain')
                    retry = request(server.server_port, 'POST', payload={'base': base, 'content': 'draft\n', 'request_id': 'crash'})
                    self.assertEqual(retry['publication']['state'], 'outcome_uncertain')
                    self.assertEqual(len(list((private / 'publication').iterdir())), 1)
                finally:
                    server.shutdown(); thread.join(); server.server_close()
            finally:
                if process.is_alive(): process.kill(); process.join()
                parent.close()

    def test_two_server_processes_serialize_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True)
            base_text = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
            report.write_text(base_text)
            private = Path(tmp) / 'private'
            pipes, processes, threads, results = [], [], [], {}
            try:
                ports = []
                for pause in (True, False):
                    parent, child = multiprocessing.Pipe()
                    process = multiprocessing.Process(target=_autosave_server, args=(root, private, child, pause))
                    process.start(); child.close(); pipes.append(parent); processes.append(process)
                    self.assertTrue(parent.poll(30)); ports.append(parent.recv())
                query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md',
                                      root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
                def request(port, method, payload=None):
                    host = f'127.0.0.1:{port}'
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=60)
                    try:
                        conn.request(method, '/api/collaboration?' + query, json.dumps(payload) if payload else None,
                                     {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json',
                                      'X-Requested-With': 'Bounty-Board'})
                        response = conn.getresponse(); return response.status, json.loads(response.read())
                    finally:
                        conn.close()
                base = request(ports[0], 'GET')[1]['revision']
                def submit(index, content):
                    results[index] = request(ports[index], 'POST', {'base': base, 'content': content, 'request_id': str(index)})
                first = threading.Thread(target=submit, args=(0, base_text.replace('one', 'alpha')))
                threads.append(first); first.start()
                self.assertTrue(pipes[0].poll(30)); self.assertEqual(pipes[0].recv(), 'exchange')
                lock_fd = os.open(private / 'observation.lock', os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(lock_fd)
                second = threading.Thread(target=submit, args=(1, base_text.replace('seven', 'omega')))
                threads.append(second); second.start()
                self.assertTrue(pipes[1].poll(30)); self.assertEqual(pipes[1].recv(), 'locking')
                pipes[0].send('continue')
                for thread in threads:
                    thread.join(60); self.assertFalse(thread.is_alive())
                self.assertEqual(results[0][1]['publication']['state'], 'published', results)
                self.assertEqual(results[1][1]['publication']['state'], 'published', results)
                self.assertEqual(report.read_text(), base_text.replace('one', 'alpha').replace('seven', 'omega'))
            finally:
                for process in processes:
                    if process.is_alive(): process.terminate()
                    process.join(10)
                    if process.is_alive(): process.kill(); process.join()
                for thread in threads:
                    thread.join(10)
                for pipe in pipes:
                    pipe.close()

    def test_http_three_way_merges_external_and_draft_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True)
            base_text = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
            report.write_text(base_text)
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private', report_autosave=True)
            thread = threading.Thread(target=server.serve_forever); thread.start()
            host = f'127.0.0.1:{server.server_port}'
            url = '/api/collaboration?' + urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md',
                                root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
            def request(method, payload=None):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                try:
                    conn.request(method, url, json.dumps(payload) if payload else None,
                                 {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json',
                                  'X-Requested-With': 'Bounty-Board'})
                    response = conn.getresponse(); return response.status, json.loads(response.read())
                finally:
                    conn.close()
            try:
                base = request('GET')[1]['revision']
                report.write_text(base_text.replace('seven', 'external'))
                status, result = request('POST', {'base': base, 'content': base_text.replace('one', 'draft'), 'request_id': 'merge'})
                self.assertEqual(status, 200, result)
                self.assertEqual(result['status'], 'merged')
                self.assertEqual(result['publication']['state'], 'published')
                self.assertEqual(report.read_text(), base_text.replace('one', 'draft').replace('seven', 'external'))
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_late_displaced_edit_is_retained_in_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True); report.write_text('original\n')
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private', report_autosave=True)
            thread = threading.Thread(target=server.serve_forever); thread.start()
            host = f'127.0.0.1:{server.server_port}'
            query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md',
                                   root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
            def request(method, payload=None, suffix=''):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                try:
                    conn.request(method, '/api/collaboration' + suffix + '?' + query,
                                 json.dumps(payload) if payload else None,
                                 {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json',
                                  'X-Requested-With': 'Bounty-Board'})
                    res = conn.getresponse(); return json.loads(res.read())
                finally:
                    conn.close()
            try:
                base = request('GET')['revision']
                exchange = report_publisher._exchange
                def late(*args):
                    report.write_text('outside\n')
                    return exchange(*args)
                with mock.patch.object(report_publisher, '_exchange', side_effect=late):
                    result = request('POST', {'base': base, 'content': 'draft\n', 'request_id': 'late'})
                self.assertEqual(result['publication']['state'], 'conflict')
                history = request('GET', suffix='/history')['history']
                self.assertTrue(any(e['kind'].startswith('retained:') for e in history), history)
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_opt_in_submit_publishes_and_retains_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True)
            report.write_text('original\n')
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private', report_autosave=True)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                host = f'127.0.0.1:{server.server_port}'
                identity = dict(family='web_bounty', program='example', lane='web', path='report.md',
                                root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest())
                def request(method, payload=None, endpoint='', extra=None):
                    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                    try:
                        conn.request(method, '/api/collaboration' + endpoint + '?' + urlencode({**identity, **(extra or {})}),
                                     json.dumps(payload) if payload else None,
                                     {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json',
                                      'X-Requested-With': 'Bounty-Board'})
                        response = conn.getresponse()
                        return response.status, json.loads(response.read())
                    finally:
                        conn.close()
                base = request('GET')[1]['revision']
                status, result = request('POST', {'base': base, 'content': 'draft\n', 'request_id': 'one'})
                self.assertEqual(status, 200, result)
                self.assertEqual(result['publication']['state'], 'published')
                self.assertTrue(result['store_saved'])
                self.assertEqual(report.read_text(), 'draft\n')
                status, recovery = request('GET', endpoint='/recovery', extra={'request_id': 'one'})
                self.assertEqual(status, 200, recovery)
                self.assertEqual(recovery['publication']['state'], 'published')
                self.assertEqual(recovery['publication']['operation'], result['publication']['operation'])
                status, unknown = request('GET', endpoint='/recovery', extra={'request_id': 'unknown'})
                self.assertEqual(status, 404, unknown)
                server.shutdown(); thread.join(); server.server_close()
                server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private', report_autosave=True)
                thread = threading.Thread(target=server.serve_forever); thread.start()
                host = f'127.0.0.1:{server.server_port}'
                status, retry = request('POST', {'base': base, 'content': 'draft\n', 'request_id': 'one'})
                self.assertEqual(status, 200, retry)
                self.assertEqual(retry['publication']['state'], 'published')
                self.assertEqual(retry['publication']['operation'], result['publication']['operation'])
                self.assertEqual(len(list((Path(tmp) / 'private' / 'publication').iterdir())), 1)
                # The store must advance its source baseline to the actual published file.
                report.write_text('external\n')
                state = request('GET')[1]
                self.assertEqual(state['content'], 'external\n')
                self.assertEqual(state['unresolved_count'], 0)
                retained = list((Path(tmp) / 'private' / 'publication').glob('*/displaced'))
                self.assertEqual(len(retained), 1)
                self.assertEqual(retained[0].read_text(), 'original\n')
                report.unlink()
                status, missing_retry = request('POST', {'base': base, 'content': 'draft\n', 'request_id': 'one'})
                self.assertEqual(status, 200, missing_retry)
                self.assertTrue(missing_retry['store_saved'])
                self.assertEqual(missing_retry['publication']['state'], 'outcome_uncertain')
            finally:
                server.shutdown()
                thread.join()
                server.server_close()
