"""Agent connect: attach the Board to an agent already running in Herdr on Hoster.

No sandbox. ``GET /api/agents/active`` lists Herdr agents (``herdr --session S
agent list``) whose working directory is inside the report's lane or program
folder; the WebSocket ``kind=connect`` runs ``herdr --session S agent attach
<pane>`` (argv list, no shell, never ``--takeover``) in a host PTY owned by
the service and fans it out to viewers like a shell session.

This is host access through the agent's TUI: whoever is signed in to the
terminal can type into that agent, and the agent runs with the host user's
rights. That is why it is off by default (``--agent-connect``), uses the same
auth, Origin and CSRF rules as the shell, and is capped at 4 sessions.

Herdr pane ids are session-local and can be reused after a pane closes, so an
attach re-runs ``agent list`` and requires the pane to still carry the same
``terminal_id`` and agent session value. Closing the last viewer ends only the
attach client after a short grace (SIGHUP, then SIGTERM, to the process group
the service spawned); the agent's own process is never signalled.

Every string from Herdr is display-escaped (control, bidi and invisible
characters become ``\\xNN``/``\\uNNNN``) and items carry ``unsafe_chars`` when
the raw value had any.
"""
import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

import report_artifacts as ra
import terminal_pty
import terminal_sandbox as sb

MAX_SESSIONS = 4
LIST_TIMEOUT = 10
LIST_MAX = 2 * 1024 * 1024
GRACE = 5               # seconds after the last viewer leaves before the attach client ends
PANE_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}')
TERMINAL_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
REF_RE = re.compile(r'[^\x00-\x1f\x7f]{1,1024}')
SESSION_NAME_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}')
STATUS_ORDER = {'working': 0, 'blocked': 1, 'idle': 2, 'done': 3}
TEXT_LIMIT = 300
# Same sets as recon_intel (UNSAFE_CHARS for the flag, DISPLAY_ESCAPE for display).
UNSAFE_CHARS = re.compile('[\x00-\x1f\x7f-\x9f­؜​-‏‪-‮⁠-⁩  ﻿]')
DISPLAY_ESCAPE = re.compile('[\x00-\x1f\x7f-\x9f­؜​‎‏‪-‮⁠-⁩  ﻿]')


class ConnectError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message

    def payload(self):
        return {'error': self.code, 'message': self.message}


def escape(value):
    if value is None:
        return None
    value = str(value)
    value = DISPLAY_ESCAPE.sub(lambda m: f'\\x{ord(m.group()):02x}' if ord(m.group()) < 0x100 else f'\\u{ord(m.group()):04x}', value)
    return value if len(value) <= TEXT_LIMIT else value[:TEXT_LIMIT - 1] + '…'


def unsafe(*values):
    return any(isinstance(v, str) and UNSAFE_CHARS.search(v) for v in values)


def inside(path, base):
    """True when ``path`` is ``base`` or below it, on a separator boundary (never a string prefix)."""
    return path == base or path.startswith(base.rstrip('/') + '/')


def _str(value):
    return value if isinstance(value, str) else None


