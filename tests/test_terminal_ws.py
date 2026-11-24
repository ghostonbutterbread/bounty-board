import email.message
import os
import socket
import struct
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import terminal_ws as tw  # noqa: E402

MASK = b"\x37\xfa\x21\x3d"


def client_frame(opcode, payload, fin=True, mask=True, rsv=0, length=None):
    """Build a raw client->server frame. ``length`` overrides the encoded length."""
    payload = payload.encode() if isinstance(payload, str) else bytes(payload)
    n = len(payload) if length is None else length
    b0 = (0x80 if fin else 0) | (rsv << 4) | opcode
    mbit = 0x80 if mask else 0
    if n < 126:
        head = struct.pack("!BB", b0, mbit | n)
    elif n < 1 << 16:
        head = struct.pack("!BBH", b0, mbit | 126, n)
    else:
        head = struct.pack("!BBQ", b0, mbit | 127, n)
    if mask:
        body = bytes(b ^ MASK[i % 4] for i, b in enumerate(payload))
        return head + MASK + body
    return head + payload


def read_exact(f, n):
    data = f.read(n)
    if data is None or len(data) != n:
        raise EOFError
    return data


def read_server_frame(f):
    """Parse one server frame -> (fin, opcode, payload, masked, len_marker)."""
    b0, b1 = read_exact(f, 2)
    marker = b1 & 0x7F
    n = marker
    if n == 126:
        (n,) = struct.unpack("!H", read_exact(f, 2))
    elif n == 127:
        (n,) = struct.unpack("!Q", read_exact(f, 8))
    masked = bool(b1 & 0x80)
    key = read_exact(f, 4) if masked else None
    payload = read_exact(f, n)
    return bool(b0 & 0x80), b0 & 0x0F, payload, masked, marker


