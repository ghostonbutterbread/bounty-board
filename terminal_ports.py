"""Sandbox preview ports: reach a PoC server inside a report's sandbox.

The sandbox keeps ``--network none``. A server started inside it (for
example ``python3 -m http.server 8000``) is reached through an agent in the
container (``sandbox/bbterm-ports.py``) that **dials out** to a host-owned
Unix socket ``ports.sock`` in the per-session directory mounted read-only at
``/run/bbterm`` (next to ``proxy.sock``). The host never connects to any path
or address the container controls; this module has no ``connect`` call at all.

Agent protocol (newline-delimited JSON, each line at most 4 KiB, strict
schema; anything else closes that one connection):

  agent -> host, first line of a connection:
    {"t": "hello", "v": 1}            this is the control connection
    {"t": "data", "id": "<32 hex>"}   answers an open; raw bytes follow
  agent -> host, later lines on the control connection:
    {"t": "ports", "ports": [8000, ...]}  listening TCP ports (sent on change)
    {"t": "fail", "id": "<32 hex>"}       the open could not reach the port
  host -> agent, on the control connection:
    {"t": "open", "id": "<32 hex>", "port": 8000}

The agent is untrusted: any process in the sandbox can kill it and speak the
protocol. Limits: 8 forwarded ports and 32 forwarded connections per session,
128 in total, 16 opens waiting for an answer, 5 s to answer an open (the
browser's connection is closed otherwise), 5 s for the first line, 8
connections that have not identified themselves, 10 control connections a
minute. Ids are random per open and valid once. Forwarded bytes are never
interpreted. The proxy port (3128) is never forwarded, whatever the agent says.

Host listeners: each forwarded sandbox port gets a host port from the range
(default 9100-9199), stable for the session's life (pause included, and kept
when the sandbox server stops and starts again), released on removal or
reset. Always bound on 127.0.0.1; also on the Tailscale IPv4 when the
``ports_tailscale`` setting is on. Never 0.0.0.0, never ::.
"""
import collections
import fcntl
import ipaddress
import json
import os
import re
import secrets
import selectors
import socket
import stat
import struct
import sys
import threading
import time
from pathlib import Path

MAX_LINE = 4096
MAX_PORTS = 8             # forwarded sandbox ports per session
MAX_REPORTED = 64         # ports in one report line (more is malformed)
MAX_SESSION_CONNS = 32    # forwarded connections per session (waiting ones included)
MAX_TOTAL_CONNS = 128     # forwarded connections for the whole service
MAX_PENDING = 16          # opens waiting for the agent, per session
MAX_UNIDENTIFIED = 8      # agent connections that have not sent their first line
MAX_RESERVED = 16         # host port numbers remembered per session
OPEN_TIMEOUT = 5
HELLO_TIMEOUT = 5
CONTROL_RATE = (10, 60)   # at most 10 control connections per 60 s per session
REPORT_RATE = (10, 5)     # at most 10 ports reports per 5 s per control connection (the agent sends <= 1/s)
ACTIVITY_EVERY = 5        # seconds between activity reports while bytes flow
TAILSCALE_REFRESH = 60
DEFAULT_RANGE = (9100, 9199)
PROXY_PORT = 3128
LOCAL_HOST = '127.0.0.1'
CGNAT = ipaddress.ip_network('100.64.0.0/10')
ID_RE = re.compile(r'[0-9a-f]{32}')


