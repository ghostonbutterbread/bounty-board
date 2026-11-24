"""Live report editing with the Board server as the single merge point.

Browsers send their full text together with the revision it was based on. The
server merges that text with the current file and writes the result, so every
Board edit passes through one place. Changes made by other writers (agents,
editors, sync clients) are noticed by polling the file, recorded, and pushed to
open editors; a later Board save merges against them instead of replacing them.

Guarantees and limits:

* Board saves for one report are serialized inside this process. Run one Board
  process per data root.
* Every version the server observes or writes is kept in private history
  (outside the data root) before it is replaced.
* Replacement uses ``renameat2(RENAME_EXCHANGE)``. A write that lands between
  the final check and the exchange is recovered from the displaced file and
  merged. A process that keeps the old file open and writes after the exchange
  can still lose that write; writers should use temp-file-and-rename.
* Overlapping edits are never resolved silently. The editor receives conflict
  markers and the server refuses to write text that still contains them.
"""
import ctypes
import errno
import hashlib
import os
import queue
import re
import secrets
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
from pathlib import Path

MAX_BYTES = 5_000_000
MARKER_TAG = '(Bounty Board)'
EDIT_LABELS = (f'your edit {MARKER_TAG}', f'saved version {MARKER_TAG}')
COPY_LABELS = (f'current file {MARKER_TAG}', f'Syncthing conflict copy {MARKER_TAG}')
HISTORY_PAGE = 50
COALESCE_SECONDS = 120
SUBSCRIBER_QUEUE = 64
_CONFLICT_STAMP = re.compile(r'\.sync-conflict-(\d{8})-(\d{6})-([A-Z0-9]{7})')
_DRAFT_KINDS = "('conflict_draft','sync_conflict')"
_WRITE_KINDS = "('board','merged','restore')"


class ReportUnavailable(Exception):
    """The report is missing, unreadable, or not a regular UTF-8 file."""


class NotEditable(Exception):
    """The report exists but this server will not write it."""


class UnresolvedConflict(Exception):
    """Submitted text still contains this server's conflict markers."""


class _Changed(Exception):
    def __init__(self, current):
        super().__init__('report changed before replacement')
        self.current = current


