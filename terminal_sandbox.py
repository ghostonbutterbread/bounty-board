"""Sandbox sessions for the terminal service: one shell per report.

A session is keyed by the report selector (family, program, lane, report
path). It owns a container (DockerBackend) and one PTY running ``docker exec
-it`` into it, so closing a browser tab never kills the shell. Every attached
viewer (phone, PC, several tabs) gets the same output; input from any of them
goes to the same shell; a new viewer first receives the recent scrollback.

The report's real folder (see ``resolve_mount``) is bind-mounted read-write at
``/report`` and the shell starts there, so a PoC edited by an agent on the host
is visible immediately and a fix made in the terminal lands in the real folder.
Nothing else from the data root is mounted. The container runs as the host
user's UID/GID so files it creates sync and stay editable. ``save_evidence``
is written by the service itself, never by the container.

``LocalBackend`` runs a plain local bash directly in the folder. It is NOT a
sandbox and exists for tests only; the service refuses it unless the data root
is under TMPDIR and the test environment variable is set.
"""
import bisect
import collections
import fcntl
import json
import os
import re
import secrets
import shutil
import stat
import struct
import subprocess
import sys
import termios
import threading
import time
from pathlib import Path

import report_artifacts as ra

SCROLLBACK_BYTES = 256 * 1024
TRANSCRIPT_BYTES = 2 * 1024 * 1024
EVIDENCE_BYTES = 1024 * 1024
LABEL = 'org.bountyboard.terminal'
MOUNT_TARGET = '/report'
PROXY_PORT = 3128

TRAMPOLINE = ('import fcntl, os, sys, termios\n'
              'fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n'
              'os.execvp(sys.argv[1], sys.argv[1:])\n')


class SandboxVanished(Exception):
    """The container no longer exists (removed outside the service)."""


