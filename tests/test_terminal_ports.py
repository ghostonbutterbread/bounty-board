"""Sandbox preview ports (terminal_ports.py): agent protocol, limits, listeners, settings, lifecycle.

The agent side is played by this test (a fake, often malicious, agent) or by
the real agent's ``forward()`` from sandbox/bbterm-ports.py. The "sandbox
server" is a real 127.0.0.1 listener of the test. The Tailscale address is a
TEST-ONLY loopback alias (127.0.0.2) through ``TailscaleAddress(networks=...)``,
which the command line cannot reach.
"""
import contextlib
import importlib.util
import ipaddress
import json
import os
import shutil
import socket
import stat
import sys
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_ports as tp  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.test_terminal_sandbox import FakeDocker, FakeViewer  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OPEN = []  # sockets opened by the test side, closed in tearDown


def tcp(host, port, source=None):
    """source: a loopback alias to connect from, so the hub sees a different client IP."""
    sock = socket.create_connection((host, port), timeout=10, source_address=(source, 0) if source else None)
    OPEN.append(sock)
    return sock


def close_all():
    while OPEN:
        OPEN.pop().close()


def load_agent(sock_path):
    spec = importlib.util.spec_from_file_location('bbterm_ports_agent', ROOT / 'sandbox/bbterm-ports.py')
    module = importlib.util.module_from_spec(spec)
    old = sys.argv
    sys.argv = ['bbterm-ports', str(sock_path), '3128']  # the 0632c25 agent read argv at import
    try:
        spec.loader.exec_module(module)
    finally:
        sys.argv = old
    module.SOCKET, module.EXCLUDE = str(sock_path), {3128}
    return module


def tailscale_address(*args, **kw):
    """TailscaleAddress; drops ``interfaces`` for the 0632c25 signature so the review-round-1
    regression tests can be shown red against that code (they then fail on their asserts)."""
    try:
        return tp.TailscaleAddress(*args, **kw)
    except TypeError:
        kw.pop('interfaces', None)
        return tp.TailscaleAddress(*args, **kw)


def free_range(size=12):
    """A host port range nobody listens on right now (tests run beside other services)."""
    for _ in range(200):
        lo = 20000 + (os.getpid() * 37 + int(time.time() * 1000)) % 30000
        lo = lo - lo % size
        busy = False
        for n in range(lo, lo + size):
            probe = socket.socket()
            try:
                probe.bind(('127.0.0.1', n))
            except OSError:
                busy = True
            finally:
                probe.close()
            if busy:
                break
        if not busy:
            return lo, lo + size - 1
        time.sleep(0.01)
    raise AssertionError('no free range')


def wait(predicate, timeout=10, message='condition not reached'):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError(message)


def closed_by_peer(sock, timeout=10):
    sock.settimeout(timeout)
    try:
        return sock.recv(1) == b''
    except (ConnectionResetError, BrokenPipeError):
        return True
    except socket.timeout:
        return False


def connectable(host, port):
    try:
        socket.create_connection((host, port), timeout=2).close()
        return True
    except OSError:
        return False


class EchoServer:
    """The 'PoC server inside the sandbox': echoes, and reports half-close by sending b'<eof>'."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(('127.0.0.1', 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        self.conns = 0
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.conns += 1
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        with conn:
            try:
                while True:
                    data = conn.recv(65536)
                    if not data:
                        conn.sendall(b'<eof>')
                        break
                    conn.sendall(data)
            except OSError:
                pass

    def close(self):
        self.sock.close()


class FakeOwner:
    def __init__(self):
        self.paused = False
        self.changes = 0
        self.activity = 0

    def ports_changed(self):
        self.changes += 1

    def ports_activity(self):
        self.activity += 1


class Agent:
    """Fake agent speaking the protocol by hand."""

    def __init__(self, path, hello=True):
        self.path = str(path)
        self.ctl = self.dial()
        self.buf = b''
        if hello:
            self.line({'t': 'hello', 'v': 1})

    def dial(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        OPEN.append(sock)
        sock.settimeout(10)
        sock.connect(self.path)
        return sock

    def line(self, message, sock=None):
        (sock or self.ctl).sendall(json.dumps(message).encode() + b'\n')

    def ports(self, ports):
        self.line({'t': 'ports', 'ports': ports})

    def read_open(self, timeout=10):
        self.ctl.settimeout(timeout)
        while b'\n' not in self.buf:
            chunk = self.ctl.recv(4096)
            if not chunk:
                raise EOFError
            self.buf += chunk
        line, self.buf = self.buf.split(b'\n', 1)
        return json.loads(line)

    def answer(self, open_id, extra=b''):
        data = self.dial()
        data.sendall(json.dumps({'t': 'data', 'id': open_id}).encode() + b'\n' + extra)
        return data

    def close(self):
        self.ctl.close()


class AutoAgent(Agent):
    """Answers every open with the real agent's forward() (connects to 127.0.0.1:<port>)."""

    def __init__(self, path):
        super().__init__(path)
        self.module = load_agent(path)
        self.lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def line(self, message, sock=None):
        lock = getattr(self, 'lock', None)
        with (lock or contextlib.nullcontext()):
            super().line(message, sock)

    def _loop(self):
        while True:
            try:
                msg = self.read_open(timeout=None)
            except (OSError, EOFError, ValueError):
                return
            threading.Thread(target=self.module.forward, args=(self.ctl, self.lock, msg['id'], msg['port']),
                             daemon=True).start()


