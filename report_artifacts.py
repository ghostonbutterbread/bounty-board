"""Report artifacts: list and safely serve files associated with one report.

Association rules (each listed file carries the reason(s) it matched):

1. ``report_folder`` -- the report lives in a dedicated folder. A folder is
   dedicated when an owning ledger finding's ``report_dir`` names it, or when it
   is a direct child of ``reports/`` that contains ``REPORT.md`` or
   ``EVIDENCE.md``. The lane's ``reports/`` root is never dedicated, and a folder
   that holds another finding's report, evidence or report_dir is treated as
   shared and skipped (so flat folders never leak sibling reports' files).
   Dot entries, ``_``-prefixed folders (metadata, archives, drafts),
   ``__pycache__`` and ``*.pyc`` are skipped; the report itself is omitted.
2. ``finding_field`` -- a path in an owning finding's artifact fields
   (``poc``, ``evidence``, ``artifacts``, ``attachments``, ``evidence_files``,
   ``files``) that resolves to a file (or a folder's files) inside the lane.
3. ``report_link`` -- a relative Markdown link or image target in the report
   that resolves inside the lane.

An owning finding is one whose ``report_path`` or ``evidence_path`` names the
report; failing that, one whose ``report_dir`` is the report's own folder. Absolute recorded paths are matched by their
``<family>/<program>/<lane>/`` segment so ledgers written on another host still
resolve. Everything is opened by walking directory descriptors with
``O_NOFOLLOW``: symlinks are never followed and only regular files are served.
"""
import json
import os
import re
import stat
from pathlib import PurePosixPath
from urllib.parse import unquote, quote

FOLDER_MARKERS = {'report.md', 'evidence.md'}
FIELD_NAMES = ('poc', 'evidence', 'artifacts', 'attachments', 'evidence_files', 'files')
MAX_DEPTH = 4
MAX_SCANNED = 2000
MAX_LISTED = 500
MAX_ZIP_BYTES = 512 * 1024 * 1024
CHUNK = 64 * 1024

CATEGORIES = {
    'video': {'.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi'},
    'audio': {'.mp3', '.m4a', '.wav', '.ogg', '.oga', '.flac'},
    'image': {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'},
    'code': {'.py', '.js', '.mjs', '.cjs', '.ts', '.html', '.htm', '.sh', '.c', '.h', '.go', '.rb', '.php',
             '.java', '.css', '.rs', '.ps1', '.xhtml'},
    'data': {'.json', '.jsonl', '.txt', '.csv', '.xml', '.yaml', '.yml', '.log', '.md', '.ini', '.toml'},
    'capture': {'.har', '.hdr', '.body', '.raw', '.pcap', '.pcapng', '.saz'},
    'archive': {'.zip', '.tar', '.gz', '.tgz', '.7z', '.xz', '.bz2'},
    'document': {'.pdf'},
}
# Inline previews: raster images and media only, with fixed types. SVG,
# HTML and scripts are never served inline.
INLINE_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
}
TEXT_PREVIEW = CATEGORIES['code'] | CATEGORIES['data'] | {'.svg'}
SENSITIVE_EXT = {'.har', '.env', '.hdr', '.body', '.raw', '.pcap', '.pcapng', '.saz', '.pem', '.key',
                 '.p12', '.pfx', '.jks', '.kdbx', '.cookie', '.cookies', '.netrc', '.npmrc', '.pgpass'}
# Name keywords apply to non-media files only: a screen recording named after
# the bug class (for example an auth bypass) should still preview.
SENSITIVE_NAME = re.compile(r'cookie|token|secret|credential|passw|session|bearer|jwt|apikey|api[_-]key|'
                            r'private[_-]?key|id_rsa|id_ed25519|(^|[._-])env([._-]|$)', re.I)


class ArtifactError(Exception):
    """Selector invalid or artifact unavailable; reported as not found."""


def category(name):
    ext = PurePosixPath(name).suffix.lower()
    for key, values in CATEGORIES.items():
        if ext in values:
            return key
    return 'other'


def sensitive(name):
    lower = name.lower()
    path = PurePosixPath(lower)
    # Dotfiles such as '.netrc' have no suffix; match the whole name too.
    if path.suffix in SENSITIVE_EXT or path.name in SENSITIVE_EXT:
        return True
    return category(lower) not in ('video', 'audio', 'image') and bool(SENSITIVE_NAME.search(lower))


def preview_kind(name, is_sensitive):
    if is_sensitive:
        return None
    ext = PurePosixPath(name).suffix.lower()
    if ext in INLINE_TYPES:
        return INLINE_TYPES[ext].split('/')[0]
    if ext in TEXT_PREVIEW:
        return 'text'
    return None


def content_disposition(kind, name):
    """RFC 6266/5987 header with an ASCII fallback and a UTF-8 filename*."""
    fallback = re.sub(r'[^A-Za-z0-9._-]', '_', name)[:150].strip('.') or 'artifact'
    return f'{kind}; filename="{fallback}"; filename*=UTF-8\'\'{quote(name, safe="")}'


