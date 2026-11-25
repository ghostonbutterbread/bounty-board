"""Recon intel: read-only depth summaries from BBH recon stores.

Sources per web lane (all optional, each reported separately):
  * URL index   <lane>/recon/url_index/url_index.sqlite (BBH agents/url_ingest.py)
  * JS library  <artifact_root>/<program>/<lane>/recon/js/_library/js_info.sqlite
                (BBH agents/js_analyzer.py), falling back to the same path under
                the Board root when the artifact tier has none
  * Aggregates  <lane>/recon/aggregated/*.txt and recon/js/*.txt (line counts)
  * Board data  ledgers/ledger.json findings, ledgers/surface_coverage.sqlite,
                recon/maps/map.jsonl (through the app's own readers)

Rules: SQLite is opened read-only (file:...?mode=ro, PRAGMA query_only, busy
timeout) with a progress handler that interrupts any statement over the
per-query budget. Big tables are never scanned in full: their sizes come from
MAX(id) (AUTOINCREMENT ids; deletions make it an upper bound), distinct values
from bounded index skip-scans, and distributions from rowid-window samples.
Every number that is not exact carries approximate=True. Work runs on one
background thread; results are cached per source keyed by the file signature
(size and mtime of the database and its -wal), so requests never block on
SQLite and repeated loads are instant. downloads/, chunks/ and sourcemaps/ of a
JS library are never touched; ledger.json of the library is not read.
"""
import json
import os
import re
import sqlite3
import stat
import threading
import time
from collections import Counter, OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from taxonomy import annotate_finding

QUERY_BUDGET = 3.0          # seconds per SQL statement
SAMPLE_BUDGET_FACTOR = 4    # a whole sample may take this many query budgets
SAMPLE_WINDOWS = 48
SAMPLE_WINDOW_ROWS = 500
EXACT_ROW_LIMIT = 200_000   # tables at most this big get exact aggregates
SKIP_SCAN_LIMIT = 5000      # distinct values enumerated through an index
REFRESH_INTERVAL = 120.0    # a changed source is recomputed at most this often
LINE_COUNT_CAP = 64 << 20   # bytes read per aggregate file before estimating
CACHE_ENTRIES = 512
LIST_LIMIT = 50
GROUP_LIMIT = 500           # grouped breakdowns and per-host joins; section marked truncated past it
TESTED_PAIRS_LIMIT = 5000   # (lane, param) pairs used to decide "untested"; larger because it affects correctness
HOST_LIMIT = 300
TEXT_LIMIT = 240
DONE_STATUSES = frozenset({'done', 'closed', 'resolved', 'dismissed', 'rejected', 'complete', 'completed',
                           'invalid', 'false_positive', 'false-positive', 'duplicate', 'wontfix', 'archived'})
AGGREGATE_FILES = ('urls.txt', 'alive.txt', 'hosts.txt', 'params.txt', 'params_raw.txt', 'jsfiles.txt',
                   'dirs.txt', 'wild.txt', 'pending_probe.txt', 'ports.jsonl')
JS_LIST_FILES = ('jsfiles.txt', 'js_urls.txt')
URL_INDEX_REL = ('recon', 'url_index', 'url_index.sqlite')
JS_LIBRARY_REL = ('recon', 'js', '_library', 'js_info.sqlite')
URL_TABLES = {
    'urls': {'id', 'canonical_url', 'route_hash', 'host', 'path', 'param_keys'},
    'test_runs': {'id', 'url_id', 'lane', 'skill', 'test_family', 'status', 'completed_at'},
}
JS_TABLES = {'js_files': {'sha256', 'byte_count', 'target_host'}}


def default_artifact_root():
    """/mnt/bounty when it is a mount point on this host, else None."""
    candidate = Path('/mnt/bounty')
    try:
        return candidate if os.path.ismount(candidate) else None
    except OSError:
        return None


class SourceError(Exception):
    """A source-level failure with a stable code for the API."""

    def __init__(self, code, detail=''):
        super().__init__(code)
        self.code = code
        self.detail = detail


class QueryTimeout(Exception):
    pass


def now_iso(offset=0.0):
    return datetime.fromtimestamp(time.time() - offset, timezone.utc).isoformat()


