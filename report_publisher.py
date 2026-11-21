"""Opt-in local exchange publisher. Caller holds the store observation lock.

This is not a filesystem CAS. Uncoordinated writes can race every check; the
retained displaced inode and reinspection expose only observable collisions.
"""
import ctypes
import errno
import hashlib
import json
import os
import stat
from pathlib import Path

# The directory cache is invalidated by inode or directory metadata changes.
# A scan counts every immediate entry, including crash remnants and symlinks.
DEFAULT_MAX_OPERATIONS = 1000
DEFAULT_MIN_FREE_BYTES = 1024 ** 3
_capacity_counts = {}


def _directory_version(st):
    return (st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)


def _operation_count(fd):
    before = os.fstat(fd)
    version = _directory_version(before)
    cached = _capacity_counts.get((before.st_dev, before.st_ino))
    if cached is not None and cached[0] == version:
        return cached[1]
    with os.scandir(fd) as entries:
        count = sum(1 for _ in entries)
    after = os.fstat(fd)
    if _directory_version(after) != version:
        raise OSError('publication directory changed during capacity scan')
    _capacity_counts[(before.st_dev, before.st_ino)] = (version, count)
    return count


def generated_navigation(relative, text):
    """Match BBH navigation markers and its exact seeded-index placeholders."""
    if any(marker in text for marker in (
            '<!-- generated: bounty-core-report-navigation -->',
            '<!-- generated: bounty-core-category-link-stub -->')):
        return True
    path = Path(relative)
    lines = '\n'.join(line for line in text.splitlines() if not line.startswith('<!-- generated:')).strip()
    if path.name == 'index.md' and path.parent.parent.name in {'raw', 'confirmed', 'dormant', 'novel', 'complete', 'archive'}:
        return lines == f'# {path.parent.parent.name.title()} {path.parent.name.upper()}'
    if path.parent.name == 'index':
        return lines == f"# {path.stem.replace('_', ' ').title()}"
    return False


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _write_at(fd, name, data, mode=0o600):
    f = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
    try:
        with os.fdopen(f, 'wb') as stream:
            f = -1
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
    finally:
        if f != -1:
            os.close(f)


def _exchange(a, an, b, bn):
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        fn = libc.renameat2
    except AttributeError as exc:
        raise OSError(errno.ENOSYS, 'renameat2 unavailable') from exc
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    if fn(a, os.fsencode(an), b, os.fsencode(bn), 2):
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))


def _identity(st):
    return (st.st_dev, st.st_ino)


