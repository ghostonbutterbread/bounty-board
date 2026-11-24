"""Minimal, strict RFC 6455 WebSocket server-side support (stdlib only).

Scope:
  * Server side only: validates a client's upgrade request, computes the
    Sec-WebSocket-Accept value, then speaks the framing protocol over an
    already-upgraded connection (e.g. a BaseHTTPRequestHandler's rfile and
    socket after it has written the 101 response).
  * No extensions (permessage-deflate etc.) and no subprotocols are ever
    negotiated, so every RSV bit must be zero.
  * Origin checking, authentication and the 101 response itself belong to the
    caller.

Strictness: protocol violations by the peer fail the connection with the
appropriate close code (1002 protocol error, 1007 invalid UTF-8, 1009 too
big) and make recv() return None; recv() never raises for peer errors.

Threading: one thread may call recv() while any number of other threads call
send_text()/send_binary()/ping()/close(); all writes share one lock.
"""

import base64
import binascii
import codecs
import hashlib
import socket
import struct
import threading
import time

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT, OP_TEXT, OP_BINARY = 0x0, 0x1, 0x2
OP_CLOSE, OP_PING, OP_PONG = 0x8, 0x9, 0xA
_DATA_OPS = {OP_CONT, OP_TEXT, OP_BINARY}
_CONTROL_OPS = {OP_CLOSE, OP_PING, OP_PONG}

CLOSE_NORMAL = 1000
CLOSE_PROTOCOL_ERROR = 1002
CLOSE_INVALID_DATA = 1007
CLOSE_TOO_BIG = 1009
_FAIL_CODES = {CLOSE_PROTOCOL_ERROR, CLOSE_INVALID_DATA, CLOSE_TOO_BIG}


class HandshakeError(Exception):
    """Upgrade request rejected; ``status`` is the HTTP status to send."""

    def __init__(self, status, message):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class WebSocketClosed(Exception):
    """Internal signal that the connection is (being) closed."""

    def __init__(self, code, reason=""):
        super().__init__(f"{code} {reason}".strip())
        self.code = code
        self.reason = reason