def to_epoch(value):
    """ISO-8601 text (BBH writes datetime.isoformat(), sometimes with Z) to epoch seconds."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


# Characters a terminal or editor can act on or hide: C0, DEL, C1, soft hyphen,
# bidi controls and invisible separators. Target-controlled values (BBH stores
# parse_qsl-decoded parameter keys) may contain them; a pasted ESC[201~ ends
# bracketed paste and the rest runs as keystrokes.
UNSAFE_CHARS = re.compile('[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff]')
# ZWNJ and ZWJ (U+200C, U+200D) are part of normal Persian/Indic text and emoji
# sequences: never offered for copying (UNSAFE_CHARS), but shown as they are.
DISPLAY_ESCAPE = re.compile('[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff]')


def _as_str(value):
    if isinstance(value, bytes):
        value = value.decode('utf-8', 'replace')
    return str(value).encode('utf-8', 'replace').decode('utf-8')


def is_unsafe(*values):
    """True when any value contains a character UNSAFE_CHARS would escape."""
    return any(v is not None and UNSAFE_CHARS.search(_as_str(v)) is not None for v in values)


def escape_unsafe(value):
    """Display-safe form: unsafe characters become \\xNN or \\uNNNN."""
    return DISPLAY_ESCAPE.sub(lambda m: f'\\x{ord(m.group()):02x}' if ord(m.group()) < 0x100 else f'\\u{ord(m.group()):04x}', _as_str(value))


def text(value, limit=TEXT_LIMIT):
    """JSON- and display-safe short string (SQLite may hold BLOBs or numbers in
    TEXT columns). Unsafe characters are escaped; callers that offer a value for
    copying also send an unsafe_chars flag computed from the raw value."""
    if value is None:
        return None
    value = escape_unsafe(value)
    return value if len(value) <= limit else value[:limit - 1] + '…'


def number(value, exact=True, method=None):
    result = {'value': value, 'approximate': not exact}
    if method:
        result['method'] = method
    return result


def file_signature(path):
    """(size, mtime_ns) of a database and its -wal; None when the file is missing."""
    try:
        main = os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return None
    try:
        wal = os.stat(str(path) + '-wal', follow_symlinks=False)
        wal_sig = (wal.st_size, wal.st_mtime_ns)
    except OSError:
        wal_sig = None
    return (main.st_size, main.st_mtime_ns, wal_sig)


def checked_path(base, parts, allow_first_symlink_within=None):
    """base/parts with no symlinked component (and no symlinked -wal/-shm).

    allow_first_symlink_within: the first component may be a symlink only when
    it resolves inside this directory (a program directory on the artifact tier).
    Raises SourceError('missing') or SourceError('unavailable', reason)."""
    current = Path(base)
    for index, part in enumerate(parts):
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            raise SourceError('missing')
        except OSError:
            raise SourceError('unavailable', 'unreadable')
        if stat.S_ISLNK(info.st_mode):
            if index == 0 and allow_first_symlink_within is not None:
                try:
                    if Path(current).resolve(strict=True).is_relative_to(Path(allow_first_symlink_within).resolve(strict=True)):
                        continue
                except OSError:
                    pass
                raise SourceError('unavailable', 'symlink_outside_root')
            raise SourceError('unavailable', 'symlink')
    for suffix in ('-wal', '-shm', '-journal'):
        if os.path.islink(str(current) + suffix):
            raise SourceError('unavailable', 'symlink')
    if not current.is_file():
        raise SourceError('unavailable', 'not_a_file')
    return current


def _lstat(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError:
        raise SourceError('unavailable', 'database side files unreadable')


def open_plan(path):
    """How to open a database without creating, modifying or leaving any file.

    Returns 'immutable' or 'ro'; raises SourceError('unavailable', reason) when
    the writer state is unclear. The journal mode comes from the header (bytes
    18-19: 1 rollback, 2 WAL), read without following symlinks.
      WAL, no -wal and no -shm, or an empty -wal: immutable=1 (the main file
        holds every committed page; nothing to miss, nothing created).
      WAL, non-empty -wal and an existing -shm (a writer is active): plain
        mode=ro, which opens the existing files and creates nothing.
      WAL, anything else (-wal without -shm, -shm without -wal): not opened.
      Rollback journal: plain mode=ro (a reader never creates a journal and
        still honours a writer's lock)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise SourceError('missing')
    except OSError:
        raise SourceError('unavailable', 'database unreadable')
    try:
        header = os.read(fd, 100)
    finally:
        os.close(fd)
    if len(header) < 100 or not header.startswith(b'SQLite format 3\x00'):
        raise SourceError('invalid', 'not a readable SQLite database')
    wal, shm = _lstat(str(path) + '-wal'), _lstat(str(path) + '-shm')
    journal = _lstat(str(path) + '-journal')
    # A FIFO or device here would block the single worker thread inside SQLite.
    if any(info is not None and not stat.S_ISREG(info.st_mode) for info in (wal, shm, journal)):
        raise SourceError('unavailable', 'a database side file is not a regular file')
    if header[18] == 2 or header[19] == 2:
        if (wal is None and shm is None) or (wal is not None and wal.st_size == 0):
            return 'immutable'
        if wal is not None and shm is not None:
            if not os.access(str(path) + '-shm', os.R_OK):
                raise SourceError('unavailable', 'the -shm file of an active writer is not readable')
            return 'ro'
        raise SourceError('unavailable', 'writer state unclear')
    return 'ro'


class ReadOnlyDB:
    """A read-only SQLite connection whose statements are bounded in time.

    Two guards: a progress handler (between VDBE opcodes) and a watchdog thread
    that calls interrupt(), which SQLite also checks inside single long opcodes
    such as the b-tree walk behind COUNT(*)."""

    def __init__(self, path, budget=QUERY_BUDGET, busy_timeout=1.0):
        self.budget = budget
        self.deadline = None
        self.timeouts = 0
        self.closed = threading.Event()
        self.mode = open_plan(path)
        try:
            self.conn = sqlite3.connect(Path(path).resolve().as_uri() + ('?mode=ro&immutable=1' if self.mode == 'immutable' else '?mode=ro'),
                                        uri=True, timeout=busy_timeout, check_same_thread=False)
        except sqlite3.Error as error:
            raise classify(error)
        try:
            self.conn.execute('PRAGMA query_only=1')
            self.conn.set_progress_handler(self._progress, 2000)
            threading.Thread(target=self._watchdog, name='recon-intel-watchdog', daemon=True).start()
            self.tables = {row[0] for row in self.query("SELECT name FROM sqlite_master WHERE type='table'")}
        except Exception:
            self.close()
            raise

    def _watchdog(self):
        while not self.closed.wait(0.05):
            deadline = self.deadline
            if deadline is not None and time.monotonic() > deadline:
                try:
                    self.conn.interrupt()
                except sqlite3.Error:
                    pass

    def _progress(self):
        return 1 if self.deadline is not None and time.monotonic() > self.deadline else 0

    def query(self, sql, args=(), budget=None):
        self.deadline = time.monotonic() + (self.budget if budget is None else budget)
        try:
            return self.conn.execute(sql, args).fetchall()
        except sqlite3.OperationalError as error:
            if 'interrupt' in str(error).lower():
                self.timeouts += 1
                raise QueryTimeout()
            raise self._classify(error)
        except sqlite3.Error as error:
            raise self._classify(error)
        finally:
            self.deadline = None

    def _classify(self, error):
        # An immutable read can see torn pages if a writer starts or checkpoints
        # during it. Nothing is written; report it as transient so the next refresh
        # retries instead of caching the source as invalid.
        if self.mode == 'immutable' and 'malformed' in str(error).lower():
            return SourceError('changed', 'the database changed during the read; retrying')
        return classify(error)

    def one(self, sql, args=(), budget=None):
        rows = self.query(sql, args, budget)
        return rows[0][0] if rows else None

    def columns(self, table):
        if table not in self.tables:
            return set()
        return {row[1] for row in self.query(f'PRAGMA table_info("{table}")')}

    def close(self):
        self.closed.set()
        self.conn.close()


def classify(error):
    message = str(error).lower()
    if 'locked' in message or 'busy' in message:
        return SourceError('locked')
    if 'no such table' in message or 'no such column' in message:
        return SourceError('schema_mismatch', 'missing table or column')
    if 'not a database' in message or 'malformed' in message or 'file is encrypted' in message:
        return SourceError('invalid', 'not a readable SQLite database')
    if 'readonly' in message or 'read-only' in message:
        return SourceError('unavailable', 'cannot read the WAL state without writing (directory or -shm not writable)')
    if 'unable to open' in message:
        return SourceError('unavailable', 'cannot open')
    return SourceError('invalid', 'sqlite error')


def skip_scan(db, table, column, limit, budget, where=''):
    """Distinct non-empty values of an indexed column through repeated index seeks.

    Each step is one O(log n) seek, so this is cheap on huge tables with few
    distinct values. Returns (values, complete)."""
    values = []
    deadline = time.monotonic() + budget
    last = ''
    extra = f' AND {where}' if where else ''
    while len(values) < limit:
        if time.monotonic() > deadline:
            return values, False
        try:
            row = db.query(f'SELECT {column} FROM {table} WHERE {column} > ?{extra} ORDER BY {column} LIMIT 1', (last,))
        except QueryTimeout:
            return values, False
        if not row:
            return values, True
        last = row[0][0]
        if not isinstance(last, str):
            return values, False
        values.append(last)
    return values, False


def sample_windows(db, table, columns, max_id, budget, windows=SAMPLE_WINDOWS, rows=SAMPLE_WINDOW_ROWS):
    """Rows from evenly spaced rowid windows. Returns (rows, windows_read)."""
    out = []
    if not max_id:
        return out, 0
    step = max(1, max_id // windows)
    deadline = time.monotonic() + budget
    read = 0
    for index in range(windows):
        if time.monotonic() > deadline:
            break
        start = index * step + max(0, step // 2 - rows // 2)
        try:
            out.extend(db.query(f'SELECT {columns} FROM {table} WHERE id >= ? AND id < ?', (start, start + rows)))
        except QueryTimeout:
            break
        read += 1
    return out, read


def parse_keys(raw):
    try:
        value = json.loads(raw) if isinstance(raw, str) else []
    except ValueError:
        return []
    return [k for k in value if isinstance(k, str)] if isinstance(value, list) else []


def host_of(value):
    """Host of a URL or bare host string (lowercase), else None."""
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    if '://' not in candidate:
        candidate = 'https://' + candidate.split()[0]
    try:
        host = urlsplit(candidate).hostname
    except ValueError:
        return None
    return host if host and '.' in host else None


class Collector:
    """Per-source result plus a list of section-level errors."""

    def __init__(self):
        self.errors = {}
        self.approximate = False
        self.unsafe_hosts = set()
        self.truncated = {}

    def capped(self, section, rows, limit):
        """rows fetched with LIMIT limit + 1: the first limit, marking the section truncated past it."""
        if len(rows) > limit:
            self.truncated[section] = True
            return rows[:limit]
        return rows

    def host(self, raw):
        """Display-safe host key; remembers hosts whose raw value had unsafe characters."""
        key = text(raw) or ''
        if is_unsafe(raw):
            self.unsafe_hosts.add(key)
        return key

    def fail(self, section, code, detail=''):
        self.errors[section] = {'code': code, **({'detail': detail} if detail else {})}


# ---------------------------------------------------------------------------
# URL index
# ---------------------------------------------------------------------------

def url_index_summary(path, budget=QUERY_BUDGET, detail=True, exact_limit=EXACT_ROW_LIMIT,
                      sample_windows_n=SAMPLE_WINDOWS, sample_rows=SAMPLE_WINDOW_ROWS):
    """Depth summary of one url_index.sqlite. Raises SourceError for whole-source failures."""
    started = time.monotonic()
    db = ReadOnlyDB(path, budget)
    c = Collector()
    try:
        cols = {table: db.columns(table) for table in ('urls', 'test_runs', 'observations', 'parameter_observations', 'imports')}
        for table, needed in URL_TABLES.items():
            if not needed <= cols[table]:
                raise SourceError('schema_mismatch', f'{table} lacks {", ".join(sorted(needed - cols[table]))}')
        result = {}
        # --- sizes -------------------------------------------------------
        max_ids = {}
        for table in ('urls', 'test_runs', 'observations', 'parameter_observations'):
            if 'id' in cols[table]:
                try:
                    max_ids[table] = db.one(f'SELECT MAX(id) FROM {table}') or 0
                except QueryTimeout:
                    max_ids[table] = None
        def size(table):
            mx = max_ids.get(table)
            if mx is None:
                return None
            if mx <= exact_limit:
                try:
                    return number(db.one(f'SELECT COUNT(*) FROM {table}'))
                except QueryTimeout:
                    pass
            c.approximate = True
            return number(mx, exact=False, method='max_id')
        result['urls'] = size('urls')
        url_total = (result['urls'] or {}).get('value') or 0
        small = (max_ids.get('urls') or 0) <= exact_limit
        result['parameter_rows'] = size('parameter_observations') if cols['parameter_observations'] else None
        # --- hosts ---------------------------------------------------------
        hosts, complete = skip_scan(db, 'urls', 'host', SKIP_SCAN_LIMIT, budget)
        result['hosts'] = number(len(hosts), exact=complete, method=None if complete else 'skip_scan_partial')
        if not complete:
            c.approximate = True
        # --- per-host, routes, parameterized urls (program view only) ------
        # Exact GROUP BY when the table is small; otherwise rowid-window samples
        # scaled to the total, refined by capped per-host index counts.
        per_host = {}
        if detail:
            per_host = host_counts(db, result, c, hosts, max_ids.get('urls') or 0, url_total, small, budget,
                                   sample_windows_n, sample_rows)
        # --- parameters ----------------------------------------------------
        keys = []
        if {'param_key', 'lane_hints', 'url_id'} <= cols['parameter_observations']:
            keys, keys_complete = skip_scan(db, 'parameter_observations', 'param_key', SKIP_SCAN_LIMIT, budget)
            result['parameters'] = number(len(keys), exact=keys_complete, method=None if keys_complete else 'skip_scan_partial')
            if not keys_complete:
                c.approximate = True
        else:
            result['parameters'] = None
            c.fail('parameters', 'schema_mismatch' if cols['parameter_observations'] else 'missing',
                   'parameter_observations unavailable')
        # --- tests (small table, exact) -----------------------------------
        tests = test_summary(db, cols, c)
        result.update(tests['headline'])
        # --- last activity -------------------------------------------------
        stamps = [tests.get('last_test'), tests.get('last_observation')]
        try:
            if 'imported_at' in cols['imports']:
                stamps.append(db.one('SELECT MAX(imported_at) FROM imports'))
            if max_ids.get('urls') and 'first_seen' in cols['urls']:
                stamps.append(db.one('SELECT first_seen FROM urls WHERE id = ?', (max_ids['urls'],)))
        except QueryTimeout:
            pass
        epochs = [e for e in (to_epoch(s) for s in stamps) if e is not None]
        result['last_activity'] = max(epochs) if epochs else None
        if detail:
            result['detail'] = url_detail(db, cols, c, per_host, keys, tests, budget)
        result['errors'] = c.errors
        result['truncated'] = c.truncated
        result['approximate'] = c.approximate
        result['timeouts'] = db.timeouts
        result['open_mode'] = db.mode
        result['elapsed'] = round(time.monotonic() - started, 3)
        return result
    finally:
        db.close()


HOST_COUNT_CAP = 2000


def host_counts(db, result, c, hosts, max_id, url_total, small, budget, windows, rows_per):
    per_host = {}
    if small:
        try:
            rows = db.query('SELECT host, COUNT(*), COUNT(DISTINCT route_hash), '
                            "SUM(CASE WHEN param_keys IS NOT NULL AND param_keys NOT IN ('', '[]') THEN 1 ELSE 0 END) "
                            'FROM urls GROUP BY host')
            for host, n, routes, params in rows:
                per_host[c.host(host)] = {'urls': n, 'routes': routes, 'param_urls': params or 0, 'urls_exact': True}
            result['routes'] = number(db.one('SELECT COUNT(DISTINCT route_hash) FROM urls'))
            result['param_urls'] = number(sum(v['param_urls'] for v in per_host.values()))
            result['host_counts'] = 'exact'
            return per_host
        except QueryTimeout:
            per_host = {}
    rows, windows_read = sample_windows(db, 'urls', 'host, route_hash, param_keys', max_id,
                                        budget * SAMPLE_BUDGET_FACTOR, windows, rows_per)
    sampled = len(rows)
    c.approximate = True
    scale = (url_total / sampled) if sampled else 0
    routes_seen = set()
    for host, route, keys in rows:
        entry = per_host.setdefault(c.host(host), {'urls': 0, 'routes': 0, 'param_urls': 0, '_routes': set(), 'urls_exact': False})
        entry['urls'] += 1
        entry['_routes'].add(route)
        routes_seen.add(route)
        if keys and keys not in ('', '[]'):
            entry['param_urls'] += 1
    for entry in per_host.values():
        entry['urls'] = round(entry['urls'] * scale)
        entry['routes'] = len(entry.pop('_routes'))  # distinct routes seen in the sample: a lower bound
        entry['param_urls'] = round(entry['param_urls'] * scale)
    for host in hosts:
        per_host.setdefault(c.host(host), {'urls': None, 'routes': None, 'param_urls': None, 'urls_exact': False})
    # Long-tail hosts are invisible to a sample: count each host through its
    # index range, capped, and keep the sample estimate for the big ones.
    deadline = time.monotonic() + budget * SAMPLE_BUDGET_FACTOR
    for host in hosts:
        if time.monotonic() > deadline:
            c.fail('host_counts', 'timeout', 'some host counts are sample estimates only')
            break
        try:
            n = db.one('SELECT COUNT(*) FROM (SELECT 1 FROM urls WHERE host = ? LIMIT ?)', (host, HOST_COUNT_CAP + 1))
        except QueryTimeout:
            continue
        entry = per_host[c.host(host)]  # raw value for the lookup above, display-safe key here
        if n <= HOST_COUNT_CAP:
            entry['urls'], entry['urls_exact'] = n, True
            if entry['param_urls'] is not None and entry['param_urls'] > n:
                entry['param_urls'] = n
        else:
            entry['urls'] = max(entry['urls'] or 0, n)
    result['routes'] = number(round(len(routes_seen) * scale) if sampled else None, exact=False, method='sample_scaled')
    result['param_urls'] = number(round(sum(1 for r in rows if r[2] and r[2] not in ('', '[]')) * scale) if sampled else None,
                                  exact=False, method='sample_scaled')
    result['host_counts'] = 'sample'
    result['sample'] = {'rows': sampled, 'windows': windows_read, 'of_windows': windows}
    return per_host


def test_summary(db, cols, c):
    out = {'headline': {}}
    tr = cols['test_runs']
    has_param = 'param_key' in tr
    try:
        total = db.one('SELECT COUNT(*) FROM test_runs')
        out['headline']['test_runs'] = number(total)
        out['headline']['tested_urls'] = number(db.one('SELECT COUNT(DISTINCT url_id) FROM test_runs'))
        out['headline']['tested_params'] = number(db.one(
            "SELECT COUNT(*) FROM (SELECT DISTINCT url_id, param_key FROM test_runs WHERE param_key != '')") if has_param else 0)
        cut1, cut7 = now_iso(86400), now_iso(7 * 86400)
        rows = db.query('SELECT lane, skill, test_family, status, COUNT(*), MAX(completed_at), '
                        'SUM(CASE WHEN completed_at >= ? THEN 1 ELSE 0 END), SUM(CASE WHEN completed_at >= ? THEN 1 ELSE 0 END), '
                        'COUNT(DISTINCT url_id) FROM test_runs GROUP BY lane, skill, test_family, status ORDER BY 5 DESC LIMIT ?',
                        (cut1, cut7, GROUP_LIMIT + 1))
        rows = c.capped('coverage_matrix', rows, GROUP_LIMIT)
        out['groups'] = [{'lane': text(r[0], 80), 'skill': text(r[1], 80), 'test_family': text(r[2], 80), 'status': text(r[3], 40),
                          'runs': r[4], 'last_run': text(r[5], 40), 'last_24h': r[6] or 0, 'last_7d': r[7] or 0, 'urls': r[8]}
                         for r in rows]
        # Exact recency even when the breakdown above is truncated.
        recent = db.query('SELECT SUM(CASE WHEN completed_at >= ? THEN 1 ELSE 0 END), SUM(CASE WHEN completed_at >= ? THEN 1 ELSE 0 END) '
                          'FROM test_runs', (cut1, cut7))[0]
        out['headline']['tests_recent'] = {'last_24h': recent[0] or 0, 'last_7d': recent[1] or 0, 'all': total}
        out['last_test'] = db.one('SELECT MAX(completed_at) FROM test_runs')
        out['tested_lane_params'] = set()
        if has_param:
            pairs = db.query("SELECT DISTINCT lane, param_key FROM test_runs WHERE param_key != '' LIMIT ?", (TESTED_PAIRS_LIMIT + 1,))
            for lane, key in c.capped('tested_pairs', pairs, TESTED_PAIRS_LIMIT):
                out['tested_lane_params'].add((str(lane), str(key)))
        out['tested_lanes'] = {str(r[0]) for r in c.capped('tested_lanes', db.query('SELECT DISTINCT lane FROM test_runs LIMIT ?', (GROUP_LIMIT + 1,)), GROUP_LIMIT)}
    except QueryTimeout:
        c.fail('tests', 'timeout')
        out.setdefault('groups', [])
        out.setdefault('tested_lane_params', set())
        out.setdefault('tested_lanes', set())
    oc = cols['observations']
    if {'lane', 'status', 'url_id'} <= oc:
        try:
            out['observation_groups'] = [{'lane': text(r[0], 80), 'status': text(r[1], 40), 'count': r[2], 'last': text(r[3], 40)}
                                         for r in c.capped('observation_groups', db.query(
                                             f'SELECT lane, status, COUNT(*), {"MAX(created_at)" if "created_at" in oc else "NULL"} '
                                             'FROM observations GROUP BY lane, status ORDER BY 3 DESC LIMIT ?', (GROUP_LIMIT + 1,)), GROUP_LIMIT)]
            out['headline']['observations'] = number(db.one('SELECT COUNT(*) FROM observations'))
            out['last_observation'] = db.one('SELECT MAX(created_at) FROM observations') if 'created_at' in oc else None
        except QueryTimeout:
            c.fail('observations', 'timeout')
    else:
        out['observation_groups'] = []
    return out


def url_detail(db, cols, c, per_host, keys, tests, budget):
    detail = {}
    # Tests and observations per host. CROSS JOIN pins the small table as the outer
    # loop; otherwise SQLite may walk the huge urls host index to avoid a sort.
    host_tests = {}
    try:
        rows = db.query('SELECT u.host, COUNT(*), COUNT(DISTINCT t.url_id), MAX(t.completed_at) '
                        'FROM test_runs t CROSS JOIN urls u ON u.id = t.url_id GROUP BY u.host ORDER BY 2 DESC LIMIT ?', (GROUP_LIMIT + 1,))
        for host, runs, urls, last in c.capped('host_tests', rows, GROUP_LIMIT):
            host_tests[c.host(host)] = {'test_runs': runs, 'tested_urls': urls, 'last_test': text(last, 40)}
        if {'url_id'} <= cols['observations']:
            rows = db.query('SELECT u.host, COUNT(*) FROM observations o CROSS JOIN urls u ON u.id = o.url_id '
                            'GROUP BY u.host ORDER BY 2 DESC LIMIT ?', (GROUP_LIMIT + 1,))
            for host, n in c.capped('host_observations', rows, GROUP_LIMIT):
                host_tests.setdefault(c.host(host), {})['observations'] = n
    except QueryTimeout:
        c.fail('host_tests', 'timeout')
    hosts = []
    for host in set(per_host) | set(host_tests):
        entry = {'host': host, **per_host.get(host, {'urls': None, 'routes': None, 'param_urls': None}),
                 'test_runs': 0, 'tested_urls': 0, 'observations': 0, 'last_test': None}
        entry.update(host_tests.get(host, {}))
        hosts.append(entry)
    detail['hosts'] = hosts
    detail['unsafe_hosts'] = sorted(c.unsafe_hosts)[:HOST_LIMIT]
    detail['coverage_matrix'] = tests.get('groups', [])
    detail['observation_groups'] = tests.get('observation_groups', [])
    # Recent test runs and observations (indexed ORDER BY, LIMIT).
    tr = cols['test_runs']
    want = [k for k in ('agent_id', 'run_id', 'technique', 'depth', 'evidence_path', 'notes', 'param_key', 'param_location',
                        'request_variant', 'response_summary') if k in tr]
    try:
        rows = db.query(f'SELECT t.lane, t.skill, t.test_family, t.status, t.completed_at, u.canonical_url, u.host'
                        f'{"".join(", t." + k for k in want)} FROM test_runs t LEFT JOIN urls u ON u.id = t.url_id '
                        f'ORDER BY t.completed_at DESC LIMIT {LIST_LIMIT}')
        detail['recent_tests'] = [{'lane': text(r[0], 80), 'skill': text(r[1], 80), 'test_family': text(r[2], 80),
                                   'status': text(r[3], 40), 'completed_at': text(r[4], 40), 'url': text(r[5], 600),
                                   'host': text(r[6]), 'unsafe_chars': is_unsafe(r[5], r[6]),
                                   **{k: text(v) for k, v in zip(want, r[7:])}} for r in rows]
    except QueryTimeout:
        c.fail('recent_tests', 'timeout')
        detail['recent_tests'] = []
    oc = cols['observations']
    if {'url_id', 'lane', 'status'} <= oc:
        owant = [k for k in ('param_key', 'agent_id', 'run_id', 'evidence_path', 'notes', 'created_at') if k in oc]
        try:
            rows = db.query(f'SELECT o.lane, o.status, u.canonical_url, u.host{"".join(", o." + k for k in owant)} '
                            f'FROM observations o LEFT JOIN urls u ON u.id = o.url_id ORDER BY o.id DESC LIMIT {LIST_LIMIT}')
            detail['recent_observations'] = [{'lane': text(r[0], 80), 'status': text(r[1], 40), 'url': text(r[2], 600),
                                              'host': text(r[3]), 'unsafe_chars': is_unsafe(r[2], r[3]),
                                              **{k: text(v) for k, v in zip(owant, r[4:])}} for r in rows]
        except QueryTimeout:
            c.fail('recent_observations', 'timeout')
            detail['recent_observations'] = []
    else:
        detail['recent_observations'] = []
    # Hunt next: hinted parameters without a test run in the hinted lane.
    detail['untested_params'] = untested_params(db, cols, c, keys, tests, budget)
    return detail


def untested_params(db, cols, c, keys, tests, budget):
    po = cols['parameter_observations']
    if not {'param_key', 'lane_hints', 'url_id'} <= po:
        return []
    tested = tests.get('tested_lane_params', set())
    out = []
    deadline = time.monotonic() + budget * SAMPLE_BUDGET_FACTOR
    shape = 'value_shape' in po
    location = 'location' in po
    for key in keys:
        if time.monotonic() > deadline:
            c.fail('untested_params', 'timeout', 'parameter list truncated by the time budget')
            break
        try:
            # One indexed seek for a hinted row of this key, one bounded count.
            fields = f'lane_hints, url_id{", value_shape" if shape else ""}{", location" if location else ""}'
            row = db.query(f'SELECT {fields} FROM (SELECT {fields} FROM parameter_observations WHERE param_key = ? LIMIT 200) '
                           "WHERE lane_hints IS NOT NULL AND lane_hints NOT IN ('', '[]') LIMIT 1", (key,))
            if not row:
                continue
            hints = parse_keys(row[0][0])
            missing = [h for h in hints if (h, key) not in tested]
            if missing and c.truncated.get('tested_pairs'):
                # The tested-pairs set is incomplete: confirm each claim with one
                # indexed seek (idx_test_runs_param) so tested params never show as untested.
                missing = [h for h in missing
                           if db.one('SELECT 1 FROM test_runs WHERE param_key = ? AND lane = ? LIMIT 1', (key, h)) is None]
            if not missing:
                continue
            count = db.one('SELECT COUNT(*) FROM (SELECT 1 FROM parameter_observations WHERE param_key = ? LIMIT 1001)', (key,))
            example = db.query('SELECT canonical_url, host FROM urls WHERE id = ?', (row[0][1],))
        except QueryTimeout:
            c.fail('untested_params', 'timeout', 'some parameters were skipped by the time budget')
            continue
        out.append({'param_key': text(key, 120), 'lane_hints': [text(h, 40) for h in hints], 'untested_lanes': [text(h, 40) for h in missing],
                    'observations': count if count <= 1000 else 1000, 'observations_capped': count > 1000,
                    'value_shape': text(row[0][2], 40) if shape else None,
                    'location': text(row[0][3 if shape else 2], 40) if location else None,
                    'example_url': text(example[0][0], 600) if example else None, 'example_host': text(example[0][1]) if example else None,
                    # Copy buttons (URL, curl, bbh next) are offered only when every raw value is safe.
                    'unsafe_chars': is_unsafe(key, *hints, *(example[0] if example else ()))})
    out.sort(key=lambda p: (-len(p['untested_lanes']), -p['observations'], p['param_key'] or ''))
    return out[:200]


# ---------------------------------------------------------------------------
# JS library
# ---------------------------------------------------------------------------

def js_library_summary(path, budget=QUERY_BUDGET, detail=True, exact_limit=EXACT_ROW_LIMIT):
    started = time.monotonic()
    db = ReadOnlyDB(path, budget)
    c = Collector()
    try:
        cols = {t: db.columns(t) for t in ('js_files', 'js_url_aliases', 'js_observations', 'leads', 'metadata', 'js_provenance', 'js_artifacts')}
        if not JS_TABLES['js_files'] <= cols['js_files']:
            raise SourceError('schema_mismatch', 'js_files lacks ' + ', '.join(sorted(JS_TABLES['js_files'] - cols['js_files'])))
        result = {}
        try:
            files, total_bytes = db.query('SELECT COUNT(*), COALESCE(SUM(byte_count), 0) FROM js_files')[0]
            result['files'] = number(files)
            result['bytes'] = number(total_bytes)
            if 'source_map' in cols['js_files']:
                result['source_maps'] = number(db.one("SELECT COUNT(*) FROM js_files WHERE source_map IS NOT NULL AND source_map != ''"))
            if cols['js_url_aliases']:
                result['urls'] = number(db.one('SELECT COUNT(*) FROM js_url_aliases'))
        except QueryTimeout:
            c.fail('files', 'timeout')
        if {'status', 'lens'} <= cols['js_observations']:
            try:
                result['observations'] = number(db.one('SELECT COUNT(*) FROM js_observations'))
                open_where = "COALESCE(next_action, '') != '' AND LOWER(COALESCE(status, '')) NOT IN (%s)" % ','.join('?' * len(DONE_STATUSES))
                result['open_observations'] = number(db.one(f'SELECT COUNT(*) FROM js_observations WHERE {open_where}', tuple(DONE_STATUSES))
                                                     if 'next_action' in cols['js_observations'] else None)
            except QueryTimeout:
                c.fail('observations', 'timeout')
        if cols['leads']:
            try:
                result['leads'] = number(db.one('SELECT COUNT(*) FROM leads'))
            except QueryTimeout:
                c.fail('leads', 'timeout')
        stamps = []
        try:
            for column in ('last_fetched_at', 'last_seen'):
                if column in cols['js_files']:
                    stamps.append(db.one(f'SELECT MAX({column}) FROM js_files'))
            if 'updated_at' in cols['js_observations']:
                stamps.append(db.one('SELECT MAX(updated_at) FROM js_observations'))
        except QueryTimeout:
            pass
        epochs = [e for e in (to_epoch(s) for s in stamps) if e is not None]
        result['last_activity'] = max(epochs) if epochs else None
        if detail:
            result['detail'] = js_detail(db, cols, c, budget)
        result['errors'] = c.errors
        result['approximate'] = c.approximate
        result['timeouts'] = db.timeouts
        result['open_mode'] = db.mode
        result['elapsed'] = round(time.monotonic() - started, 3)
        return result
    finally:
        db.close()


def js_detail(db, cols, c, budget):
    d = {}
    jf = cols['js_files']
    try:
        d['hosts'] = [{'host': text(h) or '', 'files': n, 'bytes': b or 0, 'source_maps': s or 0, 'unsafe_chars': is_unsafe(h)}
                      for h, n, b, s in db.query('SELECT target_host, COUNT(*), SUM(byte_count), '
                                                 + ("SUM(CASE WHEN source_map IS NOT NULL AND source_map != '' THEN 1 ELSE 0 END)" if 'source_map' in jf else '0')
                                                 + ' FROM js_files GROUP BY target_host ORDER BY 2 DESC LIMIT ?', (HOST_LIMIT,))]
    except QueryTimeout:
        c.fail('js_hosts', 'timeout')
        d['hosts'] = []
    alias = "(SELECT js_url FROM js_url_aliases a WHERE a.sha256 = f.sha256 LIMIT 1)" if cols['js_url_aliases'] else 'NULL'
    if 'source_map' in jf:
        try:
            d['source_map_files'] = [{'sha256': text(s, 64), 'host': text(h), 'bytes': b, 'source_map': text(m, 600), 'js_url': text(u, 600),
                                      'unsafe_chars': is_unsafe(h, m, u)}
                                     for s, h, b, m, u in db.query(f"SELECT f.sha256, f.target_host, f.byte_count, f.source_map, {alias} FROM js_files f "
                                                                   f"WHERE f.source_map IS NOT NULL AND f.source_map != '' ORDER BY f.byte_count DESC LIMIT {LIST_LIMIT}")]
        except QueryTimeout:
            c.fail('source_map_files', 'timeout')
    try:
        d['largest_files'] = [{'sha256': text(s, 64), 'host': text(h), 'bytes': b, 'js_url': text(u, 600), 'unsafe_chars': is_unsafe(h, u)}
                              for s, h, b, u in db.query(f'SELECT f.sha256, f.target_host, f.byte_count, {alias} FROM js_files f '
                                                         f'ORDER BY f.byte_count DESC LIMIT 20')]
    except QueryTimeout:
        c.fail('largest_files', 'timeout')
    if 'signal_counts_json' in jf:
        signals = Counter()
        files_with = Counter()
        try:
            rows = db.query("SELECT signal_counts_json FROM js_files WHERE signal_counts_json IS NOT NULL AND signal_counts_json != '' LIMIT 50000",
                            budget=budget * 2)
            for (raw,) in rows:
                try:
                    value = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if isinstance(value, dict):
                    for key, n in value.items():
                        if isinstance(key, str) and isinstance(n, (int, float)) and n == n and n > 0:
                            signals[key[:80]] += int(n)
                            files_with[key[:80]] += 1
            d['signals'] = [{'signal': k, 'count': n, 'files': files_with[k]} for k, n in signals.most_common(40)]
            if len(rows) >= 50000:
                d['signals_capped'] = True
        except QueryTimeout:
            c.fail('signals', 'timeout')
    jo = cols['js_observations']
    if {'lens', 'status'} <= jo:
        want = [k for k in ('observation_id', 'js_url', 'lens', 'status', 'confidence', 'title', 'summary', 'next_action',
                            'agent_id', 'run_id', 'updated_at', 'created_at') if k in jo]
        order = 'updated_at' if 'updated_at' in jo else 'rowid'
        try:
            d['lens_counts'] = [{'lens': text(l, 80), 'status': text(s, 40), 'count': n}
                                for l, s, n in db.query('SELECT lens, status, COUNT(*) FROM js_observations GROUP BY lens, status ORDER BY 3 DESC LIMIT 100')]
            d['recent_observations'] = [{**{k: text(v) for k, v in zip(want, r)}, 'unsafe_chars': is_unsafe(*r)}
                                        for r in db.query(f'SELECT {", ".join(want)} FROM js_observations ORDER BY {order} DESC LIMIT {LIST_LIMIT}')]
            if 'next_action' in jo:
                rows = db.query(f"SELECT {', '.join(want)} FROM js_observations WHERE COALESCE(next_action, '') != '' "
                                f"AND LOWER(COALESCE(status, '')) NOT IN ({','.join('?' * len(DONE_STATUSES))}) "
                                f'ORDER BY {order} DESC LIMIT {LIST_LIMIT}', tuple(DONE_STATUSES))
                d['open_observations'] = [{**{k: text(v) for k, v in zip(want, r)}, 'unsafe_chars': is_unsafe(*r)} for r in rows]
        except QueryTimeout:
            c.fail('js_observations', 'timeout')
    lc = cols['leads']
    if lc:
        want = [k for k in ('lead_id', 'lane', 'confidence', 'js_url', 'related_endpoint', 'next_action', 'run_id') if k in lc]
        if want:
            try:
                where = "WHERE COALESCE(next_action, '') != ''" if 'next_action' in lc else ''
                d['leads'] = [{**{k: text(v) for k, v in zip(want, r)}, 'unsafe_chars': is_unsafe(*r)}
                              for r in db.query(f'SELECT {", ".join(want)} FROM leads {where} ORDER BY rowid DESC LIMIT {LIST_LIMIT}')]
            except QueryTimeout:
                c.fail('leads', 'timeout')
    return d


# ---------------------------------------------------------------------------
# Plain-file sources
# ---------------------------------------------------------------------------

def count_lines(path, cap=LINE_COUNT_CAP):
    """(lines, exact) for a regular file opened without following symlinks."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise SourceError('unavailable', 'not_a_file')
        lines = 0
        read = 0
        last = b'\n'
        while read < cap:
            block = os.read(fd, min(1 << 20, cap - read))
            if not block:
                break
            lines += block.count(b'\n')
            read += len(block)
            last = block[-1:]
        if read >= info.st_size:
            return lines + (0 if last == b'\n' or read == 0 else 1), True
        return (round(lines * info.st_size / read) if read else 0), False
    finally:
        os.close(fd)


def aggregates_summary(lane):
    out = {'files': {}, 'js_lists': {}, 'approximate': False}
    for folder, names, key in ((('recon', 'aggregated'), AGGREGATE_FILES, 'files'), (('recon', 'js'), JS_LIST_FILES, 'js_lists')):
        for name in names:
            try:
                path = checked_path(lane, (*folder, name))
                lines, exact = count_lines(path)
                out[key][name] = number(lines, exact=exact, method=None if exact else 'size_scaled')
                out['approximate'] |= not exact
            except SourceError as error:
                if error.code != 'missing':
                    out[key][name] = {'error': error.code}
            except OSError:
                out[key][name] = {'error': 'unavailable'}
    return out


def board_summary(lane, read_file, ledger_fn, coverage_fn, map_fn):
    """Findings (by class, severity, status, host), coverage and MapStore counts."""
    out = {'errors': {}}
    warnings = []
    findings = ledger_fn(lane, warnings)
    hosts = Counter()
    if findings is None:
        out['errors']['findings'] = {'code': 'missing' if 'ledger_missing' in warnings else 'invalid'}
    else:
        try:
            raw = json.loads(read_file(lane, 'ledgers/ledger.json'))
            for entry in raw.get('findings', []) if isinstance(raw, dict) else []:
                if not isinstance(entry, dict) or str(entry.get('status') or '').lower() in ('archive', 'archived'):
                    continue
                host = next((h for h in (host_of(entry.get(k)) for k in ('asset', 'url', 'endpoint')) if h), None)
                if host:
                    hosts[text(host)] += 1
        except (OSError, ValueError, UnicodeError, RecursionError):
            pass
        live = [f for f in findings if str(f.get('status') or '').lower() not in ('archive', 'archived')]
        sev = Counter(str(f.get('severity') or 'UNKNOWN').upper() for f in live)
        cls = Counter(str(f.get('class_name') or 'unclassified') for f in live)
        cat = Counter(str(f.get('class_category') or 'Unclassified') for f in live)
        status = Counter(str(f.get('status') or 'unknown') for f in live)
        out['findings'] = {'total': len(live), 'archived': len(findings) - len(live),
                           'by_severity': dict(sev), 'by_class': dict(cls.most_common(30)), 'by_category': dict(cat.most_common(30)),
                           'by_status': dict(status), 'by_host': dict(hosts.most_common(HOST_LIMIT)),
                           'last_seen': max((e for e in (to_epoch(f.get('last_seen')) for f in findings) if e), default=None)}
    warnings = []
    cov = coverage_fn(lane, warnings)
    if cov is None:
        out['errors']['coverage'] = {'code': 'missing' if 'coverage_missing' in warnings else 'invalid'}
    else:
        host_q = Counter()
        host_reviewed = Counter()
        for item in cov.get('items', []):
            host_q[text(item.get('host')) or ''] += 1
            if item.get('status') == 'bounded_review':
                host_reviewed[text(item.get('host')) or ''] += 1
        out['coverage'] = {'questions': cov.get('total'), 'by_status': cov.get('counts'), 'mapped_kinds': cov.get('mapped_kinds'),
                           'unassessed_surfaces': cov.get('unclassified_surfaces'),
                           'by_host': {h: {'questions': n, 'reviewed': host_reviewed[h]} for h, n in host_q.most_common(HOST_LIMIT)}}
    warnings = []
    entries = map_fn(lane, warnings)
    out['map_entries'] = len(entries) if entries is not None else None
    return out


# ---------------------------------------------------------------------------
# Service: discovery, cache and background worker
# ---------------------------------------------------------------------------

class ReconIntel:
    """Background-computed, signature-cached recon summaries for discovered web lanes."""

    def __init__(self, root_fn, discover_fn, read_file, ledger_fn, coverage_fn, map_fn, artifact_root=None,
                 query_budget=QUERY_BUDGET, refresh_interval=REFRESH_INTERVAL, exact_limit=EXACT_ROW_LIMIT,
                 sample_windows_n=SAMPLE_WINDOWS, sample_rows=SAMPLE_WINDOW_ROWS, start=True):
        self.root_fn = root_fn
        self.discover_fn = discover_fn
        self.read_file = read_file
        self.ledger_fn, self.coverage_fn, self.map_fn = ledger_fn, coverage_fn, map_fn
        self.artifact_root = Path(artifact_root).absolute() if artifact_root else None
        self.budget = query_budget
        self.refresh_interval = refresh_interval
        self.exact_limit = exact_limit
        self.sample_windows_n, self.sample_rows = sample_windows_n, sample_rows
        self.cache = OrderedDict()   # (kind, path) -> {'sig', 'result', 'error', 'computed_at', 'level', 'elapsed'}
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        self.queue = OrderedDict()   # (kind, path, level) -> job; program requests are moved to the front
        self.running = None
        self.stopped = False
        self.lanes_cache = (0.0, None)
        self.thread = threading.Thread(target=self._worker, name='recon-intel', daemon=True)
        if start:
            self.thread.start()

    # -- discovery ---------------------------------------------------------
    def lanes(self):
        """[(family, program, lane, lane_path)] for web lanes, from the discovered program list only."""
        at, value = self.lanes_cache
        if value is not None and time.monotonic() - at < 30:
            return value
        root = self.root_fn()
        if root is None:
            return []
        found = self.discover_fn(root)
        lanes = []
        for program in found.get('programs', []):
            if program.get('family') != 'web_bounty':
                continue
            for lane in program.get('lanes', []):
                path = Path(root) / 'web_bounty' / program['name'] / lane['name']
                lanes.append(('web_bounty', program['name'], lane['name'], path))
        self.lanes_cache = (time.monotonic(), lanes)
        return lanes

    def artifact_state(self):
        if self.artifact_root is None:
            return {'configured': False, 'path': None, 'available': False,
                    'message': 'No artifact root on this host (start with --artifact-root PATH, or mount /mnt/bounty).'}
        try:
            ok = self.artifact_root.is_dir() and os.access(self.artifact_root, os.R_OK | os.X_OK)
        except OSError:
            ok = False
        return {'configured': True, 'path': str(self.artifact_root), 'available': ok,
                **({} if ok else {'message': 'The artifact root is not readable on this host.'})}

    def js_paths(self, program, lane, lane_path):
        """Candidate (origin, expected path) pairs for a lane's JS library."""
        out = []
        if self.artifact_root is not None:
            out.append(('artifact', self.artifact_root, (program, lane, *JS_LIBRARY_REL)))
        out.append(('shared', lane_path, JS_LIBRARY_REL))
        return out

    # -- cache ---------------------------------------------------------------
    def _entry(self, kind, path, sig, level):
        """Cached entry, scheduling (re)computation when needed. Caller holds the lock."""
        key = (kind, str(path))
        entry = self.cache.get(key)
        if entry is not None:
            self.cache.move_to_end(key)
        # Transient failures (a writer's lock, a budget overrun) are retried once the
        # refresh interval has passed, even when the file signature is unchanged.
        transient = entry is not None and (entry['error'] or {}).get('code') in ('locked', 'timeout', 'changed')
        fresh = entry is not None and entry['sig'] == sig and entry['level'] >= level and not transient
        recent = entry is not None and time.time() - entry['computed_at'] < self.refresh_interval and entry['level'] >= level
        if not fresh and not recent:
            self._schedule(kind, path, level, front=level > 0)
        return entry, fresh

    def _schedule(self, kind, path, level, front=False):
        job = (kind, str(path), level)
        if self.running == job:
            return
        lower = (kind, str(path), 0)
        if level > 0 and lower in self.queue:
            del self.queue[lower]
        if (kind, str(path), 1) in self.queue and level == 0:
            return
        self.queue[job] = path
        if front:
            self.queue.move_to_end(job, last=False)
        self.wake.notify()

    def pending(self, kind, path):
        p = str(path)
        return self.running is not None and self.running[:2] == (kind, p) or any(j[:2] == (kind, p) for j in self.queue)

    def _store(self, kind, path, sig, level, result=None, error=None, elapsed=None):
        with self.lock:
            key = (kind, str(path))
            self.cache[key] = {'sig': sig, 'result': result, 'error': error, 'computed_at': time.time(),
                               'level': level, 'elapsed': elapsed}
            self.cache.move_to_end(key)
            while len(self.cache) > CACHE_ENTRIES:
                self.cache.popitem(last=False)

    def _worker(self):
        while True:
            with self.lock:
                while not self.queue and not self.stopped:
                    self.wake.wait()
                if self.stopped:
                    return
                job, path = self.queue.popitem(last=False)
                self.running = job
            kind, _, level = job
            started = time.monotonic()
            try:
                result, error, sig = self._compute(kind, Path(path), level)
            except Exception as exc:  # keep the worker alive; never leak details
                result, error, sig = None, {'code': 'invalid', 'detail': type(exc).__name__}, None
            self._store(kind, path, sig, level, result, error, round(time.monotonic() - started, 3))
            with self.lock:
                self.running = None

    def _compute(self, kind, path, level):
        if kind == 'url_index':
            sig = file_signature(path)
            try:
                return url_index_summary(path, self.budget, detail=level > 0, exact_limit=self.exact_limit,
                                         sample_windows_n=self.sample_windows_n, sample_rows=self.sample_rows), None, sig
            except SourceError as error:
                return None, {'code': error.code, **({'detail': error.detail} if error.detail else {})}, sig
        if kind == 'js':
            sig = file_signature(path)
            try:
                return js_library_summary(path, self.budget, detail=level > 0, exact_limit=self.exact_limit), None, sig
            except SourceError as error:
                return None, {'code': error.code, **({'detail': error.detail} if error.detail else {})}, sig
        if kind == 'aggregates':
            return aggregates_summary(path), None, self._dir_sig(path / 'recon' / 'aggregated', path / 'recon' / 'js')
        if kind == 'board':
            return (board_summary(path, self.read_file, self.ledger_fn, self.coverage_fn, self.map_fn), None,
                    self._dir_sig(path / 'ledgers' / 'ledger.json', path / 'ledgers' / 'surface_coverage.sqlite',
                                  path / 'ledgers' / 'surface_coverage.sqlite-wal', path / 'recon' / 'maps' / 'map.jsonl'))
        raise ValueError(kind)

    @staticmethod
    def _dir_sig(*paths):
        sig = []
        for p in paths:
            try:
                info = os.stat(p, follow_symlinks=False)
                sig.append((info.st_size, info.st_mtime_ns))
            except OSError:
                sig.append(None)
            if Path(p).suffix == '' and Path(p).is_dir():
                try:
                    for child in sorted(os.scandir(p), key=lambda e: e.name)[:64]:
                        if child.is_file(follow_symlinks=False):
                            s = child.stat(follow_symlinks=False)
                            sig.append((child.name, s.st_size, s.st_mtime_ns))
                except OSError:
                    pass
        return tuple(sig)

    # -- per-lane source states --------------------------------------------
    def _source(self, kind, path, level, sig_fn):
        """{'state': ready|computing|missing|error, ...} for one source."""
        sig = sig_fn()
        with self.lock:
            entry, fresh = self._entry(kind, path, sig, level)
            pending = self.pending(kind, path)
        if entry is None:
            return {'state': 'computing', 'pending': True}
        out = {'state': 'error' if entry['error'] else 'ready', 'computed_at': entry['computed_at'],
               'stale': not fresh, 'pending': pending, 'level': entry['level'], 'elapsed': entry['elapsed']}
        if entry['error']:
            out['error'] = entry['error']
        if entry['result'] is not None:
            out['result'] = entry['result']
        if entry['level'] < level:
            out['state'] = 'computing' if not entry['error'] else out['state']
        return out

    def lane_sources(self, family, program, lane, lane_path, level):
        sources = {}
        try:
            url_path = checked_path(lane_path, URL_INDEX_REL)
            sources['url_index'] = self._source('url_index', url_path, level, lambda: file_signature(url_path))
        except SourceError as error:
            sources['url_index'] = {'state': 'missing' if error.code == 'missing' else 'error',
                                    'error': {'code': error.code, **({'detail': error.detail} if error.detail else {})}}
        sources['url_index']['expected'] = escape_unsafe(Path(lane_path, *URL_INDEX_REL))
        js = None
        tried = []
        for origin, base, parts in self.js_paths(program, lane, lane_path):
            expected = str(Path(base, *parts))
            tried.append({'origin': origin, 'path': escape_unsafe(expected)})
            if origin == 'artifact' and not self.artifact_state()['available']:
                continue
            try:
                js_path = checked_path(base, parts, allow_first_symlink_within=base if origin == 'artifact' else None)
            except SourceError as error:
                if error.code == 'missing':
                    continue
                js = {'state': 'error', 'error': {'code': error.code, **({'detail': error.detail} if error.detail else {})}, 'origin': origin}
                break
            js = self._source('js', js_path, level, lambda p=js_path: file_signature(p))
            js['origin'] = origin
            break
        if js is None:
            js = {'state': 'missing', 'error': {'code': 'missing'}}
        js['expected'] = tried
        sources['js'] = js
        sources['aggregates'] = self._source('aggregates', lane_path, 0,
                                             lambda: self._dir_sig(lane_path / 'recon' / 'aggregated', lane_path / 'recon' / 'js'))
        sources['board'] = self._source('board', lane_path, 0, lambda: self._dir_sig(
            lane_path / 'ledgers' / 'ledger.json', lane_path / 'ledgers' / 'surface_coverage.sqlite',
            lane_path / 'ledgers' / 'surface_coverage.sqlite-wal', lane_path / 'recon' / 'maps' / 'map.jsonl'))
        return sources

    # -- API payloads --------------------------------------------------------
    def overview(self):
        rows = []
        partial = False
        for family, program, lane, path in self.lanes():
            sources = self.lane_sources(family, program, lane, path, 0)
            partial |= any(s.get('state') == 'computing' or s.get('pending') for s in sources.values())
            rows.append(headline_row(family, program, lane, sources))
        return {'computed_at': time.time(), 'partial': partial, 'programs': rows,
                'artifact_root': self.artifact_state(), 'budget': {'query_seconds': self.budget, 'exact_row_limit': self.exact_limit,
                                                                   'refresh_interval': self.refresh_interval}}

    def program(self, family, program, lane, refresh=False):
        match = [entry for entry in self.lanes() if entry[:3] == (family, program, lane)]
        if not match:
            return None
        family, program, lane, path = match[0]
        if refresh:
            with self.lock:
                for kind in ('url_index', 'js', 'aggregates', 'board'):
                    for key in [k for k in self.cache if k[0] == kind and (k[1] == str(path) or k[1].startswith(str(path) + os.sep)
                                                                           or (self.artifact_root and k[1].startswith(str(self.artifact_root / program / lane) + os.sep)))]:
                        self.cache[key]['computed_at'] = 0
                        self.cache[key]['sig'] = None
        sources = self.lane_sources(family, program, lane, path, 1)
        partial = any(s.get('state') == 'computing' or s.get('pending') for s in sources.values())
        lanes = sorted({entry[2] for entry in self.lanes() if entry[1] == program})
        return {'computed_at': time.time(), 'partial': partial, 'family': family, 'program': escape_unsafe(program), 'lane': escape_unsafe(lane),
                'unsafe_chars': is_unsafe(program, lane),
                'lanes': [escape_unsafe(l) for l in lanes], 'lane_path': escape_unsafe(path), 'headline': headline_row(family, program, lane, sources),
                'sources': sources, 'hosts': host_rows(sources), 'artifact_root': self.artifact_state(),
                'budget': {'query_seconds': self.budget, 'exact_row_limit': self.exact_limit, 'refresh_interval': self.refresh_interval}}

    def wait_idle(self, timeout=30.0):
        """Test helper: block until the queue drains."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if not self.queue and self.running is None:
                    return True
            time.sleep(0.01)
        return False

    def close(self):
        with self.lock:
            self.stopped = True
            self.queue.clear()
            self.wake.notify_all()


def _val(source, *keys):
    value = source.get('result') if isinstance(source, dict) else None
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def headline_row(family, program, lane, sources):
    url, js, agg, board = (sources.get(k, {}) for k in ('url_index', 'js', 'aggregates', 'board'))
    findings = _val(board, 'findings') or {}
    activity = [v for v in (_val(url, 'last_activity'), _val(js, 'last_activity'), findings.get('last_seen')) if v]
    # id stays the raw discovered identifier (sent back URL-encoded, never displayed or copied).
    return {'id': f'{family}/{program}', 'family': family, 'program': escape_unsafe(program), 'lane': escape_unsafe(lane),
            'unsafe_chars': is_unsafe(program, lane),
            'urls': _val(url, 'urls'), 'routes': _val(url, 'routes'), 'hosts': _val(url, 'hosts'), 'parameters': _val(url, 'parameters'),
            'param_urls': _val(url, 'param_urls'),
            'test_runs': _val(url, 'test_runs'), 'tested_urls': _val(url, 'tested_urls'), 'tested_params': _val(url, 'tested_params'),
            'tests_recent': _val(url, 'tests_recent'), 'observations': _val(url, 'observations'),
            'js_files': _val(js, 'files'), 'js_bytes': _val(js, 'bytes'), 'js_source_maps': _val(js, 'source_maps'),
            'js_observations': _val(js, 'observations'), 'js_open': _val(js, 'open_observations'), 'js_leads': _val(js, 'leads'),
            'js_urls': _val(js, 'urls'),
            'aggregates': _val(agg, 'files'), 'js_lists': _val(agg, 'js_lists'),
            'findings': findings.get('total') if findings else None, 'findings_by_severity': findings.get('by_severity'),
            'coverage_questions': _val(board, 'coverage', 'questions'),
            'last_activity': max(activity) if activity else None,
            'states': {k: {'state': v.get('state'), **({'error': v['error']} if v.get('error') else {}),
                           **({'computed_at': v['computed_at']} if v.get('computed_at') else {}),
                           **({'stale': True} if v.get('stale') else {}), **({'pending': True} if v.get('pending') else {})}
                       for k, v in sources.items()},
            'approximate': bool(_val(url, 'approximate') or _val(js, 'approximate') or _val(agg, 'approximate'))}


def host_rows(sources):
    """Merge per-host URL index, JS library, findings and coverage into one table."""
    url_hosts = _val(sources.get('url_index', {}), 'detail', 'hosts') or []
    approximate_urls = _val(sources.get('url_index', {}), 'host_counts') == 'sample'
    js_hosts = {h['host']: h for h in (_val(sources.get('js', {}), 'detail', 'hosts') or [])}
    unsafe = set(_val(sources.get('url_index', {}), 'detail', 'unsafe_hosts') or [])
    findings = _val(sources.get('board', {}), 'findings', 'by_host') or {}
    coverage = _val(sources.get('board', {}), 'coverage', 'by_host') or {}
    rows = {}
    for h in url_hosts:
        rows[h['host']] = dict(h)
    for name in set(js_hosts) | set(findings) | set(coverage):
        rows.setdefault(name, {'host': name, 'urls': None, 'routes': None, 'param_urls': None, 'test_runs': 0,
                               'tested_urls': 0, 'observations': 0, 'last_test': None})
    for name, row in rows.items():
        js = js_hosts.get(name, {})
        row['js_files'] = js.get('files', 0)
        row['js_bytes'] = js.get('bytes', 0)
        row['findings'] = findings.get(name, 0)
        row['coverage_questions'] = coverage.get(name, {}).get('questions', 0)
        row['coverage_reviewed'] = coverage.get(name, {}).get('reviewed', 0)
        row['urls_approximate'] = approximate_urls
        row['under_tested'] = under_tested(row)
        row['unsafe_chars'] = name in unsafe or bool(js.get('unsafe_chars'))
        row['surface_score'] = (row.get('urls') or 0) + 20 * row['js_files'] + 5 * (row.get('param_urls') or 0)
    ordered = sorted(rows.values(), key=lambda r: (-r['surface_score'], r['host']))
    truncated = len(ordered) > HOST_LIMIT
    return {'rows': ordered[:HOST_LIMIT], 'total': len(ordered), 'truncated': truncated, 'urls_approximate': approximate_urls,
            'rule': 'Under-tested: at least 50 URLs or 3 JS files, and no test runs or fewer than one test run per 200 URLs.'}


def under_tested(row):
    urls = row.get('urls') or 0
    js = row.get('js_files') or 0
    runs = (row.get('test_runs') or 0) + (row.get('coverage_reviewed') or 0)
    if urls < 50 and js < 3:
        return False
    return runs == 0 or runs * 200 < urls


# ---------------------------------------------------------------------------
# HTTP (called from app.py's do_GET after its trust checks)
# ---------------------------------------------------------------------------

def handle_request(handler, url, service):
    """GET /api/recon/overview and GET /api/recon/program?family=&program=&lane=[&refresh=1]."""
    from urllib.parse import parse_qs
    if service is None:
        return handler.reply(404, {'error': 'recon_unavailable'})
    if url.path == '/api/recon/overview':
        if url.query:
            return handler.reply(400, {'error': 'invalid_recon_request'})
        return handler.reply(200, service.overview())
    try:
        params = parse_qs(url.query, keep_blank_values=True, strict_parsing=True, max_num_fields=4,
                          encoding='utf-8', errors='strict')
        if not {'family', 'program', 'lane'} <= set(params) or set(params) - {'family', 'program', 'lane', 'refresh'} \
                or any(len(v) != 1 for v in params.values()) or params.get('refresh', ['1'])[0] not in ('0', '1'):
            raise ValueError('invalid parameters')
        family, program, lane = (params[k][0] for k in ('family', 'program', 'lane'))
        if len(program) > 200 or '\0' in program or '/' in program:
            raise ValueError('invalid program')
    except (ValueError, UnicodeError):
        return handler.reply(400, {'error': 'invalid_recon_request'})
    # Resolved against the discovered program list only; never a raw path.
    result = service.program(family, program, lane, refresh=params.get('refresh') == ['1'])
    if result is None:
        return handler.reply(404, {'error': 'recon_lane_not_found'})
    return handler.reply(200, result)