def _snapshot(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('source not regular')
    os.lseek(fd, 0, os.SEEK_SET)
    data = bytearray()
    while len(data) <= 5_000_000:
        chunk = os.read(fd, min(65536, 5_000_001 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    after = os.fstat(fd)
    if len(data) > 5_000_000 or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('unstable source')
    return bytes(data), after


def _open_parent(root, relative):
    parts = Path(relative).parts
    if not parts or any(p in ('/', '.', '..') for p in parts):
        raise ValueError('invalid source path')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def operation_id(key, request_id):
    return _digest(json.dumps([key, request_id], ensure_ascii=False).encode())


def inspect(root, relative, op):
    """Recheck the live and displaced files. Never publish during recovery."""
    result = {'state': 'outcome_uncertain', 'operation': op.name, 'reasons': []}
    try:
        receipt = json.loads((op / 'receipt.json').read_text())
        if receipt['state'] != 'published':
            return {**result, 'state': receipt['state'], 'reasons': receipt['reasons']}
        intent = json.loads((op / 'intent.json').read_text())
        parent, name = _open_parent(root, relative)
        try:
            src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                data, info = _snapshot(src)
            finally:
                os.close(src)
            old = os.open(op / 'displaced', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                displaced, oldinfo = _snapshot(old)
            finally:
                os.close(old)
            if list(_identity(info)) != intent['candidate'] or _digest(data) != intent['draft'] or stat.S_IMODE(info.st_mode) != intent['mode']:
                result['reasons'].append('source_changed')
            if list(_identity(oldinfo)) != intent['source'] or _digest(displaced) != intent['observed'] or stat.S_IMODE(oldinfo.st_mode) != intent['mode']:
                result['reasons'].append('displaced_changed')
        finally:
            os.close(parent)
        result['state'] = 'conflict' if result['reasons'] else 'published'
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        pass
    return result


def retained_snapshot(store_root, operation):
    """Return a stable best-effort displaced snapshot for store reconciliation."""
    op = Path(store_root) / 'publication' / operation
    receipt = json.loads((op / 'receipt.json').read_text())
    if receipt['state'] != 'published':
        return None
    intent = json.loads((op / 'intent.json').read_text())
    fd = os.open(op / 'displaced', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        data, info = _snapshot(fd)
    finally:
        os.close(fd)
    if list(_identity(info)) == intent['candidate']:
        raise ValueError('exchange outcome uncertain')
    return intent['observed'], data.decode('utf-8')


def publish(root, relative, store_root, key, request_id, observed, draft, hook=None,
            max_operations=None, min_free_bytes=None):
    """Attempt once; errors retain the store draft and any created operation.

    Observed is the exact source snapshot merged into the accepted store head.
    No retry performs a second exchange for the same operation id.
    """
    opid = operation_id(key, request_id)
    area = Path(store_root) / 'publication'
    area.mkdir(mode=0o700, exist_ok=True)
    st = area.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        raise PermissionError('publication directory must be private')
    op = area / opid
    max_operations = DEFAULT_MAX_OPERATIONS if max_operations is None else max_operations
    min_free_bytes = DEFAULT_MIN_FREE_BYTES if min_free_bytes is None else min_free_bytes
    afd = os.open(area, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(afd)
        if _identity(info) != _identity(st):
            raise OSError('publication directory moved')
        try:
            existing = os.stat(opid, dir_fd=afd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if not stat.S_ISDIR(existing.st_mode):
                return {'state': 'outcome_uncertain', 'operation': opid, 'reasons': ['invalid_operation']}
            return inspect(root, relative, op)
        count = _operation_count(afd)
        free = os.fstatvfs(afd)
        available = free.f_bavail * free.f_frsize
        needed = 2 * len(draft.encode('utf-8')) + 1024 * 1024
        if count >= max_operations or available < min_free_bytes + needed:
            return {'state': 'capacity', 'operation': opid, 'reasons': ['retention_capacity']}
        try:
            os.mkdir(opid, mode=0o700, dir_fd=afd)
        except FileExistsError:
            return inspect(root, relative, op)
        os.fsync(afd)
        current = os.fstat(afd)
        _capacity_counts[(current.st_dev, current.st_ino)] = (_directory_version(current), count + 1)
        ofd = os.open(opid, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=afd)
    finally:
        os.close(afd)
    parent = source = -1
    exchanged = False
    try:
        _write_at(ofd, 'board', draft.encode('utf-8'))
        os.fsync(ofd)
        parent, name = _open_parent(root, relative)
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        data, info = _snapshot(source)
        if generated_navigation(relative, data.decode('utf-8')):
            raise ValueError('generated navigation is not editable')
        if data != observed.encode('utf-8'):
            raise ValueError('source changed before publication')
        if info.st_dev != os.fstat(ofd).st_dev:
            raise ValueError('private retention is on another filesystem')
        if info.st_uid != os.geteuid() or info.st_gid != os.getegid() or os.listxattr(source):
            raise ValueError('source metadata cannot be preserved')
        mode = stat.S_IMODE(info.st_mode)
        os.link(name, 'observed', src_dir_fd=parent, dst_dir_fd=ofd, follow_symlinks=False)
        if _identity(os.stat('observed', dir_fd=ofd, follow_symlinks=False)) != _identity(info):
            raise ValueError('source identity changed')
        data2, info = _snapshot(source)
        if data2 != data:
            raise ValueError('source changed during retention')
        os.fsync(source)
        _write_at(ofd, 'displaced', draft.encode('utf-8'), mode)
        candidate_fd = os.open('displaced', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=ofd)
        try:
            candidate = os.fstat(candidate_fd)
            if (candidate.st_uid != info.st_uid or candidate.st_gid != info.st_gid or
                    stat.S_IMODE(candidate.st_mode) != mode or os.listxattr(candidate_fd)):
                raise ValueError('candidate metadata cannot be preserved')
        finally:
            os.close(candidate_fd)
        intent = {'source': list(_identity(info)), 'candidate': list(_identity(candidate)), 'mode': mode,
                  'observed': _digest(data), 'draft': _digest(draft.encode('utf-8'))}
        _write_at(ofd, 'intent.json', json.dumps(intent, sort_keys=True).encode())
        os.fsync(ofd)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (_identity(current), current.st_mode, current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (_identity(info), info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns):
            raise ValueError('source changed before exchange')
        if hook:
            hook('before_exchange', op)
        # Do not exchange if retained evidence has been moved away from the
        # advertised private path. This is a point-in-time check, not exclusion
        # of an uncoordinated rename after it.
        area_now = area.lstat()
        op_now = op.lstat()
        if (not stat.S_ISDIR(area_now.st_mode) or _identity(area_now) != _identity(st) or
                not stat.S_ISDIR(op_now.st_mode) or _identity(op_now) != _identity(os.fstat(ofd))):
            raise ValueError('retention directory moved')
        final_data, _ = _snapshot(source)
        if generated_navigation(relative, final_data.decode('utf-8')):
            raise ValueError('generated navigation is not editable')
        check, _ = _open_parent(root, relative)
        try:
            if _identity(os.fstat(check)) != _identity(os.fstat(parent)):
                raise ValueError('source parent moved')
        finally:
            os.close(check)
        if _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != _identity(info):
            raise ValueError('source identity changed before exchange')
        _exchange(parent, name, ofd, 'displaced')
        exchanged = True
        if hook:
            hook('after_exchange', op)
        os.fsync(parent)
        os.fsync(ofd)
        # A durable receipt means the exchange and directory fsyncs completed.
        _write_at(ofd, 'receipt.pending', json.dumps({'state': 'published', 'reasons': []}).encode())
        os.link('receipt.pending', 'receipt.json', src_dir_fd=ofd, dst_dir_fd=ofd, follow_symlinks=False)
        os.fsync(ofd)
        return inspect(root, relative, op)
    except (OSError, ValueError, UnicodeError) as exc:
        state = 'outcome_uncertain' if exchanged else 'conflict'
        reason = ('exchange_unsupported' if isinstance(exc, OSError) and exc.errno in
                  (errno.ENOSYS, errno.EINVAL, errno.EXDEV, errno.EOPNOTSUPP) else 'publication_failed')
        # If a completed receipt was linked but the final fsync failed, remove
        # it before recording uncertainty. If this fails, callers must retain
        # the operation and treat its disk state as untrustworthy.
        if exchanged:
            try:
                os.unlink('receipt.json', dir_fd=ofd)
            except FileNotFoundError:
                pass
            except OSError:
                return {'state': 'outcome_uncertain', 'operation': opid, 'reasons': [reason]}
        # If a receipt cannot be persisted, do not claim a durable conflict.
        try:
            _write_at(ofd, 'receipt.json', json.dumps({'state': state, 'reasons': [reason]}).encode())
            os.fsync(ofd)
        except OSError:
            state = 'outcome_uncertain'
        return {'state': state, 'operation': opid, 'reasons': [reason]}
    finally:
        if source != -1:
            os.close(source)
        if parent != -1:
            os.close(parent)
        os.close(ofd)
