"""Review r1 R3 (from repros/r1/test_r3_removal_working_agent.py): idle removal must skip a
sandbox whose agent printed output in the last 120 s, like pause and eviction do."""
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests import terminal_fixture as fx  # noqa: E402
from tests import test_terminal_report_agent as base  # noqa: E402


class RemovalTests(base.AgentServiceTests):
    def test_removal_skips_a_working_agent(self):
        self.assertEqual(self.start()[0], 200)
        manager = self.server.manager
        session = manager.get(fx.selector())
        deadline = time.monotonic() + 10
        while session.viewer_count() and time.monotonic() < deadline:
            time.sleep(0.05)
        session.agent.pty.last_output = time.monotonic()  # printing right now
        session.left_at = self.clock[0] - manager.remove_after - 1
        _, removed = manager.reap_idle()
        self.assertEqual(removed, [], 'a working agent was removed as idle')
        session.agent.pty.last_output = time.monotonic() - 1000  # quiet: the normal removal applies
        _, removed = manager.reap_idle()
        self.assertEqual(removed, [session])


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromNames(['tests.test_review_r3_removal_working_agent.RemovalTests.test_removal_skips_a_working_agent'])


if __name__ == '__main__':
    unittest.main()
