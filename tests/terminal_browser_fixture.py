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

Prints one JSON line {port, password, keys, lane}. Uses the TEST-ONLY local
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


def main():
    target, modes = Path(sys.argv[1]), set(sys.argv[2].split(','))
    root = fx.make_root(target)
    front, term_port = free_port(), free_port()
    board = app.make_server(root, port=0, terminal_url=None if 'noterm' in modes else '/terminal/',
                            **({} if 'nolive' in modes else {'live_edit_dir': target / 'live-state'}))
    threading.Thread(target=board.serve_forever, daemon=True).start()
    proc = None
    if not ({'noterm', 'down'} & modes):
        hash_file = target / 'terminal.hash'
        terminal_auth.write_hash_file(hash_file, terminal_auth.hash_password(PASSWORD, n=2 ** 14))
        env = {**os.environ, 'BBTERM_ALLOW_LOCAL_BACKEND': '1', 'TMPDIR': os.environ.get('TMPDIR', str(target))}
        proc = subprocess.Popen([sys.executable, str(ROOT / 'terminal_service.py'), '--root', str(root), '--port', str(term_port),
                                 '--allowed-origin', f'http://127.0.0.1:{front}', '--allow-tailnet-user', 'ryu@example.test',
                                 '--password-hash-file', str(hash_file), '--state-dir', str(target / 'term-state'),
                                 '--backend', 'local-test-only'], env=env, stdout=subprocess.DEVNULL)
        for _ in range(200):
            try:
                socket.create_connection(('127.0.0.1', term_port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
    front_proxy(front, board.server_port, term_port, modes)
    lane = root / fx.FAMILY / fx.PROGRAM / fx.LANE
    print(json.dumps({'port': front, 'password': PASSWORD, 'keys': terminal_checks.block_keys(BLOCKS), 'lane': str(lane)}), flush=True)
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
