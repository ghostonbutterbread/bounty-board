"""Scope check: which hosts and URLs shown by Recon intel are in scope.

Scope truth lives in <root>/scopes/<program>/ (in-scope.txt, out-of-scope.txt
or excluded.txt, rules-of-engagement.json). The rules are evaluated by BBH:

    <bbh> agents/scope_validator.py classify <program> --scopes-base <root>/scopes --json

with {"targets": [...]} on stdin (contract: docs/integrations/scope-check.md).

Efficiency rules:
  * Verdicts are cached in memory per program, keyed by a stat-only signature of
    the scope files (size, mtime_ns), so a request never starts a subprocess:
    lookup() only reads the cache.
  * classify() runs on the Recon intel background worker. It sends only the
    targets not cached under the current signature, in one subprocess call per
    program per pass. A changed signature drops that program's verdicts.
  * Hosts are the unit (a big URL index has ~1.4k hosts, not millions of URLs);
    single URLs are checked only for rows that are displayed.

Failures (no --bbh, subprocess error, timeout, bad JSON, wrong result count)
mark every target unchecked with a reason starting "scope check failed:". They
are logged once per program and signature and retried after RETRY_INTERVAL;
there is never a fallback to "in scope". Nothing is written anywhere.
"""
import json
import os
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path

SCOPE_FILES = ('in-scope.txt', 'out-of-scope.txt', 'excluded.txt', 'rules-of-engagement.json')
STATES = frozenset({'in', 'out', 'partial', 'unchecked'})
SCOPE_STATES = frozenset({'loaded', 'empty', 'missing'})
MAX_TARGETS = 50_000        # contract limit per call
PROGRAM_ENTRIES = 128       # programs kept in the cache (LRU)
VERDICTS_PER_PROGRAM = 60_000
RETRY_INTERVAL = 60.0       # a failed check is retried after this many seconds (or on Refresh)
NO_SCOPE = 'no scope on file'
PENDING = 'scope check pending'


def failed(reason):
    return f'scope check failed: {reason}'


def resolve_scope_dir(root, program):
    """(resolved <root>/scopes/<program> or None, reason). Shared with scope_inventory.py.

    An alias symlink is followed only when it resolves inside <root>/scopes; a broken
    or escaping link is refused with a reason other than NO_SCOPE."""
    if root is None:
        return None, 'board root unavailable'
    if not isinstance(program, str) or not program or program in ('.', '..') or '/' in program or '\0' in program:
        return None, 'invalid program name'
    base = Path(root) / 'scopes'
    try:
        base_real = base.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, NO_SCOPE
    candidate = base / program
    try:
        if not os.path.lexists(candidate):
            return None, NO_SCOPE
        real = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, 'scope link is broken; ignored'
    if real != base_real and not real.is_relative_to(base_real):
        return None, 'scope link points outside the scopes directory; ignored'
    if not real.is_dir():
        return None, NO_SCOPE
    return real, ''


def _short(value, limit=240):
    if not isinstance(value, str):
        return None
    from recon_intel import text  # display-safe (control and bidi characters escaped)
    return text(value, limit)


