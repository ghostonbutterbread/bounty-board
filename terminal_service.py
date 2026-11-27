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
  GET  /api/settings            terminal settings (preview ports, Tailscale binding)
  POST /api/settings            {ports_tailscale: bool}
  GET  /api/ports?<selector>    preview ports of a report's sandbox
  GET  /api/agent/config        report agent CLI and model choice, login state
  POST /api/agent/config        {cli, model}
  POST /api/agent/start         {selector, task, cli?, model?}  (report agent in the sandbox)
  POST /api/agent/stop          {selector}
  POST /api/agent/login         {cli: "claude", token}  (writes --report-agent-token-file; 4 KiB body cap)
  POST /api/agent/logout        {cli: "claude"}
  GET  /api/agent/session?<selector>  report agent state
  GET  /api/agents/active?<selector>|all=1  Herdr agents to connect to (agent connect)
  GET  /ws?<selector>[&kind=shell|agent]  WebSocket attach (RFC 6455)
  GET  /ws?kind=connect&pane&terminal_id&session_ref  attach to a Herdr agent (agent connect)

Report agent, model relay and agent connect: docs/integrations/report-agent.md.

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
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import terminal_auth
import terminal_checks
import terminal_connect
import terminal_ports
import terminal_report_agent
import terminal_sandbox as sb
import terminal_ws

