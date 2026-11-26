"""Real-container tests for the report agent and the model relay (local Docker).

Skipped unless BBTERM_DOCKER_TESTS=1. Containers are named ``bbterm-test-*``
and removed. The CLI is tests/fake_agent_cli.py (mounted read-only like the
real binary); the upstream is a fake TLS server on 127.0.0.1 with a throwaway
CA; the login is a fake token. Nothing reaches the internet.

  docker build -t bbterm-test-image-agent:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) \\
      -f sandbox/Dockerfile.test sandbox/
  BBTERM_TEST_IMAGE=bbterm-test-image-agent:latest BBTERM_DOCKER_TESTS=1 python3 -m unittest tests.test_terminal_agent_docker

Optional, the real Claude Code binary against the fake upstream (never real
credentials, never Anthropic): ``BBTERM_CLAUDE_BIN=~/.local/bin/claude``.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_proxy  # noqa: E402
import terminal_relay  # noqa: E402
import terminal_report_agent as ra  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
from tests import fake_model_upstream as fu  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.test_terminal_docker import ENABLED, PREFIX, docker, our_containers  # noqa: E402
from tests.test_terminal_sandbox import FakeViewer  # noqa: E402

IMAGE = os.environ.get('BBTERM_TEST_IMAGE', 'bbterm-test-image-agent:latest')
FAKE_TOKEN = 'sk-ant-oat01-FAKE-docker-test-token-zyxwvutsrqponmlkji'
FAKE_CLI = Path(__file__).resolve().parent / 'fake_agent_cli.py'
CLAUDE_BIN = os.environ.get('BBTERM_CLAUDE_BIN')

SCAN = r'''
import os, sys
out = []
for pid in os.listdir("/proc"):
    if pid.isdigit():
        for name in ("environ", "cmdline"):
            try:
                out.append(open(f"/proc/{pid}/{name}", "rb").read())
            except OSError:
                pass
for top in sys.argv[1:]:
    for folder, dirs, files in os.walk(top, followlinks=False):
        for name in files:
            path = os.path.join(folder, name)
            try:
                if os.path.islink(path) or not os.path.isfile(path) or os.path.getsize(path) > 50_000_000:
                    continue
                out.append(open(path, "rb").read())
            except OSError:
                pass
sys.stdout.buffer.write(b"\n".join(out))
'''


@unittest.skipUnless(ENABLED, 'set BBTERM_DOCKER_TESTS=1 to run real-container tests')
class ReportAgentDockerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if docker('image', 'inspect', IMAGE, check=False).returncode != 0:
            raise unittest.SkipTest(f'{IMAGE} is not built')
        cls.base = fx.tmp_base('agentdocker')
        cls.root = fx.make_root(cls.base)
        cls.lane = cls.root / fx.FAMILY / fx.PROGRAM / fx.LANE
        cls.cert, cls.key = fu.make_cert(cls.base / 'tls')
        cls.upstream = fu.FakeUpstream(cls.cert, cls.key)
        cls.token = cls.base / 'login-token'
        fd = os.open(cls.token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, FAKE_TOKEN.encode() + b'\n')
        os.close(fd)
        cls.skill = cls.base / 'skills' / 'poc-tooling-policy'
        cls.skill.mkdir(parents=True)
        (cls.skill / 'SKILL.md').write_text('---\nname: poc-tooling-policy\ndescription: synthetic skill\n---\nBody.\n')
        # Egress through the sandbox proxy is refused and recorded: no name resolves.
        cls.egress = []

        def refuse(host, *args, **kwargs):
            cls.egress.append(host)
            raise socket.gaierror('refused in tests')
        cls.proxy = terminal_proxy.FilteringProxy(connect_timeout=3, resolver=refuse)
        cls.hub = ra.ReportAgentHub(enabled=True, root=cls.root, state_dir=cls.base / 'agent-state',
                                    clis={'claude': str(FAKE_CLI)}, skills={'poc-tooling-policy': str(cls.skill)},
                                    token_file=cls.token, relay_upstream=('127.0.0.1', cls.upstream.port),
                                    relay_ssl_context=fu.client_context(cls.cert), stop_grace=3.0)
        cls.backend = sb.DockerBackend(image=IMAGE, state_dir=cls.base / 'state', proxy=cls.proxy, prefix=PREFIX,
                                       memory='256m', cpus='0.5', pids=128)
        cls.backend.agent_hub = cls.hub
        cls.now = [0.0]
        cls.manager = sb.SessionManager(cls.root, cls.backend, max_sessions=3, pause_after=30, remove_after=600,
                                        min_free_memory=0, clock=lambda: cls.now[0], reap_interval=0)
        cls.manager.agent_hub = cls.hub
        cls.sel = fx.selector()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.manager.close()
            cls.hub.close()
            cls.proxy.close()
            cls.upstream.close()
        finally:
            leftovers = our_containers()
            if leftovers:
                docker('rm', '-f', *leftovers, check=False)
            shutil.rmtree(cls.base, ignore_errors=True)

    def start(self, sel=None, task=None, **extra):
        task = task or {'kind': 'poc_format', 'format': 'python',
                        'block': {'text': "curl -s 'https://example.test/x?id=1'", 'lang': 'bash', 'index': 1}}
        return self.hub.start(self.manager, {'selector': sel or self.sel, 'task': task, **extra})

    def name(self, sel=None):
        return self.backend.name(self.manager.get(sel or self.sel))

    def exec(self, *cmd, sel=None):
        return docker('exec', self.name(sel), *cmd, check=False)

    def viewer(self, sel=None):
        viewer = FakeViewer()
        session = self.manager.get(sel or self.sel)
        session.agent.pty.attach(viewer, {'type': 'hello'})
        return session, viewer

    def test_01_agent_runs_in_the_sandbox_through_the_relay(self):
        info = self.start()
        self.assertIn(info['state'], ('working', 'waiting'))
        session, viewer = self.viewer()
        viewer.wait_for('READY', timeout=60)
        out = bytes(viewer.output).decode('utf-8', 'replace')
        self.assertIn('CWD /report', out)
        self.assertIn('ARGV ["Read /home/sandbox/.report-agent/task.md and follow it."]', out)
        self.assertIn('BASE_URL http://127.0.0.1:3129', out)
        self.assertIn('TOKEN_IS_DUMMY True', out)
        self.assertIn('The main report is `example-com-sqli-D1.md`', out)
        self.assertIn('MODEL-STATUS HTTP/1.1 200', out)
        self.assertIn('MODEL-REPLY FAKE-REPLY-OK', out)
        request = self.upstream.requests[-1]
        self.assertEqual(request['target'], '/v1/messages?beta=true')
        self.assertEqual(request['headers']['authorization'], [f'Bearer {FAKE_TOKEN}'])
        self.assertIn(terminal_relay.OAUTH_BETA, request['headers']['anthropic-beta'][0])
        for gone in ('x-api-key', 'cookie', 'proxy-authorization'):
            self.assertNotIn(gone, request['headers'])
        inspect = json.loads(docker('inspect', self.name()).stdout)[0]
        self.assertEqual(inspect['HostConfig']['Memory'], 2 * 1024 ** 3)
        self.assertEqual(inspect['HostConfig']['MemorySwap'], 2 * 1024 ** 3)
        self.assertEqual(inspect['HostConfig']['NetworkMode'], 'none')
        mounts = {(m['Destination'], m['Source'], m['RW']) for m in inspect['Mounts']}
        self.assertEqual(mounts, {
            ('/report', str(self.lane / 'reports/D1-sqli-login'), True),
            ('/run/bbterm', str(self.base / 'state/proxy' / session.id), False),
            ('/opt/report-agent/claude', str(FAKE_CLI), False),
            ('/opt/report-agent/skills/poc-tooling-policy', str(self.skill), False),
        })
        listing = self.exec('ls', '-ln', '/run/bbterm').stdout
        self.assertRegex(listing, r'srw------- .* model\.sock')
        self.assertIn('proxy.sock', listing)
        task = self.exec('cat', '/home/sandbox/.report-agent/task.md').stdout
        self.assertIn("curl -s 'https://example.test/x?id=1'", task)
        link = self.exec('readlink', '/home/sandbox/.claude/skills/poc-tooling-policy').stdout.strip()
        self.assertEqual(link, '/opt/report-agent/skills/poc-tooling-policy')
        self.assertIn('synthetic skill', self.exec('cat', '/home/sandbox/.claude/skills/poc-tooling-policy/SKILL.md').stdout)
        self.assertNotEqual(self.exec('touch', '/opt/report-agent/skills/poc-tooling-policy/x').returncode, 0)  # read-only
        self.assertIn('acceptEdits', self.exec('cat', '/home/sandbox/.claude/settings.json').stdout)
        # The relay port is never offered as a preview port, and the forwarder is still one process.
        top = docker('top', self.name(), '-eo', 'pid,args').stdout
        self.assertEqual(len([line for line in top.splitlines() if 'python3 /usr/local/bin/bbterm-forward' in line
                              and 'docker-init' not in line]), 1, top)
        session.agent.pty.detach(viewer)

    def test_02_the_login_never_enters_the_container(self):
        scan = subprocess.run(['docker', 'exec', self.name(), 'python3', '-c', SCAN, '/home/sandbox', '/tmp', '/report',
                               '/run/bbterm', '/opt/report-agent', '/etc'], capture_output=True, timeout=120)
        self.assertEqual(scan.returncode, 0, scan.stderr[-300:])
        blob = scan.stdout
        self.assertIn(b'sk-ant-oat01-report-agent-relay-placeholder', blob)  # the scan does see the agent's env
        self.assertNotIn(FAKE_TOKEN.encode(), blob)
        self.assertNotIn(FAKE_TOKEN[-20:].encode(), blob)
        self.assertNotIn(FAKE_TOKEN, docker('inspect', self.name()).stdout)
        self.assertNotIn(FAKE_TOKEN, self.exec('env').stdout)
        self.assertNotIn(FAKE_TOKEN, docker('top', self.name(), '-eo', 'pid,args').stdout)
        # The host relay saw it: it is the only place the token goes.
        self.assertEqual(self.upstream.requests[-1]['headers']['authorization'], [f'Bearer {FAKE_TOKEN}'])

    def test_03_no_pause_while_the_agent_prints_then_resume_keeps_the_process(self):
        session = self.manager.get(self.sel)
        pid = self.exec('cat', '/home/sandbox/.report-agent/agent.pid').stdout.strip()
        self.assertTrue(pid.isdigit())
        session.left_at = self.now[0] - self.manager.pause_after - 1
        session.agent.pty.write(b'spam\n')
        _, viewer = self.viewer()
        viewer.wait_for('spam-1', timeout=20)
        self.assertEqual(self.manager.reap_idle(), ([], []))  # printing right now
        viewer.wait_for('spam-14', timeout=20)
        session.agent.pty.detach(viewer)
        self.assertEqual(self.manager.reap_idle(), ([], []))  # printed less than 120 s ago
        self.assertEqual(docker('inspect', '--format', '{{.State.Paused}}', self.name()).stdout.strip(), 'false')
        session.agent.pty.last_output = self.hub.clock() - ra.PAUSE_HOLD - 1
        paused, _ = self.manager.reap_idle()
        self.assertEqual(paused, [session])
        self.assertEqual(docker('inspect', '--format', '{{.State.Paused}}', self.name()).stdout.strip(), 'true')
        viewer = FakeViewer()
        target = self.hub.attach(self.manager, self.sel, viewer)
        try:
            self.assertEqual(docker('inspect', '--format', '{{.State.Paused}}', self.name()).stdout.strip(), 'false')
            target.write(b'after pause\n')
            viewer.wait_for('ECHO after pause', timeout=20)
            self.assertEqual(self.exec('cat', '/home/sandbox/.report-agent/agent.pid').stdout.strip(), pid)
            self.assertEqual(self.exec('test', '-d', f'/proc/{pid}').returncode, 0)
        finally:
            target.detach()

    def test_04_stop_ends_the_process_inside_the_container(self):
        pid = self.exec('cat', '/home/sandbox/.report-agent/agent.pid').stdout.strip()
        self.assertEqual(self.exec('test', '-d', f'/proc/{pid}').returncode, 0)
        self.assertEqual(self.hub.stop(self.manager, {'selector': self.sel})['state'], 'none')
        deadline = time.time() + 15
        while time.time() < deadline and self.exec('test', '-d', f'/proc/{pid}').returncode == 0:
            time.sleep(0.2)
        self.assertNotEqual(self.exec('test', '-d', f'/proc/{pid}').returncode, 0)
        self.assertEqual(self.hub.info(self.manager, self.sel)['state'], 'none')

    def test_05_second_start_refused_and_reset_stops_the_agent(self):
        self.start(task={'kind': 'ask', 'text': 'What does the PoC need?'})
        with self.assertRaises(ra.AgentError) as caught:
            self.start()
        self.assertEqual((caught.exception.status, caught.exception.code), (409, 'agent_running'))
        session = self.manager.get(self.sel)
        proc = session.agent.pty.proc
        old_name = self.name()
        self.manager.reset(self.sel)
        proc.wait(timeout=30)
        self.assertEqual(self.hub.info(self.manager, self.sel)['state'], 'none')
        self.assertNotIn(old_name, our_containers())

    @unittest.skipUnless(CLAUDE_BIN, 'set BBTERM_CLAUDE_BIN to run the real Claude Code binary against the fake upstream')
    def test_06_real_claude_code_through_the_relay(self):
        sel = fx.selector(fx.SECOND)
        self.hub.clis['claude'] = os.path.expanduser(CLAUDE_BIN)
        try:
            before = len(self.upstream.requests)
            self.start(sel=sel, task={'kind': 'ask', 'text': 'Say hi.'}, model='opus')
            session, viewer = self.viewer(sel)
            viewer.wait_for('FAKE-REPLY-OK', timeout=120)
            screen = bytes(viewer.output).decode('utf-8', 'replace')
            for dialog in ('trust this folder', 'Unable to connect', 'Select login method', 'Make auto mode'):
                self.assertNotIn(dialog, screen)
            requests = self.upstream.requests[before:]
            self.assertTrue(requests)
            names = set()
            for request in requests:
                self.assertEqual((request['method'], request['target']), ('POST', '/v1/messages?beta=true'))
                self.assertEqual(request['headers']['authorization'], [f'Bearer {FAKE_TOKEN}'])
                self.assertIn(terminal_relay.OAUTH_BETA, request['headers']['anthropic-beta'][0])
                self.assertNotIn('x-api-key', request['headers'])
                self.assertEqual(json.loads(request['body'])['model'], 'claude-opus-5-5')
                names |= set(request['headers'])
            self.assertEqual(self.egress, [])  # nothing tried the sandbox proxy (nonessential traffic is off)
            print('CLAUDE RELAY EVIDENCE requests', len(requests), 'header names', sorted(names), file=sys.stderr)
            session.agent.pty.detach(viewer)
            self.hub.stop(self.manager, {'selector': sel})
        finally:
            self.hub.clis['claude'] = str(FAKE_CLI)


if __name__ == '__main__':
    unittest.main()
