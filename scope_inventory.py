"""Scope panel: what a program lists in scope, how fresh it is, and what changed.

Reads <root>/scopes/<program>/ (the canonical scope directory; alias links are
followed only inside <root>/scopes, the scope_check.py rule). BBH
agents/scope_puller.py writes the files; the Board only reads them. Contract:
docs/integrations/scope-panel.md.

    scope-pull.json       last pull state (pulled_at, last attempt, error)
    scope-items.json      typed inventory (items with kind, in_scope, enforced, release)
    scope-history.jsonl   append-only change log (the tail is read)
    in-scope.txt / out-of-scope.txt   rule fallback when no inventory exists
    program-policy.md     rendered by the client's safe Markdown renderer
    assets.json           mtime only (estimated pull time when scope-pull.json is absent)

Rules:
  * Read-only. Nothing is written under the root; no network, no subprocess.
  * Every file has a size cap. An oversized, unreadable or malformed file gives a
    per-file error state; the rest of the panel still renders.
  * Parsed files are cached per program by a stat-only signature (inode, size,
    mtime_ns, ctime_ns of each file and of the directory). Ages and binaries lane
    times are computed per request (stat only, top-level entries, capped).
  * Unknown JSON keys are ignored. Every string sent to the client is display-safe
    (control, bidi and invisible characters escaped by recon_intel.text()).
"""
import json
import math
import os
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

from recon_intel import escape_unsafe, is_unsafe, text
from scope_check import NO_SCOPE, resolve_scope_dir

STALE_DAYS = 7
HISTORY_LINES = 20
# Size caps (bytes). A file over its cap is refused with a per-file error.
CAPS = {
    'scope-pull.json': 64 * 1024,
    'scope-items.json': 4 * 1024 * 1024,
    'in-scope.txt': 1024 * 1024,
    'out-of-scope.txt': 1024 * 1024,
    'program-policy.md': 256 * 1024,
}
HISTORY_TAIL_BYTES = 256 * 1024   # only the tail of scope-history.jsonl is read
HISTORY_LINE_BYTES = 64 * 1024    # a longer line is reported as unreadable
MAX_ITEMS = 5000                  # inventory items considered
MAX_RULES = 1000                  # rules sent per list (counts stay exact)
MAX_DIFF = 200                    # entries per history list
LANE_SCAN = 10000                 # top-level entries inspected per binaries lane
SIGNED_FILES = ('scope-pull.json', 'scope-items.json', 'scope-history.jsonl', 'in-scope.txt', 'out-of-scope.txt',
                'program-policy.md', 'assets.json')
WEB_KINDS = ('web_host', 'web_wildcard', 'web_url', 'ip', 'cidr')
ASSET_KINDS = ('android_app', 'ios_app', 'executable', 'source_code', 'cloud', 'other')
KINDS = frozenset(WEB_KINDS + ASSET_KINDS)
ATTEMPT_STATES = frozenset({'ok', 'failed', 'skipped_fresh', 'skipped_backoff'})
# Binaries lanes per asset kind, first existing wins. Only lanes the Board discovers are linked.
LANE_FOR_KIND = {'android_app': ('apk',), 'executable': ('exe',), 'ios_app': ('ios', 'app')}
CACHE_ENTRIES = 64


def parse_time(value):
    """Epoch seconds from an ISO 8601 string (Z or offset); None when not a time."""
    if not isinstance(value, str) or not value or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00') if value.endswith('Z') else value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if ts is not None else None


