"""Interprocess regression: two HTTP servers sharing one private store."""
import fcntl
import hashlib
import http.client
import json
import multiprocessing
import os
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode

import app


def _server(root, store, pipe, pause):
    if pause:
        original = app.read_file
        def read_then_wait(*args):
            data = original(*args)
            pipe.send('read')
            if pipe.recv() != 'release':
                raise RuntimeError('bad handshake')
            return data
        app.read_file = read_then_wait
    server = app.make_server(root, 0, collaboration_dir=store)
    if not pause:
        # Signal the second process at the actual lock boundary, before it
        # attempts acquisition. The parent releases the first only afterward.
        original_flock = fcntl.flock
        def signal_then_flock(fd, operation):
            if operation == fcntl.LOCK_EX:
                pipe.send('locking')
            return original_flock(fd, operation)
        fcntl.flock = signal_then_flock
    pipe.send(server.server_port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


class SharedStoreProcessTests(unittest.TestCase):
    def test_legacy_history_is_retained_but_not_silently_bound(self):
        from collaborative_engine import CollaborationStore
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; root.mkdir()
            store = Path(tmp) / 'private'
            original = CollaborationStore(store)
            original.observe_source('legacy', 'old retained draft')
            server = None
            try:
                with self.assertRaisesRegex(ValueError, 'legacy history'):
                    server = app.make_server(root, 0, collaboration_dir=store)
            finally:
                if server is not None: server.server_close()
            self.assertEqual(original.current('legacy')['content'], 'old retained draft')

    def test_replaced_source_directory_does_not_reuse_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True); report.write_text('old source\n')
            store = Path(tmp) / 'private'
            server = app.make_server(root, 0, collaboration_dir=store)
            thread = threading.Thread(target=server.serve_forever); thread.start()
            identity = hashlib.sha256(os.fsencode(str(root.resolve()))).hexdigest()
            url = '/api/collaboration?' + urlencode(dict(family='web_bounty', program='example', lane='web', path='example.md', root_identity=identity))
            def request():
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
                try:
                    conn.request('GET', url); response = conn.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    conn.close()
            try:
                self.assertEqual(request()[1]['content'], 'old source\n')
                root.rename(Path(tmp) / 'old-root')
                report.parent.mkdir(parents=True); report.write_text('new source\n')
                self.assertNotEqual(request()[0], 200)
            finally:
                server.shutdown(); thread.join(); server.server_close()
            with self.assertRaises(ValueError):
                app.make_server(root, 0, collaboration_dir=store)

    def test_source_read_is_serialized_across_two_servers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True)
            report.write_text('old\n')
            store = Path(tmp) / 'private'
            store.mkdir(mode=0o700)
            lock = store / 'observation.lock'
            lock.touch(mode=0o600)
            ctx = multiprocessing.get_context('fork')
            processes = []
            pipes = []
            threads = []
            try:
                ports = []
                for pause in (True, False):
                    parent, child = ctx.Pipe()
                    process = ctx.Process(target=_server, args=(root, store, child, pause))
                    process.start(); child.close()
                    processes.append(process); pipes.append(parent)
                    self.assertTrue(parent.poll(10), 'server did not start')
                    ports.append(parent.recv())
                identity = hashlib.sha256(os.fsencode(str(root.resolve()))).hexdigest()
                url = '/api/collaboration?' + urlencode(dict(family='web_bounty', program='example', lane='web', path='example.md', root_identity=identity))
                results = {}
                def request(port, name):
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
                    try:
                        conn.request('GET', url)
                        response = conn.getresponse()
                        results[name] = (response.status, json.loads(response.read()))
                    finally:
                        conn.close()
                first = threading.Thread(target=request, args=(ports[0], 'first'))
                threads.append(first); first.start()
                self.assertTrue(pipes[0].poll(10), 'first source read did not arrive')
                self.assertEqual(pipes[0].recv(), 'read')
                report.write_text('new\n')
                # A separate process holds the lock after the actual source read.
                fd = os.open(lock, os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(fd)
                second = threading.Thread(target=request, args=(ports[1], 'second'))
                threads.append(second); second.start()
                self.assertTrue(pipes[1].poll(10), 'second server did not reach lock')
                self.assertEqual(pipes[1].recv(), 'locking')
                pipes[0].send('release')
                first.join(10); second.join(10)
                self.assertFalse(first.is_alive()); self.assertFalse(second.is_alive())
                self.assertEqual(results['first'][0], 200)
                self.assertEqual(results['second'][0], 200)
                self.assertEqual(results['second'][1]['content'], 'new\n')
            finally:
                for process in processes:
                    if process.is_alive(): process.terminate()
                    process.join(10)
                for thread in threads: thread.join(10)
                for pipe in pipes: pipe.close()


if __name__ == '__main__':
    unittest.main()
