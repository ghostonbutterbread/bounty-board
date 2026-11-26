"""Model relay: the report agent reaches the model API without ever holding the login.

Per sandbox the host listens on ``model.sock`` (0600, in the same host-owned
directory as ``proxy.sock``, mounted read-only at ``/run/bbterm``). A thread
of the in-container forwarder listens on 127.0.0.1:3129 and copies each
connection to that socket; the agent's ``ANTHROPIC_BASE_URL`` points there and
it carries a fixed dummy credential.

For each connection the relay:
- reads one strict HTTP/1.1 request head (deadline, size cap, no folding, no
  Transfer-Encoding, exactly one Content-Length, body cap);
- allows only the methods and paths of the CLI's ``RelayRule`` (Claude Code:
  ``POST /v1/messages`` and ``POST /v1/messages/count_tokens``, query empty or
  ``beta=true``); anything else is 403;
- forwards only allowlisted headers (``Authorization``, ``x-api-key``,
  ``Cookie``, ``Proxy-*`` and hop-by-hop headers are dropped), sets the real
  bearer and the OAuth beta header, and asks for an uncompressed response;
- forwards over verified TLS to ``https://api.anthropic.com`` (the upstream
  can be overridden only by a constructor argument used in tests);
- streams the response back as it arrives (SSE), one request per connection.

Caps: per-session and total concurrency, head deadline, idle timeouts on both
sides, a maximum connection lifetime. Nothing about a request (body, headers,
path) is ever logged, and the token is never written anywhere.
"""
import os
import re
import selectors
import socket
import ssl
import stat
import sys
import threading
import time

HEAD_MAX = 32 * 1024
HEAD_DEADLINE = 20          # seconds for the whole request head
BODY_MAX = 32 * 1024 * 1024
CLIENT_IDLE = 600           # seconds without a byte from the agent while sending the body or waiting
UPSTREAM_IDLE = 600         # seconds without a byte from upstream (Claude Code's own timeout is 600 s)
MAX_LIFETIME = 3600         # one request, start to end
MAX_SESSION = 8             # requests in flight per sandbox (main loop, title, subagents)
MAX_TOTAL = 24              # requests in flight for the whole service
UPSTREAM = ('api.anthropic.com', 443)
OAUTH_BETA = 'oauth-2025-04-20'
TOKEN_RE = re.compile(r'[A-Za-z0-9._~+/=-]{20,2048}')
TOKEN_FILE_MAX = 8192

HEADER_NAME = re.compile(rb'[!#$%&\'*+.^_`|~0-9A-Za-z-]+')
FORWARD_EXACT = {'content-type', 'content-length', 'accept', 'user-agent', 'x-app'}
FORWARD_PREFIX = ('anthropic-', 'x-stainless-', 'x-claude-code-')
DROP_RESPONSE = {'connection', 'keep-alive', 'proxy-connection', 'set-cookie', 'alt-svc'}


def _warn(message):
    print(f'bbterm relay: {message}', file=sys.stderr, flush=True)


class RelayRule:
    """What one CLI may ask the relay for, and how the real credential is set."""

    def __init__(self, *, methods, paths, queries=('', ), upstream=UPSTREAM, betas=()):
        self.methods = frozenset(methods)
        self.paths = frozenset(paths)
        self.queries = frozenset(queries)
        self.upstream = upstream
        self.betas = tuple(betas)

    def allows(self, method, target):
        path, _, query = target.partition('?')
        return method in self.methods and path in self.paths and query in self.queries

    def auth_headers(self, token, incoming_betas):
        betas = [b.strip() for b in incoming_betas.split(',') if b.strip()] if incoming_betas else []
        for beta in self.betas:
            if beta not in betas:
                betas.append(beta)
        headers = [('Authorization', f'Bearer {token}')]
        if betas:
            headers.append(('anthropic-beta', ','.join(betas)))
        return headers


# Captured from Claude Code 2.1.331 against a fake upstream: every model call is
# POST /v1/messages?beta=true. count_tokens is allowed for /context.
CLAUDE_RULE = RelayRule(methods={'POST'}, paths={'/v1/messages', '/v1/messages/count_tokens'},
                        queries=('', 'beta=true'), betas=(OAUTH_BETA,))


