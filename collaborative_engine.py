"""Offline collaboration prototype. Never reads or writes source report files.

The caller supplies each observed source snapshot. SQLite serializes clients that
share this one database, not independent databases or arbitrary file writers.
This module is intentionally not connected to the server or browser.
"""
import hashlib
import os
import sqlite3
import stat
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path

MAX_BYTES = 5_000_000


def _revision(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > MAX_BYTES:
        raise ValueError('invalid or oversized content')
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


class CollaborationStore:
    def __init__(self, root):
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
                CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, head TEXT NOT NULL, source TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS versions (key TEXT NOT NULL, revision TEXT NOT NULL, content TEXT NOT NULL,
                    PRIMARY KEY (key, revision));
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL,
                    revision TEXT NOT NULL, base TEXT, head TEXT NOT NULL);
            ''')

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
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
        db.execute('INSERT OR IGNORE INTO versions VALUES (?, ?, ?)', (key, rev, text))
        return rev

    @staticmethod
    def _text(db, key, rev):
        row = db.execute('SELECT content FROM versions WHERE key=? AND revision=?', (key, rev)).fetchone()
        if row is None:
            raise ValueError('unknown base revision')
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
        db.execute('INSERT INTO events (key,kind,revision,base,head) VALUES (?,?,?,?,?)',
                   (key, kind + ':' + status, incoming, base, new_head))
        db.execute('UPDATE documents SET head=? WHERE key=?', (new_head, key))
        return {'status': status, 'revision': new_head, 'content': current if merged is None else merged,
                'incoming_revision': incoming}

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

    def submit(self, key, base, content):
        key = self._key(key)
        _revision(content)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT head FROM documents WHERE key=?', (key,)).fetchone()
            if row is None:
                raise ValueError('report has not been observed')
            return self._change(db, key, row[0], base, content, 'client')

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

    def history(self, key):
        key = self._key(key)
        with self._connect() as db:
            rows = db.execute('SELECT e.id,e.kind,e.revision,e.base,e.head,v.content,h.content FROM events e '
                              'JOIN versions v ON e.key=v.key AND e.revision=v.revision '
                              'JOIN versions h ON e.key=h.key AND e.head=h.revision '
                              'WHERE e.key=? ORDER BY e.id', (key,)).fetchall()
            return [dict(zip(('id', 'kind', 'revision', 'base', 'head', 'content', 'head_content'), row)) for row in rows]
