"""Browser fixture for the sandbox terminal: Board + terminal service + a
Tailscale-Serve-like front proxy, all on 127.0.0.1 with synthetic data.

  python3 tests/terminal_browser_fixture.py DIR MODE

MODE is a comma list:
  tailnet    the front proxy adds Tailscale-User-Login (allowlisted)
  login      no identity header: the password page is needed
  strip      strip /terminal before forwarding (Serve may or may not)
  noterm     the Board runs without --terminal-url
  nolive     the Board runs without live editing
  down       --terminal-url is set but no terminal service runs
  fastpause  sandboxes pause after 10 s without a viewer (reaper every second)
  ports      --preview-ports, a TEST-ONLY Tailscale address (loopback alias 127.0.0.2 named in
             DIR/tailscale.txt; empty file = no address), a synthetic "sandbox" HTTP server on
             127.0.0.1, and a fake agent thread that reports the ports listed in DIR/ports.json
             and answers opens with the real agent's forward() (sandbox/bbterm-ports.py)

Prints one JSON line {port, password, keys, lane} (+ {sandbox_port, ports_file,
tailscale_file, ports_range} in ports mode). Uses the TEST-ONLY local
backend (plain bash in the report folder); the Docker sandbox is covered by
tests/test_terminal_docker.py.
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import app  # noqa: E402
import terminal_auth  # noqa: E402
import terminal_checks  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402

PASSWORD = 'synthetic-browser-password'
BLOCKS = ['echo step-one-ok\n', 'ls poc.py\n', 'print("hello from python")\n', '$ echo console-ok\nconsole-ok\n', 'echo step-one-ok\n',
          'for i in 1 2; do\n  echo loop-$i\ndone\n']


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def front_proxy(port, board_port, term_port, modes):
    """One request per connection; WebSocket upgrades are spliced through."""
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', port))
    listener.listen(64)

    def pump(a, b):
        try:
            while True:
                data = a.recv(65536)
                if not data:
                    break
                b.sendall(data)
        except OSError:
            pass
        finally:
            for s in (a, b):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def serve(client):
        try:
            head = b''
            while b'\r\n\r\n' not in head:
                chunk = client.recv(65536)
                if not chunk:
                    client.close()
                    return
                head += chunk
            head, _, rest = head.partition(b'\r\n\r\n')
            lines = head.decode('latin-1').split('\r\n')
            method, target, version = lines[0].split(' ', 2)
            headers = [line for line in lines[1:] if line]
            upgrade = any(h.lower().startswith('upgrade:') for h in headers)
            keep = []
            for h in headers:
                name = h.split(':', 1)[0].strip().lower()
                if name in ('tailscale-user-login', 'tailscale-user-name'):
                    continue  # Serve never passes client-supplied identity headers
                if name == 'connection' and not upgrade:
                    continue
                keep.append(h)
            if target == '/terminal' or target.startswith('/terminal/'):
                if 'down' in modes:
                    client.sendall(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                    client.close()
                    return
                upstream_port = term_port
                if 'strip' in modes:
                    target = target[len('/terminal'):] or '/'
                if 'tailnet' in modes:
                    keep += ['Tailscale-User-Login: ryu@example.test', 'Tailscale-User-Name: Ryu']
            else:
                upstream_port = board_port
                # Stands in for --tailnet-host: the Board sees its own authority.
                keep = [h for h in keep if h.split(':', 1)[0].strip().lower() not in ('host', 'origin')]
                keep.append(f'Host: 127.0.0.1:{board_port}')
                if any(h.lower().startswith('origin:') for h in headers):
                    keep.append(f'Origin: http://127.0.0.1:{board_port}')
            if not upgrade:
                keep.append('Connection: close')
            upstream = socket.create_connection(('127.0.0.1', upstream_port))
            upstream.sendall((f'{method} {target} {version}\r\n' + '\r\n'.join(keep) + '\r\n\r\n').encode('latin-1') + rest)
            threading.Thread(target=pump, args=(upstream, client), daemon=True).start()
            pump(client, upstream)
        except Exception:
            try:
                client.close()
            except OSError:
                pass

    def loop():
        while True:
            client, _ = listener.accept()
            threading.Thread(target=serve, args=(client,), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()


def free_range(size=10):
    for lo in range(31000, 60000, 37):
        socks = []
        try:
            for n in range(lo, lo + size):
                s = socket.socket()
                socks.append(s)
                s.bind(('127.0.0.1', n))
            return lo, lo + size - 1
        except OSError:
            continue
        finally:
            for s in socks:
                s.close()
    raise RuntimeError('no free port range')


def sandbox_server():
    """The PoC server "inside the sandbox" (a plain 127.0.0.1 listener; the agent connects to it)."""
    import http.server

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'<!doctype html><title>Synthetic PoC</title><p>synthetic-preview-ok</p>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


def fake_agent(sock_dir, ports_file):
    """Connects to the newest session's ports.sock, reports DIR/ports.json, answers opens
    with the real agent's forward(). Reconnects when the session is reset."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('bbterm_ports_agent', ROOT / 'sandbox/bbterm-ports.py')
    agent = importlib.util.module_from_spec(spec)
    old, sys.argv = sys.argv, ['bbterm-ports']
    try:
        spec.loader.exec_module(agent)
    finally:
        sys.argv = old

    def session(path):
        agent.SOCKET = str(path)
        ctl = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        ctl.connect(str(path))
        lock = threading.Lock()
        stop = threading.Event()
        agent.send_line(ctl, lock, {'t': 'hello', 'v': 1})
        threading.Thread(target=agent.reader, args=(ctl, lock, stop), daemon=True).start()
        last = None
        try:
            while not stop.is_set():
                try:
                    wanted = json.loads(Path(ports_file).read_text() or '[]')
                except (OSError, ValueError):
                    wanted = []
                if wanted != last:
                    agent.send_line(ctl, lock, {'t': 'ports', 'ports': wanted})
                    last = wanted
                newest = max(Path(sock_dir).glob('*/ports.sock'), key=lambda p: p.stat().st_mtime, default=None)
                if newest is not None and newest != path:
                    break  # a reset made a new sandbox
                stop.wait(0.2)
        finally:
            ctl.close()

    while True:
        try:
            newest = max(Path(sock_dir).glob('*/ports.sock'), key=lambda p: p.stat().st_mtime, default=None)
            if newest is not None:
                session(newest)
        except OSError:
            pass
        time.sleep(0.2)