class ScopeChecker:
    """Cached scope verdicts per program. lookup() is cache-only; classify() may run BBH once."""

    def __init__(self, root_fn, bbh_path, timeout=10.0, retry_interval=RETRY_INTERVAL, runner=None):
        self.root_fn = root_fn
        self.bbh = Path(bbh_path) if bbh_path else None
        self.timeout = timeout
        self.retry_interval = retry_interval
        self.runner = runner or subprocess.run
        self.lock = threading.Lock()
        # program -> {'sig', 'scope_state', 'verdicts': OrderedDict, 'checked_at', 'failure': {reason, at} | None}
        self.cache = OrderedDict()
        self.logged = set()
        self.calls = 0          # subprocess calls made (tests and the dossier's performance evidence)

    # -- scope directory and signature (stat only) ---------------------------
    def scope_dir(self, program):
        """(resolved scope dir or None, reason). An alias symlink must resolve inside <root>/scopes."""
        return resolve_scope_dir(self.root_fn(), program)

    def signature(self, program):
        directory, reason = self.scope_dir(program)
        if directory is None:
            return ('none', reason)
        sig = [str(directory)]
        # Inode and ctime catch a same-size replacement that keeps the source mtime (sync tools, atomic rename).
        try:
            info = os.stat(directory)
            sig.append((info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
        except OSError:
            sig.append(None)
        for name in SCOPE_FILES:
            try:
                info = os.stat(directory / name)
                sig.append((name, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
            except OSError:
                sig.append((name, None))
        return tuple(sig)

    # -- cache ---------------------------------------------------------------
    def _entry(self, program, sig):
        """Cache entry for the current signature (dropping a stale one). Caller holds the lock."""
        entry = self.cache.get(program)
        if entry is None or entry['sig'] != sig:
            entry = {'sig': sig, 'scope_state': None, 'verdicts': OrderedDict(), 'checked_at': None, 'failure': None}
            self.cache[program] = entry
        self.cache.move_to_end(program)
        while len(self.cache) > PROGRAM_ENTRIES:
            self.cache.popitem(last=False)
        return entry

    def forget(self, program):
        """Refresh: drop cached verdicts and any failure for a program."""
        with self.lock:
            self.cache.pop(program, None)

    def lookup(self, program, targets):
        """Cache-only. Returns (verdicts {target: {state, rule, reason}}, summary, missing targets).

        summary: {state: checked|no_scope|failed|unconfigured|pending, checked_at, reason}.
        missing: targets a background pass should classify now (empty when nothing is due)."""
        sig = self.signature(program)
        if sig[0] == 'none':
            if sig[1] == NO_SCOPE:
                verdict = {'state': 'unchecked', 'rule': None, 'reason': NO_SCOPE}
                return ({t: verdict for t in targets}, {'state': 'no_scope', 'checked_at': None, 'reason': NO_SCOPE}, [])
            # A scope that exists but cannot be read (broken or escaping alias) is not open scope.
            verdict = {'state': 'unchecked', 'rule': None, 'reason': failed(sig[1])}
            return ({t: verdict for t in targets}, {'state': 'failed', 'checked_at': None, 'reason': verdict['reason'],
                                                    'source': 'scope_dir'}, [])
        if self.bbh is None:
            verdict = {'state': 'unchecked', 'rule': None, 'reason': failed('no --bbh configured on this Board')}
            return ({t: verdict for t in targets}, {'state': 'unconfigured', 'checked_at': None, 'reason': verdict['reason']}, [])
        with self.lock:
            entry = self._entry(program, sig)
            if entry['scope_state'] in ('empty', 'missing'):
                verdict = {'state': 'unchecked', 'rule': None, 'reason': NO_SCOPE}
                return ({t: verdict for t in targets}, {'state': 'no_scope', 'checked_at': entry['checked_at'], 'reason': NO_SCOPE}, [])
            cached = entry['verdicts']
            out, missing = {}, []
            for target in targets:
                verdict = cached.get(target)
                if verdict is None:
                    missing.append(target)
                else:
                    out[target] = verdict
            failure = entry['failure']
            if missing and failure is not None:
                verdict = {'state': 'unchecked', 'rule': None, 'reason': failure['reason']}
                for target in missing:
                    out[target] = verdict
                due = time.time() - failure['at'] >= self.retry_interval
                return out, {'state': 'failed', 'checked_at': entry['checked_at'], 'reason': failure['reason']}, missing if due else []
            pending = {'state': 'unchecked', 'rule': None, 'reason': PENDING}
            for target in missing:
                out[target] = pending
            if missing:
                return out, {'state': 'pending', 'checked_at': entry['checked_at'], 'reason': PENDING}, missing
            return out, {'state': 'checked', 'checked_at': entry['checked_at'], 'reason': ''}, []

    # -- background pass -------------------------------------------------------
    def classify(self, program, targets):
        """Classify targets not cached under the current signature: at most one subprocess call.

        Runs on the background worker only. Returns the number of targets sent."""
        sig = self.signature(program)
        if sig[0] == 'none' or self.bbh is None:
            return 0
        with self.lock:
            entry = self._entry(program, sig)
            if entry['scope_state'] in ('empty', 'missing'):
                return 0
            todo = list(dict.fromkeys(t for t in targets if isinstance(t, str) and t and t not in entry['verdicts']))
        if not todo:
            return 0
        todo = todo[:MAX_TARGETS]
        try:
            response = self._run(program, todo)
        except _Failure as error:
            with self.lock:
                if self.cache.get(program, {}).get('sig') not in (None, sig):
                    return len(todo)  # the scope changed meanwhile; the next pass starts over
                entry = self._entry(program, sig)
                entry['failure'] = {'reason': failed(error.reason), 'at': time.time()}
                key = (program, sig)
                first = key not in self.logged
                self.logged.add(key)
            if first:
                print(f'bounty-board: scope check for {program!r} failed: {error.reason}', file=sys.stderr, flush=True)
            return len(todo)
        with self.lock:
            if self.cache.get(program, {}).get('sig') not in (None, sig):
                return len(todo)
            entry = self._entry(program, sig)
            entry['failure'] = None
            entry['checked_at'] = time.time()
            entry['scope_state'] = response['scope_state']
            verdicts = entry['verdicts']
            for target, result in zip(todo, response['results']):
                verdicts[target] = {'state': result['state'], 'rule': _short(result.get('rule')),
                                    'reason': _short(result.get('reason')) or ''}
                verdicts.move_to_end(target)
            while len(verdicts) > VERDICTS_PER_PROGRAM:
                verdicts.popitem(last=False)
        return len(todo)

    def _run(self, program, targets):
        root = self.root_fn()
        if root is None:
            raise _Failure('board root unavailable')
        argv = [str(self.bbh), 'agents/scope_validator.py', 'classify', program,
                '--scopes-base', str(Path(root) / 'scopes'), '--json']
        self.calls += 1
        try:
            result = self.runner(argv, input=json.dumps({'targets': targets}), capture_output=True, text=True,
                                 timeout=self.timeout)
        except subprocess.TimeoutExpired:
            raise _Failure(f'BBH did not answer within {self.timeout:g} s')
        except (OSError, subprocess.SubprocessError) as error:
            raise _Failure(f'could not run BBH ({type(error).__name__})')
        if result.returncode != 0:
            line = (result.stderr or '').strip().splitlines()[-1:] or ['']
            raise _Failure(f'BBH exited {result.returncode}' + (f' ({_short(line[0], 160)})' if line[0] else ''))
        try:
            body = json.loads(result.stdout)
        except (TypeError, ValueError):
            raise _Failure('BBH printed invalid JSON')
        if not isinstance(body, dict) or body.get('scope_state') not in SCOPE_STATES or not isinstance(body.get('results'), list):
            raise _Failure('BBH answer does not match the classify contract')
        results = body['results']
        if len(results) != len(targets):
            raise _Failure(f'BBH returned {len(results)} results for {len(targets)} targets')
        for target, item in zip(targets, results):
            if (not isinstance(item, dict) or item.get('target') != target or item.get('state') not in STATES
                    or not (item.get('rule') is None or isinstance(item.get('rule'), str))
                    or not isinstance(item.get('reason', ''), str)):
                raise _Failure('BBH answer does not match the classify contract')
        return body


class _Failure(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


# ---------------------------------------------------------------------------
# Recon intel payload helpers (pure; called with cached data on request threads)
# ---------------------------------------------------------------------------

# Displayed lists that carry a URL (or host) per item: source -> {list: field}.
ITEM_TARGETS = {
    'url_index': {'recent_tests': 'url', 'recent_observations': 'url', 'untested_params': 'example_url'},
    'js': {'open_observations': 'js_url', 'recent_observations': 'js_url', 'leads': 'js_url',
           'source_map_files': 'js_url', 'largest_files': 'js_url', 'hosts': 'host'},
}
SHOWN = ('in', 'partial')


def item_targets(sources):
    """URLs (and JS hosts) of every displayed item, in order, without duplicates."""
    out = []
    for kind, lists in ITEM_TARGETS.items():
        detail = ((sources.get(kind) or {}).get('result') or {}).get('detail') or {}
        for name, field in lists.items():
            for item in detail.get(name) or []:
                value = item.get(field) if isinstance(item, dict) else None
                if isinstance(value, str) and value:
                    out.append(value)
    return list(dict.fromkeys(out))


def annotate_sources(sources, verdicts):
    """Copy of sources whose displayed items carry scope (the cached results stay untouched).

    verdicts None: no scope checker; only the internal host_list is dropped."""
    out = dict(sources)
    for kind, lists in ITEM_TARGETS.items():
        source = sources.get(kind)
        result = (source or {}).get('result')
        if not isinstance(result, dict) or ('host_list' not in result and verdicts is None):
            continue
        result = {k: v for k, v in result.items() if k != 'host_list'}
        detail = result.get('detail')
        if isinstance(detail, dict) and verdicts is not None:
            detail = dict(detail)
            for name, field in lists.items():
                if isinstance(detail.get(name), list):
                    detail[name] = [{**item, 'scope': verdicts.get(item.get(field)) if item.get(field) else None}
                                    if isinstance(item, dict) else item for item in detail[name]]
            result['detail'] = detail
        out[kind] = {**source, 'result': result}
    return out


def host_counts(rows):
    counts = {'in': 0, 'out': 0, 'partial': 0, 'unchecked': 0}
    for row in rows:
        counts[((row.get('scope') or {}).get('state')) if (row.get('scope') or {}).get('state') in counts else 'unchecked'] += 1
    return counts


def program_summary(summary, rows):
    """scope_summary for a program payload; rows are all host rows (before the display cap)."""
    counts = host_counts(rows)
    shown = [r for r in rows if (r.get('scope') or {}).get('state') in SHOWN]
    urls = sum(r.get('urls') or 0 for r in shown)
    approximate = any(r.get('urls_approximate') and not r.get('urls_exact') for r in shown)
    return {**summary, **counts, 'hosts': len(rows), 'in_scope_hosts': counts['in'] + counts['partial'],
            'in_scope_urls': {'value': urls, 'approximate': approximate, 'method': 'host_counts'} if summary['state'] == 'checked' else None}


def overview_fields(summary, verdicts, url_result, js_result):
    """Scope columns of an overview row: host counts and in-scope surface without new queries.

    Per-host URL counts are used when a program view already cached them (exact
    where the host counts are exact); otherwise the totals are scaled by the
    in-scope host share and marked approximate."""
    hosts = (url_result or {}).get('host_list') or []
    counts = {'in': 0, 'out': 0, 'partial': 0, 'unchecked': 0}
    for host in hosts:
        state = (verdicts.get(host) or {}).get('state')
        counts[state if state in counts else 'unchecked'] += 1
    scope = {**summary, **counts, 'hosts': len(hosts), 'in_scope_hosts': counts['in'] + counts['partial']}
    fields = {'scope': scope, 'in_scope_urls': None, 'in_scope_js_files': None}
    checked = counts['in'] + counts['partial'] + counts['out']
    if summary['state'] != 'checked' or not checked:
        return fields
    share = (counts['in'] + counts['partial']) / checked
    per_host = ((url_result or {}).get('detail') or {}).get('hosts')
    total_urls = ((url_result or {}).get('urls') or {}).get('value')
    if per_host:
        rows = [h for h in per_host if (verdicts.get(h.get('host')) or {}).get('state') in SHOWN]
        fields['in_scope_urls'] = {'value': sum(h.get('urls') or 0 for h in rows),
                                   'approximate': any(not h.get('urls_exact') for h in rows), 'method': 'host_counts'}
    elif isinstance(total_urls, (int, float)):
        fields['in_scope_urls'] = {'value': round(total_urls * share), 'method': 'host_share',
                                   'approximate': share < 1 or bool(((url_result or {}).get('urls') or {}).get('approximate'))}
    js_hosts = ((js_result or {}).get('detail') or {}).get('hosts')
    total_js = ((js_result or {}).get('files') or {}).get('value')
    if js_hosts and all((verdicts.get(h.get('host')) or {}).get('state') in ('in', 'out', 'partial') for h in js_hosts):
        fields['in_scope_js_files'] = {'value': sum(h.get('files') or 0 for h in js_hosts
                                                    if (verdicts.get(h.get('host')) or {}).get('state') in SHOWN),
                                       'approximate': False, 'method': 'host_counts'}
    elif isinstance(total_js, (int, float)):
        fields['in_scope_js_files'] = {'value': round(total_js * share), 'method': 'host_share',
                                       'approximate': share < 1 or bool(((js_result or {}).get('files') or {}).get('approximate'))}
    return fields