class PortsError(Exception):
    """Reported to the API caller; ``code`` is a short machine string."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class _Bad(Exception):
    """Malformed agent input: close that connection."""


def _warn(message):
    print(f'bbterm: {message}', file=sys.stderr, flush=True)


# -- parsing --------------------------------------------------------------------

def parse_range(value):
    """'9100-9199' -> (9100, 9199). Ports 1024-65535, at most 1000 numbers."""
    match = re.fullmatch(r'(\d{1,5})-(\d{1,5})', value.strip())
    if not match:
        raise ValueError('--ports-range must look like 9100-9199')
    lo, hi = int(match.group(1)), int(match.group(2))
    if not 1024 <= lo <= hi <= 65535 or hi - lo >= 1000:
        raise ValueError('--ports-range must be within 1024-65535, low first, at most 1000 ports')
    return lo, hi


def parse_tailscale_address(value):
    """'auto', or an IPv4 address in 100.64.0.0/10 (checked to be local when used)."""
    if value == 'auto':
        return value
    try:
        ip = ipaddress.IPv4Address(value)
    except ValueError:
        raise ValueError('--tailscale-address must be "auto" or an IPv4 address in 100.64.0.0/10') from None
    if ip not in CGNAT:
        raise ValueError('--tailscale-address must be in 100.64.0.0/10 (a Tailscale address)')
    return str(ip)


def _parse_line(line):
    try:
        msg = json.loads(line.decode('utf-8'), parse_constant=lambda name: (_ for _ in ()).throw(_Bad(name)))
    except (ValueError, UnicodeError, RecursionError):
        raise _Bad('not json') from None
    if not isinstance(msg, dict) or not isinstance(msg.get('t'), str):
        raise _Bad('not an object')
    return msg


def _valid_id(value):
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None


def _read_line(sock, buf, deadline=None):
    """One line (without newline) and the bytes after it. Raises _Bad past MAX_LINE, EOFError at EOF."""
    while b'\n' not in buf:
        if len(buf) > MAX_LINE:
            raise _Bad('line too long')
        if deadline is not None:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError
            sock.settimeout(left)
        chunk = sock.recv(4096)
        if not chunk:
            raise EOFError
        buf += chunk
    line, rest = buf.split(b'\n', 1)
    if len(line) > MAX_LINE:
        raise _Bad('line too long')
    return line, rest


def _shutdown(sock):
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def _close(sock):
    if sock is None:
        return
    try:
        sock.close()
    except OSError:
        pass


def _bind_tcp(ip, port):
    """Listen on ip:port. Only a specific IPv4 address; never the unspecified address."""
    addr = ipaddress.IPv4Address(ip)
    if addr.is_unspecified or addr.is_multicast:
        raise ValueError(f'refusing to bind {ip}')
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Lets the same number come back after TIME_WAIT (stable URLs); Linux
        # still refuses it while another socket listens there.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((str(addr), port))
        sock.listen(64)
    except BaseException:
        sock.close()
        raise
    return sock


def _listen_unix(path):
    """Host-owned listening socket, 0600 (the container runs as the service's own UID)."""
    try:
        if stat.S_ISSOCK(os.lstat(path).st_mode):
            os.unlink(path)
    except FileNotFoundError:
        pass
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.bind(path)
        os.chmod(path, 0o600)
        sock.listen(64)
    except BaseException:
        sock.close()
        raise
    return sock


# -- Tailscale address ----------------------------------------------------------

def interface_ipv4(name):
    """Primary IPv4 address of a network interface (SIOCGIFADDR), or None."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        result = fcntl.ioctl(probe.fileno(), 0x8915, struct.pack('256s', name.encode()[:15]))
        return socket.inet_ntoa(result[20:24])
    except OSError:
        return None
    finally:
        probe.close()


def _local_addresses():
    import terminal_proxy
    return terminal_proxy.local_addresses()


class TailscaleAddress:
    """Finds the address to bind for tailnet access.

    ``auto``: the first IPv4 in 100.64.0.0/10 on a local interface, preferring
    ``tailscale0``. An explicit address must be in 100.64.0.0/10 and local.
    ``networks``, ``addresses`` and ``interface`` exist for tests (loopback
    aliases); the command line only reaches ``spec``.
    """

    def __init__(self, spec='auto', *, networks=(CGNAT,), addresses=None, interface=interface_ipv4):
        self.spec = spec
        self.networks = tuple(networks)
        self.addresses = addresses or _local_addresses
        self.interface = interface

    def _usable(self, value):
        try:
            ip = ipaddress.ip_address(value)
        except ValueError:
            return False
        return ip.version == 4 and not ip.is_unspecified and any(ip in net for net in self.networks)

    def detect(self):
        local = {a for a in self.addresses() if self._usable(a)}
        if self.spec != 'auto':
            return self.spec if self.spec in local else None
        preferred = self.interface('tailscale0')
        if preferred in local:
            return preferred
        return min(local, key=ipaddress.ip_address) if local else None


# -- settings -------------------------------------------------------------------

class SettingsStore:
    """``<state-dir>/settings.json``: {"ports_tailscale": false}.

    Read once at start. A file that cannot be read (permissions, a symlink, a
    directory) is never written over: changes are refused until it is fixed.
    A corrupt file is renamed aside before the first write replaces it. Writes
    are atomic (new 0600 file, fsync, rename, fsync of the directory).
    """
    DEFAULTS = {'ports_tailscale': False}

    def __init__(self, path, log=None):
        self.path = Path(path)
        self.log = log or _warn
        self.lock = threading.Lock()
        self.values, self.state = self._load()

    def _load(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return dict(self.DEFAULTS), 'missing'
        except OSError as error:
            self.log(f'cannot read {self.path} ({error.strerror}); settings changes are refused until it is fixed')
            return dict(self.DEFAULTS), 'unreadable'
        try:
            with os.fdopen(fd, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise IsADirectoryError(21, 'not a regular file')
                data = stream.read(64 * 1024 + 1)
        except OSError as error:
            self.log(f'cannot read {self.path} ({error.strerror}); settings changes are refused until it is fixed')
            return dict(self.DEFAULTS), 'unreadable'
        try:
            if len(data) > 64 * 1024:
                raise ValueError('too large')
            values = json.loads(data.decode('utf-8'))
            if not isinstance(values, dict) or not isinstance(values.get('ports_tailscale', False), bool):
                raise ValueError('bad shape')
        except (ValueError, UnicodeError):
            self.log(f'{self.path} is not valid settings JSON; using defaults (it is set aside on the next change)')
            return dict(self.DEFAULTS), 'corrupt'
        return {**self.DEFAULTS, **values}, 'ok'

    def get(self, key):
        with self.lock:
            return self.values[key]

    def update(self, **changes):
        with self.lock:
            if self.state == 'unreadable':
                raise PortsError('settings_unreadable', 'The settings file could not be read, so it is not changed. '
                                 'Check its permissions.')
            values = {**self.values, **changes}
            folder = self.path.parent
            if self.state == 'corrupt':
                aside = folder / f'{self.path.name}.corrupt-{time.strftime("%Y%m%d-%H%M%S")}-{secrets.token_hex(3)}'
                os.rename(self.path, aside)
                self.log(f'set the unreadable settings file aside as {aside.name}')
            tmp = folder / f'.{self.path.name}.{secrets.token_hex(6)}.tmp'
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(json.dumps(values, indent=2, sort_keys=True).encode() + b'\n')
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            dir_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
            self.values, self.state = values, 'ok'
            return dict(values)


def disabled_settings(ports_range, ports_tailscale=False):
    """GET /api/settings when --preview-ports is off."""
    return {'preview_ports': False, 'ports_tailscale': ports_tailscale, 'tailscale_address': None,
            'tailscale_reason': 'disabled', 'ports_range': list(ports_range)}


# -- accept loop ----------------------------------------------------------------

class _Acceptor:
    """One thread accepts on every listening socket and hands each connection to its callback."""

    def __init__(self):
        self.selector = selectors.DefaultSelector()
        self.lock = threading.Lock()
        self.closed = False
        self.wake_r, self.wake_w = socket.socketpair()
        self.wake_r.setblocking(False)
        self.wake_w.setblocking(False)  # add() runs under the hub lock: it must never block
        self.selector.register(self.wake_r, selectors.EVENT_READ, None)
        self.thread = threading.Thread(target=self._loop, name='bbterm-ports-accept', daemon=True)
        self.thread.start()

    def add(self, sock, callback):
        sock.setblocking(False)
        with self.lock:
            if self.closed:
                sock.close()
                raise OSError('acceptor closed')
            self.selector.register(sock, selectors.EVENT_READ, callback)
        try:
            self.wake_w.send(b'x')
        except OSError:  # BlockingIOError: a wake-up is already pending
            pass

    def remove(self, sock):
        with self.lock:
            try:
                self.selector.unregister(sock)
            except (KeyError, ValueError):
                pass
            sock.close()

    def _loop(self):
        while not self.closed:
            try:
                events = self.selector.select(1.0)
            except (OSError, ValueError):
                continue
            for key, _ in events:
                if key.data is None:
                    try:
                        self.wake_r.recv(4096)
                    except OSError:
                        pass
                    continue
                try:
                    conn, _ = key.fileobj.accept()
                except OSError:
                    continue
                conn.setblocking(True)
                try:
                    key.data(conn)
                except Exception:
                    conn.close()

    def close(self):
        with self.lock:
            self.closed = True
            for key in list(self.selector.get_map().values()):
                if key.data is not None:
                    key.fileobj.close()
        try:
            self.wake_w.send(b'x')
        except OSError:
            pass
        self.thread.join(timeout=3)
        self.selector.close()
        self.wake_r.close()
        self.wake_w.close()


# -- per-session state ------------------------------------------------------------

class _Control:
    def __init__(self, sock):
        self.sock = sock
        # Kernel send timeout: an agent that stops reading cannot hold an open
        # forever. (A Python-level timeout would also cut the reader thread.)
        sock.settimeout(None)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDTIMEO, struct.pack('ll', OPEN_TIMEOUT, 0))
        self.send_lock = threading.Lock()
        self.dead = False

    def send(self, message):
        data = json.dumps(message).encode() + b'\n'
        with self.send_lock:
            if self.dead:
                return False
            try:
                self.sock.sendall(data)
                return True
            except OSError:
                self.kill()
                return False

    def kill(self):
        self.dead = True
        _shutdown(self.sock)


class _Pending:
    def __init__(self, control):
        self.control = control
        self.event = threading.Event()
        self.data = None
        self.leftover = b''


class _Conn:
    """One forwarded browser connection (client side) and, once answered, its agent data connection."""

    def __init__(self, client, via):
        self.client, self.via = client, via
        self.data = None
        self.dead = False

    def kill(self):
        self.dead = True
        _shutdown(self.client)
        _shutdown(self.data)


class _Forward:
    def __init__(self, sandbox_port, host_port):
        self.sandbox_port, self.host_port = sandbox_port, host_port
        self.listeners = {}  # ip -> listening socket


class SessionPorts:
    """Preview ports of one sandbox. ``owner`` provides:

    - ``ports_changed()``: the list changed (called without any ports lock held);
    - ``ports_activity()``: forwarded traffic (may unpause; called without locks);
    - ``paused``: bool attribute.
    """

    def __init__(self, hub, path, owner):
        self.hub, self.owner = hub, owner
        self.closed = False
        self.control = None
        self.control_times = collections.deque()
        self.forwards = {}                         # sandbox port -> _Forward (currently listening)
        self.reserved = collections.OrderedDict()  # sandbox port -> host port, for the session's life
        self.pending = {}
        self.conns = set()
        self.unidentified = 0
        self.sock = _listen_unix(path)

    # -- view ---------------------------------------------------------------------
    def items(self):
        with self.hub.lock:
            if self.closed:
                return []
            ts_ip = self.hub.ts_ip
            state = 'paused' if getattr(self.owner, 'paused', False) else 'open'
            out = []
            for port in sorted(self.forwards):
                fwd = self.forwards[port]
                ts = fwd.listeners.get(ts_ip) if ts_ip else None
                out.append({'port': port, 'host_port': fwd.host_port,
                            'local_url': f'http://{LOCAL_HOST}:{fwd.host_port}/',
                            'tailscale_url': f'http://{ts_ip}:{fwd.host_port}/' if ts is not None else None,
                            'state': state})
            return out

    def _notify(self):
        try:
            self.owner.ports_changed()
        except Exception as error:
            self.hub.log(f'ports notification failed: {error}')

    # -- agent side -----------------------------------------------------------------
    def _accept_agent(self, conn):
        with self.hub.lock:
            if self.closed or self.unidentified >= MAX_UNIDENTIFIED:
                conn.close()
                return
            self.unidentified += 1
        try:
            threading.Thread(target=self._agent_conn, args=(conn,), name='bbterm-ports-agent', daemon=True).start()
        except BaseException:
            with self.hub.lock:
                self.unidentified -= 1
            conn.close()

    def _agent_conn(self, conn):
        try:
            try:
                line, rest = _read_line(conn, b'', deadline=time.monotonic() + HELLO_TIMEOUT)
                msg = _parse_line(line)
            except (_Bad, EOFError, OSError):
                conn.close()
                return
        finally:
            with self.hub.lock:
                self.unidentified -= 1
        if msg == {'t': 'hello', 'v': 1} and type(msg['v']) is int:
            self._control_loop(conn, rest)
        elif set(msg) == {'t', 'id'} and msg['t'] == 'data' and _valid_id(msg['id']):
            self._data(conn, msg['id'], rest)
        else:
            conn.close()

    def _control_loop(self, conn, buf):
        now = time.monotonic()
        limit, window = CONTROL_RATE
        with self.hub.lock:
            while self.control_times and now - self.control_times[0] > window:
                self.control_times.popleft()
            if self.closed or len(self.control_times) >= limit:
                conn.close()
                return
            self.control_times.append(now)
            old, self.control = self.control, _Control(conn)
            ctl = self.control
        if old is not None:
            old.kill()  # its own thread cleans up
        reports = collections.deque()
        try:
            while not ctl.dead:
                line, buf = _read_line(conn, buf)
                msg = _parse_line(line)
                if msg['t'] == 'ports' and set(msg) == {'t', 'ports'}:
                    now, (limit, window) = time.monotonic(), REPORT_RATE
                    while reports and now - reports[0] > window:
                        reports.popleft()
                    if len(reports) >= limit:
                        raise _Bad('ports reports too fast')
                    reports.append(now)
                    self._update(ctl, self._valid_ports(msg['ports']))
                elif msg['t'] == 'fail' and set(msg) == {'t', 'id'} and _valid_id(msg['id']):
                    self._fail(ctl, msg['id'])
                else:
                    raise _Bad('unknown message')
        except (_Bad, EOFError, OSError):
            pass
        finally:
            ctl.kill()
            conn.close()
            self._control_lost(ctl)

    @staticmethod
    def _valid_ports(ports):
        if not isinstance(ports, list) or len(ports) > MAX_REPORTED:
            raise _Bad('bad ports')
        if any(type(p) is not int or not 1 <= p <= 65535 for p in ports) or len(set(ports)) != len(ports):
            raise _Bad('bad ports')
        return [p for p in ports if p != PROXY_PORT]

    def _update(self, ctl, reported):
        with self.hub.lock:
            if self.closed or self.control is not ctl:
                return
            keep = [p for p in sorted(self.forwards) if p in reported]
            wanted = (keep + [p for p in sorted(reported) if p not in self.forwards])[:MAX_PORTS]
            changed = False
            for port in [p for p in self.forwards if p not in wanted]:
                self._deactivate(port)
                changed = True
            for port in wanted:
                if port not in self.forwards:
                    changed = self._activate(port) or changed
        if changed:
            self._notify()

    def _fail(self, ctl, open_id):
        with self.hub.lock:
            pending = self.pending.get(open_id)
            if pending is not None and pending.control is ctl:
                del self.pending[open_id]
                pending.event.set()
        # A fail for an unknown id is ignored: it may simply have timed out.

    def _control_lost(self, ctl):
        with self.hub.lock:
            for open_id, pending in list(self.pending.items()):
                if pending.control is ctl:
                    del self.pending[open_id]
                    pending.event.set()
            if self.control is not ctl or self.closed:
                return
            self.control = None
            changed = bool(self.forwards)
            for port in list(self.forwards):
                self._deactivate(port)
        if changed:
            self._notify()

    def _data(self, conn, open_id, rest):
        with self.hub.lock:
            pending = self.pending.pop(open_id, None)  # valid once: a reused id is unknown from now on
            if pending is None or self.closed:
                conn.close()
                return
            pending.data, pending.leftover = conn, rest
            pending.event.set()

    # -- listeners (hub lock held) -------------------------------------------------------
    def _activate(self, port):
        hub = self.hub
        host_port = hub._allocate(self, port)
        if host_port is None:
            return False
        fwd = self.forwards[port] = _Forward(port, host_port)
        local = hub._bound.pop((LOCAL_HOST, host_port))
        self._add_listener(fwd, LOCAL_HOST, local)
        if hub.ts_ip:
            self._bind_tailscale(fwd, hub.ts_ip)
        return True

    def _bind_tailscale(self, fwd, ip):
        try:
            sock = _bind_tcp(ip, fwd.host_port)
        except OSError as error:
            self.hub.log(f'could not listen on {ip}:{fwd.host_port} ({error.strerror}); local only')
            return
        self._add_listener(fwd, ip, sock)

    def _add_listener(self, fwd, ip, sock):
        fwd.listeners[ip] = sock
        self.hub.acceptor.add(sock, lambda conn, fwd=fwd, ip=ip: self._accept_client(fwd, ip, conn))

    def _drop_listener(self, fwd, ip):
        sock = fwd.listeners.pop(ip, None)
        if sock is not None:
            self.hub.acceptor.remove(sock)

    def _deactivate(self, port):
        fwd = self.forwards.pop(port)
        for ip in list(fwd.listeners):
            self._drop_listener(fwd, ip)

    # -- browser side ----------------------------------------------------------------------
    def _accept_client(self, fwd, via, client):
        hub = self.hub
        with hub.lock:
            if (self.closed or fwd.listeners.get(via) is None or len(self.conns) >= MAX_SESSION_CONNS
                    or hub.total_conns >= MAX_TOTAL_CONNS or len(self.pending) >= MAX_PENDING):
                client.close()
                return
            record = _Conn(client, via)
            self.conns.add(record)
            hub.total_conns += 1
        try:
            threading.Thread(target=self._client, args=(fwd, record), name='bbterm-ports-client', daemon=True).start()
        except BaseException:
            with hub.lock:
                self.conns.discard(record)
                hub.total_conns -= 1
            client.close()

    def _client(self, fwd, record):
        hub = self.hub
        pending = None
        try:
            try:
                self.owner.ports_activity()  # unpauses a paused sandbox
            except Exception as error:
                hub.log(f'ports activity failed: {error}')
            with hub.lock:
                ctl = self.control
                if ctl is None or record.dead or self.closed or len(self.pending) >= MAX_PENDING:
                    return
                open_id = secrets.token_hex(16)
                pending = self.pending[open_id] = _Pending(ctl)
            if ctl.send({'t': 'open', 'id': open_id, 'port': fwd.sandbox_port}):
                pending.event.wait(OPEN_TIMEOUT)
            with hub.lock:
                if self.pending.get(open_id) is pending:
                    del self.pending[open_id]  # timed out: the id is dead from now on
                record.data = pending.data
                dead = record.dead
            if record.data is None or dead:
                return
            self._pipe(record, pending.leftover)
        finally:
            with hub.lock:
                self.conns.discard(record)
                hub.total_conns -= 1
            _close(record.client)
            _close(record.data)

    def _pipe(self, record, leftover):
        client, data = record.client, record.data
        client.settimeout(None)
        data.settimeout(None)
        last = [time.monotonic()]

        def activity():
            now = time.monotonic()
            if now - last[0] >= ACTIVITY_EVERY:
                last[0] = now
                try:
                    self.owner.ports_activity()
                except Exception as error:
                    self.hub.log(f'ports activity failed: {error}')

        if leftover:
            try:
                client.sendall(leftover)
            except OSError:
                return
        back = threading.Thread(target=_pump, args=(data, client, activity), name='bbterm-ports-pipe', daemon=True)
        back.start()
        _pump(client, data, activity)
        back.join()

    # -- teardown ----------------------------------------------------------------------------
    def _kill_via(self, ip):
        for record in list(self.conns):
            if record.via == ip:
                record.kill()

    def close(self):
        """Close every listener, connection and the agent socket; release the host port numbers."""
        with self.hub.lock:
            if self.closed:
                return
            self.closed = True
            for port in list(self.forwards):
                self._deactivate(port)
            self.reserved.clear()
            for pending in self.pending.values():
                pending.event.set()
            self.pending.clear()
            for record in list(self.conns):
                record.kill()
            control, self.control = self.control, None
            self.hub.sessions.discard(self)
        if control is not None:
            control.kill()
        self.hub.acceptor.remove(self.sock)


def _pump(src, dst, activity):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            activity()
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock, how in ((dst, socket.SHUT_WR), (src, socket.SHUT_RD)):
            try:
                sock.shutdown(how)
            except OSError:
                pass


# -- hub ------------------------------------------------------------------------------

class PortsHub:
    """Preview ports for every sandbox of the service (one per service)."""

    def __init__(self, *, state_dir, ports_range=DEFAULT_RANGE, exclude=(), tailscale=None, log=None,
                 refresh_interval=TAILSCALE_REFRESH):
        self.log = log or _warn
        self.range = tuple(ports_range)
        self.exclude = set(exclude)
        self.settings = SettingsStore(Path(state_dir) / 'settings.json', self.log)
        self.tailscale = tailscale or TailscaleAddress()
        self.lock = threading.RLock()
        self.toggle_lock = threading.Lock()
        self.sessions = set()
        self.total_conns = 0
        self._bound = {}  # (ip, port) -> socket bound by _allocate, taken by _activate
        self.ts_ip = None
        self.closed = False
        self.acceptor = _Acceptor()
        if self.settings.get('ports_tailscale'):
            self.ts_ip = self.tailscale.detect()
            if self.ts_ip is None:
                self.log('Tailscale ports are on but no Tailscale address was found; retrying every minute')
        self.stop_event = threading.Event()
        if refresh_interval:
            threading.Thread(target=self._refresher, args=(refresh_interval,), name='bbterm-ports-tailscale',
                             daemon=True).start()

    def open_session(self, path, owner):
        sp = SessionPorts(self, path, owner)
        with self.lock:
            if self.closed:
                sp.sock.close()
                raise OSError('preview ports are shutting down')
            self.sessions.add(sp)
        self.acceptor.add(sp.sock, sp._accept_agent)
        return sp

    # -- host port numbers (lock held) ---------------------------------------------------
    def _allocate(self, sp, port):
        """Pick and bind a host port for (session, sandbox port). Returns the number or None."""
        lo, hi = self.range
        taken = {n for other in self.sessions for n in other.reserved.values()}
        known = sp.reserved.get(port)
        # Free numbers first; when the range is full, numbers other sessions only
        # remember for ports that stopped listening (their URLs change if they come back).
        idle = [(other, p, n) for other in self.sessions if other is not sp
                for p, n in other.reserved.items() if p not in other.forwards]
        candidates = ([known] if known is not None else []) + [
            n for n in range(lo, hi + 1) if n not in taken and n not in self.exclude] + [n for _, _, n in idle]
        owners = {n: (other, p) for other, p, n in idle}
        for number in candidates:
            try:
                self._bound[(LOCAL_HOST, number)] = _bind_tcp(LOCAL_HOST, number)
            except OSError:
                if number == known:
                    del sp.reserved[port]  # someone else on the host took it; pick a new one
                continue
            if number in owners and number != known:
                other, other_port = owners[number]
                other.reserved.pop(other_port, None)
            sp.reserved[port] = number
            sp.reserved.move_to_end(port)
            while len(sp.reserved) > MAX_RESERVED:
                stale = next((p for p in sp.reserved if p not in sp.forwards and p != port), None)
                if stale is None:
                    break
                del sp.reserved[stale]
            return number
        self.log(f'no free host port in {lo}-{hi} for sandbox port {port}')
        return None

    # -- Tailscale -------------------------------------------------------------------------
    def _apply_tailscale(self, ip):
        changed = []
        with self.lock:
            old, self.ts_ip = self.ts_ip, ip
            if old == ip:
                return
            for sp in list(self.sessions):
                if sp.closed or not sp.forwards:
                    continue
                for fwd in sp.forwards.values():
                    if old is not None:
                        sp._drop_listener(fwd, old)
                    if ip is not None:
                        sp._bind_tailscale(fwd, ip)
                if old is not None:
                    sp._kill_via(old)
                changed.append(sp)
        for sp in changed:
            sp._notify()

    def set_tailscale(self, enabled):
        """POST /api/settings. Applies live; raises PortsError."""
        with self.toggle_lock:
            if enabled:
                ip = self.tailscale.detect()
                if ip is None:
                    raise PortsError('tailscale_not_found', 'No Tailscale address was found on this machine.')
                self.settings.update(ports_tailscale=True)
                self._apply_tailscale(ip)
            else:
                self.settings.update(ports_tailscale=False)
                self._apply_tailscale(None)
        return self.settings_payload()

    def refresh(self):
        """Re-detect the Tailscale address while the setting is on; rebind when it changed."""
        with self.toggle_lock:
            if self.settings.get('ports_tailscale'):
                ip = self.tailscale.detect()
                if ip != self.ts_ip:
                    self.log(f'Tailscale address changed to {ip or "none"}')
                    self._apply_tailscale(ip)

    def _refresher(self, interval):
        while not self.stop_event.wait(interval):
            try:
                self.refresh()
            except Exception as error:
                self.log(f'Tailscale address check failed: {error}')

    def settings_payload(self):
        on = self.settings.get('ports_tailscale')
        with self.lock:
            ip = self.ts_ip
        return {'preview_ports': True, 'ports_tailscale': on, 'tailscale_address': ip if on else None,
                'tailscale_reason': (None if ip else 'not_found') if on else 'disabled', 'ports_range': list(self.range)}

    def close(self):
        self.stop_event.set()
        with self.lock:
            self.closed = True
            sessions = list(self.sessions)
        for sp in sessions:
            sp.close()
        with self.lock:
            for sock in self._bound.values():
                sock.close()
            self._bound.clear()
        self.acceptor.close()