# -- token file -----------------------------------------------------------------

class TokenFile:
    """The dedicated login (``claude setup-token``), read on each use so it can be
    created or rotated without a restart. Refused: a symlink, anything but a regular
    file owned by this user, group/other permissions, a path inside the data root."""

    def __init__(self, path, root):
        self.path = None if path is None else os.path.abspath(str(path))
        self.root = os.path.realpath(str(root))

    @staticmethod
    def check_path(path, root):
        """Static checks for the flag (raise ValueError); the file may not exist yet."""
        path = os.path.abspath(str(path))
        real_root = os.path.realpath(str(root))
        real = os.path.realpath(path)
        for candidate in (path, real):
            if candidate == real_root or candidate.startswith(real_root.rstrip('/') + '/'):
                raise ValueError('--report-agent-token-file must be outside --root')
        return path

    def status(self):
        """(ready, reason): reason is None, 'not_configured', 'missing', 'symlink', 'not_a_file',
        'wrong_owner', 'bad_mode', 'inside_root', 'unreadable' or 'invalid'."""
        try:
            self.read()
        except TokenError as error:
            return False, error.code
        return True, None

    def read(self):
        if self.path is None:
            raise TokenError('not_configured')
        try:
            self.check_path(self.path, self.root)
        except ValueError:
            raise TokenError('inside_root') from None
        try:
            info = os.lstat(self.path)
        except FileNotFoundError:
            raise TokenError('missing') from None
        except OSError:
            raise TokenError('unreadable') from None
        if stat.S_ISLNK(info.st_mode):
            raise TokenError('symlink')
        if not stat.S_ISREG(info.st_mode):
            raise TokenError('not_a_file')
        if info.st_uid != os.getuid():
            raise TokenError('wrong_owner')
        if info.st_mode & 0o077:
            raise TokenError('bad_mode')
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            raise TokenError('unreadable') from None
        try:
            again = os.fstat(fd)
            if (again.st_dev, again.st_ino) != (info.st_dev, info.st_ino) or again.st_mode & 0o077:
                raise TokenError('unreadable')
            data = os.read(fd, TOKEN_FILE_MAX + 1)
        finally:
            os.close(fd)
        try:
            token = data.decode('ascii').strip()
        except UnicodeError:
            raise TokenError('invalid') from None
        if len(data) > TOKEN_FILE_MAX or not TOKEN_RE.fullmatch(token):
            raise TokenError('invalid')
        return token


class TokenError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


TOKEN_REASONS = {
    'not_configured': 'No login file is configured (--report-agent-token-file).',
    'missing': 'The login file does not exist yet. Run claude setup-token on Hoster and save the token there.',
    'symlink': 'The login file is a symlink, which is refused.',
    'not_a_file': 'The login file is not a regular file.',
    'wrong_owner': 'The login file is owned by another user.',
    'bad_mode': 'The login file can be read by other users. Run chmod 600 on it.',
    'inside_root': 'The login file is inside the Board data folder, which is refused.',
    'unreadable': 'The login file could not be read.',
    'invalid': 'The login file does not contain a token.',
}


# -- HTTP head parsing --------------------------------------------------------------

