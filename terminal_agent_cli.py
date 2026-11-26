"""CLI registry for the report agent: which coding CLIs exist and how each runs in a sandbox.

Each entry has a label, the host binary (``--report-agent-cli ID=PATH``,
resolved through symlinks on the host when a session starts), the model
choices, and a sandbox adapter. Only Claude Code has an adapter in this phase:
it talks to the model relay (``terminal_relay``), so the login never enters
the container. The others are listed with ``sandbox_ready: false`` and reason
``needs_sandbox_login``.

Adding Codex later is one ``CliSpec`` with an adapter (argv, env, HOME files)
plus its relay rule (``terminal_relay.RelayRule``: methods, paths, upstream
host, how the real credential is set).
"""
import json
import os
import re
import stat

import terminal_relay

BIN_DIR = '/opt/report-agent'          # host binaries are mounted read-only here, one file per CLI id
SKILLS_DIR = '/opt/report-agent/skills'  # skill directories, read-only; HOME links to them
SANDBOX_HOME = '/home/sandbox'
AGENT_DIR = SANDBOX_HOME + '/.report-agent'
TASK_FILE = AGENT_DIR + '/task.md'
PID_FILE = AGENT_DIR + '/agent.pid'
RELAY_PORT = 3129
INITIAL_PROMPT = f'Read {TASK_FILE} and follow it.'
# Never a real credential. The relay drops it and sets the real login on the host.
DUMMY_OAUTH_TOKEN = 'sk-ant-oat01-report-agent-relay-placeholder-not-a-credential'

MODEL_RE = re.compile(r'[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?')
CLI_ID_RE = re.compile(r'[a-z][a-z0-9-]{0,30}')
SKILL_NAME_RE = re.compile(r'[a-z0-9][a-z0-9-]{0,63}')

# Offline checks the agent may run without asking (Claude Code permission rules).
CLAUDE_OFFLINE_ALLOW = [
    'Read(//home/sandbox/.report-agent/**)',
    'Bash(python3 -m py_compile:*)',
    'Bash(python3 poc.py --help)',
    'Bash(python3 ./poc.py --help)',
    'Bash(node --check:*)',
    'Bash(bash -n:*)',
    'Bash(sh -n:*)',
]


class CliError(ValueError):
    pass


class ClaudeAdapter:
    """Claude Code in a report sandbox, talking to the model relay."""
    rule = terminal_relay.CLAUDE_RULE

    def argv(self, binary, model):
        args = [binary]
        if model != 'default':
            args += ['--model', model]
        return args + [INITIAL_PROMPT]

    def env(self):
        return {
            'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{RELAY_PORT}',
            'CLAUDE_CODE_OAUTH_TOKEN': DUMMY_OAUTH_TOKEN,
            'DISABLE_AUTOUPDATER': '1',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
            'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1',
            'DISABLE_TELEMETRY': '1',
            'DISABLE_ERROR_REPORTING': '1',
        }

    def home_files(self, skills, version=None):
        """Files for the tmpfs HOME: {relative path: bytes} and {relative path: symlink target}.

        Keys discovered with Claude Code 2.1.331 against a fake upstream (see
        docs/integrations/report-agent.md, Evidence): onboarding done, /report
        trusted, the auto-mode offer seen, no marketplace auto-install (it
        would fetch from downloads.claude.ai). acceptEdits, allow rules only
        for offline checks, auto mode and bypass mode disabled, so every
        other tool call asks in the Agent tab.
        """
        state = {
            'hasCompletedOnboarding': True,
            'hasSeenAutoDefaultNudge': True,
            'theme': 'dark',
            'autoUpdates': False,
            'officialMarketplaceAutoInstallAttempted': True,
            'officialMarketplaceAutoInstalled': False,
            'officialMarketplaceAutoInstallFailReason': 'policy_blocked',
            'projects': {'/report': {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True,
                                     'allowedTools': []}},
        }
        if version:
            state['lastOnboardingVersion'] = version
        settings = {
            'permissions': {
                'defaultMode': 'acceptEdits',
                'additionalDirectories': [AGENT_DIR],
                'allow': list(CLAUDE_OFFLINE_ALLOW),
                'disableAutoMode': 'disable',
                'disableBypassPermissionsMode': 'disable',
            },
            'env': {key: value for key, value in self.env().items() if key.startswith(('DISABLE_', 'CLAUDE_CODE_DISABLE'))},
        }
        files = {
            '.claude.json': json.dumps(state, indent=2).encode() + b'\n',
            '.claude/settings.json': json.dumps(settings, indent=2).encode() + b'\n',
        }
        # Docker would create a bind target's parents root-owned inside the tmpfs
        # HOME, and Claude Code must write ~/.claude, so skills are mounted under
        # SKILLS_DIR and linked from ~/.claude/skills (Claude Code follows the links).
        links = {f'.claude/skills/{name}': f'{SKILLS_DIR}/{name}' for name in sorted(skills)}
        return files, links


