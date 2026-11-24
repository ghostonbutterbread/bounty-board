"""Synthetic request-boundary tests; no Tailscale daemon or real data."""
import http.client
import json
import contextlib
import io
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import app


class TailnetBoundaryTests(unittest.TestCase):
    def test_opted_in_writer_rejects_hostile_patches_before_invocation(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            marker = root / 'invoked'
            writer = root / 'fake-writer'
            writer.write_text('#!/bin/sh\nif [ "$2" = "--help" ]; then '
                              'printf "%s\\n" "--edit-finding --patch-file --root --family --lane"; '
                              'else touch "' + str(marker) + '"; exit 1; fi\n')
            writer.chmod(0o700)
            lane = root / 'web_bounty/example/web'
            (lane / 'ledgers').mkdir(parents=True)
            (lane / 'reports').mkdir()
            (lane / 'ledgers/ledger.json').write_text('{"findings":[{"fid":"F01","severity":"LOW"}]}')
            server = app.make_server(root, port=0, writer=writer, accept_uncoordinated_writes=True,
                                     tailnet_host='board.example.ts.net')
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            body = json.dumps({'family': 'web_bounty', 'program': 'example', 'lane': 'web',
                               'fid': 'F01', 'patch': {'severity': 'HIGH'}})
            base = {'Host': 'board.example.ts.net', 'Origin': 'https://board.example.ts.net',
                    'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}
            try:
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('GET', '/api/data', headers={'Host': 'board.example.ts.net'})
                data = json.loads(conn.getresponse().read()); conn.close()
                payload = json.loads(body)
                payload['root_instance'] = data['root_instance']
                payload['expected_revision'] = data['programs'][0]['lanes'][0]['findings'][0]['metadata_revision']
                body = json.dumps(payload)
                for changed in ({'Origin': 'https://evil.test'}, {'Host': 'evil.test'},
                                {'Sec-Fetch-Site': 'cross-site'}, {'Content-Type': 'text/plain'},
                                {'X-Requested-With': 'evil'}):
                    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    conn.request('PATCH', '/api/finding', body, {**base, **changed})
                    response = conn.getresponse()
                    self.assertEqual(response.status, 403, changed)
                    response.read()
                    conn.close()
                    self.assertFalse(marker.exists())
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('PATCH', '/api/finding', body, base)
                response = conn.getresponse()
                self.assertEqual(response.status, 502)
                response.read()
                conn.close()
                self.assertTrue(marker.exists())
            finally:
                server.shutdown()
                thread.join()
                server.server_close()

    def test_cli_opt_in_serves_synthetic_data_at_exact_https_host(self):
        with tempfile.TemporaryDirectory() as root:
            lane = Path(root) / 'web_bounty/example/web/ledgers'
            lane.mkdir(parents=True)
            (lane / 'ledger.json').write_text('{"findings":[{"fid":"F01","title":"synthetic"}]}')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen([sys.executable, str(Path(app.__file__)), '--root', root,
                                        '--port', str(port), '--tailnet-host', 'board.example.ts.net'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                        conn.request('GET', '/api/data', headers={'Host': 'board.example.ts.net',
                                     'Origin': 'https://board.example.ts.net'})
                        response = conn.getresponse()
                        data = response.read()
                        conn.close()
                        break
                    except ConnectionRefusedError:
                        time.sleep(.02)
                else:
                    self.fail('isolated server did not start')
                self.assertEqual(response.status, 200, data)
                self.assertIn(b'synthetic', data)
                self.assertNotIn('Access-Control-Allow-Origin', dict(response.getheaders()))
                self.assertFalse(json.loads(data)['capabilities']['finding_metadata'])
                def request(method, headers, path='/api/data'):
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                    conn.putrequest(method, path, skip_host=True)
                    for key, value in headers:
                        conn.putheader(key, value)
                    conn.endheaders()
                    response = conn.getresponse()
                    result = (response.status, response.read())
                    conn.close()
                    return result
                host = 'board.example.ts.net'
                for authority in (host, host + ':443'):
                    for origin in ([], [('Origin', 'https://' + host)]):
                        with self.subTest(authority=authority, origin=origin):
                            self.assertEqual(request('GET', [('Host', authority)] + origin)[0], 200)
                for authority in (f'127.0.0.1:{port}', f'localhost:{port}'):
                    self.assertEqual(request('GET', [('Host', authority), ('Origin', 'http://' + authority)])[0], 200)
                for headers in (
                    [('Host', 'evil.ts.net')], [('Host', host + ':8443')],
                    [('Host', host + '.evil.test')], [('Host', host.upper())],
                    [('Host', host), ('Origin', 'http://' + host)],
                    [('Host', host), ('Origin', 'https://evil.test')],
                    [('Host', host), ('Origin', 'https://' + host + ':8443')],
                    [('Host', host), ('Origin', 'null')],
                    [('Host', host), ('Host', host)],
                    [('Host', host), ('Origin', 'https://' + host), ('Origin', 'https://' + host)],
                    [('Host', host), ('Sec-Fetch-Site', 'cross-site')],
                    [('Host', host), ('Sec-Fetch-Site', 'same-site')],
                    [('Host', host), ('Sec-Fetch-Site', 'same-origin'), ('Sec-Fetch-Site', 'cross-site')],
                    [('Host', 'evil.test'), ('X-Forwarded-Host', host), ('X-Forwarded-Proto', 'https')],
                ):
                    with self.subTest(headers=headers):
                        self.assertEqual(request('GET', headers)[0], 403)
                patch_headers = [('Host', host), ('Origin', 'https://' + host),
                                 ('Content-Type', 'application/json'), ('X-Requested-With', 'Bounty-Board'),
                                 ('Content-Length', '2')]
                self.assertEqual(request('PATCH', patch_headers, '/api/finding')[0], 503)
                for added in ([('Host', host)], [('Origin', 'https://' + host)],
                              [('Sec-Fetch-Site', 'same-site')], [('Sec-Fetch-Site', 'cross-site')]):
                    self.assertEqual(request('PATCH', patch_headers + added, '/api/finding')[0], 403)
                self.assertEqual(request('PUT', [('Host', host)], '/api/report')[0], 403)
            finally:
                process.terminate()
                process.wait(timeout=5)

    def _serve(self, root, **kwargs):
        lane = Path(root) / 'web_bounty/example/web/ledgers'
        lane.mkdir(parents=True)
        (lane / 'ledger.json').write_text('{"findings":[{"fid":"F01","title":"synthetic"}]}')
        server = app.make_server(Path(root), port=0, **kwargs)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop():
            server.shutdown(); thread.join(); server.server_close()
        self.addCleanup(stop)
        def request(method, headers, path='/api/data', body=None):
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            conn.putrequest(method, path, skip_host=True)
            for key, value in headers:
                conn.putheader(key, value)
            if body is not None:
                conn.putheader('Content-Length', str(len(body)))
            conn.endheaders(body)
            response = conn.getresponse()
            result = (response.status, response.read())
            conn.close()
            return result
        return request

    def test_following_a_link_from_another_site_opens_only_the_app_shell(self):
        host = 'board.example.ts.net'
        with tempfile.TemporaryDirectory() as root:
            request = self._serve(root, tailnet_host=host)
            navigate = [('Host', host), ('Sec-Fetch-Mode', 'navigate'), ('Sec-Fetch-Dest', 'document')]
            for site in ('cross-site', 'same-site', 'none', 'same-origin'):
                with self.subTest(site=site):
                    status, body = request('GET', navigate + [('Sec-Fetch-Site', site)], '/')
                    self.assertEqual(status, 200)
                    self.assertIn(b'<html', body.lower())
            self.assertEqual(request('GET', navigate + [('Sec-Fetch-Site', 'cross-site')], '/index.html')[0], 200)
            for headers, path in (
                (navigate + [('Sec-Fetch-Site', 'cross-site')], '/api/data'),
                (navigate + [('Sec-Fetch-Site', 'cross-site')], '/app.js'),
                ([('Host', host), ('Sec-Fetch-Site', 'cross-site'), ('Sec-Fetch-Mode', 'navigate'), ('Sec-Fetch-Dest', 'iframe')], '/'),
                ([('Host', host), ('Sec-Fetch-Site', 'cross-site'), ('Sec-Fetch-Mode', 'no-cors'), ('Sec-Fetch-Dest', 'script')], '/'),
                ([('Host', host), ('Sec-Fetch-Site', 'cross-site'), ('Sec-Fetch-Mode', 'cors'), ('Sec-Fetch-Dest', 'empty')], '/'),
                ([('Host', host), ('Sec-Fetch-Site', 'cross-site')], '/'),
                (navigate + [('Sec-Fetch-Site', 'cross-site'), ('Sec-Fetch-Mode', 'navigate')], '/'),
                (navigate + [('Sec-Fetch-Site', 'cross-site'), ('Origin', 'https://evil.test')], '/'),
                ([('Host', 'evil.test'), ('Sec-Fetch-Site', 'cross-site'), ('Sec-Fetch-Mode', 'navigate'), ('Sec-Fetch-Dest', 'document')], '/'),
            ):
                with self.subTest(headers=headers, path=path):
                    self.assertEqual(request('GET', headers, path)[0], 403)
            # Writes are unchanged: a navigation-shaped write from another site is refused.
            write = [('Host', host), ('Origin', 'https://' + host), ('Content-Type', 'application/json'),
                     ('X-Requested-With', 'Bounty-Board'), ('Sec-Fetch-Site', 'cross-site'),
                     ('Sec-Fetch-Mode', 'navigate'), ('Sec-Fetch-Dest', 'document')]
            self.assertEqual(request('PATCH', write, '/api/finding', b'{}')[0], 403)

    def test_tailnet_https_port_is_part_of_the_trusted_origin(self):
        host = 'board.example.ts.net'
        with tempfile.TemporaryDirectory() as root:
            request = self._serve(root, tailnet_host=host, tailnet_port=9001)
            authority = host + ':9001'
            self.assertEqual(request('GET', [('Host', authority)])[0], 200)
            self.assertEqual(request('GET', [('Host', authority), ('Origin', 'https://' + authority)])[0], 200)
            for headers in ([('Host', host)], [('Host', host + ':443')], [('Host', host + ':9002')],
                            [('Host', authority), ('Origin', 'https://' + host)],
                            [('Host', authority), ('Origin', 'http://' + authority)]):
                with self.subTest(headers=headers):
                    self.assertEqual(request('GET', headers)[0], 403)
            write = [('Host', authority), ('Content-Type', 'application/json'), ('X-Requested-With', 'Bounty-Board')]
            self.assertEqual(request('PATCH', write + [('Origin', 'https://' + authority)], '/api/finding', b'{}')[0], 503)
            self.assertEqual(request('PATCH', write + [('Origin', 'https://' + host)], '/api/finding', b'{}')[0], 403)
        with self.assertRaises(ValueError):
            app.make_server(Path(root), port=0, tailnet_host=host, tailnet_port=0)

    def test_tailnet_port_is_configured_from_cli_or_config(self):
        self.assertEqual(app.parse_config(['--tailnet-host', 'board.example.ts.net']).tailnet_port, 443)
        self.assertEqual(app.parse_config(['--tailnet-host', 'board.example.ts.net', '--tailnet-port', '9001']).tailnet_port, 9001)
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stderr(io.StringIO()):
            config = Path(root) / 'config.json'
            config.write_text(json.dumps({'tailnet_host': 'board.example.ts.net', 'tailnet_port': 9001}))
            self.assertEqual(app.parse_config(['--config', str(config)]).tailnet_port, 9001)
            for invalid in (0, 70000, '9001', True, None):
                with self.subTest(invalid=invalid):
                    config.write_text(json.dumps({'tailnet_host': 'board.example.ts.net', 'tailnet_port': invalid}))
                    with self.assertRaises(SystemExit):
                        app.parse_config(['--config', str(config)])
            for argv in (['--tailnet-port', '9001'], ['--tailnet-host', 'board.example.ts.net', '--tailnet-port', '0']):
                with self.subTest(argv=argv), self.assertRaises(SystemExit):
                    app.parse_config(argv)

    def test_explicit_tailnet_hostname_is_configured(self):
        try:
            args = app.parse_config(['--tailnet-host', 'board.example.ts.net'])
        except SystemExit:
            self.fail('canonical tailnet hostname should be accepted')
        self.assertEqual(args.tailnet_host, 'board.example.ts.net')

    def test_config_rejects_invalid_hostnames_and_null(self):
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stderr(io.StringIO()):
            config = Path(root) / 'config.json'
            for invalid in (None, True, '', 'https://board.example.ts.net', 'board.example.ts.net:443',
                            'Board.example.ts.net', 'board.example.ts.net.', '*.example.ts.net',
                            'board..example.ts.net', '-board.example.ts.net', 'board.example.com',
                            'a' * 64 + '.example.ts.net'):
                with self.subTest(invalid=invalid):
                    config.write_text(json.dumps({'tailnet_host': invalid}))
                    with self.assertRaises(SystemExit):
                        app.parse_config(['--config', str(config)])
            config.write_text(json.dumps({'tailnet_host': 'board.example.ts.net'}))
            self.assertEqual(app.parse_config(['--config', str(config)]).tailnet_host, 'board.example.ts.net')
            self.assertEqual(app.parse_config(['--config', str(config), '--tailnet-host', 'node.other.ts.net']).tailnet_host,
                             'node.other.ts.net')

    def test_duplicate_host_and_origin_are_rejected_by_default(self):
        with tempfile.TemporaryDirectory() as root:
            server = app.make_server(Path(root), port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                host = f'127.0.0.1:{server.server_port}'
                for headers in ([('Host', host), ('Host', 'evil.test')],
                                [('Host', host), ('Origin', f'http://{host}'), ('Origin', 'https://evil.test')],
                                [('Host', 'board.example.ts.net')]):
                    with self.subTest(headers=headers):
                        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                        conn.putrequest('GET', '/api/data', skip_host=True)
                        for key, value in headers:
                            conn.putheader(key, value)
                        conn.endheaders()
                        response = conn.getresponse()
                        self.assertEqual(response.status, 403)
                        response.read()
                        conn.close()
            finally:
                server.shutdown()
                thread.join()
                server.server_close()