PREFIX = '/terminal'
MAX_BODY = 64 * 1024
MAX_INPUT = 64 * 1024
VIEWER_QUEUE_BYTES = 4 * 1024 * 1024
PING_INTERVAL = 20
MAX_CONNECTIONS = 64   # identified requests and WebSockets in progress (each viewer holds one)
MAX_ANONYMOUS = 8      # requests without an allowlisted tailnet header or valid session cookie
MAX_PENDING = 128      # connections still sending their request head (oldest evicted first)
REQUEST_DEADLINE = 10  # seconds for the whole request head and body
REQUEST_TIMEOUT = 10   # seconds per socket read or write before the WebSocket upgrade
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
                # Too far behind: drop it now. abort() does not wait for a sender
                # stuck in sendall() to a client that stopped reading.
                self.closed = True
                self.ws.abort()
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
                 idle_timeout=None, reap_interval=10, clock=time.time, mem_available=None,
                 max_connections=MAX_CONNECTIONS, ping_interval=PING_INTERVAL, peer_timeout=PEER_TIMEOUT,
                 max_anonymous=MAX_ANONYMOUS, max_pending=MAX_PENDING, request_deadline=REQUEST_DEADLINE,
                 preview_ports=False, ports_range=terminal_ports.DEFAULT_RANGE, tailscale_address='auto',
                 tailscale=None, ports_refresh=terminal_ports.TAILSCALE_REFRESH,
                 ports_same=terminal_ports.parse_same_ranges(terminal_ports.DEFAULT_SAME), host_ports=None,
                 report_agent=None, agent_connect=None):
    """``tailscale`` (a terminal_ports.TailscaleAddress) and ``host_ports`` are for tests only;
    the command line reaches ``tailscale_address``. ``report_agent`` is a
    terminal_report_agent.ReportAgentHub and ``agent_connect`` a
    terminal_connect.ConnectHub (both off when None)."""
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
    ports_range = tuple(ports_range)
    if ports_range[0] <= port <= ports_range[1]:
        raise ValueError('--ports-range must not contain the service port')
    ports = None
    if preview_ports:
        ports = terminal_ports.PortsHub(state_dir=state_dir, ports_range=ports_range, exclude={port},
                                        tailscale=tailscale or terminal_ports.TailscaleAddress(tailscale_address),
                                        refresh_interval=ports_refresh, same_ranges=ports_same,
                                        host_ports=host_ports or terminal_ports.host_listening_ports)
    # Off: no ports.sock, no listeners, no agent connection.
    if backend is not None and hasattr(backend, 'ports_hub'):
        backend.ports_hub = ports
    checks = terminal_checks.CheckStore(state_dir / 'checks.sqlite3')
    manager = sb.SessionManager(root, backend, max_sessions=max_sessions, pause_after=pause_after,
                                remove_after=idle_timeout if idle_timeout is not None else remove_after,
                                min_free_memory=min_free_memory, reap_interval=reap_interval, mem_available=mem_available)
    # Report agent and agent connect (docs/integrations/report-agent.md): off unless given.
    agent_hub = report_agent or terminal_report_agent.ReportAgentHub(enabled=False, root=root, state_dir=state_dir)
    if agent_hub.enabled:
        agent_hub.clock = manager.clock
        manager.agent_hub = agent_hub
        if backend is not None and hasattr(backend, 'agent_hub'):
            backend.agent_hub = agent_hub
    connect_hub = agent_connect or terminal_connect.ConnectHub(enabled=False, root=root)
    def settings_payload():
        if ports is None:
            return terminal_ports.disabled_settings(ports_range)
        return ports.settings_payload()

    def ports_flags():
        current = settings_payload()
        return {'preview_ports': current['preview_ports'], 'ports_tailscale': current['ports_tailscale']}

    login_html = (STATIC / 'login.html').read_bytes()
    login_js = (STATIC / 'login.js').read_bytes()
    login_css = (STATIC / 'login.css').read_bytes()

    class Handler(BaseHTTPRequestHandler):
        """One request per connection. Admission (review N1):

        - until its head is parsed a connection is *pending*; the server evicts
          the oldest pending connection when MAX_PENDING are waiting, so slow
          heads cannot pile up;
        - the head and body together must arrive within REQUEST_DEADLINE
          (a watchdog shuts the socket), and every read or write times out
          after REQUEST_TIMEOUT until a WebSocket upgrade raises it;
        - after the head is parsed, requests with an allowlisted tailnet header
          or a valid session cookie take one of MAX_CONNECTIONS slots, all
          others one of MAX_ANONYMOUS, so anonymous traffic can never take the
          slots identified users and WebSockets need.
        """
        server_version = 'bbterm'
        sys_version = ''
        protocol_version = 'HTTP/1.1'
        timeout = REQUEST_TIMEOUT

        def setup(self):
            super().setup()
            self._slot = None
            self._watchdog = threading.Timer(request_deadline, self._expire)
            self._watchdog.daemon = True
            self._watchdog.start()

        def _expire(self):
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        def request_ready(self):
            """Head and body are in: the request deadline no longer applies."""
            self._watchdog.cancel()

        def handle(self):
            self.close_connection = True
            self.handle_one_request()

        def parse_request(self):
            if not super().parse_request():
                return False
            self.server.leave_pending(self.connection)
            user, _ = auth.identify(self.headers)
            slots = self.server.identified_slots if user else self.server.anonymous_slots
            if not slots.acquire(blocking=False):
                self.close_connection = True
                self.reply(503, {'error': 'busy', 'message': 'The terminal service is busy. Try again in a moment.'})
                return False
            self._slot = slots
            return True

        def finish(self):
            try:
                super().finish()
            finally:
                self._watchdog.cancel()
                self.server.leave_pending(self.connection)
                if self._slot is not None:
                    self._slot.release()
                    self._slot = None

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
            # One request per connection (admission is per request): say so, or a
            # keep-alive proxy such as Tailscale Serve reuses a closed socket and
            # non-retried POSTs fail with 502 (security review 2, N4).
            self.send_header('Connection', 'close')
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
            self.send_header('Connection', 'close')
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

        def query_params(self):
            try:
                params = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=8)
            except ValueError:
                raise sb.SandboxError('bad_selector', 'Report selector is invalid.') from None
            if any(len(v) != 1 for v in params.values()):
                raise sb.SandboxError('bad_selector', 'Report selector is invalid.')
            return {k: v[0] for k, v in params.items()}

        def selector_from_query(self):
            return sb.clean_selector(self.query_params())

        def read_json(self, limit=MAX_BODY):
            if self.headers.get('X-Requested-With') != 'Bounty-Board':
                return None, 'csrf'
            if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
                return None, 'content_type'
            try:
                length = int(self.headers.get('Content-Length') or '0')
            except ValueError:
                return None, 'length'
            if not 0 < length <= limit:
                return None, 'length'
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                return None, 'json'
            return (body, None) if isinstance(body, dict) else (None, 'json')

        # -- GET -----------------------------------------------------------
        def do_GET(self):
            self.request_ready()
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
                                        'max_sessions': manager.max_sessions, **ports_flags(),
                                        'report_agent': agent_hub.enabled, 'agent_connect': connect_hub.enabled})
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
                if path == '/api/settings':
                    return self.reply(200, settings_payload())
                if path == '/api/ports':
                    session = manager.get(self.selector_from_query())
                    items = session.ports.items() if session is not None and session.ports is not None else []
                    return self.reply(200, {'ports': items, **ports_flags()})
                if path == '/api/session':
                    session = manager.get(self.selector_from_query())
                    return self.reply(200, {'session': session.info() if session else None})
                handled = (agent_hub.handle_get(manager, path, self.selector_from_query)
                           or connect_hub.handle_get(path, self.query_params()))
                if handled:
                    return self.reply(*handled)
            except sb.SandboxError as error:
                return self.reply(400, {'error': error.code, 'message': error.message})
            return self.reply(404, {'error': 'not_found'})

        # -- POST ----------------------------------------------------------
        def do_POST(self):
            path = self.route()
            if not self.host_ok() or not self.origin_ok(required=True):
                return self.reply(403, {'error': 'forbidden'})
            # The login routes carry a token: a small body cap (4 KiB).
            small = path in ('/api/agent/login', '/api/agent/logout')
            body, problem = self.read_json(terminal_report_agent.LOGIN_BODY_MAX if small else MAX_BODY)
            self.request_ready()
            if problem:
                return self.reply(400 if problem != 'csrf' else 403, {'error': problem})
            if path == '/api/login':
                sid, error = auth.login(body.get('username', ''), body.get('password', ''))
                if error:
                    status = {'locked': 429, 'busy': 429, 'disabled': 403}.get(error, 401)
                    return self.reply(status, {'error': error, 'message': {
                        'locked': 'Too many failed attempts. Try again in 15 minutes.',
                        'busy': 'Too many sign-in attempts at once. Try again in a moment.',
                        'disabled': 'Password sign-in is not configured.'}.get(error, 'Wrong username or password.')})
                return self.reply(200, {'ok': True}, [('Set-Cookie', auth.session_cookie(sid))])
            if path == '/api/logout':
                auth.logout(self.headers)
                return self.reply(200, {'ok': True}, [('Set-Cookie', auth.clear_cookie())])
            user, _ = self.identity()
            if not user:
                return self.reply(401, {'error': 'login_required', 'login_url': f'{PREFIX}/login'})
            if path == '/api/settings':
                return self.post_settings(body)
            handled = agent_hub.handle_post(manager, path, body)
            if handled:
                return self.reply(*handled)
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

        def post_settings(self, body):
            if set(body) != {'ports_tailscale'} or not isinstance(body['ports_tailscale'], bool):
                return self.reply(400, {'error': 'bad_request'})
            if ports is None:
                return self.reply(409, {'error': 'preview_ports_disabled',
                                        'message': 'Preview ports are off (start the terminal service with --preview-ports).'})
            try:
                return self.reply(200, ports.set_tailscale(body['ports_tailscale']))
            except terminal_ports.PortsError as error:
                status = 409 if error.code == 'tailscale_not_found' else 500
                return self.reply(status, {'error': error.code, 'message': error.message})
            except OSError:
                return self.reply(500, {'error': 'settings_failed', 'message': 'The settings could not be saved.'})

        def do_PUT(self):
            self.request_ready()
            self.reply(405, {'error': 'method_not_allowed'})

        do_DELETE = do_PATCH = do_PUT

        def do_OPTIONS(self):
            self.request_ready()
            self.reply(405, {'error': 'method_not_allowed'})  # no CORS, ever

        # -- WebSocket -----------------------------------------------------
        def websocket(self):
            if not self.origin_ok(required=True):
                return self.reply(403, {'error': 'forbidden'})
            query = self.query_params()
            # kind=shell (default) attaches the report's shell; kind=agent the report
            # agent's PTY; kind=connect a Herdr agent on the host (agent connect).
            kind = query.pop('kind', 'shell')
            if kind in ('shell', 'agent'):
                sel = sb.clean_selector(query)
            elif kind == 'connect':
                try:
                    terminal_connect.ConnectHub.check_params(query)
                except terminal_connect.ConnectError as error:
                    return self.reply(error.status, error.payload())
            else:
                return self.reply(400, {'error': 'bad_kind'})
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
            # Sends and reads both time out: a client that stops reading cannot pin
            # this thread in sendall(), and a silent one (no pongs) is dropped.
            self.connection.settimeout(peer_timeout)
            _, method = self.identity()
            ws = terminal_ws.WebSocket(self.rfile, self.connection, max_frame=256 * 1024, max_message=256 * 1024)
            viewer = Viewer(ws)
            try:
                if kind == 'shell':
                    target = ShellTarget(sel, manager.attach(sel, viewer), viewer)
                elif kind == 'agent':
                    target = agent_hub.attach(manager, sel, viewer)
                else:
                    target = connect_hub.attach(query, viewer)
            except Exception as error:
                if isinstance(error, (sb.SandboxError, terminal_report_agent.AgentError, terminal_connect.ConnectError)):
                    code, message = error.code, error.message
                else:
                    code, message = 'sandbox_failed', 'The sandbox could not start.'
                viewer.send_control({'type': 'error', 'code': code, 'message': message})
                viewer.close()
                # Give the client 5 s to answer the close, then drop the connection.
                self.connection.settimeout(5)
                ws.recv()
                ws.abort()
                return
            stop = threading.Event()

            def pinger():
                while not stop.wait(ping_interval):
                    if time.monotonic() - ws.last_received > peer_timeout:
                        ws.abort()
                        return
                    if method == 'password' and not auth.session_user(self.headers):
                        # Signed out or expired: an open terminal must not outlive the session.
                        viewer.send_control({'type': 'closed', 'message': 'Signed out. Sign in again to use the terminal.'})
                        ws.close(1008, 'signed out')
                        time.sleep(0.5)
                        ws.abort()
                        return
                    ws.ping()
            threading.Thread(target=pinger, daemon=True).start()
            try:
                while True:
                    message = ws.recv()
                    if message is None:
                        break
                    kind_, data = message
                    if kind_ != 'text':
                        continue
                    try:
                        command = json.loads(data)
                    except ValueError:
                        continue
                    if not isinstance(command, dict):
                        continue
                    if not target.alive():
                        break  # the session was closed (idle, evicted, stopped)
                    if command.get('t') == 'in' and isinstance(command.get('d'), str) and len(command['d']) <= MAX_INPUT:
                        target.write(command['d'].encode('utf-8', 'replace'))
                    elif command.get('t') == 'resize':
                        cols, rows = command.get('cols'), command.get('rows')
                        if type(cols) is int and type(rows) is int and 2 <= cols <= 500 and 2 <= rows <= 300:
                            target.resize(cols, rows)
            finally:
                stop.set()
                target.detach()
                viewer.close()

    class ShellTarget:
        """The report's shell session, for the WebSocket loop."""

        def __init__(self, sel, session, viewer):
            self.sel, self.session, self.viewer = sel, session, viewer

        def alive(self):
            return manager.get(self.sel) is self.session

        def write(self, data):
            self.session.write(data)

        def resize(self, cols, rows):
            self.session.resize(cols, rows)

        def detach(self):
            manager.detach(self.session, self.viewer)

    class Server(ThreadingHTTPServer):
        """Thread per connection with bounded admission (see Handler)."""
        daemon_threads = True

        def process_request(self, request, client_address):
            with self.pending_lock:
                self.pending[request] = time.monotonic()
                while len(self.pending) > self.max_pending:
                    oldest = next(iter(self.pending))
                    del self.pending[oldest]
                    try:
                        oldest.shutdown(socket.SHUT_RDWR)  # still sending its head: anonymous by definition
                    except OSError:
                        pass
            super().process_request(request, client_address)

        def leave_pending(self, connection):
            with self.pending_lock:
                self.pending.pop(connection, None)

        def handle_error(self, request, client_address):
            if not isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
                super().handle_error(request, client_address)

        def server_close(self):
            try:
                manager.close()
                checks.close()
                if ports is not None:
                    ports.close()
                agent_hub.close()
                connect_hub.close()
            finally:
                super().server_close()

    server = Server(('127.0.0.1', port), Handler)
    server.identified_slots = threading.BoundedSemaphore(max_connections)
    server.anonymous_slots = threading.BoundedSemaphore(max_anonymous)
    server.pending, server.pending_lock, server.max_pending = {}, threading.Lock(), max_pending
    server.manager, server.auth, server.checks, server.ports = manager, auth, checks, ports
    server.report_agent, server.agent_connect = agent_hub, connect_hub
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


