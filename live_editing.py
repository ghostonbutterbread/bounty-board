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
  (outside the data root) before it is replaced. One client's typing session
  is one history entry holding its latest text; intermediate autosaves are
  kept only while a client may still send them back as a merge base.
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
# Wider than git's default 7 so a Markdown setext underline ('=======') inside
# a conflict cannot be mistaken for the separator.
MARKER_SIZE = 15
EDIT_LABELS = (f'your edit {MARKER_TAG}', f'saved version {MARKER_TAG}')
COPY_LABELS = (f'current file {MARKER_TAG}', f'Syncthing conflict copy {MARKER_TAG}')
HISTORY_PAGE = 50
COALESCE_SECONDS = 120
# A revision handed to a client stays usable as a merge base this long after
# its last use; history entries themselves are kept until removed by hand.
BASE_DAYS = 14
PRUNE_SECONDS = 3600
# Documents with no live editor are forgotten after this long.
EVICT_SECONDS = 600
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


_MARKER_LINE = re.compile(r'(?:<{7,}|>{7,}) .*' + re.escape(MARKER_TAG))


def has_markers(text):
    return any(_MARKER_LINE.fullmatch(line) for line in text.split('\n'))


def _normalize(text):
    return text.replace('\r\n', '\n')


def _crlf(data):
    return b'\r\n' in data and data.count(b'\n') == data.count(b'\r\n')


def _encode(text, crlf):
    return (text.replace('\n', '\r\n') if crlf else text).encode('utf-8')