class CliSpec:
    def __init__(self, cli_id, label, models, *, default_model='default', custom_models=False, adapter=None,
                 reason=None):
        self.id, self.label = cli_id, label
        self.models = tuple(models)
        self.default_model = default_model
        self.custom_models = custom_models
        self.adapter = adapter
        self.reason = reason if adapter is None else None

    @property
    def sandbox_ready(self):
        return self.adapter is not None

    def valid_model(self, model):
        if not isinstance(model, str):
            return False
        return model in self.models or (self.custom_models and MODEL_RE.fullmatch(model) is not None)


REGISTRY = {spec.id: spec for spec in (
    CliSpec('claude', 'Claude Code', ('default', 'opus', 'sonnet', 'haiku'), custom_models=True,
            adapter=ClaudeAdapter()),
    CliSpec('codex', 'Codex', ('default',), reason='needs_sandbox_login'),
    CliSpec('omp', 'OMP', ('default',), reason='needs_sandbox_login'),
    CliSpec('opencode', 'OpenCode', ('default',), reason='needs_sandbox_login'),
)}
DEFAULT_CLI = 'claude'


def parse_pair(value, what, name_re):
    """'NAME=PATH' from a repeatable flag."""
    name, sep, path = value.partition('=')
    if not sep or not name_re.fullmatch(name) or not path or not os.path.isabs(path):
        raise CliError(f'{what} must look like NAME=/absolute/path: {value}')
    return name, path


def parse_cli_flags(values):
    """``--report-agent-cli ID=PATH`` values -> {id: path}; ids must be in REGISTRY."""
    out = {}
    for value in values:
        cli_id, path = parse_pair(value, '--report-agent-cli', CLI_ID_RE)
        if cli_id not in REGISTRY:
            raise CliError(f'unknown CLI id {cli_id!r} (known: {", ".join(sorted(REGISTRY))})')
        if cli_id in out:
            raise CliError(f'--report-agent-cli {cli_id} given twice')
        out[cli_id] = path
    return out


def parse_skill_flags(values):
    """``--report-agent-skill NAME=PATH`` -> {name: path}. Symlinked skill directories are refused."""
    out = {}
    for value in values:
        name, path = parse_pair(value, '--report-agent-skill', SKILL_NAME_RE)
        if name in out:
            raise CliError(f'--report-agent-skill {name} given twice')
        check_skill_dir(path)
        if re.search(r'[,"\x00-\x1f]', path):
            raise CliError(f'skill path cannot contain a comma, quote or control character: {name}')
        out[name] = path
    return out


def check_skill_dir(path):
    try:
        info = os.lstat(path)
    except OSError as error:
        raise CliError(f'skill directory {path}: {error.strerror}') from None
    if stat.S_ISLNK(info.st_mode):
        raise CliError(f'skill directory {path} is a symlink (refused)')
    if not stat.S_ISDIR(info.st_mode):
        raise CliError(f'skill directory {path} is not a directory')
    return info


def resolve_binary(path):
    """Resolve symlinks on the host; the result must be an executable regular file
    whose path Docker's --mount syntax can carry. Returns the real path or raises CliError."""
    if not path:
        raise CliError('not configured')
    real = os.path.realpath(path)
    try:
        info = os.stat(real)
    except OSError:
        raise CliError('binary not found') from None
    if not stat.S_ISREG(info.st_mode) or not os.access(real, os.X_OK):
        raise CliError('binary is not an executable file')
    if re.search(r'[,"\x00-\x1f]', real):
        raise CliError('binary path contains a comma, quote or control character')
    return real
