"""Synthetic tests for scope_check.py and the scope fields of the recon payloads.

Everything is fictional (*.example.test); BBH is a fake script in a temp
directory outside the Board root (tests/scope_check_fixture.py)."""
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

import app
import recon_intel as ri
import scope_check as sc
from tests import scope_check_fixture as fx
from tests.recon_intel_fixture import make_js_library, make_lane, make_url_index
from tests.test_recon_intel import tree_snapshot

HOSTS = ['app.acme.example.test', 'api.acme.example.test', 'blog.acme.example.test', 'evil.example.test',
         'files.acme.example.test', 'docs.acme.example.test']


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='scope-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'root'
        self.root.mkdir()
        self.bbh = fx.write_fake_bbh(self.base / 'bin')
        fx.make_scope(self.root, 'acme', include=['*.acme.example.test', 'https://docs.acme.example.test/api/*'],
                      exclude=['blog.acme.example.test', 'https://files.acme.example.test/private/*'])
        # docs is matched by *.acme too; make it partial-only by a narrower program
        fx.make_scope(self.root, 'narrow', include=['https://docs.acme.example.test/api/*'])

    def checker(self, bbh='default', **kw):
        return sc.ScopeChecker(lambda: self.root, self.bbh if bbh == 'default' else bbh, **kw)


