#!/usr/bin/env python3
"""Bounty Board sandbox terminal service (separate from app.py).

Runs on 127.0.0.1 only. Tailscale Serve publishes it on the Board's origin
under ``/terminal/`` (``tailscale serve --bg --https=9001 --set-path /terminal
http://127.0.0.1:9011``), so the Board's drawer talks to it same-origin. Paths
are accepted with or without the ``/terminal`` prefix, because Serve may strip
it.

Routes (after the optional prefix):
  GET  /healthz                 liveness, no auth
  GET  /login, /login.js/.css   password login page
  GET  /api/status              who am I (401 with login_url when not signed in)
  POST /api/login, /api/logout  password sessions (JSON, X-Requested-With)
  GET  /api/checks?<selector>   check marks for a report's code blocks
  POST /api/checks              {family, program, lane, path, key, checked}
  GET  /api/mount?<selector>    which finding folder the report would open, or why not
  GET  /api/session?<selector>  session info, if one is running
  POST /api/reset               recreate a report's sandbox
  POST /api/evidence            save the transcript into <report folder>/validation/
  GET  /ws?<selector>           WebSocket attach (RFC 6455)

Every request must carry an allowed Host; WebSocket upgrades and state changes
also need Origin equal to an allowed origin (and that origin's own Host);
state changes need ``X-Requested-With: Bounty-Board`` and a JSON body. No CORS
headers are ever sent.

Usage:
  terminal_service.py --root ~/Shared --allowed-origin https://node.tailnet.ts.net:9001 \
      --allow-tailnet-user someone@example.com --password-hash-file ~/.config/bounty-board/terminal.hash
  terminal_service.py hash-password --output FILE     (reads the password from stdin, no echo)
"""
import argparse
import getpass
import ipaddress
import json
import os
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import terminal_auth
import terminal_checks
import terminal_sandbox as sb
import terminal_ws

PREFIX = '/terminal'
MAX_BODY = 64 * 1024
MAX_INPUT = 64 * 1024
VIEWER_QUEUE_BYTES = 4 * 1024 * 1024
PING_INTERVAL = 20
PEER_TIMEOUT = 75
STATIC = Path(__file__).parent / 'terminal_static'


def parse_origin(value):
    """Validate an allowed origin: https://host[:port], or http://127.0.0.1|localhost:port for tests."""
    parts = urlsplit(value)
    if parts.path not in ('', '/') or parts.query or parts.fragment or parts.username or parts.password or not parts.hostname:
        raise ValueError(f'invalid origin: {value}')
    if parts.scheme == 'https':
        pass
    elif parts.scheme == 'http' and parts.hostname in ('127.0.0.1', 'localhost') and parts.port:
        pass
    else:
        raise ValueError(f'origin must be https (or http on 127.0.0.1/localhost for tests): {value}')
    origin = f'{parts.scheme}://{parts.netloc}'.lower()
    authority = parts.netloc.lower()
    if parts.scheme == 'https' and parts.port in (None, 443):
        return origin.replace(':443', ''), {parts.hostname, f'{parts.hostname}:443'}
    return origin, {authority}


class Viewer:
    """One attached WebSocket. Output is queued and sent by its own thread so
    a slow device never stalls the shell or the other devices."""

    def __init__(self, ws):
        self.ws = ws
        self.queue = queue.Queue()
        self.pending = 0
        self.lock = threading.Lock()
        self.closed = False
        threading.Thread(target=self._send_loop, daemon=True).start()

    def _put(self, kind, payload):
        with self.lock:
            if self.closed:
                return
            self.pending += len(payload)
            if self.pending > VIEWER_QUEUE_BYTES:
                self.closed = True
                self.queue.put(None)
                return
        self.queue.put((kind, payload))

    def send_output(self, data):
        self._put('binary', bytes(data))

    def send_control(self, message):
        self._put('text', json.dumps(message))

    def close(self):
        with self.lock:
            self.closed = True
        self.queue.put(None)

    def _send_loop(self):
        while True:
            item = self.queue.get()
            if item is None:
                self.ws.close(1001, 'closed')
                return
            kind, payload = item
            with self.lock:
                self.pending -= len(payload)
            ok = self.ws.send_binary(payload) if kind == 'binary' else self.ws.send_text(payload)
            if not ok:
                return


