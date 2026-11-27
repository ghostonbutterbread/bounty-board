"""Background, memory-bounded search index over programs, findings and reports.

The index is a read-only view built with the same safe readers the Board uses
(`read_file`, `ledger`). A single background thread refreshes it incrementally:
a lane's ledger is re-parsed only when its stat signature changes and a report
is re-read only when its (mtime, size, inode) changes. Each lane is replaced
atomically, so searches never wait for a refresh; the only lock is the pass
lock that serializes refreshes. Nothing here writes to the data root.
"""
import heapq
import os
import re
from collections import Counter
import stat as stat_module
import threading
import time
from pathlib import Path

from report_evidence import is_evidence, recorded_paths, reports_relative
import finding_facets
from report_packets import LEGACY_NAME as _LEGACY_NAME, PACKET_DIR as _PACKET_DIR, counts_for_time, \
    is_meta, packet_folder, plan as packet_plan

SEVERITY_RANK = {'EXCEPTIONAL': 6, 'CRITICAL': 5, 'HIGH': 4, 'MEDIUM': 3, 'LOW': 2, 'INFO': 1}
KINDS = ('program', 'finding', 'report')
MAX_TERMS = 6
MAX_QUERY = 200
_CONTROL = re.compile(r'[\x00-\x08\x0b-\x1f\x7f  ]')
_SPACE = re.compile(r'\s+')
_HEADING = re.compile(r'^#{1,6}\s+(.+?)\s*#*\s*$')
# Report -> finding mapping by location: a packet folder directly under
# reports/ ("F012-xss/...", "F012/...") or a legacy "<FID> - Title.md" file
# (patterns shared with report_packets).


def packet_meta(rel):
    """True for a file under a finding packet's _meta/ folder ("F012-xss/_meta/...").

    Such files are packet bookkeeping: Recent and search hide them like
    generated navigation (Recent shows them with its navigation toggle)."""
    return is_meta(rel)


def fold(text):
    """Lowercase without changing length, so offsets map back to the original."""
    return ''.join(c.lower() if len(c.lower()) == 1 else c for c in text)


def plain(text):
    return _SPACE.sub(' ', _CONTROL.sub(' ', text)).strip()


def parse_terms(query):
    return [t for t in fold(plain(query)).split(' ') if t][:MAX_TERMS]


def ranges_for(text, terms, limit=8):
    """Merged [start, end] spans of every term in `text` (for safe highlighting)."""
    low = fold(text)
    spans = []
    for term in terms:
        start = low.find(term)
        while start != -1 and len(spans) < limit * 3:
            spans.append([start, start + len(term)])
            start = low.find(term, start + len(term))
    spans.sort()
    merged = []
    for span in spans:
        if merged and span[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], span[1])
        else:
            merged.append(span)
    return merged[:limit]


def _signature(stat):
    return (stat.st_mtime_ns, stat.st_size, stat.st_ino)


def _title_of(text, fallback):
    for line in text.split('\n', 40)[:40]:
        match = _HEADING.match(line.strip())
        if match:
            return plain(match.group(1))[:160] or fallback
    return fallback


def sub_of(owner):
    return owner['submission_key'] if owner is not None else finding_facets.NONE


