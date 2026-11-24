"""Access control for the sandbox terminal service.

Two ways in:

1. Tailscale Serve identity. Serve proxies tailnet requests to the service on
   127.0.0.1 and sets ``Tailscale-User-Login``. That header is only trusted
   because the service listens on loopback (anything able to reach it directly
   is already a local process on the host) and only when the request's Host is
   the configured Board tailnet authority, which is what Serve forwards.
2. Password login for user ``ryushe``. The password hash (scrypt) is read from
   a 0600 file; the plaintext is never stored or logged. A successful login
   creates a random server-side session id sent as an HttpOnly, Secure,
   SameSite=Strict cookie scoped to ``/terminal``.

Failed logins are rate limited: after ``MAX_FAILURES`` failures inside
``FAILURE_WINDOW`` seconds, all password logins are refused for
``LOCKOUT_SECONDS``. The lockout is global (behind Serve every request comes
from 127.0.0.1, so there is no trustworthy client address); allowlisted
tailnet users are not affected by it.
"""
import base64
import hashlib
import hmac
import os
import secrets
import stat
import threading
import time

USERNAME = 'ryushe'
COOKIE = 'bbterm_session'
SESSION_SECONDS = 12 * 3600
MAX_SESSIONS = 64
MAX_FAILURES = 5
FAILURE_WINDOW = 15 * 60
LOCKOUT_SECONDS = 15 * 60
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1
SCRYPT_MAXMEM = 128 * 1024 * 1024
MIN_PASSWORD = 12


class HashFileError(Exception):
    pass


def hash_password(password, *, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, salt=None):
    """Return a one-line ``scrypt$n$r$p$salt$hash`` record (base64, no padding issues)."""
    if not isinstance(password, str) or not password:
        raise ValueError('empty password')
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=SCRYPT_MAXMEM, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode()
    return f'scrypt${n}${r}${p}${b64(salt)}${b64(digest)}'


def parse_hash(record):
    parts = record.strip().split('$')
    if len(parts) != 6 or parts[0] != 'scrypt':
        raise HashFileError('unrecognised hash format')
    try:
        n, r, p = (int(x) for x in parts[1:4])
        salt, digest = base64.b64decode(parts[4], validate=True), base64.b64decode(parts[5], validate=True)
    except ValueError as error:
        raise HashFileError('unrecognised hash format') from error
    if n < 2 ** 14 or n & (n - 1) or not 1 <= r <= 32 or not 1 <= p <= 16 or len(salt) < 16 or len(digest) != 32:
        raise HashFileError('hash parameters are too weak or invalid')
    return n, r, p, salt, digest


def verify_password(record, password):
    n, r, p, salt, digest = parse_hash(record)
    candidate = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=SCRYPT_MAXMEM, dklen=32)
    return hmac.compare_digest(candidate, digest)


def read_hash_file(path):
    """Read the hash record, refusing files other users could read or replace."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise HashFileError('hash file is not a regular file')
        if info.st_mode & 0o077:
            raise HashFileError('hash file must be mode 0600')
        if info.st_uid != os.getuid():
            raise HashFileError('hash file must be owned by the service user')
        data = os.read(fd, 4096).decode('ascii')
    finally:
        os.close(fd)
    parse_hash(data)
    return data.strip()


def write_hash_file(path, record, force=False):
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_TRUNC if force else os.O_EXCL)
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, (record + '\n').encode())
    finally:
        os.close(fd)


class Auth:
    """Decides whether a request may use the terminal, and keeps login sessions."""

    def __init__(self, *, allowed_users=(), trusted_hosts=(), hash_record=None, clock=time.time,
                 session_seconds=SESSION_SECONDS):
        self.allowed_users = frozenset(u.strip().lower() for u in allowed_users if u.strip())
        self.trusted_hosts = frozenset(trusted_hosts)
        self.hash_record = hash_record
        self.clock = clock
        self.session_seconds = session_seconds
        self.sessions = {}
        self.failures = []
        self.locked_until = 0.0
        self.lock = threading.Lock()
        # Burn the same scrypt time for unknown usernames.
        self._dummy = hash_password(secrets.token_hex(16), salt=b'\0' * 16)

    @property
    def password_enabled(self):
        return self.hash_record is not None

    def tailnet_user(self, headers):
        """Allowlisted Serve identity for this request, or None."""
        hosts = headers.get_all('Host', [])
        if len(hosts) == 1 and hosts[0] in self.trusted_hosts:
            logins = headers.get_all('Tailscale-User-Login', [])
            if len(logins) == 1 and logins[0].strip().lower() in self.allowed_users:
                return logins[0].strip().lower()
        return None

    def session_user(self, headers):
        sid = cookie_value(headers, COOKIE)
        if not sid:
            return None
        now = self.clock()
        with self.lock:
            entry = self.sessions.get(sid)
            if entry and entry[1] > now:
                return entry[0]
            if entry:
                del self.sessions[sid]
        return None

    def identify(self, headers):
        """Return (user, method) with method 'tailnet' or 'password', or (None, None)."""
        user = self.tailnet_user(headers)
        if user:
            return user, 'tailnet'
        user = self.session_user(headers)
        return (user, 'password') if user else (None, None)

    def login(self, username, password):
        """Return (session_id, None) or (None, error) where error is 'invalid', 'locked' or 'disabled'."""
        if not self.password_enabled:
            return None, 'disabled'
        now = self.clock()
        with self.lock:
            if now < self.locked_until:
                return None, 'locked'
        name_ok = hmac.compare_digest(str(username).encode(), USERNAME.encode())
        password = password if isinstance(password, str) and len(password) <= 1024 else ''
        try:
            ok = verify_password(self.hash_record if name_ok else self._dummy, password) and name_ok
        except HashFileError:
            ok = False
        with self.lock:
            if now < self.locked_until:
                return None, 'locked'
            if not ok:
                self.failures = [t for t in self.failures if now - t < FAILURE_WINDOW] + [now]
                if len(self.failures) >= MAX_FAILURES:
                    self.locked_until = now + LOCKOUT_SECONDS
                    self.failures = []
                return None, 'invalid'
            self.failures = []
            self.sessions = {k: v for k, v in self.sessions.items() if v[1] > now}
            while len(self.sessions) >= MAX_SESSIONS:
                del self.sessions[min(self.sessions, key=lambda k: self.sessions[k][1])]
            sid = secrets.token_urlsafe(32)
            self.sessions[sid] = (USERNAME, now + self.session_seconds)
            return sid, None

    def logout(self, headers):
        sid = cookie_value(headers, COOKIE)
        with self.lock:
            self.sessions.pop(sid, None)

    def session_cookie(self, sid):
        return (f'{COOKIE}={sid}; Path=/terminal; Max-Age={self.session_seconds}; '
                'HttpOnly; Secure; SameSite=Strict')

    @staticmethod
    def clear_cookie():
        return f'{COOKIE}=; Path=/terminal; Max-Age=0; HttpOnly; Secure; SameSite=Strict'


def cookie_value(headers, name):
    found = None
    for header in headers.get_all('Cookie', []):
        for part in header.split(';'):
            key, _, value = part.strip().partition('=')
            if key == name:
                if found is not None:
                    return None  # duplicate cookies: refuse rather than guess
                found = value
    if found and 8 <= len(found) <= 128 and all(c.isalnum() or c in '-_' for c in found):
        return found
    return None