def agent_flags(parser):
    """Report agent, model relay and agent connect (docs/integrations/report-agent.md). All off by default."""
    parser.add_argument('--report-agent', action='store_true',
                        help='allow a coding CLI (Claude Code) to run in a report\'s sandbox through the model relay')
    parser.add_argument('--report-agent-cli', action='append', default=[], metavar='ID=PATH',
                        help='host binary of a CLI (claude, codex, omp, opencode); symlinks are resolved at sandbox start')
    parser.add_argument('--report-agent-skill', action='append', default=[], metavar='NAME=PATH',
                        help='skill folder mounted read-only for the agent (repeatable; no symlinks)')
    parser.add_argument('--report-agent-skills-dir', type=Path, metavar='PATH',
                        help='every skill in this folder (e.g. ~/.claude/skills; top-level symlinks resolved once) is '
                             'copied, stripped, into one read-only tree for the agent')
    parser.add_argument('--report-agent-token-file', type=Path,
                        help='0600 file with the dedicated login from "claude setup-token" (outside --root)')
    parser.add_argument('--agent-connect', action='store_true',
                        help='allow attaching to agents running in Herdr on this host (host access through the agent)')
    parser.add_argument('--herdr-bin', type=Path, default=Path(terminal_connect.default_herdr_bin()))
    parser.add_argument('--herdr-session', help='Herdr session name (required with --agent-connect)')


