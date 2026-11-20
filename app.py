"""Local, read-only Bounty Board server."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

FAMILIES = {'web_bounty': {'web', 'api'}, 'binaries': {'apk', 'exe', 'mac'}}


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
                  'review_tier', 'submission', 'submission_status', 'platform_outcome', 'file')
        return [{**{field: entry.get(field) for field in fields},
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


def reports(lane, warnings):
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
                items.append({'path': file.relative_to(base).as_posix(), 'name': name})
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
                                  'coverage': coverage(lane, warnings), 'reports': reports(lane, warnings),
                                  'gadgets': [e for e in entries if 'gadget' in (e['tags'] or [])] if entries is not None else None,
                                  'warnings': warnings})
            if found:
                programs.append({'id': family + '/' + program.name, 'name': program.name,
                                 'family': family, 'lanes': found})
    return {'programs': programs, 'warnings': global_warnings}


def make_server(root, port=9001):
    class Handler(BaseHTTPRequestHandler):
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
            port = self.server.server_port
            host = self.headers.get('Host', '')
            origin = self.headers.get('Origin')
            if (host not in {f'127.0.0.1:{port}', f'localhost:{port}'} or
                    (origin is not None and origin != f'http://{host}') or
                    self.headers.get('Sec-Fetch-Site', '') == 'cross-site'):
                self.reply(403, {'error': 'untrusted_origin'})
                return
            url = urlsplit(self.path)
            if url.path == '/api/data':
                self.reply(200, discover(Path(root)))
                return
            if url.path == '/api/report':
                params = parse_qs(url.query, keep_blank_values=True)
                try:
                    if set(params) != {'family', 'program', 'lane', 'path'} or any(len(v) != 1 for v in params.values()):
                        raise ValueError()
                    family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
                    if family not in FAMILIES or lane not in FAMILIES[family] or not program or program.startswith('_') or '/' in program or program in ('.', '..'):
                        raise ValueError()
                    if path.startswith('/') or Path(path).suffix.lower() != '.md' or any(p in ('..', '.') for p in path.split('/')):
                        raise ValueError()
                    content = read_file(Path(root), f'{family}/{program}/{lane}/reports/{path}')
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
            self.do_PUT()

        def do_DELETE(self):
            self.do_PUT()

        def log_message(self, format, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.static_root = Path(__file__).parent / 'static'
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path.home() / 'Shared')
    parser.add_argument('--port', type=int, default=9001)
    args = parser.parse_args()
    make_server(args.root, args.port).serve_forever()


if __name__ == '__main__':
    main()
