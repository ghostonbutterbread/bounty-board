"""Report agent: settings, CLI registry, task validation, prompt, and the service routes
with the test-only local backend and a fake CLI (no real CLI, no real login, no network)."""
import http.client
import io
import json
import os
import shutil
import stat
import sys
import tarfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_agent_cli as cli  # noqa: E402
import terminal_report_agent as ra  # noqa: E402
import terminal_relay as tr  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
import terminal_service as ts  # noqa: E402
from tests import fake_model_upstream as fu  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.terminal_ws_client import Client  # noqa: E402

BOARD = '127.0.0.1:18902'
ORIGIN = f'http://{BOARD}'
FAKE_TOKEN = 'sk-ant-oat01-FAKE-agent-test-token-abcdefghijklmnop'
FAKE_CLI = Path(__file__).resolve().parent / 'fake_agent_cli.py'


def write_token(path, token=FAKE_TOKEN, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    os.write(fd, token.encode() + b'\n')
    os.close(fd)
    os.chmod(path, mode)


# -- units ------------------------------------------------------------------------

class TaskTests(unittest.TestCase):
    def test_valid_tasks(self):
        self.assertEqual(ra.validate_task({'kind': 'ask', 'text': 'Why?\nThanks\t!'})['text'], 'Why?\nThanks\t!')
        task = ra.validate_task({'kind': 'poc_format', 'format': 'python',
                                 'block': {'text': 'curl -s https://example.test/', 'lang': 'bash', 'index': 2}})
        self.assertEqual(task['block']['index'], 2)
        for fmt in ra.FORMATS:
            self.assertEqual(ra.validate_task({'kind': 'poc_format', 'format': fmt})['block'], None)

    def test_refusals(self):
        bad = [None, {}, {'kind': 'run', 'text': 'x'}, {'kind': 'ask'}, {'kind': 'ask', 'text': ''},
               {'kind': 'ask', 'text': 'x', 'extra': 1}, {'kind': 'ask', 'text': 5},
               {'kind': 'poc_format', 'format': 'go'}, {'kind': 'poc_format', 'format': 'python', 'x': 1},
               {'kind': 'poc_format', 'format': 'python', 'block': {'text': 'a', 'lang': 'bash'}},
               {'kind': 'poc_format', 'format': 'python', 'block': {'text': 'a', 'lang': 'ba sh', 'index': 0}},
               {'kind': 'poc_format', 'format': 'python', 'block': {'text': 'a', 'lang': 'bash', 'index': True}},
               {'kind': 'poc_format', 'format': 'python', 'block': {'text': 'a', 'lang': 'bash', 'index': -1}}]
        for raw in bad:
            with self.assertRaises(ra.AgentError, msg=raw) as caught:
                ra.validate_task(raw)
            self.assertEqual(caught.exception.status, 400)

    def test_caps(self):
        ra.validate_task({'kind': 'ask', 'text': 'a' * ra.ASK_MAX})
        with self.assertRaises(ra.AgentError) as caught:
            ra.validate_task({'kind': 'ask', 'text': 'a' * (ra.ASK_MAX + 1)})
        self.assertEqual(caught.exception.code, 'task_too_large')
        block = {'kind': 'poc_format', 'format': 'curl', 'block': {'text': 'é' * (ra.BLOCK_MAX // 2), 'lang': '', 'index': 0}}
        ra.validate_task(block)
        block['block']['text'] += 'x'
        with self.assertRaises(ra.AgentError):
            ra.validate_task(block)

    def test_unsafe_characters_match_the_typing_filter(self):
        for ch in ['\x1b', '\x00', '\r', '\x7f', '\x85', '­', '؜', '​', '‏', '‮', '⁦',
                   '﻿', ' ', ' ']:
            with self.assertRaises(ra.AgentError, msg=repr(ch)) as caught:
                ra.validate_task({'kind': 'ask', 'text': f'echo hi{ch}there'})
            self.assertEqual(caught.exception.code, 'unsafe_chars')
            with self.assertRaises(ra.AgentError):
                ra.validate_task({'kind': 'poc_format', 'format': 'python', 'block': {'text': f'a{ch}', 'lang': '', 'index': 0}})
        ra.validate_task({'kind': 'ask', 'text': 'tab\tand newline\nand emoji 👍 and accents é are fine'})
        # The JS filter in the drawer is the reference set: same answer for every code point up to U+FFFF.
        import re
        js = (Path(__file__).resolve().parents[1] / 'static/modules/sandbox-terminal.js').read_text()
        pattern = re.search(r"const UNSAFE = /(\[[^\]]+\])/;", js).group(1)
        reference = re.compile(pattern)
        for cp in range(0x10000):
            if 0xd800 <= cp <= 0xdfff:
                continue
            ch = chr(cp)
            self.assertEqual(bool(reference.search(ch)), bool(ra.UNSAFE.search(ch)), hex(cp))

    def test_prompt_is_rendered_in_one_pass(self):
        template = ra.PROMPT_TEMPLATE.read_text()
        task = ra.validate_task({'kind': 'poc_format', 'format': 'python',
                                 'block': {'text': 'echo {{REPORT_PATH}} ```x```', 'lang': 'bash', 'index': 0}})
        text = ra.render_prompt(template, 'example-com-sqli-D1.md', task)
        self.assertIn('The main report is `example-com-sqli-D1.md`', text)
        self.assertIn('echo {{REPORT_PATH}} ```x```', text)  # not expanded again
        self.assertIn('````text\n', text)  # fence longer than the block's backticks
        self.assertIn('a standalone Python PoC (poc.py)', text)
        for name in ('bunny-report-and-triage', 'triager-first-poc-authoring', 'poc-tooling-policy', 'Manual Reproduction'):
            self.assertIn(name, text)
        rules = (
            'Never edit `EVIDENCE.md`', '--proxy URL', 'No em dashes', 'ask whether to delete it',
            # skills to load (follow-up 2)
            'vulnerability-class skill that matches this report (for example `xss`, `idor` or `ssrf`)',
            'Load `live-testing-policy` before any live request',
            # what the sandbox lacks
            'sandbox egress proxy. It stands in for the task MITM here',
            'no task MITM, no Bitwarden, no inbox and no ledger', "The PoC's own output, saved in the packet, is the record",
            'say what is missing and continue with what is possible', 'Never improvise a substitute for credentials',
            # order of work
            '1. Offline checks first', '2. Then ask to run the PoC end to end. The approval prompt shows',
            'only to the target and endpoints named in the report and the evidence, with the fewest requests needed, and nothing destructive',
            '3. Show Ryu the observed result', '4. Save the run output as a new file in the packet',
            '`poc-run-<UTC timestamp>.txt`', 'with secrets redacted', 'Never overwrite an earlier run file',
            # verdict
            'say GREEN only when a live run showed the expected impact', 'YELLOW / not ready, and what is missing',
            'Never write a status word into the report file',
            # credentials
            'also supports `--auth-file PATH`', 'Never ask Ryu to paste cookies, tokens or passwords into this chat',
            'never print a credential or the contents of a credential file',
            "`rm -f /tmp/bb-auth; (umask 077; set -C; IFS= read -rs BB_AUTH && printf '%s' \"$BB_AUTH\" > /tmp/bb-auth)`",
            'You cannot read `/tmp/bb-auth` with your file tools',
            'The sandbox `/tmp` is shared within this container', 'run the PoC with `--auth-file /tmp/bb-auth`',
            'ask Ryu whether to delete `/tmp/bb-auth`',
            # out of scope
            'looks out of scope or different from the report, stop and ask Ryu',
        )
        for rule in rules:
            self.assertEqual(text.count(rule), 1, rule)
        self.assertNotIn('Never send requests to the target unless', text)  # replaced by the approval flow
        self.assertNotIn('—', template)
        self.assertNotIn('{{', ra.render_prompt(template, 'r.md', ra.validate_task({'kind': 'ask', 'text': 'hi'})))


class CliRegistryTests(unittest.TestCase):
    def setUp(self):
        self.dir = fx.tmp_base('agentcli')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_registry_and_models(self):
        self.assertEqual(sorted(cli.REGISTRY), ['claude', 'codex', 'omp', 'opencode'])
        claude = cli.REGISTRY['claude']
        self.assertTrue(claude.sandbox_ready)
        for model in ('default', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5'):
            self.assertTrue(claude.valid_model(model), model)
        for model in ('', '-x', 'Opus', 'a b', 'x' * 65, '--dangerously', 'opus;rm', None, 5):
            self.assertFalse(claude.valid_model(model), model)
        for other in ('codex', 'omp', 'opencode'):
            spec = cli.REGISTRY[other]
            self.assertFalse(spec.sandbox_ready)
            self.assertEqual(spec.reason, 'needs_sandbox_login')
            self.assertFalse(spec.valid_model('opus'))

    def test_flags(self):
        self.assertEqual(cli.parse_cli_flags(['claude=/usr/bin/x']), {'claude': '/usr/bin/x'})
        for bad in (['claude'], ['claude=relative'], ['nope=/x'], ['claude=/a', 'claude=/b'], ['=/x']):
            with self.assertRaises(cli.CliError):
                cli.parse_cli_flags(bad)
        skill = self.dir / 'skill'
        skill.mkdir()
        self.assertEqual(cli.parse_skill_flags([f'poc-tooling-policy={skill}']), {'poc-tooling-policy': str(skill)})
        link = self.dir / 'link'
        link.symlink_to(skill)
        with self.assertRaises(cli.CliError):
            cli.parse_skill_flags([f'x={link}'])
        with self.assertRaises(cli.CliError):
            cli.parse_skill_flags([f'x={self.dir / "missing"}'])
        self.assertEqual(cli.parse_skill_flags([f'Bunny_Report.v2={skill}']), {'Bunny_Report.v2': str(skill)})  # real names
        for bad in ('.hidden', 'a/b', 'x' * 129, '-lead'):
            with self.assertRaises(cli.CliError):
                cli.parse_skill_flags([f'{bad}={skill}'])

    def test_binary_is_resolved_through_symlinks(self):
        real = self.dir / 'versions' / '9.9.9'
        real.parent.mkdir()
        real.write_text('#!/bin/sh\n')
        real.chmod(0o755)
        link = self.dir / 'claude'
        link.symlink_to(real)
        self.assertEqual(cli.resolve_binary(str(link)), str(real))
        real.chmod(0o644)
        with self.assertRaises(cli.CliError):
            cli.resolve_binary(str(link))
        with self.assertRaises(cli.CliError):
            cli.resolve_binary(None)

    def test_claude_home_files(self):
        files, links = cli.ClaudeAdapter().home_files(['poc-tooling-policy'], version='2.1.332')
        state = json.loads(files['.claude.json'])
        self.assertTrue(state['hasCompletedOnboarding'] and state['hasSeenAutoDefaultNudge'])
        self.assertTrue(state['projects']['/report']['hasTrustDialogAccepted'])
        self.assertEqual(state['lastOnboardingVersion'], '2.1.332')
        settings = json.loads(files['.claude/settings.json'])
        self.assertEqual(set(settings), {'env'})  # the policy is in the read-only managed file (test_review_r1_*)
        self.assertEqual(settings['env']['DISABLE_AUTOUPDATER'], '1')
        self.assertEqual(settings['env']['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'], '1')
        self.assertEqual(links, {'.claude/skills': '/opt/report-agent/skills'})  # one link to the one tree
        self.assertEqual(cli.ClaudeAdapter().home_files([])[1], {})
        env = cli.ClaudeAdapter().env()
        self.assertEqual(env['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:3129')
        self.assertEqual(env['CLAUDE_CODE_OAUTH_TOKEN'], cli.DUMMY_OAUTH_TOKEN)
        self.assertEqual(cli.ClaudeAdapter().argv('/opt/report-agent/claude', 'default'),
                         ['/opt/report-agent/claude', *cli.CLAUDE_FIXED_ARGS, '--', cli.INITIAL_PROMPT])
        self.assertEqual(cli.ClaudeAdapter().argv('/b', 'opus')[1:3], ['--model', 'opus'])

    def test_home_archive(self):
        files, links = cli.ClaudeAdapter().home_files(['s1'])
        data = ra.home_archive(files, links, 'task body')
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            members = {m.name: m for m in archive.getmembers()}
            self.assertEqual(archive.extractfile(members['.report-agent/task.md']).read(), b'task body')
        self.assertEqual(members['.report-agent'].mode, 0o700)
        self.assertEqual(members['.claude.json'].mode, 0o600)
        self.assertTrue(members['.claude/skills'].issym())
        self.assertEqual(members['.claude/skills'].linkname, '/opt/report-agent/skills')
        self.assertFalse(any(m.name.startswith('/') or '..' in m.name for m in members.values()))


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.dir = fx.tmp_base('agentset')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def hub(self, enabled=True):
        return ra.ReportAgentHub(enabled=enabled, root=self.dir / 'root', state_dir=self.dir, template='x')

    def test_defaults_set_and_persist(self):
        hub = self.hub()
        try:
            self.assertEqual(hub.selected(), ('claude', 'default'))
            self.assertFalse((self.dir / 'agent-settings.json').exists())
            hub.set_config({'cli': 'claude', 'model': 'opus'})
            self.assertEqual(stat.S_IMODE(os.stat(self.dir / 'agent-settings.json').st_mode), 0o600)
            self.assertFalse([p for p in os.listdir(self.dir) if p.endswith('.tmp')])
        finally:
            hub.close()
        again = self.hub()
        try:
            self.assertEqual(again.selected(), ('claude', 'opus'))
            for body in ({'cli': 'claude'}, {'cli': 'claude', 'model': 'opus', 'x': 1}, {'cli': 'nope', 'model': 'default'},
                         {'cli': 'claude', 'model': 'Bad Model'}, {'cli': 1, 'model': 'opus'}):
                with self.assertRaises(ra.AgentError) as caught:
                    again.set_config(body)
                self.assertEqual(caught.exception.status, 400)
        finally:
            again.close()

    def test_corrupt_and_unreadable_files(self):
        path = self.dir / 'agent-settings.json'
        path.write_text('{not json')
        hub = self.hub()
        try:
            self.assertEqual(hub.selected(), ('claude', 'default'))
            hub.set_config({'cli': 'codex', 'model': 'default'})
            self.assertEqual(len(list(self.dir.glob('agent-settings.json.corrupt-*'))), 1)
        finally:
            hub.close()
        path.unlink()
        path.mkdir()
        hub = self.hub()
        try:
            with self.assertRaises(ra.AgentError) as caught:
                hub.set_config({'cli': 'claude', 'model': 'opus'})
            self.assertEqual((caught.exception.status, caught.exception.code), (500, 'settings_unreadable'))
            self.assertTrue(path.is_dir())
        finally:
            hub.close()

    def test_disabled_hub_refuses_changes_and_reports_off(self):
        hub = self.hub(enabled=False)
        self.assertFalse(hub.config_payload()['enabled'])
        with self.assertRaises(ra.AgentError) as caught:
            hub.set_config({'cli': 'claude', 'model': 'opus'})
        self.assertEqual((caught.exception.status, caught.exception.code), (409, 'report_agent_disabled'))
        self.assertIsNone(hub.relay)


class DockerExecTests(unittest.TestCase):
    """What the Docker executor asks Docker to do (fake run; real Docker is in test_terminal_agent_docker)."""

    class FakeBackend(sb.DockerBackend):
        def __init__(self):
            self.docker, self.prefix, self.calls = 'docker', 'bbterm-', []

        def run(self, *args, timeout=60, check=True):
            self.calls.append(args)
            return type('R', (), {'returncode': 0, 'stdout': b'', 'stderr': b''})()

    def test_argv_never_carries_task_text_and_memory_is_raised(self):
        backend = self.FakeBackend()
        session = type('S', (), {'id': 'abc123def456'})()
        executor = ra.DockerExec(backend)
        env = cli.ClaudeAdapter().env()
        argv = executor.argv(session, '/opt/report-agent/claude', cli.ClaudeAdapter().argv('/opt/report-agent/claude', 'opus')[1:], env)
        self.assertEqual(argv[:6], ['docker', 'exec', '-it', '-w', '/report', '-e'])
        self.assertIn('bbterm-abc123def456', argv)
        tail = argv[argv.index('bbterm-abc123def456') + 1:]
        self.assertEqual(tail, ['/bin/sh', '-c', ra.WRAPPER, 'report-agent', '/opt/report-agent/claude', '--model', 'opus',
                                *cli.CLAUDE_FIXED_ARGS, '--', cli.INITIAL_PROMPT])
        self.assertNotIn(FAKE_TOKEN, ' '.join(argv))
        executor.raise_memory(session)
        self.assertEqual(backend.calls[-1], ('update', '--memory', '2g', '--memory-swap', '2g', 'bbterm-abc123def456'))
        executor.signal_agent(session, __import__('signal').SIGTERM, 4242)
        call = backend.calls[-1]
        self.assertEqual(call[:4], ('exec', 'bbterm-abc123def456', '/bin/sh', '-c'))
        self.assertEqual(call[-2:], ('TERM', '4242'))  # the pid recorded at start, as an argument

    def test_run_args_extra_mounts_read_only(self):
        base = fx.tmp_base('agentmounts')
        try:
            real = base / 'claude-bin'
            real.write_text('#!/bin/sh\n')
            real.chmod(0o755)
            link = base / 'claude'
            link.symlink_to(real)
            skill = base / 'skill'
            skill.mkdir()
            hub = ra.ReportAgentHub(enabled=True, root=base, state_dir=base / 'state', clis={'claude': str(link)},
                                    skills={'poc-tooling-policy': str(skill)}, template='x')
            try:
                session = type('S', (), {})()
                args = hub.run_args_extra(session)
                tree = hub.tree[1]
                self.assertEqual(args, ['--mount', f'type=bind,source={real},target=/opt/report-agent/claude,readonly',
                                        '--mount', f'type=bind,source={hub.managed_dir.absolute()},target=/etc/claude-code,readonly',
                                        '--mount', f'type=bind,source={tree},target=/opt/report-agent/skills,readonly'])
                self.assertEqual(session.agent_mounts, {'clis': {'claude': str(real)}, 'skills': ['poc-tooling-policy'], 'skills_tree': tree})
                skill.rmdir()
                skill.symlink_to(base)  # swapped for a symlink after start: refused at docker run
                self.assertEqual(hub.run_args_extra(session)[4:], [])
            finally:
                hub.close()
        finally:
            shutil.rmtree(base, ignore_errors=True)


# -- service, local backend, fake CLI ---------------------------------------------------

class AgentServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = fx.tmp_base('agent')
        cls.root = fx.make_root(cls.base)
        cls.cert, cls.key = fu.make_cert(cls.base / 'tls')
        cls.upstream = fu.FakeUpstream(cls.cert, cls.key)
        cls.token = cls.base / 'login-token'
        write_token(cls.token)
        cls.skill = cls.base / 'skills' / 'poc-tooling-policy'
        cls.skill.mkdir(parents=True)
        (cls.skill / 'SKILL.md').write_text('---\nname: poc-tooling-policy\ndescription: synthetic\n---\n')
        cls.clock = [1000.0]
        cls.hub = ra.ReportAgentHub(enabled=True, root=cls.root, state_dir=cls.base / 'state',
                                    clis={'claude': str(FAKE_CLI)}, skills={'poc-tooling-policy': str(cls.skill)},
                                    token_file=cls.token, relay_upstream=('127.0.0.1', cls.upstream.port),
                                    relay_ssl_context=fu.client_context(cls.cert), stop_grace=2.0)
        cls.backend = sb.LocalBackend(cls.base / 'local')
        cls.server = ts.make_service(cls.root, port=0, allowed_origins=[ORIGIN], allowed_users=['ryu@example.test'],
                                     state_dir=cls.base / 'state', backend=cls.backend, reap_interval=0,
                                     min_free_memory=0, report_agent=cls.hub)
        cls.server.manager.clock = lambda: cls.clock[0]
        cls.hub.clock = time.monotonic  # PTY output times are real; the manager clock is driven by the test
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.upstream.close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def tearDown(self):
        for path in (fx.PRIMARY, fx.SECOND):
            self.request('POST', '/terminal/api/agent/stop', {'selector': fx.selector(path)})
        write_token(self.token)

    def request(self, method, path, body=None, tailnet=True, origin=True, csrf=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=60)
        h = {'Host': BOARD}
        if tailnet:
            h['Tailscale-User-Login'] = 'ryu@example.test'
        if origin:
            h['Origin'] = ORIGIN
        data = b''
        if body is not None:
            data = json.dumps(body).encode()
            h['Content-Type'] = 'application/json'
            if csrf:
                h['X-Requested-With'] = 'Bounty-Board'
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for key, value in h.items():
            conn.putheader(key, value)
        conn.putheader('Content-Length', str(len(data)))
        conn.endheaders(data)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw)

    def ws(self, sel, kind='agent'):
        headers = {'Host': BOARD, 'Origin': ORIGIN, 'Tailscale-User-Login': 'ryu@example.test'}
        return Client(self.port, f'/terminal/ws?{urlencode({**sel, "kind": kind})}', headers)

    def start(self, path=fx.PRIMARY, task=None, **extra):
        task = task or {'kind': 'poc_format', 'format': 'python',
                        'block': {'text': 'curl -s https://example.test/login -d "u=1\'"', 'lang': 'bash', 'index': 0}}
        return self.request('POST', '/terminal/api/agent/start', {'selector': fx.selector(path), 'task': task, **extra})

    def session_state(self, path=fx.PRIMARY):
        return self.request('GET', '/terminal/api/agent/session?' + urlencode(fx.selector(path)))[1]

    def wait_state(self, want, path=fx.PRIMARY, limit=20):
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            info = self.session_state(path)
            if info['state'] == want:
                return info
            time.sleep(0.2)
        self.fail(f'state never became {want}: {info}')

    # -- config ----------------------------------------------------------------------
    def test_config_get_and_post_with_gates(self):
        status, payload = self.request('GET', '/terminal/api/agent/config')
        self.assertEqual(status, 200)
        self.assertTrue(payload['enabled'])
        login = dict(payload['login'])
        self.assertIsInstance(login.pop('saved_at'), int)
        self.assertEqual(login, {'ready': True, 'reason': None, 'message': None, 'editable': True})
        clis = {c['id']: c for c in payload['clis']}
        self.assertEqual(set(clis), {'claude', 'codex', 'omp', 'opencode'})
        self.assertTrue(clis['claude']['available'] and clis['claude']['sandbox_ready'])
        self.assertEqual(clis['claude']['models'], ['default', 'opus', 'sonnet', 'haiku'])
        self.assertEqual((clis['codex']['available'], clis['codex']['sandbox_ready'], clis['codex']['reason']),
                         (False, False, 'needs_sandbox_login'))
        self.assertEqual(self.request('GET', '/terminal/api/agent/config', tailnet=False)[0], 401)
        body = {'cli': 'claude', 'model': 'sonnet'}
        self.assertEqual(self.request('POST', '/terminal/api/agent/config', body, origin=False)[0], 403)
        self.assertEqual(self.request('POST', '/terminal/api/agent/config', body, csrf=False)[0], 403)
        self.assertEqual(self.request('POST', '/terminal/api/agent/config', body, tailnet=False)[0], 401)
        self.assertEqual(self.request('POST', '/terminal/api/agent/config', {'cli': 'claude'})[0], 400)
        status, payload = self.request('POST', '/terminal/api/agent/config', body)
        self.assertEqual((status, payload['selected']), (200, body))
        status, payload = self.request('POST', '/terminal/api/agent/config', {'cli': 'claude', 'model': 'default'})
        self.assertEqual(payload['selected']['model'], 'default')
        status, payload = self.request('GET', '/terminal/api/status')
        self.assertEqual((payload['report_agent'], payload['agent_connect']), (True, False))

    def test_login_state_in_config_and_start(self):
        os.chmod(self.token, 0o644)
        status, payload = self.request('GET', '/terminal/api/agent/config')
        self.assertEqual(payload['login']['ready'], False)
        self.assertEqual(payload['login']['reason'], 'bad_mode')
        status, payload = self.start()
        self.assertEqual((status, payload['error'], payload['reason']), (409, 'login_missing', 'bad_mode'))
        self.assertNotIn(FAKE_TOKEN, json.dumps(payload))

    # -- start / session / attach ---------------------------------------------------------
    def test_start_attach_type_and_stop(self):
        status, info = self.start()
        self.assertEqual(status, 200, info)
        self.assertIn(info['state'], ('working', 'waiting'))
        self.assertEqual((info['cli'], info['model']), ('claude', 'default'))
        status, again = self.start()
        self.assertEqual((status, again['error']), (409, 'agent_running'))
        self.assertEqual(again['agent']['cli'], 'claude')
        client = self.ws(fx.selector())
        try:
            self.assertEqual(client.status, 101)
            client.wait_output('READY')
            hello = [c for c in client.controls if c.get('type') == 'hello'][0]
            self.assertEqual((hello['kind'], hello['agent']['cli']), ('agent', 'claude'))
            out = bytes(client.output).decode('utf-8', 'replace')
            self.assertIn('ARGV ["--setting-sources", "user", "--strict-mcp-config", "--mcp-config", "{\\"mcpServers\\":{}}", "--", '
                          '"Read /home/sandbox/.report-agent/task.md and follow it."]', out)
            self.assertIn('CWD ' + str(self.root / fx.FAMILY / fx.PROGRAM / fx.LANE / 'reports/D1-sqli-login'), out)
            self.assertIn('The main report is `example-com-sqli-D1.md`', out)
            self.assertIn('curl -s https://example.test/login', out)
            self.assertIn('TOKEN_IS_DUMMY True', out)
            self.assertIn('HOMEFILE .claude.json True', out)
            self.assertIn('MODEL-STATUS HTTP/1.1 200', out)
            self.assertIn('MODEL-REPLY FAKE-REPLY-OK', out)
            self.assertEqual(self.upstream.requests[-1]['headers']['authorization'], [f'Bearer {FAKE_TOKEN}'])
            self.assertNotIn(FAKE_TOKEN, out)
            client.send_json({'t': 'in', 'd': 'hello agent\r'})
            client.wait_output('ECHO hello agent')
            client.send_json({'t': 'resize', 'cols': 90, 'rows': 20})
            self.assertEqual(self.session_state()['viewers'], 1)
            info = self.wait_state('waiting')
            client.send_json({'t': 'in', 'd': 'spam\r'})
            client.wait_output('spam-1')
            self.assertEqual(self.session_state()['state'], 'working')
            status, stopped = self.request('POST', '/terminal/api/agent/stop', {'selector': fx.selector()})
            self.assertEqual((status, stopped['state']), (200, 'none'))
            client.pump_until(lambda c: any(m.get('type') == 'closed' for m in c.controls))
        finally:
            client.close()
        self.assertEqual(self.session_state()['state'], 'none')

    def test_exit_code_and_restart(self):
        self.assertEqual(self.start()[0], 200)
        client = self.ws(fx.selector())
        try:
            client.wait_output('READY')
            client.send_json({'t': 'in', 'd': 'quit\r'})
            client.pump_until(lambda c: any(m.get('type') == 'exit' for m in c.controls))
        finally:
            client.close()
        info = self.wait_state('exited')
        self.assertEqual(info['exit_code'], 7)
        status, info = self.start(task={'kind': 'ask', 'text': 'What does this PoC need?'})
        self.assertEqual(status, 200, info)

    def test_relay_only_serves_a_live_agent(self):
        self.assertEqual(self.start()[0], 200)
        session = self.server.manager.get(fx.selector())
        path = self.hub.relay_paths[session.id]
        self.request('POST', '/terminal/api/agent/stop', {'selector': fx.selector()})
        import socket
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(path)
        sock.sendall(b'POST /v1/messages HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}')
        reply = sock.recv(4096)
        sock.close()
        self.assertTrue(reply.startswith(b'HTTP/1.1 403'), reply[:60])

    def test_refusals(self):
        self.assertEqual(self.start(cli='codex')[1]['error'], 'cli_not_sandbox_ready')
        self.assertEqual(self.start(cli='claude', model='Bad Model')[0], 400)
        self.assertEqual(self.start(task={'kind': 'ask', 'text': 'hi\x1b[201~'})[1]['error'], 'unsafe_chars')
        self.assertEqual(self.start(path=fx.LEGACY)[1]['error'], 'report_outside_folder')
        self.assertEqual(self.start(path=fx.NAVIGATION)[1]['error'], 'not_in_packet')
        self.assertEqual(self.request('POST', '/terminal/api/agent/start', {'selector': fx.selector()})[0], 400)
        self.assertEqual(self.request('POST', '/terminal/api/agent/start', {'selector': fx.selector(), 'task': {'kind': 'ask', 'text': 'x'},
                                                                          'extra': 1})[0], 400)
        self.assertEqual(self.request('POST', '/terminal/api/agent/stop', {'selector': fx.selector(), 'x': 1})[0], 400)
        client = self.ws(fx.selector(fx.SECOND))
        try:
            client.pump_until(lambda c: any(m.get('type') == 'error' for m in c.controls))
            self.assertEqual([m for m in client.controls if m['type'] == 'error'][0]['code'], 'no_agent')
        finally:
            client.close()
        self.assertEqual(self.request('POST', '/terminal/api/agent/start', {'selector': fx.selector(), 'task': {'kind': 'ask', 'text': 'x'}},
                                      csrf=False)[0], 403)

    def test_agent_viewers_count_and_pause_hold(self):
        self.assertEqual(self.start()[0], 200)
        manager = self.server.manager
        session = manager.get(fx.selector())
        session.left_at = self.clock[0]
        client = self.ws(fx.selector())
        try:
            client.wait_output('READY')
            self.assertEqual(session.viewer_count(), 1)
            self.clock[0] += manager.pause_after + 1
            self.assertEqual(manager.reap_idle(), ([], []))  # an Agent tab viewer keeps it running
        finally:
            client.close()
        deadline = time.monotonic() + 10
        while session.viewer_count() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(session.viewer_count(), 0)
        # The agent printed output just now: no pause while that is under 120 s old.
        session.left_at = self.clock[0] - manager.pause_after - 1
        session.agent.pty.last_output = time.monotonic()
        self.assertEqual(manager.reap_idle(), ([], []))
        self.assertFalse(session.paused)
        session.agent.pty.last_output = time.monotonic() - ra.PAUSE_HOLD - 1
        paused, _ = manager.reap_idle()
        self.assertEqual(paused, [session])
        # Attaching the Agent tab resumes the same process.
        pid = session.agent.pty.proc.pid
        client = self.ws(fx.selector())
        try:
            client.pump_until(lambda c: any(m.get('type') == 'hello' for m in c.controls))
            self.assertEqual([m for m in client.controls if m['type'] == 'hello'][0]['event'], 'resumed')
            client.send_json({'t': 'in', 'd': 'after resume\r'})
            client.wait_output('ECHO after resume')
            self.assertEqual(session.agent.pty.proc.pid, pid)
        finally:
            client.close()

    def test_review_r1_start_resets_the_removal_clock(self):
        manager = self.server.manager
        client = self.ws(fx.selector(), kind='shell')  # a shell viewer that left long ago
        client.pump_until(lambda c: any(m.get('type') == 'hello' for m in c.controls))
        client.close()
        session = manager.get(fx.selector())
        deadline = time.monotonic() + 10
        while session.viewer_count() and time.monotonic() < deadline:
            time.sleep(0.05)
        session.left_at = self.clock[0] - manager.remove_after + 60  # one minute before removal
        self.assertEqual(self.start()[0], 200)
        self.clock[0] += 120
        session.agent.pty.last_output = time.monotonic() - 1000
        _, removed = manager.reap_idle()
        self.assertEqual(removed, [])
        self.assertEqual(self.session_state()['state'] in ('working', 'waiting'), True)

    def test_review_r4_unexpected_errors_answer_500(self):
        original = self.hub._launch

        def broken(*args, **kwargs):
            raise __import__('subprocess').TimeoutExpired(['docker'], 60)
        self.hub._launch = broken
        try:
            status, payload = self.start()
        finally:
            self.hub._launch = original
        self.assertEqual((status, payload['error']), (500, 'agent_failed'))
        self.assertEqual(self.session_state()['state'], 'none')

    def test_review_r9_eviction_skips_a_working_agent(self):
        self.assertEqual(self.start()[0], 200)
        manager = self.server.manager
        session = manager.get(fx.selector())
        deadline = time.monotonic() + 10
        while session.viewer_count() and time.monotonic() < deadline:
            time.sleep(0.05)
        session.agent.pty.last_output = time.monotonic()
        with manager.lock:
            self.assertIsNot(manager._pick_victim_locked(), session)
        session.agent.pty.last_output = time.monotonic() - ra.PAUSE_HOLD - 1
        with manager.lock:
            candidates = [s for s in manager.sessions.values() if not s.viewer_count()]
            self.assertIn(session, candidates)

    def test_reset_and_removal_end_the_agent(self):
        self.assertEqual(self.start()[0], 200)
        manager = self.server.manager
        session = manager.get(fx.selector())
        proc = session.agent.pty.proc
        status, _ = self.request('POST', '/terminal/api/reset', {**fx.selector()})
        self.assertEqual(status, 200)
        proc.wait(timeout=10)
        self.assertEqual(self.session_state()['state'], 'none')
        self.assertEqual(self.start()[0], 200)
        session = manager.get(fx.selector())
        proc = session.agent.pty.proc
        session.agent.pty.last_output = time.monotonic() - 1000
        session.left_at = self.clock[0] - manager.remove_after - 1
        _, removed = manager.reap_idle()
        self.assertEqual(removed, [session])
        proc.wait(timeout=10)
        self.assertEqual(self.session_state()['state'], 'none')


class DisabledServiceTests(unittest.TestCase):
    def test_off_by_default(self):
        base = fx.tmp_base('agentoff')
        root = fx.make_root(base)
        server = ts.make_service(root, port=0, allowed_origins=[ORIGIN], state_dir=base / 'state',
                                 backend=sb.LocalBackend(base / 'local'), reap_interval=0, min_free_memory=0)
        try:
            self.assertFalse(server.report_agent.enabled)
            self.assertIsNone(server.manager.agent_hub)
            self.assertIsNone(server.manager.backend.agent_hub)
            status, payload = server.report_agent.handle_post(server.manager, '/api/agent/start',
                                                              {'selector': fx.selector(), 'task': {'kind': 'ask', 'text': 'x'}})
            self.assertEqual((status, payload['error']), (409, 'report_agent_disabled'))
            self.assertEqual(server.report_agent.handle_get(server.manager, '/api/agent/session', lambda: fx.selector())[1]['state'], 'none')
            self.assertFalse((base / 'state' / 'agent-settings.json').exists())
        finally:
            server.server_close()
            shutil.rmtree(base, ignore_errors=True)

    def test_cli_flags(self):
        base = fx.tmp_base('agentflags')
        try:
            root = base / 'root'
            root.mkdir()
            parse = lambda *extra: ts.build_agent_hubs(ts_args(root, base, *extra))
            with self.assertRaises(ValueError):
                parse('--report-agent-cli', 'claude=/x')  # needs --report-agent
            with self.assertRaises(ValueError):
                parse('--report-agent', '--report-agent-token-file', str(root / 'token'))
            link = base / 'tok-link'
            link.symlink_to(base / 'tok')
            with self.assertRaises(ValueError):
                parse('--report-agent', '--report-agent-token-file', str(link))
            with self.assertRaises(ValueError):
                parse('--agent-connect')
            with self.assertRaises(ValueError):
                parse('--agent-connect', '--herdr-session', 'bad name')
            hub, connect = parse('--report-agent', '--report-agent-cli', f'claude={FAKE_CLI}',
                                 '--report-agent-token-file', str(base / 'tok'))
            try:
                self.assertTrue(hub.enabled)
                self.assertIsNone(connect)
                self.assertEqual(hub.config_payload()['login']['reason'], 'missing')
            finally:
                hub.close()
        finally:
            shutil.rmtree(base, ignore_errors=True)


def ts_args(root, base, *extra):
    parser = __import__('argparse').ArgumentParser()
    parser.add_argument('--root', type=Path)
    parser.add_argument('--state-dir', type=Path)
    ts.agent_flags(parser)
    return parser.parse_args(['--root', str(root), '--state-dir', str(base / 'state'), *extra])


if __name__ == '__main__':
    unittest.main()
