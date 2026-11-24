"""Filtering forward proxy for per-session sandbox egress (stdlib only).

Sandbox containers run with ``--network none``; their only egress is this
proxy, served on one Unix socket per session and exposed in-container as
127.0.0.1:3128.  One socket speaks both SOCKS5 (first byte 0x05) and HTTP
proxy protocol (CONNECT, plus absolute-form ``http://`` requests).

Boundary: every connection resolves its destination once, refuses it if ANY
resolved address is non-global (loopback, RFC1918, link-local/metadata,
CGNAT/Tailscale, ULA, multicast, reserved, or a v6 form embedding such a v4),
and then connects only to those vetted addresses (no re-resolution, so DNS
rebinding cannot swap the target).  All ports 1-65535 are allowed; the address
filter is the boundary.

Limitations: only proxy-aware TCP clients work.  Raw TCP/UDP, ICMP and DNS
from the container do not (network none); names are resolved here, so
clients should use ``socks5h://`` or HTTP proxying.  Absolute-form HTTP
requests are served one per connection (``Connection: close`` is forced).
Plain HTTP ``Upgrade`` is not supported.
"""
from __future__ import annotations

import ipaddress
import os
import select
import socket
import stat
import threading
import time
import urllib.parse

__all__ = ['Refused', 'address_allowed', 'resolve', 'FilteringProxy']

CGNAT = ipaddress.ip_network('100.64.0.0/10')
TAILSCALE_V6 = ipaddress.ip_network('fd7a:115c:a1e0::/48')
NAT64 = ipaddress.ip_network('64:ff9b::/96')
EXPLICIT_BLOCKS = (CGNAT, TAILSCALE_V6)

MAX_HEAD = 64 * 1024
MAX_HEADERS = 100
HOP_BY_HOP = frozenset({'proxy-connection', 'proxy-authorization', 'connection', 'keep-alive',
                        'te', 'trailer', 'upgrade'})
NEVER_DROP = frozenset({'host', 'content-length', 'transfer-encoding'})
HTTP_ERRORS = {'resolve_failed': (502, 'Bad Gateway'), 'connect_refused': (502, 'Bad Gateway'),
               'connect_failed': (502, 'Bad Gateway'), 'connect_timeout': (504, 'Gateway Timeout')}
SOCKS_ERRORS = {'resolve_failed': 0x04, 'connect_refused': 0x05, 'connect_failed': 0x04,
                'connect_timeout': 0x04}  # anything else: 0x02 (not allowed by ruleset)