class SandboxError(Exception):
    """Reported to the user; ``code`` is a short machine string."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# -- selectors and folders ------------------------------------------------------

def clean_selector(raw):
    """Validate a report selector dict; raise SandboxError('bad_selector')."""
    keys = ('family', 'program', 'lane', 'path')
    if not isinstance(raw, dict) or any(not isinstance(raw.get(k), str) for k in keys):
        raise SandboxError('bad_selector', 'Report selector is missing.')
    sel = {k: raw[k] for k in keys}
    for key in ('family', 'program', 'lane'):
        value = sel[key]
        if not value or len(value) > 200 or value in ('.', '..') or '/' in value or '\\' in value or '\0' in value:
            raise SandboxError('bad_selector', 'Report selector is invalid.')
    path = sel['path']
    try:
        parts = ra._clean_parts(path)
    except ra.ArtifactError:
        raise SandboxError('bad_selector', 'Report path is invalid.') from None
    if len(path) > 1000 or not parts[-1].lower().endswith('.md'):
        raise SandboxError('bad_selector', 'Report path is invalid.')
    return sel


def session_key(sel):
    return json.dumps([sel['family'], sel['program'], sel['lane'], sel['path']])


PACKET_SLUG = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
NOT_IN_PACKET = 'This report is not inside a finding folder (reports/<FID>-…/).'


def packet_fid(name, fids):
    """The ledger FID whose packet folder ``name`` is, or None.

    Exact-FID rule (BBH report packets): the folder name is the FID itself or
    the FID, '-', and a lowercase slug ([a-z0-9]+ joined by single '-'). FIDs
    are compared verbatim (case and punctuation). When several FIDs match (an
    FID that itself contains '-', for example AC and AC-1), the longest wins.
    ``D10-xss`` never belongs to D1, and ``D1-Bad`` or ``d1-x`` match nothing.
    """
    matches = [fid for fid in fids if name == fid or (name.startswith(fid + '-') and PACKET_SLUG.fullmatch(name[len(fid) + 1:]))]
    return max(matches, key=len) if matches else None


def _ledger_findings(lane_fd):
    try:
        ledger = json.loads(ra._read_small(lane_fd, 'ledgers/ledger.json'))
    except (ra.ArtifactError, ValueError, UnicodeError):
        return []
    if not isinstance(ledger, dict) or not isinstance(ledger.get('findings'), list):
        return []
    return [f for f in ledger['findings'] if isinstance(f, dict) and isinstance(f.get('fid'), str)
            and f['fid'] and '/' not in f['fid'] and f['fid'] not in ('.', '..')]


def resolve_mount(root, sel):
    """Return the Mount for the report's finding packet folder, or raise.

    1. A report inside a packet folder ``reports/<FID>[-slug]/...`` (FID from
       the lane ledger, exact-FID rule above) mounts that packet folder.
    2. A report elsewhere (legacy ``reports/findings/<bucket>/<FID> - title.md``,
       a file directly in ``reports/``) that maps to a ledger finding, by its
       ``report_path``/``evidence_path`` or by an exact ``<FID> - `` /
       ``<FID>.md`` file name, mounts that finding's packet: the ledger
       ``report_dir`` when it is a packet folder for that FID directly under
       ``reports/``, else the legacy ``reports/<FID>/``, if it exists.
    3. Anything else (generated navigation, unmapped files) is refused with
       ``not_in_packet``. Folders are never created; ``reports/`` and the lane
       are never mounted.

    Every component from the data root down is opened with O_NOFOLLOW.
    """
    root = str(root)
    try:
        lane_fd = ra.open_lane(root, sel['family'], sel['program'], sel['lane'])
    except OSError:
        raise SandboxError('report_not_found', 'Report not found. It may have been moved or renamed.') from None
    try:
        report_rel = 'reports/' + '/'.join(ra._clean_parts(sel['path']))
        try:
            fd, _ = ra.open_file(lane_fd, report_rel)
            os.close(fd)
        except ra.ArtifactError:
            raise SandboxError('report_not_found', 'Report not found. It may have been moved or renamed.') from None
        findings = _ledger_findings(lane_fd)
        fids = [f['fid'] for f in findings]
        parts = report_rel.split('/')
        folder = fid = rule = None
        if len(parts) >= 3:
            fid = packet_fid(parts[1], fids)
            if fid:
                folder, rule = f'reports/{parts[1]}', 'packet'
        if folder is None:
            rel = lambda value: ra.recorded_relative(value, sel['family'], sel['program'], sel['lane'])
            owners = [f for f in findings if report_rel in (rel(f.get('report_path')), rel(f.get('evidence_path')))]
            if not owners:
                name = parts[-1]
                named = [f for f in findings if name == f'{f["fid"]}.md' or name.startswith(f'{f["fid"]} - ')]
                owners = sorted(named, key=lambda f: len(f['fid']), reverse=True)[:1]
            for finding in owners:
                report_dir = rel(finding.get('report_dir'))
                if report_dir:
                    pieces = report_dir.split('/')
                    candidate = report_dir if (len(pieces) == 2 and pieces[0] == 'reports'
                                               and packet_fid(pieces[1], [finding['fid']])) else None
                else:
                    candidate = f'reports/{finding["fid"]}'
                if candidate and ra._kind_at(lane_fd, candidate) == 'dir':
                    folder, fid, rule = candidate, finding['fid'], 'ledger'
                    break
        if folder is None:
            raise SandboxError('not_in_packet', NOT_IN_PACKET)
        if re.search(r'[,"\x00-\x1f]', folder) or folder.split('/')[1].startswith(('.', '_')):
            raise SandboxError('unsafe_folder', 'The finding folder name cannot be mounted (comma, quote or control character).')
        try:
            dir_fd = ra._open_dir(lane_fd, folder.split('/'))
        except OSError:
            raise SandboxError('unsafe_folder', 'The finding folder is missing or a symlink.') from None
        try:
            info = os.fstat(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        os.close(lane_fd)
    path = os.path.join(root, sel['family'], sel['program'], sel['lane'], *folder.split('/'))
    if re.search(r'[,"\x00-\x1f]', path):
        # Docker's --mount value is comma separated; never let a path add options.
        raise SandboxError('unsafe_folder', 'The finding folder path contains a comma or control character, which the sandbox cannot mount.')
    reason = 'finding folder' if rule == 'packet' else f'finding folder of {fid} (from the ledger)'
    return Mount(folder, path, (info.st_dev, info.st_ino), reason, fid=fid, rule=rule)


class Mount:
    def __init__(self, folder, path, identity, reason, fid=None, rule=None):
        self.folder, self.path, self.identity, self.reason = folder, path, identity, reason
        self.fid, self.rule = fid, rule

    def still_valid(self):
        """The path still names the same directory, reached without symlinks."""
        try:
            info = os.stat(self.path)
            here = os.lstat(self.path)
        except OSError:
            return False
        return stat.S_ISDIR(here.st_mode) and (info.st_dev, info.st_ino) == self.identity == (here.st_dev, here.st_ino)


# -- transcripts and evidence -----------------------------------------------------

ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\'
                  r'|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_=>78]')


def clean_line(line):
    line = ANSI.sub('', line)
    if '\r' in line.rstrip('\r'):
        line = line.rstrip('\r').rsplit('\r', 1)[-1]
    out = []
    for ch in line:
        if ch == '\b':
            if out:
                out.pop()
        elif ch == '\t' or ch >= ' ' and ch != '\x7f':
            out.append(ch)
    return ''.join(out)


def render_transcript(chunks, *, title, started, truncated, limit=EVIDENCE_BYTES, now=None):
    """Plain-text transcript: ANSI stripped, each line stamped with its arrival time."""
    starts, texts, offset = [], [], 0
    decoder = __import__('codecs').getincrementaldecoder('utf-8')('replace')
    for at, data in chunks:
        text = decoder.decode(data)
        starts.append(offset)
        texts.append((at, text))
        offset += len(text)
    full = ''.join(t for _, t in texts)
    lines, pos = [], 0
    for raw in full.split('\n'):
        index = max(bisect.bisect_right(starts, pos) - 1, 0)
        at = texts[index][0] if texts else started
        cleaned = clean_line(raw)
        lines.append(f'[{time.strftime("%H:%M:%S", time.localtime(at))}] {cleaned}' if cleaned else '')
        pos += len(raw) + 1
    while lines and not lines[-1]:
        lines.pop()
    now = now or time.time()
    head = [f'# Sandbox terminal transcript: {title}',
            f'# Session started {time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(started))}',
            f'# Saved {time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(now))}',
            '# Output from the Bounty Board sandbox terminal; ANSI escapes removed.']
    body = '\n'.join(lines)
    data = body.encode('utf-8')
    if len(data) > limit or truncated:
        data = data[-limit:]
        body = data.decode('utf-8', 'ignore').split('\n', 1)[-1]
        head.append('# Earlier output was dropped to keep this file small.')
    return '\n'.join(head) + '\n\n' + body + '\n'


def save_evidence(root, sel, text, now=None):
    """Write ``text`` as a new file in the real report folder's validation/.

    Same path rules as report_artifacts: every directory is opened with
    O_NOFOLLOW from the root, the target folder must be inside the lane's
    reports/, and the file is created with O_EXCL (never overwritten).
    Returns the lane-relative path. Refuses when the Board root is read-only.
    """
    root = str(root)
    if not os.access(root, os.W_OK):
        raise SandboxError('root_not_writable', 'The Board data folder is read-only, so evidence cannot be saved.')
    folder = resolve_mount(root, sel).folder
    now = now or time.time()
    stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime(now))
    lane_fd = folder_fd = valid_fd = None
    try:
        lane_fd = ra.open_lane(root, sel['family'], sel['program'], sel['lane'])
        folder_fd = ra._open_dir(lane_fd, folder.split('/'))
        try:
            os.mkdir('validation', 0o755, dir_fd=folder_fd)
        except FileExistsError:
            pass
        valid_fd = os.open('validation', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=folder_fd)
        data = text.encode('utf-8')
        for attempt in range(1, 100):
            name = f'terminal-{stamp}.txt' if attempt == 1 else f'terminal-{stamp}-{attempt}.txt'
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=valid_fd)
            except FileExistsError:
                continue
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            return f'{folder}/validation/{name}'
        raise SandboxError('evidence_failed', 'Could not pick a new file name.')
    except OSError as error:
        if error.errno in (30, 13, 1):  # EROFS, EACCES, EPERM
            raise SandboxError('root_not_writable', 'The report folder is not writable, so evidence cannot be saved.') from None
        raise SandboxError('evidence_failed', 'Evidence could not be saved (the folder may have changed).') from None
    finally:
        for fd in (valid_fd, folder_fd, lane_fd):
            if fd is not None:
                os.close(fd)


# -- PTY ------------------------------------------------------------------------

def set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def spawn_pty(argv, *, cols=100, rows=30, cwd=None, env=None):
    """Start argv as a session leader with a new PTY as its controlling terminal."""
    master, slave = os.openpty()
    try:
        set_winsize(slave, cols, rows)
        proc = subprocess.Popen([sys.executable, '-I', '-c', TRAMPOLINE, *argv], stdin=slave, stdout=slave, stderr=slave,
                                start_new_session=True, close_fds=True, cwd=cwd, env=env)
    except BaseException:
        os.close(master)
        raise
    finally:
        os.close(slave)
    return proc, master


def stop_process(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, 1)  # SIGHUP: interactive bash ignores SIGTERM
    except OSError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            pass
        proc.wait(timeout=3)


# -- backends ---------------------------------------------------------------------

class DockerBackend:
    """One hardened container per session; the PTY runs ``docker exec -it``.

    The container gets: no network (egress only through the service's filtering
    proxy over a mounted Unix socket), all capabilities dropped,
    no-new-privileges, Docker's default seccomp and AppArmor profiles, a
    read-only root filesystem with tmpfs /tmp and HOME, pids/memory/CPU limits,
    the host user's UID/GID, and exactly two mounts: the report folder
    (read-write, at /report) and the per-session proxy socket directory
    (read-only). No Docker socket, no host network, nothing else from the host.
    """

    def __init__(self, *, image, state_dir, proxy, prefix='bbterm-', docker='docker', memory='1g', cpus='1.0',
                 pids=256, uid=None, gid=None, instance=None):
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,30}-', prefix):
            raise ValueError('container prefix must look like "bbterm-"')
        self.image, self.prefix, self.docker = image, prefix, docker
        self.memory, self.cpus, self.pids = memory, cpus, pids
        self.uid = os.getuid() if uid is None else uid
        self.gid = os.getgid() if gid is None else gid
        self.proxy = proxy
        self.sock_root = Path(state_dir) / 'proxy'
        self.sock_root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.sock_root, 0o711)
        self.instance = instance or secrets.token_hex(6)
        self.handles = {}

    def run(self, *args, timeout=60, check=True):
        result = subprocess.run([self.docker, *args], capture_output=True, timeout=timeout)
        if check and result.returncode != 0:
            raise SandboxError('sandbox_failed', 'The sandbox container could not be started: '
                               + result.stderr.decode('utf-8', 'replace').strip()[-300:])
        return result

    def name(self, session):
        return f'{self.prefix}{session.id}'

    def run_args(self, session, sock_dir):
        proxy = f'http://127.0.0.1:{PROXY_PORT}'
        socks = f'socks5h://127.0.0.1:{PROXY_PORT}'
        env = {'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'http_proxy': proxy, 'https_proxy': proxy,
               'ALL_PROXY': socks, 'all_proxy': socks,
               'NO_PROXY': 'localhost,127.0.0.1,::1', 'no_proxy': 'localhost,127.0.0.1,::1',
               'NODE_USE_ENV_PROXY': '1', 'TERM': 'xterm-256color', 'HOME': '/home/sandbox'}
        owner = f'uid={self.uid},gid={self.gid}'
        args = ['run', '-d', '--name', self.name(session),
                '--label', f'{LABEL}=1', '--label', f'{LABEL}.prefix={self.prefix}',
                '--label', f'{LABEL}.instance={self.instance}',
                '--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--user', f'{self.uid}:{self.gid}', '--hostname', 'sandbox',
                '--pids-limit', str(self.pids), '--memory', self.memory, '--memory-swap', self.memory,
                '--cpus', self.cpus, '--ulimit', 'nofile=4096:4096',
                '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
                '--tmpfs', f'/home/sandbox:rw,nosuid,nodev,size=128m,{owner},mode=0700',
                '--mount', f'type=bind,source={session.mount.path},target={MOUNT_TARGET}',
                '--mount', f'type=bind,source={sock_dir},target=/run/bbterm,readonly',
                '--workdir', MOUNT_TARGET]
        for key, value in env.items():
            args += ['--env', f'{key}={value}']
        return args + [self.image]

    def create(self, session):
        sock_dir = self.sock_root / session.id
        sock_dir.mkdir(mode=0o755)
        os.chmod(sock_dir, 0o755)
        # Bind through /proc/self/fd so a long state path never hits the
        # 108-byte AF_UNIX limit; the directory descriptor lives until destroy.
        dir_fd = os.open(sock_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            handle = self.proxy.listen_unix(f'/proc/self/fd/{dir_fd}/proxy.sock')
        except BaseException:
            os.close(dir_fd)
            shutil.rmtree(sock_dir, ignore_errors=True)
            raise
        self.handles[session.id] = (handle, dir_fd)
        try:
            self.run(*self.run_args(session, sock_dir))
            # Docker resolved the source path while we were not looking; make
            # sure it is still the directory we validated (no symlink swap).
            if not session.mount.still_valid():
                raise SandboxError('unsafe_folder', 'The report folder changed while the sandbox started. Try again.')
        except BaseException:
            self.destroy(session)
            raise

    def shell_argv(self, session):
        return [self.docker, 'exec', '-it', '-w', MOUNT_TARGET, self.name(session), 'bash', '-l']

    def shell_cwd(self, session):
        return None

    def shell_env(self):
        return None

    def destroy(self, session):
        self.run('rm', '-f', self.name(session), check=False, timeout=60)
        entry = self.handles.pop(session.id, None)
        if entry is not None:
            try:
                entry[0].close()
            finally:
                os.close(entry[1])
        shutil.rmtree(self.sock_root / session.id, ignore_errors=True)

    def _lifecycle(self, verb, session, done_marker):
        result = self.run(verb, self.name(session), check=False, timeout=30)
        if result.returncode == 0:
            return
        err = result.stderr.decode('utf-8', 'replace')
        if done_marker in err:
            return  # already in the wanted state: idempotent
        if 'No such container' in err or 'is not running' in err:
            raise SandboxVanished(err.strip()[-200:])
        raise SandboxError(f'{verb}_failed', err.strip()[-300:])

    def pause(self, session):
        self._lifecycle('pause', session, 'is already paused')

    def unpause(self, session):
        self._lifecycle('unpause', session, 'is not paused')

    def state(self, session):
        """'running', 'paused', another Docker status, or None when the container is gone."""
        result = self.run('inspect', '--format', '{{.State.Status}}', self.name(session), check=False, timeout=30)
        if result.returncode != 0:
            if b'No such' in result.stderr:
                return None
            raise SandboxError('inspect_failed', result.stderr.decode('utf-8', 'replace').strip()[-300:])
        return result.stdout.decode().strip()

    def reap_stale(self):
        """Remove containers left by an earlier run: name prefix AND label must match."""
        result = self.run('ps', '-a', '--filter', f'label={LABEL}=1', '--filter', f'label={LABEL}.prefix={self.prefix}',
                          '--format', '{{.Names}}', check=False)
        names = [n for n in result.stdout.decode().split() if n.startswith(self.prefix)]
        if names:
            self.run('rm', '-f', *names, check=False, timeout=120)
        for child in self.sock_root.iterdir():
            shutil.rmtree(child, ignore_errors=True)
        return names


class LocalBackend:
    """TEST ONLY: plain local bash started in the report folder. Not isolated in any way."""

    def __init__(self, base):
        self.base = Path(base)
        self.base.mkdir(parents=True, exist_ok=True)

    def create(self, session):
        pass

    def shell_argv(self, session):
        return ['bash', '--noprofile', '--norc', '-i']

    def shell_cwd(self, session):
        return session.mount.path

    def shell_env(self):
        return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(self.base), 'TERM': 'xterm-256color',
                'PS1': 'sandbox$ ', 'LANG': 'C.UTF-8'}

    def destroy(self, session):
        pass

    # Pause stands in for docker pause: stop/continue the shell's process group.
    def pause(self, session):
        if session.proc is not None:
            os.killpg(session.proc.pid, 19)  # SIGSTOP

    def unpause(self, session):
        if session.proc is not None:
            os.killpg(session.proc.pid, 18)  # SIGCONT

    def state(self, session):
        return 'paused' if session.paused else 'running'

    def reap_stale(self):
        return []


# -- sessions --------------------------------------------------------------------

class Session:
    def __init__(self, manager, sel):
        self.manager = manager
        self.sel = sel
        self.key = session_key(sel)
        self.id = secrets.token_hex(6)
        self.lock = threading.RLock()
        self.viewers = set()
        self.created = time.time()
        self.left_at = manager.clock()
        self.folder = None
        self.mount = None
        self.notes = []
        self.proc = None
        self.master = None
        self.started = False
        self.closed = False
        self.paused = False
        self.size = (100, 30)
        self.scrollback = bytearray()
        self.transcript = collections.deque()
        self.transcript_bytes = 0
        self.transcript_dropped = False
        self.generation = 0

    def info(self):
        return {'id': self.id, 'created': int(self.created), 'idle_timeout': self.manager.remove_after,
                'pause_after': self.manager.pause_after, 'remove_after': self.manager.remove_after,
                'folder': self.folder, 'workdir': MOUNT_TARGET if isinstance(self.manager.backend, DockerBackend) else self.folder,
                'mount_reason': self.mount.reason if self.mount else None,
                'mount_rule': self.mount.rule if self.mount else None, 'fid': self.mount.fid if self.mount else None,
                'viewers': len(self.viewers), 'notes': list(self.notes), 'running': self.proc is not None,
                'paused': self.paused}

    # Container lifecycle -- caller holds self.lock.
    def _start(self):
        root, backend = self.manager.root, self.manager.backend
        self.mount = resolve_mount(root, self.sel)
        self.folder = self.mount.folder
        self.notes = []
        backend.create(self)
        self.started = True
        self._spawn_shell()

    def _spawn_shell(self):
        backend = self.manager.backend
        env = backend.shell_env()
        self.proc, self.master = spawn_pty(backend.shell_argv(self), cols=self.size[0], rows=self.size[1],
                                           cwd=backend.shell_cwd(self), env=env)
        self.generation += 1
        threading.Thread(target=self._read_loop, args=(self.master, self.proc, self.generation),
                         name=f'bbterm-pty-{self.id}', daemon=True).start()

    def _stop_shell(self):
        proc, master = self.proc, self.master
        self.proc = self.master = None
        stop_process(proc)
        if master is not None:
            try:
                os.close(master)
            except OSError:
                pass

    def _destroy(self):
        self._stop_shell()
        if self.started:
            self.started = False
            try:
                self.manager.backend.destroy(self)
            except Exception:
                pass

    def _read_loop(self, master, proc, generation):
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                break
            self._output(data)
        with self.lock:
            if self.generation == generation and self.proc is proc:
                self._stop_shell()
                if not self.closed:
                    self._output(b'\r\n[Shell exited. Press Enter to start a new shell.]\r\n')
                    self._broadcast({'type': 'exit'})

    def _output(self, data):
        with self.lock:
            self.scrollback += data
            if len(self.scrollback) > self.manager.scrollback_bytes:
                del self.scrollback[:len(self.scrollback) - self.manager.scrollback_bytes]
            self.transcript.append((time.time(), bytes(data)))
            self.transcript_bytes += len(data)
            while self.transcript_bytes > self.manager.transcript_bytes and len(self.transcript) > 1:
                self.transcript_bytes -= len(self.transcript.popleft()[1])
                self.transcript_dropped = True
            for viewer in list(self.viewers):
                viewer.send_output(data)

    def _broadcast(self, message):
        for viewer in list(self.viewers):
            viewer.send_control(message)

    # Public operations.
    def write(self, data):
        with self.lock:
            if self.closed:
                return
            if self.proc is None:
                if self.started and (b'\r' in data or b'\n' in data):
                    self._spawn_shell()
                return
            master = self.master
        try:
            os.write(master, data)
        except OSError:
            pass

    def resize(self, cols, rows):
        with self.lock:
            self.size = (cols, rows)
            if self.master is not None:
                try:
                    set_winsize(self.master, cols, rows)
                except OSError:
                    pass

    def folder_moved(self):
        """'folder_moved' when the mounted folder is no longer where the report's folder is."""
        if self.mount is None:
            return None
        try:
            current = resolve_mount(self.manager.root, self.sel)
        except SandboxError:
            return 'folder_moved'
        if current.folder != self.mount.folder or not self.mount.still_valid():
            return 'folder_moved'
        return None

    def clear_output(self):
        self.scrollback = bytearray()
        self.transcript.clear()
        self.transcript_bytes = 0
        self.transcript_dropped = False

    def transcript_text(self):
        with self.lock:
            chunks = list(self.transcript)
            dropped = self.transcript_dropped
        title = f'{self.sel["program"]} / {self.sel["lane"]} / {self.sel["path"]}'
        return render_transcript(chunks, title=title, started=self.created, truncated=dropped)


