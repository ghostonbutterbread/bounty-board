#!/usr/bin/env python3
"""In-container preview-ports agent: dials out to /run/bbterm/ports.sock.

Normally loaded by bbterm-forward as a thread in the same process (it sets
SOCKET and EXCLUDE); it still runs on its own for tests: bbterm-ports SOCKET [EXCLUDE].

The container has no network. The terminal service listens on a host-owned
Unix socket in the read-only /run/bbterm directory; this agent connects to it
(the host never connects into the container). It reports the TCP ports that
something inside the sandbox listens on (loopback or all addresses, read from
/proc/net/tcp and /proc/net/tcp6; never the proxy port 3128), and when the
host asks ``open <id> <port>`` it connects to 127.0.0.1:<port> (then ::1)
inside the container, dials a new connection to the socket identified by
<id>, and copies bytes both ways.

Protocol: newline-delimited JSON, see terminal_ports.py. The socket only
exists when the service runs with --preview-ports; until then this agent
retries quietly.
"""
import ipaddress
import json
import socket
import sys
import threading
import time

SOCKET = '/run/bbterm/ports.sock'  # set by bbterm-forward when loaded as a thread
EXCLUDE = {3128}
MAX_PORTS = 64
POLL = 1.0


def listening_ports(paths=('/proc/net/tcp', '/proc/net/tcp6')):
    found = set()
    for path in paths:
        try:
            with open(path) as stream:
                next(stream, None)
                for line in stream:
                    fields = line.split()
                    if len(fields) < 4 or fields[3] != '0A':  # 0A = LISTEN
                        continue
                    addr_hex, port_hex = fields[1].split(':')
                    raw = bytes.fromhex(addr_hex)
                    if len(raw) == 4:
                        ip = ipaddress.IPv4Address(raw[::-1])
                    else:  # four little-endian 32-bit words
                        ip = ipaddress.IPv6Address(b''.join(raw[i:i + 4][::-1] for i in range(0, 16, 4)))
                        if ip.ipv4_mapped:
                            ip = ip.ipv4_mapped
                    port = int(port_hex, 16)
                    if (ip.is_loopback or ip.is_unspecified) and port not in EXCLUDE:
                        found.add(port)
        except (OSError, ValueError):
            continue
    return sorted(found)[:MAX_PORTS]


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


def dial_host():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(SOCKET)
    except OSError:
        sock.close()
        raise
    return sock


def send_line(sock, lock, message):
    with lock:
        sock.sendall(json.dumps(message).encode() + b'\n')


def forward(control, lock, open_id, port):
    local = None
    for host in ('127.0.0.1', '::1'):
        try:
            local = socket.create_connection((host, port), timeout=3)
            break
        except OSError:
            continue
    if local is None:
        try:
            send_line(control, lock, {'t': 'fail', 'id': open_id})
        except OSError:
            pass
        return
    try:
        upstream = dial_host()
    except OSError:
        local.close()
        return
    try:
        local.settimeout(None)
        upstream.sendall(json.dumps({'t': 'data', 'id': open_id}).encode() + b'\n')
        t = threading.Thread(target=pump, args=(upstream, local), daemon=True)
        t.start()
        pump(local, upstream)
        t.join()
    except OSError:
        pass
    finally:
        local.close()
        upstream.close()


def reader(control, lock, stop):
    buf = b''
    try:
        while True:
            chunk = control.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(msg, dict) and msg.get('t') == 'open' and isinstance(msg.get('id'), str)
                        and type(msg.get('port')) is int and 1 <= msg['port'] <= 65535):
                    threading.Thread(target=forward, args=(control, lock, msg['id'], msg['port']), daemon=True).start()
            if len(buf) > 4096:
                break
    except OSError:
        pass
    finally:
        stop.set()


def session():
    control = dial_host()
    lock = threading.Lock()
    stop = threading.Event()
    try:
        send_line(control, lock, {'t': 'hello', 'v': 1})
        threading.Thread(target=reader, args=(control, lock, stop), daemon=True).start()
        last = None
        while not stop.is_set():
            ports = listening_ports()
            if ports != last:
                send_line(control, lock, {'t': 'ports', 'ports': ports})
                last = ports
            stop.wait(POLL)
    finally:
        control.close()


def main():
    delay = 0.5
    while True:
        started = time.monotonic()
        try:
            session()
        except OSError:
            pass
        if time.monotonic() - started > 30:
            delay = 0.5  # it worked for a while: reconnect quickly
        time.sleep(delay)
        delay = min(delay * 2, 10)


if __name__ == '__main__':
    SOCKET = sys.argv[1] if len(sys.argv) > 1 else SOCKET
    EXCLUDE = {int(sys.argv[2]) if len(sys.argv) > 2 else 3128}
    main()
