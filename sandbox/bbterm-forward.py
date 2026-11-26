#!/usr/bin/env python3
"""In-container loopback forwarder: 127.0.0.1:3128 -> /run/bbterm/proxy.sock.

The container has no network (``--network none``); its only way out is the
terminal service's filtering proxy, reached over this Unix socket. HTTP_PROXY,
HTTPS_PROXY and ALL_PROXY point at 127.0.0.1:3128.

With a third argument (the preview-ports socket, /run/bbterm/ports.sock) the
same process also runs the preview-ports agent (bbterm-ports, next to this
file) in a thread, restarted by a supervisor loop if it ever dies. One process
instead of two saves about 9 MiB per sandbox.

Usage: bbterm-forward [PORT [PROXY_SOCKET [PORTS_SOCKET]]]
"""
import importlib.machinery
import importlib.util
import os
import socket
import sys
import threading
import time

LISTEN = ('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 3128)
SOCKET = sys.argv[2] if len(sys.argv) > 2 else '/run/bbterm/proxy.sock'
PORTS_SOCKET = sys.argv[3] if len(sys.argv) > 3 else None
HERE = os.path.dirname(os.path.abspath(__file__))
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


def serve(client):
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect(SOCKET)
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


def supervise_agent(path, sock, exclude, *, sleep=time.sleep, clock=time.monotonic, log=None, rounds=None):
    """Run the preview-ports agent in a thread; start it again if it ever ends.

    The restart delay grows from 1 s, doubling up to 30 s, and drops back to 1 s
    after the agent stayed up for 60 s. Failures are logged once, then at most
    one line a minute with a count, so a sandbox that keeps the agent crashing
    (for example at the pids limit) cannot flood the container log.
    """
    log = log or (lambda line: print(line, file=sys.stderr, flush=True))
    delay, last_log, failures = 1, None, 0
    while rounds is None or rounds > 0:
        if rounds is not None:
            rounds -= 1
        started = clock()
        failed = []

        def run(main):
            try:
                main()
            except BaseException as error:  # reported by the supervisor, not the thread excepthook
                failed.append(error)
        try:
            agent = load_agent(path, sock, exclude)
            worker = threading.Thread(target=run, args=(agent.main,), name='bbterm-ports-agent', daemon=True)
            worker.start()
            worker.join()
            reason = (str(failed[0]) or type(failed[0]).__name__) if failed else 'ended'
        except Exception as error:  # a broken agent must never take the proxy forwarder down
            reason = str(error) or type(error).__name__
        now = clock()
        if now - started >= 60:
            delay = 1
        failures += 1
        if last_log is None or now - last_log >= 60:
            more = f' ({failures} times since the last report)' if failures > 1 else ''
            log(f'bbterm-forward: ports agent stopped: {reason}{more}; restarting in {delay} s')
            last_log, failures = now, 0
        sleep(delay)
        delay = min(delay * 2, 30)


def main():
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