def _whole_conflict(mine, saved, labels):
    def block(text):
        return text if text.endswith('\n') or not text else text + '\n'
    return (f"{'<' * MARKER_SIZE} {labels[0]}\n{block(mine)}{'=' * MARKER_SIZE}\n{block(saved)}"
            f"{'>' * MARKER_SIZE} {labels[1]}\n")


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
            result = subprocess.run(['git', 'merge-file', '-p', f'--marker-size={MARKER_SIZE}', '-L', labels[0], '-L', 'base', '-L', labels[1],
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
    """Private revision store: blobs by content hash plus per-report events.

    ``bases`` records every revision a client may still send back as the base
    of a save: texts handed out by ``open`` (client ``''``, shared), and the
    revision and sent text returned to one client by ``save``. Written heads
    are kept through their events. A blob is dropped only when no event and no
    base row still refers to it.
    """

    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10)
        with self.lock:
            self.db.execute('PRAGMA journal_mode=WAL')
            # Each autosave writes a full copy; keep the WAL from staying large.
            self.db.execute('PRAGMA journal_size_limit=4194304')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, content TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, key TEXT NOT NULL, sha TEXT NOT NULL,
                    kind TEXT NOT NULL, author TEXT NOT NULL, client TEXT, created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS events_key ON events (key, id);
                CREATE INDEX IF NOT EXISTS events_sha ON events (sha);
            ''')
            columns = [row[1] for row in self.db.execute('PRAGMA table_info(bases)')]
            if columns and 'client' not in columns:
                # Earlier layout (key, sha): keep its rows as shared bases.
                self.db.execute('ALTER TABLE bases RENAME TO bases_old')
            self.db.execute('CREATE TABLE IF NOT EXISTS bases (key TEXT NOT NULL, sha TEXT NOT NULL, client TEXT NOT NULL, '
                            'used REAL NOT NULL, PRIMARY KEY (key, sha, client))')
            self.db.execute('CREATE INDEX IF NOT EXISTS bases_sha ON bases (sha)')
            if columns and 'client' not in columns:
                self.db.execute("INSERT OR IGNORE INTO bases SELECT key, sha, '', ? FROM bases_old", (time.time(),))
                self.db.execute('DROP TABLE bases_old')

    def put(self, text, key=None, client=''):
        """Store ``text``; with ``key``, mark it as a base handed to ``client``."""
        sha = revision_of(text)
        now = time.time()
        with self.lock:
            self.db.execute('INSERT OR IGNORE INTO blobs VALUES (?,?,?)', (sha, text, now))
            if key is not None:
                self._use(key, sha, client, now)
        return sha

    def hand_out(self, key, sha, client=''):
        if sha:
            with self.lock:
                self._use(key, sha, client or '', time.time())

    def _use(self, key, sha, client, now):
        self.db.execute('INSERT INTO bases VALUES (?,?,?,?) ON CONFLICT (key, sha, client) DO UPDATE SET used=excluded.used',
                        (key, sha, client, now))

    def text(self, key, sha):
        """Content of a revision this report has seen, or None."""
        with self.lock:
            row = self.db.execute(
                'SELECT content FROM blobs WHERE sha=? AND (EXISTS (SELECT 1 FROM events WHERE key=? AND sha=?) '
                'OR EXISTS (SELECT 1 FROM bases WHERE key=? AND sha=?))', (sha, key, sha, key, sha)).fetchone()
        return row[0] if row else None

    def last(self, key):
        with self.lock:
            row = self.db.execute(f'SELECT sha FROM events WHERE key=? AND kind NOT IN {_DRAFT_KINDS} '
                                  'ORDER BY id DESC LIMIT 1', (key,)).fetchone()
        return row[0] if row else None

    def _drop_if_unused(self, sha):
        self.db.execute('DELETE FROM blobs WHERE sha=? AND NOT EXISTS (SELECT 1 FROM events WHERE sha=?) '
                        'AND NOT EXISTS (SELECT 1 FROM bases WHERE sha=?)', (sha, sha, sha))

    def release_client(self, key, client, keep):
        """Forget bases only ``client`` held for ``key``, except ``keep``.

        Called after a successful save: the client has moved on to the
        returned revision, so its older private bases cannot come back.
        """
        if not client:
            return
        keep = tuple(keep)
        with self.lock:
            rows = self.db.execute(f'SELECT sha FROM bases WHERE key=? AND client=? AND sha NOT IN ({",".join("?" * len(keep))})',
                                   (key, client, *keep)).fetchall()
            for (sha,) in rows:
                self.db.execute('DELETE FROM bases WHERE key=? AND client=? AND sha=?', (key, client, sha))
                self._drop_if_unused(sha)

    def record(self, key, sha, kind, author, client=None, coalesce=False):
        now = time.time()
        with self.lock:
            last = self.db.execute('SELECT id, kind, client, created, sha FROM events WHERE key=? ORDER BY id DESC LIMIT 1',
                                   (key,)).fetchone()
            if (coalesce and last and last[1] == kind == 'board' and client and last[2] == client
                    and now - last[3] < COALESCE_SECONDS):
                # One typing session becomes one history entry. The replaced
                # text stays only while something can still use it as a base.
                self.db.execute('UPDATE events SET sha=?, created=? WHERE id=?', (sha, now, last[0]))
                if last[4] != sha:
                    self._drop_if_unused(last[4])
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

    def copy_relation(self, key, sha):
        """How a conflict copy's text relates to what the Board wrote.

        Returns None when ``sha`` is not a Board write for this report, else
        ``(parent, later)``: the head that write replaced and the
        ``(kind, sha, created)`` of every history entry after it.
        """
        with self.lock:
            row = self.db.execute(f'SELECT id FROM events WHERE key=? AND sha=? AND kind IN {_WRITE_KINDS} '
                                  'ORDER BY id DESC LIMIT 1', (key, sha)).fetchone()
            if not row:
                return None
            parent = self.db.execute(f'SELECT sha FROM events WHERE key=? AND id<? AND kind NOT IN {_DRAFT_KINDS} '
                                     'ORDER BY id DESC LIMIT 1', (key, row[0])).fetchone()
            later = self.db.execute(f'SELECT kind, sha, created FROM events WHERE key=? AND id>? AND kind NOT IN {_DRAFT_KINDS} '
                                    'ORDER BY id', (key, row[0])).fetchall()
        return (parent[0] if parent else None), later

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

    def prune(self, base_days=BASE_DAYS):
        """Forget bases unused for ``base_days`` and blobs nothing refers to."""
        cutoff = time.time() - base_days * 86400
        with self.lock:
            self.db.execute('DELETE FROM bases WHERE used<?', (cutoff,))
            # Blobs younger than an hour may belong to an event being recorded.
            self.db.execute('DELETE FROM blobs WHERE created<? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.sha=blobs.sha) '
                            'AND NOT EXISTS (SELECT 1 FROM bases b WHERE b.sha=blobs.sha)', (time.time() - 3600,))

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
        self.tried = ()


class LiveReports:
    def __init__(self, root, state_dir, *, editable=None, poll_interval=1.0, idle_seconds=30, hook=None,
                 evict_seconds=EVICT_SECONDS):
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
        self.pruned = time.monotonic()
        self.evict_seconds = evict_seconds
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
            # Set under docs_lock so the watcher never evicts a document a
            # request has just picked up.
            doc.touched = time.monotonic()
            return doc

    def _forget_unopened(self, doc):
        """Drop a document entry created for a path that never opened."""
        with self.docs_lock:
            if doc.head is None and not doc.subscribers and self.docs.get(doc.relative) is doc:
                del self.docs[doc.relative]

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
        if first:
            # After a restart or eviction, only record what history lacks.
            last = self.history.last(doc.relative)
            if last is None:
                self.history.record(doc.relative, sha, 'observed', 'File on disk')
            elif last != sha:
                self.history.record(doc.relative, sha, 'external', 'Changed outside the Board')
        elif sha != doc.head:
            self.history.record(doc.relative, sha, 'external', 'Changed outside the Board')
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
            if doc.reason == 'not_utf8':
                raise ReportUnavailable('not UTF-8')
            # Opening only lists conflict copies; the watcher resolves them.
            self._refresh_copies(doc, resolve=False)
            self.history.hand_out(doc.relative, doc.head)
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
            try:
                theirs = _normalize(displaced.decode('utf-8'))
            except UnicodeDecodeError:
                # Bytes this server cannot merge: put them back untouched.
                doc.text, doc.head = previous, revision_of(previous)
                self._put_back(doc, displaced)
            self.history.record(doc.relative, self.history.put(theirs), 'external', 'Changed outside the Board')
            merged, conflicted = merge3(previous, target, theirs, self.workdir)
            if conflicted:
                # Nothing may leave the disk on a conflict: put the late
                # writer's version back as the head, so the editor resolves
                # against it and a save from the old base conflicts again.
                merged, conflicted = self._restore_displaced(doc, previous, target, displaced, theirs)
            if conflicted or merged == doc.text:
                return merged, conflicted
            target, kind = merged, 'merged'
        raise ReportUnavailable('report keeps changing; retry')

    def _restore_displaced(self, doc, previous, target, displaced, theirs):
        for _ in range(5):
            dir_fd, name = _open_parent(self.root, doc.relative)
            try:
                again = _replace(dir_fd, name, displaced, doc.raw)
            except _Changed as changed:
                self._adopt(doc, changed.current)
                return merge3(previous, target, doc.text, self.workdir)
            finally:
                os.close(dir_fd)
            sha = self.history.put(theirs)
            self.history.record(doc.relative, sha, 'external', 'Changed outside the Board')
            doc.text, doc.head, doc.raw, doc.crlf = theirs, sha, displaced, _crlf(displaced)
            self._refresh_identity(doc)
            if again is None:
                return merge3(previous, target, doc.text, self.workdir)
            # Yet another late write: keep it too and merge it with theirs.
            try:
                later = _normalize(again.decode('utf-8'))
            except UnicodeDecodeError:
                self._put_back(doc, again)
            self.history.record(doc.relative, self.history.put(later), 'external', 'Changed outside the Board')
            combined, clash = merge3(previous, theirs, later, self.workdir)
            if clash:
                combined = later  # keep the newest on disk; both are in history
            displaced, theirs = _encode(combined, doc.crlf), combined
        raise ReportUnavailable('report keeps changing; retry')

    def _put_back(self, doc, data):
        """Return non-UTF-8 bytes displaced by a write to disk, then refuse edits.

        Always raises: NotEditable when the bytes are back on disk, or
        ReportUnavailable when yet another writer replaced them meanwhile.
        """
        original = data
        for _ in range(5):
            dir_fd, name = _open_parent(self.root, doc.relative)
            try:
                again = _replace(dir_fd, name, data, doc.raw)
            except _Changed:
                break  # a newer write is on disk; the next observation reads it
            finally:
                os.close(dir_fd)
            doc.raw = data
            if again is None:
                break
            data = again  # an even later write was displaced: keep that one
        doc.identity = None
        if doc.raw == original:
            doc.editable, doc.reason = False, 'not_utf8'
            raise NotEditable('not_utf8')
        doc.raw = None
        raise ReportUnavailable('report keeps changing; retry')

    def _adopt(self, doc, data):
        try:
            text = _normalize(data.decode('utf-8'))
        except UnicodeDecodeError:
            # Nothing was written; leave the bytes alone and stop editing.
            doc.raw, doc.editable, doc.reason, doc.identity = data, False, 'not_utf8', None
            raise NotEditable('not_utf8') from None
        sha = self.history.put(text)
        self.history.record(doc.relative, sha, 'external', 'Changed outside the Board')
        doc.raw, doc.text, doc.head, doc.crlf = data, text, sha, _crlf(data)
        self._refresh_identity(doc)
        self._broadcast(doc, {'type': 'changed', 'revision': sha, 'author': 'Changed outside the Board'})

    @staticmethod
    def _refresh_identity(doc):
        # Do not stat the path after a write: an outside rename landing right
        # after the exchange would be taken for our own file and never
        # announced. Clearing the identity makes the watcher read the file
        # once more; if it still holds what we wrote, nothing is announced.
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
            sent = self.history.put(content, relative, client or '')
            if base == doc.head:
                target, conflicted = content, False
            else:
                target, conflicted = merge3(self.history.text(relative, base), content, doc.text, self.workdir)
            if not conflicted and target != doc.text:
                target, conflicted = self._write(doc, target, kind, author, client)
            if doc.head != before:
                self._broadcast(doc, {'type': 'changed', 'revision': doc.head,
                                      'author': author if not conflicted else 'Changed outside the Board',
                                      **({'client': client} if not conflicted else {})})
            # The client may send any revision returned here back as a base.
            self.history.hand_out(relative, doc.head, client)
            if conflicted:
                self.history.record(relative, sent, 'conflict_draft', author, client)
                return {'status': 'conflict', 'revision': doc.head, 'content': target, 'sent_revision': sent}
            # It has moved on from its older private bases.
            self.history.release_client(relative, client, (doc.head, sent))
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
            return {'merged': doc.text, 'conflicted': False}
        relation = self.history.copy_relation(doc.relative, sha)
        base = relation[0] if relation else self.history.likely_base(doc.relative, info.st_mtime_ns / 1e9 + 1)
        base_text = self.history.text(doc.relative, base) if base else None
        merged, conflicted = merge3(base_text, doc.text, text, self.workdir, COPY_LABELS)
        return {'merged': merged, 'conflicted': conflicted}

    def _refresh_copies(self, doc, resolve):
        copies = self._copy_names(doc)
        if resolve and copies and copies != doc.tried:
            for name, _, _ in copies:
                try:
                    self._auto_resolve(doc, name)
                except (OSError, KeyError, ReportUnavailable, NotEditable, UnicodeError):
                    continue
            copies = doc.tried = self._copy_names(doc)
        if copies == doc.copies:
            return
        doc.copies = copies
        self._broadcast(doc, {'type': 'sync_conflicts', 'copies': [self._copy_info(c) for c in doc.copies]})

    def _archive_copy(self, doc, name, text):
        sha = self.history.put(text)
        self.history.record(doc.relative, sha, 'sync_conflict', f'Syncthing conflict copy {name}')

    def _auto_resolve(self, doc, name):
        """Fold back a Board write that lost a Syncthing conflict.

        Only two cases are handled without review; every other copy stays
        listed for the person editing:

        * the copy holds the newest Board write and the only change after it
          is the one Syncthing put in its place (the copy was created no later
          than that change was seen): merge it from the head it replaced;
        * the copy holds a Board write that later Board saves built on, with
          no outside change since: the head already contains it, so it is
          archived and removed without merging. Merging there could bring
          back text a later save deleted on purpose.
        """
        if not doc.editable or doc.missing:
            return
        text, info = self._read_copy(doc, name)
        sha = revision_of(text)
        if sha != doc.head:
            relation = self.history.copy_relation(doc.relative, sha)
            if relation is None:
                return
            parent, later = relation
            writes = [kind in ('board', 'merged', 'restore') for kind, _, _ in later]
            if not later or not all(writes):
                if len(later) != 1 or any(writes):
                    return
                _, head, seen = later[0]
                if head != doc.head or info.st_ctime_ns / 1e9 > seen + 2:
                    return
                base_text = self.history.text(doc.relative, parent) if parent else None
                merged, conflicted = merge3(base_text, doc.text, text, self.workdir, COPY_LABELS)
                if conflicted:
                    return
                self._archive_copy(doc, name, text)
                if merged != doc.text:
                    _, conflicted = self._write(doc, merged, 'merged', 'Merged a Syncthing conflict copy', None)
                    if conflicted:
                        return
                    self._broadcast(doc, {'type': 'changed', 'revision': doc.head, 'author': 'Merged a Syncthing conflict copy'})
                self._remove_copy(doc, name, info)
                return
        self._archive_copy(doc, name, text)
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
            doc.copies = doc.tried = self._copy_names(doc)
            self._broadcast(doc, {'type': 'sync_conflicts', 'copies': [self._copy_info(c) for c in doc.copies]})
            return {**(result or {'status': 'discarded', 'revision': doc.head}), 'copy_removed': removed}

    # -- live updates ----------------------------------------------------
    def subscribe(self, relative):
        doc = self._doc(relative)
        subscriber = queue.Queue(SUBSCRIBER_QUEUE)
        with doc.lock:
            try:
                self._observe(doc)
                if doc.missing or doc.reason == 'not_utf8':
                    raise ReportUnavailable('missing or not UTF-8')
            except ReportUnavailable:
                self._forget_unopened(doc)
                raise
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
            self._tick()

    def _tick(self):
        now = time.monotonic()
        if now - self.pruned > PRUNE_SECONDS:
            self.pruned = now
            try:
                self.history.prune()
            except sqlite3.Error:
                pass
        with self.docs_lock:
            for relative, doc in list(self.docs.items()):
                if doc.subscribers or now - doc.touched <= self.evict_seconds or not doc.lock.acquire(blocking=False):
                    continue
                try:
                    if not doc.subscribers:
                        del self.docs[relative]
                finally:
                    doc.lock.release()
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
                    self._refresh_copies(doc, resolve=True)
            except (OSError, ReportUnavailable, NotEditable, sqlite3.Error):
                continue

    def close(self):
        self.stopped.set()
        self.watcher.join(timeout=5)
        self.history.close()
