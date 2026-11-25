"""Real-container tests for the sandbox terminal (local Docker).

Skipped unless BBTERM_DOCKER_TESTS=1. Uses only containers and images named
``bbterm-test-*`` and removes its containers when done. Build the image first
(no network needed):

  docker build -t bbterm-test-image:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) \
      -f sandbox/Dockerfile.test sandbox/

There is no internet in tests, so "allowed egress" is a local HTTP server on
127.0.0.2 presented through the proxy's TEST-ONLY override
(allow_networks=127.0.0.2/32, allowed.example.test -> 127.0.0.2). Host
loopback 127.0.0.1 stays refused under that override.
"""
import http.server
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_proxy  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.test_terminal_sandbox import FakeViewer  # noqa: E402

IMAGE = 'bbterm-test-image:latest'
PREFIX = 'bbterm-test-'
ENABLED = os.environ.get('BBTERM_DOCKER_TESTS') == '1'


def docker(*args, check=True):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=120)
    if check and result.returncode != 0:
        raise AssertionError(result.stderr)
    return result


def our_containers():
    out = docker('ps', '-a', '--filter', f'name=^{PREFIX}', '--format', '{{.Names}}').stdout.split()
    return [n for n in out if n.startswith(PREFIX)]


class Recorder(http.server.BaseHTTPRequestHandler):
    hits = []

    def do_GET(self):
        Recorder.hits.append((self.server.server_address, self.path, dict(self.headers)))
        body = b'allowed-egress-ok'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


PROBE = r'''
import json, os, socket, sys, urllib.request
results = {}
proxy = urllib.request.ProxyHandler({"http": os.environ["HTTP_PROXY"]})
opener = urllib.request.build_opener(proxy)
for name, url in json.loads(sys.argv[1]).items():
    try:
        with opener.open(url, timeout=10) as r:
            results[name] = [r.status, r.read().decode()]
    except urllib.error.HTTPError as e:
        results[name] = [e.code, e.read().decode()[:80]]
    except Exception as e:
        results[name] = ["error", type(e).__name__]
def connect(host, port):
    s = socket.create_connection(("127.0.0.1", 3128), timeout=10)
    s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
    return s.recv(200).split(b"\r\n")[0].decode()
def socks(host, port):
    s = socket.create_connection(("127.0.0.1", 3128), timeout=10)
    s.sendall(b"\x05\x01\x00"); s.recv(2)
    h = host.encode()
    s.sendall(b"\x05\x01\x00\x03" + bytes([len(h)]) + h + port.to_bytes(2, "big"))
    return s.recv(10)[1]
for name, (host, port) in json.loads(sys.argv[2]).items():
    results["connect " + name] = connect(host, port)
    results["socks " + name] = socks(host, port)
for name, (host, port) in [("direct internet", ("1.1.1.1", 80)), ("direct gateway", (sys.argv[3], 80))]:
    try:
        socket.create_connection((host, port), timeout=3); results[name] = "connected"
    except OSError as e:
        results[name] = "refused:" + type(e).__name__
try:
    socket.getaddrinfo("example.com", 80); results["dns"] = "resolved"
except OSError as e:
    results["dns"] = "failed"
print(json.dumps(results))
'''


