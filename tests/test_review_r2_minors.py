"""Review r2 minors (repros/r2): N1 frontmatter rewrite, N2 agent pid identity, N3 config deny rules.

N1: the stripped skill copy keeps only name and description, whatever YAML spelling declares
allowed-tools (quoted or explicit keys, a BOM, an indented --- inside a block scalar).
N2: stop never signals pid 1 or a pid that is no longer the agent CLI.
N3: the managed policy denies edits to the agent's own Claude Code config in HOME.
"""
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_agent_cli as cli  # noqa: E402
import terminal_report_agent as ra  # noqa: E402

DECLARES = {
    'double-quoted key': '---\nname: q\ndescription: d\n"allowed-tools": [Bash]\n---\nBody\n',
    'single-quoted key': "---\nname: q\ndescription: d\n'allowed-tools': [Bash]\n---\nBody\n",
    'indented --- inside a block scalar': '---\nname: q\ndescription: |\n  text\n  ---\nallowed-tools: [Bash]\n---\nBody\n',
    'UTF-8 BOM before the marker': '\ufeff---\nname: q\ndescription: d\nallowed-tools: [Bash]\n---\nBody\n',
    'explicit key': '---\nname: q\ndescription: d\n? allowed-tools\n: [Bash]\n---\nBody\n',
    'hooks and mcp servers': '---\nname: q\nhooks:\n  PreToolUse: []\nmcpServers: {e: {command: sh}}\ndescription: d\n---\nBody\n',
}


def frontmatter_lines(text):
    lines = text.split('\n')
    assert lines[0] == '---', text
    end = lines.index('---', 1)
    return lines[1:end]


class FrontmatterRewriteTests(unittest.TestCase):
    def test_only_name_and_description_survive(self):
        for label, text in DECLARES.items():
            with self.subTest(label):
                out = cli.strip_frontmatter(text)
                keys = [line.split(':', 1)[0] for line in frontmatter_lines(out)]
                self.assertTrue(set(keys) <= {'name', 'description'}, f'{label}: {out!r}')
                self.assertNotIn('allowed-tools', out.split('---\n', 2)[1])
                self.assertTrue(out.endswith('Body\n'))
                self.assertFalse(out.startswith('\ufeff'))

    def test_values_are_kept_and_quoted(self):
        out = cli.strip_frontmatter('---\nname: wide\ndescription: "Use for: reports, \\"triage\\"."\nversion: 2\n---\n# Body\n')
        self.assertEqual(out, '---\nname: "wide"\ndescription: "Use for: reports, \\"triage\\"."\n---\n# Body\n')
        out = cli.strip_frontmatter("---\nname: 'it''s'\ndescription: >\n  folded\n  text\n---\nB\n")
        self.assertEqual(out, '---\nname: "it\'s"\ndescription: "folded text"\n---\nB\n')

    def test_real_skill_header_shapes(self):
        out = cli.strip_frontmatter('---\nname: bunny-report-and-triage\ndescription: "Use for reports, triage, program '
                                    'follow-ups, or comments."\nargument-hint: "<x>"\nallowed-tools: [Read, Glob, Grep, '
                                    'Bash, Write, Edit, Agent, WebFetch, WebSearch]\n---\n\n# Title\n')
        self.assertEqual(out, '---\nname: "bunny-report-and-triage"\ndescription: "Use for reports, triage, program '
                              'follow-ups, or comments."\n---\n\n# Title\n')

    def test_unparseable_frontmatter_is_refused(self):
        for text in ('---\nallowed-tools: x\nno end', '---\nname: a\nname: b\n---\n', '---\nname: "open\n---\n',
                     "---\ndescription: 'open\n---\n"):
            with self.subTest(text=text), self.assertRaises(cli.CliError):
                cli.strip_frontmatter(text)

    def test_no_frontmatter_is_left_alone(self):
        self.assertEqual(cli.strip_frontmatter('no frontmatter\nallowed-tools: x\n'), 'no frontmatter\nallowed-tools: x\n')


class _ShellBackend:
    """Runs the ``docker exec <name> <argv...>`` argv locally, so the real identity script runs."""
    docker = 'docker'

    def __init__(self, pid_text=None):
        self.pid_text = pid_text

    def name(self, session):
        return 'bbterm-test-fake'

    def run(self, *args, check=False, timeout=None):
        argv = list(args[2:])
        if argv[:1] == ['cat']:
            return types.SimpleNamespace(returncode=0, stdout=(self.pid_text or '').encode(), stderr=b'')
        result = subprocess.run(argv, capture_output=True, timeout=timeout)
        return types.SimpleNamespace(returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)


class AgentPidTests(unittest.TestCase):
    def test_pid_one_is_refused(self):
        self.assertIsNone(ra.DockerExec(_ShellBackend('1\n')).read_pid(object(), object(), wait=0.5))
        self.assertEqual(ra.DockerExec(_ShellBackend('2\n')).read_pid(object(), object(), wait=0.5), 2)
        self.assertEqual(ra.DockerExec(_ShellBackend('4242\n')).read_pid(object(), object(), wait=0.5), 4242)

    def test_alive_requires_the_agent_binary(self):
        orig = cli.BIN_DIR
        with tempfile.TemporaryDirectory() as tmp:
            cli.BIN_DIR = tmp
            try:
                script = Path(tmp) / 'claude'
                script.write_text('import time\ntime.sleep(30)\n')
                agent = subprocess.Popen([sys.executable, str(script)])
                other = subprocess.Popen(['sleep', '30'])
                try:
                    executor = ra.DockerExec(_ShellBackend())
                    self.assertTrue(executor.alive(object(), object(), agent.pid))
                    self.assertFalse(executor.alive(object(), object(), other.pid), 'a reused pid must not count as the agent')
                finally:
                    for proc in (agent, other):
                        proc.kill()
                        proc.wait()
                self.assertFalse(executor.alive(object(), object(), agent.pid))
            finally:
                cli.BIN_DIR = orig


class ConfigDenyTests(unittest.TestCase):
    def test_managed_policy_denies_edits_to_the_agents_own_config(self):
        deny = cli.ClaudeAdapter().managed_settings()['permissions']['deny']
        self.assertIn('Edit(//home/sandbox/.claude/**)', deny)
        self.assertIn('Edit(//home/sandbox/.claude.json)', deny)


if __name__ == '__main__':
    unittest.main()
