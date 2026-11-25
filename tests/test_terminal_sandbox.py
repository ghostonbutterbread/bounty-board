"""Sandbox terminal: auth, check-state storage, mount safety, evidence, sessions.

Uses the test-only LocalBackend (plain bash in the folder); the real Docker
sandbox is exercised in test_terminal_docker.py.
"""
import email.message
import json
import os
import shutil
import stat
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_auth as ta  # noqa: E402
import terminal_checks as tc  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402


def headers(**values):
    msg = email.message.Message()
    for key, value in values.items():
        for item in value if isinstance(value, list) else [value]:
            msg[key.replace('_', '-')] = item
    return msg


FAST = {'n': 2 ** 14, 'r': 8, 'p': 1}


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.now = [1000.0]
        self.record = ta.hash_password('correct horse battery', **FAST)
        self.auth = ta.Auth(allowed_users=['Ryu@Example.test'], trusted_hosts={'node.ts.net:9001'},
                            hash_record=self.record, clock=lambda: self.now[0])

    def test_hash_roundtrip_and_format(self):
        self.assertTrue(self.record.startswith('scrypt$16384$8$1$'))
        self.assertTrue(ta.verify_password(self.record, 'correct horse battery'))
        self.assertFalse(ta.verify_password(self.record, 'wrong'))
        with self.assertRaises(ta.HashFileError):
            ta.parse_hash('scrypt$1024$8$1$AAAA$BBBB')  # too weak

    def test_allowlisted_header_needs_trusted_host(self):
        ok = headers(Host='node.ts.net:9001', Tailscale_User_Login='ryu@example.test')
        self.assertEqual(self.auth.identify(ok), ('ryu@example.test', 'tailnet'))
        direct = headers(Host='127.0.0.1:9011', Tailscale_User_Login='ryu@example.test')
        self.assertEqual(self.auth.identify(direct), (None, None))
        other = headers(Host='node.ts.net:9001', Tailscale_User_Login='someone@example.test')
        self.assertEqual(self.auth.identify(other), (None, None))
        missing = headers(Host='node.ts.net:9001')
        self.assertEqual(self.auth.identify(missing), (None, None))
        doubled = headers(Host='node.ts.net:9001', Tailscale_User_Login=['ryu@example.test', 'x@y'])
        self.assertEqual(self.auth.identify(doubled), (None, None))

    def test_login_cookie_logout_and_expiry(self):
        sid, error = self.auth.login('ryushe', 'correct horse battery')
        self.assertIsNone(error)
        cookie = self.auth.session_cookie(sid)
        for flag in ('HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/terminal', 'Max-Age=43200'):
            self.assertIn(flag, cookie)
        h = headers(Host='node.ts.net:9001', Cookie=f'{ta.COOKIE}={sid}')
        self.assertEqual(self.auth.identify(h), ('ryushe', 'password'))
        self.now[0] += ta.SESSION_SECONDS + 1
        self.assertEqual(self.auth.identify(h), (None, None))
        sid, _ = self.auth.login('ryushe', 'correct horse battery')
        h = headers(Cookie=f'{ta.COOKIE}={sid}')
        self.auth.logout(h)
        self.assertEqual(self.auth.identify(h), (None, None))
        self.assertIn('Max-Age=0', ta.Auth.clear_cookie())

    def test_failures_lock_out_then_recover(self):
        self.assertEqual(self.auth.login('ryushe', 'nope')[1], 'invalid')
        self.assertEqual(self.auth.login('someoneelse', 'correct horse battery')[1], 'invalid')
        for _ in range(ta.MAX_FAILURES - 2):
            self.auth.login('ryushe', 'nope')
        self.assertEqual(self.auth.login('ryushe', 'correct horse battery')[1], 'locked')
        self.now[0] += ta.LOCKOUT_SECONDS + 1
        self.assertIsNone(self.auth.login('ryushe', 'correct horse battery')[1])

    def test_parallel_logins_are_bounded_and_respect_lockout(self):
        # Review blocker 1: no more than MAX_VERIFY scrypt runs at once; failure slots reserved first.
        import unittest.mock
        active, peak, lock = [0], [0], threading.Lock()
        real = ta.verify_password

        def counting(record, password):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            try:
                time.sleep(0.05)
                return real(record, password)
            finally:
                with lock:
                    active[0] -= 1
        results = []
        with unittest.mock.patch.object(ta, 'verify_password', counting):
            threads = [threading.Thread(target=lambda: results.append(self.auth.login('ryushe', 'nope')[1])) for _ in range(50)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        self.assertLessEqual(peak[0], ta.MAX_VERIFY)
        self.assertEqual(len(results), 50)
        self.assertTrue(set(results) <= {'invalid', 'busy', 'locked'})
        self.assertLessEqual(results.count('invalid'), ta.MAX_FAILURES)
        self.assertIn('busy', results)
        while results.count('invalid') < ta.MAX_FAILURES and self.auth.login('ryushe', 'nope')[1] == 'invalid':
            results.append('invalid')
        self.assertEqual(self.auth.login('ryushe', 'correct horse battery')[1], 'locked')
        self.assertEqual(self.auth.pending, 0)

    def test_password_disabled_without_hash(self):
        auth = ta.Auth(allowed_users=[], trusted_hosts=set())
        self.assertEqual(auth.login('ryushe', 'x')[1], 'disabled')

    def test_cookie_parsing_refuses_duplicates_and_junk(self):
        self.assertIsNone(ta.cookie_value(headers(Cookie=f'{ta.COOKIE}=aaaaaaaaaa; {ta.COOKIE}=bbbbbbbbbb'), ta.COOKIE))
        self.assertIsNone(ta.cookie_value(headers(Cookie=f'{ta.COOKIE}=<script>'), ta.COOKIE))

    def test_hash_file_permissions(self):
        base = fx.tmp_base('hash')
        path = base / 'terminal.hash'
        ta.write_hash_file(path, self.record)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(ta.read_hash_file(path), self.record)
        with self.assertRaises(FileExistsError):
            ta.write_hash_file(path, self.record)
        os.chmod(path, 0o644)
        with self.assertRaises(ta.HashFileError):
            ta.read_hash_file(path)
        link = base / 'link.hash'
        link.symlink_to(path)
        with self.assertRaises(OSError):
            ta.read_hash_file(link)
        shutil.rmtree(base)


class CheckTests(unittest.TestCase):
    def test_keys_edit_reorder_duplicates(self):
        a, b, c = 'echo one\n', 'curl -s http://x\n', 'echo three'
        keys = tc.block_keys([a, b, c])
        self.assertTrue(all(tc.KEY_RE.match(k) for k in keys))
        # Edit one block: only its key changes.
        edited = tc.block_keys([a, 'curl -sv http://x', c])
        self.assertEqual([keys[0], keys[2]], [edited[0], edited[2]])
        self.assertNotEqual(keys[1], edited[1])
        # Reorder: keys move with their blocks.
        self.assertEqual(set(tc.block_keys([c, a, b])), set(keys))
        # Duplicates are told apart by order; whitespace noise does not matter.
        dup = tc.block_keys([a, '  \necho one   \n\n', a])
        self.assertEqual([k.split(':')[1] for k in dup], ['0', '1', '2'])
        self.assertEqual(len({k.split(':')[0] for k in dup}), 1)

    def test_store_persists_and_validates(self):
        base = fx.tmp_base('checks')
        store = tc.CheckStore(base / 'c.sqlite3')
        sel, other = fx.selector(), fx.selector(fx.THIRD)
        key = tc.block_keys(['echo hi'])[0]
        self.assertTrue(store.set(sel, key, True))
        with self.assertRaises(ValueError):
            store.set(sel, 'not-a-key', True)
        store.close()
        store = tc.CheckStore(base / 'c.sqlite3')  # survives a restart
        self.assertEqual(list(store.get(sel)), [key])
        self.assertEqual(store.get(other), {})
        store.set(sel, key, False)
        self.assertEqual(store.get(sel), {})
        store.close()
        shutil.rmtree(base)

    def test_store_cap(self):
        base = fx.tmp_base('checkcap')
        store = tc.CheckStore(base / 'c.sqlite3')
        keys = tc.block_keys([f'echo {i}' for i in range(tc.MAX_KEYS_PER_REPORT + 1)])
        for key in keys[:-1]:
            store.set(fx.selector(), key, True)
        self.assertFalse(store.set(fx.selector(), keys[-1], True))
        self.assertTrue(store.set(fx.selector(), keys[0], True))  # re-marking an existing key is fine
        store.close()
        shutil.rmtree(base)


class MountTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('mount')
        self.root = fx.make_root(self.base)
        self.lane = self.root / fx.FAMILY / fx.PROGRAM / fx.LANE

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def refused(self, path, code='not_in_packet'):
        with self.assertRaises(sb.SandboxError) as caught:
            sb.resolve_mount(self.root, fx.selector(path))
        self.assertEqual(caught.exception.code, code, path)
        return caught.exception

    def test_packet_fid_rule(self):
        fids = ['D1', 'D10', 'AC', 'AC-1']
        self.assertEqual(sb.packet_fid('D1', fids), 'D1')
        self.assertEqual(sb.packet_fid('D1-sqli-login', fids), 'D1')
        self.assertEqual(sb.packet_fid('D10-xss', fids), 'D10')        # never D1
        self.assertEqual(sb.packet_fid('D1-0day', fids), 'D1')         # digits in the slug are fine
        self.assertEqual(sb.packet_fid('AC-1-idor', fids), 'AC-1')     # longest FID wins
        self.assertEqual(sb.packet_fid('AC-idor', fids), 'AC')
        for name in ('D100-x', 'D1-Bad-Slug', 'D1_odd', 'D1-', 'D1--double', 'd1-lower', 'D1-x_y', 'D1-x.y', 'D1 x', 'xD1'):
            self.assertIsNone(sb.packet_fid(name, fids), name)

    def test_rule1_report_inside_packet_mounts_packet_root(self):
        mount = sb.resolve_mount(self.root, fx.selector())
        self.assertEqual((mount.folder, mount.fid, mount.rule), ('reports/D1-sqli-login', 'D1', 'packet'))
        self.assertEqual(mount.path, str(self.lane / 'reports/D1-sqli-login'))
        self.assertTrue(mount.still_valid())
        self.assertEqual(sb.resolve_mount(self.root, fx.selector(fx.SECOND)).fid, 'D10')
        self.assertEqual(sb.resolve_mount(self.root, fx.selector(fx.THIRD)).folder, 'reports/AC-1')  # legacy <FID>/
        # Any file in the packet (EVIDENCE.md, _meta) opens the packet root.
        self.assertEqual(sb.resolve_mount(self.root, fx.selector('D1-sqli-login/EVIDENCE.md')).folder, 'reports/D1-sqli-login')

    def test_rule2_legacy_report_mounts_ledger_packet(self):
        by_name = sb.resolve_mount(self.root, fx.selector(fx.LEGACY))
        self.assertEqual((by_name.folder, by_name.fid, by_name.rule), ('reports/D10-xss', 'D10', 'ledger'))
        self.assertIn('D10', by_name.reason)
        by_path = sb.resolve_mount(self.root, fx.selector(fx.LEGACY_LEDGER))
        self.assertEqual((by_path.folder, by_path.fid), ('reports/D7-open-redirect', 'D7'))
        # A file directly in reports/ that the ledger names maps too.
        (self.lane / 'reports/D10.md').write_text('# x\n')
        self.assertEqual(sb.resolve_mount(self.root, fx.selector('D10.md')).folder, 'reports/D10-xss')

    def test_rule3_navigation_and_unmapped_are_refused_without_creating_anything(self):
        before = sorted(p.name for p in (self.lane / 'reports').iterdir())
        for path in (fx.NAVIGATION, 'index/all.md', 'findings/confirmed/Z9 - unknown.md',
                     'findings/confirmed/D5 - no packet.md',  # ledger finding whose packet folder is missing
                     'D1-Bad-Slug/x.md', 'D1_odd/x.md', 'D1-/x.md', 'D100-x/x.md', 'd1-lower/x.md', 'D1--double/x.md'):
            error = self.refused(path)
        self.assertEqual(error.message, 'This report is not inside a finding folder (reports/<FID>-…/).')
        self.assertEqual(sorted(p.name for p in (self.lane / 'reports').iterdir()), before, 'no folder was created')

    def test_ledger_report_dir_must_be_a_packet_for_that_fid(self):
        ledger = self.lane / 'ledgers/ledger.json'
        data = json.loads(ledger.read_text())
        data['findings'].append({'fid': 'D20', 'report_dir': 'reports'})                       # reports/ itself
        data['findings'].append({'fid': 'D21', 'report_dir': 'reports/D10-xss'})               # another FID's packet
        data['findings'].append({'fid': 'D22', 'report_dir': 'reports/findings/D22-x'})        # not directly under reports/
        ledger.write_text(json.dumps(data))
        (self.lane / 'reports/findings/D22-x').mkdir()
        for fid in ('D20', 'D21', 'D22'):
            (self.lane / f'reports/findings/confirmed/{fid} - x.md').write_text('# x\n')
            self.refused(f'findings/confirmed/{fid} - x.md')

    def test_refuses_symlinked_packets_and_lanes(self):
        target = self.base / 'elsewhere'
        target.mkdir()
        (target / 'x.md').write_text('# x\n')
        add = json.loads((self.lane / 'ledgers/ledger.json').read_text())
        add['findings'] += [{'fid': 'D30'}, {'fid': 'D31', 'report_dir': 'reports/D31-linked'}]
        (self.lane / 'ledgers/ledger.json').write_text(json.dumps(add))
        (self.lane / 'reports/D30').symlink_to(target)                  # symlinked packet (rule 1)
        self.refused('D30/x.md', 'report_not_found')                    # the report path itself crosses the symlink
        (self.lane / 'reports/D31-linked').symlink_to(target)           # symlinked ledger packet (rule 2)
        (self.lane / 'reports/findings/confirmed/D31 - x.md').write_text('# x\n')
        self.refused('findings/confirmed/D31 - x.md')
        (self.root / fx.FAMILY / fx.PROGRAM / 'lane2').symlink_to(self.lane)
        with self.assertRaises(sb.SandboxError):
            sb.resolve_mount(self.root, {**fx.selector(), 'lane': 'lane2'})

    def test_refuses_bad_selectors(self):
        for path in ('../x.md', '/etc/passwd.md', 'a/../../b.md', 'x.txt', '', 'a//b.md'):
            with self.assertRaises(sb.SandboxError):
                sb.clean_selector(fx.selector(path))
        for bad in ({**fx.selector(), 'lane': '..'}, {**fx.selector(), 'program': 'a/b'}, {'family': 'x'}):
            with self.assertRaises(sb.SandboxError):
                sb.clean_selector(bad)
        self.refused('D99-missing/x.md', 'report_not_found')

    def test_refuses_mount_option_injection(self):
        data = json.loads((self.lane / 'ledgers/ledger.json').read_text())
        data['findings'].append({'fid': 'Q,1'})
        (self.lane / 'ledgers/ledger.json').write_text(json.dumps(data))
        (self.lane / 'reports/Q,1').mkdir()
        (self.lane / 'reports/Q,1/EVIDENCE.md').write_text('# x\n')
        self.refused('Q,1/EVIDENCE.md', 'unsafe_folder')

    def test_moved_folder_invalidates_mount(self):
        mount = sb.resolve_mount(self.root, fx.selector())
        (self.lane / 'reports/D1-sqli-login').rename(self.lane / 'reports/D1-renamed')
        self.assertFalse(mount.still_valid())
        self.refused(fx.PRIMARY, 'report_not_found')


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('evidence')
        self.root = fx.make_root(self.base)
        self.lane = self.root / fx.FAMILY / fx.PROGRAM / fx.LANE

    def tearDown(self):
        for path in self.base.rglob('*'):
            if path.is_dir() and not path.is_symlink():
                os.chmod(path, 0o755)
        os.chmod(self.root, 0o755)
        shutil.rmtree(self.base, ignore_errors=True)

    def test_transcript_strips_ansi_and_stamps_lines(self):
        chunks = [(1700000000.0, b'\x1b[32mgreen\x1b[0m text\r\n'), (1700000001.0, b'\x1b]0;title\x07prog\r 50%\r100%\r\n'),
                  (1700000002.0, b'ab\bc\n\xe2\x9c'), (1700000003.0, b'\x93 done\n')]
        text = sb.render_transcript(chunks, title='t', started=1700000000.0, truncated=False)
        self.assertNotIn('\x1b', text)
        self.assertIn('] green text', text)
        self.assertIn('] 100%', text)
        self.assertIn('] ac', text)
        self.assertIn('] ✓ done', text)
        self.assertTrue(text.startswith('# Sandbox terminal transcript: t'))

    def test_transcript_size_cap(self):
        chunks = [(1700000000.0, b'x' * 1000 + b'\n')] * 3000
        text = sb.render_transcript(chunks, title='t', started=1700000000.0, truncated=False, limit=10000)
        self.assertLess(len(text), 12000)
        self.assertIn('Earlier output was dropped', text)

    def test_writes_new_file_in_validation(self):
        first = sb.save_evidence(self.root, fx.selector(), 'one\n', now=1700000000)
        second = sb.save_evidence(self.root, fx.selector(), 'two\n', now=1700000000)
        self.assertTrue(first.startswith('reports/D1-sqli-login/validation/terminal-'))
        self.assertNotEqual(first, second)
        self.assertEqual((self.lane / first).read_text(), 'one\n')
        self.assertEqual((self.lane / second).read_text(), 'two\n')

    def test_refuses_symlinked_validation_and_existing_symlink_target(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (self.lane / 'reports/D1-sqli-login/validation').symlink_to(outside)
        with self.assertRaises(sb.SandboxError):
            sb.save_evidence(self.root, fx.selector(), 'x\n', now=1700000000)
        self.assertEqual(list(outside.iterdir()), [])

    def test_never_overwrites_planted_symlink(self):
        validation = self.lane / 'reports/D1-sqli-login/validation'
        validation.mkdir()
        victim = self.base / 'victim.txt'
        victim.write_text('keep')
        name = 'terminal-' + time.strftime('%Y%m%d-%H%M%S', time.localtime(1700000000)) + '.txt'
        (validation / name).symlink_to(victim)
        rel = sb.save_evidence(self.root, fx.selector(), 'new\n', now=1700000000)
        self.assertNotEqual(rel.rsplit('/', 1)[-1], name)
        self.assertEqual(victim.read_text(), 'keep')

    def test_refuses_read_only_root(self):
        os.chmod(self.root, 0o555)
        try:
            with self.assertRaises(sb.SandboxError) as caught:
                sb.save_evidence(self.root, fx.selector(), 'x\n')
            self.assertEqual(caught.exception.code, 'root_not_writable')
        finally:
            os.chmod(self.root, 0o755)

    def test_refuses_read_only_folder(self):
        folder = self.lane / 'reports/D1-sqli-login'
        os.chmod(folder, 0o555)
        try:
            with self.assertRaises(sb.SandboxError) as caught:
                sb.save_evidence(self.root, fx.selector(), 'x\n')
            self.assertEqual(caught.exception.code, 'root_not_writable')
        finally:
            os.chmod(folder, 0o755)


class FakeViewer:
    def __init__(self):
        self.output = bytearray()
        self.controls = []
        self.closed = False
        self.lock = threading.Lock()

    def send_output(self, data):
        with self.lock:
            self.output += data

    def send_control(self, message):
        self.controls.append(message)

    def close(self):
        self.closed = True

    def wait_for(self, needle, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                if needle.encode() in self.output:
                    return True
            time.sleep(0.05)
        raise AssertionError(f'{needle!r} not seen; got {bytes(self.output[-400:])!r}')


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('sessions')
        self.root = fx.make_root(self.base)
        self.now = [0.0]
        self.manager = sb.SessionManager(self.root, sb.LocalBackend(self.base / 'local'), max_sessions=2, pause_after=30,
                                         remove_after=60, min_free_memory=0, clock=lambda: self.now[0], reap_interval=0)

    def tearDown(self):
        self.manager.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def test_shell_starts_in_report_folder_and_sees_live_edits(self):
        viewer = FakeViewer()
        session = self.manager.attach(fx.selector(), viewer)
        self.assertEqual(viewer.controls[0]['type'], 'hello')
        self.assertEqual(viewer.controls[0]['session']['folder'], 'reports/D1-sqli-login')
        session.write(b'pwd; python3 poc.py\n')
        viewer.wait_for('reports/D1-sqli-login')
        viewer.wait_for('poc-ran-ok')
        # An agent edits the PoC on the host: the next run uses it, no recopy.
        (self.root / fx.FAMILY / fx.PROGRAM / fx.LANE / 'reports/D1-sqli-login/poc.py').write_text('print("edited-on-host")\n')
        session.write(b'python3 poc.py\n')
        viewer.wait_for('edited-on-host')

    def test_two_viewers_share_one_shell_and_new_viewer_gets_scrollback(self):
        a, b = FakeViewer(), FakeViewer()
        session = self.manager.attach(fx.selector(), a)
        session.write(b'echo marker-$((40+2))\n')
        a.wait_for('marker-42')
        same = self.manager.attach(fx.selector(), b)
        self.assertIs(same, session)
        self.assertIn(b'marker-42', bytes(b.output))  # scrollback replayed
        same.write(b'echo from-b-$((1+1))\n')
        a.wait_for('from-b-2')
        b.wait_for('from-b-2')
        self.assertEqual(b.controls[-1], {'type': 'viewers', 'count': 2})

    def test_pause_resume_keeps_shell_then_removal_starts_fresh(self):
        viewer = FakeViewer()
        session = self.manager.attach(fx.selector(), viewer)
        self.assertEqual(viewer.controls[0]['event'], 'started')
        session.write(b'export KEEP=still-here; cd poc-sub 2>/dev/null || mkdir -p sub && cd sub\n')
        self.manager.detach(session, viewer)
        self.now[0] += 29
        self.assertEqual(self.manager.reap_idle(), ([], []))
        self.now[0] += 2
        self.assertEqual(self.manager.reap_idle(), ([session], []))
        self.assertTrue(session.paused)
        self.assertEqual(self.manager.reap_idle(), ([], []))  # idempotent: already paused
        again = FakeViewer()
        self.assertIs(self.manager.attach(fx.selector(), again), session)
        self.assertEqual(again.controls[0]['event'], 'resumed')
        self.assertFalse(session.paused)
        session.write(b'echo "$KEEP in $(basename $PWD)"\n')
        again.wait_for('still-here in sub')
        self.manager.detach(session, again)
        self.now[0] += 61
        self.assertEqual(self.manager.reap_idle(), ([], [session]))
        self.assertTrue(session.closed)
        self.assertIsNone(session.proc)
        self.assertIsNone(self.manager.get(fx.selector()))
        fresh_viewer = FakeViewer()
        fresh = self.manager.attach(fx.selector(), fresh_viewer)
        self.assertIsNot(fresh, session)
        self.assertEqual(fresh_viewer.controls[0]['event'], 'recreated_idle')

    def test_max_sessions_evicts_idle_then_refuses(self):
        a, b, c = FakeViewer(), FakeViewer(), FakeViewer()
        first = self.manager.attach(fx.selector(), a)
        self.manager.attach(fx.selector(fx.SECOND), b)
        with self.assertRaises(sb.SandboxError) as caught:
            self.manager.attach(fx.selector(fx.THIRD), c)
        self.assertEqual(caught.exception.code, 'too_many_sessions')
        self.manager.detach(first, a)
        third = self.manager.attach(fx.selector(fx.THIRD), c)  # removes the viewerless one
        self.assertTrue(first.closed)
        self.assertEqual(third.folder, 'reports/AC-1')

    def test_reset_restarts_shell_and_keeps_viewers(self):
        viewer = FakeViewer()
        session = self.manager.attach(fx.selector(), viewer)
        session.write(b'export GONE=1; echo before-reset\n')
        viewer.wait_for('before-reset')
        old_id = session.id
        self.manager.reset(fx.selector())
        self.assertNotEqual(session.id, old_id)
        self.assertIn({'type': 'reset'}, viewer.controls)
        self.assertEqual(viewer.controls[-1]['type'], 'hello')
        self.assertEqual(bytes(session.scrollback).count(b'before-reset'), 0)
        session.write(b'echo "gone=[${GONE:-unset}]"\n')
        viewer.wait_for('gone=[unset]')

    def test_shell_exit_respawns_on_enter(self):
        viewer = FakeViewer()
        session = self.manager.attach(fx.selector(), viewer)
        session.write(b'exit\n')
        viewer.wait_for('Shell exited')
        deadline = time.time() + 5
        while session.proc is not None and time.time() < deadline:
            time.sleep(0.05)
        session.write(b'\r')
        session.write(b'echo back-$((2*3))\n')
        viewer.wait_for('back-6')

    def test_close_stops_everything(self):
        viewer = FakeViewer()
        session = self.manager.attach(fx.selector(), viewer)
        proc = session.proc
        self.manager.close()
        self.assertTrue(viewer.closed)
        self.assertIsNotNone(proc.poll())
        with self.assertRaises(sb.SandboxError):
            self.manager.attach(fx.selector(), FakeViewer())

    def test_folder_move_is_reported_to_new_viewers(self):
        session = self.manager.attach(fx.selector(), FakeViewer())
        lane = self.root / fx.FAMILY / fx.PROGRAM / fx.LANE
        (lane / 'reports/D1-sqli-login').rename(lane / 'reports/finding-z')
        (lane / 'reports/D1-sqli-login').mkdir()
        (lane / 'reports' / fx.PRIMARY).write_text('# new\n')
        late = FakeViewer()
        self.manager.attach(fx.selector(), late)
        self.assertIn('folder_moved', late.controls[0]['session']['notes'])
        self.assertIs(self.manager.get(fx.selector()), session)

    def test_evidence_from_session_transcript(self):
        viewer = FakeViewer()
        session = self.manager.attach(fx.selector(), viewer)
        session.write(b'printf "\\033[31mred-evidence\\033[0m\\n"\n')
        viewer.wait_for('red-evidence')
        rel = sb.save_evidence(self.root, fx.selector(), session.transcript_text())
        text = (self.root / fx.FAMILY / fx.PROGRAM / fx.LANE / rel).read_text()
        self.assertIn('red-evidence', text)
        self.assertNotIn('\x1b', text)


class FakeDocker:
    """Backend double: real PTY running `sleep`, scripted container state."""

    def __init__(self):
        self.containers = {}  # session id -> 'running' | 'paused'
        self.calls = []
        self.pause_gate = None  # threading.Event: pause blocks until set
        self.pause_started = threading.Event()
        self.fail_pause = 0
        self.stale = ['bbterm-old1']

    def create(self, session):
        self.calls.append(('create', session.id))
        self.containers[session.id] = 'running'

    def shell_argv(self, session):
        return ['sleep', '600']

    def shell_cwd(self, session):
        return session.mount.path

    def shell_env(self):
        return None

    def _need(self, session):
        if session.id not in self.containers:
            raise sb.SandboxVanished('No such container')

    def pause(self, session):
        self.calls.append(('pause', session.id))
        self.pause_started.set()
        if self.pause_gate is not None:
            self.pause_gate.wait(5)
        if self.fail_pause:
            self.fail_pause -= 1
            raise sb.SandboxError('pause_failed', 'daemon busy')
        self._need(session)
        self.containers[session.id] = 'paused'

    def unpause(self, session):
        self.calls.append(('unpause', session.id))
        self._need(session)
        self.containers[session.id] = 'running'

    def state(self, session):
        return self.containers.get(session.id)

    def destroy(self, session):
        self.calls.append(('destroy', session.id))
        self.containers.pop(session.id, None)

    def reap_stale(self):
        names, self.stale = self.stale, []
        return names


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('lifecycle')
        self.root = fx.make_root(self.base)
        fx.add_findings(self.root, [f'L{i}' for i in range(4)])
        self.now = [0.0]
        self.free = [8 * 1024 ** 3]
        self.docker = FakeDocker()
        self.logs = []
        self.manager = self.make()

    def make(self, **kw):
        options = dict(max_sessions=3, pause_after=300, remove_after=4 * 3600, min_free_memory=2 * 1024 ** 3,
                       clock=lambda: self.now[0], reap_interval=0, mem_available=lambda: self.free[0], log=self.logs.append)
        options.update(kw)
        return sb.SessionManager(self.root, self.docker, **options)

    def tearDown(self):
        self.manager.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def open(self, i):
        viewer = FakeViewer()
        return self.manager.attach(fx.selector(f'L{i}/EVIDENCE.md'), viewer), viewer

    def test_defaults_and_restart_cleanup(self):
        manager = sb.SessionManager(self.root, FakeDocker(), reap_interval=0)
        self.assertEqual((manager.max_sessions, manager.pause_after, manager.remove_after, manager.min_free_memory),
                         (12, 300, 14400, 2 * 1024 ** 3))
        self.assertEqual(manager.reaped_on_start, ['bbterm-old1'])  # leftovers from the previous run
        manager.close()
        self.assertEqual(sb.SessionManager(self.root, FakeDocker(), idle_timeout=900, reap_interval=0).remove_after, 900)

    def test_grace_pause_resume_remove(self):
        session, viewer = self.open(0)
        self.now[0] += 1000
        self.assertEqual(self.manager.reap_idle(), ([], []), 'never paused while a viewer is attached')
        self.manager.detach(session, viewer)
        self.now[0] += 299
        self.assertEqual(self.manager.reap_idle(), ([], []), 'grace period')
        self.now[0] += 1
        self.assertEqual(self.manager.reap_idle(), ([session], []))
        self.assertEqual(self.docker.containers[session.id], 'paused')
        proc = session.proc
        same, viewer2 = self.open(0)
        self.assertIs(same, session)
        self.assertIs(session.proc, proc, 'same shell process')
        self.assertEqual(viewer2.controls[0]['event'], 'resumed')
        self.assertEqual(self.docker.containers[session.id], 'running')
        self.manager.detach(session, viewer2)
        self.now[0] += 300
        self.manager.reap_idle()
        self.now[0] += 4 * 3600 - 300
        self.assertEqual(self.manager.reap_idle(), ([], [session]), 'removed 4 h after the last viewer left, even paused')
        self.assertNotIn(session.id, self.docker.containers)
        fresh, viewer3 = self.open(0)
        self.assertIsNot(fresh, session)
        self.assertEqual(viewer3.controls[0]['event'], 'recreated_idle')
        self.assertEqual(self.manager.reap_idle(), ([], []))

    def test_attach_during_pause_ends_running(self):
        session, viewer = self.open(0)
        self.manager.detach(session, viewer)
        self.now[0] += 301
        self.docker.pause_gate = threading.Event()
        reaper = threading.Thread(target=self.manager.reap_idle)
        reaper.start()
        self.assertTrue(self.docker.pause_started.wait(5))
        result = {}
        attacher = threading.Thread(target=lambda: result.update(s=self.open(0)))
        attacher.start()
        time.sleep(0.2)
        self.assertTrue(attacher.is_alive(), 'attach waits for the in-flight pause')
        self.docker.pause_gate.set()
        reaper.join(5)
        attacher.join(5)
        same, viewer2 = result['s']
        self.assertIs(same, session)
        self.assertFalse(session.paused)
        self.assertEqual(self.docker.containers[session.id], 'running')
        self.assertEqual(viewer2.controls[0]['event'], 'resumed')
        self.assertEqual(self.manager.reap_idle(), ([], []), 'a viewer is attached now')

    def test_failed_pause_is_logged_and_retried(self):
        session, viewer = self.open(0)
        self.manager.detach(session, viewer)
        self.now[0] += 301
        self.docker.fail_pause = 1
        self.assertEqual(self.manager.reap_idle(), ([], []))
        self.assertFalse(session.paused)
        self.assertTrue(any('pause failed' in line for line in self.logs))
        self.assertEqual(self.manager.reap_idle(), ([session], []))

    def test_unpause_after_vanish_recreates(self):
        session, viewer = self.open(0)
        session._output(b'old-output')
        self.manager.detach(session, viewer)
        self.now[0] += 301
        self.manager.reap_idle()
        old_id = session.id
        del self.docker.containers[old_id]  # removed outside the service
        same, viewer2 = self.open(0)
        self.assertEqual(viewer2.controls[0]['event'], 'recreated_vanished')
        self.assertNotEqual(same.id, old_id)
        self.assertEqual(self.docker.containers[same.id], 'running')
        self.assertNotIn(b'old-output', bytes(same.scrollback))

    def test_running_container_vanished_is_recreated_on_attach(self):
        session, viewer = self.open(0)
        self.manager.detach(session, viewer)
        del self.docker.containers[session.id]
        same, viewer2 = self.open(0)
        self.assertEqual(viewer2.controls[0]['event'], 'recreated_vanished')
        self.assertIn(same.id, self.docker.containers)

    def test_pause_of_vanished_container_counts_as_removed(self):
        session, viewer = self.open(0)
        self.manager.detach(session, viewer)
        del self.docker.containers[session.id]
        self.now[0] += 301
        self.assertEqual(self.manager.reap_idle(), ([], [session]))
        self.assertIsNone(self.manager.get(fx.selector('L0/EVIDENCE.md')))

    def test_capacity_prefers_paused_then_running_never_attached(self):
        s0, v0 = self.open(0)
        s1, v1 = self.open(1)
        s2, v2 = self.open(2)
        self.manager.detach(s0, v0)       # left first, running
        self.now[0] += 10
        self.manager.detach(s1, v1)       # left later, will be paused
        self.now[0] += 400
        self.manager.reap_idle()
        self.assertTrue(s0.paused and s1.paused)
        self.docker.containers[s0.id] = 'running'; s0.paused = False  # make s0 a running viewerless one
        s3, _ = self.open(3)
        self.assertTrue(s1.closed, 'the paused one goes first even though s0 left earlier')
        self.assertFalse(s0.closed)
        self.assertFalse(s2.closed)
        s4, _ = self.open(1)
        self.assertTrue(s0.closed, 'then the running viewerless one')
        with self.assertRaises(sb.SandboxError) as caught:
            self.open(0)
        self.assertEqual(caught.exception.code, 'too_many_sessions')
        self.assertIn('All 3 sandboxes', caught.exception.message)
        self.assertFalse(s2.closed or s3.closed or s4.closed)

    def test_memory_guard_refuses_new_but_allows_resume(self):
        session, viewer = self.open(0)
        self.manager.detach(session, viewer)
        self.now[0] += 301
        self.manager.reap_idle()
        self.free[0] = int(1.5 * 1024 ** 3)
        with self.assertRaises(sb.SandboxError) as caught:
            self.open(1)
        self.assertEqual(caught.exception.code, 'low_memory')
        self.assertEqual(caught.exception.message, 'Hoster is low on memory (1.5 GB free); close a terminal or try later.')
        self.assertIsNone(self.manager.get(fx.selector('L1/EVIDENCE.md')))
        same, viewer2 = self.open(0)
        self.assertEqual(viewer2.controls[0]['event'], 'resumed')
        self.free[0] = None  # unknown (no /proc/meminfo): allowed
        self.open(1)

    def test_mem_available_parser(self):
        meminfo = self.base / 'meminfo'
        meminfo.write_text('MemTotal:       16000000 kB\nMemAvailable:    2048000 kB\n')
        self.assertEqual(sb.read_mem_available(str(meminfo)), 2048000 * 1024)
        self.assertIsNone(sb.read_mem_available(str(self.base / 'missing')))

    def test_detached_viewer_and_removal_race_reopens_cleanly(self):
        session, viewer = self.open(0)
        self.manager.detach(session, viewer)
        self.now[0] += 4 * 3600
        self.manager.reap_idle()
        again, viewer2 = self.open(0)
        self.assertFalse(again.closed)
        self.assertEqual(viewer2.controls[0]['event'], 'recreated_idle')
        self.manager.detach(again, viewer2)
        self.manager.detach(again, viewer2)  # double detach is harmless


if __name__ == '__main__':
    unittest.main()
