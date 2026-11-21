"""Shared revision storage. Never reads or writes source report files.

The caller supplies each observed source snapshot. SQLite serializes clients that
share this one database, not independent databases or arbitrary file writers.
The application owns source observation and publication.
"""
import fcntl
import hashlib
import json
import os
import sqlite3
import stat
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path

MAX_BYTES = 5_000_000
HISTORY_PAGE_SIZE = 50
DEFAULT_STORE_BYTES = 512 * 1024 * 1024


def _revision(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > MAX_BYTES:
        raise ValueError('invalid or oversized content')
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


class CollaborationStore:
    def __init__(self, root, max_store_bytes=DEFAULT_STORE_BYTES):
        if type(max_store_bytes) is not int or max_store_bytes < 65536:
            raise ValueError('invalid store size limit')
        self.max_store_bytes = max_store_bytes
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise PermissionError('store directory must be owner-only')
        self.path = self.root / 'collaboration.sqlite3'
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise PermissionError('store database must be owner-only')
        finally:
            os.close(fd)
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS source_roots (path TEXT PRIMARY KEY, device INTEGER NOT NULL, inode INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, head TEXT NOT NULL, source TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS versions (key TEXT NOT NULL, revision TEXT NOT NULL, content TEXT NOT NULL,
                    PRIMARY KEY (key, revision));
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL,
                    revision TEXT NOT NULL, base TEXT, head TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS requests (key TEXT NOT NULL, request_id TEXT NOT NULL,
                    payload TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (key, request_id));
                CREATE TABLE IF NOT EXISTS resolutions (key TEXT NOT NULL, conflict_id INTEGER NOT NULL,
                    revision TEXT NOT NULL, PRIMARY KEY (key, conflict_id));
                CREATE TABLE IF NOT EXISTS retained_operations (key TEXT NOT NULL, operation TEXT NOT NULL,
                    base TEXT NOT NULL, merge_base TEXT NOT NULL, PRIMARY KEY (key, operation));
                CREATE TABLE IF NOT EXISTS retained_requests (key TEXT NOT NULL, operation TEXT NOT NULL,
                    request_id TEXT NOT NULL, revision TEXT NOT NULL, event_id INTEGER NOT NULL, result TEXT NOT NULL,
                    PRIMARY KEY (key, operation, request_id));
                CREATE TABLE IF NOT EXISTS publication_attempts (key TEXT NOT NULL, operation TEXT NOT NULL,
                    state TEXT NOT NULL, PRIMARY KEY (key, operation));
                CREATE INDEX IF NOT EXISTS events_key_id ON events (key, id DESC);
                CREATE INDEX IF NOT EXISTS events_conflicts ON events (key, id) WHERE kind LIKE '%:conflict';
                CREATE INDEX IF NOT EXISTS publication_key_order ON publication_attempts (key);
                CREATE INDEX IF NOT EXISTS retained_key_order ON retained_requests (key, operation);
            ''')

    def bind_source(self, root):
        path = Path(root).resolve(strict=True)
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('source root must be a directory')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT device,inode FROM source_roots WHERE path=?', (str(path),)).fetchone()
            if row is None:
                # Existing pre-binding stores cannot prove which directory
                # generated their histories; retain them, but do not guess.
                if db.execute('SELECT 1 FROM documents LIMIT 1').fetchone() and not db.execute('SELECT 1 FROM source_roots LIMIT 1').fetchone():
                    raise ValueError('legacy history has no source identity; use a new private store and retain the old one')
                db.execute('INSERT INTO source_roots VALUES (?,?,?)', (str(path), info.st_dev, info.st_ino))
            elif row != (info.st_dev, info.st_ino):
                raise ValueError('source directory changed; retain history and use a new private store')

    @contextmanager
    def observation(self):
        # All server processes sharing this store must hold the same lock from
        # before the source read through the subsequent database operation.
        fd = os.open(self.root / 'observation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise PermissionError('observation lock must be owner-only')
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            page_size = db.execute('PRAGMA page_size').fetchone()[0]
            db.execute(f'PRAGMA max_page_count={max(1, self.max_store_bytes // page_size)}')
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _key(key):
        if not isinstance(key, str) or not key or len(key) > 4096 or '\0' in key:
            raise ValueError('invalid report key')
        return key

    @staticmethod
    def _put(db, key, text):
        rev = _revision(text)
        if db.execute('INSERT OR IGNORE INTO versions VALUES (?, ?, ?)', (key, rev, text)).rowcount == 0:
            CollaborationStore._text(db, key, rev)
        return rev

    @staticmethod
    def _text(db, key, rev):
        row = db.execute('SELECT content FROM versions WHERE key=? AND revision=?', (key, rev)).fetchone()
        if row is None:
            raise ValueError('unknown base revision')
        if _revision(row[0]) != rev:
            raise ValueError('corrupt retained version')
        return row[0]

    def _merge(self, current, base, incoming):
        if any('\x00' in text for text in (current, base, incoming)):
            return None
        # git's mature line merge returns a conflict count; fatal errors fail closed.
        with tempfile.TemporaryDirectory(prefix='merge-', dir=self.root) as tmp:
            paths = [Path(tmp) / name for name in ('current', 'base', 'incoming')]
            for path, text in zip(paths, (current, base, incoming)):
                path.write_text(text, encoding='utf-8', newline='')
            result = subprocess.run(['git', 'merge-file', '-p', '--', *(str(p) for p in paths)],
                                    capture_output=True, timeout=15, check=False)
        # git returns the conflict count (capped at 127); fatal errors return 255.
        if 1 <= result.returncode <= 127:
            return None
        if result.returncode != 0:
            raise RuntimeError('merge failed')
        merged = result.stdout.decode('utf-8')
        _revision(merged)
        return merged

    def _change(self, db, key, head, base, content, kind):
        # Validate the base before retaining the submitted version.
        base_text = self._text(db, key, base)
        current = self._text(db, key, head)
        incoming = self._put(db, key, content)
        if head == base or current == base_text:
            merged, status = content, 'saved'
        elif incoming == base or content == current:
            merged, status = current, 'unchanged'
        else:
            merged = self._merge(current, base_text, content)
            status = 'conflict' if merged is None else 'merged'
        new_head = head if merged is None else self._put(db, key, merged)
        event = db.execute('INSERT INTO events (key,kind,revision,base,head) VALUES (?,?,?,?,?)',
                           (key, kind + ':' + status, incoming, base, new_head))
        db.execute('UPDATE documents SET head=? WHERE key=?', (new_head, key))
        result = {'status': status, 'revision': new_head, 'content': current if merged is None else merged,
                  'incoming_revision': incoming}
        if status == 'conflict':
            result['conflict_id'] = event.lastrowid
        return result

    def observe_source(self, key, content):
        key = self._key(key)
        rev = _revision(content)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT head, source FROM documents WHERE key=?', (key,)).fetchone()
            if row is None:
                self._put(db, key, content)
                db.execute('INSERT INTO documents VALUES (?,?,?)', (key, rev, rev))
                db.execute('INSERT INTO events (key,kind,revision,base,head) VALUES (?,?,?,?,?)',
                           (key, 'source:initial', rev, None, rev))
                return {'status': 'initial', 'revision': rev, 'content': content, 'incoming_revision': rev}
            head, source = row
            if source == rev:
                return {'status': 'unchanged', 'revision': head, 'content': self._text(db, key, head), 'incoming_revision': rev}
            result = self._change(db, key, head, source, content, 'source')
            db.execute('UPDATE documents SET source=? WHERE key=?', (rev, key))
            return result

    def observe_retained(self, key, operation, base, content, request_id):
        """Record one observed snapshot of a displaced inode, not a source save.

        Callers must durably identify and serialize observations in their actual
        observation order. Repeated bytes return the earlier historical result,
        not necessarily the current head. A conflicting snapshot is retained
        without advancing the merge base. This method neither reads nor watches
        an inode.
        """
        key = self._key(key)
        for value in (operation, request_id):
            if not isinstance(value, str) or not value or len(value) > 200 or '\0' in value:
                raise ValueError('invalid observation identity')
        revision = _revision(content)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._text(db, key, base)
            row = db.execute('SELECT base,merge_base FROM retained_operations WHERE key=? AND operation=?',
                             (key, operation)).fetchone()
            if row is None:
                db.execute('INSERT INTO retained_operations VALUES (?,?,?,?)', (key, operation, base, base))
                merge_base = base
            elif row[0] != base:
                raise ValueError('operation base changed')
            else:
                merge_base = row[1]
            old = db.execute('SELECT revision,result FROM retained_requests WHERE key=? AND operation=? AND request_id=?',
                             (key, operation, request_id)).fetchone()
            if old is not None:
                if old[0] != revision:
                    raise ValueError('observation id reused')
                return json.loads(old[1])
            latest = db.execute('SELECT revision,event_id,result FROM retained_requests '
                                'WHERE key=? AND operation=? ORDER BY rowid DESC LIMIT 1',
                                (key, operation)).fetchone()
            if latest is not None and latest[0] == revision:
                db.execute('INSERT INTO retained_requests VALUES (?,?,?,?,?,?)',
                           (key, operation, request_id, revision, latest[1], latest[2]))
                return json.loads(latest[2])
            document = db.execute('SELECT head FROM documents WHERE key=?', (key,)).fetchone()
            if document is None:
                raise ValueError('report has not been observed')
            result = self._change(db, key, document[0], merge_base, content, 'retained')
            event_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
            if result['status'] != 'conflict':
                db.execute('UPDATE retained_operations SET merge_base=? WHERE key=? AND operation=?',
                           (revision, key, operation))
            db.execute('INSERT INTO retained_requests VALUES (?,?,?,?,?,?)',
                       (key, operation, request_id, revision, event_id, json.dumps(result, ensure_ascii=False)))
            return result

    def retained_provenance(self, key, event_id):
        """Resolve an observation event within its report's history."""
        key = self._key(key)
        if type(event_id) is not int or not 1 <= event_id <= 9223372036854775807:
            raise ValueError('invalid event')
        with self._connect() as db:
            row = db.execute('SELECT r.operation,r.request_id,o.base FROM retained_requests r '
                             'JOIN retained_operations o ON o.key=r.key AND o.operation=r.operation '
                             'WHERE r.key=? AND r.event_id=? ORDER BY r.rowid LIMIT 1', (key, event_id)).fetchone()
            if row is None:
                raise ValueError('unknown retained observation')
            return dict(zip(('operation', 'request_id', 'base'), row))

    def publication_page(self, key, after, limit):
        """Operations in creation order, bounded independently of store size."""
        with self._connect() as db:
            return db.execute('SELECT rowid,operation,state FROM publication_attempts '
                              'WHERE key=? AND rowid>? ORDER BY rowid LIMIT ?',
                              (self._key(key), after, limit)).fetchall()

    def retained_latest(self, key, operation):
        with self._connect() as db:
            row = db.execute('SELECT revision FROM retained_requests WHERE key=? AND operation=? '
                             'ORDER BY rowid DESC LIMIT 1', (self._key(key), operation)).fetchone()
            return None if row is None else row[0]

    def publication_state(self, key, operation):
        with self._connect() as db:
            row = db.execute('SELECT state FROM publication_attempts WHERE key=? AND operation=?', (self._key(key), operation)).fetchone()
            return None if row is None else row[0]

    def begin_publication(self, key, operation):
        with self._connect() as db:
            db.execute('INSERT INTO publication_attempts VALUES (?,?,?)', (self._key(key), operation, 'pending'))

    def complete_publication(self, key, operation, state):
        if state not in ('published', 'conflict', 'outcome_uncertain'):
            raise ValueError('invalid publication state')
        with self._connect() as db:
            if db.execute('UPDATE publication_attempts SET state=? WHERE key=? AND operation=? AND state=?',
                          (state, self._key(key), operation, 'pending')).rowcount != 1:
                raise ValueError('publication attempt is not pending')

    def request_result(self, key, request_id):
        """Look up a previously committed request without submitting it again."""
        key = self._key(key)
        if not isinstance(request_id, str) or not request_id or len(request_id) > 200:
            raise ValueError('invalid request id')
        with self._connect() as db:
            row = db.execute('SELECT result FROM requests WHERE key=? AND request_id=?', (key, request_id)).fetchone()
            return None if row is None else json.loads(row[0])

    def receipt(self, key, base, content, request_id, conflict_id=None):
        """Return only an exact previously committed request; never create work."""
        key = self._key(key)
        _revision(content)
        if not isinstance(request_id, str) or not request_id or len(request_id) > 200:
            raise ValueError('invalid request id')
        payload = json.dumps([base, content, conflict_id], ensure_ascii=False)
        with self._connect() as db:
            row = db.execute('SELECT payload,result FROM requests WHERE key=? AND request_id=?',
                             (key, request_id)).fetchone()
            if row is None:
                return None
            if row[0] != payload:
                raise ValueError('request id reused')
            return json.loads(row[1])

    def submit(self, key, base, content, request_id=None, conflict_id=None):
        key = self._key(key)
        _revision(content)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if request_id is not None:
                if not isinstance(request_id, str) or not request_id or len(request_id) > 200:
                    raise ValueError('invalid request id')
                payload = json.dumps([base, content, conflict_id], ensure_ascii=False)
                previous = db.execute('SELECT payload,result FROM requests WHERE key=? AND request_id=?',
                                      (key, request_id)).fetchone()
                if previous:
                    if previous[0] != payload:
                        raise ValueError('request id reused')
                    return json.loads(previous[1])
            row = db.execute('SELECT head FROM documents WHERE key=?', (key,)).fetchone()
            if row is None:
                raise ValueError('report has not been observed')
            if conflict_id is not None:
                if type(conflict_id) is not int or row[0] != base:
                    raise ValueError('stale resolution')
                conflict = db.execute("SELECT id FROM events WHERE key=? AND id=? AND kind LIKE '%:conflict'", (key, conflict_id)).fetchone()
                resolved = db.execute('SELECT 1 FROM resolutions WHERE key=? AND conflict_id=?', (key, conflict_id)).fetchone()
                if not conflict or resolved:
                    raise ValueError('unknown or resolved conflict')
            result = self._change(db, key, row[0], base, content, 'resolution' if conflict_id is not None else 'client')
            if conflict_id is not None:
                db.execute('INSERT INTO resolutions VALUES (?,?,?)', (key, conflict_id, result['revision']))
            if request_id is not None:
                db.execute('INSERT INTO requests VALUES (?,?,?,?)',
                           (key, request_id, payload, json.dumps(result, ensure_ascii=False)))
            return result

    def restore(self, key, expected_head, revision):
        """Restore a retained version only if the caller's observed head is current."""
        key = self._key(key)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT head FROM documents WHERE key=?', (key,)).fetchone()
            if row is None or row[0] != expected_head:
                raise ValueError('head changed')
            content = self._text(db, key, revision)
            return self._change(db, key, expected_head, expected_head, content, 'restore')

    def current(self, key):
        key = self._key(key)
        with self._connect() as db:
            row = db.execute('SELECT head FROM documents WHERE key=?', (key,)).fetchone()
            return None if row is None else {'revision': row[0], 'content': self._text(db, key, row[0])}

    def unresolved_count(self, key):
        key = self._key(key)
        with self._connect() as db:
            return db.execute("SELECT count(*) FROM events e LEFT JOIN resolutions r "
                              "ON e.key=r.key AND e.id=r.conflict_id WHERE e.key=? "
                              "AND e.kind LIKE '%:conflict' AND r.revision IS NULL", (key,)).fetchone()[0]

    def version(self, key, revision):
        import re
        key = self._key(key)
        if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{64}', revision):
            raise ValueError('invalid revision')
        with self._connect() as db:
            return {'revision': revision, 'content': self._text(db, key, revision)}

    def history_page(self, key, before=None):
        key = self._key(key)
        if before is not None and (type(before) is not int or not 1 <= before <= 9223372036854775807):
            raise ValueError('invalid cursor')
        with self._connect() as db:
            db.execute('BEGIN')
            count = db.execute("SELECT count(*) FROM events e LEFT JOIN resolutions r "
                               "ON e.key=r.key AND e.id=r.conflict_id WHERE e.key=? "
                               "AND e.kind LIKE '%:conflict' AND r.revision IS NULL", (key,)).fetchone()[0]
            cursor_clause = '' if before is None else 'AND e.id < ? '
            params = (key, HISTORY_PAGE_SIZE + 1) if before is None else (key, before, HISTORY_PAGE_SIZE + 1)
            rows = db.execute('SELECT e.id,e.kind,e.revision,e.base,e.head,r.revision FROM events e '
                              'LEFT JOIN resolutions r ON e.key=r.key AND e.id=r.conflict_id '
                              'WHERE e.key=? ' + cursor_clause + 'ORDER BY e.id DESC LIMIT ?', params).fetchall()
            more = len(rows) > HISTORY_PAGE_SIZE
            rows = rows[:HISTORY_PAGE_SIZE]
            return {'history': [dict(zip(('id', 'kind', 'revision', 'base', 'head', 'resolved_revision'), row)) for row in rows],
                    'next_before': rows[-1][0] if more else None, 'unresolved_count': count}
