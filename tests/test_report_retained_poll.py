"""Synthetic, process-barrier regressions for retained report edits."""
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
from tests.fixture_preferences import make_server as make_test_server
import report_publisher
from collaborative_engine import CollaborationStore


def server_process(root, private, pipe, barrier):
    if barrier:
        original = report_publisher.retained_snapshot
        def wait(*args):
            nonlocal barrier
            if barrier:
                barrier = False
                pipe.send('snapshot')
                if pipe.recv() != 'continue':
                    raise RuntimeError('bad barrier')
            return original(*args)
        report_publisher.retained_snapshot = wait
    server = make_test_server(root, 0, collaboration_dir=private, report_autosave=True)
    pipe.send(server.server_port)
    server.serve_forever()


class RetainedPollTests(unittest.TestCase):
    def test_two_processes_invalidate_completed_sweep_and_make_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, private = Path(tmp) / 'source', Path(tmp) / 'private'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True); report.write_text('initial\n')
            servers = []
            try:
                for _ in range(2):
                    parent, child = multiprocessing.Pipe()
                    proc = multiprocessing.Process(target=server_process, args=(root, private, child, False))
                    proc.start(); child.close(); servers.append((proc, parent, None))
                    self.assertTrue(parent.poll(30)); servers[-1] = (proc, parent, parent.recv())
                key = json.dumps([str(root.resolve()), 'web_bounty/example/web/reports/report.md'], ensure_ascii=False)
                store = CollaborationStore(private)
                with store.observation():
                    for n in range(65):
                        op = f'conflict-{n:03}'
                        store.begin_publication(key, op); store.complete_publication(key, op, 'conflict')
                query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md', root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
                def request(index, method, payload=None):
                    port = servers[index][2]; host = f'127.0.0.1:{port}'
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
                    try:
                        conn.request(method, '/api/collaboration?' + query, json.dumps(payload) if payload else None,
                                     {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'})
                        response = conn.getresponse(); return response.status, json.loads(response.read())
                    finally:
                        conn.close()
                self.assertEqual(request(0, 'GET')[1]['reconciliation']['state'], 'backlog')
                state = request(0, 'GET')[1]
                self.assertEqual(state['reconciliation']['state'], 'complete')
                other = {'base': state['revision'], 'content': 'other process\n', 'request_id': 'other'}
                self.assertEqual(request(1, 'POST', other)[0], 503)
                status, state = request(1, 'POST', other)
                self.assertEqual(status, 200, state)
                self.assertEqual(state['publication']['state'], 'published')
                next_payload = {'base': state['revision'], 'content': 'next process\n', 'request_id': 'next'}
                self.assertEqual(request(0, 'POST', next_payload)[0], 503)
                status, result = request(0, 'POST', next_payload)
                self.assertEqual(status, 200, result)
                self.assertEqual(result['publication']['state'], 'published')
                self.assertEqual(report.read_text(), 'next process\n')
            finally:
                for proc, pipe, _ in servers:
                    if proc.is_alive(): proc.terminate()
                    proc.join(10)
                    if proc.is_alive(): proc.kill(); proc.join()
                    pipe.close()

    def exercise(self, delayed, overlap, post_first=False):
        with tempfile.TemporaryDirectory() as tmp:
            root, private = Path(tmp) / 'source', Path(tmp) / 'private'
            report = root / 'web_bounty/example/web/reports/report.md'
            report.parent.mkdir(parents=True)
            initial = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
            report.write_text(initial)
            parent, child = multiprocessing.Pipe()
            proc = multiprocessing.Process(target=server_process, args=(root, private, child, not delayed))
            proc.start(); child.close()
            worker = None
            try:
                self.assertTrue(parent.poll(30)); port = parent.recv()
                query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md', root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest()))
                def request(method, payload=None, endpoint='', extra=''):
                    host = f'127.0.0.1:{port}'
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
                    try:
                        conn.request(method, '/api/collaboration' + endpoint + '?' + query + extra,
                                     json.dumps(payload) if payload else None,
                                     {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'})
                        response = conn.getresponse(); return response.status, json.loads(response.read())
                    finally:
                        conn.close()
                base = request('GET')[1]['revision']
                payload = {'base': base, 'content': initial.replace('one', 'board'), 'request_id': 'first'}
                result = {}
                with report.open('r+') as old:
                    worker = threading.Thread(target=lambda: result.update(response=request('POST', payload)))
                    worker.start()
                    if delayed:
                        worker.join(30); self.assertFalse(worker.is_alive())
                        self.assertEqual(result['response'][1]['publication']['state'], 'published')
                    else:
                        self.assertTrue(parent.poll(30)); self.assertEqual(parent.recv(), 'snapshot')
                    outside = initial.replace('one' if overlap else 'seven', 'outside')
                    old.seek(0); old.write(outside); old.truncate(); old.flush(); os.fsync(old.fileno())
                    if not delayed:
                        parent.send('continue'); worker.join(30); self.assertFalse(worker.is_alive())
                if not delayed:
                    self.assertNotEqual(result['response'][1]['publication']['state'], 'published', result)
                if post_first:
                    first = result['response'][1]
                    next_payload = {'base': first['revision'], 'content': first['content'].replace('two', 'second'), 'request_id': 'second'}
                    next_status, next_result = request('POST', next_payload)
                    self.assertEqual(next_status, 200, next_result)
                    self.assertNotEqual(next_result['publication']['state'], 'published', next_result)
                    self.assertEqual(report.read_text(), payload['content'])
                current = request('GET')[1]
                history = request('GET', endpoint='/history')[1]['history']
                self.assertTrue(any(x['kind'].startswith('retained:') for x in history), history)
                if overlap:
                    self.assertGreater(current['unresolved_count'], 0)
                else:
                    self.assertIn('outside', current['content'])
                    self.assertIn('board', current['content'])
                retry = request('POST', payload)[1]
                self.assertNotEqual(retry['publication']['state'], 'published', retry)
                self.assertEqual(report.read_text(), payload['content'])
            finally:
                if proc.is_alive(): proc.terminate()
                proc.join(10)
                if proc.is_alive(): proc.kill(); proc.join()
                if worker: worker.join(10)
                parent.close()

    def test_collision_after_inspection(self):
        for overlap in (True, False):
            with self.subTest(overlap=overlap): self.exercise(False, overlap)

    def test_late_descriptor_before_get(self):
        for overlap in (True, False):
            with self.subTest(overlap=overlap): self.exercise(True, overlap)

    def test_late_descriptor_before_post(self):
        for overlap in (True, False):
            with self.subTest(overlap=overlap): self.exercise(True, overlap, True)