def revision_of(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def has_markers(text):
    return any(line.startswith(('<<<<<<< ', '>>>>>>> ')) and line.endswith(MARKER_TAG) for line in text.split('\n'))


def _normalize(text):
    return text.replace('\r\n', '\n')


def _crlf(data):
    return b'\r\n' in data and data.count(b'\n') == data.count(b'\r\n')


def _encode(text, crlf):
    return (text.replace('\n', '\r\n') if crlf else text).encode('utf-8')


def _whole_conflict(mine, saved, labels):
    def block(text):
        return text if text.endswith('\n') or not text else text + '\n'
    return f'<<<<<<< {labels[0]}\n{block(mine)}=======\n{block(saved)}>>>>>>> {labels[1]}\n'


def merge3(base, mine, saved, workdir, labels=EDIT_LABELS):
    """Three-way line merge. Returns (text, conflicted)."""
    if mine == saved or base == saved:
        return mine, False
    if base == mine:
        return saved, False
    if base is None:
        return _whole_conflict(mine, saved, labels), True
    with tempfile.TemporaryDirectory(prefix='merge-', dir=workdir) as tmp:
        paths = []
        for name, text in (('mine', mine), ('base', base), ('saved', saved)):
            path = os.path.join(tmp, name)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(text.encode('utf-8'))
            paths.append(path)
        try:
            result = subprocess.run(['git', 'merge-file', '-p', '-L', labels[0], '-L', 'base', '-L', labels[1],
                                     '--', *paths], capture_output=True, timeout=20, check=False)
        except (OSError, subprocess.SubprocessError):
            # Without a merge tool, hand both versions to the person editing.
            return _whole_conflict(mine, saved, labels), True
    if result.returncode >= 128 or result.returncode < 0:
        return _whole_conflict(mine, saved, labels), True
    return result.stdout.decode('utf-8'), result.returncode > 0


def _exchange(dir_fd, a, b):
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        fn = libc.renameat2
    except AttributeError as exc:
        raise OSError(errno.ENOSYS, 'renameat2 unavailable') from exc
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    if fn(dir_fd, os.fsencode(a), dir_fd, os.fsencode(b), 2):  # RENAME_EXCHANGE
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def _open_parent(root, relative):
    parts = relative.split('/')
    if not parts or any(part in ('', '.', '..') for part in parts):
        raise ReportUnavailable('invalid path')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
    except BaseException:
        os.close(fd)
        raise
    return fd, parts[-1]


def _read_at(dir_fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ReportUnavailable('not a regular file')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise ReportUnavailable('file too large')
            chunks.append(chunk)
        return b''.join(chunks), info
    finally:
        os.close(fd)


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size, info.st_ctime_ns)


def _replace(dir_fd, name, data, expected, hook=None):
    """Replace ``name`` with ``data`` if it still holds ``expected``.

    Raises _Changed (nothing written) when the check fails. Returns the
    displaced bytes when a write landed between the check and the exchange
    (``data`` is in place and the displaced version must be merged back), or
    None.
    """
    info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise ReportUnavailable('not a regular file')
    # Syncthing never indexes '.syncthing.*.tmp', so staging is not synced.
    staged = f'.syncthing.board-{secrets.token_hex(6)}.tmp'
    fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
    try:
        try:
            os.fchmod(fd, stat.S_IMODE(info.st_mode))
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        if hook:
            hook('before_check')
        current, _ = _read_at(dir_fd, name)
        if current != expected:
            raise _Changed(current)
        if hook:
            hook('before_exchange')
        try:
            _exchange(dir_fd, staged, name)
            exchanged = True
        except OSError as exc:
            if exc.errno not in (errno.ENOSYS, errno.EINVAL, errno.ENOTSUP):
                raise
            os.rename(staged, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            exchanged = False
        displaced = None
        if exchanged:
            old, _ = _read_at(dir_fd, staged)
            if old != expected:
                displaced = old
        os.fsync(dir_fd)
        return displaced
    finally:
        try:
            os.unlink(staged, dir_fd=dir_fd)
        except FileNotFoundError:
            pass


class History:
    """Private revision store: blobs by content hash plus per-report events."""

    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10)
        with self.lock:
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, content TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, key TEXT NOT NULL, sha TEXT NOT NULL,
                    kind TEXT NOT NULL, author TEXT NOT NULL, client TEXT, created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS events_key ON events (key, id);
                CREATE TABLE IF NOT EXISTS bases (key TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (key, sha));
            ''')

    def put(self, text, key=None):
        sha = revision_of(text)
        with self.lock:
            self.db.execute('INSERT OR IGNORE INTO blobs VALUES (?,?,?)', (sha, text, time.time()))
            if key is not None:
                self.db.execute('INSERT OR IGNORE INTO bases VALUES (?,?)', (key, sha))
        return sha

    def text(self, key, sha):
        """Content of a revision this report has seen, or None."""
        with self.lock:
            row = self.db.execute(
                'SELECT content FROM blobs WHERE sha=? AND (EXISTS (SELECT 1 FROM events WHERE key=? AND sha=?) '
                'OR EXISTS (SELECT 1 FROM bases WHERE key=? AND sha=?))', (sha, key, sha, key, sha)).fetchone()
        return row[0] if row else None

    def record(self, key, sha, kind, author, client=None, coalesce=False):
        now = time.time()
        with self.lock:
            last = self.db.execute('SELECT id, kind, client, created FROM events WHERE key=? ORDER BY id DESC LIMIT 1',
                                   (key,)).fetchone()
            if (coalesce and last and last[1] == kind == 'board' and client and last[2] == client
                    and now - last[3] < COALESCE_SECONDS):
                # One typing session becomes one history entry; its earlier
                # blobs stay available as merge bases.
                self.db.execute('UPDATE events SET sha=?, created=? WHERE id=?', (sha, now, last[0]))
                self.db.execute('INSERT OR IGNORE INTO bases VALUES (?,?)', (key, sha))
                return last[0]
            return self.db.execute('INSERT INTO events (key, sha, kind, author, client, created) VALUES (?,?,?,?,?,?)',
                                   (key, sha, kind, author, client, now)).lastrowid

    def page(self, key, before=None, limit=HISTORY_PAGE):
        with self.lock:
            rows = self.db.execute(
                'SELECT e.id, e.sha, e.kind, e.author, e.client, e.created, length(b.content) FROM events e '
                'JOIN blobs b ON b.sha=e.sha WHERE e.key=? AND (? IS NULL OR e.id<?) ORDER BY e.id DESC LIMIT ?',
                (key, before, before, limit)).fetchall()
        return [{'id': r[0], 'revision': r[1], 'kind': r[2], 'author': r[3], 'client': r[4], 'created': r[5],
                 'length': r[6]} for r in rows]

    def written_parent(self, key, sha):
        """For a revision the Board wrote, the head it replaced; else None."""
        with self.lock:
            row = self.db.execute(f'SELECT id FROM events WHERE key=? AND sha=? AND kind IN {_WRITE_KINDS} '
                                  'ORDER BY id DESC LIMIT 1', (key, sha)).fetchone()
            if not row:
                return None
            parent = self.db.execute(f'SELECT sha FROM events WHERE key=? AND id<? AND kind NOT IN {_DRAFT_KINDS} '
                                     'ORDER BY id DESC LIMIT 1', (key, row[0])).fetchone()
        return parent[0] if parent else None

    def likely_base(self, key, until):
        """Best guess at the version an unknown concurrent edit started from.

        Uses the head preceding the latest Board write at or before ``until``,
        else the head at ``until``. A guess: callers show the result for review.
        """
        with self.lock:
            write = self.db.execute(f'SELECT id FROM events WHERE key=? AND created<=? AND kind IN {_WRITE_KINDS} '
                                    'ORDER BY id DESC LIMIT 1', (key, until)).fetchone()
            if write:
                row = self.db.execute(f'SELECT sha FROM events WHERE key=? AND id<? AND kind NOT IN {_DRAFT_KINDS} '
                                      'ORDER BY id DESC LIMIT 1', (key, write[0])).fetchone()
            else:
                row = self.db.execute(f'SELECT sha FROM events WHERE key=? AND created<=? AND kind NOT IN {_DRAFT_KINDS} '
                                      'ORDER BY id DESC LIMIT 1', (key, until)).fetchone()
        return row[0] if row else None

    def prune(self, older_than_days=14):
        """Drop merge-base blobs no history entry uses once they are old."""
        cutoff = time.time() - older_than_days * 86400
        with self.lock:
            self.db.execute('DELETE FROM blobs WHERE created<? AND sha NOT IN (SELECT sha FROM events)', (cutoff,))
            self.db.execute('DELETE FROM bases WHERE sha NOT IN (SELECT sha FROM blobs)')

    def close(self):
        with self.lock:
            self.db.close()


class _Doc:
    def __init__(self, relative):
        self.relative = relative
        self.lock = threading.RLock()
        self.head = None
        self.text = None
        self.raw = None
        self.crlf = False
        self.identity = None
        self.missing = False
        self.editable = False
        self.reason = None
        self.subscribers = set()
        self.touched = 0.0
        self.copies = ()


class LiveReports:
    def __init__(self, root, state_dir, *, editable=None, poll_interval=1.0, idle_seconds=30, hook=None):
        self.root = Path(root).resolve(strict=True)
        state = Path(state_dir).expanduser().absolute()
        state.mkdir(mode=0o700, parents=True, exist_ok=True)
        state = state.resolve(strict=True)
        if state == self.root or state.is_relative_to(self.root):
            raise ValueError('live edit history must be stored outside the data root')
        info = state.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError('live edit state directory must be private to this user (mode 0700)')
        self.state_dir = state
        self.workdir = state / 'merge'
        self.workdir.mkdir(mode=0o700, exist_ok=True)
        self.history = History(state / 'history.sqlite3')
        self.history.prune()
        self.editable = editable or (lambda relative, text: True)
        self.hook = hook
        self.poll_interval = poll_interval
        self.idle_seconds = idle_seconds
        self.docs = {}
        self.docs_lock = threading.Lock()
        self.stopped = threading.Event()
        self.watcher = threading.Thread(target=self._watch, name='live-report-watcher', daemon=True)
        self.watcher.start()

    # -- document state -------------------------------------------------
    def _doc(self, relative):
        with self.docs_lock:
            doc = self.docs.get(relative)
            if doc is None:
                doc = self.docs[relative] = _Doc(relative)
            return doc

    def _observe(self, doc):
        """Read the file; record and announce any version not seen before."""
        try:
            dir_fd, name = _open_parent(self.root, doc.relative)
            try:
                data, info = _read_at(dir_fd, name)
            finally:
                os.close(dir_fd)
        except FileNotFoundError:
            if not doc.missing:
                doc.missing, doc.identity, doc.raw = True, None, None
                self._broadcast(doc, {'type': 'missing'})
            return
        except (OSError, ReportUnavailable) as exc:
            doc.missing, doc.identity, doc.raw = True, None, None
            raise ReportUnavailable(str(exc)) from exc
        doc.identity = _identity(info)
        doc.missing = False
        if data == doc.raw:
            return
        try:
            text = _normalize(data.decode('utf-8'))
        except UnicodeDecodeError as exc:
            doc.raw, doc.editable, doc.reason = data, False, 'not_utf8'
            raise ReportUnavailable('not UTF-8') from exc
        first = doc.head is None
        sha = self.history.put(text)
        if sha != doc.head:
            self.history.record(doc.relative, sha, 'observed' if first else 'external', 'File on disk' if first else 'Changed outside the Board')
        changed = sha != doc.head and not first
        doc.raw, doc.text, doc.head, doc.crlf = data, text, sha, _crlf(data)
        doc.editable = bool(self.editable(doc.relative, text))
        doc.reason = None if doc.editable else 'generated_navigation'
        if changed:
            self._broadcast(doc, {'type': 'changed', 'revision': sha, 'author': 'Changed outside the Board'})

    def _snapshot(self, doc):
        return {'content': doc.text, 'revision': doc.head, 'editable': doc.editable, 'reason': doc.reason,
                'sync_conflicts': [self._copy_info(c) for c in doc.copies]}

    def open(self, relative):
        doc = self._doc(relative)
        with doc.lock:
            doc.touched = time.monotonic()
            self._observe(doc)
            if doc.missing:
                raise ReportUnavailable('missing')
            self._refresh_copies(doc)
            return self._snapshot(doc)

    # -- writing ---------------------------------------------------------
    def _write(self, doc, target, kind, author, client):
        """Write ``target`` over the current head, merging any late writer.

        Returns (text, conflicted). When conflicted, nothing further was
        written and ``text`` carries conflict markers for the editor.
        """
        for _ in range(5):
            dir_fd, name = _open_parent(self.root, doc.relative)
            try:
                displaced = _replace(dir_fd, name, _encode(target, doc.crlf), doc.raw, self.hook)
            except _Changed as changed:
                # Someone wrote after our last observation: adopt it, then merge.
                previous = doc.text
                self._adopt(doc, changed.current)
                target, conflicted = merge3(previous, target, doc.text, self.workdir)
                if conflicted or target == doc.text:
                    return target, conflicted
                continue
            finally:
                os.close(dir_fd)
            previous = doc.text
            sha = self.history.put(target)
            self.history.record(doc.relative, sha, kind, author, client, coalesce=kind == 'board')
            doc.text, doc.head, doc.raw = target, sha, _encode(target, doc.crlf)
            self._refresh_identity(doc)
            if displaced is None:
                return target, False
            # A write slipped in between the check and the exchange. It is no
            # longer on disk: keep it in history and merge it back.
            theirs = _normalize(displaced.decode('utf-8', 'replace'))
            self.history.record(doc.relative, self.history.put(theirs), 'external', 'Changed outside the Board')
            merged, conflicted = merge3(previous, target, theirs, self.workdir)
            if conflicted or merged == target:
                return merged, conflicted
            target, kind = merged, 'merged'
        raise ReportUnavailable('report keeps changing; retry')

    def _adopt(self, doc, data):
        text = _normalize(data.decode('utf-8', 'replace'))
        sha = self.history.put(text)
        self.history.record(doc.relative, sha, 'external', 'Changed outside the Board')
        doc.raw, doc.text, doc.head, doc.crlf = data, text, sha, _crlf(data)
        self._refresh_identity(doc)
        self._broadcast(doc, {'type': 'changed', 'revision': sha, 'author': 'Changed outside the Board'})

    def _refresh_identity(self, doc):
        try:
            doc.identity = _identity(os.stat(self.root / doc.relative, follow_symlinks=False))
        except OSError:
            doc.identity = None

    def save(self, relative, base, content, *, author='Board editor', client=None, kind='board'):
        """Merge ``content`` (based on revision ``base``) into the report."""
        if not isinstance(content, str) or len(content.encode('utf-8')) > MAX_BYTES:
            raise ValueError('invalid content')
        content = _normalize(content)
        if has_markers(content):
            raise UnresolvedConflict()
        doc = self._doc(relative)
        with doc.lock:
            doc.touched = time.monotonic()
            self._observe(doc)
            if doc.missing:
                raise ReportUnavailable('missing')
            if not doc.editable:
                raise NotEditable(doc.reason or 'not_editable')
            before = doc.head
            sent = self.history.put(content, relative)
            if base == doc.head:
                target, conflicted = content, False
            else:
                target, conflicted = merge3(self.history.text(relative, base), content, doc.text, self.workdir)
            if not conflicted and target != doc.text:
                target, conflicted = self._write(doc, target, kind, author, client)
            if conflicted:
                self.history.record(relative, sent, 'conflict_draft', author, client)
                return {'status': 'conflict', 'revision': doc.head, 'content': target, 'sent_revision': sent}
            if doc.head != before:
                self._broadcast(doc, {'type': 'changed', 'revision': doc.head, 'author': author, 'client': client})
            return {'status': 'saved' if doc.text == content else 'merged', 'revision': doc.head,
                    'content': doc.text, 'sent_revision': sent}

    # -- history ---------------------------------------------------------
    def history_page(self, relative, before=None):
        return self.history.page(relative, before)

    def revision(self, relative, sha):
        text = self.history.text(relative, sha)
        if text is None:
            raise KeyError(sha)
        return text

    def restore(self, relative, sha, base, *, author='Board editor', client=None):
        return self.save(relative, base, self.revision(relative, sha), author=author, client=client, kind='restore')

    # -- Syncthing conflict copies ----------------------------------------
    def _copy_names(self, doc):
        directory, _, name = doc.relative.rpartition('/')
        stem, dot, suffix = name.rpartition('.')
        stem, suffix = (stem, dot + suffix) if dot else (name, '')
        try:
            dir_fd, _ = _open_parent(self.root, doc.relative)
        except OSError:
            return ()
        try:
            names = os.listdir(dir_fd)
            found = []
            for entry in names:
                if not entry.startswith(stem + '.sync-conflict-') or not entry.endswith(suffix):
                    continue
                middle = entry[len(stem):len(entry) - len(suffix)]
                if not _CONFLICT_STAMP.fullmatch(middle):
                    continue
                try:
                    info = os.stat(entry, dir_fd=dir_fd, follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISREG(info.st_mode):
                    found.append((entry, info.st_size, info.st_mtime_ns))
            return tuple(sorted(found))
        finally:
            os.close(dir_fd)

    @staticmethod
    def _copy_info(copy):
        name, size, mtime_ns = copy
        match = _CONFLICT_STAMP.search(name)
        return {'name': name, 'size': size, 'modified': mtime_ns / 1e9, 'device': match.group(3) if match else None}

    def _read_copy(self, doc, name):
        if name not in {c[0] for c in self._copy_names(doc)}:
            raise KeyError(name)
        dir_fd, _ = _open_parent(self.root, doc.relative)
        try:
            data, info = _read_at(dir_fd, name)
        finally:
            os.close(dir_fd)
        return _normalize(data.decode('utf-8', 'replace')), info

    def _remove_copy(self, doc, name, info):
        dir_fd, _ = _open_parent(self.root, doc.relative)
        try:
            now = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            if (now.st_dev, now.st_ino, now.st_mtime_ns, now.st_size) != (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size):
                return False
            os.unlink(name, dir_fd=dir_fd)
            return True
        except FileNotFoundError:
            return True
        finally:
            os.close(dir_fd)

    def _merge_preview(self, doc, text, info):
        sha = revision_of(text)
        if sha == doc.head:
            return {'merged': doc.text, 'conflicted': False, 'known': True}
        base = self.history.written_parent(doc.relative, sha)
        known = base is not None
        if base is None:
            base = self.history.likely_base(doc.relative, info.st_mtime_ns / 1e9 + 1)
        base_text = self.history.text(doc.relative, base) if base else None
        merged, conflicted = merge3(base_text, doc.text, text, self.workdir, COPY_LABELS)
        return {'merged': merged, 'conflicted': conflicted, 'known': known}

    def _refresh_copies(self, doc):
        copies = self._copy_names(doc)
        if copies == doc.copies:
            return
        doc.copies = copies
        for name, _, _ in copies:
            try:
                self._auto_resolve(doc, name)
            except (OSError, KeyError, ReportUnavailable, UnicodeError):
                continue
        doc.copies = self._copy_names(doc)
        self._broadcast(doc, {'type': 'sync_conflicts', 'copies': [self._copy_info(c) for c in doc.copies]})

    def _archive_copy(self, doc, name, text):
        sha = self.history.put(text)
        self.history.record(doc.relative, sha, 'sync_conflict', f'Syncthing conflict copy {name}')

    def _auto_resolve(self, doc, name):
        """Silently fold back a Board write that lost a Syncthing conflict."""
        if not doc.editable or doc.missing:
            return
        text, info = self._read_copy(doc, name)
        preview = self._merge_preview(doc, text, info)
        if not preview['known'] or preview['conflicted']:
            return
        self._archive_copy(doc, name, text)
        if preview['merged'] != doc.text:
            target, conflicted = self._write(doc, preview['merged'], 'merged', 'Merged a Syncthing conflict copy', None)
            if conflicted:
                return
            self._broadcast(doc, {'type': 'changed', 'revision': doc.head, 'author': 'Merged a Syncthing conflict copy'})
        self._remove_copy(doc, name, info)

    def sync_conflict(self, relative, name):
        doc = self._doc(relative)
        with doc.lock:
            self._observe(doc)
            text, info = self._read_copy(doc, name)
            preview = self._merge_preview(doc, text, info)
            return {'name': name, 'content': text, 'merged': preview['merged'], 'conflicted': preview['conflicted'],
                    'revision': doc.head}

    def resolve_sync_conflict(self, relative, name, action, *, base=None, content=None, author='Board editor', client=None):
        doc = self._doc(relative)
        with doc.lock:
            self._observe(doc)
            text, info = self._read_copy(doc, name)
            result = None
            if action == 'apply':
                result = self.save(relative, base, content, author=author, client=client)
                if result['status'] == 'conflict':
                    return result
            elif action != 'discard':
                raise ValueError('invalid action')
            self._archive_copy(doc, name, text)
            removed = self._remove_copy(doc, name, info)
            doc.copies = self._copy_names(doc)
            self._broadcast(doc, {'type': 'sync_conflicts', 'copies': [self._copy_info(c) for c in doc.copies]})
            return {**(result or {'status': 'discarded', 'revision': doc.head}), 'copy_removed': removed}

    # -- live updates ----------------------------------------------------
    def subscribe(self, relative):
        doc = self._doc(relative)
        subscriber = queue.Queue(SUBSCRIBER_QUEUE)
        with doc.lock:
            doc.subscribers.add(subscriber)
            doc.touched = time.monotonic()
        return subscriber

    def unsubscribe(self, relative, subscriber):
        doc = self._doc(relative)
        with doc.lock:
            doc.subscribers.discard(subscriber)
            doc.touched = time.monotonic()

    def _broadcast(self, doc, event):
        for subscriber in list(doc.subscribers):
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                # A stalled client is closed; it reconnects and reloads.
                doc.subscribers.discard(subscriber)
                with subscriber.mutex:
                    subscriber.queue.clear()
                subscriber.put_nowait(None)

    def _watch(self):
        while not self.stopped.wait(self.poll_interval):
            now = time.monotonic()
            with self.docs_lock:
                docs = list(self.docs.values())
            for doc in docs:
                if not doc.subscribers and now - doc.touched > self.idle_seconds:
                    continue
                try:
                    current = _identity(os.stat(self.root / doc.relative, follow_symlinks=False))
                except OSError:
                    current = None
                try:
                    with doc.lock:
                        if current != doc.identity:
                            self._observe(doc)
                        self._refresh_copies(doc)
                except (OSError, ReportUnavailable, sqlite3.Error):
                    continue

    def close(self):
        self.stopped.set()
        self.watcher.join(timeout=5)
        self.history.close()
