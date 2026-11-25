"""Tiny blocking WebSocket client for tests (masks frames, as RFC 6455 requires)."""
import base64
import json
import os
import socket
import struct


class Client:
    def __init__(self, port, path, headers):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f'GET {path} HTTP/1.1', 'Upgrade: websocket', 'Connection: Upgrade',
                 f'Sec-WebSocket-Key: {key}', 'Sec-WebSocket-Version: 13']
        lines += [f'{k}: {v}' for k, v in headers.items()]
        self.sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
        self.buffer = b''
        while b'\r\n\r\n' not in self.buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            self.buffer += chunk
        head, _, self.buffer = self.buffer.partition(b'\r\n\r\n')
        self.status = int(head.split(b' ', 2)[1]) if head else 0
        self.output = bytearray()
        self.controls = []

    def send_json(self, message):
        payload = json.dumps(message).encode()
        mask = os.urandom(4)
        header = bytes([0x81])
        n = len(payload)
        header += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack('!H', n)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError
            self.buffer += chunk
        data, self.buffer = self.buffer[:n], self.buffer[n:]
        return data

    def frame(self):
        b1, b2 = self._read(2)
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack('!H', self._read(2))[0]
        elif n == 127:
            n = struct.unpack('!Q', self._read(8))[0]
        return b1 & 0x0F, self._read(n)

    def pump_until(self, predicate, limit=200):
        for _ in range(limit):
            opcode, payload = self.frame()
            if opcode == 2:
                self.output += payload
            elif opcode == 1:
                self.controls.append(json.loads(payload))
            elif opcode == 8:
                raise EOFError('closed')
            if predicate(self):
                return True
        raise AssertionError('condition not reached')

    def wait_output(self, needle):
        return self.pump_until(lambda c: needle.encode() in c.output)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