class SessionManager:
    """Owns every report sandbox and its lifecycle.

    running  -- at least one viewer, or no viewer for less than ``pause_after``
    paused   -- ``docker pause`` (processes frozen, memory kept) once no viewer
                has been attached for ``pause_after`` seconds
    removed  -- ``docker rm -f`` once no viewer has been attached for
                ``remove_after`` seconds (measured from when the last one left)

    Opening a paused report unpauses it and reattaches to the same shell and
    scrollback. Lock order is always session.lock, then manager.lock; the
    reaper re-checks every condition under session.lock, so a viewer that
    attaches while a pause is in flight waits for it and then unpauses.
    """

    def __init__(self, root, backend, *, max_sessions=12, pause_after=300, remove_after=4 * 3600,
                 min_free_memory=2 * 1024 ** 3, idle_timeout=None, scrollback_bytes=SCROLLBACK_BYTES,
                 transcript_bytes=TRANSCRIPT_BYTES, clock=time.monotonic, reap_interval=10,
                 mem_available=None, log=None):
        self.root = Path(root)
        self.backend = backend
        self.max_sessions = max_sessions
        self.remove_after = idle_timeout if idle_timeout is not None else remove_after
        self.pause_after = min(pause_after, self.remove_after)
        self.min_free_memory = min_free_memory
        self.mem_available = mem_available or read_mem_available
        self.log = log or (lambda message: print(f'bbterm: {message}', file=sys.stderr, flush=True))
        self.scrollback_bytes = scrollback_bytes
        self.transcript_bytes = transcript_bytes
        self.clock = clock
        self.sessions = {}
        self.removed_idle = collections.OrderedDict()  # key -> True, for the "removed after idle" notice
        self.lock = threading.Lock()
        self.closed = False
        self.stop_event = threading.Event()
        self.reaped_on_start = backend.reap_stale()
        if reap_interval:
            threading.Thread(target=self._reaper, args=(reap_interval,), name='bbterm-reaper', daemon=True).start()

    @property
    def idle_timeout(self):  # backward-compatible name for remove_after
        return self.remove_after

    def get(self, sel):
        with self.lock:
            return self.sessions.get(session_key(sel))

    # -- capacity and memory -----------------------------------------------------
    def _check_memory(self):
        if not self.min_free_memory:
            return
        free = self.mem_available()
        if free is not None and free < self.min_free_memory:
            raise SandboxError('low_memory', f'Hoster is low on memory ({free / 1024 ** 3:.1f} GB free); '
                               'close a terminal or try later.')

    def _pick_victim_locked(self):
        """Paused sandbox idle longest first, then a running viewerless one; never one with a viewer."""
        idle = [s for s in self.sessions.values() if not s.viewers]
        if not idle:
            return None
        return min(idle, key=lambda s: (not s.paused, s.left_at))

    # -- attach / detach -----------------------------------------------------------
    def attach(self, sel, viewer):
        """Attach a viewer: unpause, reuse, or create the report's sandbox."""
        sel = clean_selector(sel)
        key = session_key(sel)
        for _ in range(5):
            victim = None
            created = False
            with self.lock:
                if self.closed:
                    raise SandboxError('shutting_down', 'The terminal service is stopping.')
                session = self.sessions.get(key)
                if session is None:
                    self._check_memory()
                    if len(self.sessions) >= self.max_sessions:
                        victim = self._pick_victim_locked()
                        if victim is None:
                            raise SandboxError('too_many_sessions', f'All {self.max_sessions} sandboxes have someone '
                                               'attached. Close the terminal on another report and try again.')
                        del self.sessions[victim.key]
                    session = Session(self, sel)
                    self.sessions[key] = session
                    created = True
            if victim is not None:
                self._close_session(victim, 'Closed to make room for another report.')
            with session.lock:
                if session.closed:
                    continue  # removed between lookup and lock; look again
                event = 'attached'
                if created:
                    with self.lock:
                        event = 'recreated_idle' if self.removed_idle.pop(key, None) else 'started'
                    self._start_locked(session)
                elif session.paused:
                    event = self._resume_locked(session)
                elif not session.started:
                    self._start_locked(session)
                    event = 'started'
                elif not self._alive_locked(session):
                    event = self._recreate_locked(session, 'recreated_vanished')
                return self._join_locked(session, viewer, event)
        raise SandboxError('sandbox_busy', 'The sandbox is changing state. Try again.')

    def _start_locked(self, session):
        try:
            session._start()
        except BaseException:
            session.closed = True
            with self.lock:
                if self.sessions.get(session.key) is session:
                    del self.sessions[session.key]
            session._destroy()
            raise

    def _alive_locked(self, session):
        try:
            return self.backend.state(session) in ('running', 'paused')
        except Exception:
            return True  # unknown: do not destroy a session on a failed probe

    def _resume_locked(self, session):
        try:
            self.backend.unpause(session)
        except SandboxVanished:
            return self._recreate_locked(session, 'recreated_vanished')
        session.paused = False
        return 'resumed'

    def _recreate_locked(self, session, event):
        """The container is gone (removed outside the service): start a fresh one in place."""
        self._check_memory()
        session._destroy()
        session.paused = False
        session.clear_output()
        session.id = secrets.token_hex(6)
        session.created = time.time()
        self._start_locked(session)
        return event

    def _join_locked(self, session, viewer, event):
        moved = session.folder_moved()
        if moved and moved not in session.notes:
            session.notes.append(moved)
        session.viewers.add(viewer)
        viewer.send_control({'type': 'hello', 'event': event, 'session': session.info()})
        if session.scrollback:
            viewer.send_output(bytes(session.scrollback))
        if session.proc is None:
            viewer.send_output(b'\r\n[Shell exited. Press Enter to start a new shell.]\r\n')
        session._broadcast({'type': 'viewers', 'count': len(session.viewers)})
        return session

    def detach(self, session, viewer):
        with session.lock:
            if viewer in session.viewers:
                session.viewers.discard(viewer)
                if not session.viewers:
                    session.left_at = self.clock()
                session._broadcast({'type': 'viewers', 'count': len(session.viewers)})

    def reset(self, sel):
        """Recreate the sandbox for a report (fresh container, same mounted folder)."""
        sel = clean_selector(sel)
        session = self.get(sel)
        if session is None:
            return None
        with session.lock:
            if session.closed:
                return None
            session._broadcast({'type': 'reset'})
            try:
                self._recreate_locked(session, 'reset')
            except BaseException:
                session.closed = True
                with self.lock:
                    if self.sessions.get(session.key) is session:
                        del self.sessions[session.key]
                for viewer in list(session.viewers):
                    viewer.send_control({'type': 'error', 'code': 'sandbox_failed', 'message': 'The sandbox could not be recreated.'})
                    viewer.close()
                raise
            session._broadcast({'type': 'hello', 'event': 'reset', 'session': session.info()})
        return session

    def _close_session(self, session, message):
        with session.lock:
            session.closed = True
            for viewer in list(session.viewers):
                viewer.send_control({'type': 'closed', 'message': message})
                viewer.close()
            session.viewers.clear()
            session._destroy()

    # -- timers ------------------------------------------------------------------------
    def reap_idle(self):
        """One reaper pass: pause and remove idle sandboxes. Returns (paused, removed)."""
        with self.lock:
            candidates = [s for s in self.sessions.values() if not s.viewers]
        paused, removed = [], []
        for session in candidates:
            with session.lock:
                if session.closed or session.viewers:
                    continue
                idle = self.clock() - session.left_at
                if idle >= self.remove_after:
                    session.closed = True
                    with self.lock:
                        if self.sessions.get(session.key) is session:
                            del self.sessions[session.key]
                        self.removed_idle[session.key] = True
                        while len(self.removed_idle) > 500:
                            self.removed_idle.popitem(last=False)
                    session._destroy()
                    removed.append(session)
                elif idle >= self.pause_after and not session.paused and session.started:
                    try:
                        self.backend.pause(session)
                    except SandboxVanished:
                        session.closed = True
                        with self.lock:
                            if self.sessions.get(session.key) is session:
                                del self.sessions[session.key]
                        session._destroy()
                        removed.append(session)
                        continue
                    except Exception as error:
                        self.log(f'pause failed, will retry: {error}')
                        continue
                    session.paused = True
                    paused.append(session)
        return paused, removed

    def _reaper(self, interval):
        while not self.stop_event.wait(interval):
            try:
                self.reap_idle()
            except Exception as error:
                self.log(f'reaper pass failed: {error}')

    def close(self):
        self.stop_event.set()
        with self.lock:
            self.closed = True
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            self._close_session(session, 'The terminal service stopped.')


def read_mem_available(path='/proc/meminfo'):
    """MemAvailable in bytes, or None when unknown."""
    try:
        with open(path) as stream:
            for line in stream:
                if line.startswith('MemAvailable:'):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return None
