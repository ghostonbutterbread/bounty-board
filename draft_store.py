"""Private local report draft versions; never modifies source reports.

A successful save preserves a complete, immutable version on this device. It
is not a source-file save or a claim that another machine received the draft.
"""
import hashlib
import json
import os
import stat
import time
import uuid
from pathlib import Path

MAX_CONTENT_BYTES = 5_000_000


class DraftConflictError(ValueError):
    """An idempotency key was reused for a different draft."""


def _digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _identity(value, field):
    if not isinstance(value, str) or not value or len(value) > 4096 or '\x00' in value:
        raise ValueError(f'invalid {field}')
    return value


def _directory(root, report_key, create):
    root = Path(root)
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(root_fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise PermissionError('draft directory must be owner-only')
        name = _digest(report_key)
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=root_fd)
                os.fsync(root_fd)
            except FileExistsError:
                pass
        report_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        info = os.fstat(report_fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            os.close(report_fd)
            raise PermissionError('report draft directory must be owner-only')
        return report_fd
    finally:
        os.close(root_fd)


def _read(directory_fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise PermissionError('draft file must be owner-only and regular')
        limit = 6 * MAX_CONTENT_BYTES + 50_000  # JSON can escape one byte into six.
        with os.fdopen(fd, 'rb') as stream:
            fd = -1
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError('draft file too large')
        record = json.loads(data)
        if (not isinstance(record, dict) or not isinstance(record.get('content'), str)
                or record.get('content_sha256') != _digest(record['content'])
                or not isinstance(record.get('saved_at_ns'), int)):
            raise ValueError('invalid or corrupted draft')
        return record
    finally:
        if fd != -1:
            os.close(fd)


def save_draft(root, report_key, content, base_revision, request_id):
    report_key = _identity(report_key, 'report key')
    request_id = _identity(request_id, 'request id')
    base_revision = _identity(base_revision, 'base revision')
    if not isinstance(content, str) or len(content.encode('utf-8')) > MAX_CONTENT_BYTES:
        raise ValueError('draft content is invalid or too large')
    record = {'report_key': report_key, 'request_id': request_id, 'base_revision': base_revision,
              'content': content, 'content_sha256': _digest(content), 'saved_at_ns': time.time_ns()}
    data = json.dumps(record, ensure_ascii=False, sort_keys=True).encode('utf-8')
    directory_fd = _directory(root, report_key, True)
    temp_name = '.pending-' + uuid.uuid4().hex
    final_name = _digest(request_id) + '.json'
    try:
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        try:
            with os.fdopen(fd, 'wb') as stream:
                fd = -1
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if fd != -1:
                os.close(fd)
        try:
            os.link(temp_name, final_name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        except FileExistsError:
            existing = _read(directory_fd, final_name)
            expected = ('report_key', 'request_id', 'base_revision', 'content', 'content_sha256')
            if any(existing.get(k) != record[k] for k in expected):
                raise DraftConflictError('request id already belongs to a different draft')
            record = existing
        os.fsync(directory_fd)
        return record
    finally:
        try:
            os.unlink(temp_name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def list_drafts(root, report_key):
    report_key = _identity(report_key, 'report key')
    try:
        directory_fd = _directory(root, report_key, False)
    except FileNotFoundError:
        return []
    try:
        drafts = []
        for name in sorted(os.listdir(directory_fd)):
            if not name.endswith('.json'):
                continue
            record = _read(directory_fd, name)
            if not isinstance(record, dict) or record.get('report_key') != report_key:
                raise ValueError('invalid report draft identity')
            drafts.append(record)
        return sorted(drafts, key=lambda x: (x['saved_at_ns'], x['request_id']))
    finally:
        os.close(directory_fd)