class HubCase(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('ports')
        self.range = free_range()
        self.addresses = {'127.0.0.1', '127.0.0.2'}
        self.tailscale = tailscale_address('auto', networks=[ipaddress.ip_network('127.0.0.2/32'),
                                                               ipaddress.ip_network('127.0.0.3/32')],
                                             addresses=lambda: self.addresses, interfaces=lambda: ['eth0', 'tailscale0'],
                                             # TEST ONLY: "tailscale0" carries whichever alias is up
                                             interface=lambda name: next((a for a in sorted(self.addresses)
                                                                          if a in ('127.0.0.2', '127.0.0.3')), None)
                                             if name == 'tailscale0' else None)
        self.logs = []
        self.hub = tp.PortsHub(state_dir=self.base, ports_range=self.range, tailscale=self.tailscale,
                               log=self.logs.append, refresh_interval=0)
        self.owner = FakeOwner()
        self.sock_path = self.base / 'ports.sock'
        self.sp = self.hub.open_session(str(self.sock_path), self.owner)
        self.servers = []

    def tearDown(self):
        close_all()
        self.hub.close()
        for server in self.servers:
            server.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def server(self):
        server = EchoServer()
        self.servers.append(server)
        return server

    def wait_items(self, count):
        return wait(lambda: len(self.sp.items()) == count and (self.sp.items() or [None]), message=f'expected {count} ports, got {self.sp.items()}')

    def forward(self, agent=None):
        server = self.server()
        agent = agent or AutoAgent(self.sock_path)
        agent.ports([server.port])
        item = self.wait_items(1)[0]
        return server, agent, item


class ForwardTests(HubCase):
    def test_end_to_end_echo_with_half_close_and_http(self):
        server, agent, item = self.forward()
        lo, hi = self.range
        self.assertEqual(item['port'], server.port)
        self.assertTrue(lo <= item['host_port'] <= hi)
        self.assertEqual(item['local_url'], f'http://127.0.0.1:{item["host_port"]}/')
        self.assertIsNone(item['tailscale_url'])
        self.assertEqual(item['state'], 'open')
        client = tcp('127.0.0.1', item['host_port'])
        client.sendall(b'hello sandbox')
        client.shutdown(socket.SHUT_WR)  # half-close travels to the sandbox server
        got = b''
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            got += chunk
        client.close()
        self.assertEqual(got, b'hello sandbox<eof>')
        self.assertGreaterEqual(self.owner.activity, 1, 'an inbound connection counts as activity')

    def test_http_server_body(self):
        import http.server
        body = b'synthetic-poc-page'

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass
        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            agent = AutoAgent(self.sock_path)
            agent.ports([httpd.server_address[1]])
            item = self.wait_items(1)[0]
            with urllib.request.urlopen(item['local_url'], timeout=10) as response:
                self.assertEqual(response.read(), body)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_listeners_bind_only_loopback_and_the_tailscale_address(self):
        server, agent, item = self.forward()
        host_port = item['host_port']
        names = lambda: {sock.getsockname() for sock in self.sp.forwards[server.port].listeners.values()}
        self.assertEqual(names(), {('127.0.0.1', host_port)})
        self.assertFalse(connectable('127.0.0.3', host_port), 'not bound on other addresses')
        self.hub.set_tailscale(True)
        self.assertEqual(names(), {('127.0.0.1', host_port), ('127.0.0.2', host_port)})
        self.assertEqual(self.sp.items()[0]['tailscale_url'], f'http://127.0.0.2:{host_port}/')
        self.assertFalse(connectable('127.0.0.3', host_port))
        # Nothing listens on the unspecified address for this port (kernel view).
        hex_port = f'{host_port:04X}'
        for path in ('/proc/net/tcp', '/proc/net/tcp6'):
            for line in Path(path).read_text().splitlines()[1:]:
                local, state = line.split()[1], line.split()[3]
                if state == '0A' and local.endswith(':' + hex_port):
                    self.assertIn(local.split(':')[0], ('0100007F', '0200007F'), line)
        for bad in ('0.0.0.0', '224.0.0.1'):
            with self.assertRaises(ValueError):
                tp._bind_tcp(bad, host_port)
        with self.assertRaises(ValueError):
            tp._bind_tcp('::', host_port)

    def test_port_is_stable_across_a_server_restart_and_closed_when_it_stops(self):
        server, agent, item = self.forward()
        host_port = item['host_port']
        agent.ports([])
        self.wait_items(0)
        self.assertFalse(connectable('127.0.0.1', host_port), 'the listener closes when the sandbox stops listening')
        other = self.server()
        agent.ports([other.port])  # another port meanwhile takes a different number
        self.assertNotEqual(self.wait_items(1)[0]['host_port'], host_port)
        agent.ports([other.port, server.port])
        items = {i['port']: i['host_port'] for i in self.wait_items(2)}
        self.assertEqual(items[server.port], host_port, 'same URL after the server restarts')

    def test_release_on_close_and_reset(self):
        server, agent, item = self.forward()
        host_port = item['host_port']
        self.sp.close()
        self.assertFalse(connectable('127.0.0.1', host_port))
        self.assertFalse(self.sock_path.exists() and connectable_unix(self.sock_path))
        # A new session (what a reset creates) may take the released number.
        path2 = self.base / 'ports2.sock'
        sp2 = self.hub.open_session(str(path2), FakeOwner())
        agent2 = AutoAgent(path2)
        agent2.ports([server.port])
        wait(lambda: sp2.items())
        self.assertEqual(sp2.items()[0]['host_port'], self.range[0])
        self.assertEqual(host_port, self.range[0])

    def test_range_exhaustion_and_busy_numbers(self):
        lo, hi = self.range
        squatter = socket.socket()
        squatter.bind(('127.0.0.1', lo))  # another host process holds the first number
        squatter.listen(1)
        try:
            servers = [self.server() for _ in range(3)]
            agent = AutoAgent(self.sock_path)
            hub2 = None
            # Shrink the range to three numbers (one busy): only two ports fit.
            self.hub.range = (lo, lo + 2)
            agent.ports([s.port for s in servers])
            items = self.wait_items(2)
            self.assertEqual(sorted(i['host_port'] for i in items), [lo + 1, lo + 2])
            wait(lambda: any('no free host port' in line for line in self.logs))
            self.assertIsNone(hub2)
        finally:
            squatter.close()

    def test_caps_on_ports_and_proxy_port_never_forwarded(self):
        agent = Agent(self.sock_path)
        self.hub.range = (self.range[0], self.range[0] + 11)
        ports = [3128] + [s.port for s in (self.server() for _ in range(10))]
        agent.ports(ports)
        items = self.wait_items(tp.MAX_PORTS)
        self.assertNotIn(3128, [i['port'] for i in items])
        self.assertEqual([i['port'] for i in items], sorted(ports[1:])[:tp.MAX_PORTS])


def connectable_unix(path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(str(path))
        return True
    except OSError:
        return False
    finally:
        sock.close()


class MaliciousAgentTests(HubCase):
    def control_closed(self, agent):
        return closed_by_peer(agent.ctl)

    def test_oversized_line_closes_control(self):
        server, agent, item = self.forward(Agent(self.sock_path))
        agent.ctl.sendall(b'{"t": "ports", "ports": [' + b' ' * 5000)
        self.assertTrue(self.control_closed(agent))
        self.wait_items(0)  # losing the control connection withdraws its ports
        self.assertFalse(connectable('127.0.0.1', item['host_port']))

    @mock.patch.object(tp, 'CONTROL_RATE', (100, 60))  # many control connections on purpose here
    def test_bad_messages_close_only_that_connection(self):
        bad_lines = [b'not json', b'[1, 2]', b'{"t": "ports", "ports": [true]}', b'{"t": "ports", "ports": ["80"]}',
                     b'{"t": "ports", "ports": [80, 80]}', b'{"t": "ports", "ports": [70000]}',
                     b'{"t": "ports", "ports": [80], "x": 1}', b'{"t": "nope"}', b'{"t": "ports", "ports": NaN}',
                     json.dumps({'t': 'ports', 'ports': list(range(1, 66))}).encode(), b'{"t": "fail", "id": "zz"}',
                     b'\xff\xfe']
        for raw in bad_lines:
            with self.subTest(raw=raw[:40]):
                agent = Agent(self.sock_path)
                agent.ctl.sendall(raw + b'\n')
                self.assertTrue(self.control_closed(agent))
                agent.close()
        # Bad first lines.
        for raw in (b'{"t": "hello", "v": true}', b'{"t": "hello", "v": 2}', b'{"t": "data"}',
                    b'{"t": "data", "id": "ABC"}', b'hello'):
            with self.subTest(first=raw):
                agent = Agent(self.sock_path, hello=False)
                agent.ctl.sendall(raw + b'\n')
                self.assertTrue(self.control_closed(agent))
                agent.close()
        # The service still works for a well-behaved agent.
        self.forward()

    def test_agent_cannot_choose_a_destination(self):
        """A malicious agent can only answer opens; the host never connects anywhere."""
        source = (ROOT / 'terminal_ports.py').read_text()
        self.assertNotIn('.connect(', source)
        self.assertNotIn('create_connection', source)
        self.assertNotIn('connect_ex', source)
        agent = Agent(self.sock_path)
        for message in ({'t': 'data', 'id': 'a' * 32, 'host': '127.0.0.1', 'port': 22},
                        {'t': 'open', 'id': 'a' * 32, 'port': 22}, {'t': 'connect', 'host': 'docker.sock'}):
            sock = agent.dial()
            agent.line(message, sock)
            self.assertTrue(closed_by_peer(sock), message)
            sock.close()
        agent.line({'t': 'open', 'id': 'a' * 32, 'port': 22})
        self.assertTrue(self.control_closed(agent))

    def test_unknown_and_reused_ids_are_closed(self):
        server, agent, item = self.forward(Agent(self.sock_path))
        stranger = agent.answer('b' * 32)
        self.assertTrue(closed_by_peer(stranger), 'unknown id')
        client = tcp('127.0.0.1', item['host_port'])
        msg = agent.read_open()
        self.assertEqual((msg['t'], msg['port']), ('open', server.port))
        self.assertTrue(tp.ID_RE.fullmatch(msg['id']))
        first = agent.answer(msg['id'], extra=b'from-sandbox')
        self.assertEqual(client.recv(100), b'from-sandbox')
        client.sendall(b'from-browser')
        self.assertEqual(first.recv(100), b'from-browser')
        second = agent.answer(msg['id'])
        self.assertTrue(closed_by_peer(second), 'an id is valid once')
        client.close()
        self.assertTrue(closed_by_peer(first))
        # The control connection survived the bad data connections.
        agent.ports([])
        self.wait_items(0)

    def test_slow_answer_and_fail_close_the_browser_connection(self):
        server, agent, item = self.forward(Agent(self.sock_path))
        with mock.patch.object(tp, 'OPEN_TIMEOUT', 0.5):
            client = tcp('127.0.0.1', item['host_port'])
            msg = agent.read_open()
            started = time.time()
            self.assertTrue(closed_by_peer(client))
            self.assertLess(time.time() - started, 4)
            late = agent.answer(msg['id'])
            self.assertTrue(closed_by_peer(late), 'a late answer finds a dead id')
        client = tcp('127.0.0.1', item['host_port'])
        msg = agent.read_open()
        agent.line({'t': 'fail', 'id': msg['id']})
        started = time.time()
        self.assertTrue(closed_by_peer(client, timeout=4))
        self.assertLess(time.time() - started, 3)
        agent.line({'t': 'fail', 'id': 'c' * 32})  # unknown fail ids are ignored (it may have timed out)
        agent.ports([server.port])
        time.sleep(0.2)
        self.assertEqual(len(self.sp.items()), 1)

    def test_flood_of_opens_is_capped(self):
        server, agent, item = self.forward(Agent(self.sock_path))
        clients = [tcp('127.0.0.1', item['host_port']) for _ in range(40)]
        opens = []
        agent.ctl.settimeout(2)
        with contextlib.suppress(OSError):
            while True:
                opens.append(agent.read_open(timeout=2))
        self.assertEqual(len(opens), tp.MAX_PENDING)
        closed = sum(1 for c in clients if closed_by_peer(c, timeout=0.5))
        self.assertGreaterEqual(closed, 40 - tp.MAX_SESSION_CONNS)
        self.assertLessEqual(len(self.sp.conns), tp.MAX_SESSION_CONNS)
        for c in clients:
            c.close()
        wait(lambda: not self.sp.conns and not self.sp.pending, timeout=15)
        self.assertEqual(self.hub.total_conns, 0)

    def test_total_connection_cap(self):
        server, agent, item = self.forward()
        with mock.patch.object(tp, 'MAX_TOTAL_CONNS', 3):
            kept = [tcp('127.0.0.1', item['host_port']) for _ in range(3)]
            for c in kept:
                c.sendall(b'x')
                self.assertEqual(c.recv(1), b'x')
            extra = tcp('127.0.0.1', item['host_port'])
            self.assertTrue(closed_by_peer(extra, timeout=5))
            for c in kept:
                c.close()
        wait(lambda: self.hub.total_conns == 0)

    def test_flood_of_unidentified_connections_and_hello_deadline(self):
        with mock.patch.object(tp, 'HELLO_TIMEOUT', 1):
            silent = [Agent(self.sock_path, hello=False) for _ in range(tp.MAX_UNIDENTIFIED)]
            wait(lambda: self.sp.unidentified == tp.MAX_UNIDENTIFIED)
            extra = Agent(self.sock_path, hello=False)
            self.assertTrue(closed_by_peer(extra.ctl, timeout=0.8), 'over the cap: closed at once')
            started = time.time()
            for agent in silent:
                self.assertTrue(closed_by_peer(agent.ctl, timeout=5))
            self.assertLess(time.time() - started, 4)
            # A trickle does not extend the deadline.
            trickle = Agent(self.sock_path, hello=False)
            started = time.time()
            for _ in range(10):
                with contextlib.suppress(OSError):
                    trickle.ctl.sendall(b' ')
                time.sleep(0.2)
            self.assertTrue(closed_by_peer(trickle.ctl, timeout=3))
            self.assertLess(time.time() - started, 4)
        wait(lambda: self.sp.unidentified == 0)

    def test_control_reconnect_rate(self):
        limit, _ = tp.CONTROL_RATE
        agents = []
        for _ in range(limit):
            agents.append(Agent(self.sock_path))
            agents[-1].ports([])
            time.sleep(0.05)
        for old in agents[:-1]:
            self.assertTrue(closed_by_peer(old.ctl), 'a new control connection replaces the old one')
        over = Agent(self.sock_path)
        self.assertTrue(closed_by_peer(over.ctl), 'too many control connections this minute')
        self.assertFalse(closed_by_peer(agents[-1].ctl, timeout=0.3), 'the current one stays')


class ReviewFixTests(HubCase):
    """Regression tests for the independent review of 1aa50ea."""

    def test_wake_byte_never_blocks_under_the_hub_lock(self):
        acceptor = self.hub.acceptor
        self.assertFalse(acceptor.wake_w.getblocking())
        with self.hub.lock:  # the accept thread cannot drain while we hold everything up
            with contextlib.suppress(BlockingIOError):
                while True:
                    acceptor.wake_w.send(b'x' * 4096)
            sock = socket.socket()
            sock.bind(('127.0.0.1', 0))
            sock.listen(1)
            done = threading.Event()
            threading.Thread(target=lambda: (acceptor.add(sock, lambda c: c.close()), done.set()), daemon=True).start()
            self.assertTrue(done.wait(3), 'add() returned with a full wake-up pipe')
        acceptor.remove(sock)
        self.forward()  # still accepting

    def test_ports_reports_are_rate_limited(self):
        agent = Agent(self.sock_path)
        limit, _ = tp.REPORT_RATE
        with contextlib.suppress(OSError):
            for i in range(limit + 1):
                agent.ports([40000 + i % 2])
        self.assertTrue(closed_by_peer(agent.ctl))

    def test_deeply_nested_json_is_just_malformed(self):
        agent = Agent(self.sock_path, hello=False)
        agent.ctl.sendall(b'[' * 4000 + b'\n')
        self.assertTrue(closed_by_peer(agent.ctl))
        agent = Agent(self.sock_path)
        agent.ctl.sendall(b'{"t": "ports", "ports": ' + b'[' * 4000 + b'\n')
        self.assertTrue(closed_by_peer(agent.ctl))
        wait(lambda: self.sp.unidentified == 0)

    def test_thread_start_failure_does_not_leak_counters(self):
        server, agent, item = self.forward()

        class NoThread(threading.Thread):
            def start(self):
                raise RuntimeError("can't start new thread")
        with mock.patch.object(tp.threading, 'Thread', NoThread):
            client = tcp('127.0.0.1', item['host_port'])
            self.assertTrue(closed_by_peer(client))
            stranger = Agent(self.sock_path, hello=False)
            self.assertTrue(closed_by_peer(stranger.ctl))
        self.assertEqual((self.hub.total_conns, len(self.sp.conns), self.sp.unidentified), (0, 0, 0))

    def test_idle_reservations_of_other_sessions_are_reused_when_the_range_is_full(self):
        lo = self.range[0]
        self.hub.range = (lo, lo)
        server, agent, item = self.forward()
        agent.ports([])
        self.wait_items(0)
        path2 = self.base / 'ports2.sock'
        sp2 = self.hub.open_session(str(path2), FakeOwner())
        other = self.server()
        AutoAgent(path2).ports([other.port])
        self.assertEqual(wait(lambda: sp2.items())[0]['host_port'], lo, 'took the idle number')
        self.assertEqual(self.sp.reserved, {})
        agent.ports([server.port])
        time.sleep(0.3)
        self.assertEqual(self.sp.items(), [], 'an active forward is never taken')


class ReviewRound1Tests(HubCase):
    """Regression tests for the independent review of 0632c25 (repros R1-R4)."""

    def test_r1_switching_off_closes_tailnet_listeners_even_when_the_save_fails(self):
        server, agent, item = self.forward()
        host_port = item['host_port']
        self.hub.set_tailscale(True)
        via_tailnet = tcp('127.0.0.2', host_port)
        via_tailnet.sendall(b'p')
        self.assertEqual(via_tailnet.recv(1), b'p')
        with mock.patch.object(tp.os, 'fsync', side_effect=OSError(28, 'No space left on device')):
            with self.assertRaises(OSError):  # the service answers 500 settings_failed
                self.hub.set_tailscale(False)
        self.assertFalse(connectable('127.0.0.2', host_port), 'off means off, saved or not')
        self.assertTrue(closed_by_peer(via_tailnet, timeout=2))
        payload = self.hub.settings_payload()
        self.assertEqual((payload['ports_tailscale'], payload['tailscale_address']), (False, None))
        self.hub.refresh()  # the 60 s check must not turn it back on from the stale file
        self.assertFalse(connectable('127.0.0.2', host_port))
        self.assertIsNone(self.sp.items()[0]['tailscale_url'])

    def test_r1_mirror_a_failed_save_when_switching_on_leaves_it_off(self):
        server, agent, item = self.forward()
        with mock.patch.object(tp.os, 'fsync', side_effect=OSError(28, 'No space left on device')):
            with self.assertRaises(OSError):
                self.hub.set_tailscale(True)
        self.assertFalse(connectable('127.0.0.2', item['host_port']))
        self.assertFalse(self.hub.settings_payload()['ports_tailscale'])
        self.hub.refresh()
        self.assertFalse(connectable('127.0.0.2', item['host_port']))

    def test_r2_settings_work_again_after_a_failed_write_of_a_corrupt_file(self):
        path = self.base / 'r2-settings.json'
        path.write_text('{not json')
        store = tp.SettingsStore(path, log=lambda m: None)
        self.assertEqual(store.state, 'corrupt')
        with mock.patch.object(tp.os, 'fsync', side_effect=OSError(28, 'No space left on device')):
            with self.assertRaises(OSError):
                store.update(ports_tailscale=True)
        store.update(ports_tailscale=True)  # disk is fine again: no restart needed
        self.assertTrue(store.get('ports_tailscale'))
        self.assertEqual(len([p for p in self.base.iterdir() if p.name.startswith('r2-settings.json.corrupt-')]), 1)
        self.assertEqual(json.loads(path.read_text()), {'ports_tailscale': True})

    def open_hogs(self, count):
        ports = []
        for n in range(count):
            path = self.base / f'hog{n}.sock'
            sp = self.hub.open_session(str(path), FakeOwner())
            server = self.server()
            AutoAgent(path).ports([server.port])
            ports.append(wait(lambda sp=sp: sp.items() and sp.items()[0])['host_port'])
        return ports

    def held(self, host_port, count):
        out = []
        for _ in range(count):
            c = tcp('127.0.0.1', host_port)
            c.sendall(b'x')
            self.assertEqual(c.recv(1), b'x')
            out.append(c)
        return out

    def test_r3_one_client_at_its_cap_leaves_room_for_another_client(self):
        """Rewritten in round 2 (fair-share eviction dropped, N1): the per-IP cap is what keeps a
        hog from filling the global cap; another client (another IP) still gets in."""
        hogs = self.open_hogs(2)
        server, agent, item = self.forward()  # another session, another client
        with mock.patch.object(tp, 'MAX_CLIENT_CONNS', 3), mock.patch.object(tp, 'MAX_TOTAL_CONNS', 4):
            held = self.held(hogs[0], 2) + self.held(hogs[1], 1)
            refused = tcp('127.0.0.1', hogs[1])
            self.assertTrue(closed_by_peer(refused, timeout=3), 'the hog is at its per-IP cap')
            other = tcp('127.0.0.1', item['host_port'], source='127.0.0.5')
            other.sendall(b'v')
            self.assertEqual(other.recv(1), b'v', 'another client still gets in')
            self.assertFalse(any(closed_by_peer(c, timeout=0.2) for c in held), 'nothing was evicted')

    def test_r3_per_client_cap_across_sessions(self):
        hogs = self.open_hogs(2)
        with mock.patch.object(tp, 'MAX_CLIENT_CONNS', 3):
            self.held(hogs[0], 2)
            self.held(hogs[1], 1)
            extra = tcp('127.0.0.1', hogs[1])
            self.assertTrue(closed_by_peer(extra, timeout=3), 'the 4th connection from one IP is refused')
            self.assertEqual(self.hub.client_conns, {'127.0.0.1': 3})
        close_all()
        wait(lambda: self.hub.client_conns == {} and self.hub.total_conns == 0)

    def test_r3_idle_connections_close_only_under_pressure(self):
        hogs = self.open_hogs(1)
        with mock.patch.object(tp, 'MAX_TOTAL_CONNS', 4):
            held = self.held(hogs[0], 3)  # 75%: not over the threshold
            future = time.monotonic() + tp.IDLE_CLOSE + 1
            self.assertEqual(self.hub.reap_idle_conns(now=future), 0)
            held += self.held(hogs[0], 1)  # 100%
            self.assertEqual(self.hub.reap_idle_conns(now=time.monotonic()), 0, 'not idle long enough')
            held[0].sendall(b'y')  # one connection stays busy
            self.assertEqual(held[0].recv(1), b'y')
            # Every connection is idle at "future" except none has had traffic since; pretend the busy
            # one sent bytes just before it.
            busy = next(r for sp in self.hub.sessions for r in sp.conns
                        if r.client.getpeername() == held[0].getsockname())
            busy.last = future
            self.assertEqual(self.hub.reap_idle_conns(now=future), 3)
            self.assertFalse(closed_by_peer(held[0], timeout=0.3), 'the busy connection stays')
            for c in held[1:]:
                self.assertTrue(closed_by_peer(c, timeout=2))

    def test_r4_auto_never_falls_back_to_a_non_tailscale_cgnat_address(self):
        isp_cgnat_on_eth0 = '100.72.13.9'
        detect = tailscale_address('auto', addresses=lambda: {'127.0.0.1', isp_cgnat_on_eth0},
                                     interfaces=lambda: ['lo', 'eth0'],
                                     interface=lambda name: isp_cgnat_on_eth0 if name == 'eth0' else None).detect()
        self.assertIsNone(detect)
        detect = tailscale_address('auto', addresses=lambda: {'127.0.0.1', isp_cgnat_on_eth0},
                                     interface=lambda name: None).detect()  # the reviewer's form, real interface list
        self.assertIsNone(detect)


class ForwarderAgentTests(HubCase):
    """The agent runs as a supervised thread inside bbterm-forward (one process per sandbox)."""

    def load_forwarder(self):
        spec = importlib.util.spec_from_file_location('bbterm_forward', ROOT / 'sandbox/bbterm-forward.py')
        module = importlib.util.module_from_spec(spec)
        old = sys.argv
        sys.argv = ['bbterm-forward']
        try:
            spec.loader.exec_module(module)
        finally:
            sys.argv = old
        return module

    def test_forwarder_process_runs_the_agent(self):
        import subprocess
        probe = socket.socket()
        probe.bind(('127.0.0.1', 0))
        free = probe.getsockname()[1]
        probe.close()
        proc = subprocess.Popen([sys.executable, '-I', str(ROOT / 'sandbox/bbterm-forward.py'), str(free),
                                 str(self.base / 'no-proxy.sock'), str(self.sock_path)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait(lambda: self.sp.control is not None, timeout=15, message='the agent thread never connected')
            self.assertIsNone(proc.poll(), 'the forwarder keeps running')
            # Its own listen port (3128 in the container) is excluded from what it reports.
            time.sleep(1.5)
            self.assertNotIn(free, self.sp.forwards)
        finally:
            proc.terminate()
            proc.wait(timeout=10)

    def test_supervisor_restarts_a_dead_agent(self):
        forwarder = self.load_forwarder()
        counter = self.base / 'starts'
        fake = self.base / 'fake-agent'
        fake.write_text(
            'import pathlib\n'
            f'COUNTER = pathlib.Path({str(counter)!r})\n'
            'def main():\n'
            '    COUNTER.write_text(str(int(COUNTER.read_text() or 0) + 1) if COUNTER.exists() else "1")\n'
            '    raise RuntimeError("agent crashed")\n')
        threading.Thread(target=forwarder.supervise_agent, args=(str(fake), str(self.sock_path), 3128),
                         kwargs={'sleep': lambda s: time.sleep(0.02), 'log': lambda line: None}, daemon=True).start()
        wait(lambda: counter.exists() and int(counter.read_text()) >= 3, message='agent not restarted')
        agent = forwarder.load_agent(str(ROOT / 'sandbox/bbterm-ports.py'), '/run/bbterm/ports.sock', 3128)
        self.assertEqual((agent.SOCKET, agent.EXCLUDE), ('/run/bbterm/ports.sock', {3128}))


class ReviewRound2Tests(HubCase):
    """Regression tests for the re-review of 7493c3c (N1-N3)."""

    def test_n1_active_connections_of_another_session_are_never_evicted(self):
        path = self.base / 'busy.sock'
        busy_sp = self.hub.open_session(str(path), FakeOwner())
        server = self.server()
        AutoAgent(path).ports([server.port])
        busy_port = wait(lambda: busy_sp.items() and busy_sp.items()[0])['host_port']
        _, _, item = self.forward()  # the other client's session
        with mock.patch.object(tp, 'MAX_TOTAL_CONNS', 4):
            live = [tcp('127.0.0.1', busy_port) for _ in range(4)]
            for c in live:
                c.sendall(b'a')
                self.assertEqual(c.recv(1), b'a')
            for _ in range(3):  # the other session's client keeps reconnecting at the full cap
                attacker = tcp('127.0.0.1', item['host_port'], source='127.0.0.6')
                self.assertTrue(closed_by_peer(attacker, timeout=3), 'refused at the global cap')
            for c in live:  # every live connection still works
                c.sendall(b'b')
                self.assertEqual(c.recv(1), b'b')
            wait(lambda: any('total cap of 4 reached' in line for line in self.logs))

    def test_n2_supervisor_backs_off_and_rate_limits_its_log(self):
        forwarder = ForwarderAgentTests.load_forwarder(self)
        fake = self.base / 'crashing-agent'
        fake.write_text('def main():\n    raise RuntimeError("cannot start new thread")\n')
        now, sleeps, lines = [0.0], [], []

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds
        forwarder.supervise_agent(str(fake), str(self.sock_path), 3128, sleep=sleep, clock=lambda: now[0],
                                  log=lines.append, rounds=10)
        self.assertEqual(sleeps, [1, 2, 4, 8, 16, 30, 30, 30, 30, 30])
        self.assertEqual(len(lines), 3, lines)  # at 0 s, then at most one a minute
        self.assertIn('cannot start new thread', lines[0])
        self.assertNotIn('times since', lines[0])
        self.assertIn('times since the last report', lines[1])
        # An agent that stayed up for a minute restarts quickly again.
        long_lived = self.base / 'long-agent'
        long_lived.write_text('def main():\n    pass\n')
        sleeps.clear()
        clock = iter([0, 61, 61, 62, 62, 63]).__next__
        forwarder.supervise_agent(str(long_lived), str(self.sock_path), 3128, sleep=sleeps.append, clock=clock,
                                  log=lambda line: None, rounds=3)
        self.assertEqual(sleeps, [1, 2, 4])

    def test_n3_per_ip_cap_is_48_and_refusals_are_logged_rate_limited(self):
        self.assertEqual(tp.MAX_CLIENT_CONNS, 48)
        server, agent, item = self.forward()
        with mock.patch.object(tp, 'MAX_CLIENT_CONNS', 1):
            first = tcp('127.0.0.1', item['host_port'])
            first.sendall(b'x')
            self.assertEqual(first.recv(1), b'x')
            for _ in range(3):
                self.assertTrue(closed_by_peer(tcp('127.0.0.1', item['host_port']), timeout=3))
        lines = [line for line in self.logs if 'refused' in line]
        self.assertEqual(lines, ['preview port connection from 127.0.0.1 refused: per-client-IP cap of 1 reached'])
        with mock.patch.object(tp, 'MAX_CLIENT_CONNS', 1), mock.patch.object(tp, 'REFUSAL_LOG_EVERY', 0):
            self.assertTrue(closed_by_peer(tcp('127.0.0.1', item['host_port']), timeout=3))
        lines = [line for line in self.logs if 'refused' in line]
        self.assertEqual(lines[-1], 'preview port connection from 127.0.0.1 refused: per-client-IP cap of 1 reached '
                                    '(3 refused since the last report)')


class BackendOrderTests(unittest.TestCase):
    def test_destroy_closes_ports_even_when_docker_rm_fails(self):
        import subprocess
        base = fx.tmp_base('destroy-order')
        try:
            backend = sb.DockerBackend(image='bbterm-test-none', state_dir=base, proxy=None)
            closed = []

            class Session:
                id = 'abc123'

                def close_ports(self):
                    closed.append(True)
            with mock.patch.object(backend, 'run', side_effect=subprocess.TimeoutExpired('docker', 60)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    backend.destroy(Session())
            self.assertEqual(closed, [True])
        finally:
            shutil.rmtree(base, ignore_errors=True)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('settings')
        self.path = self.base / 'settings.json'
        self.logs = []

    def tearDown(self):
        os.chmod(self.base, 0o755)
        shutil.rmtree(self.base, ignore_errors=True)

    def store(self):
        return tp.SettingsStore(self.path, log=self.logs.append)

    def test_defaults_atomic_write_and_mode(self):
        store = self.store()
        self.assertEqual((store.get('ports_tailscale'), store.state), (False, 'missing'))
        store.update(ports_tailscale=True)
        self.assertEqual(json.loads(self.path.read_text()), {'ports_tailscale': True})
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), ['settings.json'], 'no temp file left')
        self.assertTrue(self.store().get('ports_tailscale'), 'persists')

    def test_unknown_keys_are_kept_for_later_settings(self):
        self.path.write_text(json.dumps({'ports_tailscale': False, 'theme_later': 'x'}))
        self.store().update(ports_tailscale=True)
        self.assertEqual(json.loads(self.path.read_text()), {'ports_tailscale': True, 'theme_later': 'x'})

    def test_corrupt_file_is_set_aside_before_replacing(self):
        for raw in (b'{not json', b'[]', b'{"ports_tailscale": "yes"}', b'\xff'):
            with self.subTest(raw=raw):
                for p in self.base.iterdir():
                    p.unlink()
                self.path.write_bytes(raw)
                store = self.store()
                self.assertEqual((store.get('ports_tailscale'), store.state), (False, 'corrupt'))
                self.assertEqual(self.path.read_bytes(), raw, 'reading never changes the file')
                store.update(ports_tailscale=True)
                aside = [p for p in self.base.iterdir() if '.corrupt-' in p.name]
                self.assertEqual(len(aside), 1)
                self.assertEqual(aside[0].read_bytes(), raw)
                self.assertEqual(json.loads(self.path.read_text()), {'ports_tailscale': True})

    def test_failed_read_is_never_written_over(self):
        self.path.write_text('{"ports_tailscale": true}')
        os.chmod(self.path, 0)
        try:
            if os.access(self.path, os.R_OK):
                self.skipTest('running as root')
            store = self.store()
            self.assertEqual(store.state, 'unreadable')
            with self.assertRaises(tp.PortsError) as caught:
                store.update(ports_tailscale=False)
            self.assertEqual(caught.exception.code, 'settings_unreadable')
        finally:
            os.chmod(self.path, 0o600)
        self.assertEqual(self.path.read_text(), '{"ports_tailscale": true}')
        # A symlink or a directory at the name is not read and not replaced either.
        target = self.base / 'elsewhere.json'
        target.write_text('{"ports_tailscale": true}')
        self.path.unlink()
        self.path.symlink_to(target)
        store = self.store()
        self.assertEqual(store.state, 'unreadable')
        with self.assertRaises(tp.PortsError):
            store.update(ports_tailscale=False)
        self.assertTrue(self.path.is_symlink())
        self.path.unlink()
        self.path.mkdir()
        self.assertEqual(self.store().state, 'unreadable')

    def test_failed_replace_keeps_the_old_file(self):
        self.path.write_text('{"ports_tailscale": false}')
        store = self.store()
        with mock.patch.object(tp.os, 'replace', side_effect=OSError(28, 'No space left')):
            with self.assertRaises(OSError):
                store.update(ports_tailscale=True)
        self.assertEqual(self.path.read_text(), '{"ports_tailscale": false}')
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), ['settings.json'])
        self.assertFalse(store.get('ports_tailscale'))


class TailscaleTests(HubCase):
    def test_detection_rules(self):
        def make(spec, addrs, ifaces=None, nets=(tp.CGNAT,)):
            ifaces = ifaces or {}
            return tailscale_address(spec, networks=nets, addresses=lambda: addrs, interfaces=lambda: list(ifaces),
                                       interface=lambda name: ifaces.get(name)).detect()
        both = {'192.168.1.5', '100.101.1.2', '100.64.0.9'}
        self.assertEqual(make('auto', both, {'eth0': '100.64.0.9', 'tailscale0': '100.101.1.2'}), '100.101.1.2')
        self.assertEqual(make('auto', both, {'tailscale1': '100.64.0.9', 'tailscale0': '100.101.1.2'}), '100.101.1.2',
                         'tailscale0 first')
        self.assertEqual(make('auto', both, {'tailscale1': '100.64.0.9', 'tailscale0': None}), '100.64.0.9',
                         'another tailscale* interface')
        self.assertIsNone(make('auto', both, {'eth0': '100.64.0.9', 'tailscale0': None}), 'never a non-Tailscale interface')
        self.assertIsNone(make('auto', both, {'tailscale0': '100.99.9.9'}), 'the interface address must be local')
        self.assertIsNone(make('auto', {'192.168.1.5', '127.0.0.1', 'fd7a:115c:a1e0::1'}, {'tailscale0': '127.0.0.1'}))
        self.assertEqual(make('100.101.1.2', {'100.101.1.2'}), '100.101.1.2', 'explicit: any interface')
        self.assertIsNone(make('100.101.1.2', {'100.64.0.9'}), 'an explicit address must be local')
        self.assertIsNone(make('auto', {'127.0.0.2'}, {'tailscale0': '127.0.0.2'}), 'loopback only with the test override')
        self.assertEqual(tp.parse_tailscale_address('auto'), 'auto')
        self.assertEqual(tp.parse_tailscale_address('100.100.1.1'), '100.100.1.1')
        for bad in ('0.0.0.0', '127.0.0.1', '192.168.1.1', '100.128.0.1', '::', 'fd7a:115c:a1e0::1', 'tailscale0'):
            with self.assertRaises(ValueError, msg=bad):
                tp.parse_tailscale_address(bad)
        self.assertEqual(tp.parse_range('9100-9199'), (9100, 9199))
        for bad in ('80-90', '9100', '9199-9100', '9000-10500', '9100-70000'):
            with self.assertRaises(ValueError, msg=bad):
                tp.parse_range(bad)

    def test_live_toggle_opens_and_closes_listeners_and_connections(self):
        server, agent, item = self.forward()
        host_port = item['host_port']
        payload = self.hub.settings_payload()
        self.assertEqual(payload, {'preview_ports': True, 'ports_tailscale': False, 'tailscale_address': None,
                                   'tailscale_reason': 'disabled', 'ports_range': list(self.range)})
        changes = self.owner.changes
        payload = self.hub.set_tailscale(True)
        self.assertEqual((payload['ports_tailscale'], payload['tailscale_address'], payload['tailscale_reason']),
                         (True, '127.0.0.2', None))
        self.assertGreater(self.owner.changes, changes, 'viewers hear about the new URL')
        via_tailnet = tcp('127.0.0.2', host_port)
        via_local = tcp('127.0.0.1', host_port)
        for sock in (via_tailnet, via_local):
            sock.sendall(b'ping')
            self.assertEqual(sock.recv(4), b'ping')
        payload = self.hub.set_tailscale(False)
        self.assertEqual((payload['ports_tailscale'], payload['tailscale_address'], payload['tailscale_reason']),
                         (False, None, 'disabled'))
        self.assertTrue(closed_by_peer(via_tailnet), 'switching off closes open tailnet connections')
        self.assertFalse(connectable('127.0.0.2', host_port))
        via_local.sendall(b'still')
        self.assertEqual(via_local.recv(5), b'still', 'local connections stay')
        via_local.close()
        self.assertIsNone(self.sp.items()[0]['tailscale_url'])
        self.assertFalse(json.loads((self.base / 'settings.json').read_text())['ports_tailscale'])

    def test_switching_on_without_an_address_is_refused_and_not_saved(self):
        self.addresses = {'127.0.0.1'}
        with self.assertRaises(tp.PortsError) as caught:
            self.hub.set_tailscale(True)
        self.assertEqual(caught.exception.code, 'tailscale_not_found')
        self.assertFalse((self.base / 'settings.json').exists())
        self.assertFalse(self.hub.settings_payload()['ports_tailscale'])

    def test_address_change_rebinds_and_loss_reports_not_found(self):
        server, agent, item = self.forward()
        host_port = item['host_port']
        self.hub.set_tailscale(True)
        self.addresses = {'127.0.0.1', '127.0.0.3'}
        self.hub.refresh()
        self.assertEqual(self.hub.settings_payload()['tailscale_address'], '127.0.0.3')
        self.assertTrue(connectable('127.0.0.3', host_port))
        self.assertFalse(connectable('127.0.0.2', host_port))
        self.assertEqual(self.sp.items()[0]['tailscale_url'], f'http://127.0.0.3:{host_port}/')
        self.addresses = {'127.0.0.1'}
        self.hub.refresh()
        payload = self.hub.settings_payload()
        self.assertEqual((payload['ports_tailscale'], payload['tailscale_address'], payload['tailscale_reason']),
                         (True, None, 'not_found'))
        self.assertFalse(connectable('127.0.0.3', host_port))
        self.assertTrue(connectable('127.0.0.1', host_port))

    def test_setting_survives_restart_and_new_forwards_bind_both(self):
        self.hub.set_tailscale(True)
        self.hub.close()
        self.hub = tp.PortsHub(state_dir=self.base, ports_range=self.range, tailscale=self.tailscale,
                               log=self.logs.append, refresh_interval=0)
        self.sp = self.hub.open_session(str(self.sock_path), self.owner)
        server, agent, item = self.forward()
        self.assertEqual(item['tailscale_url'], f'http://127.0.0.2:{item["host_port"]}/')


class PortsDocker(FakeDocker):
    """FakeDocker with a ports.sock per session, like DockerBackend."""

    def __init__(self, base, hub):
        super().__init__()
        self.base, self.ports_hub = Path(base), hub

    def path(self, session):
        return self.base / f'{session.id}.sock'

    def create(self, session):
        super().create(session)
        session.ports = self.ports_hub.open_session(str(self.path(session)), session)

    def destroy(self, session):
        session.close_ports()
        super().destroy(session)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('ports-life')
        self.root = fx.make_root(self.base)
        self.now = [0.0]
        self.hub = tp.PortsHub(state_dir=self.base / 'state', ports_range=free_range(), refresh_interval=0,
                               tailscale=tailscale_address(addresses=lambda: set()))
        self.docker = PortsDocker(self.base, self.hub)
        self.manager = sb.SessionManager(self.root, self.docker, max_sessions=3, pause_after=300, remove_after=4 * 3600,
                                         min_free_memory=0, clock=lambda: self.now[0], reap_interval=0, log=lambda m: None)
        self.servers = []

    def tearDown(self):
        close_all()
        self.manager.close()
        self.hub.close()
        for server in self.servers:
            server.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def open_forward(self):
        viewer = FakeViewer()
        session = self.manager.attach(fx.selector(), viewer)
        server = EchoServer()
        self.servers.append(server)
        agent = AutoAgent(self.docker.path(session))
        agent.ports([server.port])
        item = wait(lambda: session.ports.items())[0]
        return session, viewer, agent, server, item

    def test_ports_are_pushed_to_viewers_and_in_session_info(self):
        session, viewer, agent, server, item = self.open_forward()
        pushed = wait(lambda: [c for c in viewer.controls if c['type'] == 'ports' and c['ports']])
        self.assertEqual(pushed[-1]['ports'], [item])
        self.assertEqual(session.info()['ports'], [item])
        agent.ports([])
        wait(lambda: viewer.controls[-1] == {'type': 'ports', 'ports': []})

    def test_inbound_connection_unpauses_and_traffic_delays_only_the_pause(self):
        session, viewer, agent, server, item = self.open_forward()
        self.manager.detach(session, viewer)
        self.now[0] = 300
        self.assertEqual(self.manager.reap_idle(), ([session], []))
        self.assertEqual(session.ports.items()[0]['state'], 'paused')
        client = tcp('127.0.0.1', item['host_port'])
        client.sendall(b'wake')
        self.assertEqual(client.recv(4), b'wake')
        self.assertFalse(session.paused)
        self.assertEqual(self.docker.containers[session.id], 'running')
        self.assertIn(('unpause', session.id), self.docker.calls)
        self.assertEqual(session.ports.items()[0]['state'], 'open')
        client.close()
        # Traffic at 500 keeps it running until 800, not 600.
        self.now[0] = 500
        self.manager.port_activity(session)
        self.now[0] = 799
        self.assertEqual(self.manager.reap_idle(), ([], []))
        self.now[0] = 800
        self.assertEqual(self.manager.reap_idle(), ([session], []))
        # Removal still counts from when the last viewer left (t=0), traffic or not.
        self.now[0] = 4 * 3600 - 10
        self.manager.port_activity(session)  # unpauses again
        self.assertFalse(session.paused)
        self.now[0] = 4 * 3600
        paused, removed = self.manager.reap_idle()
        self.assertEqual(removed, [session])
        self.assertFalse(connectable('127.0.0.1', item['host_port']), 'removal closes the listener')
        self.assertIsNone(session.ports)

    def test_reset_releases_and_recreates(self):
        session, viewer, agent, server, item = self.open_forward()
        old_path = self.docker.path(session)
        self.manager.reset(fx.selector())
        self.assertFalse(connectable('127.0.0.1', item['host_port']))
        self.assertEqual(session.ports.items(), [], 'the new sandbox starts with no ports')
        self.assertNotEqual(self.docker.path(session), old_path)
        self.assertEqual(self.hub.total_conns, 0)


if __name__ == '__main__':
    unittest.main()
