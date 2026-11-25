#!/usr/bin/env python3
"""In-container loopback forwarder: 127.0.0.1:3128 -> /run/bbterm/proxy.sock.

The container has no network (``--network none``); its only way out is the
terminal service's filtering proxy, reached over this Unix socket. HTTP_PROXY,
HTTPS_PROXY and ALL_PROXY point at 127.0.0.1:3128.
"""
import socket
import sys
import threading

LISTEN = ('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 3128)
SOCKET = sys.argv[2] if len(sys.argv) > 2 else '/run/bbterm/proxy.sock'


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


def main():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(LISTEN)
    listener.listen(64)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client,), daemon=True).start()


if __name__ == '__main__':
    main()
