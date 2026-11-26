"""Artifact uploads: store files sent from the artifacts panel in a report's folder.

Opt-in (``--artifact-uploads``). One request carries one file as the raw body
(``application/octet-stream``; no multipart). The target is the report's
dedicated folder exactly as ``report_artifacts.associate()`` decides it at
request time (association rule 1, ``report_folder``), so an uploaded file
shows up in the same panel. Nothing is created but the file itself: no
folders, no ledger writes, and nothing is ever overwritten or replaced.

Placement: the body is streamed into ``.syncthing.board-<hex>.tmp`` (Syncthing
never indexes it, the root's ``.stignore`` ignores ``*.tmp``) created with
``O_CREAT|O_EXCL|O_NOFOLLOW`` inside the folder, which is opened by walking
descriptors with ``O_NOFOLLOW`` from the data root. After fsync the staged
inode is hard-linked to its final name (``linkat`` fails instead of
replacing), the staged name is removed and the directory is fsynced. Name
choice and linking run under one process lock so two uploads in this process
never pick names that differ only in case; a file created meanwhile by another
writer makes ``linkat`` fail and the next suffix is tried.

Contract: docs/integrations/artifact-uploads.md.
"""
import errno
import os
import re
import secrets
import socket
import threading
import unicodedata
from pathlib import PurePosixPath
from urllib.parse import parse_qs, urlsplit

import report_artifacts as ra

MAX_UPLOAD_BYTES = 512 * 1024 * 1024
DEFAULT_FREE_FLOOR = 1024 * 1024 * 1024
MAX_CONCURRENT = 2
CHUNK = 64 * 1024
READ_TIMEOUT = 60
NAME_MAX_BYTES = 180
# Refusals after the trust gate drain a small body so the browser reads the
# JSON reply instead of a connection reset; larger bodies close unread.
DRAIN_LIMIT = 1024 * 1024
MAX_SUFFIX = 9999
_UNSAFE = set('/\\:*?"<>|')
_WINDOWS_RESERVED = re.compile(r'(con|prn|aux|nul|com[0-9]|lpt[0-9])', re.I)
_LINK_UNSUPPORTED = {errno.EPERM, errno.EOPNOTSUPP, errno.ENOTSUP, errno.EXDEV, errno.EMLINK}


class UploadError(Exception):
    def __init__(self, status, code, **extra):
        super().__init__(code)
        self.status, self.code, self.extra = status, code, extra


class Uploads:
    """Per-server upload state: limits, concurrency slots and the placement lock."""

    def __init__(self, max_bytes=MAX_UPLOAD_BYTES, free_floor=DEFAULT_FREE_FLOOR, concurrent=MAX_CONCURRENT,
                 read_timeout=READ_TIMEOUT):
        self.max_bytes = max_bytes
        self.free_floor = free_floor
        self.read_timeout = read_timeout
        self.slots = threading.BoundedSemaphore(concurrent)
        self.place_lock = threading.Lock()


def upload_state(uploads, found):
    """The ``upload`` block of the artifact list response."""
    if uploads is None:
        return {'enabled': False, 'reason': 'disabled', 'max_bytes': None}
    if not found.get('folder'):
        return {'enabled': False, 'reason': 'no_report_folder', 'max_bytes': uploads.max_bytes}
    return {'enabled': True, 'reason': None, 'max_bytes': uploads.max_bytes}


def free_bytes(dir_fd):
    info = os.statvfs(dir_fd)
    return info.f_bavail * info.f_frsize


def _utf8_cut(text, limit):
    data = text.encode('utf-8')
    if len(data) <= limit:
        return text
    return data[:max(limit, 0)].decode('utf-8', errors='ignore')


def sanitize_name(raw):
    """Turn a browser-supplied file name into a safe single path component.

    Fixable problems are fixed (path parts, unsafe or control characters,
    leading dots/underscores, length); only names that cannot be trusted at
    all (NUL, undecodable text) raise ``UploadError(400, 'invalid_name')``."""
    if not isinstance(raw, str) or '\0' in raw:
        raise UploadError(400, 'invalid_name')
    try:
        raw.encode('utf-8')
    except UnicodeError:
        raise UploadError(400, 'invalid_name') from None
    name = unicodedata.normalize('NFC', re.split(r'[/\\]', raw)[-1])
    # Control, format (bidi overrides, zero-width) and line/paragraph separators.
    name = ''.join('_' if ch in _UNSAFE or unicodedata.category(ch) in ('Cc', 'Cf', 'Zl', 'Zp') else ch for ch in name)
    original_ext = _extension(name.lstrip('._ '))
    name = name.lstrip('._ ').rstrip('. ')
    if not name:
        return 'upload' + original_ext
    ext = _extension(name)
    stem = name[:len(name) - len(ext)] if ext else name
    if not stem:
        stem, ext = name, ''
    if _WINDOWS_RESERVED.fullmatch(stem.split('.')[0]):
        stem += '_'  # CON, NUL, COM1... cannot exist on Windows sync peers
    return _fit(stem, ext)