def _s(value, limit=240):
    """Display-safe short string, or None for anything that is not a string or number."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return None
    return text(value, limit)


def _flag(value):
    return value if isinstance(value, bool) else None


def _time_field(value):
    """{'text': display-safe original, 'ts': epoch} or None."""
    ts = parse_time(value)
    if ts is None and not isinstance(value, str):
        return None
    return {'text': _s(value, 40), 'ts': ts}


def stat_sig(path):
    try:
        info = os.stat(path)
        return (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    except OSError:
        return None


OUTSIDE = {'state': 'unreadable', 'error': 'link points outside the scopes directory; ignored'}


def outside(path, base):
    """True when path is a link resolving outside base (the resolved <root>/scopes)."""
    if base is None or not os.path.islink(path):
        return False
    real = os.path.realpath(path)
    return not real.startswith(str(base) + os.sep)


def read_capped(path, cap, base=None):
    """(bytes or None, file state dict). States: ok, missing, too_large, unreadable."""
    if outside(path, base):
        return None, dict(OUTSIDE)
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return None, {'state': 'missing'}
    except OSError as error:
        return None, {'state': 'unreadable', 'error': text(error.strerror or 'cannot read', 120)}
    if not os.path.isfile(path):
        return None, {'state': 'unreadable', 'error': 'not a regular file'}
    if info.st_size > cap:
        return None, {'state': 'too_large', 'error': f'file is {info.st_size} bytes; the limit is {cap}', 'size': info.st_size}
    try:
        with open(path, 'rb') as handle:
            data = handle.read(cap + 1)
    except OSError as error:
        return None, {'state': 'unreadable', 'error': text(error.strerror or 'cannot read', 120)}
    if len(data) > cap:
        return None, {'state': 'too_large', 'error': f'file grew past the limit of {cap} bytes'}
    return data, {'state': 'ok', 'size': len(data)}


def read_json(path, cap, base=None):
    data, state = read_capped(path, cap, base)
    if data is None:
        return None, state
    try:
        value = json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None, {'state': 'invalid', 'error': 'not valid JSON'}
    if not isinstance(value, dict):
        return None, {'state': 'invalid', 'error': 'expected a JSON object'}
    return value, state


def read_rules(path, base=None):
    data, state = read_capped(path, CAPS[path.name], base)
    if data is None:
        return None, state
    lines = [line.strip() for line in data.decode('utf-8', 'replace').splitlines()]
    return [line for line in lines if line and not line.startswith('#')], state


def policy_text(data):
    """Markdown source made display-safe line by line (newlines kept, CRLF normalized)."""
    source = data.decode('utf-8', 'replace').replace('\r\n', '\n').replace('\r', '\n')
    return '\n'.join(escape_unsafe(line) for line in source.split('\n'))


def read_tail(path, max_lines=HISTORY_LINES, max_bytes=HISTORY_TAIL_BYTES, base=None):
    """Last max_lines lines of a JSONL file, newest first, reading at most max_bytes from the end.

    Returns (raw lines newest first, more: bool, file state)."""
    if outside(path, base):
        return [], False, dict(OUTSIDE)
    try:
        size = os.stat(path).st_size
    except FileNotFoundError:
        return [], False, {'state': 'missing'}
    except OSError as error:
        return [], False, {'state': 'unreadable', 'error': text(error.strerror or 'cannot read', 120)}
    if not os.path.isfile(path):
        return [], False, {'state': 'unreadable', 'error': 'not a regular file'}
    start = max(0, size - max_bytes)
    try:
        with open(path, 'rb') as handle:
            handle.seek(start)
            data = handle.read(max_bytes)
    except OSError as error:
        return [], False, {'state': 'unreadable', 'error': text(error.strerror or 'cannot read', 120)}
    lines = data.split(b'\n')
    if not data.endswith(b'\n'):
        lines = lines[:-1]  # the last line is still being appended
    if start > 0:
        lines = lines[1:]  # the first line is partial
    lines = [line for line in lines if line.strip()]
    if start > 0 and not lines and data.strip():
        # One line longer than the tail window: report it instead of an empty log.
        return [b'\0' * (HISTORY_LINE_BYTES + 1)], True, {'state': 'ok', 'size': size}
    more = start > 0 or len(lines) > max_lines
    return list(reversed(lines[-max_lines:])), more, {'state': 'ok', 'size': size}


def _diff_list(values, fields):
    if not isinstance(values, list):
        return [], 0
    out = []
    for value in values[:MAX_DIFF]:
        if not isinstance(value, dict):
            continue
        entry = {}
        for name in fields:
            raw = value.get(name)
            if name in ('in_scope',):
                entry[name] = _flag(raw)
            elif name in ('from', 'to'):
                entry[name] = raw if isinstance(raw, bool) else _s(raw, 160)
            else:
                entry[name] = _s(raw, 240)
        out.append(entry)
    return out, len(values)


def history_entry(raw):
    if len(raw) > HISTORY_LINE_BYTES:
        return {'state': 'invalid', 'error': 'line too long'}
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return {'state': 'invalid', 'error': 'not valid JSON'}
    if not isinstance(value, dict):
        return {'state': 'invalid', 'error': 'expected a JSON object'}
    entry = {'state': 'ok', 'at': _time_field(value.get('at')), 'source': _s(value.get('source'), 40)}
    for name, fields in (('added', ('key', 'kind', 'name', 'in_scope')), ('removed', ('key', 'kind', 'name', 'in_scope')),
                         ('changed', ('key', 'field', 'from', 'to')), ('release_changed', ('key', 'name', 'previous', 'signal'))):
        items, total = _diff_list(value.get(name), fields)
        entry[name] = items
        entry[name + '_count'] = total
    return entry


def _release(value):
    if not isinstance(value, dict):
        return None
    return {'method': _s(value.get('method'), 60), 'signal': _s(value.get('signal'), 240), 'version': _s(value.get('version'), 80),
            'previous_signal': _s(value.get('previous_signal'), 240), 'error': _s(value.get('error'), 240),
            'checked_at': _time_field(value.get('checked_at')), 'changed_at': _time_field(value.get('changed_at'))}


def _item(value):
    if not isinstance(value, dict):
        return None
    kind = value.get('kind') if isinstance(value.get('kind'), str) else None
    identifier = _s(value.get('identifier'), 300)
    if not kind or identifier is None:
        return None
    return {'key': _s(value.get('key'), 400), 'kind': text(kind, 40), 'known_kind': kind in KINDS, 'identifier': identifier,
            'name': _s(value.get('name'), 240), 'in_scope': _flag(value.get('in_scope')), 'tier': _s(value.get('tier'), 20),
            'max_severity': _s(value.get('max_severity'), 20), 'eligible_for_bounty': _flag(value.get('eligible_for_bounty')),
            'enforced': value.get('enforced') is True, 'platform_type': _s(value.get('platform_type'), 60),
            'description': _s(value.get('description'), 500), 'first_seen': _time_field(value.get('first_seen')),
            'last_seen': _time_field(value.get('last_seen')), 'release': _release(value.get('release'))}


def _rule_list(values):
    return {'items': [text(v, 300) for v in values[:MAX_RULES]], 'count': len(values), 'truncated': len(values) > MAX_RULES}


class ScopeInventory:
    """Read-only scope panel payloads, cached per program by file signatures."""

    def __init__(self, root_fn, binaries_lanes=('apk', 'exe', 'mac'), now=time.time):
        self.root_fn = root_fn
        self.binaries_lanes = frozenset(binaries_lanes)
        self.now = now
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.parses = 0  # files parsed (tests: cache hit means no new parse)

    # -- signature and cache ----------------------------------------------------
    @staticmethod
    def signature(directory):
        return (str(directory), stat_sig(directory)) + tuple((name, stat_sig(directory / name)) for name in SIGNED_FILES)

    def _parsed(self, program, directory, base, refresh=False):
        sig = self.signature(directory)
        with self.lock:
            entry = self.cache.get(program)
            if entry is not None and entry[0] == sig and not refresh:
                self.cache.move_to_end(program)
                return entry[1]
        parsed = self._parse(directory, base)
        with self.lock:
            self.cache[program] = (sig, parsed)
            self.cache.move_to_end(program)
            while len(self.cache) > CACHE_ENTRIES:
                self.cache.popitem(last=False)
        return parsed

    # -- parsing (files only; no time-dependent values) --------------------------
    def _parse(self, directory, base):
        self.parses += 1
        files = {}
        pull, files['scope-pull.json'] = read_json(directory / 'scope-pull.json', CAPS['scope-pull.json'], base)
        inventory, files['scope-items.json'] = read_json(directory / 'scope-items.json', CAPS['scope-items.json'], base)
        in_rules, files['in-scope.txt'] = read_rules(directory / 'in-scope.txt', base)
        out_rules, files['out-of-scope.txt'] = read_rules(directory / 'out-of-scope.txt', base)
        policy_raw, files['program-policy.md'] = read_capped(directory / 'program-policy.md', CAPS['program-policy.md'], base)
        tail, more, files['scope-history.jsonl'] = read_tail(directory / 'scope-history.jsonl', base=base)

        pull_info = None
        if pull is not None:
            status = pull.get('last_attempt_status')
            pull_info = {'pulled_at': _time_field(pull.get('pulled_at')), 'last_attempt_at': _time_field(pull.get('last_attempt_at')),
                         'last_attempt_status': status if status in ATTEMPT_STATES else _s(status, 40),
                         'last_error': _s(pull.get('last_error'), 300), 'platform': _s(pull.get('platform'), 40),
                         'items': pull.get('items') if isinstance(pull.get('items'), int) and not isinstance(pull.get('items'), bool) else None}

        items = None
        inventory_info = {'state': 'missing'}
        if inventory is not None:
            raw_items = inventory.get('items')
            if not isinstance(raw_items, list):
                files['scope-items.json'] = {'state': 'invalid', 'error': 'items is not a list'}
                inventory_info = {'state': 'invalid'}
            else:
                items = [i for i in (_item(v) for v in raw_items[:MAX_ITEMS]) if i is not None]
                inventory_info = {'state': 'ok', 'source': _s(inventory.get('source'), 20),
                                  'generated_at': _time_field(inventory.get('generated_at')),
                                  'count': len(raw_items), 'truncated': len(raw_items) > MAX_ITEMS,
                                  'skipped': min(len(raw_items), MAX_ITEMS) - len(items)}
        elif files['scope-items.json']['state'] != 'missing':
            inventory_info = {'state': files['scope-items.json']['state']}

        if items is not None:
            enforced = [i for i in items if i['enforced']]
            rules = {'source': 'inventory',
                     'in': _rule_list([i['identifier'] for i in enforced if i['in_scope'] is True]),
                     'out': _rule_list([i['identifier'] for i in enforced if i['in_scope'] is False])}
        elif in_rules is not None or out_rules is not None:
            rules = {'source': 'txt', 'in': _rule_list(in_rules or []), 'out': _rule_list(out_rules or [])}
        else:
            rules = {'source': 'none', 'in': _rule_list([]), 'out': _rule_list([])}

        assets = [i for i in (items or []) if i['kind'] in ASSET_KINDS or not i['known_kind']]
        history = {'entries': [history_entry(line) for line in tail], 'more': more}
        policy = {'text': policy_text(policy_raw)} if policy_raw is not None else None
        mtimes = {}
        for name in ('assets.json', 'in-scope.txt'):
            sig = None if outside(directory / name, base) else stat_sig(directory / name)
            mtimes[name] = sig[2] / 1e9 if sig else None
        return {'files': files, 'pull': pull_info, 'inventory': inventory_info, 'rules': rules, 'assets': assets,
                'history': history, 'policy': policy, 'mtimes': mtimes}

    # -- per-request: lanes, ages -------------------------------------------------
    def lane_info(self, root, program):
        """{lane name: newest top-level file mtime or None} for the program's discovered binaries lanes."""
        out = {}
        family = Path(root) / 'binaries'
        base = family / program
        if family.is_symlink() or base.is_symlink() or not base.is_dir():
            return out
        for lane in sorted(self.binaries_lanes):
            path = base / lane
            if path.is_symlink() or not path.is_dir():
                continue
            newest = None
            try:
                with os.scandir(path) as entries:
                    for index, entry in enumerate(entries):
                        if index >= LANE_SCAN:
                            break
                        if entry.is_file(follow_symlinks=False):
                            mtime = entry.stat(follow_symlinks=False).st_mtime
                            newest = mtime if newest is None or mtime > newest else newest
            except OSError:
                pass
            out[lane] = newest
        return out

    def payload(self, family, program, refresh=False):
        now = self.now()
        root = self.root_fn()
        result = {'version': 1, 'family': family, 'program': text(program, 200), 'copy_safe': not is_unsafe(program),
                  'computed_at': iso(now), 'stale_days': STALE_DAYS}
        if program.startswith(('_', '.')):
            # Discovery skips underscore and hidden program dirs; never turn them into paths here.
            result['scope'] = {'state': 'failed', 'reason': 'not a discovered program'}
            return result
        directory, reason = resolve_scope_dir(root, program)
        if directory is None:
            result['scope'] = {'state': 'none' if reason == NO_SCOPE else 'failed', 'reason': text(reason, 200)}
            return result
        # Files inside the scope dir may be links, but only to somewhere inside <root>/scopes.
        parsed = self._parsed(program, directory, (Path(root) / 'scopes').resolve(), refresh)
        result['scope'] = {'state': 'loaded', 'alias': directory.name != program, 'reason': ''}
        result.update({k: parsed[k] for k in ('files', 'pull', 'inventory', 'rules', 'policy')})

        # Freshness: scope-pull.json pulled_at, else an estimate from file mtimes.
        pulled = (parsed['pull'] or {}).get('pulled_at') or {}
        pulled_ts, source = pulled.get('ts'), 'scope-pull.json'
        if pulled_ts is None:
            for name in ('assets.json', 'in-scope.txt'):
                if parsed['mtimes'].get(name) is not None:
                    pulled_ts, source = parsed['mtimes'][name], name
                    break
            else:
                source = None
        age = None if pulled_ts is None else max(0, math.floor((now - pulled_ts) / 86400))
        last = parsed['pull'] or {}
        result['freshness'] = {'pulled_ts': pulled_ts, 'pulled_at': iso(pulled_ts), 'estimated': source not in (None, 'scope-pull.json'),
                               'source': source, 'age_days': age, 'stale': age is None or age >= STALE_DAYS,
                               'last_attempt_status': last.get('last_attempt_status'), 'last_attempt_at': last.get('last_attempt_at'),
                               'last_error': last.get('last_error'), 'failed': last.get('last_attempt_status') == 'failed',
                               'platform': last.get('platform')}

        # Stat binaries lanes only when an asset can link to one.
        linkable = any(item['kind'] in LANE_FOR_KIND for item in parsed['assets'])
        lanes = self.lane_info(root, program) if root is not None and linkable else {}
        assets = []
        for item in parsed['assets']:
            item = dict(item)
            lane = next((name for name in LANE_FOR_KIND.get(item['kind'], ()) if name in lanes), None)
            item['lane'] = {'program': f'binaries/{program}', 'lane': lane, 'updated_ts': lanes[lane]} if lane else None
            release = item['release']
            if release is not None:
                release = dict(release)
                changed = (release.get('changed_at') or {}).get('ts')
                updated = lanes.get(lane) if lane else None
                release['lane_stale'] = bool(lane and changed is not None and (updated is None or changed > updated))
                item['release'] = release
            assets.append(item)
        result['assets'] = assets
        result['history'] = parsed['history']
        return result


def handle_request(handler, url, service, families):
    """GET /api/scope?family=&program=[&refresh=1]."""
    from urllib.parse import parse_qs
    if service is None:
        return handler.reply(404, {'error': 'scope_unavailable'})
    try:
        params = parse_qs(url.query, keep_blank_values=True, strict_parsing=True, max_num_fields=3, encoding='utf-8', errors='strict')
        if not {'family', 'program'} <= set(params) or set(params) - {'family', 'program', 'refresh'} \
                or any(len(v) != 1 for v in params.values()) or params.get('refresh', ['0'])[0] not in ('0', '1'):
            raise ValueError('invalid parameters')
        family, program = params['family'][0], params['program'][0]
        if family not in families or not program or len(program) > 200 or '\0' in program or '/' in program or program in ('.', '..'):
            raise ValueError('invalid program')
    except (ValueError, UnicodeError):
        return handler.reply(400, {'error': 'invalid_scope_request'})
    return handler.reply(200, service.payload(family, program, refresh=params.get('refresh') == ['1']))
