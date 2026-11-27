"""Review r1 R2 (from repros/r1/test_r2_relay_lifetime.py): the relay's lifetime must bound every
read, so a stalled upstream cannot hold a slot past max_lifetime."""
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests import fake_model_upstream as fu  # noqa: E402
from tests import test_terminal_relay as base  # noqa: E402


class LifetimeTests(base.RelayTests):
    def setUp(self):
        super().setUp()
        self.relay.close()
        self.upstream.close()
        self.stall = threading.Event()  # never set during the test: the upstream stalls after the first SSE event
        self.upstream = fu.FakeUpstream(self.cert, self.key, hold=self.stall)
        self.relay = self.make_relay(max_lifetime=1, upstream_idle=8)
        self.rs = self.relay.open_session(self.sock_path, self.gate)

    def tearDown(self):
        self.stall.set()
        super().tearDown()

    def test_lifetime_ends_a_stalled_stream(self):
        start = time.monotonic()
        base.read_all(base.request(self.sock_path))
        took = time.monotonic() - start
        self.assertLess(took, 3.0, f'request outlived max_lifetime=1 s by {took - 1:.1f} s')
        deadline = time.monotonic() + 5
        while self.relay.total and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.relay.total, 0)


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromNames(['tests.test_review_r2_relay_lifetime.LifetimeTests.test_lifetime_ends_a_stalled_stream'])


if __name__ == '__main__':
    unittest.main()