class Refused(Exception):
    """Destination refused or unreachable; ``reason`` is a short machine string."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class _HttpError(Exception):
    def __init__(self, status, text, detail):
        super().__init__(detail)
        self.status, self.text, self.detail = status, text, detail


def _contains(net, ip):
    return ip.version == net.version and ip in net


def address_allowed(ip, allow_networks=()) -> bool:
    """True only for globally routable unicast addresses (plus test-only overrides)."""
    if not isinstance(ip, (ipaddress.IPv4Address, ipaddress.IPv6Address)):
        ip = ipaddress.ip_address(ip)
    if any(_contains(net, ip) for net in allow_networks):
        return True
    if ip.is_multicast or not ip.is_global or any(_contains(n, ip) for n in EXPLICIT_BLOCKS):
        return False
    if ip.version == 6:
        embedded = [ip.ipv4_mapped, ip.sixtofour, *(ip.teredo or ())]
        if ip in NAT64:
            embedded.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
        if any(v4 is not None and not address_allowed(v4) for v4 in embedded):
            return False
    return True


def resolve(host, port, *, allow_networks=(), static_hosts=None, resolver=socket.getaddrinfo):
    """Resolve and vet ``host``; return [(family, sockaddr)] to connect to verbatim."""
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise Refused('bad_port')
    if not isinstance(host, str):
        raise Refused('bad_host')
    if host.startswith('[') and host.endswith(']'):
        host = host[1:-1]
    if not host or len(host) > 253 or any(c.isspace() or c == '\0' for c in host):
        raise Refused('bad_host')
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is None and static_hosts and host.lower() in static_hosts:
        literal = ipaddress.ip_address(static_hosts[host.lower()])
    if literal is not None:
        if not address_allowed(literal, allow_networks):
            raise Refused('blocked_address')
        return [_sockaddr(literal, port)]
    try:
        name = host.encode('idna').decode('ascii')
    except UnicodeError:
        raise Refused('bad_host') from None
    try:
        infos = resolver(name, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        raise Refused('resolve_failed') from None
    out = []
    for family, _type, _proto, _canon, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip = ipaddress.ip_address(sockaddr[0])
        if not address_allowed(ip, allow_networks):
            raise Refused('blocked_address')  # any bad answer poisons the whole name
        entry = _sockaddr(ip, port)
        if entry not in out:
            out.append(entry)
    if not out:
        raise Refused('resolve_failed')
    return out


def _sockaddr(ip, port):
    if ip.version == 4:
        return socket.AF_INET, (str(ip), port)
    return socket.AF_INET6, (str(ip), port, 0, 0)


def _split_hostport(authority):
    if authority.startswith('['):
        end = authority.find(']')
        if end < 0 or authority[end + 1:end + 2] != ':':
            raise _HttpError(400, 'Bad Request', 'bad authority')
        host, port = authority[1:end], authority[end + 2:]
    else:
        host, sep, port = authority.rpartition(':')
        if not sep:
            raise _HttpError(400, 'Bad Request', 'missing port')
    if not (port.isascii() and port.isdigit() and len(port) <= 5):
        raise _HttpError(400, 'Bad Request', 'bad port')
    return host, int(port)


def _parse_head(raw):
    lines = raw.decode('latin-1').split('\r\n')
    request = lines[0].split(' ')
    if len(request) != 3 or not request[2].startswith('HTTP/1.'):
        raise _HttpError(400, 'Bad Request', 'bad request line')
    headers = []
    for line in lines[1:]:
        name, sep, value = line.partition(':')
        if not sep or not name or any(c in name for c in ' \t'):
            raise _HttpError(400, 'Bad Request', 'bad header line')
        headers.append((name, value.strip()))
    if len(headers) > MAX_HEADERS:
        raise _HttpError(431, 'Request Header Fields Too Large', 'too many headers')
    return request[0], request[1], request[2], headers


def _origin_request(method, target, version, headers):
    """Rewrite an absolute-form http:// request to origin-form; return (host, port, head)."""
    parts = urllib.parse.urlsplit(target)
    scheme = parts.scheme.lower()
    if scheme == 'https':
        raise _HttpError(400, 'Bad Request', 'use CONNECT for https')
    if scheme != 'http' or not parts.netloc or '@' in parts.netloc:
        raise _HttpError(400, 'Bad Request', 'absolute-form http:// URL required')
    try:
        host, port = parts.hostname, parts.port or 80
    except ValueError:
        raise _HttpError(400, 'Bad Request', 'bad port') from None
    if not host:
        raise _HttpError(400, 'Bad Request', 'missing host')
    path = (parts.path or '/') + (f'?{parts.query}' if parts.query else '')
    listed = {t.strip().lower() for n, v in headers if n.lower() == 'connection' for t in v.split(',')}
    drop = HOP_BY_HOP | (listed - NEVER_DROP)
    kept = [(n, v) for n, v in headers if n.lower() not in drop]
    if not any(n.lower() == 'host' for n, _ in kept):
        kept.insert(0, ('Host', parts.netloc))
    lines = [f'{method} {path} {version}', *(f'{n}: {v}' for n, v in kept), 'Connection: close', '', '']
    return host, port, '\r\n'.join(lines).encode('latin-1')


class _Reader:
    def __init__(self, sock):
        self.sock, self.buf = sock, b''

    def fill(self):
        data = self.sock.recv(65536)
        if not data:
            raise EOFError
        self.buf += data

    def exact(self, n):
        while len(self.buf) < n:
            self.fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def head(self, limit):
        while True:
            end = self.buf.find(b'\r\n\r\n')
            if end >= 0 and end + 4 <= limit:
                out, self.buf = self.buf[:end], self.buf[end + 4:]
                return out
            if end >= 0 or len(self.buf) >= limit:
                raise _HttpError(431, 'Request Header Fields Too Large', 'request head too large')
            self.fill()