def build_agent_hubs(args):
    """(ReportAgentHub or None, ConnectHub or None) from the flags; ValueError for bad flags."""
    import terminal_agent_cli
    import terminal_relay
    report_agent = agent_connect = None
    if args.report_agent:
        clis = terminal_agent_cli.parse_cli_flags(args.report_agent_cli)
        skills = terminal_agent_cli.parse_skill_flags(args.report_agent_skill)
        token = None
        if args.report_agent_token_file is not None:
            token = terminal_relay.TokenFile.check_path(args.report_agent_token_file, args.root)
            if os.path.islink(token):
                raise ValueError('--report-agent-token-file must not be a symlink')
        skills_dir = None
        if args.report_agent_skills_dir is not None:
            skills_dir = os.path.abspath(str(args.report_agent_skills_dir))
            terminal_agent_cli.check_skills_dir(skills_dir)
        report_agent = terminal_report_agent.ReportAgentHub(enabled=True, root=args.root, state_dir=args.state_dir,
                                                            clis=clis, skills=skills, skills_dir=skills_dir, token_file=token)
    elif args.report_agent_cli or args.report_agent_skill or args.report_agent_token_file or args.report_agent_skills_dir:
        raise ValueError('--report-agent-cli, --report-agent-skill, --report-agent-skills-dir and --report-agent-token-file '
                         'need --report-agent')
    if args.agent_connect:
        if not args.herdr_session or not terminal_connect.SESSION_NAME_RE.fullmatch(args.herdr_session):
            raise ValueError('--agent-connect needs --herdr-session NAME (letters, digits, _ . -)')
        agent_connect = terminal_connect.ConnectHub(enabled=True, root=args.root,
                                                    herdr=terminal_connect.Herdr(args.herdr_bin, args.herdr_session),
                                                    pty_env=connect_env())
    return report_agent, agent_connect