def _clean_parts(relative):
    if not isinstance(relative, str) or not relative or '\0' in relative or relative.startswith('/') or '\\' in relative:
        raise ArtifactError('invalid path')
    parts = relative.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ArtifactError('invalid path')
    return parts


def _open_dir(dir_fd, parts):
    fd = os.dup(dir_fd)
    try:
        for part in parts:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_lane(root, family, program, lane):
    """Return a directory descriptor for the lane, refusing symlinked components."""
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        return _open_dir(root_fd, [family, program, lane])
    finally:
        os.close(root_fd)


def open_file(lane_fd, relative):
    """Open a lane-relative regular file without following symlinks."""
    parts = _clean_parts(relative)
    try:
        parent = _open_dir(lane_fd, parts[:-1])
    except OSError as error:
        raise ArtifactError('unavailable') from error
    try:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except OSError as error:
        raise ArtifactError('unavailable') from error
    finally:
        os.close(parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise ArtifactError('not a regular file')
    return fd, info


def _read_small(lane_fd, relative, limit=5_000_000):
    fd, info = open_file(lane_fd, relative)
    with os.fdopen(fd, 'rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ArtifactError('too large')
    return data


def _kind_at(lane_fd, relative):
    """'file', 'dir' or None for a lane-relative path (no symlinks followed)."""
    try:
        parts = _clean_parts(relative)
        parent = _open_dir(lane_fd, parts[:-1])
    except (ArtifactError, OSError):
        return None
    try:
        info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
    except OSError:
        return None
    finally:
        os.close(parent)
    return 'file' if stat.S_ISREG(info.st_mode) else 'dir' if stat.S_ISDIR(info.st_mode) else None


def _normalize(parts):
    out = []
    for part in parts:
        if part in ('', '.'):
            continue
        if part == '..':
            if not out:
                return None
            out.pop()
        else:
            out.append(part)
    return '/'.join(out) or None


def recorded_relative(value, family, program, lane):
    """Map a ledger-recorded path to a lane-relative path, or None."""
    if not isinstance(value, str) or not value.strip() or '\0' in value or '\n' in value:
        return None
    value = value.strip()
    if value.startswith('/'):
        marker = f'/{family}/{program}/{lane}/'
        index = value.rfind(marker)
        if index < 0:
            return None
        value = value[index + len(marker):]
    elif re.match(r'^[a-z][a-z0-9+.-]*:', value, re.I):
        return None
    if re.search(r'\s', value) and ('/' not in value or not re.fullmatch(r'[\w ./+@()-]+', value)):
        return None  # prose, not a path
    return _normalize(value.split('/'))


def _fields(finding):
    for field in FIELD_NAMES:
        value = finding.get(field)
        values = value if isinstance(value, list) else [value]
        for item in values[:50]:
            if isinstance(item, dict):
                item = item.get('path')
            if isinstance(item, str):
                yield field, item


LINK = re.compile(r'!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)')
REFERENCE = re.compile(r'^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))(?:\s+.*)?$', re.M)


def markdown_targets(text):
    seen = []
    for match in list(LINK.finditer(text)) + list(REFERENCE.finditer(text)):
        target = (match.group(1) or match.group(2)).strip()
        if re.match(r'^[a-z][a-z0-9+.-]*:', target, re.I) or target.startswith(('#', '//')):
            continue
        target = unquote(target.split('#', 1)[0].split('?', 1)[0])
        if target and target not in seen:
            seen.append(target)
    return seen[:200]


def _walk(lane_fd, folder, skip, out, budget):
    """Collect regular files under a lane-relative folder via descriptors."""
    def visit(fd, prefix, depth):
        try:
            entries = sorted(os.scandir(fd), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if budget[0] <= 0:
                return
            name = entry.name
            if name.startswith('.') or name == '__pycache__' or name.lower().endswith('.pyc'):
                continue
            relative = f'{prefix}/{name}'
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(info.st_mode):
                if name.startswith('_') or depth >= MAX_DEPTH:
                    continue
                try:
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except OSError:
                    continue
                try:
                    visit(child, relative, depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and relative not in skip:
                budget[0] -= 1
                out.append(relative)
    try:
        fd = _open_dir(lane_fd, folder.split('/'))
    except OSError:
        return
    try:
        visit(fd, folder, 0)
    finally:
        os.close(fd)


def associate(lane_fd, family, program, lane, report_path):
    """Return (artifacts, notes) for ``reports/<report_path>`` in the lane."""
    report_rel = 'reports/' + '/'.join(_clean_parts(report_path))
    if PurePosixPath(report_rel).suffix.lower() != '.md':
        raise ArtifactError('invalid report')
    text = _read_small(lane_fd, report_rel).decode('utf-8', errors='replace')
    findings = []
    try:
        ledger = json.loads(_read_small(lane_fd, 'ledgers/ledger.json'))
        if isinstance(ledger, dict) and isinstance(ledger.get('findings'), list):
            findings = [f for f in ledger['findings'] if isinstance(f, dict)]
    except (ArtifactError, ValueError, UnicodeError):
        pass

    def rel(value):
        return recorded_relative(value, family, program, lane)

    report_dir = report_rel.rsplit('/', 1)[0]
    owners = [f for f in findings if report_rel in (rel(f.get('report_path')), rel(f.get('evidence_path')))]
    if not owners:
        # An unregistered Markdown file (a submission draft, notes) inside a
        # finding's own report_dir belongs to that finding's folder.
        owners = [f for f in findings if report_dir != 'reports' and rel(f.get('report_dir')) == report_dir]
    owner_ids = {id(f) for f in owners}
    reasons = {}
    notes = []

    def add(relative, reason, detail):
        if relative == report_rel:
            return
        entry = reasons.setdefault(relative, [])
        if not any(r['reason'] == reason and r['detail'] == detail for r in entry):
            entry.append({'reason': reason, 'detail': detail})

    def inside(child, folder):
        return child == folder or child.startswith(folder + '/')

    def shared(folder):
        for finding in findings:
            if id(finding) in owner_ids:
                continue
            for field in ('report_path', 'evidence_path', 'report_dir'):
                other = rel(finding.get(field))
                if other and inside(other, folder):
                    return True
        return False

    # Rule 1: dedicated report folder.
    folder, why = None, None
    for finding in owners:
        candidate = rel(finding.get('report_dir'))
        if candidate and candidate.startswith('reports/') and inside(report_rel, candidate):
            folder, why = candidate, f'report_dir of finding {finding.get("fid") or "?"}'
            break
    if folder is None and report_dir.count('/') == 1:
        names = {n.lower() for n in _list_names(lane_fd, report_dir)}
        if names & FOLDER_MARKERS:
            folder, why = report_dir, 'folder holds REPORT.md or EVIDENCE.md'
    if folder and shared(folder):
        notes.append('folder_shared')
        folder = None
    elif folder is None and report_dir != 'reports':
        notes.append('folder_not_dedicated')
    elif folder is None:
        notes.append('flat_reports_root')
    budget = [MAX_SCANNED]
    if folder:
        found = []
        _walk(lane_fd, folder, {report_rel}, found, budget)
        for relative in found:
            add(relative, 'report_folder', why)

    # Rule 2: owning finding artifact fields.
    for finding in owners:
        for field, value in _fields(finding):
            relative = rel(value)
            kind = relative and _kind_at(lane_fd, relative)
            detail = f'{field} of finding {finding.get("fid") or "?"}'
            if kind == 'file':
                add(relative, 'finding_field', detail)
            elif kind == 'dir' and '/' in relative and not relative.startswith('ledgers/') and not shared(relative):
                found = []
                _walk(lane_fd, relative, {report_rel}, found, budget)
                for item in found:
                    add(item, 'finding_field', detail)

    # Rule 3: relative Markdown links in the report.
    for target in markdown_targets(text):
        relative = _normalize(report_dir.split('/') + target.split('/'))
        if relative and _kind_at(lane_fd, relative) == 'file':
            add(relative, 'report_link', target)

    artifacts = []
    for relative in sorted(reasons)[:MAX_LISTED]:
        try:
            fd, info = open_file(lane_fd, relative)
        except ArtifactError:
            continue
        os.close(fd)
        name = relative.rsplit('/', 1)[-1]
        is_sensitive = sensitive(name)
        artifacts.append({
            'name': name, 'relative': relative,
            'display_path': relative[len(folder) + 1:] if folder and relative.startswith(folder + '/') else relative,
            'size': info.st_size, 'modified': int(info.st_mtime),
            'category': category(name), 'sensitive': is_sensitive,
            'preview': preview_kind(name, is_sensitive),
            'source_reason': reasons[relative][0]['reason'], 'reasons': reasons[relative],
        })
    if len(reasons) > MAX_LISTED or budget[0] <= 0:
        notes.append('truncated')
    return {'report': report_rel, 'folder': folder, 'artifacts': artifacts, 'notes': notes}


def _list_names(lane_fd, folder):
    try:
        fd = _open_dir(lane_fd, folder.split('/'))
    except OSError:
        return []
    try:
        return os.listdir(fd)
    except OSError:
        return []
    finally:
        os.close(fd)


def parse_range(header, size):
    """Return (start, end) inclusive, None for full content, or 'invalid'."""
    if not header:
        return None
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', header.strip())
    if not match or (not match.group(1) and not match.group(2)):
        return None if ',' in header else 'invalid'
    first, last = match.groups()
    if first:
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
        if last and int(last) < start:
            return 'invalid'
    else:
        length = int(last)
        if length == 0:
            return 'invalid'
        start, end = max(size - length, 0), size - 1
    if start >= size:
        return 'invalid'
    return start, end
