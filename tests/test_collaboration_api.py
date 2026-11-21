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
                self.assertTrue(any(e['content']=='external race\n' for e in state['history']))
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
                self.assertTrue(any(e['content'] == 'changed\ntwo\nthree\n' for e in state['history']))
                self.assertTrue(any(e['content'] == 'one\ntwo\nEXTERNAL\n' for e in state['history']))
            finally:
                server.shutdown(); thread.join(); server.server_close()


if __name__ == '__main__':
    unittest.main()
