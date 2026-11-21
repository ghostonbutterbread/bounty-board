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
import report_publisher


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
    server = app.make_server(root, 0, collaboration_dir=private, report_autosave=True)
    pipe.send(server.server_port)
    server.serve_forever()


class RetainedPollTests(unittest.TestCase):
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
