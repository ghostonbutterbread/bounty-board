"""Local, read-only Bounty Board server."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Literal, overload
from urllib.parse import urlsplit, parse_qs

from taxonomy import annotate_finding
from recon_intel import BBH_LANES, MARK_STATUSES

# Parameter locations accepted for a Board URL mark (BBH stores any string; these are its documented examples plus path/json).
MARK_LOCATIONS = ('query', 'body', 'header', 'cookie', 'path', 'json')

FAMILIES = {'web_bounty': {'web', 'api'}, 'binaries': {'apk', 'exe', 'mac'}}
SEVERITIES = ('EXCEPTIONAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN')
# Offered status values. Bounty Core lifecycle values (active is its default,
# pending-review) are offered too; BBH accepts any string, so a write may also
# use another safe token (STATUS_TOKEN), for example to restore a finding's
# exact previous status.
STATUSES = ('raw', 'confirmed', 'active', 'pending-review', 'dormant', 'novel', 'complete', 'archive')
STATUS_TOKEN = r'[a-z0-9][a-z0-9-]{0,39}'
ARCHIVE_STATUSES = ('archive', 'archived')
# Local submission bookkeeping accepted by BBH manual_hunter --set-submission.
SUBMISSION_STATES = ('not_submitted', 'submitted', 'dropped')
# One character of a single-line ledger value. BBH splits notes with
# str.splitlines(), which also breaks on U+0085, U+2028 and U+2029.
LINE_CHAR = r'[^\x00-\x1f\x7f\x85\u2028\u2029]'
SUBMISSION_RESULTS = ('valid', 'duplicate')
RECLASSIFY_UNSUPPORTED = 'Unavailable: the BBH writer does not offer agents/map_store.py write.'
GADGET_CHAIN_STATUSES = ('ready', 'deferred', 'watch')
RESIDUAL_CLASSES = ('reachability', 'format', 'enforcement-point', 'trust-anchor', 'oracle', 'capability')
METADATA_WRITE_WARNING = ('Uncoordinated metadata writes can overwrite concurrent edits, including edits '
                          'on other hosts or from sync clients; no shared compare-and-swap exists. '
                          'Stop other writers before editing.')


@overload
def read_file(root, relative, *, include_identity: Literal[False] = False) -> bytes: ...


@overload
def read_file(root, relative, *, include_identity: Literal[True]) -> tuple[bytes, tuple[int, int]]: ...


def read_file(root, relative, *, include_identity=False):
    """Open every path component without following symlinks."""
    import os
    parts = Path(relative).parts
    if not parts or any(p in ('..', '.', '/') for p in parts):
        raise ValueError('invalid path')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            import stat
            file_stat = os.fstat(file_fd)
            if not stat.S_ISREG(file_stat.st_mode):
                raise ValueError('not a regular file')
            with os.fdopen(file_fd, 'rb') as stream:
                file_fd = -1
                data = stream.read(5_000_001)
            if len(data) > 5_000_000:
                raise ValueError('file too large')
            return (data, (file_stat.st_dev, file_stat.st_ino)) if include_identity else data
        finally:
            if file_fd != -1:
                os.close(file_fd)
    finally:
        os.close(fd)


def ledger(lane, warnings, canonical_out=None):
    try:
        contents, identity = read_file(lane, 'ledgers/ledger.json', include_identity=True)
        raw = json.loads(contents)
        if not isinstance(raw, dict) or not isinstance(raw.get('findings'), list):
            raise ValueError('unsupported ledger shape')
        if any(not isinstance(entry, dict) for entry in raw['findings']):
            raise ValueError('unsupported finding shape')
        fields = ('fid', 'type', 'title', 'class_name', 'severity', 'status',
                  'review_tier', 'submission', 'submission_status', 'platform_outcome', 'file',
                  'severity_rationale', 'report_path', 'evidence_path', 'report_dir', 'current',
                  'first_seen', 'last_seen')
        # Reject unsafe JSON anywhere in this ledger, including fields that are
        # not currently projected, without exposing its contents in a warning.
        json.dumps(raw, ensure_ascii=False, allow_nan=False).encode('utf-8')
        import hashlib
        import os
        lane_stat = lane.stat()
        source = os.fsencode(f'{lane.resolve()}\0{lane_stat.st_dev}\0{lane_stat.st_ino}\0{identity[0]}\0{identity[1]}\0')
        result = [{**{field: entry.get(field) for field in fields},
                   # Additive display-time classification (taxonomy.py); raw class_name is unchanged.
                   **annotate_finding(entry),
                   'metadata_revision': hashlib.sha256(source + json.dumps(entry, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')).hexdigest(),
                   'status': entry.get('status') or (entry['current'].get('status') if isinstance(entry.get('current'), dict) else None),
                   'title': entry.get('title') or entry.get('type')} for entry in raw['findings']]
        if canonical_out is not None:
            # Same parsed bytes as the revisions above (used by ledger_snapshot).
            canonical_out.extend(json.dumps(entry, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
                                 for entry in raw['findings'])
        # Account for the actual portfolio nesting at the response boundary.
        json.dumps({'programs': [{'lanes': [{'findings': result}]}]},
                   ensure_ascii=False, allow_nan=False).encode('utf-8')
        return result
    except FileNotFoundError:
        warnings.append('ledger_missing')
    except (OSError, ValueError, UnicodeError, RecursionError):
        warnings.append('ledger_unavailable_or_invalid')
    return None


def ledger_snapshot(lane):
    """{fid: (metadata_revision, canonical entry JSON)} for unique FIDs, from one read."""
    canonical = []
    projected = ledger(lane, [], canonical) or []
    fids = [f.get('fid') for f in projected]
    return {f['fid']: (f['metadata_revision'], text) for f, text in zip(projected, canonical)
            if isinstance(f.get('fid'), str) and fids.count(f['fid']) == 1}


def map_entries(lane, warnings):
    try:
        raw = read_file(lane, 'recon/maps/map.jsonl').decode('utf-8')
        entries = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if any(not isinstance(item, dict) or not isinstance(item.get('tags', []), list) for item in entries):
            raise ValueError('unsupported map shape')
        fields = ('title', 'url', 'surface', 'scope', 'status', 'path', 'tags', 'timestamp')
        result = [{key: item.get(key) for key in fields} for item in entries]
        # Check at the actual portfolio nesting depth, before it can break the
        # response for every other lane during final JSON encoding.
        json.dumps({'programs': [{'lanes': [{'map': result}]}]}, ensure_ascii=False, allow_nan=False).encode('utf-8')
        return result
    except FileNotFoundError:
        warnings.append('map_missing')
    except (OSError, ValueError, UnicodeError, RecursionError):
        warnings.append('map_unavailable_or_invalid')
    return None


def coverage(lane, warnings):
    import sqlite3
    path = lane / 'ledgers' / 'surface_coverage.sqlite'
    try:
        # No immutable=1: it silently discards committed WAL transactions.
        for part in (lane / 'ledgers', path, Path(str(path) + '-wal'), Path(str(path) + '-shm')):
            if part.is_symlink():
                raise ValueError('symlink')
        if not path.exists():
            raise FileNotFoundError()
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.row_factory = sqlite3.Row
            db.execute('BEGIN')
            def extra(table, alias, names):
                # Optional provenance columns: older databases may lack them (shown as null).
                have = {r[1] for r in db.execute(f'PRAGMA table_info({table})')}
                return ', '.join(f'{alias}.{n}' if n in have else f'NULL AS {n}' for n in names)
            rows = db.execute('''SELECT s.id, s.kind, s.host, s.surface_key, s.input_key,
                s.consumer, s.fingerprint, s.run_id, a.class_name, a.status, a.pressure,
                a.reason, a.boundary, a.axes_json, a.evidence_json, a.reopen_when,
                a.assessed_fingerprint, {a_extra} FROM assessments a JOIN surfaces s ON s.id=a.surface_id'''.format(
                a_extra=extra('assessments', 'a', ('updated_at', 'agent', 'assessment_run_id')) + ', ' + extra('surfaces', 's', ('first_seen', 'last_seen')))).fetchall()
            kind_rows = db.execute('SELECT kind, COUNT(*) AS n FROM surfaces GROUP BY kind').fetchall()
            unassessed = [dict(row) for row in db.execute('''SELECT s.id AS surface_id, s.kind, s.host,
                s.surface_key, s.input_key, s.consumer, s.fingerprint, s.run_id, {s_extra}
                FROM surfaces s WHERE NOT EXISTS (SELECT 1 FROM assessments a WHERE a.surface_id=s.id)'''.format(
                s_extra=extra('surfaces', 's', ('first_seen', 'last_seen'))))]
            unclassified = len(unassessed)
        finally:
            db.close()
        # SQLite's dynamic typing permits BLOBs even in TEXT columns. Reject
        # non-JSON scalars here, before freshness calculation or API encoding.
        import math
        def validate_scalars(values):
            for value in values:
                if value is None or isinstance(value, int):
                    continue
                if isinstance(value, float) and math.isfinite(value):
                    continue
                if isinstance(value, str):
                    value.encode('utf-8')
                    continue
                raise ValueError('invalid coverage scalar')
        validate_scalars(row['kind'] for row in kind_rows)
        # JSON object names are strings: combine SQL groups that encode to the
        # same name, rather than emitting duplicate keys that lose counts.
        kinds = {}
        for row in kind_rows:
            value = row['kind']
            key = value if isinstance(value, str) else json.dumps(value, allow_nan=False)
            kinds[key] = kinds.get(key, 0) + row['n']
        for item in unassessed:
            validate_scalars(item.values())
        counts = {}
        items = []
        for row in rows:
            item = dict(row)
            item['surface_id'] = item.pop('id')
            item['class_category'] = annotate_finding({'class_name': item['class_name']})['class_category']
            axes_json, evidence_json = item.pop('axes_json'), item.pop('evidence_json')
            validate_scalars(item.values())
            if not isinstance(axes_json, (str, bytes, bytearray)) or not isinstance(evidence_json, (str, bytes, bytearray)):
                raise ValueError('invalid assessment JSON')
            item['axes'] = json.loads(axes_json)
            item['evidence_refs'] = json.loads(evidence_json)
            status = {'untested': 'no_assessment', 'exhausted': 'bounded_review'}.get(item['status'], item['status'])
            baseline = item['fingerprint'] or (f"@mapper-run:{item['run_id']}" if item['run_id'] else None)
            item['freshness'] = ('not_applicable' if status == 'no_assessment' else
                                 'unknown' if not baseline or not item['assessed_fingerprint'] else
                                 'current' if item['assessed_fingerprint'] == baseline else 'stale')
            if item['freshness'] == 'stale':
                item['prior_status'] = status
                status = 'stale'
            item['status'] = status
            counts[status] = counts.get(status, 0) + 1
            items.append(item)
        result = {'counts': counts, 'items': items, 'total': len(items),
                  'mapped_kinds': kinds, 'unclassified_surfaces': unclassified,
                  'unassessed_surfaces': unassessed}
        # Decoded assessment JSON can contain non-finite numbers or invalid
        # Unicode escapes; enforce the actual response encoding at this boundary.
        json.dumps({'programs': [{'lanes': [{'coverage': result}]}]},
                   ensure_ascii=False, allow_nan=False).encode('utf-8')
        return result
    except FileNotFoundError:
        warnings.append('coverage_missing')
    except (OSError, ValueError, UnicodeError, RecursionError, sqlite3.Error):
        warnings.append('coverage_unavailable_or_invalid')
    return None


def reports(lane, warnings, findings=None, report_autosave=False):
    import os
    from report_publisher import generated_navigation
    from report_evidence import is_evidence, recorded_paths, reports_relative
    from report_packets import counts_for_time, packet_folder, plan
    base = lane / 'reports'
    if not base.exists():
        warnings.append('reports_missing')
        return None
    if base.is_symlink() or not base.is_dir():
        warnings.append('reports_unavailable_or_invalid')
        return None
    items = []
    ownership = {}
    for finding in findings or []:
        fid = finding.get('fid') if isinstance(finding, dict) else None
        relative = reports_relative(finding.get('report_path'), lane) if fid else None
        if relative:
            ownership.setdefault(relative, []).append(fid)
    # Evidence files are artifacts of their finding, not reports: skipped
    # before their content is read (report_evidence.is_evidence).
    report_paths, evidence_paths = recorded_paths(findings, lane)
    def onerror(_error):
        warnings.append('reports_unavailable_or_invalid')
    def mtime_of(file):
        try:
            return file.lstat().st_mtime
        except OSError:
            return None
    found, evidence, other = [], [], []
    for directory, dirs, files in os.walk(base, followlinks=False, onerror=onerror):
        dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            file = Path(directory) / name
            if file.is_symlink():
                continue
            rel = file.relative_to(base).as_posix()
            if file.suffix.lower() == '.md':
                if not file.is_file():
                    continue  # regular files only, like the search index (_walk S_ISREG)
                if is_evidence(rel, report_paths, evidence_paths):
                    evidence.append((rel, mtime_of(file)))
                else:
                    found.append((rel, name, file, mtime_of(file)))
            elif packet_folder(rel) and counts_for_time(rel) and file.is_file():
                # Only for the packet time (report_packets): never read.
                other.append((rel, mtime_of(file)))
    # One main report per finding packet (report_packets.plan); the packet's
    # other Markdown files stay listed as kind packet_file, unread.
    def navigation_page(rel):
        try:
            return generated_navigation(rel, read_file(lane, 'reports/' + rel).decode('utf-8'))
        except (OSError, ValueError, UnicodeError):
            return False
    packets = plan([(rel, modified) for rel, _, _, modified in found], findings, lane, other, evidence,
                   is_navigation=navigation_page)
    for rel, name, file, modified in found:
        owned = ownership.get(rel, [])
        packet_file = packets.files.get(rel)
        if packet_file is not None:
            items.append({'path': rel, 'name': name, 'kind': 'packet_file', 'owner_fids': owned,
                          'modified': modified, 'packet': packet_file['packet'], 'packet_main': packet_file['main'],
                          'packet_group': packet_file['group'], 'editable': bool(report_autosave),
                          'collaboration_editable': True})
            continue
        try:
            text = read_file(lane, 'reports/' + rel).decode('utf-8')
        except (OSError, ValueError, UnicodeError):
            text = None
            if 'report_content_unavailable_or_invalid' not in warnings:
                warnings.append('report_content_unavailable_or_invalid')
        navigation = text is not None and generated_navigation(rel, text)
        main = packets.mains.get(rel)
        fids = owned
        if main is not None and not navigation:
            # The packet's main report: owned by every finding whose
            # report_path lies in the packet; its time is the packet's.
            fids = list(dict.fromkeys([*fids, *main['owner_fids']]))
        if navigation:
            kind, fids = 'generated_navigation', []
        elif fids:
            kind = 'registered_report'
        elif text is None:
            kind, fids = 'unknown', []
        elif '<!-- generated: bounty-core-finding-report -->' in text:
            kind, fids = 'generated_report', []
        else:
            kind, fids = ('unregistered' if findings is not None else 'unknown'), []
        item = {'path': rel, 'name': name, 'kind': kind, 'owner_fids': fids, 'modified': modified,
                'editable': bool(report_autosave and text is not None and not navigation),
                'collaboration_editable': bool(text is not None and not navigation)}
        if main is not None and not navigation:
            item.update({'packet': main['packet'], 'packet_main': rel, 'modified': main['modified'],
                         'file_modified': modified, 'updated_file': main['updated_file'],
                         'packet_evidence': main['evidence']})
        items.append(item)
    return items


def discover(root, report_autosave=False, *, include_reports=True, inventory_only=False):
    if not root.is_dir():
        return {'programs': [], 'warnings': ['root_unavailable']}
    programs = []
    global_warnings = []
    for family, lanes in FAMILIES.items():
        base = root / family
        if not base.is_dir() or base.is_symlink():
            continue
        try:
            family_programs = sorted(base.iterdir())
        except OSError:
            global_warnings.append('discovery_incomplete')
            continue
        for program in family_programs:
            if program.name.startswith('_') or program.is_symlink() or not program.is_dir():
                continue
            found = []
            try:
                program_lanes = sorted(program.iterdir())
            except OSError:
                global_warnings.append('discovery_incomplete')
                continue
            for lane in program_lanes:
                if lane.name in lanes and lane.is_dir() and not lane.is_symlink():
                    warnings = []
                    findings = None if inventory_only else ledger(lane, warnings)
                    entries = None if inventory_only else map_entries(lane, warnings)
                    found.append({'name': lane.name, 'findings': findings, 'map': entries,
                                  'coverage': None if inventory_only else coverage(lane, warnings), 'reports': reports(lane, warnings, findings, report_autosave) if include_reports and not inventory_only else None,
                                  'gadgets': [e for e in entries if 'gadget' in (e['tags'] or [])] if entries is not None else None,
                                  'warnings': warnings, **({'unscanned': True} if inventory_only else {})})
            if found:
                programs.append({'id': family + '/' + program.name, 'name': program.name,
                                 'family': family, 'lanes': found})
    return {'programs': programs, 'warnings': global_warnings}


def writer_available(writer):
    import subprocess
    if not writer:
        return False
    try:
        result = subprocess.run([str(writer), 'agents/manual_hunter.py', '--help'],
                                capture_output=True, text=True, timeout=15)
        return result.returncode == 0 and all(option in result.stdout for option in
            ('--edit-finding', '--patch-file', '--root', '--family', '--lane'))
    except (OSError, subprocess.SubprocessError):
        return False


def writer_features(writer):
    """Ledger actions the BBH writer advertises in its --help output."""
    import re
    import subprocess
    if not writer:
        return frozenset()
    try:
        result = subprocess.run([str(writer), 'agents/manual_hunter.py', '--help'],
                                capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    if result.returncode != 0:
        return frozenset()
    required = {'submission': ('--set-submission', '--submission-state', '--submission-result', '--submission-report'),
                'add_finding': ('--from-file',),
                # Permanent delete of an archived finding (BBH refuses any other status).
                'delete': ('--delete-finding',),
                'actor': ('--actor',)}
    features = {name for name, options in required.items() if all(o in result.stdout for o in options)}
    try:
        # Probe with --help as the second argument, like every other probe, so
        # wrappers that log writes can tell probes apart. Subcommand flags are
        # a compatibility assumption; a failing write disables the writer.
        store = subprocess.run([str(writer), 'agents/map_store.py', '--help'],
                               capture_output=True, text=True, timeout=15)
        commands = re.search(r'\{([a-z,-]+)\}', store.stdout or '')
        if store.returncode == 0 and commands and 'write' in commands.group(1).split(','):
            features.add('reclassify')
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        # Recon URL marks (recon_intel.py): BBH url_ingest.py mark.
        ingest = subprocess.run([str(writer), 'agents/url_ingest.py', '--help'], capture_output=True, text=True, timeout=15)
        # argparse prints several {choice,...} groups (options too); look for the command group.
        commands = [group.split(',') for group in re.findall(r'\{([a-z,-]+)\}', ingest.stdout or '')]
        if (ingest.returncode == 0 and any('mark' in group for group in commands) and
                all(o in ingest.stdout for o in ('--url', '--lane', '--status', '--param', '--param-location', '--notes', '--agent-id'))):
            features.add('url_mark')
    except (OSError, subprocess.SubprocessError):
        pass
    return frozenset(features)


def ledger_action_capabilities(server):
    """Advertise ledger actions; unsupported actions stay visibly disabled."""
    enabled = bool(server.writer_enabled)
    features = server.writer_features if enabled else frozenset()
    return {
        'submission': {'enabled': 'submission' in features, 'states': list(SUBMISSION_STATES),
                       'results': list(SUBMISSION_RESULTS), 'local_only': True},
        'add_finding': {'enabled': 'add_finding' in features},
        'delete': {'enabled': 'delete' in features, 'requires_status': 'archive'},
        'reclassify': {store: ({'enabled': True} if 'reclassify' in features else {'enabled': False, 'reason': RECLASSIFY_UNSUPPORTED})
                       for store in ('gadgets', 'map')},
        # BBH url_ingest.py mark writes <program>/web only (see recon_mark).
        'url_mark': {'enabled': 'url_mark' in features, 'statuses': list(MARK_STATUSES), 'lanes': list(BBH_LANES),
                     'locations': list(MARK_LOCATIONS), 'board_lane': 'web'},
    }


class ArchiveState:
    """Previous status of findings the Board archived, so Restore works from any device.

    Lives in the Board's private state directory (never under the data root).
    One small JSON file, bounded to MAX entries (oldest dropped), replaced
    atomically; callers hold the metadata write lock."""
    MAX = 5000
    NAME = 'archive-state.json'

    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / self.NAME

    @staticmethod
    def key(family, program, lane, fid):
        return f'{family}/{program}/{lane}/{fid}'

    def read(self, for_update=False):
        """Stored entries. A missing file is empty.

        For display (``for_update=False``) any read problem shows as empty. For
        an update an unreadable file raises, so a transient error can never
        overwrite every stored status, and a corrupt file is moved aside
        (``archive-state.json.corrupt-<time>``) before it is replaced."""
        import re
        try:
            raw = json.loads(self.path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {}
        except (ValueError, UnicodeError):
            if for_update:
                self._set_aside()
            return {}
        except OSError:
            if for_update:
                raise
            return {}
        if not isinstance(raw, dict):
            if for_update:
                self._set_aside()
            return {}
        out = {}
        for key, value in raw.items():
            if (isinstance(value, dict) and isinstance(value.get('previous_status'), str) and
                    re.fullmatch(STATUS_TOKEN, value['previous_status']) and isinstance(value.get('archived_at'), str) and
                    key == self.key(value.get('family'), value.get('program'), value.get('lane'), value.get('fid'))):
                out[key] = value
        return out

    def _set_aside(self):
        import time
        self.path.replace(self.path.with_name(f'{self.NAME}.corrupt-{time.strftime("%Y%m%dT%H%M%S")}-{time.time_ns() % 1000000}'))

    def lane(self, family, program, lane):
        prefix = self.key(family, program, lane, '')
        return {v['fid']: {'previous_status': v['previous_status'], 'archived_at': v['archived_at']}
                for k, v in self.read().items() if k.startswith(prefix)}

    def write(self, data):
        import os
        import tempfile
        if len(data) > self.MAX:
            data = dict(sorted(data.items(), key=lambda item: item[1]['archived_at'])[-self.MAX:])
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temp = tempfile.mkstemp(prefix='.archive-state-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(data, handle, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, self.path)
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise

    def record(self, family, program, lane, fid, previous_status):
        from datetime import datetime, timezone
        data = self.read(for_update=True)
        data[self.key(family, program, lane, fid)] = {
            'family': family, 'program': program, 'lane': lane, 'fid': fid, 'previous_status': previous_status,
            'archived_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
        self.write(data)

    def forget(self, family, program, lane, fid):
        data = self.read(for_update=True)
        if data.pop(self.key(family, program, lane, fid), None) is not None:
            self.write(data)


class ReportNaState:
    """Board-only "not applicable" marks on report files (noise), keyed by path.

    Lives in the Board's private state directory (never under the data root)
    and never touches the ledger or report files. One small JSON file, bounded
    to MAX entries (oldest marked_at dropped), replaced atomically under its
    own lock, so it works while the BBH writer is off. A moved or renamed
    report simply has no mark; stale keys are harmless."""
    MAX = 10000
    MAX_PATH = 1024
    NAME = 'report-na.json'

    def __init__(self, directory):
        import threading
        self.directory = Path(directory)
        self.path = self.directory / self.NAME
        self.lock = threading.Lock()

    @staticmethod
    def key(family, program, lane, path):
        return f'{family}/{program}/{lane}/{path}'

    def read(self, for_update=False):
        """Stored marks. A missing file is empty.

        For display (``for_update=False``) any read problem returns None
        (unavailable). For an update an unreadable file raises, so a transient
        error never overwrites stored marks, and a corrupt file is moved aside
        (``report-na.json.corrupt-<time>``) before it is replaced."""
        try:
            raw = json.loads(self.path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {}
        except (ValueError, UnicodeError):
            if for_update:
                self._set_aside()
                return {}
            return None
        except OSError:
            if for_update:
                raise
            return None
        if not isinstance(raw, dict):
            if for_update:
                self._set_aside()
                return {}
            return None
        out = {}
        for key, value in raw.items():
            if (isinstance(value, dict) and all(isinstance(value.get(k), str) for k in ('family', 'program', 'lane', 'path', 'marked_at')) and
                    key == self.key(value['family'], value['program'], value['lane'], value['path'])):
                out[key] = value
        return out

    def _set_aside(self):
        import time
        self.path.replace(self.path.with_name(f'{self.NAME}.corrupt-{time.strftime("%Y%m%dT%H%M%S")}-{time.time_ns() % 1000000}'))

    def keys(self):
        """Marked keys for display, or None when the store cannot be read."""
        data = self.read()
        return None if data is None else set(data)

    def write(self, data):
        import os
        import tempfile
        if len(data) > self.MAX:
            data = dict(sorted(data.items(), key=lambda item: item[1]['marked_at'])[-self.MAX:])
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        # mkstemp creates the file with mode 0600.
        fd, temp = tempfile.mkstemp(prefix='.report-na-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(data, handle, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, self.path)
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise

    def set(self, family, program, lane, path, na):
        """Mark (na=True) or unmark a report; returns marked_at or None."""
        from datetime import datetime, timezone
        if not isinstance(path, str) or not 0 < len(path) <= self.MAX_PATH:
            raise ValueError('invalid report path')
        key = self.key(family, program, lane, path)
        with self.lock:
            data = self.read(for_update=True)
            if not na:
                if data.pop(key, None) is not None:
                    self.write(data)
                return None
            marked_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
            data[key] = {'family': family, 'program': program, 'lane': lane, 'path': path, 'marked_at': marked_at}
            self.write(data)
            return marked_at


    MAX_PRUNE = 200

    def prune(self, listings, missing):
        """Drop marks for reports that no longer exist; returns how many were dropped.

        `listings` is [(family, program, lane, paths)] from complete lane report
        walks; a mark in one of those lanes whose path is not listed is a
        candidate, and `missing(family, program, lane, path)` must confirm the
        file is gone (it returns False on any doubt, e.g. a permission error).
        Bounded to MAX_PRUNE candidates per call. Never runs on a read error: a
        store that cannot be read for display is left alone, and the update
        follows the normal write rules (atomic replace under the lock)."""
        current = self.read()
        if not current or not listings:
            return 0
        by_lane = {}
        for key, value in current.items():
            by_lane.setdefault((value['family'], value['program'], value['lane']), []).append((key, value['path']))
        stale = []
        for family, program, lane, paths in listings:
            for key, path in by_lane.get((family, program, lane), ()):
                if path not in paths:
                    stale.append((key, family, program, lane, path))
            if len(stale) >= self.MAX_PRUNE:
                break
        stale = stale[:self.MAX_PRUNE]
        gone = {key for key, family, program, lane, path in stale if missing(family, program, lane, path)}
        if not gone:
            return 0
        with self.lock:
            try:
                data = self.read(for_update=True)
                dropped = [key for key in gone if data.pop(key, None) is not None]
                if dropped:
                    self.write(data)
                return len(dropped)
            except OSError:
                return 0


def report_na_listings(entries):
    """(family, program, lane, paths) for lanes whose report walk completed."""
    return [(family, program, lane, {r['path'] for r in items}) for family, program, lane, items, warnings in entries
            if isinstance(items, list) and 'reports_unavailable_or_invalid' not in (warnings or [])]


def report_na_flags(store):
    """One read of the N/A marks for a response: (keys or None, available)."""
    keys = store.keys() if store is not None else None
    return keys, keys is not None


def valid_tailnet_host(host):
    import re
    label = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    return (isinstance(host, str) and len(host) <= 253 and
            re.fullmatch(fr'{label}\.{label}\.ts\.net', host) is not None)


def valid_terminal_url(value):
    import re
    return isinstance(value, str) and re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)+', value) is not None


def make_server(root, port=9001, writer=None, accept_uncoordinated_writes=False, tailnet_host=None,
                tailnet_port=443, collaboration_dir=None, experimental_fixture_publish=False, collaboration_max_bytes=None,
                report_autosave=False, retention_max_operations=None, retention_min_free_bytes=None,
                live_edit_dir=None, state_dir=None, terminal_url=None, artifact_root=None, recon_query_budget=None,
                artifact_uploads=False, user_config=None):
    import os
    import tempfile
    import threading
    from collaborative_engine import CollaborationStore, GitUnavailableError
    if state_dir is not None and (Path(state_dir).absolute().is_relative_to(Path(root).absolute()) or
                                  Path(state_dir).resolve().is_relative_to(Path(root).resolve())):
        raise ValueError('the Board state directory must be outside the data root')
    if live_edit_dir is not None and (collaboration_dir is not None or report_autosave or experimental_fixture_publish):
        raise ValueError('live editing replaces the shared-draft store, report autosave and fixture publication')
    if retention_max_operations is not None and (type(retention_max_operations) is not int or retention_max_operations < 1):
        raise ValueError('invalid retention operation limit')
    if retention_min_free_bytes is not None and (type(retention_min_free_bytes) is not int or retention_min_free_bytes < 0):
        raise ValueError('invalid retention free-space floor')
    if report_autosave and (collaboration_dir is None or experimental_fixture_publish):
        raise ValueError('report autosave requires a collaboration store and excludes fixture publication')
    if tailnet_host is not None and not valid_tailnet_host(tailnet_host):
        raise ValueError('invalid canonical tailnet hostname')
    if terminal_url is not None and not valid_terminal_url(terminal_url):
        raise ValueError('terminal URL must be a same-origin path such as /terminal/')
    if type(tailnet_port) is not int or not 1 <= tailnet_port <= 65535:
        raise ValueError('invalid tailnet HTTPS port')
    if tailnet_host is None:
        tailnet_authorities, tailnet_origin = frozenset(), None
    elif tailnet_port == 443:
        tailnet_authorities, tailnet_origin = frozenset({tailnet_host, f'{tailnet_host}:443'}), f'https://{tailnet_host}'
    else:
        tailnet_authorities = frozenset({f'{tailnet_host}:{tailnet_port}'})
        tailnet_origin = f'https://{tailnet_host}:{tailnet_port}'
    root = Path(root).absolute()
    from user_preferences import UserPreferences, validate as validate_user_preferences, MAX_BYTES as USER_PREFERENCES_MAX_BYTES
    user_preferences = UserPreferences(user_config if user_config is not None else Path.home() / '.config/bountyboard/user.conf', root)

    def root_snapshot():
        import hashlib
        try:
            canonical = root.resolve(strict=True)
            stat = canonical.stat()
            if not canonical.is_dir():
                return None
            identity = hashlib.sha256(os.fsencode(str(canonical))).hexdigest()
            instance = hashlib.sha256(os.fsencode(f'{canonical}\0{stat.st_dev}\0{stat.st_ino}')).hexdigest()
            return canonical, identity, instance
        except (OSError, RuntimeError):
            return None

    if experimental_fixture_publish:
        if collaboration_dir is None or not os.environ.get('TMPDIR'):
            raise ValueError('fixture publication requires collaboration storage and explicit TMPDIR')
        if root.is_symlink() or not root.resolve(strict=True).is_relative_to(Path(tempfile.gettempdir()).resolve(strict=True)):
            raise ValueError('fixture root must be inside TMPDIR')
    collaboration = (CollaborationStore(collaboration_dir, **({} if collaboration_max_bytes is None else
                                                               {'max_store_bytes': collaboration_max_bytes}))
                     if collaboration_dir else None)
    if collaboration:
        with collaboration.observation():
            collaboration.bind_source(root)
    live = None
    live_root = root_snapshot() if live_edit_dir is not None else None
    if live_edit_dir is not None:
        from live_editing import LiveReports
        from report_publisher import generated_navigation
        if live_root is None:
            raise ValueError('data root is unavailable')
        live = LiveReports(live_root[0], live_edit_dir, editable=lambda relative, text: not generated_navigation(relative, text))
    from search_index import SearchIndex
    from report_publisher import generated_navigation as _generated_navigation
    search_index = SearchIndex(root_snapshot, FAMILIES, read_file, ledger, _generated_navigation)
    search_slots = threading.BoundedSemaphore(4)
    # Recon intel (recon_intel.py): read-only URL index / JS library summaries, computed in the background.
    # Scope check (scope_check.py): BBH classify through the --bbh launcher, read-only, on the recon worker.
    from recon_intel import ReconIntel, QUERY_BUDGET
    from scope_check import ScopeChecker
    recon_root = lambda: (root_snapshot() or (None,))[0]
    recon = ReconIntel(recon_root, lambda r: discover(r, inventory_only=True),
                       read_file, ledger, coverage, map_entries, artifact_root=artifact_root,
                       query_budget=recon_query_budget or QUERY_BUDGET, scope=ScopeChecker(recon_root, writer))
    # Scope panel (scope_inventory.py): read-only scope inventory, pull state and change log per program.
    from scope_inventory import ScopeInventory
    scope_inventory = ScopeInventory(recon_root, FAMILIES['binaries'])
    collaboration_lock = threading.RLock()
    portfolio_scan = threading.BoundedSemaphore(1)
    lane_reads = threading.BoundedSemaphore(8)
    # Serialize this server's own metadata requests through precheck and writer.
    # Other processes and sync peers do not participate in this lock.
    metadata_write_lock = threading.Lock()
    # Progress is per server: an incomplete sweep never permits a new exchange.
    retained_cursors = {}
    # A completed multi-request sweep can authorize one following write,
    # provided no publication operation was added under the shared lock.
    retained_ready = {}
    retained_scan_limit = 64

    def reconcile_retained(key):
        import hashlib
        import uuid
        from report_publisher import retained_snapshot
        assert collaboration is not None
        cursor, uncertain = retained_cursors.get(key, (0, False))
        retained_ready.pop(key, None)
        rows = collaboration.publication_page(key, cursor, retained_scan_limit + 1)
        for _, operation, state in rows[:retained_scan_limit]:
            uncertain |= state in ('pending', 'outcome_uncertain')
            try:
                snapshot = retained_snapshot(collaboration.root, operation)
            except FileNotFoundError:
                # A failed or interrupted attempt may never have made a receipt.
                if state in ('pending', 'outcome_uncertain', 'conflict') or state.startswith('capacity:'):
                    continue
                raise
            if snapshot is None:
                continue
            base, text = snapshot
            revision = hashlib.sha256(text.encode('utf-8')).hexdigest()
            latest = collaboration.retained_latest(key, operation)
            if revision != (latest if latest is not None else base):
                collaboration.observe_retained(key, operation, base, text, uuid.uuid4().hex)
        incomplete = len(rows) > retained_scan_limit
        if incomplete:
            retained_cursors[key] = (rows[retained_scan_limit - 1][0], uncertain)
        else:
            retained_cursors.pop(key, None)
            if cursor and not uncertain:
                retained_ready[key] = rows[-1][0] if rows else cursor
        state = 'backlog' if incomplete else ('uncertain' if uncertain else 'complete')
        return {'state': state, 'scanned': min(len(rows), retained_scan_limit)}

    class Handler(BaseHTTPRequestHandler):
        def trusted_request(self, require_origin=False, navigation=False):
            port = self.server.server_port
            hosts = self.headers.get_all('Host', [])
            origins = self.headers.get_all('Origin', [])
            sites = self.headers.get_all('Sec-Fetch-Site', [])
            if len(hosts) != 1 or len(origins) > 1 or len(sites) > 1:
                return False
            host = hosts[0]
            if host in {f'127.0.0.1:{port}', f'localhost:{port}'}:
                expected = f'http://{host}'
            elif host in tailnet_authorities:
                expected = tailnet_origin
            else:
                return False
            if (require_origin and not origins) or (origins and origins[0] != expected):
                return False
            if navigation and not require_origin and sites:
                # Following a link from another site (chat, notes) opens the app
                # shell. Only a top-level page load qualifies: frames and
                # scripted requests from other sites stay refused.
                modes = self.headers.get_all('Sec-Fetch-Mode', [])
                dests = self.headers.get_all('Sec-Fetch-Dest', [])
                if modes == ['navigate'] and dests == ['document']:
                    return sites[0] in ('same-origin', 'none', 'same-site', 'cross-site')
            return not sites or sites[0] in (('same-origin',) if require_origin else ('same-origin', 'none'))

        def reply(self, status, payload, extra=None):
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def collaboration_identity(self, extra=()):
            import hashlib
            params = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=8)
            required = {'family', 'program', 'lane', 'path', 'root_identity'}
            if not required <= set(params) or set(params) - required - set(extra) or any(len(v) != 1 for v in params.values()):
                raise ValueError('invalid identity')
            root_id = hashlib.sha256(os.fsencode(str(root.resolve(strict=True)))).hexdigest()
            if params['root_identity'][0] != root_id:
                raise ValueError('root changed')
            family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
            if (family not in FAMILIES or lane not in FAMILIES[family] or
                    not program or program.startswith('_') or program in ('.', '..') or '/' in program or '\0' in program or
                    path.startswith('/') or Path(path).suffix.lower() != '.md' or
                    any(p in ('', '.', '..') for p in path.split('/'))):
                raise ValueError('invalid identity')
            relative = f'{family}/{program}/{lane}/reports/{path}'
            return json.dumps([str(root.resolve()), relative], ensure_ascii=False), relative

        def collaboration_admitted(self, **kwargs):
            if not self.server.collaboration_slots.acquire(blocking=False):
                return self.reply(503, {'error': 'collaboration_busy', 'message': 'Retain your local draft and retry.'}, {'Retry-After': '2'})
            timeout = self.connection.gettimeout()
            try:
                self.connection.settimeout(15)
                return self.collaboration_request(**kwargs)
            finally:
                try:
                    self.connection.settimeout(timeout)
                finally:
                    self.server.collaboration_slots.release()

        def collaboration_request(self, write=False, view='current'):
            import sqlite3
            import subprocess
            if collaboration is None:
                return self.reply(503, {'error': 'collaboration_disabled'})
            try:
                extra = {'history': ('before',), 'version': ('revision',), 'recovery': ('request_id',)}.get(view, ())
                key, relative = self.collaboration_identity(extra)
                params = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=8)
                before = None
                if view == 'history' and 'before' in params:
                    raw = params['before'][0]
                    if not raw.isascii() or not raw.isdecimal() or len(raw) > 19:
                        raise ValueError('invalid cursor')
                    before = int(raw)
                if view == 'version' and 'revision' not in params:
                    raise ValueError('missing revision')
                if view == 'recovery' and 'request_id' in params:
                    request_id = params['request_id'][0]
                    if not report_autosave or not request_id or len(request_id) > 200:
                        raise ValueError('invalid recovery request')
                payload = {}
                if write:
                    if (not self.trusted_request(require_origin=True) or
                            self.headers.get_all('X-Requested-With', []) != ['Bounty-Board'] or
                            [x.lower() for x in self.headers.get_all('Content-Type', [])] != ['application/json'] or
                            self.headers.get('Transfer-Encoding')):
                        return self.reply(403, {'error': 'untrusted_origin'})
                    lengths = self.headers.get_all('Content-Length', [])
                    if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= 30_050_000:
                        raise ValueError('invalid length')
                    payload = json.loads(self.rfile.read(int(lengths[0])))
                    if not isinstance(payload, dict) or set(payload) not in ({'base', 'content', 'request_id'}, {'base', 'content', 'request_id', 'conflict_id'}, {'action', 'revision'}, {'action', 'base', 'content', 'source_snapshot', 'request_id'}):
                        raise ValueError('invalid payload')
                    if 'action' in payload:
                        if payload['action'] == 'publish':
                            if set(payload) != {'action', 'revision'} or not isinstance(payload['revision'], str):
                                raise ValueError('invalid action')
                        elif payload['action'] == 'reconcile':
                            if set(payload) != {'action', 'base', 'content', 'source_snapshot', 'request_id'} or not all(isinstance(payload[k], str) for k in ('base', 'content', 'source_snapshot', 'request_id')) or not payload['base'] or not payload['request_id']:
                                raise ValueError('invalid action')
                        else:
                            raise ValueError('invalid action')
                    elif not all(isinstance(payload[k], str) and payload[k] for k in ('base', 'request_id')):
                        raise ValueError('invalid payload')
                with collaboration_lock, collaboration.observation():
                    collaboration.bind_source(root)
                    from report_publisher import generated_navigation
                    reconciliation = None
                    scan_source = None
                    if report_autosave:
                        # Observe the visible source first so retained merges use its
                        # current store baseline; never publish during this sweep.
                        try:
                            scan_source = read_file(root, relative).decode('utf-8')
                        except FileNotFoundError:
                            scan_source = None
                        if write and scan_source is not None and generated_navigation(relative, scan_source):
                            return self.reply(403, {'error': 'generated_navigation_not_editable',
                                                    'message': 'This generated navigation file is read-only; edit the underlying report instead.'})
                        if scan_source is not None:
                            collaboration.observe_source(key, scan_source)
                        try:
                            ready = retained_ready.pop(key, None) if write else None
                            if ready is not None and not collaboration.publication_page(key, ready, 1):
                                reconciliation = {'state': 'complete', 'scanned': 0}
                            else:
                                reconciliation = reconcile_retained(key)
                        except (OSError, UnicodeError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError):
                            return self.reply(503, {'error': 'retained_reconciliation_unavailable',
                                                    'message': 'Retain your local draft and retry; retained history could not be checked.'})
                        if write and reconciliation['state'] == 'backlog':
                            return self.reply(503, {'error': 'retained_scan_backlog',
                                                    'reconciliation': reconciliation,
                                                    'message': 'Retain your local draft and retry after reconciliation.'})
                    if view == 'recovery' and 'request_id' in params:
                        assert reconciliation is not None
                        from report_publisher import inspect, operation_id
                        current = collaboration.current(key)
                        request_receipt = collaboration.request_result(key, params['request_id'][0])
                        if current is None or request_receipt is None:
                            return self.reply(404, {'error': 'not_observed'})
                        current['store_receipt'] = request_receipt
                        operation = operation_id(key, params['request_id'][0])
                        state = collaboration.publication_state(key, operation)
                        current['publication'] = inspect(root, relative, collaboration.root / 'publication' / operation)
                        if state and state.startswith('capacity:'):
                            import hashlib
                            if reconciliation['state'] != 'complete' or scan_source is None:
                                current['publication'] = {'state': 'outcome_uncertain', 'operation': operation,
                                                          'reasons': ['capacity_preconditions_unavailable']}
                            elif (hashlib.sha256(scan_source.encode('utf-8')).hexdigest() != state[9:] or
                                  current['revision'] != request_receipt['revision'] or
                                  request_receipt['status'] == 'conflict' or collaboration.unresolved_count(key)):
                                current['publication'] = {'state': 'conflict', 'operation': operation,
                                                          'reasons': ['capacity_retry_changed']}
                            else:
                                current['publication'] = {'state': 'capacity', 'operation': operation, 'reasons': ['retention_capacity']}
                        elif state is None:
                            current['publication']['state'] = ('outcome_uncertain' if reconciliation['state'] != 'complete' else 'conflict')
                            current['publication']['reasons'].append('not_published')
                        elif state in ('pending', 'outcome_uncertain'):
                            current['publication']['state'] = 'outcome_uncertain'
                            current['publication']['reasons'].append('incomplete_attempt')
                        elif state == 'conflict' and current['publication']['state'] == 'published':
                            current['publication']['state'] = 'conflict'
                        if current['publication']['state'] == 'published':
                            if reconciliation['state'] != 'complete':
                                current['publication']['state'] = 'outcome_uncertain'
                                current['publication']['reasons'].append('retained_' + reconciliation['state'])
                            elif collaboration.unresolved_count(key) or current['content'] != scan_source:
                                current['publication']['state'] = 'conflict'
                                current['publication']['reasons'].append('store_needs_reconciliation')
                        current['reconciliation'] = reconciliation
                        current['store_saved'] = True
                        return self.reply(200, current)
                    try:
                        content = read_file(root, relative).decode('utf-8')
                    except FileNotFoundError:
                        # Recover only an existing observed identity; do not create work.
                        current = collaboration.current(key)
                        if current is None:
                            return self.reply(404, {'error': 'source_unavailable'})
                        if write:
                            if payload.get('action') != 'publish':
                                receipt = collaboration.receipt(key, payload['base'], payload['content'],
                                                                payload['request_id'], payload.get('conflict_id'), payload.get('source_snapshot'))
                                if receipt is not None:
                                    if report_autosave:
                                        from report_publisher import operation_id
                                        receipt['store_saved'] = True
                                        receipt['publication'] = {'state': 'outcome_uncertain',
                                                                  'operation': operation_id(key, payload['request_id']),
                                                                  'reasons': ['source_unavailable']}
                                        receipt['reconciliation'] = reconciliation
                                    return self.reply(200, receipt)
                            return self.reply(409, {'error': 'source_unavailable', 'message': 'Retain your local draft; restore the source before saving.'})
                        if view == 'history':
                            result = collaboration.history_page(key, before)
                        elif view == 'version':
                            result = collaboration.version(key, params['revision'][0])
                        else:
                            result = current
                            page = collaboration.history_page(key)
                            result['history'] = page['history']
                            result['unresolved_count'] = page['unresolved_count']
                        result['source_status'] = 'source_unavailable'
                        if reconciliation is not None:
                            result['reconciliation'] = reconciliation
                        return self.reply(200, result)
                    if write and generated_navigation(relative, content):
                        return self.reply(403, {'error': 'generated_navigation_not_editable',
                                                'message': 'This generated navigation file is read-only; edit the underlying report instead.'})
                    if view == 'current':
                        collaboration.observe_source(key, content)
                    if view == 'history':
                        result = collaboration.history_page(key, before)
                    elif view == 'version':
                        result = collaboration.version(key, params['revision'][0])
                    elif view == 'recovery':
                        result = collaboration.current(key)
                        if result is None:
                            return self.reply(404, {'error': 'not_observed'})
                        result['source_status'] = 'available'
                    elif write and payload.get('action') == 'publish':
                        if not experimental_fixture_publish:
                            return self.reply(403, {'error': 'publication_disabled'})
                        current = collaboration.current(key)
                        if current is None:
                            raise ValueError('missing document')
                        if current['revision'] != payload['revision'] or collaboration.unresolved_count(key):
                            return self.reply(409, {'error': 'head_changed_or_conflict'})
                        latest = read_file(root, relative).decode('utf-8')
                        if latest != content:
                            collaboration.observe_source(key, latest)
                            return self.reply(409, {'error': 'source_changed'})
                        # This is deliberately only a fixture publisher. External writers do
                        # not take this lock; check-then-replace is not a filesystem CAS.
                        self.publish_fixture(relative, current['content'])
                        observed = read_file(root, relative).decode('utf-8')
                        collaboration.observe_source(key, observed)
                        if observed != current['content']:
                            return self.reply(409, {'error': 'publication_changed'})
                        result = {'status': 'published', 'revision': current['revision']}
                    elif write:
                        explicit_reconcile = payload.get('action') == 'reconcile'
                        if explicit_reconcile and not report_autosave:
                            return self.reply(403, {'error': 'publication_disabled'})
                        before_submit = collaboration.current(key)
                        needs_reconciliation = (report_autosave and before_submit is not None and
                                                (before_submit['content'] != content or payload.get('conflict_id') is not None))
                        previous_receipt = (collaboration.receipt(key, payload['base'], payload['content'],
                                                                  payload['request_id'], payload.get('conflict_id'), payload.get('source_snapshot'))
                                            if report_autosave else None)
                        if explicit_reconcile and previous_receipt is None:
                            assert reconciliation is not None
                            if (reconciliation['state'] != 'complete' or before_submit is None or
                                    before_submit['revision'] != payload['base'] or before_submit['content'] != payload['content'] or
                                    payload['source_snapshot'] != content or content != scan_source or collaboration.unresolved_count(key)):
                                return self.reply(409, {'error': 'reconciliation_changed', 'message': 'Review the current shared draft and Markdown before trying again.'})
                            needs_reconciliation = False
                        result = collaboration.submit(key, payload['base'], payload['content'], payload['request_id'], payload.get('conflict_id'), payload.get('source_snapshot'))
                        if report_autosave:
                            assert reconciliation is not None
                            from report_publisher import inspect, operation_id, publish, retained_snapshot
                            result['store_saved'] = True
                            operation = operation_id(key, payload['request_id'])
                            prior = collaboration.publication_state(key, operation)
                            capacity_retry = bool(prior and prior.startswith('capacity:'))
                            if capacity_retry:
                                import hashlib
                                capacity_retry = (previous_receipt is not None and reconciliation['state'] == 'complete' and
                                                  hashlib.sha256(content.encode('utf-8')).hexdigest() == prior[9:] and
                                                  collaboration.current(key)['revision'] == result['revision'] and
                                                  result['status'] != 'conflict' and not collaboration.unresolved_count(key))
                            if prior is not None and not capacity_retry:
                                if prior.startswith('capacity:'):
                                    result['publication'] = {'state': 'conflict', 'operation': operation,
                                                             'reasons': ['capacity_retry_changed']}
                                else:
                                    result['publication'] = inspect(root, relative, collaboration.root / 'publication' / operation)
                                if prior in ('pending', 'outcome_uncertain'):
                                    result['publication']['state'] = 'outcome_uncertain'
                                    result['publication']['reasons'].append('incomplete_attempt')
                                elif prior == 'conflict' and result['publication']['state'] == 'published':
                                    result['publication']['state'] = 'conflict'
                                if result['publication']['state'] == 'published':
                                    if reconciliation['state'] != 'complete':
                                        result['publication']['state'] = 'outcome_uncertain'
                                        result['publication']['reasons'].append('retained_' + reconciliation['state'])
                                    elif needs_reconciliation or collaboration.unresolved_count(key):
                                        result['publication']['state'] = 'conflict'
                                        result['publication']['reasons'].append('store_needs_reconciliation')
                            elif reconciliation['state'] == 'uncertain':
                                result['publication'] = {'state': 'outcome_uncertain', 'operation': operation,
                                                         'reasons': ['retained_uncertain']}
                            elif previous_receipt is not None and not capacity_retry:
                                # A retry of a stored-only save is never a new
                                # authorization to exchange the current source.
                                result['publication'] = {'state': 'conflict', 'operation': operation,
                                                         'reasons': ['not_published']}
                            elif result['status'] == 'conflict' or collaboration.unresolved_count(key):
                                result['publication'] = {'state': 'conflict', 'reasons': ['unresolved_store_conflict']}
                            elif needs_reconciliation and not capacity_retry:
                                result['publication'] = {'state': 'conflict', 'reasons': ['store_needs_reconciliation']}
                            elif collaboration.current(key)['revision'] != result['revision']:
                                result['publication'] = {'state': 'conflict', 'reasons': ['head_changed']}
                            else:
                                try:
                                    collaboration.begin_publication(key, operation, prior if capacity_retry else None)
                                    result['publication'] = publish(root, relative, collaboration.root, key,
                                                                    payload['request_id'], content, result['content'],
                                                                    max_operations=retention_max_operations,
                                                                    min_free_bytes=retention_min_free_bytes)
                                    if result['publication']['state'] in ('published', 'conflict'):
                                        snapshot = retained_snapshot(collaboration.root, result['publication']['operation'])
                                        if snapshot is not None:
                                            import hashlib
                                            import uuid
                                            actual = read_file(root, relative).decode('utf-8')
                                            collaboration.observe_source(key, actual)
                                            base, displaced = snapshot
                                            if hashlib.sha256(displaced.encode('utf-8')).hexdigest() != base:
                                                observation = collaboration.observe_retained(key, result['publication']['operation'],
                                                                                             base, displaced, uuid.uuid4().hex)
                                                result['publication']['retained_observation'] = observation['status']
                                            if result['publication']['state'] == 'published':
                                                if collaboration.unresolved_count(key) or collaboration.current(key)['content'] != actual:
                                                    result['publication']['state'] = 'conflict'
                                                    result['publication']['reasons'].append('store_needs_reconciliation')
                                                elif actual != result['content']:
                                                    result['publication']['state'] = 'conflict'
                                                    result['publication']['reasons'].append('source_changed')
                                    stored_state = result['publication']['state']
                                    if stored_state == 'capacity':
                                        import hashlib
                                        stored_state += ':' + hashlib.sha256(content.encode('utf-8')).hexdigest()
                                    collaboration.complete_publication(key, operation, stored_state)
                                except (GitUnavailableError, OSError, UnicodeError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError):
                                    result['publication'] = {'state': 'outcome_uncertain',
                                                             'operation': operation_id(key, payload['request_id']),
                                                             'reasons': ['publication_or_observation_failed']}
                    else:
                        result = collaboration.current(key)
                        if result is None:
                            raise ValueError('missing document')
                        page = collaboration.history_page(key)
                        result['history'] = page['history']
                        result['unresolved_count'] = page['unresolved_count']
                        if report_autosave:
                            result['source_snapshot'] = content
                if reconciliation is not None:
                    result['reconciliation'] = reconciliation
                return self.reply(200, result)
            except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
                return self.reply(409 if write else 404, {'error': 'invalid_or_conflicting_request'})
            except GitUnavailableError:
                return self.reply(503, {'error': 'git_unavailable', 'message': 'Retain your local draft; install Git and make git available on the server PATH, then retry with the same request ID and inspect the result.'})
            except sqlite3.Error as exc:
                if getattr(exc, 'sqlite_errorcode', None) == sqlite3.SQLITE_FULL:
                    return self.reply(503, {'error': 'collaboration_capacity', 'message': 'Retain your local draft; increase the store limit or free disk space, then retry with the same request ID.'})
                return self.reply(503, {'error': 'collaboration_unavailable', 'message': 'Retain your local draft and retry.'})
            except (OSError, subprocess.SubprocessError):
                return self.reply(503, {'error': 'collaboration_unavailable', 'message': 'Retain your local draft and retry; check available disk space.'})

        def publish_fixture(self, relative, content):
            import uuid
            parts = Path(relative).parts
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            name = '.board-' + uuid.uuid4().hex
            try:
                for part in parts[:-1]:
                    next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    os.close(directory); directory = next_fd
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                try:
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(content.encode('utf-8')); stream.flush(); os.fsync(stream.fileno())
                    os.replace(name, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
                    os.fsync(directory)
                finally:
                    try: os.unlink(name, dir_fd=directory)
                    except FileNotFoundError: pass
            finally:
                os.close(directory)

        def live_relative(self, extra=()):
            params = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=8)
            required = {'family', 'program', 'lane', 'path'}
            if not required <= set(params) or set(params) - required - set(extra) or any(len(v) != 1 for v in params.values()):
                raise ValueError('invalid selector')
            family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
            if (family not in FAMILIES or lane not in FAMILIES[family] or
                    not program or program.startswith('_') or program in ('.', '..') or '/' in program or '\0' in program or
                    '\0' in path or path.startswith('/') or Path(path).suffix.lower() != '.md' or
                    any(p in ('', '.', '..') for p in path.split('/'))):
                raise ValueError('invalid selector')
            return f'{family}/{program}/{lane}/reports/{path}', {k: params[k][0] for k in extra if k in params}

        def live_read_json(self, limit):
            if (not self.trusted_request(require_origin=True) or
                    self.headers.get('X-Requested-With') != 'Bounty-Board' or
                    self.headers.get('Content-Type', '').lower() != 'application/json' or
                    self.headers.get('Transfer-Encoding')):
                raise PermissionError('untrusted')
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= limit:
                raise ValueError('invalid length')
            payload = json.loads(self.rfile.read(int(lengths[0])))
            if not isinstance(payload, dict):
                raise ValueError('invalid payload')
            return payload

        def live_request(self, method):
            import re
            import sqlite3
            from live_editing import MAX_BYTES, NotEditable, ReportUnavailable, UnresolvedConflict
            view = urlsplit(self.path).path[len('/api/live/'):]
            sha = re.compile(r'[a-f0-9]{64}')
            try:
                if method == 'GET':
                    if view == 'events':
                        return self.live_events()
                    extra = {'report': (), 'history': ('before',), 'revision': ('revision',), 'sync-conflict': ('name',)}.get(view)
                    if extra is None:
                        return self.reply(404, {'error': 'not_found'})
                    relative, args = self.live_relative(extra)
                    if view == 'report':
                        return self.reply(200, live.open(relative))
                    if view == 'history':
                        before = args.get('before')
                        if before is not None and (not before.isascii() or not before.isdecimal() or len(before) > 18):
                            raise ValueError('invalid cursor')
                        return self.reply(200, {'events': live.history_page(relative, int(before) if before else None)})
                    if view == 'revision':
                        if not sha.fullmatch(args.get('revision', '')):
                            raise ValueError('invalid revision')
                        return self.reply(200, {'content': live.revision(relative, args['revision'])})
                    return self.reply(200, live.sync_conflict(relative, args.get('name', '')))
                extra = {'save': (), 'restore': (), 'sync-conflict': ('name',)}.get(view)
                if extra is None:
                    return self.reply(404, {'error': 'not_found'})
                relative, args = self.live_relative(extra)
                payload = self.live_read_json(2 * MAX_BYTES + 4096)
                if root_snapshot() != live_root:
                    return self.reply(409, {'error': 'root_changed', 'message': 'The data root changed; restart the Board.'})
                client = payload.get('client')
                if not isinstance(client, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', client):
                    raise ValueError('invalid client')
                author = payload.get('author', 'Board editor')
                if not isinstance(author, str) or not 0 < len(author) <= 60 or not author.isprintable():
                    raise ValueError('invalid author')
                base = payload.get('base')
                if not isinstance(base, str) or not sha.fullmatch(base):
                    raise ValueError('invalid base')
                allowed = {'save': {'base', 'content', 'client', 'author'}, 'restore': {'base', 'revision', 'client', 'author'},
                           'sync-conflict': {'base', 'content', 'action', 'client', 'author'}}[view]
                if set(payload) - allowed:
                    raise ValueError('unexpected fields')
                if view == 'save':
                    return self.reply(200, live.save(relative, base, payload.get('content'), author=author, client=client))
                if view == 'restore':
                    revision = payload.get('revision')
                    if not isinstance(revision, str) or not sha.fullmatch(revision):
                        raise ValueError('invalid revision')
                    return self.reply(200, live.restore(relative, revision, base, author=author, client=client))
                action = payload.get('action')
                if action not in ('apply', 'discard'):
                    raise ValueError('invalid action')
                return self.reply(200, live.resolve_sync_conflict(relative, args.get('name', ''), action, base=base,
                                                                 content=payload.get('content'), author=author, client=client))
            except PermissionError:
                return self.reply(403, {'error': 'untrusted_origin'})
            except UnresolvedConflict:
                return self.reply(422, {'error': 'unresolved_conflict', 'message': 'Resolve the marked conflict before saving.'})
            except NotEditable as exc:
                return self.reply(403, {'error': 'not_editable', 'reason': str(exc)})
            except KeyError:
                return self.reply(404, {'error': 'revision_or_copy_not_found'})
            except (ReportUnavailable, FileNotFoundError, NotADirectoryError):
                return self.reply(404, {'error': 'report_not_found_or_unavailable'})
            except (ValueError, UnicodeError, json.JSONDecodeError):
                return self.reply(400, {'error': 'invalid_request'})
            except (OSError, sqlite3.Error):
                return self.reply(503, {'error': 'live_edit_unavailable', 'message': 'Your text is kept in this browser; retrying.'})

        def live_events(self):
            import queue
            relative, _ = self.live_relative()
            if not self.server.live_streams.acquire(blocking=False):
                return self.reply(503, {'error': 'too_many_streams'}, {'Retry-After': '5'})
            try:
                # Refuses missing or unreadable reports (answered as 404).
                subscriber = live.subscribe(relative)
            except BaseException:
                self.server.live_streams.release()
                raise
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Accel-Buffering', 'no')
                self.end_headers()
                self.wfile.write(b'retry: 2000\n\n')
                self.wfile.flush()
                while not live.stopped.is_set():
                    try:
                        event = subscriber.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b': keep-alive\n\n')
                        self.wfile.flush()
                        continue
                    if event is None:
                        break
                    self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                pass
            finally:
                live.unsubscribe(relative, subscriber)
                self.server.live_streams.release()
                self.close_connection = True

        # --- Report artifacts (feat/board-report-artifacts) -------------------
        # Lists and serves files associated with one report; see
        # report_artifacts.py for the association rule and docs/integrations/
        # report-artifacts.md for the contract. Read-only; every download
        # re-runs the association and opens the file without following symlinks.
        def report_artifacts(self, view):
            import report_artifacts as ra
            params = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=8)
            bound = 'root_instance' in params
            needed = {'family', 'program', 'lane', 'path'} | ({'artifact'} if view in ('file', 'media') else set())
            before = root_snapshot() if bound else None
            lane_fd = None
            self.artifact_started = False
            try:
                if set(params) != needed | ({'root_instance'} if bound else set()) or any(len(v) != 1 for v in params.values()):
                    raise ra.ArtifactError('invalid selector')
                if bound and (not before or params['root_instance'] != [before[2]]):
                    return self.reply(409, {'error': 'root_changed'})
                family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
                if (family not in FAMILIES or lane not in FAMILIES[family] or not program or program.startswith('_') or
                        program in ('.', '..') or '/' in program or '\0' in program):
                    raise ra.ArtifactError('invalid selector')
                lane_fd = ra.open_lane(before[0] if bound else root, family, program, lane)
                found = ra.associate(lane_fd, family, program, lane, path)
                if view == 'list':
                    # 'upload' (feat/board-artifact-uploads): whether the panel may upload here.
                    # 'deletable' per entry (feat/board-artifact-delete): whether the panel may offer Delete.
                    from artifact_uploads import upload_state, mark_deletable
                    mark_deletable(self.server.artifact_uploads, found)
                    return self.reply(200, {**found, 'max_zip_bytes': ra.MAX_ZIP_BYTES,
                                            'upload': upload_state(self.server.artifact_uploads, found)})
                if view == 'zip':
                    return self.artifact_zip(ra, lane_fd, found, path)
                item = next((a for a in found['artifacts'] if a['relative'] == params['artifact'][0]), None)
                if item is None:
                    raise ra.ArtifactError('not associated')
                ext = Path(item['name']).suffix.lower()
                if view == 'media' and (item['sensitive'] or ext not in ra.INLINE_TYPES):
                    return self.reply(415, {'error': 'preview_not_allowed'})
                fd, info = ra.open_file(lane_fd, item['relative'])
                with os.fdopen(fd, 'rb') as stream:
                    self.artifact_stream(ra, stream, info.st_size, item['name'],
                                         ra.INLINE_TYPES[ext] if view == 'media' else 'application/octet-stream',
                                         'inline' if view == 'media' else 'attachment')
            except (OSError, ValueError, UnicodeError, ra.ArtifactError):
                if self.artifact_started:
                    self.close_connection = True  # body already streaming; client sees a short response
                elif bound and before and root_snapshot() != before:
                    self.reply(409, {'error': 'root_changed'})
                else:
                    self.reply(404, {'error': 'artifact_not_found_or_unavailable'})
            finally:
                if lane_fd is not None:
                    os.close(lane_fd)

        # --- Artifact uploads (feat/board-artifact-uploads) ---------------------
        # Opt-in (--artifact-uploads). Stores one raw-body file in the report's
        # dedicated folder; logic and gates live in artifact_uploads.py, contract
        # in docs/integrations/artifact-uploads.md.
        def artifact_upload(self):
            from artifact_uploads import handle_upload
            return handle_upload(self, self.server.artifact_uploads, root, root_snapshot, FAMILIES)

        # --- Artifact delete (feat/board-artifact-delete) ----------------------
        # Same opt-in flag; removes one listed, non-Markdown file from the
        # report's dedicated folder. Logic in artifact_uploads.handle_delete.
        def artifact_delete(self):
            from artifact_uploads import handle_delete
            return handle_delete(self, self.server.artifact_uploads, root, root_snapshot, FAMILIES)

        def artifact_headers(self, content_type, disposition):
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Disposition', disposition)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "sandbox; default-src 'none'")
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Cache-Control', 'no-store')

        def artifact_stream(self, ra, stream, size, name, content_type, kind):
            span = ra.parse_range(self.headers.get('Range'), size)
            if span == 'invalid':
                self.send_response(416)
                self.artifact_headers('application/octet-stream', ra.content_disposition('attachment', name))
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            start, end = span or (0, size - 1)
            self.send_response(206 if span else 200)
            self.artifact_headers(content_type, ra.content_disposition(kind, name))
            self.send_header('Accept-Ranges', 'bytes')
            if span:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(max(end - start + 1, 0)))
            self.end_headers()
            self.artifact_started = True
            stream.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = stream.read(min(ra.CHUNK, remaining))
                if not chunk:
                    break  # file shrank; the client sees a short body
                self.wfile.write(chunk)
                remaining -= len(chunk)

        def artifact_zip(self, ra, lane_fd, found, path):
            import time
            import zipfile
            items = [a for a in found['artifacts'] if not a['sensitive']]
            if not items:
                return self.reply(404, {'error': 'no_artifacts'})
            if sum(a['size'] for a in items) > ra.MAX_ZIP_BYTES:
                return self.reply(413, {'error': 'archive_too_large', 'max_zip_bytes': ra.MAX_ZIP_BYTES})
            stem = Path(path).parent.name if '/' in path else Path(path).stem
            self.send_response(200)
            self.artifact_headers('application/zip', ra.content_disposition('attachment', f'{stem or "report"}-artifacts.zip'))
            self.end_headers()
            self.artifact_started = self.close_connection = True
            budget = ra.MAX_ZIP_BYTES
            with zipfile.ZipFile(self.wfile, 'w', allowZip64=True) as archive:
                for item in items:
                    try:
                        fd, info = ra.open_file(lane_fd, item['relative'])
                    except ra.ArtifactError:
                        continue
                    with os.fdopen(fd, 'rb') as stream:
                        size = min(info.st_size, budget)
                        entry = zipfile.ZipInfo(item['relative'], date_time=max(time.localtime(info.st_mtime)[:6], (1980, 1, 1, 0, 0, 0)))
                        entry.compress_type = zipfile.ZIP_DEFLATED if item['category'] in ('code', 'data') else zipfile.ZIP_STORED
                        entry.file_size = size
                        with archive.open(entry, 'w', force_zip64=size > 0x7fffffff) as target:
                            remaining = size
                            while remaining > 0:
                                chunk = stream.read(min(ra.CHUNK, remaining))
                                if not chunk:
                                    break
                                target.write(chunk)
                                remaining -= len(chunk)
                        budget -= size - remaining
                    if budget <= 0:
                        break
            return None

        def search_request(self, url):
            from search_index import KINDS, MAX_QUERY
            try:
                params = parse_qs(url.query, keep_blank_values=True, strict_parsing=bool(url.query),
                                  encoding='utf-8', errors='strict', max_num_fields=4)
                if not set(params) <= {'q', 'limit', 'program', 'kind'} or any(len(v) != 1 for v in params.values()):
                    raise ValueError('invalid parameters')
                query = params.get('q', [''])[0]
                if len(query) > MAX_QUERY or '\0' in query:
                    raise ValueError('invalid query')
                limit = 8
                if 'limit' in params:
                    raw = params['limit'][0]
                    if not raw.isascii() or not raw.isdecimal() or len(raw) > 3 or not 1 <= int(raw) <= 50:
                        raise ValueError('invalid limit')
                    limit = int(raw)
                program = params.get('program', [''])[0]
                if len(program) > 200 or '\0' in program or ('program' in params and not program):
                    raise ValueError('invalid program')
                kinds = KINDS
                if 'kind' in params:
                    kinds = tuple(params['kind'][0].split(','))
                    if not kinds or len(set(kinds)) != len(kinds) or any(k not in KINDS for k in kinds):
                        raise ValueError('invalid kind')
            except (ValueError, UnicodeError):
                return self.reply(400, {'error': 'invalid_search', 'message': 'Invalid search parameters.'})
            if not search_slots.acquire(blocking=False):
                return self.reply(503, {'error': 'search_busy'}, {'Retry-After': '1'})
            try:
                return self.reply(200, search_index.search(query, limit=limit, program=program or None, kinds=kinds))
            finally:
                search_slots.release()

        def recent_reports_request(self, url):
            """GET /api/recent-reports: reports across all programs, newest first.

            Served from the search index (file modification time, title, owners);
            bounded page size and filter sizes, same trust checks as every GET.
            """
            import finding_facets
            from search_index import MAX_QUERY
            lanes = set().union(*FAMILIES.values())
            # Repeatable filters: name -> (allowed values, most repeats).
            repeatable = {'program': (None, 100), 'lane': (lanes, len(lanes)),
                          'severity': ({k for k, _ in finding_facets.SEVERITIES}, len(finding_facets.SEVERITIES)),
                          'class': ({k for k, _ in finding_facets.class_options()}, len(finding_facets.class_options())),
                          'submission': ({k for k, _ in finding_facets.SUBMISSIONS}, len(finding_facets.SUBMISSIONS))}
            try:
                params = parse_qs(url.query, keep_blank_values=True, strict_parsing=bool(url.query),
                                  encoding='utf-8', errors='strict', max_num_fields=200)
                allowed = {'limit', 'offset', 'within', 'q', 'order', 'nav', 'hide_na', *repeatable}
                if not set(params) <= allowed or any(len(v) != 1 for k, v in params.items() if k not in repeatable):
                    raise ValueError('invalid parameters')
                for name, (values, most) in repeatable.items():
                    given = params.get(name, [])
                    if len(given) > most or (values is not None and any(v not in values for v in given)):
                        raise ValueError('invalid ' + name)

                def number(name, default, low, high):
                    if name not in params:
                        return default
                    raw = params[name][0]
                    if not raw.isascii() or not raw.isdecimal() or len(raw) > 10 or not low <= int(raw) <= high:
                        raise ValueError('invalid ' + name)
                    return int(raw)
                limit = number('limit', 50, 1, 200)
                offset = number('offset', 0, 0, 1_000_000)
                within = number('within', None, 1, 20 * 365 * 86400)
                programs = params.get('program', [])
                if any(not p or len(p) > 200 or '\0' in p for p in programs):
                    raise ValueError('invalid program')
                query = params.get('q', [''])[0]
                if len(query) > MAX_QUERY or '\0' in query:
                    raise ValueError('invalid query')
                order = params.get('order', ['newest'])[0]
                nav = params.get('nav', ['0'])[0]
                hide_na = params.get('hide_na', ['0'])[0]
                if order not in ('newest', 'oldest', 'severity', 'class') or nav not in ('0', '1') or hide_na not in ('0', '1'):
                    raise ValueError('invalid order')
            except (ValueError, UnicodeError):
                return self.reply(400, {'error': 'invalid_recent_reports', 'message': 'Invalid recent report parameters.'})
            if not search_slots.acquire(blocking=False):
                return self.reply(503, {'error': 'search_busy'}, {'Retry-After': '1'})
            try:
                na_keys, _ = report_na_flags(self.server.report_na)
                return self.reply(200, search_index.recent(limit=limit, offset=offset, within=within, programs=programs,
                                                           lanes=params.get('lane', []), query=query, order=order,
                                                           include_navigation=nav == '1', na_keys=na_keys, hide_na=hide_na == '1',
                                                           severities=params.get('severity', []), classes=params.get('class', []),
                                                           submissions=params.get('submission', [])))
            finally:
                search_slots.release()

        def do_GET(self):
            import hashlib
            import os
            url = urlsplit(self.path)
            if not self.trusted_request(navigation=url.path in ('/', '/index.html')):
                self.reply(403, {'error': 'untrusted_origin'})
                return
            if url.path == '/api/user-preferences':
                try:
                    preferences = user_preferences.read()
                except (OSError, ValueError, UnicodeError):
                    return self.reply(503, {'error': 'preferences_unavailable'})
                return self.reply(200, {'preferences': preferences})
            if url.path in ('/api/report-artifacts', '/api/report-artifact', '/api/report-artifact-media', '/api/report-artifacts.zip'):
                return self.report_artifacts({'/api/report-artifacts': 'list', '/api/report-artifact': 'file',
                                              '/api/report-artifact-media': 'media', '/api/report-artifacts.zip': 'zip'}[url.path])
            if url.path.startswith('/api/live/'):
                if live is None:
                    return self.reply(404, {'error': 'live_edit_disabled'})
                return self.live_request('GET')
            if url.path == '/api/search':
                return self.search_request(url)
            if url.path == '/api/recent-reports':
                return self.recent_reports_request(url)
            if url.path in ('/api/recon/overview', '/api/recon/program', '/api/recon/urls', '/api/recon/url'):
                from recon_intel import handle_request
                return handle_request(self, url, recon)
            if url.path == '/api/scope':
                from scope_inventory import handle_request as scope_request
                return scope_request(self, url, scope_inventory, FAMILIES)
            if url.path == '/api/archive-state':
                return self.archive_state_request(url)
            if url.path == '/api/collaboration':
                return self.collaboration_admitted()
            if url.path == '/api/collaboration/recovery':
                return self.collaboration_admitted(view='recovery')
            if url.path == '/api/collaboration/history':
                return self.collaboration_admitted(view='history')
            if url.path == '/api/collaboration/version':
                return self.collaboration_admitted(view='version')
            if url.path == '/api/data':
                params = parse_qs(url.query, keep_blank_values=True)
                phase = params.get('phase', [self.headers.get('X-Bounty-Board-Phase', '')])[0]
                # Metadata and fixture writers retain the synchronous path.
                # Collaborative report writes validate their source independently.
                phased = (phase in ('summary', 'complete', 'identity') and not self.server.writer
                          and not experimental_fixture_publish)
                before = root_snapshot() if phased else None
                if phased and phase == 'identity':
                    self.reply(200, {'root_instance': before[2] if before else None}); return
                if phased and phase == 'complete' and (not before or params.get('root_instance') != [before[2]]):
                    self.reply(409, {'error': 'root_changed'}); return
                if phased and before:
                    if phase == 'complete' and not portfolio_scan.acquire(blocking=False):
                        self.reply(503, {'error': 'portfolio_scan_busy'}); return
                    try:
                        result: dict = discover(before[0], report_autosave, include_reports=phase != 'summary', inventory_only=phase == 'summary')
                    finally:
                        if phase == 'complete':
                            portfolio_scan.release()
                    if root_snapshot() != before:
                        self.reply(409, {'error': 'root_changed'}); return
                    result['root_identity'] = before[1]
                    result['root_instance'] = before[2]
                    result['reports_loading'] = phase == 'summary'
                    result['portfolio_unloaded'] = phase == 'summary'
                else:
                    before = root_snapshot() if self.server.writer_enabled else None
                    result = discover(root, report_autosave)
                    if self.server.writer_enabled:
                        if not before or root_snapshot() != before:
                            self.reply(409, {'error': 'root_changed'}); return
                        result['root_instance'] = before[2]
                # Identity follows the effective canonical path, not report content.
                # It is an opaque namespace, not a secret or authentication token.
                try:
                    import os
                    if not (phased and before):
                        canonical = root.resolve(strict=True)
                        result['root_identity'] = hashlib.sha256(os.fsencode(str(canonical))).hexdigest() if canonical.is_dir() else None
                except (OSError, RuntimeError):
                    result['root_identity'] = None
                result['capabilities'] = {'finding_metadata': self.server.writer_enabled,
                                          'finding_fields': ['severity', 'class_name', 'status', 'severity_rationale'] if self.server.writer_enabled else [],
                                          'finding_options': {'severity': SEVERITIES, 'status': STATUSES} if self.server.writer_enabled else {},
                                          'finding_metadata_warning': METADATA_WRITE_WARNING,
                                          'ledger_actions': ledger_action_capabilities(self.server),
                                          'report_edit': False,
                                          'collaboration': collaboration is not None,
                                          'report_autosave': report_autosave,
                                          'live_edit': live is not None,
                                          # Sandbox terminal (terminal_service.py, a separate process
                                          # published on this origin); None hides the terminal UI.
                                          'terminal_url': terminal_url,
                                          # Report artifact uploads (artifact_uploads.py, --artifact-uploads).
                                          'artifact_uploads': self.server.artifact_uploads is not None,
                                          'fixture_publish': experimental_fixture_publish}
                if self.server.report_na is not None:
                    # Forget marks of reports that were moved or deleted (confirmed per file, bounded).
                    self.server.report_na.prune(report_na_listings(
                        [(p['family'], p['name'], l['name'], l.get('reports'), l.get('warnings')) for p in result.get('programs', [])
                         for l in p['lanes']]), self.report_missing)
                na_keys, na_available = report_na_flags(self.server.report_na)
                result['capabilities']['report_na'] = {'enabled': na_available}
                for program_entry in result.get('programs', []):
                    for lane_entry in program_entry['lanes']:
                        prefix = f"{program_entry['id']}/{lane_entry['name']}/"
                        for report in lane_entry.get('reports') or []:
                            report['na'] = bool(na_keys) and prefix + report['path'] in na_keys
                if phased and before:
                    result['capabilities']['source_authoritative'] = phase != 'summary'
                self.reply(200, result)
                return
            if url.path in ('/api/lane', '/api/lane-reports'):
                if self.server.writer or experimental_fixture_publish:
                    self.reply(404, {'error': 'not_found'}); return
                if not lane_reads.acquire(blocking=False):
                    self.reply(503, {'error': 'lane_read_busy'}); return
                before = root_snapshot()
                try:
                    params = parse_qs(url.query, keep_blank_values=True, strict_parsing=True, max_num_fields=4)
                    if set(params) != {'root_instance', 'family', 'program', 'lane'} or any(len(v) != 1 for v in params.values()):
                        raise ValueError('invalid selector')
                    if not before or params['root_instance'] != [before[2]]:
                        self.reply(409, {'error': 'root_changed'}); return
                    family, program, name = (params[k][0] for k in ('family', 'program', 'lane'))
                    if (family not in FAMILIES or name not in FAMILIES[family] or not program or
                            program.startswith('_') or program in ('.', '..') or '/' in program or '\0' in program):
                        raise ValueError('invalid selector')
                    family_dir = before[0] / family
                    program_dir = family_dir / program
                    lane_dir = program_dir / name
                    if any(p.is_symlink() or not p.is_dir() for p in (family_dir, program_dir, lane_dir)):
                        raise ValueError('invalid lane')
                    warnings = []
                    findings = ledger(lane_dir, warnings)
                    if url.path == '/api/lane-reports':
                        items = reports(lane_dir, warnings, findings, report_autosave)
                        if root_snapshot() != before:
                            self.reply(409, {'error': 'root_changed'}); return
                        if self.server.report_na is not None:
                            self.server.report_na.prune(report_na_listings([(family, program, name, items, warnings)]), self.report_missing)
                        na_keys, na_available = report_na_flags(self.server.report_na)
                        prefix = f'{family}/{program}/{name}/'
                        for report in items or []:
                            report['na'] = bool(na_keys) and prefix + report['path'] in na_keys
                        self.reply(200, {'root_instance': before[2], 'family': family, 'program': program,
                                         'lane': name, 'reports': items, 'warnings': warnings,
                                         'source_authoritative': True, 'na_available': na_available})
                        return
                    entries = map_entries(lane_dir, warnings)
                    selected = {'name': name, 'findings': findings, 'map': entries,
                                'coverage': coverage(lane_dir, warnings), 'reports': None,
                                'gadgets': [e for e in entries if 'gadget' in (e['tags'] or [])] if entries is not None else None,
                                'warnings': warnings, 'reports_unscanned': True}
                    if root_snapshot() != before:
                        self.reply(409, {'error': 'root_changed'}); return
                    self.reply(200, {'root_instance': before[2], 'family': family, 'program': program, 'lane': selected,
                                     'source_authoritative': True})
                except (OSError, ValueError, UnicodeError):
                    if before and root_snapshot() != before:
                        self.reply(409, {'error': 'root_changed'})
                    else:
                        self.reply(404, {'error': 'lane_not_found_or_unavailable'})
                finally:
                    lane_reads.release()
                return
            if url.path == '/api/map-observation':
                before = None
                bound = False
                try:
                    params = parse_qs(url.query, keep_blank_values=True, strict_parsing=True,
                                      encoding='utf-8', errors='strict', max_num_fields=5)
                    bound = 'root_instance' in params
                    required = {'family', 'program', 'lane', 'path'}
                    if set(params) != required | ({'root_instance'} if bound else set()) or any(len(v) != 1 for v in params.values()):
                        raise ValueError('invalid selector')
                    if bound:
                        before = root_snapshot()
                        if not before or params['root_instance'] != [before[2]]:
                            self.reply(409, {'error': 'root_changed'}); return
                    family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
                    if (family not in FAMILIES or lane not in FAMILIES[family] or
                            not program or program.startswith('_') or program in ('.', '..') or
                            '/' in program or '\0' in program or '\0' in path or
                            any(part in ('', '.', '..') for part in path.split('/')) or
                            path.split('/')[-1] != 'index.md'):
                        raise ValueError('invalid selector')
                    prefix = f'{family}/{program}/{lane}/recon/maps/'
                    source = before[0] if before else root
                    raw = read_file(source, prefix + 'map.jsonl').decode('utf-8')
                    entries = [json.loads(line) for line in raw.splitlines() if line.strip()]
                    if any(not isinstance(item, dict) or not isinstance(item.get('tags', []), list) for item in entries):
                        raise ValueError('invalid index')
                    if sum(item.get('path') == path for item in entries) != 1:
                        raise ValueError('unindexed or ambiguous')
                    content = read_file(source, prefix + path).decode('utf-8')
                    if bound and root_snapshot() != before:
                        self.reply(409, {'error': 'root_changed'}); return
                    self.reply(200, {'content': content})
                except (OSError, ValueError, UnicodeError, RecursionError):
                    if bound and before and root_snapshot() != before:
                        self.reply(409, {'error': 'root_changed'})
                    else:
                        self.reply(404, {'error': 'observation_not_found_or_unavailable'})
                return
            if url.path == '/api/report':
                params = parse_qs(url.query, keep_blank_values=True)
                bound = 'root_instance' in params
                before = root_snapshot() if bound else None
                try:
                    if set(params) != {'family', 'program', 'lane', 'path'} | ({'root_instance'} if bound else set()) or any(len(v) != 1 for v in params.values()):
                        raise ValueError()
                    if bound and (not before or params['root_instance'] != [before[2]]):
                        self.reply(409, {'error': 'root_changed'}); return
                    family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
                    if family not in FAMILIES or lane not in FAMILIES[family] or not program or program.startswith('_') or '/' in program or program in ('.', '..'):
                        raise ValueError()
                    if path.startswith('/') or Path(path).suffix.lower() != '.md' or any(p in ('..', '.') for p in path.split('/')):
                        raise ValueError()
                    content = read_file(before[0] if bound else Path(root), f'{family}/{program}/{lane}/reports/{path}')
                    text = content.decode('utf-8')
                    if bound and root_snapshot() != before:
                        self.reply(409, {'error': 'root_changed'}); return
                    revision = hashlib.sha256(content).hexdigest()
                    from report_publisher import generated_navigation
                    eligible = not generated_navigation(path, text)
                    self.reply(200, {'content': text, 'revision': revision,
                                     'editable': bool(report_autosave and eligible),
                                     'collaboration_editable': eligible,
                                     **({'root_instance': before[2], 'source_authoritative': True} if bound else {})}, {'ETag': '"' + revision + '"'})
                except (OSError, ValueError, UnicodeError):
                    if bound and before and root_snapshot() != before:
                        self.reply(409, {'error': 'root_changed'})
                    else:
                        self.reply(404, {'error': 'report_not_found_or_unavailable'})
                return
            if not url.path.startswith('/api/'):
                import mimetypes
                from urllib.parse import unquote
                relative = unquote(url.path).lstrip('/') or 'index.html'
                try:
                    data = read_file(self.server.static_root, relative)
                    self.send_response(200)
                    self.send_header('Content-Type', mimetypes.guess_type(relative)[0] or 'application/octet-stream')
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    if relative == 'index.html':
                        # The page may be opened from other sites; never inside
                        # their frames, and without a handle back to the opener.
                        self.send_header('X-Frame-Options', 'DENY')
                        self.send_header('Content-Security-Policy', "frame-ancestors 'none'")
                        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
                    self.end_headers()
                    self.wfile.write(data)
                except (OSError, ValueError):
                    self.reply(404, {'error': 'not_found'})
                return
            self.reply(404, {'error': 'not_found'})

        def do_PUT(self):
            self.reply(403, {'error': 'editing_disabled', 'message': 'Report writes are disabled; retain your draft.'})

        def do_POST(self):
            if urlsplit(self.path).path == '/api/user-preferences':
                try:
                    payload = self.live_read_json(USER_PREFERENCES_MAX_BYTES)
                    if set(payload) not in ({'set'}, {'migrate'}):
                        raise ValueError('invalid payload')
                    migrate = 'migrate' in payload
                    values = validate_user_preferences(payload['migrate' if migrate else 'set'])
                except PermissionError:
                    self.close_connection = True
                    return self.reply(403, {'error': 'untrusted_origin'})
                except (ValueError, UnicodeError):
                    self.close_connection = True
                    return self.reply(400, {'error': 'invalid_request'})
                try:
                    result = user_preferences.update(values, migrate=migrate)
                except (OSError, ValueError, UnicodeError):
                    self.close_connection = True
                    return self.reply(503, {'error': 'preferences_unavailable'})
                return self.reply(200, {'preferences': result})
            if urlsplit(self.path).path == '/api/report-artifact-upload':  # feat/board-artifact-uploads
                return self.artifact_upload()
            if urlsplit(self.path).path == '/api/report-artifact-delete':  # feat/board-artifact-delete
                return self.artifact_delete()
            if urlsplit(self.path).path.startswith('/api/live/'):
                if live is None:
                    return self.reply(404, {'error': 'live_edit_disabled'})
                return self.live_request('POST')
            if urlsplit(self.path).path == '/api/collaboration':
                return self.collaboration_admitted(write=True)
            if urlsplit(self.path).path == '/api/report-na':
                # Board-only state: independent of the BBH writer and its lock.
                return self.report_na_request()
            # Ledger actions share the metadata lock with PATCH /api/finding.
            action = {'/api/finding/submission': self.set_submission, '/api/finding/new': self.add_finding,
                      '/api/finding/reclassify': self.reclassify_finding, '/api/finding/delete': self.delete_finding,
                      '/api/recon/mark': self.recon_mark}.get(urlsplit(self.path).path)
            if action:
                with metadata_write_lock:
                    return action()
            self.do_PUT()

        def do_PATCH(self):
            with metadata_write_lock:
                return self.patch_finding()

        def finding_precheck(self, family, program, lane, fid, root_instance, expected_revision):
            """Shared pre-write checks for every BBH finding writer.

            Returns (lane_path, finding) or None after replying with the refusal.
            With expected_revision=None only the lane/root/tree checks run and
            finding is None (used to add a new finding)."""
            import os
            lane_path = root / family / program / lane
            before = root_snapshot()
            if not before or before[2] != root_instance:
                return self.reply(409, {'error': 'root_changed'})
            if any(path.is_symlink() or not path.is_dir() for path in (root, root / family, root / family / program, lane_path)):
                return self.reply(404, {'error': 'finding_not_found'})
            layout_paths = [lane_path / p for p in (
                'context', 'context/target_profile.json', 'context/me_context.md', 'context/session_handoff.md',
                'notes', 'notes/index.md', 'notes/faq', 'notes/hypotheses', 'notes/handoffs', 'notes/timeline',
                'working', 'working/scratch', 'recon', 'recon/urls', 'recon/params', 'recon/js',
                'recon/maps', 'recon/artifacts', 'input', 'input/original', 'input/extracted', 'input/metadata')]
            layout_paths.append(root / family / program / 'shared')
            if any(path.is_symlink() for path in layout_paths):
                return self.reply(409, {'error': 'unsafe_writer_tree'})
            # BBH refresh touches generated paths; reject escaping symlinks.
            for directory in (lane_path / 'ledgers', lane_path / 'reports'):
                if directory.is_symlink() or not directory.is_dir():
                    return self.reply(409, {'error': 'unsafe_writer_tree'})
                walk_errors = []
                for current, dirs, files in os.walk(directory, followlinks=False, onerror=walk_errors.append):
                    if any((Path(current) / name).is_symlink() for name in dirs):
                        return self.reply(409, {'error': 'unsafe_writer_tree'})
                    for name in files:
                        path = Path(current) / name
                        if path.is_symlink():
                            try:
                                target = path.resolve(strict=True)
                                if directory.name != 'reports' or not target.is_relative_to(directory.resolve()):
                                    raise ValueError('escaping link')
                            except (OSError, ValueError, RuntimeError):
                                return self.reply(409, {'error': 'unsafe_writer_tree'})
                if walk_errors:
                    return self.reply(409, {'error': 'unsafe_writer_tree'})
            self.pre_write = ledger_snapshot(lane_path)
            if expected_revision is None:
                return (lane_path, None) if root_snapshot() == before else self.reply(409, {'error': 'root_changed'})
            findings = ledger(lane_path, [])
            matches = [f for f in findings or [] if isinstance(f.get('fid'), str) and f['fid'].upper() == fid.upper()]
            if len(matches) != 1 or matches[0]['fid'] != fid:
                return self.reply(404, {'error': 'finding_not_found'})
            if root_snapshot() != before or matches[0]['metadata_revision'] != expected_revision:
                return self.reply(409, {'error': 'finding_changed', 'message': 'Finding changed since it was loaded. Copy your pending value, refresh, and review before retrying.'})
            return lane_path, matches[0]

        def patch_finding(self):
            import os
            import re
            import subprocess
            import tempfile
            if urlsplit(self.path).path != '/api/finding':
                return self.do_PUT()
            if (not self.trusted_request(require_origin=True) or
                self.headers.get('X-Requested-With') != 'Bounty-Board' or
                self.headers.get('Content-Type', '').lower() != 'application/json' or
                self.headers.get('Transfer-Encoding')):
                return self.reply(403, {'error': 'untrusted_origin'})
            if not self.server.writer_enabled:
                return self.reply(503, {'error': 'writer_unavailable'})
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= 16384:
                    raise ValueError('invalid length')
                payload = json.loads(self.rfile.read(int(lengths[0])))
                if not isinstance(payload, dict) or set(payload) != {'family', 'program', 'lane', 'fid', 'patch', 'expected_revision', 'root_instance'}:
                    raise ValueError('invalid payload')
                family, program, lane, fid, patch = (payload[k] for k in ('family', 'program', 'lane', 'fid', 'patch'))
                if any(not isinstance(payload[k], str) or not re.fullmatch(r'[a-f0-9]{64}', payload[k]) for k in ('expected_revision', 'root_instance')):
                    raise ValueError('invalid precondition')
                if (not isinstance(family, str) or family not in FAMILIES or not isinstance(lane, str) or lane not in FAMILIES[family] or
                    not isinstance(program, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', program) or
                    not isinstance(fid, str) or not re.fullmatch(r'[A-Za-z][0-9]{2,}', fid) or
                    not isinstance(patch, dict) or not patch or set(patch) - {'severity', 'class_name', 'status', 'severity_rationale'} or
                    any(not isinstance(v, str) or len(v) > 4000 for v in patch.values())):
                    raise ValueError('invalid fields')
                if ('severity' in patch and patch['severity'] not in SEVERITIES or
                    'status' in patch and not re.fullmatch(STATUS_TOKEN, patch['status']) or
                    'class_name' in patch and not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,99}', patch['class_name'])):
                    raise ValueError('invalid value')
            except (ValueError, UnicodeError, json.JSONDecodeError):
                return self.reply(400, {'error': 'invalid_finding_patch'})
            checked = self.finding_precheck(family, program, lane, fid, payload['root_instance'], payload['expected_revision'])
            if not checked:
                return
            lane_path, before = checked
            try:
                with tempfile.TemporaryDirectory(prefix='bounty-board-') as temp:
                    patchfile = Path(temp) / 'patch.json'
                    patchfile.write_text(json.dumps(patch), encoding='utf-8')
                    result = subprocess.run([str(self.server.writer), 'agents/manual_hunter.py', program,
                        '--family', family, '--lane', lane, '--root', str(root), '--edit-finding', fid,
                        '--patch-file', str(patchfile)], capture_output=True, timeout=60)
                # The ledger may have changed (even after a failure): let Recent re-read it.
                search_index.touch()
                if result.returncode != 0:
                    self.server.writer_enabled = False
                    return self.reply(502, {'error': 'writer_failed', 'message': 'Update may be incomplete; refresh before retrying.'})
                updated = [f for f in ledger(lane_path, []) or [] if f.get('fid') == fid]
                if (len(updated) != 1 or any(updated[0].get(k) != v for k, v in patch.items()) or
                    ('status' in patch and isinstance(updated[0].get('current'), dict) and
                     updated[0]['current'].get('status') != patch['status'])):
                    self.server.writer_enabled = False
                    return self.reply(502, {'error': 'verification_failed', 'message': 'Update may be incomplete; refresh before retrying.'})
                return self.reply(200, {'finding': updated[0], 'revisions': self.rebased_revisions(lane_path),
                                        **self.track_archive(family, program, lane, fid, before.get('status'), patch.get('status'))})
            except (OSError, subprocess.SubprocessError):
                self.server.writer_enabled = False
                return self.reply(503, {'error': 'writer_unavailable', 'message': 'Update may be incomplete; refresh before retrying.'})

        # --- Ledger actions (feat/board-ledger-actions) -------------------------
        # Every action runs a supported BBH manual_hunter command, mirrors
        # patch_finding's safety (same-origin JSON, root/revision preconditions,
        # read-back verification) and disables the writer after a failure.
        def ledger_action_payload(self, keys, feature):
            import re
            if (not self.trusted_request(require_origin=True) or
                self.headers.get('X-Requested-With') != 'Bounty-Board' or
                self.headers.get('Content-Type', '').lower() != 'application/json' or
                self.headers.get('Transfer-Encoding')):
                return self.reply(403, {'error': 'untrusted_origin'})
            if not self.server.writer_enabled or (feature is not None and feature not in self.server.writer_features):
                return self.reply(503, {'error': 'writer_unavailable'})
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= 16384:
                    raise ValueError('invalid length')
                payload = json.loads(self.rfile.read(int(lengths[0])))
                if not isinstance(payload, dict) or set(payload) != {'family', 'program', 'lane', 'root_instance', *keys}:
                    raise ValueError('invalid payload')
                family, program, lane = (payload[k] for k in ('family', 'program', 'lane'))
                if any(not isinstance(payload[k], str) or not re.fullmatch(r'[a-f0-9]{64}', payload[k])
                       for k in ('root_instance', 'expected_revision') if k in payload):
                    raise ValueError('invalid precondition')
                if (not isinstance(family, str) or family not in FAMILIES or not isinstance(lane, str) or lane not in FAMILIES[family] or
                        not isinstance(program, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', program) or
                        ('fid' in payload and (not isinstance(payload['fid'], str) or not re.fullmatch(r'[A-Za-z][0-9]{2,}', payload['fid'])))):
                    raise ValueError('invalid fields')
                return payload
            except (ValueError, UnicodeError, json.JSONDecodeError):
                return self.reply(400, {'error': 'invalid_ledger_action'})

        def hunter_args(self, program, family, lane, *args):
            return ['agents/manual_hunter.py', program, '--family', family, '--lane', lane, '--root', str(root), *args]

        def run_writer(self, argv, verify, refused=None, lane_path=None):
            """Run one BBH command, verify the read-back and reply.

            refused(result) may classify a non-zero exit that BBH documents as
            a no-op (for example a duplicate note); any other failure disables
            the writer because the update may be partial."""
            import subprocess
            try:
                result = subprocess.run([str(self.server.writer), *argv], capture_output=True, text=True,
                                        timeout=getattr(self.server, 'writer_timeout', 60))
                # The ledger may have changed (even after a failure): let Recent re-read it.
                search_index.touch()
                if result.returncode != 0:
                    outcome = refused(result) if refused else None
                    if outcome is not None:
                        return self.reply(*outcome)
                    self.server.writer_enabled = False
                    return self.reply(502, {'error': 'writer_failed', 'message': 'Update may be incomplete; refresh before retrying.'})
                outcome = verify(result)
                if outcome is None:
                    self.server.writer_enabled = False
                    return self.reply(502, {'error': 'verification_failed', 'message': 'Update may be incomplete; refresh before retrying.'})
                if outcome[0] == 200 and lane_path is not None:
                    outcome[1]['revisions'] = self.rebased_revisions(lane_path)
                return self.reply(*outcome)
            except (OSError, subprocess.SubprocessError):
                self.server.writer_enabled = False
                return self.reply(503, {'error': 'writer_unavailable', 'message': 'Update may be incomplete; refresh before retrying.'})

        def set_submission(self):
            """Record local submission state via BBH --set-submission.

            This only edits the ledger entry; nothing is sent to any platform."""
            import re
            payload = self.ledger_action_payload({'fid', 'expected_revision', 'submission'}, 'submission')
            if not payload:
                return
            submission = payload['submission']
            if isinstance(submission, dict) and isinstance(submission.get('report'), str):
                # BBH stores the stripped value; compare against the same.
                submission = {**submission, 'report': submission['report'].strip()}
            if (not isinstance(submission, dict) or not submission.get('state') or set(submission) - {'state', 'result', 'report'} or
                    submission['state'] not in SUBMISSION_STATES or
                    submission.get('result') not in (None, *SUBMISSION_RESULTS) or
                    not (submission.get('report') is None or (isinstance(submission['report'], str) and
                         re.fullmatch(LINE_CHAR + r'{1,200}', submission['report'])))):
                return self.reply(400, {'error': 'invalid_ledger_action'})
            family, program, lane, fid = (payload[k] for k in ('family', 'program', 'lane', 'fid'))
            checked = self.finding_precheck(family, program, lane, fid, payload['root_instance'], payload['expected_revision'])
            if not checked:
                return
            lane_path = checked[0]
            args = ['--set-submission', fid, '--submission-state', submission['state']]
            if submission.get('result'):
                args += ['--submission-result', submission['result']]
            if submission.get('report'):
                # One argument, so a value starting with '-' is not read as an option.
                args += [f"--submission-report={submission['report']}"]

            def verify(_result):
                updated = [f for f in ledger(lane_path, []) or [] if f.get('fid') == fid]
                recorded = updated[0].get('submission') if len(updated) == 1 else None
                if not isinstance(recorded, dict) or any(recorded.get(k) != v for k, v in submission.items() if v is not None):
                    return None
                return 200, {'finding': updated[0]}
            return self.run_writer(self.hunter_args(program, family, lane, *args), verify, lane_path=lane_path)

        def add_finding(self):
            """Add one finding through BBH --from-file using a generated note."""
            import re
            import tempfile
            payload = self.ledger_action_payload({'finding'}, 'add_finding')
            if not payload:
                return
            finding = payload['finding']
            line = LINE_CHAR
            if (not isinstance(finding, dict) or set(finding) != {'title', 'class_name', 'severity', 'file', 'description'} or
                    any(not isinstance(v, str) for v in finding.values()) or
                    not re.fullmatch(line + r'{3,200}', finding['title'].strip()) or
                    not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,99}', finding['class_name']) or
                    finding['severity'] not in SEVERITIES or
                    not re.fullmatch(line + r'{1,300}', finding['file'].strip()) or
                    not re.fullmatch(line + r'{1,2000}', finding['description'].strip())):
                return self.reply(400, {'error': 'invalid_ledger_action'})
            family, program, lane = (payload[k] for k in ('family', 'program', 'lane'))
            checked = self.finding_precheck(family, program, lane, '', payload['root_instance'], None)
            if not checked:
                return
            lane_path = checked[0]
            ledger_path = lane_path / 'ledgers/ledger.json'
            try:
                original = ledger_path.read_bytes()
            except OSError:
                return self.reply(409, {'error': 'unsafe_writer_tree'})
            known = {f.get('fid') for f in ledger(lane_path, []) or []}
            title = finding['title'].strip()
            note = ''.join(f'{label}: {value.strip()}\n' for label, value in (
                ('Title', title), ('Class', finding['class_name']), ('Severity', finding['severity']),
                ('File', finding['file']), ('Description', finding['description'])))

            def verify(_result):
                added = [f for f in ledger(lane_path, []) or [] if f.get('fid') not in known]
                if len(added) != 1 or added[0].get('title') != title or added[0].get('class_name') != finding['class_name']:
                    return None
                return 200, {'finding': added[0]}

            def refused(result):
                # BBH prints "Duplicate: <fid>", writes nothing and exits 1.
                try:
                    unchanged = ledger_path.read_bytes() == original
                except OSError:
                    unchanged = False
                if result.returncode == 1 and 'Duplicate:' in (result.stdout or '') and unchanged:
                    return 409, {'error': 'not_added', 'message': 'BBH did not add a new finding: it matches an existing one.'}
                return None
            with tempfile.TemporaryDirectory(prefix='bounty-board-') as temp:
                notefile = Path(temp) / 'board-note.md'
                notefile.write_text(note, encoding='utf-8')
                return self.run_writer(self.hunter_args(program, family, lane, '--from-file', str(notefile)), verify, refused, lane_path=lane_path)

        def reclassify_finding(self):
            """Copy a finding into MapStore (optionally as a gadget) via BBH.

            Step 1 runs ``agents/map_store.py write``; step 2 runs
            ``manual_hunter --edit-finding`` to append a provenance note (and
            optionally set status ``archive``) on the original finding. The
            finding, its evidence and report files are never removed."""
            import re
            import tempfile
            from datetime import datetime, timezone
            payload = self.ledger_action_payload({'fid', 'expected_revision', 'destination', 'details'}, 'reclassify')
            if not payload:
                return
            line = LINE_CHAR
            destination, details = payload['destination'], payload['details']
            try:
                if destination not in ('gadgets', 'map') or not isinstance(details, dict):
                    raise ValueError('invalid destination')
                allowed = {'title', 'surface', 'note', 'tags', 'archive_original'} | ({'tier', 'capability'} if destination == 'gadgets' else set())
                if set(details) - allowed or not {'title', 'surface'} <= set(details):
                    raise ValueError('invalid details')
                title, surface = details['title'], details['surface']
                note, tags = details.get('note', ''), details.get('tags', [])
                archive = details.get('archive_original', False)
                if (not isinstance(title, str) or not re.fullmatch(line + r'{3,200}', title.strip()) or
                        not isinstance(surface, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', surface) or
                        not isinstance(note, str) or not re.fullmatch(r'[^\x00-\x09\x0b-\x1f\x7f]{0,4000}', note) or
                        not isinstance(tags, list) or len(tags) > 8 or
                        any(not isinstance(t, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,40}', t) for t in tags) or
                        {'gadget', 'residual'} & set(tags) or any(t.startswith('finding-') for t in tags) or
                        type(archive) is not bool):
                    raise ValueError('invalid details')
                capability = []
                if destination == 'gadgets':
                    tier, cap = details.get('tier'), details.get('capability')
                    fields = ['grants', 'requires', 'crosses', 'crosses_detail', 'chain_status', 'chain_watch']
                    residual_fields = ['residual_class', 'disclosed_by', 'composes_with']
                    if tier not in ('confirmed', 'residual') or not isinstance(cap, dict):
                        raise ValueError('invalid gadget')
                    expected = fields + (residual_fields if tier == 'residual' else [])
                    if set(cap) - set(expected) or any(not isinstance(v, str) or not re.fullmatch(line + r'{0,300}', v) for v in cap.values()):
                        raise ValueError('invalid capability')
                    required = ['grants', 'requires', 'crosses', 'chain_status'] + (residual_fields if tier == 'residual' else [])
                    if any(not cap.get(k, '').strip() for k in required):
                        raise ValueError('missing capability')
                    if cap['chain_status'] not in GADGET_CHAIN_STATUSES or (tier == 'residual' and cap['residual_class'] not in RESIDUAL_CLASSES):
                        raise ValueError('invalid capability value')
                    capability = [(k, cap[k].strip()) for k in expected if cap.get(k, '').strip()]
            except (ValueError, KeyError, TypeError):
                return self.reply(400, {'error': 'invalid_ledger_action'})
            family, program, lane, fid = (payload[k] for k in ('family', 'program', 'lane', 'fid'))
            checked = self.finding_precheck(family, program, lane, fid, payload['root_instance'], payload['expected_revision'])
            if not checked:
                return
            lane_path, finding = checked
            maps = lane_path / 'recon/maps'
            if maps.is_symlink() or (maps.exists() and not maps.is_dir()):
                return self.reply(409, {'error': 'unsafe_writer_tree'})
            warnings = []
            before = map_entries(lane_path, warnings) or []
            if 'map_unavailable_or_invalid' in warnings:
                return self.reply(409, {'error': 'unsafe_writer_tree'})
            marker = f'finding-{fid.lower()}'
            now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
            created = {}
            existing = [entry for entry in before if marker in (entry.get('tags') or [])]
            if existing:
                # A move whose second step (annotating the finding) did not
                # happen is finished instead of refused. Anything else is a
                # real duplicate.
                raw = self.raw_finding(lane_path, fid)
                notes = raw.get('review_notes') if isinstance(raw, dict) and isinstance(raw.get('review_notes'), str) else ''
                entry = existing[0]
                kind = 'gadgets' if 'gadget' in (entry.get('tags') or []) else 'map'
                if len(existing) != 1 or kind != destination or not entry.get('path') or f'recon/maps/{entry["path"]}' in notes:
                    return self.reply(409, {'error': 'already_reclassified', 'message': 'A MapStore entry for this finding already exists. Refresh and review it.'})
                created.update(entry)
            if not created:  # step 1: create the MapStore entry
                store_tags = (['gadget'] + (['residual'] if details.get('tier') == 'residual' else []) if destination == 'gadgets' else []) + [marker, 'from-ledger', *tags]

                def lane_relative(value):
                    if not isinstance(value, str) or not value:
                        return 'Not recorded'
                    try:
                        return Path(value).relative_to(lane_path).as_posix() if Path(value).is_absolute() else value
                    except ValueError:
                        return value
                body = '\n'.join([
                    f'## Reclassified from ledger finding {fid}', '',
                    f'- Source finding: {fid} ({family}/{program}/{lane})',
                    f'- Finding title: {finding.get("title") or "Not recorded"}',
                    f'- Finding class: {finding.get("class_name") or "Not recorded"}',
                    f'- Severity as recorded on the finding: {finding.get("severity") or "Not recorded"}',
                    f'- Evidence: {lane_relative(finding.get("evidence_path"))}',
                    f'- Report: {lane_relative(finding.get("report_path") or finding.get("report_dir"))}',
                    f'- Reclassified by: bounty-board at {now}', '',
                    'The original ledger entry, its evidence and its report files are kept.', '',
                    *([note.strip(), ''] if note.strip() else []),
                    *(['Capability:', *[f'- {k}: {v}' for k, v in capability], ''] if capability else []),
                ])
                run_id = f'board-{fid.lower()}-{now.replace("-", "").replace(":", "").lower()}'
                store_argv = ['agents/map_store.py', 'write', '--program', program, '--family', family, '--lane', lane,
                              '--root', str(root), '--surface', surface, '--scope', 'surface', '--tags', ','.join(store_tags),
                              f'--title={title.strip()}', '--agent', 'bounty-board', '--run-id', run_id]

                def verify_store(_result):
                    after = map_entries(lane_path, []) or []
                    known = {entry.get('path') for entry in before}
                    added = [entry for entry in after if entry.get('path') not in known]
                    if (len(after) != len(before) + 1 or len(added) != 1 or added[0].get('title') != title.strip() or
                            not {marker, *(['gadget'] if destination == 'gadgets' else [])} <= set(added[0].get('tags') or []) or
                            (destination == 'map' and 'gadget' in (added[0].get('tags') or []))):
                        return None
                    created.update(added[0])
                    return 200, {}
                with tempfile.TemporaryDirectory(prefix='bounty-board-') as temp:
                    bodyfile = Path(temp) / 'board-observation.md'
                    bodyfile.write_text(body, encoding='utf-8')
                    import subprocess
                    try:
                        result = subprocess.run([str(self.server.writer), *store_argv, '--body-file', str(bodyfile)],
                                                capture_output=True, text=True, timeout=60)
                    except (OSError, subprocess.SubprocessError):
                        self.server.writer_enabled = False
                        return self.reply(503, {'error': 'writer_unavailable', 'message': 'Update may be incomplete; refresh before retrying.'})
                if result.returncode != 0 or verify_store(result) is None:
                    self.server.writer_enabled = False
                    return self.reply(502, {'error': 'writer_failed' if result.returncode else 'verification_failed',
                                            'message': 'MapStore update may be incomplete; refresh and review before retrying.'})
            # Step 2: annotate the original finding. Refuse if it changed meanwhile.
            current = [f for f in ledger(lane_path, []) or [] if f.get('fid') == fid]
            entry_path = f'recon/maps/{created["path"]}'
            store_name = 'Gadgets' if destination == 'gadgets' else 'MapStore'
            if len(current) != 1 or current[0]['metadata_revision'] != finding['metadata_revision']:
                return self.reply(409, {'error': 'partial_reclassify', 'map_entry': created,
                                        'message': f'Created {store_name} entry {entry_path}, but the finding changed, so it was not annotated. Refresh and review.'})
            raw = self.raw_finding(lane_path, fid)
            previous = raw.get('review_notes') if isinstance(raw, dict) and isinstance(raw.get('review_notes'), str) else ''
            appended = f'Reclassified to {store_name} on {now[:10]} by Bounty Board: {entry_path}. Ledger entry and evidence kept.'
            patch = {'review_notes': f'{previous.rstrip()}\n\n{appended}' if previous.strip() else appended}
            if archive:
                patch['status'] = 'archive'

            def verify_finding(_result):
                updated = [f for f in ledger(lane_path, []) or [] if f.get('fid') == fid]
                notes = self.raw_finding(lane_path, fid)
                if (len(updated) != 1 or not isinstance(notes, dict) or notes.get('review_notes') != patch['review_notes'] or
                        (archive and updated[0].get('status') != 'archive')):
                    return None
                return 200, {'finding': updated[0], 'map_entry': created}
            with tempfile.TemporaryDirectory(prefix='bounty-board-') as temp:
                patchfile = Path(temp) / 'patch.json'
                patchfile.write_text(json.dumps(patch), encoding='utf-8')
                return self.run_writer(self.hunter_args(program, family, lane, '--edit-finding', fid, '--patch-file', str(patchfile)), verify_finding, lane_path=lane_path)

        def recon_mark(self):
            """POST /api/recon/mark: record one URL review through BBH url_ingest.py mark.

            BBH resolves its database as $HOME/Shared/web_bounty/<program>/web/recon/
            url_index/url_index.sqlite (no root option). The Board runs it only when
            that file is the same file (device and inode) as the one this view read,
            and only for a URL id that is in the index with exactly the URL the
            client saw; it verifies the new test run afterwards. BBH has no delete."""
            import re
            import recon_intel as ri
            if (not self.trusted_request(require_origin=True) or
                self.headers.get('X-Requested-With') != 'Bounty-Board' or
                self.headers.get('Content-Type', '').lower() != 'application/json' or
                self.headers.get('Transfer-Encoding')):
                return self.reply(403, {'error': 'untrusted_origin'})
            if not self.server.writer_enabled or 'url_mark' not in self.server.writer_features:
                return self.reply(503, {'error': 'writer_unavailable'})
            required = {'family', 'program', 'lane', 'root_instance', 'url_id', 'url', 'test_lane', 'status'}
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= 16384:
                    raise ValueError('invalid length')
                payload = json.loads(self.rfile.read(int(lengths[0])))
                if not isinstance(payload, dict) or not required <= set(payload) or set(payload) - required - {'param', 'param_location', 'notes'}:
                    raise ValueError('invalid payload')
                text_ok = lambda v, n: isinstance(v, str) and 0 < len(v) <= n and not ri.is_unsafe(v)
                if (payload['family'] != 'web_bounty' or not isinstance(payload['lane'], str) or payload['lane'] not in FAMILIES['web_bounty'] or
                        not isinstance(payload['program'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', payload['program']) or
                        not isinstance(payload['root_instance'], str) or not re.fullmatch(r'[a-f0-9]{64}', payload['root_instance']) or
                        type(payload['url_id']) is not int or payload['url_id'] < 1 or not text_ok(payload['url'], 2000) or
                        payload['test_lane'] not in BBH_LANES or payload['status'] not in MARK_STATUSES or
                        ('param' in payload and not text_ok(payload['param'], 120)) or
                        ('param_location' in payload and ('param' not in payload or payload['param_location'] not in MARK_LOCATIONS)) or
                        ('notes' in payload and not (text_ok(payload['notes'], 500) and re.fullmatch(LINE_CHAR + '+', payload['notes'])))):
                    raise ValueError('invalid fields')
            except (ValueError, UnicodeError, json.JSONDecodeError):
                return self.reply(400, {'error': 'invalid_recon_mark'})
            family, program, lane, url_id = (payload[k] for k in ('family', 'program', 'lane', 'url_id'))
            snapshot = root_snapshot()
            if not snapshot or payload['root_instance'] != snapshot[2]:
                return self.reply(409, {'error': 'root_changed'})
            if lane != 'web':
                return self.reply(409, {'error': 'mark_target_mismatch',
                                        'message': f'BBH url_ingest writes only the web lane; this view is the {lane} lane. Not marked.'})
            try:
                found = recon.url_index_path(family, program, lane)
            except ri.SourceError as error:
                return self.reply(409, {'error': 'url_index_unavailable', 'message': f'The URL index is not readable ({error.code}). Not marked.'})
            if found is None:
                return self.reply(404, {'error': 'recon_lane_not_found'})
            db = found[1]
            # Same file as BBH would open: HOME is passed to BBH unchanged.
            home = os.environ.get('HOME') or str(Path.home())
            target = Path(home) / 'Shared' / 'web_bounty' / program / 'web' / 'recon' / 'url_index' / 'url_index.sqlite'
            try:
                same = os.stat(target)[1:3] == os.stat(db)[1:3]
            except OSError:
                same = False
            if not same:
                return self.reply(409, {'error': 'mark_target_mismatch',
                                        'message': f'BBH would write {target}, but this view reads {db}. Not marked: the write would go to a different database.'})
            try:
                before = ri.raw_url(db, url_id, recon.budget)
            except (ri.SourceError, ri.QueryTimeout):
                return self.reply(409, {'error': 'url_index_unavailable', 'message': 'The URL index could not be read. Not marked.'})
            if before is None:
                return self.reply(404, {'error': 'url_not_found'})
            if before[0] != payload['url']:
                return self.reply(409, {'error': 'url_changed', 'message': 'This URL changed in the index. Refresh and try again.'})
            argv = ['agents/url_ingest.py', 'mark', program, f'--url={before[0]}', f"--lane={payload['test_lane']}",
                    f"--status={payload['status']}", '--agent-id=bounty-board']
            if 'param' in payload:
                argv += [f"--param={payload['param']}", f"--param-location={payload.get('param_location', 'query')}"]
            if 'notes' in payload:
                argv += [f"--notes={payload['notes']}"]

            def verify(_result):
                # A run newer than the pre-call maximum, made by the Board, with the requested
                # values. Agents may mark the same URL meanwhile; their runs do not count.
                try:
                    runs = ri.board_runs(db, url_id, before[2], 'bounty-board', recon.budget)
                except (ri.SourceError, ri.QueryTimeout):
                    return None
                wanted = (payload['test_lane'], payload['status'], payload.get('param', ''))
                if not any((run[1], run[2], run[3] or '') == wanted for run in runs):
                    return None
                recon.refresh_url_index(family, program, lane)
                history = ri.url_history(db, url_id, recon.budget)
                page = ri.list_urls(db, {}, url_id - 1, 1, recon.budget, 'asc')
                item = page['items'][0] if page['items'] and page['items'][0]['id'] == url_id else None
                if item is not None:
                    recon.annotate_urls(program, [item])  # scope from the cache only; marking is not scope-gated
                return 200, {'url': history, 'item': item}
            return self.run_writer(argv, verify)

        def delete_finding(self):
            """Permanently delete one archived finding via BBH --delete-finding.

            Archive is the only recoverable state; this step is permanent (BBH
            keeps a minimal tombstone and deletes the generated files; there is
            no restore). The Board refuses before invoking BBH unless the
            current status is archive and verifies afterwards that the FID is
            gone. BBH exit 1 means it refused before committing (stderr
            "[manual_hunter] <reason>", relayed as `reason`; the writer stays
            enabled when the ledger is unchanged). Exit 3 means deleted, but a
            later step warned ("Warning:" lines, relayed as `warning_text`).
            Exit 2 (usage) or anything else disables the writer."""
            payload = self.ledger_action_payload({'fid', 'expected_revision'}, 'delete')
            if not payload:
                return
            family, program, lane, fid = (payload[k] for k in ('family', 'program', 'lane', 'fid'))
            checked = self.finding_precheck(family, program, lane, fid, payload['root_instance'], payload['expected_revision'])
            if not checked:
                return
            lane_path, finding = checked
            if finding.get('status') != 'archive':
                return self.reply(409, {'error': 'not_archived', 'message': 'Only archived findings can be deleted. Archive it first.'})
            ledger_path = lane_path / 'ledgers/ledger.json'
            try:
                original = ledger_path.read_bytes()
            except OSError:
                return self.reply(409, {'error': 'unsafe_writer_tree'})

            def lines(text, marker):
                found = []
                for line in (text or '').splitlines():
                    line = line.strip()
                    if line.startswith(marker):
                        found.append(''.join(c for c in line[len(marker):].strip() if c.isprintable())[:300])
                return found[:5]

            def verify(_result):
                remaining = ledger(lane_path, [])
                if remaining is None or any(f.get('fid') == fid for f in remaining):
                    return None
                try:
                    if self.server.archive_state is not None:
                        self.server.archive_state.forget(family, program, lane, fid)
                except (OSError, ValueError, TypeError):
                    pass
                return 200, {'deleted': fid, 'warnings': False, 'warning_text': []}

            def refused(result):
                if result.returncode == 3:
                    outcome = verify(result)
                    if outcome is not None:
                        outcome[1].update(warnings=True, revisions=self.rebased_revisions(lane_path),
                                          warning_text=lines(f'{result.stderr or ""}\n{result.stdout or ""}', 'Warning:'))
                    return outcome
                try:
                    unchanged = ledger_path.read_bytes() == original
                except OSError:
                    unchanged = False
                if result.returncode == 1 and unchanged:
                    reason = (lines(result.stderr, '[manual_hunter]') or ['BBH refused to delete this finding.'])[0]
                    return 409, {'error': 'delete_refused', 'reason': reason, 'message': 'BBH refused; nothing was changed.'}
                return None
            actor = ['--actor', 'bounty-board'] if 'actor' in self.server.writer_features else []
            return self.run_writer(self.hunter_args(program, family, lane, '--delete-finding', fid, *actor), verify, refused, lane_path=lane_path)

        def track_archive(self, family, program, lane, fid, previous, status):
            """Remember the status a finding had when the Board archived it; forget it on restore.

            The ledger write already succeeded, so a state failure is reported, not raised."""
            import re
            store = self.server.archive_state
            if status is None or store is None:
                return {}
            archiving = status in ARCHIVE_STATUSES and previous not in ARCHIVE_STATUSES
            restoring = status not in ARCHIVE_STATUSES and previous in ARCHIVE_STATUSES
            try:
                if archiving and isinstance(previous, str) and re.fullmatch(STATUS_TOKEN, previous):
                    store.record(family, program, lane, fid, previous)
                    return {'archive_state': 'saved'}
                if archiving:
                    return {'archive_state': 'no_previous_status'}
                if restoring:
                    store.forget(family, program, lane, fid)
            except (OSError, ValueError, TypeError):
                return {'archive_state': 'unavailable'}
            return {}

        def report_na_request(self):
            """POST /api/report-na: mark or unmark one report file as N/A (Board-only state).

            Same trust checks as the ledger actions. Marking requires the report
            to exist as a regular file under the lane's reports/ with no
            symlinked component; unmarking skips that check so a stale mark on
            a moved or deleted file can be cleared."""
            import re
            if (not self.trusted_request(require_origin=True) or
                    self.headers.get_all('X-Requested-With', []) != ['Bounty-Board'] or
                    [x.lower() for x in self.headers.get_all('Content-Type', [])] != ['application/json'] or
                    self.headers.get('Transfer-Encoding')):
                return self.reply(403, {'error': 'untrusted_origin'})
            try:
                lengths = self.headers.get_all('Content-Length', [])
                if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= 4096:
                    raise ValueError('invalid length')
                payload = json.loads(self.rfile.read(int(lengths[0])))
                if not isinstance(payload, dict) or set(payload) != {'family', 'program', 'lane', 'path', 'na'}:
                    raise ValueError('invalid payload')
                family, program, lane, path, na = (payload[k] for k in ('family', 'program', 'lane', 'path', 'na'))
                if (not isinstance(family, str) or family not in FAMILIES or not isinstance(lane, str) or lane not in FAMILIES[family] or
                        not isinstance(program, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', program) or
                        type(na) is not bool or not isinstance(path, str) or
                        not re.fullmatch(LINE_CHAR + '{1,%d}' % ReportNaState.MAX_PATH, path) or '\\' in path or
                        not path.lower().endswith('.md') or any(p in ('', '.', '..') for p in path.split('/'))):
                    raise ValueError('invalid fields')
            except (ValueError, UnicodeError, json.JSONDecodeError):
                return self.reply(400, {'error': 'invalid_report_na'})
            if na and not self.regular_report(family, program, lane, path):
                return self.reply(404, {'error': 'report_not_found'})
            store = self.server.report_na
            if store is None:
                return self.reply(503, {'error': 'report_na_unavailable'})
            try:
                marked_at = store.set(family, program, lane, path, na)
            except OSError:
                return self.reply(503, {'error': 'report_na_unavailable'})
            return self.reply(200, {'path': path, 'na': na, 'marked_at': marked_at})

        def report_missing(self, family, program, lane, path):
            """True only when the report is certainly gone: a path component or
            the file does not exist, a component is not a directory or is a
            symlink, or the file is not a regular file. Any other error keeps
            the mark."""
            import errno
            import os
            import stat
            parts = [family, program, lane, 'reports', *path.split('/')]
            try:
                fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            except OSError:
                return False
            try:
                for part in parts[:-1]:
                    next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = next_fd
                file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    return not stat.S_ISREG(os.fstat(file_fd).st_mode)
                finally:
                    os.close(file_fd)
            except OSError as error:
                return error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)
            finally:
                os.close(fd)

        def regular_report(self, family, program, lane, path):
            """True when root/family/program/lane/reports/<path> is a regular file, never following a symlink."""
            import os
            import stat
            parts = [family, program, lane, 'reports', *path.split('/')]
            try:
                fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            except OSError:
                return False
            try:
                for part in parts[:-1]:
                    next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = next_fd
                file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    return stat.S_ISREG(os.fstat(file_fd).st_mode)
                finally:
                    os.close(file_fd)
            except OSError:
                return False
            finally:
                os.close(fd)

        def archive_state_request(self, url):
            """GET /api/archive-state: previous statuses the Board stored for archived findings in one lane."""
            import re
            try:
                params = parse_qs(url.query, keep_blank_values=True, strict_parsing=True, max_num_fields=4)
                if set(params) != {'family', 'program', 'lane'} or any(len(v) != 1 for v in params.values()):
                    raise ValueError('invalid parameters')
                family, program, lane = (params[k][0] for k in ('family', 'program', 'lane'))
                if (family not in FAMILIES or lane not in FAMILIES[family] or
                        not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', program)):
                    raise ValueError('invalid lane')
            except ValueError:
                return self.reply(400, {'error': 'invalid_archive_state_request'})
            store = self.server.archive_state
            if store is None:
                return self.reply(200, {'available': False, 'entries': {}})
            return self.reply(200, {'available': True, 'entries': store.lane(family, program, lane)})

        def rebased_revisions(self, lane_path):
            """Old->new revisions for entries this write left byte-for-byte unchanged.

            BBH replaces ledger.json atomically, so every revision changes even
            for untouched entries. A client may roll a row forward only if it
            holds exactly the pre-write revision; other changes stay conflicts."""
            before, after = getattr(self, 'pre_write', None) or {}, ledger_snapshot(lane_path)
            return {fid: [old[0], after[fid][0]] for fid, old in before.items()
                    if fid in after and after[fid][1] == old[1] and after[fid][0] != old[0]}

        def raw_finding(self, lane_path, fid):
            """Unprojected ledger entry (review_notes is not part of the board projection)."""
            try:
                raw = json.loads(read_file(lane_path, 'ledgers/ledger.json'))
                matches = [f for f in raw.get('findings', []) if isinstance(f, dict) and f.get('fid') == fid]
                return matches[0] if len(matches) == 1 else None
            except (OSError, ValueError, UnicodeError, AttributeError):
                return None

        def do_DELETE(self):
            self.do_PUT()

        def log_message(self, format, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.collaboration_slots = threading.BoundedSemaphore(4)
    server.live_streams = threading.BoundedSemaphore(32)
    server.live = live
    server.search_index = search_index
    server.recon = recon
    server.scope_inventory = scope_inventory
    # Artifact uploads (artifact_uploads.py): None unless --artifact-uploads.
    from artifact_uploads import Uploads
    server.artifact_uploads = Uploads() if artifact_uploads else None
    base_close = server.server_close

    # One close path: stop the live editing watcher and the search index
    # thread, then close the socket. Each step runs even if an earlier one fails.
    def server_close():
        try:
            if live is not None:
                live.close()
        finally:
            try:
                search_index.close()
            finally:
                try:
                    recon.close()
                finally:
                    base_close()
    server.server_close = server_close
    server.static_root = Path(__file__).parent / 'static'
    server.writer = Path(writer).absolute() if writer else None
    server.writer_enabled = bool(accept_uncoordinated_writes and writer_available(server.writer))
    server.writer_features = writer_features(server.writer) if server.writer_enabled else frozenset()
    # Private Board state (previous status of archived findings); never under the data root.
    server.archive_state = ArchiveState(state_dir) if state_dir is not None else None
    # Board-only N/A marks on report files; same private state directory.
    server.report_na = ReportNaState(state_dir) if state_dir is not None else None
    return server


def parse_config(argv=None):
    import tomllib
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, help='JSON or TOML configuration file')
    parser.add_argument('--root', type=Path, help='data root (overrides config)')
    parser.add_argument('--port', type=int, help='listen port (overrides config)')
    parser.add_argument('--tailnet-host', help='exact canonical Tailscale Serve DNS hostname (overrides config)')
    parser.add_argument('--tailnet-port', type=int,
                        help='HTTPS port Tailscale Serve listens on for --tailnet-host (default 443; overrides config)')
    parser.add_argument('--bbh', type=Path, help='opt in to metadata writes with this BBH executable')
    parser.add_argument('--accept-uncoordinated-writes', action='store_true',
                        help='accept metadata write risk: concurrent edits can be overwritten; no shared compare-and-swap')
    parser.add_argument('--collaboration-dir', type=Path, help='opt in to experimental private shared draft storage')
    parser.add_argument('--collaboration-max-bytes', type=int, help='maximum SQLite database size in bytes (default 512 MiB; minimum 65536)')
    parser.add_argument('--experimental-fixture-publish', action='store_true', help='dangerous test-only source writes, restricted to TMPDIR')
    parser.add_argument('--report-autosave', action='store_true', help='opt in to experimental source publication; external writers and sync can race')
    parser.add_argument('--live-edit', action='store_true',
                        help='edit reports in the Board: autosave to Markdown, merge outside changes, push updates live')
    parser.add_argument('--live-edit-dir', type=Path, default=Path.home() / '.local/state/bounty-board/live-edit',
                        help='private history directory for --live-edit (outside the data root)')
    parser.add_argument('--terminal-url', help='same-origin path of the sandbox terminal service, e.g. /terminal/ '
                        '(shows the terminal drawer; see docs/integrations/sandbox-terminal.md)')
    from report_publisher import DEFAULT_MAX_OPERATIONS, DEFAULT_MIN_FREE_BYTES
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/bounty-board',
                        help='private Board state directory, for example the previous status of archived findings (outside the data root)')
    parser.add_argument('--retention-max-operations', type=int, default=DEFAULT_MAX_OPERATIONS,
                        help='maximum retained publication entries (default 1000)')
    parser.add_argument('--retention-min-free-bytes', type=int, default=DEFAULT_MIN_FREE_BYTES,
                        help='free-space floor in bytes (default 1073741824)')
    parser.add_argument('--artifact-uploads', action='store_true',
                        help='opt in to uploading files from the artifacts panel into report folders under the data root, '
                        'and deleting non-Markdown files there (Syncthing distributes both); '
                        'see docs/integrations/artifact-uploads.md')
    parser.add_argument('--artifact-root', type=Path,
                        help='bulk artifact tier holding JS libraries (default: /mnt/bounty when it is a mount point)')
    parser.add_argument('--recon-query-budget', type=float, default=None,
                        help='seconds one recon intel SQLite query may run before it is interrupted (default 3)')
    args = parser.parse_args(argv)
    settings = {}
    if args.config:
        try:
            raw = args.config.read_bytes()
            if args.config.suffix.lower() == '.json':
                settings = json.loads(raw)
            elif args.config.suffix.lower() == '.toml':
                settings = tomllib.loads(raw.decode('utf-8'))
            else:
                raise ValueError('expected .json or .toml')
            if not isinstance(settings, dict) or set(settings) - {'root', 'port', 'tailnet_host', 'tailnet_port'}:
                raise ValueError('expected only root, port, tailnet_host and tailnet_port keys')
            if 'root' in settings and (not isinstance(settings['root'], str) or not settings['root']):
                raise ValueError('root must be a non-empty string')
            if 'port' in settings and (type(settings['port']) is not int or not 1 <= settings['port'] <= 65535):
                raise ValueError('port must be an integer from 1 to 65535')
            if 'tailnet_host' in settings and not valid_tailnet_host(settings['tailnet_host']):
                raise ValueError('tailnet_host must be a canonical lowercase node.tailnet.ts.net hostname')
            if 'tailnet_port' in settings and (type(settings['tailnet_port']) is not int or not 1 <= settings['tailnet_port'] <= 65535):
                raise ValueError('tailnet_port must be an integer from 1 to 65535')
        except (OSError, ValueError, UnicodeError) as exc:
            parser.error(f'invalid config: {exc}')
    if args.root is None:
        args.root = Path(settings.get('root', str(Path.home() / 'Shared'))).expanduser()
        if args.config and 'root' in settings and not args.root.is_absolute():
            args.root = args.config.absolute().parent / args.root
    args.port = args.port if args.port is not None else settings.get('port', 9001)
    args.tailnet_host = args.tailnet_host if args.tailnet_host is not None else settings.get('tailnet_host')
    if args.tailnet_host is not None and not valid_tailnet_host(args.tailnet_host):
        parser.error('tailnet host must be a canonical lowercase node.tailnet.ts.net hostname')
    args.tailnet_port = args.tailnet_port if args.tailnet_port is not None else settings.get('tailnet_port', 443)
    if not 1 <= args.tailnet_port <= 65535:
        parser.error('tailnet port must be from 1 to 65535')
    if args.tailnet_port != 443 and args.tailnet_host is None:
        parser.error('--tailnet-port needs a tailnet host')
    if not 1 <= args.port <= 65535:
        parser.error('port must be from 1 to 65535')
    if args.collaboration_max_bytes is not None and args.collaboration_max_bytes < 65536:
        parser.error('collaboration max bytes must be at least 65536')
    if args.retention_max_operations < 1 or args.retention_min_free_bytes < 0:
        parser.error('retention operations must be positive and free-space floor non-negative')
    if args.terminal_url is not None and not valid_terminal_url(args.terminal_url):
        parser.error('--terminal-url must be a same-origin path such as /terminal/')
    if args.live_edit and (args.collaboration_dir or args.report_autosave or args.experimental_fixture_publish):
        parser.error('--live-edit replaces --collaboration-dir, --report-autosave and --experimental-fixture-publish')
    if args.recon_query_budget is not None and not 0.1 <= args.recon_query_budget <= 120:
        parser.error('recon query budget must be from 0.1 to 120 seconds')
    if args.artifact_root is None:
        from recon_intel import default_artifact_root
        args.artifact_root = default_artifact_root()
    return args


def main():
    from report_publisher import DEFAULT_MAX_OPERATIONS, DEFAULT_MIN_FREE_BYTES
    args = parse_config()
    make_server(args.root, args.port, writer=args.bbh,
                accept_uncoordinated_writes=args.accept_uncoordinated_writes,
                tailnet_host=args.tailnet_host, collaboration_dir=args.collaboration_dir,
                **({} if args.tailnet_port == 443 else {'tailnet_port': args.tailnet_port}),
                experimental_fixture_publish=args.experimental_fixture_publish,
                **({} if args.retention_max_operations == DEFAULT_MAX_OPERATIONS else {'retention_max_operations': args.retention_max_operations}),
                **({} if args.retention_min_free_bytes == DEFAULT_MIN_FREE_BYTES else {'retention_min_free_bytes': args.retention_min_free_bytes}),
                **({'report_autosave': True} if args.report_autosave else {}),
                **({'live_edit_dir': args.live_edit_dir} if args.live_edit else {}),
                state_dir=args.state_dir,
                **({'terminal_url': args.terminal_url} if args.terminal_url else {}),
                **({} if args.artifact_root is None else {'artifact_root': args.artifact_root}),
                **({} if args.recon_query_budget is None else {'recon_query_budget': args.recon_query_budget}),
                **({'artifact_uploads': True} if args.artifact_uploads else {}),
                **({} if args.collaboration_max_bytes is None else {'collaboration_max_bytes': args.collaboration_max_bytes})).serve_forever()


if __name__ == '__main__':
    main()