class ScopeCheckerTests(Base):
    def test_classify_then_cache_hit_without_subprocess(self):
        c = self.checker()
        verdicts, summary, missing = c.lookup('acme', HOSTS)
        self.assertEqual(summary['state'], 'pending')
        self.assertEqual(missing, HOSTS)
        self.assertTrue(all(v['state'] == 'unchecked' and v['reason'] == sc.PENDING for v in verdicts.values()))
        self.assertEqual(c.classify('acme', HOSTS), len(HOSTS))
        self.assertEqual(len(fx.calls(self.bbh)), 1)
        verdicts, summary, missing = c.lookup('acme', HOSTS)
        self.assertEqual((summary['state'], missing), ('checked', []))
        self.assertEqual(verdicts['app.acme.example.test'], {'state': 'in', 'rule': '*.acme.example.test', 'reason': 'matches *.acme.example.test'})
        self.assertEqual(verdicts['blog.acme.example.test']['state'], 'out')
        self.assertEqual(verdicts['blog.acme.example.test']['reason'], 'excluded by blog.acme.example.test')
        self.assertEqual(verdicts['evil.example.test'], {'state': 'out', 'rule': None, 'reason': 'no in-scope rule matches'})
        self.assertEqual(verdicts['files.acme.example.test']['state'], 'partial')
        # Cached: further lookups and passes start no subprocess.
        for _ in range(5):
            c.lookup('acme', HOSTS)
            self.assertEqual(c.classify('acme', HOSTS), 0)
        self.assertEqual(len(fx.calls(self.bbh)), 1)
        self.assertEqual(c.calls, 1)

    def test_urls_are_decided_exactly(self):
        c = self.checker()
        urls = ['https://files.acme.example.test/private/x', 'https://files.acme.example.test/public/y',
                'https://docs.acme.example.test/api/v1?a=1', 'https://docs.acme.example.test/blog']
        c.classify('narrow', urls + ['docs.acme.example.test'])
        v, _, _ = c.lookup('narrow', urls + ['docs.acme.example.test'])
        self.assertEqual(v['docs.acme.example.test']['state'], 'partial')
        self.assertEqual([v[u]['state'] for u in urls[2:]], ['in', 'out'])
        c.classify('acme', urls)
        v, _, _ = c.lookup('acme', urls)
        self.assertEqual([v[u]['state'] for u in urls[:2]], ['out', 'in'])
        self.assertNotIn('partial', {x['state'] for u, x in v.items()})

    def test_new_host_sends_only_the_delta(self):
        c = self.checker()
        c.classify('acme', HOSTS[:4])
        c.classify('acme', HOSTS)
        self.assertEqual([call['targets'] for call in fx.calls(self.bbh)], [4, 2])

    def test_scope_file_change_reclassifies_everything(self):
        c = self.checker()
        c.classify('acme', HOSTS)
        scope = self.root / 'scopes' / 'acme' / 'out-of-scope.txt'
        scope.write_text(scope.read_text() + 'app.acme.example.test\n')
        os.utime(scope, ns=(time.time_ns() + 10**9, time.time_ns() + 10**9))
        _, summary, missing = c.lookup('acme', HOSTS)
        self.assertEqual(summary['state'], 'pending')
        self.assertEqual(missing, HOSTS)
        c.classify('acme', HOSTS)
        self.assertEqual([call['targets'] for call in fx.calls(self.bbh)], [6, 6])
        v, summary, _ = c.lookup('acme', HOSTS)
        self.assertEqual(v['app.acme.example.test']['state'], 'out')
        # A new excluded.txt counts too.
        (self.root / 'scopes' / 'acme' / 'excluded.txt').write_text('api.acme.example.test\n')
        self.assertEqual(c.lookup('acme', HOSTS)[1]['state'], 'pending')

    def test_alias_inside_allowed_outside_refused(self):
        (self.root / 'scopes' / 'acme-alias').symlink_to('acme')
        outside = self.base / 'elsewhere' / 'acme'
        outside.mkdir(parents=True)
        (outside / 'in-scope.txt').write_text('*.example.test\n')
        (self.root / 'scopes' / 'acme-out').symlink_to(outside)
        c = self.checker()
        self.assertEqual(c.scope_dir('acme-alias')[0], (self.root / 'scopes' / 'acme').resolve())
        c.classify('acme-alias', HOSTS)
        v, summary, _ = c.lookup('acme-alias', HOSTS)
        self.assertEqual((summary['state'], v['blog.acme.example.test']['state']), ('checked', 'out'))
        directory, reason = c.scope_dir('acme-out')
        self.assertIsNone(directory)
        self.assertIn('outside', reason)
        self.assertEqual(c.classify('acme-out', HOSTS), 0)
        # A scope that exists but cannot be read is a failed check (copy disabled), never open scope.
        v, summary, missing = c.lookup('acme-out', HOSTS)
        self.assertEqual((summary['state'], missing), ('failed', []))
        self.assertIn('outside', summary['reason'])
        self.assertTrue(all(x['state'] == 'unchecked' and x['reason'].startswith('scope check failed:') for x in v.values()))
        self.assertEqual(len(fx.calls(self.bbh)), 1)
        (self.root / 'scopes' / 'broken').symlink_to('nowhere')
        self.assertEqual(c.lookup('broken', HOSTS)[1]['state'], 'failed')
        self.assertIn('broken', c.lookup('broken', HOSTS)[1]['reason'])

    def test_same_size_same_mtime_replacement_reclassifies(self):
        # Sync tools and atomic renames can keep size and the source mtime; the verdicts must not go stale.
        directory = self.root / 'scopes' / 'acme'
        target = directory / 'in-scope.txt'
        before, dir_before = os.stat(target), os.stat(directory)
        c = self.checker()
        c.classify('acme', HOSTS)
        self.assertEqual(c.lookup('acme', HOSTS)[0]['app.acme.example.test']['state'], 'in')
        text = target.read_text()
        replacement = text.replace('acme', 'acmf')
        self.assertEqual(len(replacement), len(text))
        tmp = directory / '.replacement'
        tmp.write_text(replacement)
        os.utime(tmp, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(tmp, target)
        os.utime(directory, ns=(dir_before.st_atime_ns, dir_before.st_mtime_ns))
        self.assertEqual(os.stat(target).st_size, before.st_size)
        verdicts, summary, missing = c.lookup('acme', HOSTS)
        self.assertEqual(summary['state'], 'pending')
        self.assertIn('app.acme.example.test', missing)

    def test_missing_scope_is_no_scope_without_subprocess(self):
        c = self.checker()
        v, summary, missing = c.lookup('initech', HOSTS)
        self.assertEqual((summary['state'], missing), ('no_scope', []))
        self.assertTrue(all(x == {'state': 'unchecked', 'rule': None, 'reason': 'no scope on file'} for x in v.values()))
        self.assertEqual(c.classify('initech', HOSTS), 0)
        self.assertEqual(fx.calls(self.bbh), [])
        # An invalid name is refused (fail closed), never read as open scope.
        self.assertEqual(c.lookup('../acme', HOSTS)[1]['state'], 'failed')
        self.assertEqual(fx.calls(self.bbh), [])

    def test_empty_scope_dir_is_no_scope(self):
        fx.make_scope(self.root, 'hollow', include=[])
        c = self.checker()
        c.classify('hollow', HOSTS)
        v, summary, missing = c.lookup('hollow', HOSTS)
        self.assertEqual((summary['state'], missing), ('no_scope', []))
        self.assertEqual(v[HOSTS[0]]['reason'], 'no scope on file')
        self.assertEqual(c.classify('hollow', HOSTS + ['new.example.test']), 0)
        self.assertEqual(len(fx.calls(self.bbh)), 1)

    def test_failures_mark_unchecked_and_retry_later(self):
        for mode, needle in (('fail', 'exited 3 (scope file unreadable)'), ('badjson', 'invalid JSON'),
                             ('wrongcount', 'returned 5 results for 6 targets'), ('timeout', 'did not answer within 0.5 s')):
            with self.subTest(mode=mode):
                fx.set_mode(self.bbh, mode)
                c = self.checker(timeout=0.5, retry_interval=60)
                c.classify('acme', HOSTS)
                v, summary, missing = c.lookup('acme', HOSTS)
                self.assertEqual(summary['state'], 'failed')
                self.assertTrue(summary['reason'].startswith('scope check failed: '), summary['reason'])
                self.assertIn(needle, summary['reason'])
                self.assertEqual(missing, [])  # not due yet: no retry storm from polling
                self.assertTrue(all(x['state'] == 'unchecked' and x['reason'].startswith('scope check failed: ') for x in v.values()))
                c.retry_interval = 0
                fx.set_mode(self.bbh, 'ok')
                self.assertEqual(c.lookup('acme', HOSTS)[2], HOSTS)
                c.classify('acme', HOSTS)
                self.assertEqual(c.lookup('acme', HOSTS)[1]['state'], 'checked')

    def test_unconfigured(self):
        c = self.checker(bbh=None)
        v, summary, missing = c.lookup('acme', HOSTS)
        self.assertEqual((summary['state'], missing), ('unconfigured', []))
        self.assertTrue(all(x['state'] == 'unchecked' and x['reason'].startswith('scope check failed: ') for x in v.values()))
        self.assertEqual(c.classify('acme', HOSTS), 0)
        # No scope on file wins: such programs run open scope.
        self.assertEqual(c.lookup('initech', HOSTS)[1]['state'], 'no_scope')

    def test_failure_logged_once_per_signature(self):
        fx.set_mode(self.bbh, 'fail')
        c = self.checker(retry_interval=0)
        from io import StringIO
        from unittest.mock import patch
        with patch('sys.stderr', new_callable=StringIO) as err:
            c.classify('acme', HOSTS)
            c.classify('acme', HOSTS)
        self.assertEqual(err.getvalue().count('scope check for'), 1)
        self.assertEqual(len(fx.calls(self.bbh)), 2)

    def test_hostile_rule_text_is_display_safe(self):
        fx.make_scope(self.root, 'odd', include=['*.acme.example.test'], exclude=['blog.acme.example.test‮'])
        c = self.checker()
        c.classify('odd', ['blog.acme.example.test‮'])
        v, _, _ = c.lookup('odd', ['blog.acme.example.test‮'])
        self.assertIn('\\u202e', v['blog.acme.example.test‮']['rule'])
        self.assertNotIn('‮', v['blog.acme.example.test‮']['reason'])

    def test_nothing_written_under_root(self):
        before = tree_snapshot(self.root)
        c = self.checker()
        c.classify('acme', HOSTS)
        c.lookup('acme', HOSTS)
        fx.set_mode(self.bbh, 'fail')
        c.forget('acme')
        c.classify('acme', HOSTS)
        self.assertEqual(tree_snapshot(self.root), before)

    def test_two_thousand_hosts_under_one_second(self):
        hosts = [f'h{i}.acme.example.test' for i in range(1990)] + [f'x{i}.other.example.test' for i in range(10)]
        c = self.checker()
        started = time.monotonic()
        c.classify('acme', hosts)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.0)
        started = time.monotonic()
        v, summary, _ = c.lookup('acme', hosts)
        self.assertLess(time.monotonic() - started, 0.1)
        self.assertEqual(sum(1 for x in v.values() if x['state'] == 'in'), 1990)
        self.assertEqual(c.calls, 1)


def recon_service(root, bbh, **kw):
    checker = sc.ScopeChecker(lambda: Path(root), bbh)
    svc = ri.ReconIntel(lambda: Path(root), lambda r: app.discover(r, inventory_only=True), app.read_file, app.ledger,
                        app.coverage, app.map_entries, artifact_root=None, scope=checker, **kw)
    return svc, checker


def settle(test, svc, fn, rounds=6):
    """Call fn until the payload is no longer partial (each call may queue background work)."""
    body = fn()
    for _ in range(rounds):
        test.assertTrue(svc.wait_idle(60))
        body = fn()
        if not body['partial']:
            return body
    return body


class ReconScopeTests(Base):
    def setUp(self):
        super().setUp()
        lane = make_lane(self.root, 'globex-demo', 'web', url_index=False, js_shared=False)
        make_url_index(lane / 'recon/url_index/url_index.sqlite',
                       hosts={'shop.example.test': 140, 'cdn.example.test': 20, 'auth.example.test': 12}, tests=True,
                       tests_host='shop.example.test')
        make_js_library(lane / 'recon/js/_library/js_info.sqlite', hosts={'cdn.example.test': 4, 'shop.example.test': 6})
        fx.make_scope(self.root, 'globex-demo', include=['*.example.test'],
                      exclude=['shop.example.test', 'https://cdn.example.test/private/*'])
        make_lane(self.root, 'acme-demo', 'web')  # no scope dir: open scope

    def test_program_payload_scope_fields(self):
        svc, checker = recon_service(self.root, self.bbh)
        self.addCleanup(svc.close)
        body = settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web'))
        self.assertFalse(body['partial'])
        s = body['scope_summary']
        self.assertEqual(s['state'], 'checked')
        self.assertIsInstance(s['checked_at'], float)
        # Host rows also list finding hosts from the ledger (app/api.example.test, no URL counts).
        self.assertEqual((s['in'], s['out'], s['partial'], s['unchecked']), (3, 1, 1, 0))
        self.assertEqual((s['hosts'], s['in_scope_hosts']), (5, 4))
        self.assertEqual(s['in_scope_urls'], {'value': 32, 'approximate': False, 'method': 'host_counts'})
        rows = {r['host']: r for r in body['hosts']['rows']}
        self.assertEqual(rows['shop.example.test']['scope'], {'state': 'out', 'rule': 'shop.example.test', 'reason': 'excluded by shop.example.test'})
        self.assertFalse(rows['shop.example.test']['under_tested'])  # OOS surface is never "under-tested"
        self.assertEqual(rows['cdn.example.test']['scope']['state'], 'partial')
        self.assertEqual(rows['auth.example.test']['scope']['state'], 'in')
        self.assertEqual(body['hosts']['out_of_scope'], 1)
        self.assertNotIn('all_rows', body['hosts'])
        det = body['sources']['url_index']['result']['detail']
        self.assertNotIn('host_list', body['sources']['url_index']['result'])
        for name in ('recent_tests', 'recent_observations', 'untested_params'):
            for item in det[name]:
                self.assertIn(item['scope']['state'], ('in', 'out'), name)  # URLs are decided exactly
        shop_tests = [t for t in det['recent_tests'] if 'shop.example.test' in t['url']]
        self.assertTrue(shop_tests and all(t['scope']['state'] == 'out' for t in shop_tests))
        js = body['sources']['js']['result']['detail']
        self.assertEqual({h['host']: h['scope']['state'] for h in js['hosts']}, {'cdn.example.test': 'partial', 'shop.example.test': 'out'})
        self.assertTrue(all('scope' in o for o in js['open_observations']))
        # The cached source results were not modified by the annotation.
        cached = svc.cache[('url_index', str(self.root / 'web_bounty/globex-demo/web/recon/url_index/url_index.sqlite'))]['result']
        self.assertNotIn('scope', cached['detail']['recent_tests'][0])
        # Cached requests: no further subprocess calls.
        calls = checker.calls
        for _ in range(3):
            svc.program('web_bounty', 'globex-demo', 'web')
            svc.overview()
        self.assertTrue(svc.wait_idle(30))
        svc.program('web_bounty', 'globex-demo', 'web')
        self.assertEqual(checker.calls, calls)

    def test_one_subprocess_per_program_per_pass(self):
        svc, checker = recon_service(self.root, self.bbh)
        self.addCleanup(svc.close)
        settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web'))
        # Hosts then items: at most one call each time the worker runs a scope job for the program.
        programs = [c['program'] for c in fx.calls(self.bbh)]
        self.assertEqual(set(programs), {'globex-demo'})
        self.assertLessEqual(len(programs), 2)
        overview = settle(self, svc, svc.overview)
        self.assertEqual([c['program'] for c in fx.calls(self.bbh)], programs)  # acme-demo has no scope: never called
        rows = {r['program']: r for r in overview['programs']}
        self.assertEqual(rows['acme-demo']['scope']['state'], 'no_scope')
        self.assertIsNone(rows['acme-demo']['in_scope_urls'])
        g = rows['globex-demo']
        self.assertEqual((g['scope']['in_scope_hosts'], g['scope']['hosts']), (2, 3))
        self.assertEqual(g['in_scope_urls'], {'value': 32, 'approximate': False, 'method': 'host_counts'})
        self.assertEqual(g['in_scope_js_files']['value'], 4)

    def test_overview_without_program_view_scales_by_host_share(self):
        svc, checker = recon_service(self.root, self.bbh)
        self.addCleanup(svc.close)
        overview = settle(self, svc, svc.overview)
        g = {r['program']: r for r in overview['programs']}['globex-demo']
        self.assertEqual(g['scope']['state'], 'checked')
        self.assertEqual(g['in_scope_urls'], {'value': round(172 * 2 / 3), 'approximate': True, 'method': 'host_share'})
        self.assertEqual(g['in_scope_js_files']['method'], 'host_share')
        self.assertEqual(len(fx.calls(self.bbh)), 1)

    def test_refresh_reclassifies(self):
        svc, checker = recon_service(self.root, self.bbh)
        self.addCleanup(svc.close)
        settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web'))
        before = len(fx.calls(self.bbh))
        settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web', refresh=True), rounds=1)
        settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web'))
        self.assertGreater(len(fx.calls(self.bbh)), before)

    def test_failed_check_does_not_hide_or_poll_forever(self):
        fx.set_mode(self.bbh, 'fail')
        svc, checker = recon_service(self.root, self.bbh)
        self.addCleanup(svc.close)
        body = settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web'))
        self.assertFalse(body['partial'])
        self.assertEqual(body['scope_summary']['state'], 'failed')
        self.assertIsNone(body['scope_summary']['in_scope_urls'])
        rows = {r['host']: r for r in body['hosts']['rows']}
        self.assertEqual(rows['shop.example.test']['scope']['state'], 'unchecked')
        self.assertTrue(rows['shop.example.test']['scope']['reason'].startswith('scope check failed: '))

    def test_no_bbh_is_unconfigured(self):
        svc, checker = recon_service(self.root, None)
        self.addCleanup(svc.close)
        body = settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web'))
        self.assertEqual(body['scope_summary']['state'], 'unconfigured')
        open_scope = settle(self, svc, lambda: svc.program('web_bounty', 'acme-demo', 'web'))
        self.assertEqual(open_scope['scope_summary']['state'], 'no_scope')
        self.assertEqual({r['scope']['reason'] for r in open_scope['hosts']['rows']}, {'no scope on file'})

    def test_recon_read_writes_nothing_under_root(self):
        before = tree_snapshot(self.root)
        svc, checker = recon_service(self.root, self.bbh)
        self.addCleanup(svc.close)
        settle(self, svc, svc.overview)
        settle(self, svc, lambda: svc.program('web_bounty', 'globex-demo', 'web'))
        self.assertEqual(tree_snapshot(self.root), before)

    def test_two_thousand_host_index_background_cost(self):
        lane = make_lane(self.root, 'big-demo', 'web', url_index=False, findings=False)
        db_path = make_url_index(lane / 'recon/url_index/url_index.sqlite', hosts={'seed.big.example.test': 1}, tests=False)
        db = sqlite3.connect(db_path)
        db.executemany("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen) "
                       "VALUES (?, ?, 'r', 'p', ?, '/', '[]', 'gen', 'a', 'b')",
                       [(f'https://h{i}.big.example.test/', f'b{i}', f'h{i}.big.example.test') for i in range(2000)])
        db.commit()
        db.close()
        fx.make_scope(self.root, 'big-demo', include=['*.big.example.test'], exclude=['h7.big.example.test'])
        timings = {}
        for name, bbh in (('without', None), ('with', self.bbh)):
            svc = ri.ReconIntel(lambda: self.root, lambda r: app.discover(r, inventory_only=True), app.read_file, app.ledger,
                                app.coverage, app.map_entries, scope=sc.ScopeChecker(lambda: self.root, bbh) if bbh else None)
            self.addCleanup(svc.close)
            started = time.monotonic()
            body = settle(self, svc, lambda: svc.program('web_bounty', 'big-demo', 'web'))
            timings[name] = time.monotonic() - started
            self.assertFalse(body['partial'])
        self.assertEqual(body['scope_summary']['out'], 1)
        self.assertEqual(body['scope_summary']['in'], 2000)
        self.assertLess(timings['with'] - timings['without'], 1.0, timings)


if __name__ == '__main__':
    unittest.main()


class OverviewShareApproximation(unittest.TestCase):
    def test_host_share_keeps_the_source_approximation(self):
        summary = {'state': 'checked', 'checked_at': 1, 'reason': ''}
        url = {'host_list': ['a.example.test'], 'urls': {'value': 1000, 'approximate': True}}
        js = {'files': {'value': 10, 'approximate': True}}
        fields = sc.overview_fields(summary, {'a.example.test': {'state': 'in'}}, url, js)
        self.assertEqual(fields['in_scope_urls']['value'], 1000)
        self.assertTrue(fields['in_scope_urls']['approximate'])
        self.assertTrue(fields['in_scope_js_files']['approximate'])
        exact = sc.overview_fields(summary, {'a.example.test': {'state': 'in'}},
                                   {'host_list': ['a.example.test'], 'urls': {'value': 1000, 'approximate': False}}, None)
        self.assertFalse(exact['in_scope_urls']['approximate'])