class SearchIndex:
    def __init__(self, root_snapshot, families, read_file, ledger, generated_navigation, *,
                 interval=5.0, max_report_chars=60_000, max_total_chars=24_000_000, max_reports=60_000):
        self._root_snapshot = root_snapshot
        self._families = families
        self._read_file = read_file
        self._ledger = ledger
        self._generated_navigation = generated_navigation
        self.interval = interval
        self.max_report_chars = max_report_chars
        self.max_total_chars = max_total_chars
        self.max_reports = max_reports
        self._lanes = {}
        self._instance = None
        self._built = False
        self._warnings = ()
        self._chars = 0
        self._report_count = 0
        self._pass_lock = threading.Lock()
        self._wake = threading.Event()
        self._stopped = threading.Event()
        self._first_pass = threading.Event()
        self._thread = None
        self._start_lock = threading.Lock()
        self._last_pass = 0.0
        self._last_search = 0.0
        self.passes = 0
        # touch() bumps _touch_gen; a pass that started after it records it in
        # _fresh_gen, so recent(fresh_wait) never answers from a pass that may
        # have read the ledger before the write.
        self._touch_gen = 0
        self._fresh_gen = 0

    # ---- lifecycle -------------------------------------------------------
    def start(self):
        with self._start_lock:
            if self._thread is None and not self._stopped.is_set():
                self._thread = threading.Thread(target=self._run, name='board-search-index', daemon=True)
                self._thread.start()

    def close(self):
        self._stopped.set()
        self._wake.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)

    def _run(self):
        while not self._stopped.is_set():
            self._wake.clear()
            try:
                self.refresh()
            except Exception:  # keep serving the last good index; retry next pass
                self._warnings = tuple(sorted(set(self._warnings) | {'refresh_failed'}))
            idle = time.monotonic() - self._last_search > 60
            self._wake.wait(None if idle else self.interval)

    def touch(self):
        """Mark the index stale (a finding was written): the next recent() with
        fresh_wait redoes a pass first instead of waiting for the interval."""
        self._touch_gen += 1
        self._last_pass = 0.0
        self._wake.set()

    def invalidate(self):
        """Drop everything (root changed); the next pass rebuilds from scratch."""
        self._lanes = {}
        self._instance = None
        self._built = False
        self._first_pass.clear()
        self._chars = self._report_count = 0
        self._wake.set()

    # ---- indexing --------------------------------------------------------
    def refresh(self):
        with self._pass_lock:
            generation = self._touch_gen
            snapshot = self._root_snapshot()
            if snapshot is None:
                self._lanes, self._instance, self._built = {}, None, False
                self._warnings = ('root_unavailable',)
                return
            if snapshot[2] != self._instance:
                self._lanes, self._instance, self._built = {}, snapshot[2], False
            root = snapshot[0]
            warnings = set()
            budget = {'chars': 0, 'reports': 0}
            seen = set()
            for family, lane_names in self._families.items():
                base = root / family
                try:
                    if base.is_symlink() or not base.is_dir():
                        continue
                    programs = sorted(base.iterdir())
                except OSError:
                    warnings.add('discovery_incomplete')
                    continue
                for program in programs:
                    if self._stopped.is_set():
                        return
                    try:
                        if program.name.startswith('_') or program.is_symlink() or not program.is_dir():
                            continue
                        lanes = sorted(program.iterdir())
                    except OSError:
                        warnings.add('discovery_incomplete')
                        continue
                    for lane in lanes:
                        try:
                            if lane.name not in lane_names or lane.is_symlink() or not lane.is_dir():
                                continue
                        except OSError:
                            continue
                        key = (family, program.name, lane.name)
                        seen.add(key)
                        self._lanes[key] = self._scan_lane(lane, key, self._lanes.get(key), budget, warnings)
            for key in set(self._lanes) - seen:
                self._lanes.pop(key, None)
            if self._root_snapshot() != snapshot:
                self._lanes, self._instance, self._built = {}, None, False
                return
            self._chars, self._report_count = budget['chars'], budget['reports']
            self._warnings = tuple(sorted(warnings))
            self._built = True
            self._first_pass.set()
            self._last_pass = time.monotonic()
            self._fresh_gen = max(self._fresh_gen, generation)
            self.passes += 1

    def _scan_lane(self, lane, key, old, budget, warnings):
        family, program, name = key
        try:
            ledger_sig = _signature(os.lstat(lane / 'ledgers' / 'ledger.json'))
        except OSError:
            ledger_sig = None
        if old is not None and old['ledger_sig'] == ledger_sig:
            raw_findings = old['raw_findings']
        else:
            lane_warnings = []
            raw = self._ledger(lane, lane_warnings) if ledger_sig is not None else None
            raw_findings = [{**{k: f.get(k) for k in ('fid', 'title', 'class_name', 'severity', 'status',
                                                      'report_path', 'evidence_path', 'submission_status',
                                                      'metadata_revision')},
                             'submission': self._submission(f.get('submission'))} for f in raw or []]
            # Facet keys (finding_facets), normalized once per ledger change and
            # cached with the ledger signature, never per request.
            for f in raw_findings:
                f['severity_key'] = finding_facets.severity_key(f)
                f['class_info'] = finding_facets.class_info(f)
                f['submission_key'] = finding_facets.submission_key(f)
            if 'ledger_unavailable_or_invalid' in lane_warnings:
                warnings.add('ledger_unavailable')
        old_reports = old['reports'] if old is not None else {}
        reports = {}
        # Evidence files (report_evidence.is_evidence) are artifacts of their
        # finding, not reports: kept by path only (no read, no budget) so a
        # finding hit can still link its evidence.
        evidence = {}
        # Packet files (report_packets): every Markdown file of a finding
        # packet other than its main report. Kept by path only (no read, no
        # budget), so links to them resolve to the main report.
        packet_files = {}
        report_paths, evidence_paths = recorded_paths(raw_findings, lane)
        base = lane / 'reports'
        found, other = [], []
        if base.is_dir() and not base.is_symlink():
            for rel, filename, stat, markdown in self._walk(base, warnings):
                if not markdown:
                    other.append((rel, stat.st_mtime))
                elif is_evidence(rel, report_paths, evidence_paths):
                    evidence[rel] = {'mtime': stat.st_mtime}
                else:
                    found.append((rel, filename, stat))
        def navigation_page(rel):
            try:
                return bool(self._generated_navigation(rel, self._read_file(lane, 'reports/' + rel).decode('utf-8')))
            except (OSError, ValueError, UnicodeError):
                return False
        packets = packet_plan([(rel, stat.st_mtime) for rel, _, stat in found], raw_findings, lane, other,
                              [(rel, e['mtime']) for rel, e in evidence.items()], is_navigation=navigation_page)
        for rel, filename, stat in found:
            if rel in packets.files:
                packet_files[rel] = {**packets.files[rel], 'mtime': stat.st_mtime}
                continue
            if budget['reports'] >= self.max_reports:
                warnings.add('report_limit')
                break
            budget['reports'] += 1
            sig = _signature(stat)
            previous = old_reports.get(rel)
            room = budget['chars'] < self.max_total_chars
            # Reuse indexed text only while the budget has room for it, so
            # max_total_chars bounds memory across refreshes too.
            if previous is not None and previous['sig'] == sig and (
                    (previous['has_text'] and (room or not previous['text'])) or (not previous['has_text'] and not room)):
                entry = previous
            else:
                entry = self._read_report(lane, rel, filename, sig, stat.st_mtime, room, warnings)
            budget['chars'] += len(entry['text'])
            if not entry['has_text']:
                warnings.add('content_limit' if entry['unread'] != 'error' else 'content_unavailable')
            elif entry['truncated']:
                warnings.add('content_truncated')
            entry['meta'] = packet_meta(rel)
            main = packets.mains.get(rel)
            # A packet's main report carries the packet's time (newest file).
            entry['packet'] = main
            entry['mtime'] = main['modified'] if main is not None and main['modified'] is not None else stat.st_mtime
            reports[rel] = entry
        owners = self._ownership(lane, raw_findings)
        findings = []
        for f in raw_findings:
            fid = f.get('fid')
            if fid is None:
                continue
            link = None
            target = reports_relative(f.get('report_path'), lane)
            if target in packet_files:
                target = packet_files[target]['main']
            if target in reports and not reports[target]['nav']:
                link = {'path': target, 'kind': 'report'}
            else:
                target = reports_relative(f.get('evidence_path'), lane)
                if target in evidence:
                    link = {'path': target, 'kind': 'evidence'}
            title = plain(str(f.get('title') or ''))
            fields = {'fid': plain(str(fid)), 'title': title, 'class': plain(str(f.get('class_name') or '')),
                      'severity': plain(str(f.get('severity') or '')), 'status': plain(str(f.get('status') or ''))}
            findings.append({**fields, 'low': {k: fold(v) for k, v in fields.items()}, 'link': link})
        unique = self._unique_fids(raw_findings)
        for rel, entry in reports.items():
            # A file an evidence_path names is evidence (never in `reports`),
            # so ownership here comes from report_path only.
            registered = owners['report_path'].get(rel, [])
            main = entry.get('packet')
            if main is not None and not entry['nav']:
                registered = list(dict.fromkeys([*map(str, registered), *main['owner_fids']]))
            entry['owner_fids'] = [str(x) for x in registered]
            entry['report_kind'] = ('registered_report' if registered
                                    else 'generated_report' if entry['generated'] else 'unregistered')
            if entry['nav']:
                entry['finding_fid'], entry['finding_match'] = None, None
            elif main is not None:
                entry['finding_fid'], entry['finding_match'] = main['finding']
            else:
                entry['finding_fid'], entry['finding_match'] = self._map_finding(rel, registered, [], unique)
        fid_counts = Counter(f.get('fid') for f in raw_findings)
        by_fid = {f['fid']: f for f in raw_findings if isinstance(f.get('fid'), str) and fid_counts[f['fid']] == 1}
        return {'family': family, 'program': program, 'lane': name, 'ledger_sig': ledger_sig,
                'raw_findings': raw_findings, 'by_fid': by_fid, 'findings': findings, 'reports': reports, 'evidence': evidence,
                'packet_files': packet_files}

    @staticmethod
    def _walk(base, warnings):
        """Yield (relative path, name, lstat, is_markdown) of regular files; never follows symlinks.

        Every .md file, plus the other files inside a finding packet that move
        its time (report_packets.counts_for_time), which are never read."""
        stack = [(str(base), '')]
        while stack:
            directory, prefix = stack.pop()
            try:
                with os.scandir(directory) as entries:
                    listing = sorted(entries, key=lambda e: e.name)
            except OSError:
                warnings.add('reports_unavailable')
                continue
            for entry in listing:
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        stack.append((entry.path, prefix + entry.name + '/'))
                        continue
                    markdown = entry.name[-3:].lower() == '.md'
                    if not markdown and not (prefix and packet_folder(prefix + entry.name) and counts_for_time(prefix + entry.name)):
                        continue
                    stat = entry.stat(follow_symlinks=False)
                    if stat_module.S_ISREG(stat.st_mode):
                        yield prefix + entry.name, entry.name, stat, markdown
                except OSError:
                    continue

    def _read_report(self, lane, rel, filename, sig, mtime, room, warnings):
        stem = filename[:-3]
        entry = {'sig': sig, 'mtime': mtime, 'title': stem, 'text': '', 'low': '', 'path_low': fold(rel), 'title_low': fold(stem), 'base_low': fold(stem),
                 'has_text': False, 'truncated': False, 'nav': False, 'generated': False,
                 'unread': 'budget', 'owner_fids': [], 'report_kind': 'unregistered',
                 'finding_fid': None, 'finding_match': None}
        try:
            text = self._read_file(lane, 'reports/' + rel).decode('utf-8')
        except (OSError, ValueError, UnicodeError):
            entry['unread'] = 'error'
            return entry
        # Classify and title every report, even past the budget: the budget
        # bounds stored text, and without this a navigation stub would show
        # in Recent as a normal report once the budget is spent.
        entry['nav'] = bool(self._generated_navigation(rel, text))
        entry['generated'] = '<!-- generated: bounty-core-finding-report -->' in text
        entry['title'] = _title_of(text, stem)
        entry['title_low'] = fold(entry['title'])
        if entry['nav']:
            entry['has_text'] = True
            entry['unread'] = ''
            return entry
        if not room:
            return entry
        capped = text[:self.max_report_chars]
        entry['truncated'] = len(capped) < len(text)
        entry['text'] = _CONTROL.sub(' ', capped)
        entry['low'] = fold(entry['text'])
        entry['has_text'] = True
        entry['unread'] = ''
        return entry

    @staticmethod
    def _submission(value):
        if not isinstance(value, dict):
            return None
        return {k: value.get(k) if isinstance(value.get(k), str) else None for k in ('state', 'result')}

    @staticmethod
    def _unique_fids(raw_findings):
        """{FID folded to upper case: ledger FID} for string FIDs occurring exactly once."""
        seen = {}
        for f in raw_findings:
            fid = f.get('fid')
            if isinstance(fid, str) and fid:
                seen.setdefault(fid.upper(), []).append(fid)
        return {key: fids[0] for key, fids in seen.items() if len(fids) == 1}

    @staticmethod
    def _map_finding(rel, registered, evidence, unique):
        """(fid, match) for one non-navigation report, or (None, None).

        Priority: report_path owner, evidence_path owner, packet folder (first
        path segment "<FID>" or "<FID>-..."), legacy "<FID> - Title.md" file
        name. Only FIDs occurring exactly once in the ledger map; a tier with
        several distinct owners is ambiguous and maps to nothing."""
        for owners, match in ((registered, 'report_path'), (evidence, 'evidence_path')):
            distinct = {str(fid) for fid in owners}
            if len(distinct) > 1:
                return None, None
            if distinct:
                fid = distinct.pop()
                return (fid, match) if unique.get(fid.upper()) == fid else (None, None)
        segments = rel.split('/')
        if len(segments) > 1:
            found = _PACKET_DIR.match(segments[0])
            if found and found.group(1).upper() in unique:
                return unique[found.group(1).upper()], 'packet'
        found = _LEGACY_NAME.match(segments[-1])
        if found and found.group(1).upper() in unique:
            return unique[found.group(1).upper()], 'legacy'
        return None, None

    def _ownership(self, lane, raw_findings):
        owners = {'report_path': {}, 'evidence_path': {}}
        for f in raw_findings:
            fid = f.get('fid')
            if not fid:
                continue
            for field in ('report_path', 'evidence_path'):
                rel = reports_relative(f.get(field), lane)
                if rel:
                    owners[field].setdefault(rel, []).append(fid)
        return owners

    # ---- state -----------------------------------------------------------
    def state(self):
        if not self._built:
            return 'building'
        return 'partial' if self._warnings else 'ready'

    # ---- search ----------------------------------------------------------
    def _activate(self, fresh_wait=0.0, keep_alive=True):
        """Wake the refresher when the index is stale.

        A cold index gets a short grace period so the first request is useful.
        `keep_alive` (searches) keeps the refresher passing every `interval`
        for the next minute. With `fresh_wait`, a pass older than the interval
        is redone first (bounded wait): one on-demand pass per request, so a
        polling view stays current without keeping the refresher busy.
        """
        if keep_alive:
            self._last_search = time.monotonic()
        wanted = self._touch_gen
        snapshot = self._root_snapshot()
        if snapshot is None or snapshot[2] != self._instance:
            if self._instance is not None:
                self.invalidate()
            self._wake.set()
            self.start()
        elif self._fresh_gen < wanted or time.monotonic() - self._last_pass > self.interval / 2:
            passes = self.passes
            touched = self._fresh_gen < wanted
            stale = fresh_wait and self._built and (touched or time.monotonic() - self._last_pass > self.interval)
            self._wake.set()
            self.start()
            if stale:
                deadline = time.monotonic() + fresh_wait
                while ((self.passes == passes or self._fresh_gen < wanted) and time.monotonic() < deadline
                       and not self._stopped.is_set()):
                    time.sleep(0.02)
        self.start()
        if not self._built:
            self._first_pass.wait(1.5)
            snapshot = self._root_snapshot()
        return snapshot

    def search(self, query, *, limit=8, program=None, kinds=KINDS):
        started = time.perf_counter()
        snapshot = self._activate()
        terms = parse_terms(query)
        lanes = list(self._lanes.values())
        groups = {'programs': [], 'findings': [], 'reports': []}
        counts = {kind: 0 for kind in KINDS}
        if terms and self._instance is not None and snapshot is not None and snapshot[2] == self._instance:
            if program:
                lanes = [l for l in lanes if program in (f"{l['family']}/{l['program']}", l['program'])]
            full = ' '.join(terms)
            heaps = {kind: [] for kind in KINDS}
            now = time.time()
            seq = 0
            if 'program' in kinds:
                seen = {}
                for l in lanes:
                    entry = seen.setdefault((l['family'], l['program']), {'lanes': [], 'findings': 0, 'reports': 0})
                    entry['lanes'].append(l['lane'])
                    entry['findings'] += len(l['findings'])
                    entry['reports'] += sum(1 for r in l['reports'].values() if not r['nav'] and not r.get('meta'))
                for (family, name), info in seen.items():
                    score = self._score_program(terms, full, fold(name), fold(f'{family}/{name}'))
                    if score:
                        counts['program'] += 1
                        seq += 1
                        heapq.heappush(heaps['program'], (score, -seq, {'kind': 'program', 'id': f'{family}/{name}',
                                       'name': name, 'family': family, 'lanes': info['lanes'],
                                       'finding_count': info['findings'], 'report_count': info['reports'],
                                       'score': score, 'title_ranges': ranges_for(name, terms),
                                       'target': {'program': f'{family}/{name}', 'section': 'findings'}}))
                        if len(heaps['program']) > limit:
                            heapq.heappop(heaps['program'])
            for l in lanes:
                pid = f"{l['family']}/{l['program']}"
                if 'finding' in kinds:
                    for f in l['findings']:
                        score = self._score_finding(terms, full, f['low'])
                        if not score:
                            continue
                        counts['finding'] += 1
                        score += SEVERITY_RANK.get(f['severity'].upper(), 0)
                        seq += 1
                        if len(heaps['finding']) >= limit and (score, -seq) < heaps['finding'][0][:2]:
                            continue
                        link = f['link']
                        report = None
                        if link:
                            r = l['reports'][link['path']] if link['kind'] == 'report' else {'title': 'Evidence'}
                            report = {'path': link['path'], 'title': r['title'], 'kind': link['kind'],
                                      'target': {'program': pid, 'lane': l['lane'], 'section': 'reports', 'report': link['path']}}
                        item = {'kind': 'finding', 'fid': f['fid'], 'title': f['title'] or 'Untitled finding',
                                'severity': f['severity'], 'status': f['status'], 'class': f['class'],
                                'program': pid, 'program_name': l['program'], 'lane': l['lane'], 'score': score,
                                'title_ranges': ranges_for(f['title'], terms), 'report': report,
                                'target': {'program': pid, 'lane': l['lane'], 'section': 'findings', 'finding': f['fid']}}
                        heapq.heappush(heaps['finding'], (score, -seq, item))
                        if len(heaps['finding']) > limit:
                            heapq.heappop(heaps['finding'])
                if 'report' in kinds:
                    for rel, r in l['reports'].items():
                        if r['nav'] or r.get('meta'):
                            continue
                        hit = self._score_report(terms, full, r, now)
                        if not hit:
                            continue
                        score, position = hit
                        counts['report'] += 1
                        seq += 1
                        if len(heaps['report']) >= limit and (score, -seq) < heaps['report'][0][:2]:
                            continue
                        snippet = self._snippet(r, terms, position)
                        item = {'kind': 'report', 'path': rel, 'title': r['title'], 'program': pid,
                                'program_name': l['program'], 'lane': l['lane'], 'report_kind': r['report_kind'],
                                'owner_fids': r['owner_fids'][:5], 'score': round(score, 2),
                                'snippet': snippet, 'snippet_ranges': ranges_for(snippet, terms) if snippet else [],
                                'title_ranges': ranges_for(r['title'], terms), 'modified': int(r['mtime']),
                                'truncated': r['truncated'] or not r['has_text'],
                                'target': {'program': pid, 'lane': l['lane'], 'section': 'reports', 'report': rel}}
                        heapq.heappush(heaps['report'], (score, -seq, item))
                        if len(heaps['report']) > limit:
                            heapq.heappop(heaps['report'])
            for kind, group in (('program', 'programs'), ('finding', 'findings'), ('report', 'reports')):
                groups[group] = [item for _, _, item in sorted(heaps[kind], key=lambda x: (-x[0], -x[1]))]
        return {'query': plain(query), 'index_state': self.state(), 'root_instance': self._instance,
                'limit': limit, 'counts': counts, 'results': groups, 'warnings': list(self._warnings),
                'took_ms': round((time.perf_counter() - started) * 1000, 2)}

    # ---- recent reports ----------------------------------------------------
    def recent(self, *, limit=50, offset=0, within=None, programs=(), lane=None, lanes=(), query='',
               order='newest', include_navigation=False, fresh_wait=2.0, na_keys=None, hide_na=False,
               severities=(), classes=(), submissions=()):
        """Reports across every program and lane ordered by file modification time.

        One row per finding packet (report_packets): the main report, at the
        newest time of any file in the packet, with `updated_file` naming that
        file (packet-relative) when it is not the main report.

        Filters: `within` (seconds before now), `programs` (ids "family/name"),
        `lanes` (or the older single `lane`), `query` (every term must occur in
        the title or path), `severities`, `classes` and `submissions` (facet
        keys from finding_facets; "none" selects reports with no linked
        finding), and generated navigation and packet `_meta/` files (excluded
        unless `include_navigation`). OR within a filter, AND across filters.
        Facet counts for programs, lanes, severities, classes and submissions
        each ignore their own filter.

        `order`: newest, oldest, severity (highest first, ties newest first,
        no linked finding last) or class (category label A to Z, Unclassified
        then no linked finding last, ties by severity then newest).

        `na_keys` is the set of Board N/A marks ("family/program/lane/path"),
        or None when that store is unavailable. With `hide_na`, marked reports
        are left out of items, totals and facets; `na_hidden` counts those that
        match every other filter and `na_hidden_page` those whose sort position
        falls within the returned page's span.
        """
        started = time.perf_counter()
        snapshot = self._activate(fresh_wait, keep_alive=False)
        now = time.time()
        since = now - within if within is not None else None
        terms = parse_terms(query)
        wanted = set(programs)
        wanted_lanes = set(lanes) | ({lane} if lane is not None else set())
        wanted_sev, wanted_cls, wanted_sub = set(severities), set(classes), set(submissions)
        marks = na_keys if na_keys is not None else frozenset()
        hiding = bool(hide_na and marks)
        matches = []
        hidden = []
        names = {}
        counts = {'program': {}, 'lane': {}, 'sev': {}, 'cls': {}, 'sub': {}}
        present = set()  # class keys of rows that pass the non-facet filters
        total_reports = 0
        if self._instance is not None and snapshot is not None and snapshot[2] == self._instance:
            for l in list(self._lanes.values()):
                pid = f"{l['family']}/{l['program']}"
                names[pid] = (l['program'], l['family'])
                in_program = not wanted or pid in wanted
                in_lane = not wanted_lanes or l['lane'] in wanted_lanes
                by_fid = l.get('by_fid', {})
                prefix = f"{pid}/{l['lane']}/"
                for rel, r in l['reports'].items():
                    if (r['nav'] or r.get('meta')) and not include_navigation:
                        continue
                    na = prefix + rel in marks
                    if not (na and hiding):
                        total_reports += 1
                    if since is not None and r['mtime'] < since:
                        continue
                    if terms and not all(t in r['title_low'] or t in r['path_low'] for t in terms):
                        continue
                    owner = by_fid.get(r.get('finding_fid')) if r.get('finding_fid') else None
                    if owner is None:
                        sev, cls, sub = finding_facets.NONE, finding_facets.NONE, finding_facets.NONE
                    else:
                        sev, cls, sub = owner['severity_key'], owner['class_info']['category'], owner['submission_key']
                    ok = {'program': in_program, 'lane': in_lane, 'sev': not wanted_sev or sev in wanted_sev,
                          'cls': not wanted_cls or cls in wanted_cls, 'sub': not wanted_sub or sub in wanted_sub}
                    every = all(ok.values())
                    if na and hiding:
                        if every:
                            hidden.append(((r['mtime'], pid, l['lane'], rel), sev, cls, None))
                        continue
                    present.add(cls)  # after the N/A check: hidden reports add no class option
                    for facet, key in (('program', pid), ('lane', l['lane']), ('sev', sev), ('cls', cls), ('sub', sub)):
                        if all(v for k, v in ok.items() if k != facet):
                            counts[facet][key] = counts[facet].get(key, 0) + 1
                    if every:
                        matches.append(((r['mtime'], pid, l['lane'], rel), sev, cls, (r, owner, na)))
        all_class_labels = dict(finding_facets.class_options())

        def order_rows(rows):
            rows.sort(key=lambda m: m[0], reverse=order != 'oldest')
            if order == 'severity':
                rows.sort(key=lambda m: finding_facets.SEVERITY_RANK[m[1]])
            elif order == 'class':
                rows.sort(key=lambda m: (finding_facets.class_sort(m[2], all_class_labels.get(m[2], m[2])),
                                         finding_facets.SEVERITY_RANK[m[1]]))
            return rows
        order_rows(matches)
        page_hidden = 0
        if hidden:
            # Hidden reports between the previous page's last item (or the
            # list start) and this page's last item.
            visible = run = 0
            for m in order_rows(matches + hidden):
                if visible >= offset + limit:
                    break
                if m[3] is None:
                    run += 1
                    continue
                if visible >= offset:
                    page_hidden += run
                run = 0
                visible += 1
        items = []
        for (mtime, pid, lane_name, rel), sev, cls, (r, owner, na) in matches[offset:offset + limit]:
            finding = None
            if owner is not None:
                finding = {'fid': owner['fid'], 'title': owner['title'], 'severity': owner['severity'],
                           'status': owner['status'], 'submission': owner.get('submission'),
                           'submission_status': owner.get('submission_status'),
                           'metadata_revision': owner.get('metadata_revision'), 'match': r['finding_match'],
                           'class': dict(owner['class_info']), 'severity_key': sev}
            items.append({'path': rel, 'name': rel.rsplit('/', 1)[-1], 'title': r['title'], 'program': pid,
                          'program_name': names[pid][0], 'family': names[pid][1], 'lane': lane_name,
                          'modified': mtime, 'report_kind': 'generated_navigation' if r['nav'] else r['report_kind'],
                          'owner_fids': r['owner_fids'][:5], 'finding': finding, 'submission_key': sub_of(owner),
                          'na': na, 'packet_meta': bool(r.get('meta')),
                          'packet': r['packet']['packet'] if r.get('packet') else None,
                          'updated_file': r['packet']['updated_file'] if r.get('packet') else None,
                          'target': {'program': pid, 'lane': lane_name, 'section': 'reports', 'report': rel}})

        def facet(name, options, shown=None):
            # Severity and submission list every option (zero counts included);
            # classes list those present without the facet filters, plus selected ones.
            return [{'key': k, 'label': label, 'count': counts[name].get(k, 0)} for k, label in options
                    if shown is None or k in shown]
        return {'index_state': self.state(), 'root_instance': self._instance, 'now': now,
                'total': len(matches), 'total_reports': total_reports, 'offset': offset, 'limit': limit, 'order': order,
                'items': items, 'na_available': na_keys is not None, 'na_hidden': len(hidden),
                'na_hidden_page': page_hidden,
                'facets': {'programs': sorted(({'id': pid, 'name': names[pid][0], 'family': names[pid][1], 'count': n}
                                               for pid, n in counts['program'].items()), key=lambda x: (x['name'].lower(), x['id'])),
                           'lanes': [{'name': k, 'count': v} for k, v in sorted(counts['lane'].items())],
                           'severities': facet('sev', finding_facets.SEVERITIES),
                           'classes': facet('cls', sorted(finding_facets.class_options(), key=lambda o: finding_facets.class_sort(*o)),
                                            present | wanted_cls),
                           'submissions': facet('sub', finding_facets.SUBMISSIONS)},
                'warnings': list(self._warnings), 'took_ms': round((time.perf_counter() - started) * 1000, 2)}

    # ---- scoring ---------------------------------------------------------
    @staticmethod
    def _text_score(term, text, exact, prefix, word, substring):
        if text == term:
            return exact
        if text.startswith(term):
            return prefix
        if text.find(term) == -1:
            return 0
        return word if (' ' + term) in (' ' + text) or any(sep + term in text for sep in ('-', '_', '/', '.')) else substring

    def _score_program(self, terms, full, name, pid):
        total = 0
        for term in terms:
            score = self._text_score(term, name, 100, 80, 60, 40) or (20 if term in pid else 0)
            if not score:
                return 0
            total += score
        return total + (40 if name == full else 0)

    def _score_finding(self, terms, full, low):
        total = 0
        for term in terms:
            best = max(self._text_score(term, low['fid'], 100, 70, 50, 50),
                       self._text_score(term, low['title'], 60, 65, 55, 40),
                       self._text_score(term, low['class'], 40, 35, 30, 15),
                       self._text_score(term, low['severity'], 35, 35, 15, 15),
                       self._text_score(term, low['status'], 30, 30, 15, 15))
            if not best:
                return 0
            total += best
        if low['title'] == full:
            total += 60
        elif low['title'].startswith(full):
            total += 30
        return total

    def _score_report(self, terms, full, r, now):
        title = r['title_low']
        path = r['path_low']
        base = r['base_low']
        total = 0
        position = None
        for term in terms:
            best = max(self._text_score(term, title, 90, 60, 50, 45),
                       self._text_score(term, base, 70, 55, 45, 40),
                       40 if term in path else 0)
            if not best and r['low']:
                at = r['low'].find(term)
                if at != -1:
                    best = 10 + (3 if r['low'].find(term, at + len(term)) != -1 else 0)
                    if position is None:
                        position = (at, len(term))
            if not best:
                return None
            total += best
        if title == full:
            total += 60
        age_days = max(0.0, (now - r['mtime']) / 86400)
        total += 5 * max(0.0, 1 - age_days / 60) + (3 if r['owner_fids'] else 0)
        return total, position

    @staticmethod
    def _snippet(r, terms, position):
        text = r['text']
        if not text:
            return ''
        if position is None:
            at = next((r['low'].find(t) for t in terms if r['low'].find(t) != -1), -1)
            if at == -1:
                body = [l for l in text.split('\n') if l.strip() and not l.lstrip().startswith('#')]
                return plain(' '.join(body))[:160]
            position = (at, len(terms[0]))
        start = max(0, position[0] - 60)
        end = min(len(text), position[0] + position[1] + 100)
        snippet = plain(text[start:end])
        return ('…' if start else '') + snippet + ('…' if end < len(text) else '')
