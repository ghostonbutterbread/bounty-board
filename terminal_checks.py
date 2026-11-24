"""Per-report "Checked" state for the code blocks of a report.

Check marks are never written into the report. They live in a small SQLite
database in the terminal service's state directory, keyed by the report
selector and a block key.

Block key: ``<sha256(normalised block text)[:32]>:<n>`` where ``n`` counts
earlier blocks in the same report with identical text (0 for the first).
Consequences, which the browser module mirrors exactly:

- Editing a block changes only that block's key, so only it loses its mark.
- Moving blocks around keeps their marks (the key is not a position).
- Two identical blocks are told apart by their order among identical blocks.

Normalisation: CRLF to LF, trailing whitespace stripped from every line, and
leading/trailing blank lines dropped, so re-indenting the fence or a stray
trailing space does not reset a mark.
"""
import hashlib
import json
import re
import sqlite3
import threading
import time
from pathlib import Path

KEY_RE = re.compile(r'^[0-9a-f]{32}:\d{1,4}$')
MAX_KEYS_PER_REPORT = 500


def normalise(text):
    lines = [line.rstrip() for line in str(text).replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return '\n'.join(lines)


def block_keys(texts):
    seen = {}
    keys = []
    for text in texts:
        digest = hashlib.sha256(normalise(text).encode('utf-8')).hexdigest()[:32]
        n = seen.get(digest, 0)
        seen[digest] = n + 1
        keys.append(f'{digest}:{n}')
    return keys


class CheckStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS checks (report TEXT NOT NULL, key TEXT NOT NULL, '
                        'checked_at REAL NOT NULL, PRIMARY KEY (report, key))')

    @staticmethod
    def report_id(selector):
        return json.dumps([selector['family'], selector['program'], selector['lane'], selector['path']])

    def get(self, selector):
        with self.lock:
            rows = self.db.execute('SELECT key, checked_at FROM checks WHERE report = ?', (self.report_id(selector),)).fetchall()
        return {key: at for key, at in rows}

    def set(self, selector, key, checked):
        """Mark or unmark one block. Returns False when the per-report cap is reached."""
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise ValueError('invalid block key')
        report = self.report_id(selector)
        with self.lock:
            if not checked:
                self.db.execute('DELETE FROM checks WHERE report = ? AND key = ?', (report, key))
                return True
            count = self.db.execute('SELECT COUNT(*) FROM checks WHERE report = ?', (report,)).fetchone()[0]
            exists = self.db.execute('SELECT 1 FROM checks WHERE report = ? AND key = ?', (report, key)).fetchone()
            if not exists and count >= MAX_KEYS_PER_REPORT:
                return False
            self.db.execute('INSERT OR REPLACE INTO checks (report, key, checked_at) VALUES (?, ?, ?)', (report, key, time.time()))
            return True

    def close(self):
        with self.lock:
            self.db.close()