def _extension(name):
    ext = PurePosixPath(name).suffix if name else ''
    # Keep a plausible extension only (short, no spaces).
    return ext if 1 < len(ext.encode('utf-8')) <= 24 and ' ' not in ext else ''


def _fit(stem, ext, suffix=''):
    """``stem + suffix + ext`` within NAME_MAX_BYTES, cutting the stem first."""
    room = NAME_MAX_BYTES - len((suffix + ext).encode('utf-8'))
    if room < 1:
        ext = ''
        room = NAME_MAX_BYTES - len(suffix.encode('utf-8'))
    cut = _utf8_cut(stem, room).rstrip('. ') or 'upload'
    return cut + suffix + ext


def candidates(name):
    """``name``, then ``stem-2.ext``, ``stem-3.ext``, ..."""
    yield name
    ext = _extension(name)
    stem = name[:len(name) - len(ext)] if ext and len(name) > len(ext) else name
    if not ext or len(name) <= len(ext):
        ext = ''
    for number in range(2, MAX_SUFFIX + 1):
        yield _fit(stem, ext, f'-{number}')


def _taken(dir_fd):
    return {entry.casefold() for entry in os.listdir(dir_fd)}


def _place(uploads, dir_fd, staged, name):
    """Give the staged inode its final name without replacing anything. Returns the name."""
    with uploads.place_lock:
        taken = _taken(dir_fd)
        for candidate in candidates(name):
            if candidate.casefold() in taken:
                continue
            try:
                os.link(staged, candidate, src_dir_fd=dir_fd, dst_dir_fd=dir_fd, follow_symlinks=False)
                return candidate
            except FileExistsError:
                taken.add(candidate.casefold())  # created meanwhile by another writer
            except OSError as error:
                if error.errno not in _LINK_UNSUPPORTED:
                    raise
                # No hard links on this filesystem: check again and rename in place.
                # Another process could create the same name between check and
                # rename; this process's own uploads are serialized by the lock.
                if candidate.casefold() in _taken(dir_fd):
                    taken.add(candidate.casefold())
                    continue
                os.rename(staged, candidate, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
                return candidate
    raise UploadError(409, 'name_unavailable')


def store(uploads, dir_fd, name, length, rfile):
    """Stream ``length`` bytes from ``rfile`` into the folder. Returns the final name."""
    staged = f'.syncthing.board-{secrets.token_hex(6)}.tmp'
    fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o666, dir_fd=dir_fd)
    try:
        try:
            remaining = length
            while remaining:
                try:
                    chunk = rfile.read(min(CHUNK, remaining))
                except (socket.timeout, TimeoutError, ConnectionError, OSError):
                    chunk = b''
                if not chunk:
                    raise UploadError(400, 'incomplete_body')
                view = memoryview(chunk)
                while view:
                    view = view[os.write(fd, view):]
                remaining -= len(chunk)
            os.fsync(fd)
        finally:
            os.close(fd)
        final = _place(uploads, dir_fd, staged, name)
        os.fsync(dir_fd)
        return final
    finally:
        try:
            os.unlink(staged, dir_fd=dir_fd)
        except FileNotFoundError:
            pass  # renamed into place by the no-hard-link fallback


def _selector(handler, families):
    params = parse_qs(urlsplit(handler.path).query, keep_blank_values=True, max_num_fields=8)
    bound = 'root_instance' in params
    needed = {'family', 'program', 'lane', 'path', 'name'} | ({'root_instance'} if bound else set())
    if set(params) != needed or any(len(v) != 1 for v in params.values()):
        raise ra.ArtifactError('invalid selector')
    family, program, lane, path = (params[k][0] for k in ('family', 'program', 'lane', 'path'))
    if (family not in families or lane not in families[family] or not program or program.startswith('_') or
            program in ('.', '..') or '/' in program or '\0' in program):
        raise ra.ArtifactError('invalid selector')
    ra._clean_parts(path)
    return family, program, lane, path, params['name'][0], (params['root_instance'][0] if bound else None)


def _gate(handler):
    headers = handler.headers
    lengths = headers.get_all('Content-Length', [])
    types = headers.get_all('Content-Type', [])
    if (not handler.trusted_request(require_origin=True) or
            headers.get_all('X-Requested-With', []) != ['Bounty-Board'] or
            len(types) != 1 or types[0].strip().lower() != 'application/octet-stream' or
            headers.get_all('Transfer-Encoding') or
            len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,15}', lengths[0].strip())):
        return None
    return int(lengths[0].strip())