def accept_key(key):
    digest = hashlib.sha1((key + _GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _all(headers, name):
    return headers.get_all(name) or []


def check_handshake(method, headers):
    """Validate a client upgrade request; return the Sec-WebSocket-Accept value."""
    if method != "GET":
        raise HandshakeError(400, "WebSocket upgrade requires GET")
    upgrade = _all(headers, "Upgrade")
    if len(upgrade) != 1 or upgrade[0].strip().lower() != "websocket":
        raise HandshakeError(400, "missing or invalid Upgrade header")
    tokens = {
        t.strip().lower()
        for value in _all(headers, "Connection")
        for t in value.split(",")
    }
    if "upgrade" not in tokens:
        raise HandshakeError(400, "Connection header lacks 'upgrade'")
    version = _all(headers, "Sec-WebSocket-Version")
    if len(version) != 1 or version[0].strip() != "13":
        raise HandshakeError(426, "unsupported Sec-WebSocket-Version")
    keys = _all(headers, "Sec-WebSocket-Key")
    if len(keys) != 1:
        raise HandshakeError(400, "exactly one Sec-WebSocket-Key required")
    key = keys[0].strip()
    try:
        raw = base64.b64decode(key.encode("ascii"), validate=True)
    except (binascii.Error, UnicodeEncodeError, ValueError):
        raise HandshakeError(400, "Sec-WebSocket-Key is not valid base64") from None
    if len(raw) != 16:
        raise HandshakeError(400, "Sec-WebSocket-Key must decode to 16 bytes")
    return accept_key(key)


def handshake_headers(accept):
    return [
        ("Upgrade", "websocket"),
        ("Connection", "Upgrade"),
        ("Sec-WebSocket-Accept", accept),
    ]


def _valid_close_code(code):
    return (1000 <= code <= 1003 or 1007 <= code <= 1014
            or 3000 <= code <= 4999)


def encode_frame(opcode, payload, fin=True):
    """Build an unmasked (server-to-client) frame."""
    n = len(payload)
    b0 = (0x80 if fin else 0) | opcode
    if n < 126:
        header = struct.pack("!BB", b0, n)
    elif n < 1 << 16:
        header = struct.pack("!BBH", b0, 126, n)
    else:
        header = struct.pack("!BBQ", b0, 127, n)
    return header + bytes(payload)


def _unmask(payload, mask):
    if not payload:
        return b""
    n = len(payload)
    key = int.from_bytes((mask * (n // 4 + 1))[:n], "big")
    return (int.from_bytes(payload, "big") ^ key).to_bytes(n, "big")


class WebSocket:
    def __init__(self, rfile, sock, *, max_frame=1 << 20, max_message=1 << 20):
        self.rfile = rfile
        self.sock = sock
        self.max_frame = max_frame
        self.max_message = max_message
        self.last_received = time.monotonic()
        self.closed = False          # no more sends (close frame sent / failed)
        self._done = False           # recv() finished for good
        self._lock = threading.Lock()
        self._msg_op = None          # opcode of in-progress fragmented message
        self._msg_parts = []
        self._msg_len = 0
        self._decoder = None

    # ---------------------------------------------------------------- sending
    def _send(self, opcode, payload, *, closing=False):
        with self._lock:
            if self.closed:
                return False
            if closing:
                self.closed = True
            try:
                self.sock.sendall(encode_frame(opcode, payload))
            except OSError:
                self.closed = True
                return False
            return True

    def send_text(self, text):
        return self._send(OP_TEXT, text.encode("utf-8"))

    def send_binary(self, data):
        return self._send(OP_BINARY, bytes(data))

    def ping(self, payload=b""):
        payload = bytes(payload)
        if len(payload) > 125:
            raise ValueError("ping payload must be <= 125 bytes")
        return self._send(OP_PING, payload)

    def close(self, code=CLOSE_NORMAL, reason=""):
        """Send a close frame once (idempotent). The socket is shut down when
        the peer's close arrives in recv(), or immediately for errors."""
        reason_b = reason.encode("utf-8")[:123].decode("utf-8", "ignore").encode("utf-8")
        payload = struct.pack("!H", code) + reason_b
        sent = self._send(OP_CLOSE, payload, closing=True)
        if self._done or code in _FAIL_CODES:
            self._shutdown()
        return sent

    def _shutdown(self):
        self._done = True
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    # -------------------------------------------------------------- receiving
    def _read_exact(self, n):
        if n == 0:
            return b""
        try:
            data = self.rfile.read(n)
        except (OSError, ValueError):
            data = b""
        if data is None or len(data) != n:
            raise EOFError
        return data

    def _fail(self, code):
        self._send(OP_CLOSE, struct.pack("!H", code), closing=True)
        self._shutdown()
        return None

    def recv(self):
        """Return ('text', str) / ('binary', bytes), or None once closed."""
        while not self._done:
            try:
                result = self._recv_frame()
            except EOFError:
                self._shutdown()
                return None
            except WebSocketClosed as exc:
                return self._fail(exc.code)
            if result is not None:
                return result
        return None

    def _recv_frame(self):
        b0, b1 = self._read_exact(2)
        fin, rsv, opcode = b0 & 0x80, b0 & 0x70, b0 & 0x0F
        masked, length = b1 & 0x80, b1 & 0x7F
        if rsv or opcode not in _DATA_OPS | _CONTROL_OPS:
            raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "bad rsv/opcode")
        if opcode in _CONTROL_OPS and (not fin or length > 125):
            raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "bad control frame")
        if not masked:
            raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "unmasked client frame")
        if length == 126:
            (length,) = struct.unpack("!H", self._read_exact(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._read_exact(8))
            if length >> 63:
                raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "length MSB set")
        if opcode == OP_CONT and self._msg_op is None:
            raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "orphan continuation")
        if opcode in (OP_TEXT, OP_BINARY) and self._msg_op is not None:
            raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "interleaved message")
        if length > self.max_frame:
            raise WebSocketClosed(CLOSE_TOO_BIG, "frame too big")
        if opcode in _DATA_OPS and self._msg_len + length > self.max_message:
            raise WebSocketClosed(CLOSE_TOO_BIG, "message too big")
        mask = self._read_exact(4)
        payload = _unmask(self._read_exact(length), mask)
        self.last_received = time.monotonic()

        if opcode == OP_PING:
            self._send(OP_PONG, payload)
            return None
        if opcode == OP_PONG:
            return None
        if opcode == OP_CLOSE:
            self._on_close(payload)
            return None
        return self._on_data(opcode, fin, payload)

    def _on_close(self, payload):
        if len(payload) == 1:
            raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "1-byte close payload")
        reply = b""
        if payload:
            (code,) = struct.unpack("!H", payload[:2])
            if not _valid_close_code(code):
                raise WebSocketClosed(CLOSE_PROTOCOL_ERROR, "bad close code")
            try:
                payload[2:].decode("utf-8")
            except UnicodeDecodeError:
                raise WebSocketClosed(CLOSE_INVALID_DATA, "bad close reason") from None
            reply = payload[:2]
        self._send(OP_CLOSE, reply, closing=True)
        self._shutdown()

    def _on_data(self, opcode, fin, payload):
        if opcode != OP_CONT:
            self._msg_op = opcode
            self._decoder = (codecs.getincrementaldecoder("utf-8")()
                             if opcode == OP_TEXT else None)
        if self._decoder is not None:
            try:
                self._msg_parts.append(self._decoder.decode(payload, final=bool(fin)))
            except UnicodeDecodeError:
                raise WebSocketClosed(CLOSE_INVALID_DATA, "invalid UTF-8") from None
        else:
            self._msg_parts.append(payload)
        self._msg_len += len(payload)
        if not fin:
            return None
        op, parts = self._msg_op, self._msg_parts
        self._msg_op, self._msg_parts, self._msg_len, self._decoder = None, [], 0, None
        if self.closed:              # closing handshake in progress: discard
            return None
        if op == OP_TEXT:
            return ("text", "".join(parts))
        return ("binary", b"".join(parts))