class Herdr:
    """The subset of the Herdr CLI used here. ``binary`` and ``session`` come from flags."""

    def __init__(self, binary, session, env=None):
        self.binary, self.session = str(binary), session
        self.env = env

    def list_agents(self):
        try:
            result = subprocess.run([self.binary, '--session', self.session, 'agent', 'list'], capture_output=True,
                                    timeout=LIST_TIMEOUT, env=self.env, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            raise ConnectError(502, 'herdr_failed', 'Herdr did not answer. Is the Herdr server running?') from None
        if result.returncode != 0 or len(result.stdout) > LIST_MAX:
            raise ConnectError(502, 'herdr_failed', 'Herdr could not list the agents.')
        try:
            data = json.loads(result.stdout.decode('utf-8'))
            agents = data['result']['agents']
        except (ValueError, UnicodeError, KeyError, TypeError):
            raise ConnectError(502, 'herdr_failed', 'Herdr returned something unexpected.') from None
        if not isinstance(agents, list):
            raise ConnectError(502, 'herdr_failed', 'Herdr returned something unexpected.')
        return [a for a in agents if isinstance(a, dict)]

    def attach_argv(self, pane):
        return [self.binary, '--session', self.session, 'agent', 'attach', pane]  # never --takeover


def session_ref(agent):
    ref = agent.get('agent_session')
    return _str(ref.get('value')) if isinstance(ref, dict) else None


class ConnectSession:
    """One attach client in a host PTY, shared by every viewer of that agent."""

    def __init__(self, hub, key, pane, terminal_id, ref):
        self.hub = hub
        self.key = key
        self.pane, self.terminal_id, self.ref = pane, terminal_id, ref
        self.pty = None
        self.closed = False
        self.grace_timer = None
        self.lock = threading.Lock()


class ConnectHub:
    def __init__(self, *, enabled, root, herdr=None, max_sessions=MAX_SESSIONS, grace=GRACE, pty_env=None,
                 clock=time.monotonic):
        self.enabled = bool(enabled)
        self.root = os.path.realpath(str(root))
        self.herdr = herdr
        self.max_sessions = max_sessions
        self.grace = grace
        self.pty_env = pty_env
        self.clock = clock
        self.lock = threading.Lock()
        self.sessions = {}

    # -- listing -----------------------------------------------------------------------
    def _relative(self, path):
        real = os.path.realpath(path)
        return os.path.relpath(real, self.root) if inside(real, self.root) else None

    def items(self, lane=None, program=None):
        agents = self.herdr.list_agents()
        out = []
        for agent in agents:
            cwd = _str(agent.get('foreground_cwd')) or _str(agent.get('cwd'))
            real = os.path.realpath(cwd) if cwd and os.path.isabs(cwd) and '\0' not in cwd else None
            match = None
            if real is not None and lane is not None and inside(real, lane):
                match = 'lane'
            elif real is not None and program is not None and inside(real, program):
                match = 'program'
            if lane is not None and match is None:
                continue
            raw = [_str(agent.get('pane_id')), _str(agent.get('terminal_id')), session_ref(agent), _str(agent.get('agent')),
                   _str(agent.get('agent_status')), cwd, _str(agent.get('terminal_title_stripped')) or _str(agent.get('terminal_title'))]
            seq = agent.get('state_change_seq')
            out.append({
                'pane_id': escape(raw[0]), 'terminal_id': escape(raw[1]), 'session_ref': escape(raw[2]),
                'agent': escape(raw[3]), 'status': escape(raw[4]),
                'cwd_relative': escape(self._relative(real)) if real is not None and self._relative(real) is not None else None,
                'title': escape(raw[6]), 'state_change_seq': seq if type(seq) is int else None, 'match': match,
                'unsafe_chars': unsafe(*raw),
                'connected': (raw[0], raw[1], raw[2]) in {(s.pane, s.terminal_id, s.ref) for s in self._live()},
            })
        out.sort(key=lambda item: (STATUS_ORDER.get(item['status'], 4), -(item['state_change_seq'] or 0)))
        return out

    def _live(self):
        with self.lock:
            return [s for s in self.sessions.values() if not s.closed]

    def active(self, query):
        """GET /api/agents/active?<selector> or ?all=1."""
        if not self.enabled:
            return {'enabled': False, 'agents': []}
        if query.get('all') == '1' and set(query) == {'all'}:
            return {'enabled': True, 'agents': self.items()}
        sel = sb.clean_selector(query)
        try:
            lane_fd = ra.open_lane(self.root, sel['family'], sel['program'], sel['lane'])
        except OSError:
            raise ConnectError(404, 'report_not_found', 'Report not found. It may have been moved or renamed.') from None
        os.close(lane_fd)
        program = os.path.join(self.root, sel['family'], sel['program'])
        lane = os.path.join(program, sel['lane'])
        return {'enabled': True, 'agents': self.items(lane=lane, program=program)}

    # -- attach ------------------------------------------------------------------------
    @staticmethod
    def check_params(query):
        pane, terminal_id, ref = query.get('pane'), query.get('terminal_id'), query.get('session_ref')
        if not (isinstance(pane, str) and PANE_RE.fullmatch(pane) and isinstance(terminal_id, str)
                and TERMINAL_RE.fullmatch(terminal_id) and isinstance(ref, str) and REF_RE.fullmatch(ref)):
            raise ConnectError(400, 'bad_agent', 'The agent reference is invalid.')
        return pane, terminal_id, ref

    def attach(self, query, viewer):
        if not self.enabled:
            raise ConnectError(409, 'agent_connect_disabled', 'Agent connect is off (start the terminal service with --agent-connect).')
        pane, terminal_id, ref = self.check_params(query)
        key = (pane, terminal_id, ref)
        with self.lock:
            current = self.sessions.get(key)
            if current is not None and not current.closed:
                return self._join(current, viewer)
        # Pane ids are reused after a pane closes: the pane must still be that agent.
        found = [a for a in self.herdr.list_agents() if a.get('pane_id') == pane]
        if not found or found[0].get('terminal_id') != terminal_id or session_ref(found[0]) != ref:
            raise ConnectError(409, 'agent_gone', 'That agent is no longer in that pane. Refresh the list.')
        with self.lock:
            current = self.sessions.get(key)
            if current is not None and not current.closed:
                return self._join(current, viewer)
            if len([s for s in self.sessions.values() if not s.closed]) >= self.max_sessions:
                raise ConnectError(503, 'too_many_connections', f'{self.max_sessions} agents are already connected. '
                                   'Close one and try again.')
            cs = ConnectSession(self, key, pane, terminal_id, ref)
            cs.pty = terminal_pty.PtyFanout(self.herdr.attach_argv(pane), env=self.pty_env, cwd=None, clock=self.clock,
                                            on_exit=lambda code, cs=cs: self._ended(cs, code), name='bbterm-connect',
                                            exit_note=lambda code: self._exit_note(code))
            try:
                cs.pty.start()
            except OSError:
                raise ConnectError(502, 'attach_failed', 'Herdr attach could not start.') from None
            self.sessions[key] = cs
            return self._join(cs, viewer)

    @staticmethod
    def _exit_note(code):
        if code == 0:
            return b'\r\n[Detached from the agent.]\r\n'
        return (f'\r\n[Herdr attach ended ({code}). Someone else may be attached, or the pane closed. '
                f'Refresh the list and try again.]\r\n').encode()

    def _join(self, cs, viewer):
        with cs.lock:
            if cs.grace_timer is not None:
                cs.grace_timer.cancel()
                cs.grace_timer = None
        cs.pty.attach(viewer, {'type': 'hello', 'kind': 'connect', 'event': 'attached',
                               'agent': {'pane_id': escape(cs.pane), 'terminal_id': escape(cs.terminal_id)}})
        return ConnectTarget(self, cs, viewer)

    def _ended(self, cs, code):
        with self.lock:
            cs.closed = True
            if self.sessions.get(cs.key) is cs:
                del self.sessions[cs.key]

    def detach(self, cs, viewer):
        left = cs.pty.detach(viewer)
        if left:
            return
        with cs.lock:
            if cs.grace_timer is not None:
                cs.grace_timer.cancel()
            cs.grace_timer = threading.Timer(self.grace, self._grace_over, args=(cs,))
            cs.grace_timer.daemon = True
            cs.grace_timer.start()

    def _grace_over(self, cs):
        with cs.lock:
            cs.grace_timer = None
        if cs.pty.viewers:
            return
        self._end(cs)

    def _end(self, cs):
        """End only the attach client the service spawned (its own process group)."""
        with self.lock:
            cs.closed = True
            if self.sessions.get(cs.key) is cs:
                del self.sessions[cs.key]
        cs.pty.stop(signals=(signal.SIGHUP, signal.SIGTERM), grace=2.0)

    def close(self):
        with self.lock:
            sessions = list(self.sessions.values())
        for cs in sessions:
            with cs.lock:
                if cs.grace_timer is not None:
                    cs.grace_timer.cancel()
            cs.pty.close_viewers('The terminal service stopped.')
            self._end(cs)

    # -- routes -----------------------------------------------------------------------
    def handle_get(self, path, query):
        if path != '/api/agents/active':
            return None
        try:
            return 200, self.active(query)
        except ConnectError as error:
            return error.status, error.payload()
        except sb.SandboxError as error:
            return 400, {'error': error.code, 'message': error.message}


class ConnectTarget:
    def __init__(self, hub, cs, viewer):
        self.hub, self.cs, self.viewer = hub, cs, viewer

    def alive(self):
        return not self.cs.closed and self.cs.pty.running

    def write(self, data):
        self.cs.pty.write(data)

    def resize(self, cols, rows):
        self.cs.pty.resize(cols, rows)

    def detach(self):
        self.hub.detach(self.cs, self.viewer)


def default_herdr_bin():
    return str(Path.home() / '.local/bin/herdr')