def main():
    target, modes = Path(sys.argv[1]), set(sys.argv[2].split(','))
    root = fx.make_root(target)
    front, term_port = free_port(), free_port()
    board = app.make_server(root, port=0, terminal_url=None if 'noterm' in modes else '/terminal/',
                            **({} if 'nolive' in modes else {'live_edit_dir': target / 'live-state'}))
    threading.Thread(target=board.serve_forever, daemon=True).start()
    proc = None
    extra_info, ports_args, extra_env = {}, [], {}
    if 'ports' in modes:
        ports_range = free_range()
        ports_file, tailscale_file = target / 'ports.json', target / 'tailscale.txt'
        ports_file.write_text('[]')
        tailscale_file.write_text('127.0.0.2')
        ports_args = ['--preview-ports', '--ports-range', f'{ports_range[0]}-{ports_range[1]}']
        sandbox_port = sandbox_server()
        # TEST ONLY: the fake sandbox server is a host process here; tell the local backend to
        # leave it out of the host-listener scan (in Docker it lives in the container).
        extra_env = {'BBTERM_TEST_TAILSCALE_FILE': str(tailscale_file), 'BBTERM_TEST_SANDBOX_PORTS': str(sandbox_port)}
        extra_info = {'sandbox_port': sandbox_port, 'ports_file': str(ports_file),
                      'tailscale_file': str(tailscale_file), 'ports_range': list(ports_range)}
        threading.Thread(target=fake_agent, args=(target / 'term-state/local/ports', ports_file), daemon=True).start()
    if not ({'noterm', 'down'} & modes):
        hash_file = target / 'terminal.hash'
        terminal_auth.write_hash_file(hash_file, terminal_auth.hash_password(PASSWORD, n=2 ** 14))
        env = {**os.environ, 'BBTERM_ALLOW_LOCAL_BACKEND': '1', 'TMPDIR': os.environ.get('TMPDIR', str(target)), **extra_env}
        proc = subprocess.Popen([sys.executable, str(ROOT / 'terminal_service.py'), '--root', str(root), '--port', str(term_port),
                                 '--allowed-origin', f'http://127.0.0.1:{front}', '--allow-tailnet-user', 'ryu@example.test',
                                 '--password-hash-file', str(hash_file), '--state-dir', str(target / 'term-state'),
                                 '--backend', 'local-test-only', '--min-free-memory', '0',
                                 *(['--pause-after', '10', '--reap-interval', '1'] if 'fastpause' in modes else []), *ports_args],
                                env=env, stdout=subprocess.DEVNULL)
        for _ in range(200):
            try:
                socket.create_connection(('127.0.0.1', term_port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
    front_proxy(front, board.server_port, term_port, modes)
    lane = root / fx.FAMILY / fx.PROGRAM / fx.LANE
    print(json.dumps({'port': front, 'password': PASSWORD, 'keys': terminal_checks.block_keys(BLOCKS), 'lane': str(lane),
                      **extra_info}), flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        if proc:
            proc.terminate()
            proc.wait(timeout=10)


if __name__ == '__main__':
    import signal
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    main()