def connect_env():
    """Environment for the Herdr attach client: what it needs to find its socket and draw."""
    keep = ('HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR')
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env['TERM'] = 'xterm-256color'
    return env


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
    parser.add_argument('--preview-ports', action='store_true',
                        help='forward ports that a sandbox listens on to host ports (127.0.0.1, plus Tailscale when '
                             'switched on in Settings)')
    parser.add_argument('--ports-range', default='9100-9199', help='host ports for preview ports (default 9100-9199)')
    parser.add_argument('--ports-same', default=terminal_ports.DEFAULT_SAME,
                        help='on Tailscale, give a sandbox port its own number when free and in these ranges '
                             f'(default {terminal_ports.DEFAULT_SAME}; empty turns it off)')
    parser.add_argument('--tailscale-address', default='auto',
                        help='"auto" (an address in 100.64.0.0/10, tailscale0 first) or that IPv4 address')
    agent_flags(parser)
    args = parser.parse_args(argv)
    try:
        args.ports_range = terminal_ports.parse_range(args.ports_range)
        args.ports_same = terminal_ports.parse_same_ranges(args.ports_same)
        args.tailscale_address = terminal_ports.parse_tailscale_address(args.tailscale_address)
    except ValueError as error:
        parser.error(str(error))
    if args.ports_range[0] <= args.port <= args.ports_range[1]:
        parser.error('--ports-range must not contain the service port')
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
    try:
        report_agent, agent_connect = build_agent_hubs(args)
    except ValueError as error:
        parser.error(str(error))
    tailscale = host_ports = None
    if args.backend == 'local-test-only':
        tmp = os.path.realpath(os.environ.get('TMPDIR', '/nonexistent'))
        if os.environ.get('BBTERM_ALLOW_LOCAL_BACKEND') != '1' or not os.path.realpath(args.root).startswith(tmp + '/'):
            parser.error('the local backend is for tests only (needs BBTERM_ALLOW_LOCAL_BACKEND=1 and a root under TMPDIR)')
        backend = sb.LocalBackend(args.state_dir / 'local')  # ports_hub is set by make_service
        test_tailscale = os.environ.get('BBTERM_TEST_TAILSCALE_FILE')
        if test_tailscale:
            # TEST ONLY, behind the local-backend gate above: the "Tailscale address" is the
            # loopback alias named in this file (empty file: no address). Browser fixtures use
            # it to switch Tailscale on and off; the Docker backend never reads it.
            def alias():
                try:
                    return Path(test_tailscale).read_text().strip() or None
                except OSError:
                    return None
            tailscale = terminal_ports.TailscaleAddress(
                networks=[ipaddress.ip_network('127.0.0.0/8')], addresses=lambda: {a for a in [alias()] if a},
                interfaces=lambda: ['tailscale0'], interface=lambda name: alias())
        test_sandbox_ports = os.environ.get('BBTERM_TEST_SANDBOX_PORTS')
        if test_sandbox_ports:
            # TEST ONLY, same gate: the local backend's "sandbox servers" are host processes,
            # so the host-listener scan would see them; in Docker they are in the container.
            ignored = {int(n) for n in test_sandbox_ports.split(',') if n.strip().isdigit()}
            host_ports = lambda exclude: terminal_ports.host_listening_ports(exclude) - ignored  # noqa: E731
    else:
        import terminal_proxy
        backend = sb.DockerBackend(image=args.image, state_dir=args.state_dir, proxy=terminal_proxy.FilteringProxy(),
                                   prefix=args.container_prefix, memory=args.memory, cpus=args.cpus, pids=args.pids)
    try:
        server = make_service(args.root, port=args.port, allowed_origins=args.allowed_origin,
                              allowed_users=args.allow_tailnet_user, hash_record=hash_record, state_dir=args.state_dir,
                              backend=backend, max_sessions=args.max_sessions, pause_after=args.pause_after,
                              remove_after=args.remove_after, min_free_memory=args.min_free_memory,
                              reap_interval=max(1, args.reap_interval), preview_ports=args.preview_ports,
                              ports_range=args.ports_range, tailscale_address=args.tailscale_address, tailscale=tailscale,
                              ports_same=args.ports_same, host_ports=host_ports,
                              report_agent=report_agent, agent_connect=agent_connect)
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