def handle_upload(handler, uploads, root, root_snapshot, families):
    """``POST /api/report-artifact-upload``. ``handler`` is the Board request handler."""
    length = None
    body_read = False
    timeout = handler.connection.gettimeout()

    def refuse(status, payload, extra=None):
        # The body is unread: drain a small one so the reply reaches the
        # browser, otherwise close so it is not parsed as the next request.
        nonlocal body_read
        if not body_read and length is not None and length <= DRAIN_LIMIT:
            try:
                handler.connection.settimeout(5)
                body_read = len(handler.rfile.read(length)) == length
            except OSError:
                pass
            finally:
                try:
                    handler.connection.settimeout(timeout)
                except OSError:
                    pass
        if not body_read:
            handler.close_connection = True
        handler.reply(status, payload, {**(extra or {}), **({} if body_read else {'Connection': 'close'})})

    if uploads is None:
        handler.close_connection = True
        return handler.reply(404, {'error': 'uploads_disabled'}, {'Connection': 'close'})
    declared = _gate(handler)
    if declared is None:
        handler.close_connection = True
        return handler.reply(403, {'error': 'untrusted_origin'}, {'Connection': 'close'})
    if declared > uploads.max_bytes:
        handler.close_connection = True
        return handler.reply(413, {'error': 'too_large', 'max_bytes': uploads.max_bytes}, {'Connection': 'close'})
    length = declared
    try:
        family, program, lane, path, raw_name, root_instance = _selector(handler, families)
    except ra.ArtifactError:
        return refuse(404, {'error': 'artifact_not_found_or_unavailable'})
    try:
        name = sanitize_name(raw_name)
    except UploadError as error:
        return refuse(error.status, {'error': error.code})
    before = root_snapshot() if root_instance is not None else None
    if root_instance is not None and (not before or root_instance != before[2]):
        return refuse(409, {'error': 'root_changed'})
    if not uploads.slots.acquire(blocking=False):
        return refuse(503, {'error': 'uploads_busy'}, {'Retry-After': '2'})
    lane_fd = dir_fd = None
    try:
        try:
            lane_fd = ra.open_lane(before[0] if before else root, family, program, lane)
            found = ra.associate(lane_fd, family, program, lane, path)
        except (OSError, ValueError, UnicodeError, ra.ArtifactError):
            if before and root_snapshot() != before:
                return refuse(409, {'error': 'root_changed'})
            return refuse(404, {'error': 'artifact_not_found_or_unavailable'})
        folder = found['folder']
        if not folder:
            note = next((n for n in found['notes'] if n in ('folder_shared', 'folder_not_dedicated', 'flat_reports_root')), None)
            return refuse(409, {'error': 'no_report_folder', 'note': note})
        try:
            dir_fd = ra._open_dir(lane_fd, folder.split('/'))
        except OSError:
            return refuse(404, {'error': 'artifact_not_found_or_unavailable'})
        try:
            available = free_bytes(dir_fd)
        except OSError:
            available = 0
        if available < length + uploads.free_floor:
            return refuse(507, {'error': 'insufficient_storage'})
        handler.connection.settimeout(uploads.read_timeout)
        try:
            final = store(uploads, dir_fd, name, length, handler.rfile)
            body_read = True
        except UploadError as error:
            body_read = error.code != 'incomplete_body'
            if body_read:
                return handler.reply(error.status, {'error': error.code})
            handler.close_connection = True
            try:  # the client is usually gone already
                handler.reply(error.status, {'error': error.code}, {'Connection': 'close'})
            except OSError:
                pass
            return None
        except OSError as error:
            handler.close_connection = True
            if error.errno in (errno.ENOSPC, errno.EDQUOT):
                return handler.reply(507, {'error': 'insufficient_storage'}, {'Connection': 'close'})
            return handler.reply(500, {'error': 'upload_failed'}, {'Connection': 'close'})
        relative = f'{folder}/{final}'
        entry = _entry(lane_fd, family, program, lane, path, relative)
        return handler.reply(201, {'artifact': entry, 'renamed': final != name, 'requested_name': name})
    finally:
        try:
            handler.connection.settimeout(timeout)
        except OSError:
            pass
        for fd in (dir_fd, lane_fd):
            if fd is not None:
                os.close(fd)
        uploads.slots.release()


def _entry(lane_fd, family, program, lane, path, relative):
    """The list entry for the new file (same shape as ``/api/report-artifacts``).

    Files the listing skips (``*.pyc``) or that fall past its caps are still
    saved; they get the same fields from the file itself and ``listed: false``."""
    try:
        found = ra.associate(lane_fd, family, program, lane, path)
        item = next((a for a in found['artifacts'] if a['relative'] == relative), None)
        if item is not None:
            return item
    except (OSError, ValueError, UnicodeError, ra.ArtifactError):
        found = {'folder': relative.rsplit('/', 1)[0]}
    name = relative.rsplit('/', 1)[-1]
    try:
        fd, info = ra.open_file(lane_fd, relative)
        os.close(fd)
        size, modified = info.st_size, int(info.st_mtime)
    except ra.ArtifactError:
        size = modified = None
    is_sensitive = ra.sensitive(name)
    folder = found.get('folder') or ''
    return {'name': name, 'relative': relative,
            'display_path': relative[len(folder) + 1:] if folder and relative.startswith(folder + '/') else relative,
            'size': size, 'modified': modified, 'category': ra.category(name), 'sensitive': is_sensitive,
            'preview': ra.preview_kind(name, is_sensitive), 'source_reason': 'report_folder',
            'reasons': [{'reason': 'report_folder', 'detail': 'uploaded'}], 'listed': False}