def headers(**kw):
    defaults = {
        "Upgrade": "websocket",
        "Connection": "keep-alive, Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    }
    defaults.update({k.replace("_", "-"): v for k, v in kw.items()})
    msg = email.message.Message()
    for k, v in defaults.items():
        if v is None:
            continue
        for item in v if isinstance(v, list) else [v]:
            msg[k] = item
    return msg


class HandshakeTests(unittest.TestCase):
    def test_accept_key_rfc_sample(self):
        self.assertEqual(tw.accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
                         "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    def test_valid(self):
        self.assertEqual(tw.check_handshake("GET", headers()),
                         "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        self.assertEqual(tw.check_handshake("GET", headers(Upgrade="WebSocket")),
                         "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    def test_handshake_headers(self):
        self.assertEqual(tw.handshake_headers("abc"), [
            ("Upgrade", "websocket"), ("Connection", "Upgrade"),
            ("Sec-WebSocket-Accept", "abc")])

    def assertRejected(self, status, method="GET", **kw):
        with self.assertRaises(tw.HandshakeError) as cm:
            tw.check_handshake(method, headers(**kw))
        self.assertEqual(cm.exception.status, status)
        self.assertTrue(cm.exception.message)

    def test_rejections(self):
        self.assertRejected(400, Upgrade=None)
        self.assertRejected(400, Upgrade="h2c")
        self.assertRejected(400, Upgrade=["websocket", "websocket"])
        self.assertRejected(400, Connection="keep-alive")
        self.assertRejected(400, Connection=None)
        self.assertRejected(400, Connection="upgrades")
        self.assertRejected(426, Sec_WebSocket_Version="8")
        self.assertRejected(426, Sec_WebSocket_Version=None)
        self.assertRejected(400, Sec_WebSocket_Key="AAAAAAAAAAAAAAAAAAAA")  # 15 bytes
        self.assertRejected(400, Sec_WebSocket_Key="not base64!!????????==")
        self.assertRejected(400, Sec_WebSocket_Key=None)
        self.assertRejected(400, Sec_WebSocket_Key=["dGhlIHNhbXBsZSBub25jZQ==",
                                                     "dGhlIHNhbXBsZSBub25jZQ=="])
        self.assertRejected(400, method="POST")


class FrameTests(unittest.TestCase):
    max_frame = 1 << 20
    max_message = 1 << 20

    def setUp(self):
        self.srv, self.cli = socket.socketpair()
        self.cli.settimeout(5)
        self.srv.settimeout(5)
        self.srv_r = self.srv.makefile("rb")
        self.cli_r = self.cli.makefile("rb")
        self.ws = tw.WebSocket(self.srv_r, self.srv, max_frame=self.max_frame,
                               max_message=self.max_message)

    def tearDown(self):
        for f in (self.srv_r, self.cli_r, self.srv, self.cli):
            f.close()

    def send(self, *frames):
        self.cli.sendall(b"".join(frames))

    def expect_close(self, code):
        self.assertIsNone(self.ws.recv())
        fin, op, payload, masked, _ = read_server_frame(self.cli_r)
        self.assertEqual(op, tw.OP_CLOSE)
        self.assertFalse(masked)
        self.assertEqual(struct.unpack("!H", payload[:2])[0], code)
        self.assertTrue(self.ws.closed)
        self.assertIsNone(self.ws.recv())
        self.assertFalse(self.ws.send_text("x"))
        self.assertEqual(self.cli_r.read(1), b"")  # socket shut down

    # --- happy paths
    def test_text_binary_roundtrip(self):
        self.send(client_frame(1, "héllo"), client_frame(2, b"\x00\xff"))
        self.assertEqual(self.ws.recv(), ("text", "héllo"))
        self.assertEqual(self.ws.recv(), ("binary", b"\x00\xff"))
        self.assertTrue(self.ws.send_text("ok"))
        self.assertTrue(self.ws.send_binary(b"\x01"))
        self.assertEqual(read_server_frame(self.cli_r)[:3], (True, 1, b"ok"))
        self.assertEqual(read_server_frame(self.cli_r)[:3], (True, 2, b"\x01"))

    def test_empty_messages(self):
        self.send(client_frame(1, ""), client_frame(2, b""))
        self.assertEqual(self.ws.recv(), ("text", ""))
        self.assertEqual(self.ws.recv(), ("binary", b""))

    def test_fragmentation_with_interleaved_ping(self):
        before = self.ws.last_received
        self.send(client_frame(2, b"ab", fin=False),
                  client_frame(9, b"pp"),
                  client_frame(0, b"cd", fin=False),
                  client_frame(0xA, b"pong"),
                  client_frame(0, b"ef"))
        self.assertEqual(self.ws.recv(), ("binary", b"abcdef"))
        self.assertEqual(read_server_frame(self.cli_r)[:4], (True, 0xA, b"pp", False))
        self.assertGreaterEqual(self.ws.last_received, before)

    def test_split_multibyte_text_ok(self):
        data = "€".encode()
        self.send(client_frame(1, data[:1], fin=False), client_frame(0, data[1:]))
        self.assertEqual(self.ws.recv(), ("text", "€"))

    def test_ping_and_server_ping(self):
        self.assertTrue(self.ws.ping(b"hb"))
        self.assertEqual(read_server_frame(self.cli_r)[:3], (True, 9, b"hb"))
        with self.assertRaises(ValueError):
            self.ws.ping(b"x" * 126)

    # --- protocol errors
    def test_unmasked_client_frame(self):
        self.send(client_frame(1, "hi", mask=False))
        self.expect_close(1002)

    def test_rsv_bit(self):
        for rsv in (1, 2, 4):
            with self.subTest(rsv=rsv):
                self.tearDown(); self.setUp()
                self.send(client_frame(1, "hi", rsv=rsv))
                self.expect_close(1002)

    def test_bad_opcodes(self):
        for op in (3, 7, 0xB, 0xF):
            with self.subTest(op=op):
                self.tearDown(); self.setUp()
                self.send(client_frame(op, b""))
                self.expect_close(1002)

    def test_continuation_without_start(self):
        self.send(client_frame(0, b"x"))
        self.expect_close(1002)

    def test_new_data_frame_mid_fragment(self):
        self.send(client_frame(1, "a", fin=False), client_frame(1, "b"))
        self.expect_close(1002)

    def test_fragmented_control(self):
        self.send(client_frame(9, b"x", fin=False))
        self.expect_close(1002)

    def test_control_payload_126(self):
        self.send(client_frame(9, b"x" * 126))
        self.expect_close(1002)

    def test_64bit_length_msb(self):
        self.send(client_frame(2, b"", length=1 << 63)[:10])
        self.expect_close(1002)

    def test_invalid_utf8(self):
        self.send(client_frame(1, b"\xff\xfe"))
        self.expect_close(1007)

    def test_invalid_utf8_truncated_at_end(self):
        self.send(client_frame(1, "€".encode()[:2]))
        self.expect_close(1007)

    def test_eof_mid_frame(self):
        self.send(client_frame(2, b"abcdef")[:5])
        self.cli.shutdown(socket.SHUT_WR)
        self.assertIsNone(self.ws.recv())
        self.assertTrue(self.ws.closed)
        self.assertIsNone(self.ws.recv())

    def test_eof_between_frames(self):
        self.cli.shutdown(socket.SHUT_WR)
        self.assertIsNone(self.ws.recv())

    # --- close handling
    def test_close_echo_1000(self):
        self.send(client_frame(8, struct.pack("!H", 1000) + b"bye"))
        self.assertIsNone(self.ws.recv())
        fin, op, payload, masked, _ = read_server_frame(self.cli_r)
        self.assertEqual((op, payload, masked), (8, struct.pack("!H", 1000), False))
        self.assertTrue(self.ws.closed)
        self.assertFalse(self.ws.send_binary(b"x"))
        self.assertEqual(self.cli_r.read(1), b"")

    def test_close_empty_payload(self):
        self.send(client_frame(8, b""))
        self.assertIsNone(self.ws.recv())
        self.assertEqual(read_server_frame(self.cli_r)[1:3], (8, b""))

    def test_close_one_byte(self):
        self.send(client_frame(8, b"\x03"))
        self.expect_close(1002)

    def test_close_bad_codes(self):
        for code in (1005, 999, 2000, 1004, 1006, 1015, 5000):
            with self.subTest(code=code):
                self.tearDown(); self.setUp()
                self.send(client_frame(8, struct.pack("!H", code)))
                self.expect_close(1002)

    def test_close_good_codes(self):
        for code in (1001, 1011, 3000, 4999):
            with self.subTest(code=code):
                self.tearDown(); self.setUp()
                self.send(client_frame(8, struct.pack("!H", code)))
                self.assertIsNone(self.ws.recv())
                self.assertEqual(read_server_frame(self.cli_r)[2],
                                 struct.pack("!H", code))

    def test_close_invalid_utf8_reason(self):
        self.send(client_frame(8, struct.pack("!H", 1000) + b"\xc3"))
        self.expect_close(1007)

    def test_server_initiated_close(self):
        self.assertTrue(self.ws.close(1001, "bye"))
        self.assertFalse(self.ws.close())          # idempotent
        self.assertFalse(self.ws.send_text("x"))
        fin, op, payload, _, _ = read_server_frame(self.cli_r)
        self.assertEqual((op, payload), (8, struct.pack("!H", 1001) + b"bye"))
        # data still in flight is discarded; peer close completes handshake
        self.send(client_frame(1, "late"), client_frame(8, struct.pack("!H", 1001)))
        self.assertIsNone(self.ws.recv())
        self.assertEqual(self.cli_r.read(1), b"")

    def test_close_reason_truncated_to_valid_utf8(self):
        self.ws.close(1000, "€" * 100)
        payload = read_server_frame(self.cli_r)[2]
        self.assertLessEqual(len(payload), 125)
        payload[2:].decode("utf-8")

    # --- server framing
    def test_server_length_encodings(self):
        for n, marker in ((125, 125), (126, 126), (65535, 126), (65536, 127)):
            with self.subTest(n=n):
                self.assertTrue(self.ws.send_binary(b"z" * n))
                fin, op, payload, masked, m = read_server_frame(self.cli_r)
                self.assertEqual((fin, op, len(payload), masked, m),
                                 (True, 2, n, False, marker))

    def test_concurrent_send_binary(self):
        threads, per = 6, 40

        def worker(i):
            for j in range(per):
                self.ws.send_binary(bytes([i]) * (100 + 300 * (j % 3)))

        ts = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
        counts = {}

        def reader():
            for _ in range(threads * per):
                fin, op, payload, masked, _ = read_server_frame(self.cli_r)
                assert fin and op == 2 and not masked
                assert len(set(payload)) == 1
                counts[payload[0]] = counts.get(payload[0], 0) + 1

        r = threading.Thread(target=reader)
        r.start()
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        r.join(5)
        self.assertFalse(r.is_alive())
        self.assertEqual(counts, {i: per for i in range(threads)})

    def test_send_after_peer_gone(self):
        self.cli_r.close()  # makefile holds an fd reference; close both
        self.cli.close()
        results = [self.ws.send_binary(b"x" * 65536) for _ in range(5)]
        self.assertFalse(results[-1])
        self.assertTrue(self.ws.closed)


class LimitTests(FrameTests.__base__):
    def setUp(self):
        self.srv, self.cli = socket.socketpair()
        self.srv.settimeout(5)
        self.cli.settimeout(5)
        self.srv_r = self.srv.makefile("rb")
        self.cli_r = self.cli.makefile("rb")
        self.ws = tw.WebSocket(self.srv_r, self.srv, max_frame=100, max_message=150)

    tearDown = FrameTests.tearDown
    expect_close = FrameTests.expect_close

    def test_oversized_frame_without_reading_payload(self):
        # Only the header is sent; the server must not wait for the payload.
        self.cli.sendall(client_frame(2, b"", length=101)[:4])
        self.expect_close(1009)

    def test_oversized_fragmented_message(self):
        self.cli.sendall(client_frame(2, b"a" * 100, fin=False)
                         + client_frame(0, b"b" * 51))
        self.expect_close(1009)

    def test_at_limits_ok(self):
        self.cli.sendall(client_frame(2, b"a" * 100, fin=False)
                         + client_frame(0, b"b" * 50))
        self.assertEqual(self.ws.recv(), ("binary", b"a" * 100 + b"b" * 50))


if __name__ == "__main__":
    unittest.main()