class BadRequest(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


def read_head(sock, deadline):
    """Read up to the blank line. Returns (head bytes, leftover body bytes)."""
    buf = b''
    while b'\r\n\r\n' not in buf:
        if len(buf) > HEAD_MAX:
            raise BadRequest(431, 'head_too_large')
        left = deadline - time.monotonic()
        if left <= 0:
            raise BadRequest(408, 'head_timeout')
        sock.settimeout(left)
        try:
            chunk = sock.recv(8192)
        except socket.timeout:
            raise BadRequest(408, 'head_timeout') from None
        if not chunk:
            raise BadRequest(400, 'incomplete_head')
        buf += chunk
    head, rest = buf.split(b'\r\n\r\n', 1)
    if len(head) > HEAD_MAX:
        raise BadRequest(431, 'head_too_large')
    return head, rest


def parse_head(head):
    """Strict HTTP/1.1 request head -> (method, target, [(lower name, value)])."""
    lines = head.split(b'\r\n')
    parts = lines[0].split(b' ')
    if len(parts) != 3 or parts[2] != b'HTTP/1.1' or not parts[0].isalpha() or not parts[1].startswith(b'/'):
        raise BadRequest(400, 'bad_request_line')
    try:
        method, target = parts[0].decode('ascii'), parts[1].decode('ascii')
    except UnicodeError:
        raise BadRequest(400, 'bad_request_line') from None
    if any(c in target for c in '#\\') or any(ord(c) < 0x21 or ord(c) > 0x7e for c in target):
        raise BadRequest(400, 'bad_target')
    headers = []
    for line in lines[1:]:
        if not line or line[:1] in (b' ', b'\t'):
            raise BadRequest(400, 'bad_header')  # empty line inside the head, or obsolete folding
        name, sep, value = line.partition(b':')
        if not sep or not HEADER_NAME.fullmatch(name):
            raise BadRequest(400, 'bad_header')
        value = value.strip(b' \t')
        if any(b < 0x20 and b != 0x09 or b == 0x7f for b in value):
            raise BadRequest(400, 'bad_header')
        try:
            headers.append((name.decode('ascii').lower(), value.decode('latin-1')))
        except UnicodeError:
            raise BadRequest(400, 'bad_header') from None
    return method, target, headers


def content_length(headers):
    if any(name == 'transfer-encoding' for name, _ in headers):
        raise BadRequest(400, 'transfer_encoding')  # Claude Code sends Content-Length; chunked uploads are refused
    values = [value for name, value in headers if name == 'content-length']
    if len(values) != 1 or not re.fullmatch(r'\d{1,10}', values[0]):
        raise BadRequest(411, 'length_required')
    length = int(values[0])
    if length > BODY_MAX:
        raise BadRequest(413, 'body_too_large')
    return length


def forwarded_headers(headers):
    """Only headers a model client needs; credentials, cookies, proxy and hop-by-hop headers never pass."""
    out = []
    for name, value in headers:
        if name in ('authorization', 'x-api-key', 'cookie', 'host', 'anthropic-beta') or name.startswith('proxy-'):
            continue
        if name in FORWARD_EXACT or name.startswith(FORWARD_PREFIX):
            out.append((name, value))
    return out


def simple_response(status, code):
    body = ('{"type": "error", "error": {"type": "relay_error", "message": "%s"}}' % code).encode()
    reason = {400: 'Bad Request', 403: 'Forbidden', 408: 'Request Timeout', 411: 'Length Required',
              413: 'Payload Too Large', 431: 'Request Header Fields Too Large', 502: 'Bad Gateway',
              503: 'Service Unavailable'}.get(status, 'Error')
    return (f'HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n'
            f'Connection: close\r\n\r\n').encode() + body


# -- relay ------------------------------------------------------------------------

def _listen_unix(path):
    try:
        if stat.S_ISSOCK(os.lstat(path).st_mode):
            os.unlink(path)
    except FileNotFoundError:
        pass
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.bind(path)
        os.chmod(path, 0o600)
        sock.listen(16)
    except BaseException:
        sock.close()
        raise
    return sock


def _drain(conn, limit=1024 * 1024):
    """Read what the client already sent before closing, so it gets the answer instead of a reset."""
    try:
        conn.setblocking(False)
        while limit > 0:
            chunk = conn.recv(65536)
            if not chunk:
                return
            limit -= len(chunk)
    except OSError:
        pass


class RelaySession:
    """One sandbox's model.sock. ``gate()`` returns (rule, None) when an agent may use the
    relay now, or (None, (status, code)) otherwise."""

    def __init__(self, relay, path, gate):
        self.relay = relay
        self.gate = gate
        self.sock = _listen_unix(path)
        self.inflight = 0
        self.closed = False
        self.conns = set()
        self.upstreams = set()


class ModelRelay:
    def __init__(self, token, *, upstream=None, ssl_context=None, log=None, max_session=MAX_SESSION,
                 max_total=MAX_TOTAL, head_deadline=HEAD_DEADLINE, client_idle=CLIENT_IDLE,
                 upstream_idle=UPSTREAM_IDLE, max_lifetime=MAX_LIFETIME):
        """``upstream`` (host, port) and ``ssl_context`` are for tests only: the command
        line and the Board cannot reach them."""
        self.token = token  # TokenFile
        self.upstream_override = upstream
        self.ssl_context = ssl_context or ssl.create_default_context()
        self.log = log or _warn
        self.max_session, self.max_total = max_session, max_total
        self.head_deadline, self.client_idle, self.upstream_idle = head_deadline, client_idle, upstream_idle
        self.max_lifetime = max_lifetime
        self.lock = threading.Lock()
        self.total = 0
        self.sessions = set()
        self.selector = selectors.DefaultSelector()
        self.wake_r, self.wake_w = socket.socketpair()
        self.wake_r.setblocking(False)
        self.wake_w.setblocking(False)
        self.selector.register(self.wake_r, selectors.EVENT_READ, None)
        self.closed = False
        self.thread = threading.Thread(target=self._accept_loop, name='bbterm-relay-accept', daemon=True)
        self.thread.start()

    def _wake(self):
        try:
            self.wake_w.send(b'x')
        except (BlockingIOError, OSError):
            pass

    def open_session(self, path, gate):
        rs = RelaySession(self, path, gate)
        with self.lock:
            if self.closed:
                rs.sock.close()
                raise OSError('model relay is shutting down')
            self.sessions.add(rs)
            self.selector.register(rs.sock, selectors.EVENT_READ, rs)
        self._wake()
        return rs

    def close_session(self, rs):
        with self.lock:
            if rs.closed:
                return
            rs.closed = True
            self.sessions.discard(rs)
            try:
                self.selector.unregister(rs.sock)
            except (KeyError, ValueError):
                pass
        try:
            rs.sock.close()
        except OSError:
            pass
        self.cancel(rs)

    def cancel(self, rs):
        """End every request in flight for this sandbox, on both sides (agent stopped, reset, removed)."""
        with self.lock:
            socks = list(rs.conns) + list(rs.upstreams)
        for sock in socks:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        with self.lock:
            sessions = list(self.sessions)
            self.closed = True
        for rs in sessions:
            self.close_session(rs)
        self._wake()
        self.thread.join(timeout=5)
        self.selector.close()
        self.wake_r.close()
        self.wake_w.close()

    def _accept_loop(self):
        while True:
            with self.lock:
                if self.closed:
                    return
            try:
                events = self.selector.select(timeout=1)
            except (OSError, ValueError):
                with self.lock:
                    if self.closed:
                        return
                time.sleep(0.1)
                continue
            for key, _ in events:
                if key.data is None:
                    try:
                        while self.wake_r.recv(64):
                            pass
                    except (BlockingIOError, OSError):
                        pass
                    continue
                rs = key.data
                try:
                    conn, _ = rs.sock.accept()
                except OSError:
                    continue
                try:
                    self._admit(rs, conn)
                except Exception as error:  # e.g. no thread could be started: keep serving the others
                    self.log(f'could not serve a model request: {type(error).__name__}')
                    _drain(conn)
                    conn.close()

    def _admit(self, rs, conn):
        # The gate runs before a slot is taken: a sandbox without a live agent cannot hold slots.
        _, refusal = rs.gate()
        with self.lock:
            full = refusal is None and (rs.closed or rs.inflight >= self.max_session or self.total >= self.max_total)
            if refusal is None and not full:
                rs.inflight += 1
                self.total += 1
                rs.conns.add(conn)
        if refusal is not None or full:
            status, code = refusal or (503, 'busy')
            try:
                conn.settimeout(2)
                conn.sendall(simple_response(status, code))
            except OSError:
                pass
            _drain(conn)
            conn.close()
            return
        try:
            threading.Thread(target=self._serve, args=(rs, conn), name='bbterm-relay', daemon=True).start()
        except BaseException:
            self._release(rs, conn)
            raise

    def _release(self, rs, conn, held=()):
        with self.lock:
            for sock in held:
                rs.upstreams.discard(sock)
            if conn in rs.conns:
                rs.conns.discard(conn)
                rs.inflight -= 1
                self.total -= 1

    def _serve(self, rs, conn):
        held = []
        try:
            self._relay_one(rs, conn, held)
        except BadRequest as error:
            try:
                conn.settimeout(5)
                conn.sendall(simple_response(error.status, error.code))
            except OSError:
                pass
            _drain(conn)
        except (OSError, ssl.SSLError):
            pass  # either side went away; nothing about the request is logged
        finally:
            for sock in held + [conn]:
                try:
                    sock.close()
                except OSError:
                    pass
            self._release(rs, conn, held)

    def _relay_one(self, rs, conn, held):
        start = time.monotonic()
        head, rest = read_head(conn, start + self.head_deadline)
        method, target, headers = parse_head(head)
        rule, refusal = rs.gate()
        if refusal is not None:
            raise BadRequest(*refusal)
        if not rule.allows(method, target):
            raise BadRequest(403, 'not_allowed')
        length = content_length(headers)
        if len(rest) > length:
            raise BadRequest(400, 'extra_bytes')  # one request per connection, no pipelining
        try:
            token = self.token.read()
        except TokenError:
            raise BadRequest(503, 'login_missing') from None
        host, port = self.upstream_override or rule.upstream
        betas = ','.join(value for name, value in headers if name == 'anthropic-beta')
        out = [f'{method} {target} HTTP/1.1', f'Host: {host}' if port == 443 else f'Host: {host}:{port}']
        out += [f'{name}: {value}' for name, value in forwarded_headers(headers)]
        out += [f'{name}: {value}' for name, value in rule.auth_headers(token, betas)]
        out += ['Accept-Encoding: identity', 'Connection: close']
        request_head = ('\r\n'.join(out) + '\r\n\r\n').encode('latin-1')
        del token
        try:
            raw = socket.create_connection((host, port), timeout=30)
        except OSError:
            raise BadRequest(502, 'upstream_unreachable') from None
        held.append(raw)
        with self.lock:
            rs.upstreams.add(raw)
        try:
            upstream = self.ssl_context.wrap_socket(raw, server_hostname=host)
        except (OSError, ssl.SSLError):
            raise BadRequest(502, 'upstream_tls_failed') from None
        held.append(upstream)
        with self.lock:
            rs.upstreams.add(upstream)
        upstream.settimeout(self.upstream_idle)
        upstream.sendall(request_head)
        if rest:
            upstream.sendall(rest)
        left = length - len(rest)
        while left > 0:
            remaining = start + self.max_lifetime - time.monotonic()
            if remaining <= 0:
                raise BadRequest(408, 'body_timeout')
            conn.settimeout(min(self.client_idle, remaining))
            chunk = conn.recv(min(65536, left))
            if not chunk:
                raise BadRequest(400, 'incomplete_body')
            upstream.sendall(chunk)
            left -= len(chunk)
        self._stream_back(upstream, conn, start)

    def _stream_back(self, upstream, conn, start):
        """Response head with Connection rewritten to close, then the body as it arrives."""
        buf = b''
        while b'\r\n\r\n' not in buf:
            if len(buf) > 64 * 1024:
                raise BadRequest(502, 'upstream_bad_response')
            chunk = upstream.recv(16384)
            if not chunk:
                raise BadRequest(502, 'upstream_closed')
            buf += chunk
        head, body = buf.split(b'\r\n\r\n', 1)
        lines = head.split(b'\r\n')
        if not lines[0].startswith(b'HTTP/1.1 ') and not lines[0].startswith(b'HTTP/1.0 '):
            raise BadRequest(502, 'upstream_bad_response')
        kept = [lines[0]]
        for line in lines[1:]:
            name = line.split(b':', 1)[0].strip().lower()
            if name.decode('latin-1') not in DROP_RESPONSE:
                kept.append(line)
        kept.append(b'Connection: close')
        conn.sendall(b'\r\n'.join(kept) + b'\r\n\r\n' + body)
        while time.monotonic() - start < self.max_lifetime:
            chunk = upstream.recv(65536)
            if not chunk:
                return
            conn.sendall(chunk)  # unbuffered: each SSE event goes out as soon as it arrives