class _Listener:
    def __init__(self, proxy, sock, path):
        self.proxy, self.sock, self.path = proxy, sock, path
        self.closed = False
        self._ino = os.lstat(path).st_ino
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f'proxy-accept:{path}')
        self._thread.start()

    def _loop(self):
        try:
            while not self.closed:
                try:
                    conn, _ = self.sock.accept()
                except TimeoutError:
                    continue
                except OSError:
                    if not self.closed:
                        time.sleep(0.05)
                    continue
                if self.closed:  # raced with close(); the loop exits within one accept timeout
                    conn.close()
                    break
                self.proxy._spawn(conn, self)
        finally:
            self.sock.close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            st = os.lstat(self.path)
            if stat.S_ISSOCK(st.st_mode) and st.st_ino == self._ino:
                os.unlink(self.path)
        except OSError:
            pass
        self.proxy._close_owner(self)


class FilteringProxy:
    def __init__(self, *, allow_networks=(), static_hosts=None, connect_timeout=10, idle_timeout=600,
                 max_connections=64, log=None, resolver=socket.getaddrinfo):
        self.allow_networks = tuple(allow_networks)
        self.static_hosts = {k.lower(): v for k, v in (static_hosts or {}).items()}
        self.connect_timeout, self.idle_timeout = connect_timeout, idle_timeout
        self.max_connections = max_connections
        self.resolver = resolver  # test hook; production uses socket.getaddrinfo
        self._log = log or (lambda _msg: None)
        self._lock = threading.Lock()
        self._conns = {}  # client socket -> record {'owner', 'socks', 'dead'}
        self._listeners = []
        self._closed = False

    # -- lifecycle -------------------------------------------------------
    def listen_unix(self, path):
        try:
            if stat.S_ISSOCK(os.lstat(path).st_mode):
                os.unlink(path)
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.bind(path)
            os.chmod(path, 0o666)
            sock.listen(64)
            sock.settimeout(0.25)
            listener = _Listener(self, sock, path)
        except BaseException:
            sock.close()
            raise
        with self._lock:
            self._listeners.append(listener)
        return listener

    def close(self):
        with self._lock:
            self._closed = True
            listeners, self._listeners = self._listeners, []
        for listener in listeners:
            listener.close()
        self._close_owner(None, everything=True)

    def _close_owner(self, owner, everything=False):
        with self._lock:
            records = [r for r in self._conns.values() if everything or r['owner'] is owner]
            for rec in records:
                rec['dead'] = True
                for s in rec['socks']:
                    _shutdown(s)

    def _admit(self, conn, owner):
        with self._lock:
            if self._closed or len(self._conns) >= self.max_connections:
                return False
            self._conns[conn] = {'owner': owner, 'socks': [conn], 'dead': False}
            return True

    def _add_upstream(self, conn, upstream):
        with self._lock:
            rec = self._conns[conn]
            rec['socks'].append(upstream)
            if rec['dead']:
                _shutdown(upstream)

    def _spawn(self, conn, owner):
        if not self._admit(conn, owner):
            self._reject(conn)
            return
        threading.Thread(target=self._run, args=(conn,), daemon=True).start()

    def _reject(self, conn):
        self._log('connection rejected: max_connections')
        try:
            conn.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        except OSError:
            pass
        conn.close()

    def handle(self, conn):
        """Serve one client connection (blocking)."""
        if not self._admit(conn, None):
            self._reject(conn)
            return
        self._run(conn)

    def _run(self, conn):
        try:
            conn.settimeout(self.idle_timeout)
            reader = _Reader(conn)
            reader.fill()
            if reader.buf[0] == 0x05:
                self._serve_socks(conn, reader)
            else:
                self._serve_http(conn, reader)
        except (EOFError, OSError, ValueError):
            pass  # client went away, timed out, or the connection was closed under us
        except Exception as exc:  # pragma: no cover - defensive; keep the accept loop alive
            self._log(f'proxy error: {type(exc).__name__}')
        finally:
            with self._lock:
                rec = self._conns.pop(conn, None)
            for s in (rec['socks'] if rec else [conn]):
                _shutdown(s)
                s.close()

    # -- shared ------------------------------------------------------------
    def _open(self, conn, host, port, proto):
        try:
            addrs = resolve(host, port, allow_networks=self.allow_networks,
                            static_hosts=self.static_hosts, resolver=self.resolver)
            upstream = self._connect(addrs)
        except Refused as exc:
            self._log(f'{proto} {host!r}:{port} refused {exc.reason}')
            raise
        self._add_upstream(conn, upstream)
        self._log(f'{proto} {host!r}:{port} connected')
        return upstream

    def _connect(self, addrs):
        reason = 'connect_failed'
        for family, sockaddr in addrs:
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.settimeout(self.connect_timeout)
            try:
                sock.connect(sockaddr)
                sock.settimeout(self.idle_timeout)
                return sock
            except TimeoutError:
                reason = 'connect_timeout'
            except ConnectionRefusedError:
                reason = 'connect_refused'
            except OSError:
                reason = 'connect_failed'
            sock.close()
        raise Refused(reason)

    def _relay(self, a, b):
        peer = {a.fileno(): (a, b), b.fileno(): (b, a)}
        poller = select.poll()
        for fd in peer:
            poller.register(fd, select.POLLIN)
        while peer:
            events = poller.poll(self.idle_timeout * 1000)
            if not events:
                return  # idle timeout; _run closes both sides
            for fd, _ev in events:
                src, dst = peer[fd]
                try:
                    data = src.recv(65536)
                except (BlockingIOError, InterruptedError):
                    continue
                if not data:
                    poller.unregister(fd)
                    del peer[fd]
                    _shutdown(dst, socket.SHUT_WR)
                    continue
                dst.sendall(data)

    # -- HTTP ----------------------------------------------------------------
    def _serve_http(self, conn, reader):
        try:
            method, target, version, headers = _parse_head(reader.head(MAX_HEAD))
            if method == 'CONNECT':
                host, port = _split_hostport(target)
                upstream = self._open(conn, host, port, 'http-connect')
                conn.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
                if reader.buf:
                    upstream.sendall(reader.buf)
            else:
                host, port, head = _origin_request(method, target, version, headers)
                upstream = self._open(conn, host, port, 'http')
                upstream.sendall(head + reader.buf)
        except _HttpError as exc:
            self._log(f'http rejected {exc.status} {exc.detail}')
            return self._http_error(conn, exc.status, exc.text, f'{exc.detail}\n')
        except Refused as exc:
            status, text = HTTP_ERRORS.get(exc.reason, (403, 'Forbidden'))
            body = (f'Blocked by sandbox egress policy: {exc.reason}\n' if status == 403
                    else f'Upstream error: {exc.reason}\n')
            return self._http_error(conn, status, text, body)
        self._relay(conn, upstream)

    def _http_error(self, conn, status, text, body):
        data = body.encode()
        conn.sendall(f'HTTP/1.1 {status} {text}\r\nContent-Type: text/plain; charset=utf-8\r\n'
                     f'Content-Length: {len(data)}\r\nConnection: close\r\n\r\n'.encode() + data)
        _shutdown(conn, socket.SHUT_WR)
        conn.settimeout(0.5)  # brief drain so unread request bytes don't reset the reply
        try:
            for _ in range(16):
                if not conn.recv(65536):
                    break
        except OSError:
            pass

    # -- SOCKS5 --------------------------------------------------------------
    def _serve_socks(self, conn, reader):
        _ver, nmethods = reader.exact(2)
        if 0x00 not in reader.exact(nmethods):
            conn.sendall(b'\x05\xff')
            return
        conn.sendall(b'\x05\x00')
        ver, cmd, _rsv, atyp = reader.exact(4)
        if ver != 5:
            return
        if cmd != 0x01:
            return _socks_reply(conn, 0x07)
        if atyp == 0x01:
            host = socket.inet_ntop(socket.AF_INET, reader.exact(4))
        elif atyp == 0x04:
            host = socket.inet_ntop(socket.AF_INET6, reader.exact(16))
        elif atyp == 0x03:
            try:
                host = reader.exact(reader.exact(1)[0]).decode('utf-8')
            except UnicodeDecodeError:
                host = '\0'  # rejected by resolve() as bad_host
        else:
            return _socks_reply(conn, 0x08)
        port = int.from_bytes(reader.exact(2), 'big')
        try:
            upstream = self._open(conn, host, port, 'socks')
        except Refused as exc:
            return _socks_reply(conn, SOCKS_ERRORS.get(exc.reason, 0x02))
        _socks_reply(conn, 0x00)
        if reader.buf:
            upstream.sendall(reader.buf)
        self._relay(conn, upstream)


def _socks_reply(conn, code):
    conn.sendall(bytes([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))


def _shutdown(sock, how=socket.SHUT_RDWR):
    try:
        sock.shutdown(how)
    except OSError:
        pass