def make_service(root, *, port=9011, allowed_origins=(), allowed_users=(), hash_record=None, state_dir,
                 backend=None, max_sessions=12, pause_after=300, remove_after=4 * 3600, min_free_memory=2 * 1024 ** 3,
                 idle_timeout=None, reap_interval=10, clock=time.time, mem_available=None):
    root = Path(root).absolute()
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    origins, hosts = {}, set()
    for value in allowed_origins:
        origin, authorities = parse_origin(value)
        if authorities & {f'127.0.0.1:{port}', f'localhost:{port}'}:
            raise ValueError('an allowed origin cannot be the service itself')
        origins[origin] = authorities
        hosts |= authorities
    if not origins:
        raise ValueError('at least one --allowed-origin is required')
    auth = terminal_auth.Auth(allowed_users=allowed_users, trusted_hosts=hosts, hash_record=hash_record, clock=clock)
    checks = terminal_checks.CheckStore(state_dir / 'checks.sqlite3')
    manager = sb.SessionManager(root, backend, max_sessions=max_sessions, pause_after=pause_after,
                                remove_after=idle_timeout if idle_timeout is not None else remove_after,
                                min_free_memory=min_free_memory, reap_interval=reap_interval, mem_available=mem_available)
    login_html = (STATIC / 'login.html').read_bytes()
    login_js = (STATIC / 'login.js').read_bytes()
    login_css = (STATIC / 'login.css').read_bytes()

    class Handler(BaseHTTPRequestHandler):
        server_version = 'bbterm'
        sys_version = ''
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            pass  # never log URLs (selectors) or headers

        # -- request gate --------------------------------------------------
        def route(self):
            path = urlsplit(self.path).path
            if path == PREFIX or path.startswith(PREFIX + '/'):
                path = path[len(PREFIX):] or '/'
            return path

        def host_ok(self):
            hosts_seen = self.headers.get_all('Host', [])
            return len(hosts_seen) == 1 and hosts_seen[0].lower() in hosts

        def origin_ok(self, required):
            """Origin must match an allowed origin whose authority is this request's Host."""
            found = self.headers.get_all('Origin', [])
            sites = self.headers.get_all('Sec-Fetch-Site', [])
            if len(found) > 1 or len(sites) > 1:
                return False
            if sites and sites[0] not in (('same-origin',) if required else ('same-origin', 'none')):
                return False
            if not found:
                return not required
            authorities = origins.get(found[0].lower())
            return authorities is not None and self.headers['Host'].lower() in authorities

        def identity(self):
            return auth.identify(self.headers)

        def reply(self, status, payload, headers=()):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            for key, value in headers:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def static(self, data, content_type, csp=None):
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Referrer-Policy', 'same-origin')
            if csp:
                self.send_header('Content-Security-Policy', csp)
            self.end_headers()
            self.wfile.write(data)

        def selector_from_query(self):
            params = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=8)
            if any(len(v) != 1 for v in params.values()):
                raise sb.SandboxError('bad_selector', 'Report selector is invalid.')
            return sb.clean_selector({k: v[0] for k, v in params.items()})

        def read_json(self):
            if self.headers.get('X-Requested-With') != 'Bounty-Board':
                return None, 'csrf'
            if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
                return None, 'content_type'
            try:
                length = int(self.headers.get('Content-Length') or '0')
            except ValueError:
                return None, 'length'
            if not 0 < length <= MAX_BODY:
                return None, 'length'
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                return None, 'json'
            return (body, None) if isinstance(body, dict) else (None, 'json')

        # -- GET -----------------------------------------------------------
        def do_GET(self):
            path = self.route()
            if path == '/healthz':
                return self.reply(200, {'ok': True})
            if not self.host_ok() or not self.origin_ok(required=False):
                return self.reply(403, {'error': 'forbidden'})
            if path in ('/', '/login'):
                return self.static(login_html, 'text/html; charset=utf-8',
                                   "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
                                   "img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
            if path == '/login.js':
                return self.static(login_js, 'text/javascript; charset=utf-8')
            if path == '/login.css':
                return self.static(login_css, 'text/css; charset=utf-8')
            user, method = self.identity()
            if path == '/api/status':
                if not user:
                    return self.reply(401, {'error': 'login_required', 'login_url': f'{PREFIX}/login',
                                            'password_login': auth.password_enabled})
                return self.reply(200, {'user': user, 'method': method, 'idle_timeout': manager.remove_after,
                                        'pause_after': manager.pause_after, 'remove_after': manager.remove_after,
                                        'max_sessions': manager.max_sessions})
            if not user:
                return self.reply(401, {'error': 'login_required', 'login_url': f'{PREFIX}/login'})
            try:
                if path == '/ws':
                    return self.websocket()
                if path == '/api/checks':
                    return self.reply(200, {'checks': checks.get(self.selector_from_query())})
                if path == '/api/mount':
                    # Whether this report has a finding folder to open (the Board disables the
                    # Terminal button with the message when it does not).
                    try:
                        mount = sb.resolve_mount(root, self.selector_from_query())
                    except sb.SandboxError as error:
                        if error.code == 'bad_selector':
                            raise
                        return self.reply(200, {'ok': False, 'code': error.code, 'message': error.message})
                    return self.reply(200, {'ok': True, 'folder': mount.folder, 'fid': mount.fid, 'rule': mount.rule,
                                            'reason': mount.reason})
                if path == '/api/session':
                    session = manager.get(self.selector_from_query())
                    return self.reply(200, {'session': session.info() if session else None})
            except sb.SandboxError as error:
                return self.reply(400, {'error': error.code, 'message': error.message})
            return self.reply(404, {'error': 'not_found'})

        # -- POST ----------------------------------------------------------
        def do_POST(self):
            path = self.route()
            if not self.host_ok() or not self.origin_ok(required=True):
                return self.reply(403, {'error': 'forbidden'})
            body, problem = self.read_json()
            if problem:
                return self.reply(400 if problem != 'csrf' else 403, {'error': problem})
            if path == '/api/login':
                sid, error = auth.login(body.get('username', ''), body.get('password', ''))
                if error:
                    status = {'locked': 429, 'disabled': 403}.get(error, 401)
                    return self.reply(status, {'error': error, 'message': {
                        'locked': 'Too many failed attempts. Try again in 15 minutes.',
                        'disabled': 'Password sign-in is not configured.'}.get(error, 'Wrong username or password.')})
                return self.reply(200, {'ok': True}, [('Set-Cookie', auth.session_cookie(sid))])
            if path == '/api/logout':
                auth.logout(self.headers)
                return self.reply(200, {'ok': True}, [('Set-Cookie', auth.clear_cookie())])
            user, _ = self.identity()
            if not user:
                return self.reply(401, {'error': 'login_required', 'login_url': f'{PREFIX}/login'})
            try:
                sel = sb.clean_selector(body)
                if path == '/api/checks':
                    if not isinstance(body.get('checked'), bool):
                        return self.reply(400, {'error': 'bad_request'})
                    if not checks.set(sel, body.get('key'), body['checked']):
                        return self.reply(409, {'error': 'too_many_checks'})
                    return self.reply(200, {'checks': checks.get(sel)})
                if path == '/api/reset':
                    session = manager.reset(sel)
                    return self.reply(200, {'session': session.info() if session else None})
                if path == '/api/evidence':
                    session = manager.get(sel)
                    if session is None:
                        return self.reply(409, {'error': 'no_session', 'message': 'Open the terminal first.'})
                    relative = sb.save_evidence(root, sel, session.transcript_text())
                    return self.reply(200, {'relative': relative, 'name': relative.rsplit('/', 1)[-1]})
            except ValueError:
                return self.reply(400, {'error': 'bad_request'})
            except sb.SandboxError as error:
                status = {'bad_selector': 400, 'report_not_found': 404, 'root_not_writable': 409, 'not_in_packet': 409,
                          'unsafe_folder': 409, 'too_many_sessions': 503}.get(error.code, 500)
                return self.reply(status, {'error': error.code, 'message': error.message})
            return self.reply(404, {'error': 'not_found'})

        def do_PUT(self):
            self.reply(405, {'error': 'method_not_allowed'})

        do_DELETE = do_PATCH = do_PUT

        def do_OPTIONS(self):
            self.reply(405, {'error': 'method_not_allowed'})  # no CORS, ever

        # -- WebSocket -----------------------------------------------------
        def websocket(self):
            if not self.origin_ok(required=True):
                return self.reply(403, {'error': 'forbidden'})
            sel = self.selector_from_query()
            try:
                accept = terminal_ws.check_handshake(self.command, self.headers)
            except terminal_ws.HandshakeError as error:
                extra = [('Sec-WebSocket-Version', '13')] if error.status == 426 else []
                return self.reply(error.status, {'error': 'bad_handshake'}, extra)
            self.send_response(101)
            for key, value in terminal_ws.handshake_headers(accept):
                self.send_header(key, value)
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            ws = terminal_ws.WebSocket(self.rfile, self.connection, max_frame=256 * 1024, max_message=256 * 1024)
            viewer = Viewer(ws)
            try:
                session = manager.attach(sel, viewer)
            except sb.SandboxError as error:
                viewer.send_control({'type': 'error', 'code': error.code, 'message': error.message})
                viewer.close()
                ws.recv()
                return
            except Exception:
                viewer.send_control({'type': 'error', 'code': 'sandbox_failed', 'message': 'The sandbox could not start.'})
                viewer.close()
                return
            stop = threading.Event()

            def pinger():
                while not stop.wait(PING_INTERVAL):
                    if time.monotonic() - ws.last_received > PEER_TIMEOUT:
                        ws.close(1001, 'timeout')
                        try:
                            self.connection.shutdown(2)
                        except OSError:
                            pass
                        return
                    ws.ping()
            threading.Thread(target=pinger, daemon=True).start()
            try:
                while True:
                    message = ws.recv()
                    if message is None:
                        break
                    kind, data = message
                    if kind != 'text':
                        continue
                    try:
                        command = json.loads(data)
                    except ValueError:
                        continue
                    if not isinstance(command, dict):
                        continue
                    current = manager.get(sel)
                    if current is not session:
                        break  # the session was closed (idle, evicted, stopped)
                    if command.get('t') == 'in' and isinstance(command.get('d'), str) and len(command['d']) <= MAX_INPUT:
                        session.write(command['d'].encode('utf-8', 'replace'))
                    elif command.get('t') == 'resize':
                        cols, rows = command.get('cols'), command.get('rows')
                        if type(cols) is int and type(rows) is int and 2 <= cols <= 500 and 2 <= rows <= 300:
                            session.resize(cols, rows)
            finally:
                stop.set()
                manager.detach(session, viewer)
                viewer.close()

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            if not isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
                super().handle_error(request, client_address)

        def server_close(self):
            try:
                manager.close()
                checks.close()
            finally:
                super().server_close()

    server = Server(('127.0.0.1', port), Handler)
    server.manager, server.auth, server.checks = manager, auth, checks
    return server


def parse_size(value):
    """Bytes from '2147483648', '2G', '512M' or '0'."""
    import re
    match = re.fullmatch(r'(\d+)\s*([KMG]i?B?)?', value.strip(), re.I)
    if not match:
        raise argparse.ArgumentTypeError('expected a size such as 2G or 512M')
    unit = (match.group(2) or '').upper()[:1]
    return int(match.group(1)) * {'': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3}[unit]


def hash_password_cli(argv):
    parser = argparse.ArgumentParser(prog='terminal_service.py hash-password',
                                     description='Create the password hash file from stdin (no echo).')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--force', action='store_true', help='replace an existing file')
    args = parser.parse_args(argv)
    if sys.stdin.isatty():
        password = getpass.getpass('Password: ')
        if getpass.getpass('Repeat: ') != password:
            print('Passwords differ.', file=sys.stderr)
            return 1
    else:
        password = sys.stdin.readline().rstrip('\r\n')
    if len(password) < terminal_auth.MIN_PASSWORD:
        print(f'Password must be at least {terminal_auth.MIN_PASSWORD} characters.', file=sys.stderr)
        return 1
    try:
        terminal_auth.write_hash_file(args.output, terminal_auth.hash_password(password), force=args.force)
    except FileExistsError:
        print('Output file exists; use --force to replace it.', file=sys.stderr)
        return 1
    print(f'Wrote {args.output} (mode 0600).')
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['hash-password']:
        return hash_password_cli(argv[1:])
    parser = argparse.ArgumentParser(description='Bounty Board sandbox terminal service')
    parser.add_argument('--root', type=Path, default=Path.home() / 'Shared', help='Board data root')
    parser.add_argument('--port', type=int, default=9011)
    parser.add_argument('--allowed-origin', action='append', default=[], required=True,
                        help='Board origin, e.g. https://node.tailnet.ts.net:9001 (repeatable)')
    parser.add_argument('--allow-tailnet-user', action='append', default=[],
                        help='Tailscale-User-Login allowed without a password (repeatable)')
    parser.add_argument('--password-hash-file', type=Path, help='0600 file from "hash-password"')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/bounty-board/terminal')
    parser.add_argument('--image', default='bbterm-sandbox:latest')
    parser.add_argument('--container-prefix', default='bbterm-')
    parser.add_argument('--max-sessions', type=int, default=12, help='sandboxes kept at once, 1-32 (default 12)')
    parser.add_argument('--pause-after', type=int, default=300,
                        help='seconds without a viewer before a sandbox is paused (default 300)')
    parser.add_argument('--remove-after', type=int, default=None,
                        help='seconds without a viewer before a sandbox is removed (default 14400)')
    parser.add_argument('--idle-timeout', type=int, default=None, help='old name for --remove-after')
    parser.add_argument('--reap-interval', type=int, default=10, help=argparse.SUPPRESS)  # tests only
    parser.add_argument('--min-free-memory', type=parse_size, default=2 * 1024 ** 3,
                        help='refuse new sandboxes below this MemAvailable, e.g. 2G (default 2G; 0 disables)')
    parser.add_argument('--memory', default='1g')
    parser.add_argument('--cpus', default='1.0')
    parser.add_argument('--pids', type=int, default=256)
    parser.add_argument('--backend', choices=('docker', 'local-test-only'), default='docker')
    args = parser.parse_args(argv)
    if args.remove_after is not None and args.idle_timeout is not None and args.remove_after != args.idle_timeout:
        parser.error('--idle-timeout is the old name of --remove-after; give only one')
    args.remove_after = args.remove_after if args.remove_after is not None else (args.idle_timeout or 4 * 3600)
    if not 1 <= args.port <= 65535 or not 1 <= args.max_sessions <= 32:
        parser.error('port must be 1-65535 and --max-sessions 1-32')
    if args.pause_after < 10 or args.remove_after < 60 or args.pause_after > args.remove_after:
        parser.error('need --pause-after >= 10 s, --remove-after >= 60 s and pause before removal')
    hash_record = None
    if args.password_hash_file:
        try:
            hash_record = terminal_auth.read_hash_file(args.password_hash_file)
        except (OSError, UnicodeError, terminal_auth.HashFileError) as error:
            parser.error(f'password hash file: {error}')
    if args.backend == 'local-test-only':
        tmp = os.path.realpath(os.environ.get('TMPDIR', '/nonexistent'))
        if os.environ.get('BBTERM_ALLOW_LOCAL_BACKEND') != '1' or not os.path.realpath(args.root).startswith(tmp + '/'):
            parser.error('the local backend is for tests only (needs BBTERM_ALLOW_LOCAL_BACKEND=1 and a root under TMPDIR)')
        backend = sb.LocalBackend(args.state_dir / 'local')
    else:
        import terminal_proxy
        backend = sb.DockerBackend(image=args.image, state_dir=args.state_dir, proxy=terminal_proxy.FilteringProxy(),
                                   prefix=args.container_prefix, memory=args.memory, cpus=args.cpus, pids=args.pids)
    try:
        server = make_service(args.root, port=args.port, allowed_origins=args.allowed_origin,
                              allowed_users=args.allow_tailnet_user, hash_record=hash_record, state_dir=args.state_dir,
                              backend=backend, max_sessions=args.max_sessions, pause_after=args.pause_after,
                              remove_after=args.remove_after, min_free_memory=args.min_free_memory,
                              reap_interval=max(1, args.reap_interval))
    except ValueError as error:
        parser.error(str(error))
    import signal
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(f'Terminal service on 127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
