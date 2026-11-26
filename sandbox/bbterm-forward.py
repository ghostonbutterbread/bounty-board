#!/usr/bin/env python3
"""In-container loopback forwarder: 127.0.0.1:3128 -> /run/bbterm/proxy.sock.

The container has no network (``--network none``); its only way out is the
terminal service's filtering proxy, reached over this Unix socket. HTTP_PROXY,
HTTPS_PROXY and ALL_PROXY point at 127.0.0.1:3128.

With a third argument (the preview-ports socket, /run/bbterm/ports.sock) the
same process also runs the preview-ports agent (bbterm-ports, next to this
file) in a thread, restarted by a supervisor loop if it ever dies. One process
instead of two saves about 9 MiB per sandbox.

Report agent (docs/integrations/report-agent.md): when the host created
model.sock next to the proxy socket (--report-agent), another supervised
thread listens on 127.0.0.1:3129 and copies each connection to it. The agent's
ANTHROPIC_BASE_URL points there; the host relay adds the login.

Usage: bbterm-forward [PORT [PROXY_SOCKET [PORTS_SOCKET]]]
"""
import importlib.machinery
import importlib.util
import os
import socket
import stat
import sys
import threading
import time

LISTEN = ('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 3128)
SOCKET = sys.argv[2] if len(sys.argv) > 2 else '/run/bbterm/proxy.sock'
PORTS_SOCKET = sys.argv[3] if len(sys.argv) > 3 else None
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PORT = 3129
MODEL_SOCKET = os.path.join(os.path.dirname(SOCKET), 'model.sock')
AGENT = next((p for p in (os.path.join(HERE, 'bbterm-ports'), os.path.join(HERE, 'bbterm-ports.py'))
              if os.path.exists(p)), os.path.join(HERE, 'bbterm-ports'))  # image name; repo name for tests


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s, how in ((dst, socket.SHUT_WR), (src, socket.SHUT_RD)):
            try:
                s.shutdown(how)
            except OSError:
                pass


def serve(client, path=None):
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect(path or SOCKET)
    except OSError:
        client.close()
        upstream.close()
        return
    t = threading.Thread(target=pump, args=(upstream, client), daemon=True)
    t.start()
    pump(client, upstream)
    t.join()
    client.close()
    upstream.close()


def load_agent(path, sock, exclude):
    loader = importlib.machinery.SourceFileLoader('bbterm_ports', path)
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader('bbterm_ports', loader))
    loader.exec_module(module)
    module.SOCKET, module.EXCLUDE = sock, {exclude}
    return module


def supervise_agent(path, sock, exclude, delay=1):
    """Run the preview-ports agent in a thread; start it again if it ever ends."""
    while True:
        try:
            agent = load_agent(path, sock, exclude)
            agent.EXCLUDE = agent.EXCLUDE | {MODEL_PORT}  # never offer the model relay port as a preview
            worker = threading.Thread(target=agent.main, name='bbterm-ports-agent', daemon=True)
            worker.start()
            worker.join()
        except Exception as error:  # a broken agent must never take the proxy forwarder down
            print(f'bbterm-forward: ports agent stopped: {error}', file=sys.stderr, flush=True)
        time.sleep(delay)


def model_relay(port=MODEL_PORT, path=None, delay=10):
    """127.0.0.1:port -> model.sock, only while the host provides model.sock; restarted if it fails."""
    path = path or MODEL_SOCKET
    while True:
        try:
            if stat.S_ISSOCK(os.lstat(path).st_mode):
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    listener.bind(('127.0.0.1', port))
                    listener.listen(16)
                    while True:
                        client, _ = listener.accept()
                        threading.Thread(target=serve, args=(client, path), daemon=True).start()
                finally:
                    listener.close()
        except FileNotFoundError:
            pass
        except Exception as error:  # never take the proxy forwarder down
            print(f'bbterm-forward: model relay stopped: {error}', file=sys.stderr, flush=True)
        time.sleep(delay)


def main():
    threading.Thread(target=model_relay, name='bbterm-model-relay', daemon=True).start()
    if PORTS_SOCKET:
        threading.Thread(target=supervise_agent, args=(AGENT, PORTS_SOCKET, LISTEN[1]),
                         name='bbterm-ports-supervisor', daemon=True).start()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(LISTEN)
    listener.listen(64)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client,), daemon=True).start()


if __name__ == '__main__':
    main()
