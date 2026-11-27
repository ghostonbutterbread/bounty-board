"""Fake model API upstream for relay tests: TLS on 127.0.0.1 with a throwaway CA.

Never a real endpoint, never a real credential. Records each request (method,
target, lower-cased headers, body) and answers like the Messages API: an SSE
stream for ``"stream": true`` (in two parts, so tests can prove the relay
streams), JSON otherwise.
"""
import json
import shutil
import socket
import ssl
import subprocess
import threading
from pathlib import Path


def make_cert(folder):
    """Self-signed cert for 127.0.0.1 (and localhost), made with the openssl CLI. Returns (cert, key)."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    cert, key = folder / 'upstream-cert.pem', folder / 'upstream-key.pem'
    if not cert.exists():
        if shutil.which('openssl') is None:
            raise RuntimeError('openssl is needed to make the test certificate')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', str(key), '-out', str(cert)],
                       check=True, capture_output=True, timeout=60)
    return cert, key


def client_context(cert):
    """What the relay uses in tests: verification on, trusting only the test cert."""
    context = ssl.create_default_context(cafile=str(cert))
    return context


def sse_events(model='claude-test', text='FAKE-REPLY-OK'):
    events = [
        ('message_start', {'type': 'message_start', 'message': {'id': 'msg_fake', 'type': 'message', 'role': 'assistant',
                                                                'model': model, 'content': [], 'stop_reason': None,
                                                                'stop_sequence': None,
                                                                'usage': {'input_tokens': 10, 'output_tokens': 1}}}),
        ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
        ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
        ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
        ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                           'usage': {'output_tokens': 5}}),
        ('message_stop', {'type': 'message_stop'}),
    ]
    return [f'event: {name}\ndata: {json.dumps(data)}\n\n'.encode() for name, data in events]


def tool_events(model, tool_id, name, tool_input):
    """One assistant turn that asks to run a tool (what a scripted model returns)."""
    events = [
        ('message_start', {'type': 'message_start', 'message': {'id': f'msg_{tool_id}', 'type': 'message', 'role': 'assistant',
                                                                'model': model, 'content': [], 'stop_reason': None,
                                                                'stop_sequence': None,
                                                                'usage': {'input_tokens': 10, 'output_tokens': 1}}}),
        ('content_block_start', {'type': 'content_block_start', 'index': 0,
                                 'content_block': {'type': 'tool_use', 'id': f'toolu_{tool_id}', 'name': name, 'input': {}}}),
        ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(tool_input)}}),
        ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
        ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use', 'stop_sequence': None},
                           'usage': {'output_tokens': 5}}),
        ('message_stop', {'type': 'message_stop'}),
    ]
    return [f'event: {n}\ndata: {json.dumps(d)}\n\n'.encode() for n, d in events]


class FakeUpstream:
    def __init__(self, cert, key, *, hold=None):
        """``hold``: a threading.Event; streaming answers pause after the first event until it is set."""
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(str(cert), str(key))
        self.sock = socket.socket()
        self.sock.bind(('127.0.0.1', 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.requests = []
        self.hold = hold
        self.script = []  # [(tool name, input)]: streaming turns that offer tools return these in order
        self.lock = threading.Lock()
        self.closed = False
        threading.Thread(target=self._loop, daemon=True).start()

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass

    def _loop(self):
        while not self.closed:
            try:
                raw, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(raw,), daemon=True).start()

    def _serve(self, raw):
        try:
            raw.settimeout(20)
            conn = self.context.wrap_socket(raw, server_side=True)
        except (OSError, ssl.SSLError):
            raw.close()
            return
        try:
            buf = b''
            while b'\r\n\r\n' not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            head, body = buf.split(b'\r\n\r\n', 1)
            lines = head.decode('latin-1').split('\r\n')
            method, target, _ = lines[0].split(' ', 2)
            headers = {}
            for line in lines[1:]:
                name, _, value = line.partition(':')
                headers.setdefault(name.strip().lower(), []).append(value.strip())
            length = int(headers.get('content-length', ['0'])[0])
            while len(body) < length:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                body += chunk
            record = {'method': method, 'target': target, 'headers': headers, 'body': body}
            with self.lock:
                self.requests.append(record)
            try:
                payload = json.loads(body or b'{}')
            except ValueError:
                payload = {}
            if payload.get('stream'):
                with self.lock:
                    step = self.script.pop(0) if self.script and payload.get('tools') else None
                if step is not None:
                    events = tool_events(payload.get('model', 'claude-test'), len(self.requests), *step)
                else:
                    events = sse_events(payload.get('model', 'claude-test'))
                conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n'
                             b'Set-Cookie: upstream=1\r\nTransfer-Encoding: chunked\r\n\r\n')
                for index, event in enumerate(events):
                    conn.sendall(b'%x\r\n%s\r\n' % (len(event), event))
                    if index == 0 and self.hold is not None:
                        self.hold.wait(20)
                conn.sendall(b'0\r\n\r\n')
            else:
                data = json.dumps({'id': 'msg_fake2', 'type': 'message', 'role': 'assistant', 'content': [
                    {'type': 'text', 'text': 'FAKE-JSON-OK'}], 'stop_reason': 'end_turn',
                    'usage': {'input_tokens': 1, 'output_tokens': 1}}).encode()
                conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s'
                             % (len(data), data))
        except (OSError, ssl.SSLError, ValueError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass
