"""Scope panel reader (scope_inventory.py) and GET /api/scope. Synthetic data only (*.example.test)."""
import http.client
import json
import os
import re
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

import app
from tests.fixture_preferences import make_server as make_test_server
import scope_inventory as si
from scope_inventory import ScopeInventory
from tests.scope_panel_fixture import DAY, iso, make_acme, make_root, write

UNSAFE = re.compile('[\x00-\x1f\x7f-\x9f­؜​‎‏‪-‮⁠-⁩  ﻿]')


def snapshot(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            path = Path(dirpath) / name
            info = path.lstat()
            out[str(path.relative_to(root))] = (info.st_mode, info.st_size, info.st_mtime_ns)
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='scope-inv-'))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.root = self.base / 'root'
        self.now = time.time()
        make_root(self.root, self.now)
        self.inv = ScopeInventory(lambda: self.root, ('apk', 'exe', 'mac'), now=lambda: self.now)

    def scopes(self, program='acme-demo'):
        return self.root / 'scopes' / program


class PayloadTests(Base):
    def test_full_inventory(self):
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(d['scope']['state'], 'loaded')
        self.assertEqual(d['inventory']['state'], 'ok')
        self.assertEqual(d['inventory']['count'], 24)
        self.assertEqual(d['rules']['source'], 'inventory')
        self.assertEqual(d['rules']['in']['count'], 14)
        self.assertEqual(d['rules']['out']['count'], 4)
        self.assertIn('https://acme.example.test/careers/*', d['rules']['out']['items'])
        kinds = [a['kind'] for a in d['assets']]
        self.assertEqual(kinds, ['android_app', 'ios_app', 'executable', 'source_code', 'other', 'mystery_kind'])
        self.assertTrue(all('future_key' not in a for a in d['assets']))  # unknown keys ignored
        self.assertIn('Acme demo policy', d['policy']['text'])
        f = d['freshness']
        self.assertEqual((f['age_days'], f['stale'], f['estimated'], f['source']), (34, True, False, 'scope-pull.json'))
        self.assertTrue(f['failed'])
        self.assertEqual(f['last_error'], 'HTTP 429 from platform')
        self.assertTrue(d['copy_safe'])
        json.dumps(d, allow_nan=False)

    def test_lane_links_and_lane_stale(self):
        assets = {a['kind']: a for a in self.inv.payload('web_bounty', 'acme-demo')['assets']}
        self.assertEqual(assets['android_app']['lane'], {'program': 'binaries/acme-demo', 'lane': 'apk',
                                                         'updated_ts': assets['android_app']['lane']['updated_ts']})
        self.assertAlmostEqual(assets['android_app']['lane']['updated_ts'], self.now - 12 * DAY, delta=2)
        self.assertTrue(assets['android_app']['release']['lane_stale'])     # changed 5 d ago, lane file 12 d old
        self.assertEqual(assets['executable']['lane']['lane'], 'exe')
        self.assertFalse(assets['executable']['release']['lane_stale'])    # no change observed
        self.assertIsNone(assets['ios_app']['lane'])                       # no ios/app lane discovered
        self.assertFalse(assets['ios_app']['release']['lane_stale'])
        self.assertEqual(assets['executable']['release']['error'], 'no download URL')
        self.assertIsNone(assets['source_code']['lane'])
        # A newer top-level file in the apk lane clears the warning (stat only, no parse needed).
        os.utime(write(self.root / 'binaries/acme-demo/apk/new.apk', 'x'), (self.now, self.now))
        assets = {a['kind']: a for a in self.inv.payload('web_bounty', 'acme-demo')['assets']}
        self.assertFalse(assets['android_app']['release']['lane_stale'])

    def test_lane_scan_is_top_level_only_and_ignores_symlinks(self):
        apk = self.root / 'binaries/acme-demo/apk'
        os.utime(write(apk / 'input/deep.apk', 'x'), (self.now, self.now))
        outside = write(self.base / 'outside.apk', 'x')
        os.utime(outside, (self.now, self.now))
        (apk / 'link.apk').symlink_to(outside)
        lanes = self.inv.lane_info(self.root, 'acme-demo')
        self.assertAlmostEqual(lanes['apk'], self.now - 12 * DAY, delta=2)

    def test_lane_symlink_is_not_linked(self):
        shutil.rmtree(self.root / 'binaries/acme-demo/apk')
        (self.root / 'binaries/acme-demo/apk').symlink_to(self.base)
        assets = {a['kind']: a for a in self.inv.payload('web_bounty', 'acme-demo')['assets']}
        self.assertIsNone(assets['android_app']['lane'])

    def test_no_inventory_falls_back_to_text_rules(self):
        d = self.inv.payload('web_bounty', 'globex-demo')
        self.assertEqual(d['inventory']['state'], 'missing')
        self.assertEqual(d['rules']['source'], 'txt')
        self.assertEqual(d['rules']['in']['items'], ['*.globex.example.test', 'shop.globex.example.test'])  # comments, blanks dropped
        self.assertEqual(d['rules']['out']['items'], ['admin.globex.example.test'])
        self.assertEqual(d['assets'], [])
        self.assertEqual(d['history']['entries'], [])
        self.assertIn('Globex policy', d['policy']['text'])
        f = d['freshness']
        self.assertTrue(f['estimated'])
        self.assertEqual(f['source'], 'in-scope.txt')
        self.assertFalse(f['stale'])

    def test_estimate_prefers_assets_json_mtime(self):
        old = self.now - 9 * DAY
        os.utime(write(self.scopes('globex-demo') / 'assets.json', '{}'), (old, old))
        f = self.inv.payload('web_bounty', 'globex-demo')['freshness']
        self.assertEqual((f['source'], f['age_days'], f['stale'], f['estimated']), ('assets.json', 9, True, True))

    def test_pulled_at_null_uses_estimate(self):
        write(self.scopes() / 'scope-pull.json', {'version': 1, 'pulled_at': None, 'last_attempt_status': 'ok'})
        f = self.inv.payload('web_bounty', 'acme-demo')['freshness']
        self.assertTrue(f['estimated'])
        self.assertEqual(f['source'], 'in-scope.txt')

    def test_stale_boundary(self):
        for days, stale in ((6.9, False), (7.0, True), (0, False)):
            write(self.scopes() / 'scope-pull.json', {'pulled_at': iso(self.now - days * DAY), 'last_attempt_status': 'ok'})
            f = self.inv.payload('web_bounty', 'acme-demo')['freshness']
            self.assertEqual(f['stale'], stale, days)
            self.assertFalse(f['failed'])

    def test_no_scope_dir(self):
        d = self.inv.payload('web_bounty', 'initech-demo')
        self.assertEqual(d['scope'], {'state': 'none', 'reason': 'no scope on file'})
        self.assertNotIn('rules', d)

    def test_alias_inside_allowed_outside_refused(self):
        (self.root / 'scopes' / 'acme-alias').symlink_to(self.scopes())
        d = self.inv.payload('web_bounty', 'acme-alias')
        self.assertEqual(d['scope']['state'], 'loaded')
        self.assertTrue(d['scope']['alias'])
        self.assertEqual(d['rules']['in']['count'], 14)
        outside = self.base / 'outside-scope'
        make_acme(self.base / 'elsewhere', self.now)
        (self.root / 'scopes' / 'evil-demo').symlink_to(self.base / 'elsewhere' / 'scopes' / 'acme-demo')
        d = self.inv.payload('web_bounty', 'evil-demo')
        self.assertEqual(d['scope']['state'], 'failed')
        self.assertIn('outside', d['scope']['reason'])
        (self.root / 'scopes' / 'broken-demo').symlink_to(outside)
        self.assertEqual(self.inv.payload('web_bounty', 'broken-demo')['scope']['state'], 'failed')

    def test_file_links_outside_scopes_are_refused(self):
        secret = write(self.base / 'secret.md', '# private notes')
        policy = self.scopes() / 'program-policy.md'
        policy.unlink()
        policy.symlink_to(secret)
        (self.scopes() / 'scope-history.jsonl').unlink()
        (self.scopes() / 'scope-history.jsonl').symlink_to(secret)
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertIsNone(d['policy'])
        self.assertIn('outside', d['files']['program-policy.md']['error'])
        self.assertEqual(d['files']['scope-history.jsonl']['state'], 'unreadable')
        self.assertNotIn('private notes', json.dumps(d))
        # A link to another file inside <root>/scopes is followed.
        policy.unlink()
        policy.symlink_to(self.scopes('globex-demo') / 'program-policy.md')
        self.assertIn('Globex policy', self.inv.payload('web_bounty', 'acme-demo')['policy']['text'])

    def test_malformed_files_give_per_file_errors(self):
        write(self.scopes() / 'scope-pull.json', '{nope')
        write(self.scopes() / 'scope-items.json', '[1, 2]')
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(d['files']['scope-pull.json']['state'], 'invalid')
        self.assertEqual(d['files']['scope-items.json']['state'], 'invalid')
        self.assertEqual(d['inventory']['state'], 'invalid')
        self.assertEqual(d['rules']['source'], 'txt')          # rules still shown from the text files
        self.assertEqual(d['rules']['in']['count'], 14)
        self.assertIsNotNone(d['policy'])
        self.assertTrue(d['freshness']['estimated'])
        write(self.scopes() / 'scope-items.json', {'items': 'nope'})
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(d['files']['scope-items.json']['state'], 'invalid')
        # Item entries that are not objects or lack kind/identifier are skipped.
        write(self.scopes() / 'scope-items.json', {'items': [1, {'kind': 'android_app'}, {'kind': 'cloud', 'identifier': 'bucket-x'}]})
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual([a['identifier'] for a in d['assets']], ['bucket-x'])
        self.assertEqual(d['inventory']['skipped'], 2)

    def test_oversized_files_are_refused_per_file(self):
        write(self.scopes() / 'program-policy.md', 'x' * (si.CAPS['program-policy.md'] + 1))
        write(self.scopes() / 'scope-items.json', '{"items": []}' + ' ' * si.CAPS['scope-items.json'])
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(d['files']['program-policy.md']['state'], 'too_large')
        self.assertIsNone(d['policy'])
        self.assertEqual(d['files']['scope-items.json']['state'], 'too_large')
        self.assertEqual(d['rules']['source'], 'txt')
        self.assertEqual(d['freshness']['age_days'], 34)

    def test_history_tail_order_cap_and_baseline(self):
        d = self.inv.payload('web_bounty', 'acme-demo')
        entries = d['history']['entries']
        self.assertEqual(entries[0]['state'], 'invalid')        # last line malformed, newest first
        self.assertEqual([e['source'] for e in entries[1:]], ['pull', 'pull', 'baseline'])
        self.assertEqual(entries[1]['added_count'], 2)
        self.assertEqual(entries[1]['release_changed'][0]['signal'], 'Updated on Nov 20, 2026')
        self.assertEqual(entries[2]['changed'][0], {'key': 'web_host:status.acme.example.test', 'field': 'in_scope', 'from': True, 'to': False})
        self.assertFalse(d['history']['more'])
        lines = [json.dumps({'at': iso(self.now - i), 'source': 'pull', 'added': [{'key': f'web_host:h{i}.example.test', 'kind': 'web_host',
                                                                                     'name': f'h{i}.example.test', 'in_scope': True}]}) for i in range(500, 0, -1)]
        write(self.scopes() / 'scope-history.jsonl', '\n'.join(lines) + '\n')
        d = self.inv.payload('web_bounty', 'acme-demo')
        entries = d['history']['entries']
        self.assertEqual(len(entries), si.HISTORY_LINES)
        self.assertEqual(entries[0]['added'][0]['name'], 'h1.example.test')
        self.assertEqual(entries[-1]['added'][0]['name'], 'h20.example.test')
        self.assertTrue(d['history']['more'])

    def test_history_reads_only_the_tail(self):
        big = 'x' * 1000
        lines = [json.dumps({'at': iso(self.now), 'source': 'pull', 'pad': big, 'added': [{'name': f'n{i}'}]}) for i in range(2000)]
        write(self.scopes() / 'scope-history.jsonl', '\n'.join(lines) + '\n')
        real_open = open
        reads = []

        class Spy:
            def __init__(self, handle): self.h = handle
            def __enter__(self): return self
            def __exit__(self, *a): self.h.close()
            def seek(self, n): reads.append(('seek', n)); return self.h.seek(n)
            def read(self, n=-1): data = self.h.read(n); reads.append(('read', len(data))); return data

        def spy_open(path, mode='r', *a, **k):
            handle = real_open(path, mode, *a, **k)
            return Spy(handle) if str(path).endswith('scope-history.jsonl') else handle
        si.open = spy_open
        try:
            entries = self.inv.payload('web_bounty', 'acme-demo')['history']['entries']
        finally:
            del si.open
        self.assertEqual(entries[0]['added'][0]['name'], 'n1999')
        self.assertLessEqual(sum(n for op, n in reads if op == 'read'), si.HISTORY_TAIL_BYTES)
        self.assertGreater(next(n for op, n in reads if op == 'seek'), 0)

    def test_unsafe_characters_escaped(self):
        write(self.scopes() / 'in-scope.txt', 'evil‮.example.test\n')
        d = self.inv.payload('web_bounty', 'acme-demo')
        blob = json.dumps(d, ensure_ascii=False)
        self.assertIsNone(UNSAFE.search(blob.replace('\\n', '')), 'raw unsafe character in payload')
        other = {a['kind']: a for a in d['assets']}['mystery_kind']
        self.assertEqual(other['identifier'], 'thing-\\u202eevil')
        self.assertEqual(other['name'], 'Unknown \\x1b[31mkind')
        self.assertIn('\\u202eevil\\u202c', d['policy']['text'])
        self.assertIn('\\x1b[201~', d['policy']['text'])
        self.assertIn('\n', d['policy']['text'])      # line structure kept for Markdown
        self.assertNotIn('\x1b', d['policy']['text'])

    def test_unsafe_program_name_is_not_copy_safe(self):
        d = self.inv.payload('web_bounty', 'acme\x1b-demo')
        self.assertFalse(d['copy_safe'])
        self.assertEqual(d['program'], 'acme\\x1b-demo')


class CacheTests(Base):
    def test_signature_cache_hit_and_invalidation(self):
        self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(self.inv.parses, 1)
        self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(self.inv.parses, 1)
        # Same size and same mtime, different content: inode/ctime change still invalidates.
        path = self.scopes() / 'scope-pull.json'
        info = path.stat()
        replacement = path.with_name('scope-pull.json.tmp')
        replacement.write_text(path.read_text().replace('HTTP 429', 'HTTP 503'))
        os.utime(replacement, ns=(info.st_atime_ns, info.st_mtime_ns))
        os.replace(replacement, path)
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(self.inv.parses, 2)
        self.assertEqual(d['freshness']['last_error'], 'HTTP 503 from platform')
        # Appending to the history and creating a new file both invalidate.
        with open(self.scopes() / 'scope-history.jsonl', 'a') as handle:
            handle.write(json.dumps({'at': iso(self.now), 'source': 'pull', 'removed': [{'name': 'gone.example.test'}]}) + '\n')
        d = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(self.inv.parses, 3)
        self.assertEqual(d['history']['entries'][0]['removed'][0]['name'], 'gone.example.test')
        write(self.scopes('globex-demo') / 'scope-items.json', {'items': []})
        self.inv.payload('web_bounty', 'globex-demo')
        self.inv.payload('web_bounty', 'globex-demo')
        self.assertEqual(self.inv.parses, 4)
        self.inv.payload('web_bounty', 'acme-demo', refresh=True)
        self.assertEqual(self.inv.parses, 5)

    def test_ages_are_computed_per_request_from_cache(self):
        d1 = self.inv.payload('web_bounty', 'acme-demo')
        self.now += 3 * DAY
        d2 = self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(self.inv.parses, 1)
        self.assertEqual(d2['freshness']['age_days'], d1['freshness']['age_days'] + 3)

    def test_cached_payload_not_mutated_by_lane_info(self):
        self.inv.payload('web_bounty', 'acme-demo')
        cached = self.inv.cache['acme-demo'][1]
        self.assertTrue(all('lane' not in a for a in cached['assets']))


class ReadOnlyTests(Base):
    def test_nothing_written_under_root(self):
        before = snapshot(self.root)
        for program in ('acme-demo', 'globex-demo', 'initech-demo', 'missing-demo'):
            self.inv.payload('web_bounty', program)
            self.inv.payload('binaries', program, refresh=True)
        self.assertEqual(snapshot(self.root), before)


class HttpTests(Base):
    def setUp(self):
        super().setUp()
        self.server = make_test_server(self.root, port=0, artifact_root=self.base / 'absent')
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)

    def get(self, params, host=None, raw=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', '/api/scope' + (raw if raw is not None else f'?{urlencode(params)}'),
                         headers={'Host': host or f'127.0.0.1:{self.port}'})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_endpoint(self):
        before = snapshot(self.root)
        status, body = self.get({'family': 'web_bounty', 'program': 'acme-demo'})
        self.assertEqual(status, 200)
        self.assertEqual(body['rules']['in']['count'], 14)
        self.assertEqual(self.get({'family': 'binaries', 'program': 'acme-demo', 'refresh': '1'})[0], 200)
        self.assertEqual(self.get({'family': 'web_bounty', 'program': 'initech-demo'})[1]['scope']['state'], 'none')
        self.assertEqual(snapshot(self.root), before)

    def test_rejections(self):
        self.assertEqual(self.get({'family': 'web_bounty', 'program': 'acme-demo'}, host='evil.example')[0], 403)
        for params in ({'family': 'web_bounty'}, {'family': 'nope', 'program': 'acme-demo'},
                       {'family': 'web_bounty', 'program': '../etc'}, {'family': 'web_bounty', 'program': '..'},
                       {'family': 'web_bounty', 'program': 'acme-demo', 'refresh': '2'},
                       {'family': 'web_bounty', 'program': 'acme-demo', 'x': '1'}, {'family': 'web_bounty', 'program': ''}):
            self.assertEqual(self.get(params)[0], 400, params)
        self.assertEqual(self.get(None, raw='?family=web_bounty&program=a&program=b')[0], 400)


def _history_line(at, **kw):
    import json as _json
    return _json.dumps({'at': at, 'source': 'pull', 'added': [], 'removed': [], 'changed': [], 'release_changed': [], **kw})


class ReviewOneTests(unittest.TestCase):
    """Independent review 1 of the scope panel (minor findings 1-4)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='sp-review-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.d = self.root / 'scopes' / 'acme-demo'
        self.d.mkdir(parents=True)
        (self.d / 'in-scope.txt').write_text('*.acme.example.test\n')
        self.inv = si.ScopeInventory(lambda: self.root, ('apk', 'exe', 'mac'))

    def test_partial_last_line_is_not_shown_as_newest_entry(self):
        (self.d / 'scope-history.jsonl').write_text(
            _history_line('2026-11-20T00:00:00Z') + '\n' + _history_line('2026-11-21T00:00:00Z') + '\n' + '{"at": "2026-11-22T0')
        entries = self.inv.payload('web_bounty', 'acme-demo')['history']['entries']
        self.assertEqual([e['state'] for e in entries], ['ok', 'ok'])

    def test_huge_single_line_reports_unreadable_not_empty(self):
        (self.d / 'scope-history.jsonl').write_text(_history_line('2026-11-20T00:00:00Z', note='x' * 300_000) + '\n')
        entries = self.inv.payload('web_bounty', 'acme-demo')['history']['entries']
        self.assertEqual([(e['state'], e.get('error')) for e in entries], [('invalid', 'line too long')])

    def test_lane_scan_skipped_without_linkable_assets(self):
        lane = self.root / 'binaries' / 'acme-demo' / 'apk'
        lane.mkdir(parents=True)
        for i in range(50):
            (lane / f'f{i}').write_text('x')
        self.inv.payload('web_bounty', 'acme-demo')
        real = os.scandir
        with mock.patch.object(si.os, 'scandir', side_effect=lambda p: real(p)) as spy:
            self.inv.payload('web_bounty', 'acme-demo')
        self.assertEqual(spy.call_count, 0)

    def test_undiscovered_program_names_are_not_read(self):
        for name in ('_archived', '.hidden'):
            hidden = self.root / 'scopes' / name
            hidden.mkdir()
            (hidden / 'in-scope.txt').write_text('secret.example.test\n')
            d = self.inv.payload('web_bounty', name)
            self.assertEqual(d['scope']['state'], 'failed')
            self.assertNotIn('rules', d)


if __name__ == '__main__':
    unittest.main()