@unittest.skipUnless(ENABLED, 'set BBTERM_DOCKER_TESTS=1 to run real-container tests')
class DockerSandboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if docker('image', 'inspect', IMAGE, check=False).returncode != 0:
            raise unittest.SkipTest(f'{IMAGE} is not built')
        cls.base = fx.tmp_base('docker')
        cls.root = fx.make_root(cls.base)
        cls.lane = cls.root / fx.FAMILY / fx.PROGRAM / fx.LANE
        cls.allowed = http.server.ThreadingHTTPServer(('127.0.0.2', 0), Recorder)
        cls.loopback = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Recorder)
        for server in (cls.allowed, cls.loopback):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.gateway = docker('network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}').stdout.strip()
        cls.proxy = terminal_proxy.FilteringProxy(allow_networks=[ipaddress.ip_network('127.0.0.2/32')],
                                                  static_hosts={'allowed.example.test': '127.0.0.2'}, connect_timeout=3)
        cls.now = [0.0]
        cls.backend = sb.DockerBackend(image=IMAGE, state_dir=cls.base / 'state', proxy=cls.proxy, prefix=PREFIX,
                                       memory='256m', cpus='0.5', pids=128)
        cls.manager = sb.SessionManager(cls.root, cls.backend, max_sessions=3, pause_after=30, remove_after=60, min_free_memory=0,
                                        clock=lambda: cls.now[0], reap_interval=0)
        cls.viewer = FakeViewer()
        cls.session = cls.manager.attach(fx.selector(), cls.viewer)
        cls.name = cls.backend.name(cls.session)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.manager.close()
            cls.proxy.close()
            for server in (cls.allowed, cls.loopback):
                server.shutdown()
                server.server_close()
        finally:
            leftovers = our_containers()
            if leftovers:
                docker('rm', '-f', *leftovers, check=False)
            shutil.rmtree(cls.base, ignore_errors=True)

    def exec(self, *cmd, env=()):
        flags = [arg for item in env for arg in ('-e', item)]
        return docker('exec', *flags, self.name, *cmd, check=False)

    def test_01_hardening_flags(self):
        info = json.loads(docker('inspect', self.name).stdout)[0]
        host = info['HostConfig']
        self.assertEqual(host['NetworkMode'], 'none')
        self.assertTrue(host['ReadonlyRootfs'])
        self.assertEqual(host['CapDrop'], ['ALL'])
        self.assertFalse(host['CapAdd'])
        self.assertIn('no-new-privileges', host['SecurityOpt'])
        self.assertFalse(any('unconfined' in opt for opt in host['SecurityOpt']))
        self.assertFalse(host['Privileged'])
        self.assertTrue(host['Init'])
        self.assertEqual(host['PidsLimit'], 128)
        self.assertEqual(host['Memory'], 256 * 1024 * 1024)
        self.assertEqual(host['NanoCpus'], 500_000_000)
        self.assertEqual(info['Config']['User'], f'{os.getuid()}:{os.getgid()}')
        self.assertEqual(set(host['Tmpfs']), {'/tmp', '/home/sandbox'})
        mounts = {(m['Destination'], m['Source'], m['RW']) for m in info['Mounts']}
        self.assertEqual(mounts, {('/report', str(self.lane / 'reports/finding-a'), True),
                                  ('/run/bbterm', str(self.base / 'state/proxy' / self.session.id), False)})
        self.assertNotIn('docker.sock', json.dumps(info))
        if info.get('AppArmorProfile') is not None and Path('/sys/kernel/security/apparmor').exists():
            self.assertEqual(info['AppArmorProfile'], 'docker-default')
        status = self.exec('cat', '/proc/self/status').stdout
        self.assertIn('NoNewPrivs:\t1', status)
        self.assertIn('CapEff:\t0000000000000000', status)
        self.assertRegex(status, r'Seccomp:\t2')
        self.assertNotEqual(self.exec('touch', '/etc/bbterm-x').returncode, 0)
        self.assertEqual(self.exec('touch', '/tmp/ok').returncode, 0)

    def test_02_shell_starts_in_mounted_report_folder(self):
        self.session.write(b'pwd; python3 poc.py\n')
        self.viewer.wait_for('/report')
        self.viewer.wait_for('poc-ran-ok')

    def test_03_host_edit_visible_immediately(self):
        (self.lane / 'reports/finding-a/poc.py').write_text('print("agent-edited-" + str(6*7))\n')
        self.session.write(b'python3 poc.py\n')
        self.viewer.wait_for('agent-edited-42')

    def test_04_container_edit_lands_on_host_with_host_owner(self):
        self.session.write(b'echo fixed-in-terminal > made-here.txt; mkdir -p sub && echo x > sub/y\n')
        target = self.lane / 'reports/finding-a/made-here.txt'
        deadline = time.time() + 10
        while not target.exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertEqual(target.read_text(), 'fixed-in-terminal\n')
        for path in (target, self.lane / 'reports/finding-a/sub', self.lane / 'reports/finding-a/sub/y'):
            st = path.stat()
            self.assertEqual((st.st_uid, st.st_gid), (os.getuid(), os.getgid()))

    def test_05_nothing_outside_the_folder(self):
        self.assertNotEqual(self.exec('cat', '/report/../flat.md').returncode, 0)
        listing = self.exec('ls', '-a', '/').stdout.split()
        self.assertNotIn('flat.md', listing)
        mountinfo = self.exec('cat', '/proc/self/mountinfo').stdout
        self.assertNotIn(str(self.root) + ' ', mountinfo)
        self.assertNotIn('docker.sock', mountinfo)
        root_mounts = [line for line in mountinfo.splitlines() if str(self.base) in line or '/report' in line]
        self.assertEqual(len([m for m in root_mounts if ' /report ' in m]), 1)
        self.assertEqual(self.exec('ls', '/run/bbterm').stdout.split(), ['proxy.sock'])
        grep = self.exec('sh', '-c', 'grep -rl "must never be visible" / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; true')
        self.assertEqual(grep.stdout.strip(), '')

    def test_06_network_policy(self):
        Recorder.hits.clear()
        allowed_port, loop_port = self.allowed.server_address[1], self.loopback.server_address[1]
        urls = {'allowed': f'http://allowed.example.test:{allowed_port}/x', 'host loopback': f'http://127.0.0.1:{loop_port}/',
                'localhost name': f'http://localhost:{loop_port}/', 'bridge gateway': f'http://{self.gateway}:{loop_port}/',
                'private 10': 'http://10.0.0.1/', 'private 192': 'http://192.168.1.1/', 'tailnet 100.x': 'http://100.100.100.100/',
                'metadata': 'http://169.254.169.254/latest/meta-data/', 'ula tailnet': 'http://[fd7a:115c:a1e0::1]/'}
        tunnels = {'allowed': ['allowed.example.test', allowed_port], 'host loopback': ['127.0.0.1', loop_port],
                   'metadata': ['169.254.169.254', 80], 'tailnet 100.x': ['100.100.100.100', 80],
                   'bridge gateway': [self.gateway, loop_port]}
        # NO_PROXY normally sends 127.0.0.1/localhost direct (and that fails: no
        # network). Clear it so every probe goes through the proxy's filter.
        result = self.exec('python3', '-c', PROBE, json.dumps(urls), json.dumps(tunnels), self.gateway,
                           env=('NO_PROXY=', 'no_proxy='))
        self.assertEqual(result.returncode, 0, result.stderr)
        got = json.loads(result.stdout)
        self.assertEqual(got['allowed'], [200, 'allowed-egress-ok'])
        for name in urls:
            if name != 'allowed':
                self.assertEqual(got[name][0], 403, (name, got[name]))
        self.assertTrue(got['connect allowed'].startswith('HTTP/1.1 200'))
        self.assertEqual(got['socks allowed'], 0)
        for name in tunnels:
            if name != 'allowed':
                self.assertIn('403', got[f'connect {name}'], name)
                self.assertEqual(got[f'socks {name}'], 2, name)
        self.assertTrue(got['direct internet'].startswith('refused'))
        self.assertTrue(got['direct gateway'].startswith('refused'))
        self.assertEqual(got['dns'], 'failed')
        hosts = {hit[0][0] for hit in Recorder.hits}
        self.assertEqual(hosts, {'127.0.0.2'})  # the host loopback listener was never reached
        self.assertTrue(all('Proxy-Connection' not in hit[2] for hit in Recorder.hits))
        print('\nNETWORK EVIDENCE ' + json.dumps(got, sort_keys=True))

    def test_065_pause_freezes_and_resume_keeps_shell(self):
        session = self.session
        self.viewer.output.clear()
        session.write(b'mkdir -p sub; cd sub; (while true; do echo t >> /tmp/ticks; sleep 0.2; done) & echo bg-$((1+1))\n')
        self.viewer.wait_for('bg-2')
        time.sleep(1)
        ticks = lambda: int(self.exec('sh', '-c', 'wc -l < /tmp/ticks').stdout.split()[0])
        c0, t0 = ticks(), time.monotonic()
        self.manager.detach(session, self.viewer)
        self.now[0] += 31
        paused, removed = self.manager.reap_idle()
        self.assertEqual((paused, removed), ([session], []))
        state = json.loads(docker('inspect', self.name).stdout)[0]['State']
        self.assertTrue(state['Paused'])
        self.assertEqual(self.backend.state(session), 'paused')
        self.backend.pause(session)  # idempotent
        time.sleep(2)  # frozen: no ticks while paused
        viewer = FakeViewer()
        same = self.manager.attach(fx.selector(), viewer)
        self.assertIs(same, session)
        self.assertEqual(viewer.controls[0]['event'], 'resumed')
        self.assertIn(b'bg-2', bytes(viewer.output), 'scrollback kept')
        type(self).viewer = viewer
        c1, elapsed = ticks(), time.monotonic() - t0
        # Running, the job writes 5 ticks a second; frozen for >= 2 s it must fall well short.
        self.assertLess(c1 - c0, elapsed * 5 / 2, f'job kept running while paused: {c1 - c0} ticks in {elapsed:.1f} s')
        counts = []
        for _ in range(2):
            out = self.exec('sh', '-c', 'wc -l < /tmp/ticks; cat /proc/loadavg >/dev/null').stdout.split()
            counts.append(int(out[0]))
            time.sleep(1.2)
        self.assertGreater(counts[1], counts[0], 'background job runs again after unpause')
        # While paused the job made no progress: ticks written ~= running time only.
        session.write(b'echo "cwd=$PWD alive=$(kill -0 $! && echo yes)"\n')
        viewer.wait_for('cwd=/report/sub alive=yes')
        session.write(b'kill %1; cd /report\n')
        print(f'\nPAUSE EVIDENCE {c1 - c0} ticks across {elapsed:.1f} s including a 2 s pause; after resume {counts}')

    def test_07_idle_reap_and_stale_reap(self):
        viewer = FakeViewer()
        other = self.manager.attach(fx.selector('solo/notes.md'), viewer)
        name = self.backend.name(other)
        self.assertIn(name, our_containers())
        self.manager.detach(other, viewer)
        self.now[0] += 61
        paused, removed = self.manager.reap_idle()
        self.assertIn(other, removed)
        self.assertNotIn(name, our_containers())
        # A container left over from an earlier run (prefix AND label) is reaped on start;
        # one with the prefix but without the label is left alone.
        # (A separate prefix keeps this run's live session out of the reap.)
        stale = 'bbterm-test-stale-'
        docker('run', '-d', '--name', f'{stale}one', '--label', f'{sb.LABEL}=1', '--label', f'{sb.LABEL}.prefix={stale}',
               '--network', 'none', IMAGE, 'sleep', '300')
        docker('run', '-d', '--name', f'{stale}nolabel', '--network', 'none', IMAGE, 'sleep', '300')
        try:
            backend = sb.DockerBackend(image=IMAGE, state_dir=self.base / 'state2', proxy=self.proxy, prefix=stale)
            names = backend.reap_stale()
            self.assertEqual(names, [f'{stale}one'])
            self.assertIn(f'{stale}nolabel', our_containers())
            self.assertNotIn(f'{stale}one', our_containers())
            self.assertIn(self.name, our_containers())
        finally:
            docker('rm', '-f', f'{stale}nolabel', f'{stale}one', check=False)

    def test_08_evidence_written_by_service(self):
        self.session.write(b'echo evidence-line-$((7*6))\n')
        self.viewer.wait_for('evidence-line-42')
        rel = sb.save_evidence(self.root, fx.selector(), self.session.transcript_text())
        self.assertTrue(rel.startswith('reports/finding-a/validation/terminal-'))
        self.assertIn('evidence-line-42', (self.lane / rel).read_text())
        self.assertEqual(self.exec('ls', '/report/validation').returncode, 0)  # visible in the sandbox too

    def test_09_measure_memory_and_pause_latency(self):
        stats = docker('stats', '--no-stream', '--format', '{{.MemUsage}}', self.name).stdout.strip()
        pauses, unpauses = [], []
        for _ in range(10):
            t = time.perf_counter(); self.backend.pause(self.session); pauses.append(time.perf_counter() - t)
            t = time.perf_counter(); self.backend.unpause(self.session); unpauses.append(time.perf_counter() - t)
        paused_stats = None
        self.backend.pause(self.session)
        paused_stats = docker('stats', '--no-stream', '--format', '{{.MemUsage}}', self.name).stdout.strip()
        self.backend.unpause(self.session)
        med = lambda xs: sorted(xs)[len(xs) // 2]
        print(f'\nMEASURE idle sandbox memory {stats}; while paused {paused_stats}; '
              f'docker pause median {med(pauses)*1000:.0f} ms (max {max(pauses)*1000:.0f}); '
              f'unpause median {med(unpauses)*1000:.0f} ms (max {max(unpauses)*1000:.0f}); n=10')
        session = self.session
        session.write(b'echo after-measure-$((2+5))\n')
        self.viewer.wait_for('after-measure-7')

    def test_99_cleanup_on_stop(self):
        manager = sb.SessionManager(self.root, sb.DockerBackend(image=IMAGE, state_dir=self.base / 'state3', proxy=self.proxy,
                                                                prefix='bbterm-test-stop-'), reap_interval=0)
        viewer = FakeViewer()
        session = manager.attach(fx.selector('flat.md'), viewer)
        name = manager.backend.name(session)
        self.assertIn(name, our_containers())
        manager.backend.pause(session)  # a paused sandbox is removed too
        session.paused = True
        manager.close()
        self.assertNotIn(name, our_containers())
        self.assertEqual(list((self.base / 'state3/proxy').iterdir()), [])
        self.assertTrue(viewer.closed)


if __name__ == '__main__':
    unittest.main()
