"""Local, read-only Bounty Board server."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

FAMILIES = {'web_bounty': {'web', 'api'}, 'binaries': {'apk', 'exe', 'mac'}}
SEVERITIES = ('EXCEPTIONAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN')
STATUSES = ('raw', 'confirmed', 'dormant', 'novel', 'complete', 'archive')
METADATA_WRITE_WARNING = ('Uncoordinated metadata writes can overwrite concurrent edits, including edits '
                          'on other hosts or from sync clients; no shared compare-and-swap exists. '
                          'Stop other writers before editing.')


def read_file(root, relative):
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
            if not stat.S_ISREG(os.fstat(file_fd).st_mode):
                raise ValueError('not a regular file')
            with os.fdopen(file_fd, 'rb') as stream:
                file_fd = -1
                data = stream.read(5_000_001)
            if len(data) > 5_000_000:
                raise ValueError('file too large')
            return data
        finally:
            if file_fd != -1:
                os.close(file_fd)
    finally:
        os.close(fd)


def ledger(lane, warnings):
    try:
        raw = json.loads(read_file(lane, 'ledgers/ledger.json'))
        if not isinstance(raw, dict) or not isinstance(raw.get('findings'), list):
            raise ValueError('unsupported ledger shape')
        if any(not isinstance(entry, dict) for entry in raw['findings']):
            raise ValueError('unsupported finding shape')
        fields = ('fid', 'type', 'title', 'class_name', 'severity', 'status',
                  'review_tier', 'submission', 'submission_status', 'platform_outcome', 'file',
                  'severity_rationale', 'report_path', 'evidence_path', 'report_dir', 'current')
        return [{**{field: entry.get(field) for field in fields},
                 'status': entry.get('status') or (entry['current'].get('status') if isinstance(entry.get('current'), dict) else None),
                 'title': entry.get('title') or entry.get('type')} for entry in raw['findings']]
    except FileNotFoundError:
        warnings.append('ledger_missing')
    except (OSError, ValueError, UnicodeError):
        warnings.append('ledger_unavailable_or_invalid')
    return None


def map_entries(lane, warnings):
    try:
        raw = read_file(lane, 'recon/maps/map.jsonl').decode('utf-8')
        entries = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if any(not isinstance(item, dict) or not isinstance(item.get('tags', []), list) for item in entries):
            raise ValueError('unsupported map shape')
        fields = ('title', 'url', 'surface', 'scope', 'status', 'path', 'tags', 'timestamp')
        return [{key: item.get(key) for key in fields} for item in entries]
    except FileNotFoundError:
        warnings.append('map_missing')
    except (OSError, ValueError, UnicodeError):
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
            rows = db.execute('''SELECT s.id, s.kind, s.host, s.surface_key, s.input_key,
                s.consumer, s.fingerprint, s.run_id, a.class_name, a.status, a.pressure,
                a.reason, a.boundary, a.axes_json, a.evidence_json, a.reopen_when,
                a.assessed_fingerprint FROM assessments a JOIN surfaces s ON s.id=a.surface_id''').fetchall()
            kinds = {row['kind']: row['n'] for row in db.execute('SELECT kind, COUNT(*) AS n FROM surfaces GROUP BY kind')}
            unclassified = db.execute('SELECT COUNT(*) FROM surfaces s WHERE NOT EXISTS (SELECT 1 FROM assessments a WHERE a.surface_id=s.id)').fetchone()[0]
        finally:
            db.close()
        counts = {}
        items = []
        for row in rows:
            item = dict(row)
            item['surface_id'] = item.pop('id')
            item['axes'] = json.loads(item.pop('axes_json'))
            item['evidence_refs'] = json.loads(item.pop('evidence_json'))
            status = {'untested': 'no_assessment', 'exhausted': 'bounded_review'}.get(item['status'], item['status'])
            baseline = item['fingerprint'] or '@mapper-run:' + item['run_id']
            if status != 'no_assessment' and item['assessed_fingerprint'] and item['assessed_fingerprint'] != baseline:
                item['prior_status'] = status
                status = 'stale'
            item['status'] = status
            counts[status] = counts.get(status, 0) + 1
            items.append(item)
        return {'counts': counts, 'items': items, 'total': len(items),
                'mapped_kinds': kinds, 'unclassified_surfaces': unclassified}
    except FileNotFoundError:
        warnings.append('coverage_missing')
    except (OSError, ValueError, UnicodeError, sqlite3.Error):
        warnings.append('coverage_unavailable_or_invalid')
    return None


def reports(lane, warnings, findings=None):
    import os
    base = lane / 'reports'
    if not base.exists():
        warnings.append('reports_missing')
        return None
    if base.is_symlink() or not base.is_dir():
        warnings.append('reports_unavailable_or_invalid')
        return None
    items = []
    def onerror(_error):
        warnings.append('reports_unavailable_or_invalid')
    for directory, dirs, files in os.walk(base, followlinks=False, onerror=onerror):
        dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            file = Path(directory) / name
            if file.suffix.lower() == '.md' and not file.is_symlink():
                rel = file.relative_to(base).as_posix()
                owners = {'report_path': [], 'evidence_path': []}
                for finding in findings or []:
                    for field in owners:
                        recorded = finding.get(field)
                        if not isinstance(recorded, str) or not recorded:
                            continue
                        candidate = Path(recorded)
                        if not candidate.is_absolute():
                            candidate = lane / candidate
                        if candidate == file.absolute() and finding.get('fid'):
                            owners[field].append(finding['fid'])
                try:
                    text = read_file(lane, 'reports/' + rel).decode('utf-8')
                except (OSError, ValueError, UnicodeError):
                    text = None
                    if 'report_content_unavailable_or_invalid' not in warnings:
                        warnings.append('report_content_unavailable_or_invalid')
                if owners['report_path']:
                    kind = 'registered_report'
                    fids = owners['report_path']
                elif owners['evidence_path']:
                    kind = 'generated_evidence'
                    fids = owners['evidence_path']
                elif text is None:
                    kind, fids = 'unknown', []
                elif any(marker in text for marker in ('<!-- generated: bounty-core-report-navigation -->', '<!-- generated: bounty-core-category-link-stub -->')):
                    kind, fids = 'generated_navigation', []
                elif '<!-- generated: bounty-core-finding-report -->' in text:
                    kind, fids = 'generated_report', []
                else:
                    kind, fids = ('unregistered' if findings is not None else 'unknown'), []
                items.append({'path': rel, 'name': name, 'kind': kind, 'owner_fids': fids, 'editable': False})
    return items


def discover(root):
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
                    findings = ledger(lane, warnings)
                    entries = map_entries(lane, warnings)
                    found.append({'name': lane.name, 'findings': findings, 'map': entries,
                                  'coverage': coverage(lane, warnings), 'reports': reports(lane, warnings, findings),
                                  'gadgets': [e for e in entries if 'gadget' in (e['tags'] or [])] if entries is not None else None,
                                  'warnings': warnings})
            if found:
                programs.append({'id': family + '/' + program.name, 'name': program.name,
                                 'family': family, 'lanes': found})
    return {'programs': programs, 'warnings': global_warnings}


class PortfolioCache:
    """One in-process scan at a time; no filesystem work under the lock."""
    def __init__(self, root):
        import threading
        self.root = root
        self.lock = threading.RLock()
        self.snapshot = None
        self.snapshot_root = None
        self.updated = None
        self.running = False
        self.error = None
        self.generation = 0
        self.started_once = False
        self.writers = 0

    def _start_locked(self):
        import threading
        self.running = True
        self.started_once = True
        generation = self.generation
        try:
            threading.Thread(target=self._scan, args=(generation,), daemon=True).start()
        except Exception:
            self.running = False
            self.error = 'Portfolio scan could not start. Retry refresh.'

    def _scan(self, generation):
        import hashlib
        import logging
        import os
        from datetime import datetime, timezone
        try:
            try:
                canonical = self.root.resolve(strict=True)
                before = canonical.stat()
                if not canonical.is_dir():
                    raise OSError('root is not a directory')
            except (OSError, RuntimeError):
                canonical = None
            if canonical is None:
                result = {'programs': [], 'warnings': ['root_unavailable'], 'root_identity': None}
            else:
                result = discover(canonical)
                try:
                    current = self.root.resolve(strict=True)
                    after = current.stat()
                    if current != canonical or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                        raise OSError('root changed during discovery')
                except (OSError, RuntimeError):
                    raise RuntimeError('Portfolio root changed during discovery')
                result['root_identity'] = hashlib.sha256(os.fsencode(str(canonical))).hexdigest()
            warnings = result.get('warnings', [])
            problem = ('Portfolio root unavailable.' if 'root_unavailable' in warnings else
                       'Portfolio discovery incomplete.' if 'discovery_incomplete' in warnings else None)
            with self.lock:
                if generation == self.generation:
                    if problem and self.snapshot is not None:
                        self.error = problem + ' Showing the previous snapshot.'
                    else:
                        if canonical is not None and not problem:
                            import secrets
                            result['source_token'] = secrets.token_urlsafe(32)
                        self.snapshot = result
                        self.snapshot_root = (canonical, before.st_dev, before.st_ino) if canonical is not None and not problem else None
                        self.updated = datetime.now(timezone.utc).isoformat()
                        self.error = problem
        except BaseException:
            logging.exception('Portfolio scan failed')
            with self.lock:
                if generation == self.generation:
                    self.error = 'Portfolio scan failed. Retry refresh.'
        finally:
            with self.lock:
                self.running = False
                if generation != self.generation and not self.writers:
                    self._start_locked()

    def verified_root(self, token):
        # Snapshot identity describes the completed scan, not the live path.
        with self.lock:
            if (self.running or self.writers or self.error or not self.snapshot_root or
                    not token or token != self.snapshot.get('source_token')):
                return None
            expected, generation = self.snapshot_root, self.generation
        try:
            current = self.root.resolve(strict=True)
            info = current.stat()
            if (current, info.st_dev, info.st_ino) != expected:
                return None
        except (OSError, RuntimeError):
            return None
        with self.lock:
            if (self.running or self.writers or self.error or self.generation != generation or
                    self.snapshot_root != expected):
                return None
        return current

    def begin_write(self, token, root):
        with self.lock:
            if (self.running or self.writers or self.error or not self.snapshot_root or
                    not self.snapshot or not token or token != self.snapshot.get('source_token') or
                    self.snapshot_root[0] != root):
                return False
            self.writers += 1
            self.generation += 1
            return True

    def write_root_current(self, root):
        with self.lock:
            expected = self.snapshot_root
        try:
            current = self.root.resolve(strict=True)
            info = current.stat()
            return bool(expected and current == root and (current, info.st_dev, info.st_ino) == expected)
        except (OSError, RuntimeError):
            return False

    def end_write(self):
        with self.lock:
            self.writers -= 1
            self.invalidate()

    def invalidate(self):
        with self.lock:
            self.generation += 1
            if not self.running and not self.writers:
                self._start_locked()

    def get(self, refresh=False):
        with self.lock:
            if not self.running and not self.writers and (refresh or not self.started_once):
                self._start_locked()
            busy = self.running or self.writers
            state = 'refreshing' if busy and self.snapshot is not None else 'loading' if busy else 'error' if self.error else 'ready'
            status = {'state': state, 'updated_at': self.updated, 'error': self.error}
            return (dict(self.snapshot) if self.snapshot is not None else {}), status


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


def valid_tailnet_host(host):
    import re
    label = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    return (isinstance(host, str) and len(host) <= 253 and
            re.fullmatch(fr'{label}\.{label}\.ts\.net', host) is not None)


def make_server(root, port=9001, writer=None, accept_uncoordinated_writes=False, tailnet_host=None):
    if tailnet_host is not None and not valid_tailnet_host(tailnet_host):
        raise ValueError('invalid canonical tailnet hostname')
    root = Path(root).absolute()
    class Handler(BaseHTTPRequestHandler):
        def trusted_request(self, require_origin=False):
            port = self.server.server_port
            hosts = self.headers.get_all('Host', [])
            origins = self.headers.get_all('Origin', [])
            sites = self.headers.get_all('Sec-Fetch-Site', [])
            if len(hosts) != 1 or len(origins) > 1 or len(sites) > 1:
                return False
            host = hosts[0]
            if host in {f'127.0.0.1:{port}', f'localhost:{port}'}:
                expected = f'http://{host}'
            elif tailnet_host and host in {tailnet_host, f'{tailnet_host}:443'}:
                expected = f'https://{tailnet_host}'
            else:
                return False
            if (require_origin and not origins) or (origins and origins[0] != expected):
                return False
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

        def do_GET(self):
            import hashlib
            if not self.trusted_request():
                self.reply(403, {'error': 'untrusted_origin'})
                return
            url = urlsplit(self.path)
            if url.path == '/api/data':
                result, portfolio = self.server.portfolio.get(refresh=self.headers.get('X-Portfolio-Refresh') == '1')
                result['portfolio'] = portfolio
                result['capabilities'] = {'finding_metadata': self.server.writer_enabled,
                                          'finding_fields': ['severity', 'class_name', 'status', 'severity_rationale'] if self.server.writer_enabled else [],
                                          'finding_options': {'severity': SEVERITIES, 'status': STATUSES} if self.server.writer_enabled else {},
                                          'finding_metadata_warning': METADATA_WRITE_WARNING,
                                          'report_edit': False}
                self.reply(200 if 'programs' in result else (202 if portfolio['state'] == 'loading' else 503), result)
                return
            if url.path == '/api/report':
                tokens = self.headers.get_all('X-Portfolio-Source', [])
                token = tokens[0] if len(tokens) == 1 else None
                report_root = self.server.portfolio.verified_root(token)
                if report_root is None:
                    return self.reply(409, {'error': 'source_unverified'})
                params = parse_qs(url.query, keep_blank_values=True)
                try:
                    if set(params) != {'family', 'program', 'lane', 'path'} or any(len(v) != 1 for v in params.values()):
                        raise ValueError()
                    family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
                    if family not in FAMILIES or lane not in FAMILIES[family] or not program or program.startswith('_') or '/' in program or program in ('.', '..'):
                        raise ValueError()
                    if path.startswith('/') or Path(path).suffix.lower() != '.md' or any(p in ('..', '.') for p in path.split('/')):
                        raise ValueError()
                    content = read_file(report_root, f'{family}/{program}/{lane}/reports/{path}')
                    if self.server.portfolio.verified_root(token) != report_root:
                        return self.reply(409, {'error': 'source_unverified'})
                    text = content.decode('utf-8')
                    revision = hashlib.sha256(content).hexdigest()
                    self.reply(200, {'content': text, 'revision': revision, 'editable': False}, {'ETag': '"' + revision + '"'})
                except (OSError, ValueError, UnicodeError):
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
                    self.end_headers()
                    self.wfile.write(data)
                except (OSError, ValueError):
                    self.reply(404, {'error': 'not_found'})
                return
            self.reply(404, {'error': 'not_found'})

        def do_PUT(self):
            self.reply(403, {'error': 'editing_disabled', 'message': 'Report writes are disabled; retain your draft.'})

        def do_POST(self):
            self.do_PUT()

        def do_PATCH(self):
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
                if not isinstance(payload, dict) or set(payload) != {'family', 'program', 'lane', 'fid', 'patch'}:
                    raise ValueError('invalid payload')
                family, program, lane, fid, patch = (payload[k] for k in ('family', 'program', 'lane', 'fid', 'patch'))
                if (not isinstance(family, str) or family not in FAMILIES or not isinstance(lane, str) or lane not in FAMILIES[family] or
                    not isinstance(program, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', program) or
                    not isinstance(fid, str) or not re.fullmatch(r'[A-Za-z][0-9]{2,}', fid) or
                    not isinstance(patch, dict) or not patch or set(patch) - {'severity', 'class_name', 'status', 'severity_rationale'} or
                    any(not isinstance(v, str) or len(v) > 4000 for v in patch.values())):
                    raise ValueError('invalid fields')
                if ('severity' in patch and patch['severity'] not in SEVERITIES or
                    'status' in patch and patch['status'] not in STATUSES or
                    'class_name' in patch and not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,99}', patch['class_name'])):
                    raise ValueError('invalid value')
            except (ValueError, UnicodeError, json.JSONDecodeError):
                return self.reply(400, {'error': 'invalid_finding_patch'})
            tokens = self.headers.get_all('X-Portfolio-Source', [])
            token = tokens[0] if len(tokens) == 1 else None
            root = self.server.portfolio.verified_root(token)
            if root is None or not self.server.portfolio.begin_write(token, root):
                return self.reply(409, {'error': 'source_unverified'})
            try:
                return self.write_finding(root, family, program, lane, fid, patch)
            finally:
                self.server.portfolio.end_write()

        def write_finding(self, root, family, program, lane, fid, patch):
            import os
            import subprocess
            import tempfile
            lane_path = root / family / program / lane
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
            findings = ledger(lane_path, [])
            matches = [f for f in findings or [] if isinstance(f.get('fid'), str) and f['fid'].upper() == fid.upper()]
            if len(matches) != 1 or matches[0]['fid'] != fid:
                return self.reply(404, {'error': 'finding_not_found'})
            try:
                if not self.server.portfolio.write_root_current(root):
                    return self.reply(409, {'error': 'source_unverified'})
                with tempfile.TemporaryDirectory(prefix='bounty-board-') as temp:
                    patchfile = Path(temp) / 'patch.json'
                    patchfile.write_text(json.dumps(patch), encoding='utf-8')
                    result = subprocess.run([str(self.server.writer), 'agents/manual_hunter.py', program,
                        '--family', family, '--lane', lane, '--root', str(root), '--edit-finding', fid,
                        '--patch-file', str(patchfile)], capture_output=True, timeout=60)
                if result.returncode != 0:
                    self.server.writer_enabled = False
                    return self.reply(502, {'error': 'writer_failed', 'message': 'Update may be incomplete; refresh before retrying.'})
                if not self.server.portfolio.write_root_current(root):
                    return self.reply(409, {'error': 'source_unverified', 'message': 'Update may be incomplete; refresh before retrying.'})
                updated = [f for f in ledger(lane_path, []) or [] if f.get('fid') == fid]
                if (len(updated) != 1 or any(updated[0].get(k) != v for k, v in patch.items()) or
                    ('status' in patch and isinstance(updated[0].get('current'), dict) and
                     updated[0]['current'].get('status') != patch['status'])):
                    self.server.writer_enabled = False
                    return self.reply(502, {'error': 'verification_failed', 'message': 'Update may be incomplete; refresh before retrying.'})
                return self.reply(200, {'finding': updated[0]})
            except (OSError, subprocess.SubprocessError):
                self.server.writer_enabled = False
                return self.reply(503, {'error': 'writer_unavailable', 'message': 'Update may be incomplete; refresh before retrying.'})

        def do_DELETE(self):
            self.do_PUT()

        def log_message(self, format, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.static_root = Path(__file__).parent / 'static'
    server.portfolio = PortfolioCache(root)
    server.writer = Path(writer).absolute() if writer else None
    server.writer_enabled = bool(accept_uncoordinated_writes and writer_available(server.writer))
    return server


def parse_config(argv=None):
    import tomllib
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, help='JSON or TOML configuration file')
    parser.add_argument('--root', type=Path, help='data root (overrides config)')
    parser.add_argument('--port', type=int, help='listen port (overrides config)')
    parser.add_argument('--tailnet-host', help='exact canonical Tailscale Serve DNS hostname (overrides config)')
    parser.add_argument('--bbh', type=Path, help='opt in to metadata writes with this BBH executable')
    parser.add_argument('--accept-uncoordinated-writes', action='store_true',
                        help='accept metadata write risk: concurrent edits can be overwritten; no shared compare-and-swap')
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
            if not isinstance(settings, dict) or set(settings) - {'root', 'port', 'tailnet_host'}:
                raise ValueError('expected only root, port and tailnet_host keys')
            if 'root' in settings and (not isinstance(settings['root'], str) or not settings['root']):
                raise ValueError('root must be a non-empty string')
            if 'port' in settings and (type(settings['port']) is not int or not 1 <= settings['port'] <= 65535):
                raise ValueError('port must be an integer from 1 to 65535')
            if 'tailnet_host' in settings and not valid_tailnet_host(settings['tailnet_host']):
                raise ValueError('tailnet_host must be a canonical lowercase node.tailnet.ts.net hostname')
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
    if not 1 <= args.port <= 65535:
        parser.error('port must be from 1 to 65535')
    return args


def main():
    args = parse_config()
    make_server(args.root, args.port, writer=args.bbh,
                accept_uncoordinated_writes=args.accept_uncoordinated_writes,
                tailnet_host=args.tailnet_host).serve_forever()


if __name__ == '__main__':
    main()
