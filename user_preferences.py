"""Private server-side UI preferences, never report or credential storage."""
import fcntl
import json
import os
import secrets
import stat
from pathlib import Path

# Keys correspond to existing browser preferences. Terminal Settings are stored
# individually so a stale tab changing a shortcut cannot reset another setting.
KEYS = frozenset({
    'bounty-board-theme', 'bounty-board-show-archived', 'bounty-board-sidebar-collapsed',
    'bounty-board-finding-sort', 'bounty-board-dashboard-work', 'bounty-board-class-group',
    'bounty-board-report-list-hide-na', 'bounty-board-report-list-open',
    'bounty-board-recent-programs', 'bounty-board-last-program',
    'bounty-board-recent-panel-show-na',
    'terminal.copyOnSelect', 'terminal.ctrlCCopy', 'terminal.ctrlVPaste',
    'terminal.shortcut', 'terminal.dock',
}) | frozenset(f'list.{name}.{field}' for name in ('recent', 'submissions') for field in
              ('window', 'order', 'nav', 'hideNa', 'programs', 'lanes', 'subs', 'sevs', 'classes'))
MAX_BYTES = 2 * 1024 * 1024
MAX_VALUE_BYTES = 128 * 1024


def validate(values):
    if not isinstance(values, dict) or set(values) - KEYS:
        raise ValueError('invalid preferences')
    for key, value in values.items():
        if not isinstance(value, str) or len(value.encode('utf-8')) > MAX_VALUE_BYTES:
            raise ValueError('invalid value')
        if key == 'bounty-board-theme' and value not in ('light', 'dark', 'dusk'):
            raise ValueError('invalid theme')
        if key in ('bounty-board-show-archived', 'bounty-board-sidebar-collapsed',
                   'bounty-board-report-list-hide-na', 'bounty-board-report-list-open') and value not in ('true', 'false'):
            raise ValueError('invalid flag')
        if key == 'bounty-board-recent-panel-show-na' and value not in ('0', '1'):
            raise ValueError('invalid panel preference')
        if key in ('bounty-board-dashboard-work', 'bounty-board-class-group'):
            allowed = ('all', 'open') if key == 'bounty-board-dashboard-work' else ('class', 'category')
            if json.loads(value) not in allowed:
                raise ValueError('invalid view preference')
        if key == 'bounty-board-finding-sort':
            sort = json.loads(value)
            if (not isinstance(sort, dict) or set(sort) != {'key', 'dir'} or
                    sort['key'] not in ('', 'title', 'severity', 'class', 'status', 'id', 'first_seen', 'last_seen') or
                    sort['dir'] not in ('asc', 'desc')):
                raise ValueError('invalid sort')
        if key in ('bounty-board-recent-programs', 'bounty-board-last-program'):
            parsed = json.loads(value)
            programs = parsed if key == 'bounty-board-recent-programs' else [parsed]
            if (not isinstance(programs, list) or len(programs) > 5 or
                    any(not isinstance(item, dict) or set(item) != {'program', 'lane'} or
                        any(not isinstance(item[k], str) or len(item[k]) > 200 for k in ('program', 'lane')) for item in programs)):
                raise ValueError('invalid program preference')
        if key in ('terminal.copyOnSelect', 'terminal.ctrlCCopy', 'terminal.ctrlVPaste') and value not in ('true', 'false'):
            raise ValueError('invalid switch')
        if key == 'terminal.dock' and value not in ('bottom', 'top', 'left', 'right'):
            raise ValueError('invalid dock')
        if key == 'terminal.shortcut':
            shortcut = json.loads(value)
            if (not isinstance(shortcut, dict) or set(shortcut) != {'ctrl', 'alt', 'shift', 'code'} or
                    any(type(shortcut[k]) is not bool for k in ('ctrl', 'alt', 'shift')) or
                    not isinstance(shortcut['code'], str) or len(shortcut['code']) > 16):
                raise ValueError('invalid shortcut')
        if key.startswith('list.'):
            field = key.rsplit('.', 1)[-1]
            parsed = json.loads(value)
            if field == 'window':
                valid = parsed in ('1d', '7d', '30d', 'all')
            elif field == 'order':
                valid = parsed in ('newest', 'oldest', 'severity', 'class')
            elif field in ('nav', 'hideNa'):
                valid = type(parsed) is bool
            else:
                valid = (isinstance(parsed, list) and len(parsed) <= 100 and
                         all(isinstance(item, str) and len(item) <= 200 for item in parsed))
            if not valid:
                raise ValueError('invalid list preference')
    return values


class UserPreferences:
    def __init__(self, path, root):
        self.path = Path(os.path.abspath(path))
        root = Path(os.path.abspath(root))
        shared = Path.home() / 'Shared'
        if (self.path.is_relative_to(root) or self.path.is_relative_to(shared) or
                self.path.resolve().is_relative_to(root.resolve()) or
                self.path.resolve().is_relative_to(shared.resolve())):
            raise ValueError('preferences must be outside the data root and Shared')

    def _directory(self, create):
        # Walk from / with O_NOFOLLOW: neither existing nor newly created path
        # components can redirect a private write through a symlink.
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in self.path.parent.parts[1:]:
                try:
                    nextfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                    nextfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nextfd
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _read(self, directory):
        try:
            fd = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return {}, {}
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('not a regular file')
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError('too large')
        result = json.loads(data)
        if not isinstance(result, dict):
            raise ValueError('invalid preferences')
        revisions = result.pop('__revisions', {})
        if (not isinstance(revisions, dict) or set(revisions) - KEYS or
                any(type(v) is not int or v < 1 for v in revisions.values())):
            raise ValueError('invalid revisions')
        return validate(result), revisions

    def read(self):
        try:
            directory = self._directory(False)
        except FileNotFoundError:
            return {}, {}
        try:
            return self._read(directory)
        finally:
            os.close(directory)

    def update(self, values, migrate=False, expected=None):
        validate(values)
        directory = self._directory(True)
        lock = None
        name = None
        try:
            lock = os.open('.user.conf.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            if not stat.S_ISREG(os.fstat(lock).st_mode):
                raise ValueError('invalid lock')
            fcntl.flock(lock, fcntl.LOCK_EX)
            previous, revisions = self._read(directory)
            if expected is not None and any(revisions.get(key, 0) != version for key, version in expected.items()):
                return previous, revisions, True, []
            result = dict(previous)
            revisions = dict(revisions)
            applied = []
            for key, value in values.items():
                if not migrate or key not in result:
                    result[key] = value
                    revisions[key] = revisions.get(key, 0) + 1
                    applied.append(key)
            if result == previous and migrate:
                return result, revisions, False, applied
            data = (json.dumps({**result, '__revisions': revisions}, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')
            if len(data) > MAX_BYTES:
                raise ValueError('too large')
            name = '.user.conf-' + secrets.token_hex(16)
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path.name, src_dir_fd=directory, dst_dir_fd=directory)
            name = None
            os.fsync(directory)
            return result, revisions, False, applied
        finally:
            if name is not None:
                try:
                    os.unlink(name, dir_fd=directory)
                except FileNotFoundError:
                    pass
            if lock is not None:
                os.close(lock)
            os.close(directory)
