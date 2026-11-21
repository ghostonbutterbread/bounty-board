"""Synthetic HTTP scans, ordering, backlog and storage failure paths."""
import hashlib
import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
import os
import report_publisher
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

import app
from collaborative_engine import CollaborationStore


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root, self.private = Path(self.tmp.name) / 'source', Path(self.tmp.name) / 'private'
        self.report = self.root / 'web_bounty/example/web/reports/report.md'
        self.report.parent.mkdir(parents=True)
        self.text = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
        self.report.write_text(self.text)
        self.server = app.make_server(self.root, 0, collaboration_dir=self.private, report_autosave=True)
        self.thread = threading.Thread(target=self.server.serve_forever); self.thread.start()
        self.host = f'127.0.0.1:{self.server.server_port}'
        self.query = urlencode(dict(family='web_bounty', program='example', lane='web', path='report.md', root_identity=hashlib.sha256(str(self.root.resolve()).encode()).hexdigest()))
        self.key = json.dumps([str(self.root.resolve()), 'web_bounty/example/web/reports/report.md'], ensure_ascii=False)

    def tearDown(self):
        self.server.shutdown(); self.thread.join(20); self.server.server_close()
        self.assertFalse(self.thread.is_alive())
        self.tmp.cleanup()

    def request(self, method='GET', payload=None, endpoint='', extra=''):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            conn.request(method, '/api/collaboration' + endpoint + '?' + self.query + extra,
                         json.dumps(payload) if payload else None,
                         {'Host': self.host, 'Origin': 'http://' + self.host, 'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'})
            response = conn.getresponse(); return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_outstanding_operations_observed_in_creation_order_and_deduped(self):
        base = self.request()[1]
        with self.report.open('r+') as first:
            one = self.request('POST', {'base': base['revision'], 'content': self.text.replace('one', 'ONE'), 'request_id': 'one'})[1]
            self.assertEqual(one['publication']['state'], 'published')
            with self.report.open('r+') as second:
                two = self.request('POST', {'base': one['revision'], 'content': one['content'].replace('two', 'TWO'), 'request_id': 'two'})[1]
                self.assertEqual(two['publication']['state'], 'published')
                for f, text in ((second, one['content'].replace('five', 'FIVE')), (first, self.text.replace('seven', 'SEVEN'))):
                    f.seek(0); f.write(text); f.truncate(); f.flush()
                state = self.request()[1]
                self.assertEqual(state['content'], self.text.replace('one', 'ONE').replace('two', 'TWO').replace('five', 'FIVE').replace('seven', 'SEVEN'))
                page = self.request(endpoint='/history')[1]['history']
                events = [e for e in reversed(page) if e['kind'].startswith('retained:')]
                self.assertEqual(len(events), 2, page)
                store = CollaborationStore(self.private)
                ops = [store.retained_provenance(self.key, e['id'])['operation'] for e in events]
                self.assertEqual(ops, [one['publication']['operation'], two['publication']['operation']])
                self.request(); self.request(endpoint='/history')
                self.assertEqual(len([e for e in self.request(endpoint='/history')[1]['history'] if e['kind'].startswith('retained:')]), 2)
                recovery = self.request(endpoint='/recovery', extra='&request_id=one')[1]
                self.assertNotEqual(recovery['publication']['state'], 'published')
                self.assertEqual(self.report.read_text(), two['content'])

    def test_scan_backlog_is_bounded_and_blocks_post_until_sweep_finishes(self):
        base = self.request()[1]
        store = CollaborationStore(self.private)
        for n in range(65):
            store.begin_publication(self.key, f'incomplete-{n:03}')
        payload = {'base': base['revision'], 'content': 'draft\n', 'request_id': 'new'}
        status, result = self.request('POST', payload)
        self.assertEqual(status, 503, result)
        self.assertEqual(result['error'], 'retained_scan_backlog')
        self.assertEqual(result['reconciliation'], {'state': 'backlog', 'scanned': 64})
        self.assertEqual(self.report.read_text(), self.text)
        self.assertIsNone(store.request_result(self.key, 'new'))
        status, result = self.request('POST', payload)
        self.assertEqual(status, 200, result)
        self.assertEqual(result['reconciliation'], {'state': 'uncertain', 'scanned': 1})
        self.assertEqual(result['publication']['state'], 'outcome_uncertain')
        self.assertEqual(self.report.read_text(), self.text)

    def test_retry_of_unpublished_merged_store_save_never_exchanges(self):
        base = self.request()[1]
        with self.report.open('r+') as old:
            first = self.request('POST', {'base': base['revision'], 'content': self.text.replace('one', 'ONE'), 'request_id': 'one'})[1]
            old.seek(0); old.write(self.text.replace('seven', 'SEVEN')); old.truncate(); old.flush()
            second_payload = {'base': first['revision'], 'content': first['content'].replace('two', 'TWO'), 'request_id': 'two'}
            second = self.request('POST', second_payload)[1]
            self.assertEqual(second['publication']['state'], 'conflict')
            merged = self.request()[1]['content']
            self.report.write_text(merged)
            with mock.patch.object(report_publisher, '_exchange', wraps=report_publisher._exchange) as exchange:
                status, retry = self.request('POST', second_payload)
            self.assertEqual(status, 200, retry)
            exchange.assert_not_called()
            self.assertNotEqual(retry['publication']['state'], 'published')
            self.assertEqual(self.report.read_text(), merged)

    def test_post_exchange_sqlite_failure_recovers_without_reexchange(self):
        base = self.request()[1]
        payload = {'base': base['revision'], 'content': self.text.replace('one', 'BOARD'), 'request_id': 'first'}
        original = report_publisher._exchange
        with self.report.open('r+') as old:
            def late(*args):
                result = original(*args)
                old.seek(0); old.write(self.text.replace('seven', 'OUTSIDE')); old.truncate(); old.flush(); os.fsync(old.fileno())
                return result
            with mock.patch.object(report_publisher, '_exchange', side_effect=late), \
                    mock.patch.object(CollaborationStore, 'observe_retained', side_effect=sqlite3.OperationalError('injected')):
                status, result = self.request('POST', payload)
            self.assertEqual(status, 200, result)
            self.assertEqual(result['publication']['state'], 'outcome_uncertain')
            self.assertEqual(self.report.read_text(), payload['content'])
            with mock.patch.object(report_publisher, '_exchange', side_effect=AssertionError('must not exchange')):
                retry = self.request('POST', payload)[1]
            self.assertEqual(retry['publication']['state'], 'outcome_uncertain')
            state = self.request()[1]
            self.assertIn('OUTSIDE', state['content'])
            events = self.request(endpoint='/history')[1]['history']
            self.assertEqual(len([e for e in events if e['kind'].startswith('retained:')]), 1)
            self.assertEqual(self.report.read_text(), payload['content'])

    def test_sqlite_scan_error_returns_503_without_store_submit_or_exchange(self):
        base = self.request()[1]
        payload = {'base': base['revision'], 'content': 'draft\n', 'request_id': 'new'}
        with mock.patch.object(CollaborationStore, 'publication_page', side_effect=sqlite3.OperationalError('injected')):
            status, result = self.request('POST', payload)
        self.assertEqual((status, result['error']), (503, 'retained_reconciliation_unavailable'))
        self.assertEqual(self.report.read_text(), self.text)
        self.assertIsNone(CollaborationStore(self.private).request_result(self.key, 'new'))
        self.assertEqual(self.request('POST', payload)[1]['publication']['state'], 'published')
