"""Synthetic HTTP collaboration tests. All state is in tempfile roots."""
import http.client
import hashlib
import json
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path
from urllib.parse import urlencode

import app


class CollaborationAPITests(unittest.TestCase):
    def test_simultaneous_slow_collaboration_requests_are_admission_bounded(self):
        import socket
        import time
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True); report.write_text('base')
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private')
            thread = threading.Thread(target=server.serve_forever); thread.start()
            identity = dict(family='web_bounty', program='example', lane='web', path='example.md',
                            root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest())
            host = f'127.0.0.1:{server.server_port}'
            path = '/api/collaboration?' + urlencode(identity)
            sockets = []
            try:
                for _ in range(4):
                    sock = socket.create_connection(('127.0.0.1', server.server_port), timeout=10)
                    sockets.append(sock)
                    sock.sendall(f'POST {path} HTTP/1.1\r\nHost: {host}\r\n'.encode() +
                                 f'Origin: http://{host}\r\nContent-Type: application/json\r\nX-Requested-With: Bounty-Board\r\nContent-Length: 1\r\n\r\n'.encode())
                deadline = time.monotonic() + 10
                while server.collaboration_slots._value and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(server.collaboration_slots._value, 0)
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
                try:
                    conn.request('GET', path)
                    response = conn.getresponse()
                    self.assertEqual(response.status, 503)
                    self.assertIn('retry', json.loads(response.read())['message'].lower())
                finally: conn.close()
            finally:
                for sock in sockets:
                    try:
                        sock.sendall(b'0'); sock.recv(4096)
                    finally: sock.close()
                server.shutdown(); thread.join(); server.server_close()

    def test_large_document_is_not_multiplied_in_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True); report.write_text('x' * 5_000_000)
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private')
            thread = threading.Thread(target=server.serve_forever); thread.start()
            identity = dict(family='web_bounty', program='example', lane='web', path='example.md',
                            root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest())
            def get(endpoint='', **params):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                try:
                    conn.request('GET', '/api/collaboration'+endpoint+'?'+urlencode({**identity, **params}))
                    response=conn.getresponse(); raw=response.read()
                    return response.status, json.loads(raw), len(raw)
                finally: conn.close()
            try:
                status, state, size = get()
                self.assertEqual(status, 200)
                self.assertEqual(len(state['content']), 5_000_000)
                self.assertLess(size, 5_025_000)
                self.assertEqual(set(state['history'][0]), {'id','kind','revision','base','head','resolved_revision'})
                status, page, size = get('/history')
                self.assertEqual((status, len(page['history'])), (200, 1))
                self.assertLess(size, 25000)
                self.assertEqual(get('/version', revision=state['revision'])[1]['content'], state['content'])
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_quota_rejection_rolls_back_and_allows_retry_after_increase(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True); report.write_text('initial')
            store = Path(tmp) / 'private'
            identity = dict(family='web_bounty', program='example', lane='web', path='example.md',
                            root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest())
            def start(limit):
                server = app.make_server(root, 0, collaboration_dir=store, collaboration_max_bytes=limit)
                thread = threading.Thread(target=server.serve_forever); thread.start()
                return server, thread
            server, thread = start(131072)
            def request(method, body=None, endpoint='', params=None):
                host = f'127.0.0.1:{server.server_port}'
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=20)
                try:
                    conn.request(method, '/api/collaboration'+endpoint+'?'+urlencode({**identity, **(params or {})}),
                                 json.dumps(body) if body is not None else None,
                                 {'Host':host, 'Origin':'http://'+host, 'Content-Type':'application/json', 'X-Requested-With':'Bounty-Board'})
                    response=conn.getresponse(); return response.status, json.loads(response.read())
                finally: conn.close()
            try:
                base = request('GET')[1]['revision']
                payload = {'base':base, 'content':'x'*300000, 'request_id':'quota-retry'}
                status, result = request('POST', payload)
                self.assertEqual(status, 503)
                self.assertIn('Retain', result['message'])
                after = request('GET')[1]
                self.assertEqual(after['revision'], base)
                self.assertEqual(len(after['history']), 1)
                self.assertEqual(request('GET', endpoint='/version', params={'revision':base})[1]['content'], 'initial')
                server.shutdown(); thread.join(); server.server_close()
                server, thread = start(4000000)
                status, saved = request('POST', payload)
                self.assertEqual((status, saved['content']), (200, payload['content']))
                self.assertEqual(request('POST', payload)[1], saved)
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_metadata_paging_and_report_scoped_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True); report.write_text('base\x00')
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private')
            thread = threading.Thread(target=server.serve_forever); thread.start()
            identity = dict(family='web_bounty', program='example', lane='web', path='example.md',
                            root_identity=hashlib.sha256(str(root.resolve()).encode()).hexdigest())
            def request(endpoint='', params=None, method='GET', body=None, headers=None):
                host = f'127.0.0.1:{server.server_port}'
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=20)
                try:
                    conn.request(method, '/api/collaboration'+endpoint+'?'+urlencode({**identity, **(params or {})}),
                                 json.dumps(body) if body is not None else None,
                                 {'Host': host, 'Origin': 'http://'+host, 'Content-Type':'application/json',
                                  'X-Requested-With':'Bounty-Board', **(headers or {})})
                    response = conn.getresponse(); raw = response.read()
                    return response.status, json.loads(raw), len(raw)
                finally: conn.close()
            try:
                base = request()[1]['revision']
                request(method='POST', body={'base':base, 'content':'head\x00', 'request_id':'head'})
                for n in range(51):
                    status, value, _ = request(method='POST', body={'base':base, 'content':f'conflict {n}\x00', 'request_id':str(n)})
                    self.assertEqual((status, value['status']), (200, 'conflict'))
                status, state, size = request()
                self.assertEqual((status, state['unresolved_count'], len(state['history'])), (200, 51, 50))
                self.assertLess(size, 25000)
                self.assertTrue(all('content' not in e and 'head_content' not in e for e in state['history']))
                status, first, _ = request('/history')
                self.assertEqual(status, 200)
                status, new_conflict, _ = request(method='POST', body={'base':base, 'content':'new conflict\x00', 'request_id':'new-conflict'})
                self.assertEqual((status, new_conflict['status']), (200, 'conflict'))
                status, second, _ = request('/history', {'before':first['next_before']})
                self.assertEqual((status, second['next_before'], second['unresolved_count']), (200, None, 52))
                events = first['history'] + second['history']
                self.assertEqual((len(events), len({e['id'] for e in events})), (53, 53))
                old = next(e for e in events if e['kind']=='client:conflict' and e['revision']==hashlib.sha256(b'conflict 0\x00').hexdigest())
                self.assertEqual(request('/version', {'revision':old['revision']})[1]['content'], 'conflict 0\x00')
                self.assertEqual(request('/version', {'revision':old['head']})[1]['content'], 'head\x00')
                self.assertEqual(request('/version', {'revision':'bad'})[0], 404)
                self.assertEqual(request('/history', {'before':'-1'})[0], 404)
                self.assertEqual(request('/history', headers={'Origin':'http://evil.test'})[0], 403)
                report2=report.with_name('other.md'); report2.write_text('other')
                identity['path']='other.md'
                self.assertEqual(request('/version', {'revision':old['revision']})[0], 404)
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_opt_in_fixture_publication_checks_head_and_writes_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'; report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True); report.write_text('initial\n')
            server = app.make_server(root, 0, collaboration_dir=Path(tmp) / 'private', experimental_fixture_publish=True)
            thread = threading.Thread(target=server.serve_forever); thread.start()
            host = f'127.0.0.1:{server.server_port}'
            root_id=hashlib.sha256(str(root.resolve()).encode()).hexdigest()
            url = '/api/collaboration?' + urlencode({'family':'web_bounty','program':'example','lane':'web','path':'example.md','root_identity':root_id})
            def req(method, body=None):
                c = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                c.request(method, url, json.dumps(body) if body is not None else None,
                          {'Host':host,'Origin':'http://'+host,'Content-Type':'application/json','X-Requested-With':'Bounty-Board'})
                r=c.getresponse(); value=(r.status,json.loads(r.read())); c.close(); return value
            try:
                initial=req('GET')[1]
                saved=req('POST', {'base':initial['revision'],'content':'published\n','request_id':'save'})[1]
                self.assertEqual(report.read_text(),'initial\n')
                self.assertEqual(req('POST', {'action':'publish','revision':initial['revision']})[0],409)
                self.assertEqual(report.read_text(),'initial\n')
                original_read=app.read_file
                calls=0
                def racing_read(*args):
                    nonlocal calls
                    data=original_read(*args)
                    calls+=1
                    if calls==1:
                        report.write_text('external race\n')
                    return data
                with mock.patch.object(app, 'read_file', side_effect=racing_read):
                    self.assertEqual(req('POST', {'action':'publish','revision':saved['revision']})[0],409)
                self.assertEqual(report.read_text(),'external race\n')
                state=req('GET')[1]
                self.assertTrue(any(e['revision']==hashlib.sha256(b'external race\n').hexdigest() for e in state['history']))
                conflict=next(e for e in state['history'] if e['kind']=='source:conflict')
                saved=req('POST', {'base':state['revision'],'content':'published\n','request_id':'resolve-source','conflict_id':conflict['id']})[1]
                self.assertEqual(req('POST', {'action':'publish','revision':saved['revision']})[0],200)
                self.assertEqual(report.read_text(),'published\n')
            finally:
                server.shutdown(); thread.join(); server.server_close()

    def test_shared_drafts_conflicts_retry_and_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            report = root / 'web_bounty/example/web/reports/example.md'
            report.parent.mkdir(parents=True)
            report.write_text('one\ntwo\nthree\n')
            store = Path(tmp) / 'private'
            identity = {'family': 'web_bounty', 'program': 'example', 'lane': 'web', 'path': 'example.md',
                        'root_identity': hashlib.sha256(str(root.resolve()).encode()).hexdigest()}
            def start():
                server = app.make_server(root, 0, collaboration_dir=store)
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                return server, thread
            server, thread = start()
            def request(method, payload=None, headers=None):
                host = f'127.0.0.1:{server.server_port}'
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                body = json.dumps(payload) if payload is not None else None
                conn.request(method, '/api/collaboration?' + urlencode(identity), body,
                             {'Host': host, 'Origin': 'http://' + host, 'Content-Type': 'application/json',
                              'X-Requested-With': 'Bounty-Board', **(headers or {})})
                response = conn.getresponse(); result = (response.status, json.loads(response.read())); conn.close()
                return result
            try:
                status, initial = request('GET'); self.assertEqual(status, 200)
                base = initial['revision']
                first = {'base': base, 'content': 'ONE\ntwo\nthree\n', 'request_id': 'first'}
                identity['root_identity'] = '0' * 64
                self.assertEqual(request('GET')[0], 404)
                self.assertEqual(request('POST', first)[0], 409)
                identity['root_identity'] = hashlib.sha256(str(root.resolve()).encode()).hexdigest()
                self.assertEqual(request('POST', first, {'Origin': 'http://evil.test'})[0], 403)
                self.assertEqual(request('POST', first, {'Host': 'evil.test'})[0], 403)
                self.assertEqual(request('POST', first, {'Content-Type': 'text/plain'})[0], 403)
                self.assertEqual(request('POST', {'action': 'publish', 'revision': base})[0], 403)
                status, saved = request('POST', first); self.assertEqual(status, 200)
                self.assertEqual(request('POST', first)[1], saved)
                self.assertEqual(request('POST', {**first, 'content': 'different'})[0], 409)
                status, merged = request('POST', {'base': base, 'content': 'one\ntwo\nTHREE\n', 'request_id': 'second'})
                self.assertEqual((status, merged['status'], merged['content']), (200, 'merged', 'ONE\ntwo\nTHREE\n'))
                status, conflict = request('POST', {'base': base, 'content': 'changed\ntwo\nthree\n', 'request_id': 'third'})
                self.assertEqual((status, conflict['status']), (200, 'conflict'))
                conflict_id = conflict['conflict_id']
                resolution = {'base': conflict['revision'], 'content': 'resolved\ntwo\nTHREE\n',
                              'request_id': 'resolve', 'conflict_id': conflict_id}
                status, resolved = request('POST', resolution)
                self.assertEqual((status, resolved['status']), (200, 'saved'))
                self.assertEqual(request('POST', resolution)[1], resolved)
                item = next(e for e in request('GET')[1]['history'] if e['id'] == conflict_id)
                self.assertEqual(item['resolved_revision'], resolved['revision'])
                self.assertEqual(request('GET', headers={'Origin': 'http://evil.test'})[0], 403)
                report.write_text('one\ntwo\nEXTERNAL\n')
                self.assertEqual(request('GET')[0], 200)
                server.shutdown(); thread.join(); server.server_close()
                server, thread = start()
                status, state = request('GET')
                self.assertEqual(status, 200)
                self.assertTrue(any(e['revision'] == hashlib.sha256(b'changed\ntwo\nthree\n').hexdigest() for e in state['history']))
                self.assertTrue(any(e['revision'] == hashlib.sha256(b'one\ntwo\nEXTERNAL\n').hexdigest() for e in state['history']))
            finally:
                server.shutdown(); thread.join(); server.server_close()


if __name__ == '__main__':
    unittest.main()
