"""URL browser (GET /api/recon/urls, /api/recon/url) and BBH URL marks (POST /api/recon/mark).

Synthetic roots under TMPDIR only. A fake BBH implements `url_ingest.py mark`
the way BBH does (database at $HOME/Shared/web_bounty/<program>/web/recon/
url_index/url_index.sqlite); one test runs the real BBH url_ingest.py."""
import http.client
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

import app
import recon_intel as ri
from tests.recon_intel_fixture import make_lane, make_large_url_index

BBH_SOURCE = Path(os.environ.get('BBH_SOURCE', '/home/ryushe/projects/bbh-merge-hotpath'))

FAKE_RECON_WRITER = r'''#!PYTHON
import json, os, sqlite3, sys, time
from datetime import datetime, timezone
from pathlib import Path
args = sys.argv[1:]
if '--help' in args:
    if args[0] == 'agents/url_ingest.py':
        print(os.environ.get('FAKE_INGEST_HELP', 'usage: url_ingest.py [-h] {init,ingest,aggregate,status,mark,history,next,params,search,brief,stats} program '
              '--url --lane --status --param --param-location --notes --agent-id --skill --test-family --evidence'))
    else:
        print('--edit-finding --patch-file --root --family --lane')
    sys.exit(0)
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write(json.dumps(args) + '\n')
mode = Path(os.environ['FAKE_MODE']).read_text().strip() if Path(os.environ['FAKE_MODE']).exists() else 'ok'
if mode == 'fail':
    sys.exit(3)
if mode == 'timeout':
    time.sleep(10)
def opt(name):
    for arg in args:
        if arg.startswith(name + '='):
            return arg[len(name) + 1:]
    return None
assert args[:2] == ['agents/url_ingest.py', 'mark'], args
program = args[2]
db = sqlite3.connect(Path(os.environ['HOME']) / 'Shared' / 'web_bounty' / program / 'web' / 'recon' / 'url_index' / 'url_index.sqlite')
now = datetime.now(timezone.utc).isoformat()
url = opt('--url')
row = db.execute('SELECT id FROM urls WHERE canonical_url = ?', (url,)).fetchone()
if not row or mode == 'newurl':
    db.execute("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen) "
               "VALUES (?, ?, 'r', 'p', 'x', '/', '[]', 'mark-unknown', ?, ?)", (url + ('#new' if mode == 'newurl' else ''), 'new' + now, now, now))
    url_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
else:
    url_id = row[0]
status = 'dismissed' if mode == 'wrong' else opt('--status')
lane, param = opt('--lane'), opt('--param') or ''
db.execute('INSERT INTO test_runs (url_id, lane, param_key, param_location, skill, test_family, status, agent_id, notes, started_at, completed_at) '
           "VALUES (?, ?, ?, ?, 'manual', 'general-review', ?, ?, ?, ?, ?)", (url_id, lane, param, opt('--param-location'), status, opt('--agent-id'), opt('--notes'), now, now))
if mode == 'concurrent':
    # An agent marks the same URL while the Board's BBH call runs.
    db.execute('INSERT INTO test_runs (url_id, lane, param_key, skill, test_family, status, agent_id, started_at, completed_at) '
               "VALUES (?, 'xss', 'q', 'manual', 'general-review', 'dismissed', 'agent-x', ?, ?)", (url_id, now, now))
if db.execute('SELECT id FROM observations WHERE url_id = ? AND lane = ? AND param_key = ?', (url_id, lane, param)).fetchone():
    db.execute('UPDATE observations SET status = ?, notes = ?, created_at = ? WHERE url_id = ? AND lane = ? AND param_key = ?',
               (status, opt('--notes'), now, url_id, lane, param))
else:
    db.execute('INSERT INTO observations (url_id, lane, param_key, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
               (url_id, lane, param, status, opt('--notes'), now))
db.commit()
db.close()
'''.replace('PYTHON', sys.executable)

# The real BBH url_ingest.py from a BBH checkout; the manual_hunter capability probe
# is stubbed (it needs the bounty_core package the real `bbh` dispatcher provides).
REAL_BBH_LAUNCHER = r'''#!/bin/sh
if [ "$1" = "agents/manual_hunter.py" ] && [ "$2" = "--help" ]; then echo "--edit-finding --patch-file --root --family --lane"; exit 0; fi
cd "BBH_SOURCE" && exec "PYTHON" "$@"
'''


class Base(unittest.TestCase):
    writer = False
    real_bbh = False

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recon-urls-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / 'home'
        self.root = self.home / 'Shared'
        self.root.mkdir(parents=True)
        self.lane = make_lane(self.root)
        self.db = self.lane / 'recon/url_index/url_index.sqlite'
        env = mock.patch.dict(os.environ, {'HOME': str(self.home), 'FAKE_LOG': str(self.base / 'writer.log'),
                                           'FAKE_MODE': str(self.base / 'mode')})
        env.start()
        self.addCleanup(env.stop)
        writer = None
        if self.writer:
            writer = self.base / 'bbh'
            writer.write_text((REAL_BBH_LAUNCHER.replace('BBH_SOURCE', str(BBH_SOURCE)) if self.real_bbh else FAKE_RECON_WRITER)
                              .replace('PYTHON', sys.executable))
            writer.chmod(0o700)
        self.server = app.make_server(self.root, 0, writer=writer, accept_uncoordinated_writes=writer is not None)
        self.server.writer_timeout = 2
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, params=None, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
            base = {'Host': f'127.0.0.1:{self.port}'}
            if method == 'POST':
                base.update({'Origin': f'http://127.0.0.1:{self.port}', 'X-Requested-With': 'Bounty-Board', 'Content-Type': 'application/json',
                             'Sec-Fetch-Site': 'same-origin'})
            conn.request(method, path + (f'?{urlencode(params)}' if params else ''), body=data, headers={**base, **(headers or {})})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def urls(self, **params):
        return self.request('GET', '/api/recon/urls', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', **params})

    def root_instance(self):
        # Read once: /api/data stops reporting it after a failed write disables the writer.
        if not getattr(self, '_root_instance', None):
            self._root_instance = self.request('GET', '/api/data', {'phase': 'identity'})[1]['root_instance']
        return self._root_instance


class UrlListTests(Base):
    def walk(self, order, **filters):
        seen, cursor, pages = [], 0, 0
        while True:
            status, body = self.urls(order=order, cursor=cursor, limit=17, **filters)
            self.assertEqual(status, 200)
            self.assertEqual(body['order'], order)
            seen += [i['id'] for i in body['items']]
            pages += 1
            if body['done']:
                return seen, pages
            cursor = body['next']

    def test_keyset_pages_cover_every_url_once(self):
        seen, pages = self.walk('asc')
        self.assertEqual(seen, sorted(set(seen)))
        self.assertEqual(len(seen), 98)
        self.assertEqual(pages, 6)
        item = self.urls(limit=1)[1]['items'][0]
        self.assertEqual(set(item), {'id', 'url', 'host', 'path', 'params', 'first_seen', 'last_seen', 'lanes', 'tests', 'last_test', 'unsafe_chars'})

    def test_newest_first_by_default_and_both_directions_cover_every_url_once(self):
        first = self.urls(limit=5)[1]
        self.assertEqual(first['order'], 'desc')
        self.assertEqual([i['id'] for i in first['items']], [98, 97, 96, 95, 94])
        down, pages = self.walk('desc')
        self.assertEqual(down, sorted(set(down), reverse=True))
        self.assertEqual(len(down), 98)
        self.assertEqual(pages, 6)
        up, _ = self.walk('asc')
        self.assertEqual(sorted(up), sorted(down))

    def test_id_gaps_and_filters_in_both_directions(self):
        db = sqlite3.connect(self.db)
        db.execute('DELETE FROM urls WHERE id BETWEEN 10 AND 40 OR id IN (2, 77, 98)')
        db.commit()
        expected = [r[0] for r in db.execute('SELECT id FROM urls ORDER BY id')]
        hosted = [r[0] for r in db.execute("SELECT id FROM urls WHERE host = 'app.example.test' ORDER BY id")]
        db.close()
        for order in ('asc', 'desc'):
            with self.subTest(order=order):
                seen, _ = self.walk(order)
                self.assertEqual(seen, expected if order == 'asc' else expected[::-1])
                seen, _ = self.walk(order, host='app.example.test')
                self.assertEqual(sorted(seen), hosted)
                self.assertEqual(len(seen), len(set(seen)))

    def test_filters(self):
        ids = lambda **f: [i['id'] for i in self.urls(limit=100, **f)[1]['items']]
        self.assertEqual(len(ids(host='app.example.test')), 60)
        self.assertEqual(len(ids(host='static.example.test')), 8)
        self.assertEqual(len(ids(params='1')), 49)
        self.assertEqual(len(ids(param='file')), len(ids(q='?file=')))
        self.assertTrue(ids(param='file'))
        self.assertEqual(ids(q='NO-SUCH-TEXT'), [])
        self.assertEqual(len(ids(status='tested')), 4)
        self.assertEqual(len(ids(status='untested')), 94)
        self.assertEqual(len(ids(status='surface_reviewed')), 1)
        self.assertEqual(len(ids(status='surface_reviewed', test_lane='xss')), 1)
        self.assertEqual(ids(status='surface_reviewed', test_lane='ssrf'), [])
        self.assertEqual(len(ids(test_lane='open-redirect')), 1)
        self.assertEqual(len(ids(status='untested', test_lane='xss')), 97)
        tested = self.urls(status='tested', limit=100)[1]['items']
        xss = [i for i in tested if any(l['lane'] == 'xss' for l in i['lanes'])][0]
        self.assertEqual(xss['tests'], 1)
        self.assertEqual(xss['lanes'][0]['status'], 'surface_reviewed')
        # LIKE wildcards in the text filter are literal.
        self.assertEqual(ids(q='%'), [])

    def test_history(self):
        tested = self.urls(status='tested', test_lane='open-redirect')[1]['items'][0]
        status, body = self.request('GET', '/api/recon/url', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'id': tested['id']})
        self.assertEqual(status, 200)
        self.assertEqual(body['test_runs'][0]['lane'], 'open-redirect')
        self.assertEqual(body['test_runs'][0]['evidence_path'], '/elsewhere/out.txt')
        self.assertEqual(body['observations'][0]['status'], 'deep_reviewed')
        self.assertEqual(self.request('GET', '/api/recon/url', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'id': 99999})[0], 404)

    def test_rejections(self):
        self.assertEqual(self.urls(status='bogus')[0], 400)
        self.assertEqual(self.urls(limit='500')[0], 400)
        self.assertEqual(self.urls(cursor='-1')[0], 400)
        self.assertEqual(self.urls(order='sideways')[0], 400)
        self.assertEqual(self.urls(after='5')[0], 400)
        self.assertEqual(self.urls(offset='10')[0], 400)
        self.assertEqual(self.urls(test_lane='X;1')[0], 400)
        self.assertEqual(self.request('GET', '/api/recon/urls', {'family': 'web_bounty', 'program': '../etc', 'lane': 'web'})[0], 400)
        self.assertEqual(self.request('GET', '/api/recon/urls', {'family': 'web_bounty', 'program': 'nope', 'lane': 'web'})[0], 404)
        self.assertEqual(self.request('GET', '/api/recon/urls', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web'},
                                      headers={'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/recon/url', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web'})[0], 400)

    def test_missing_index_says_where(self):
        os.unlink(self.db)
        status, body = self.urls()
        self.assertEqual(status, 200)
        self.assertEqual(body['error']['code'], 'missing')
        self.assertTrue(body['expected'].endswith('acme-demo/web/recon/url_index/url_index.sqlite'))

    def test_unsafe_values_are_escaped_and_flagged(self):
        db = sqlite3.connect(self.db)
        db.execute("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen) "
                   "VALUES (?, 'hx', 'r', 'p', ?, '/', ?, 's', 'a', 'b')",
                   ('https://evil\u202e.example.test/?\x1b[201~=1', 'evil\u202e.example.test', json.dumps(['\x1b[201~'])))
        db.commit()
        db.close()
        item = self.urls(host='evil\u202e.example.test')[1]['items'][0]
        self.assertTrue(item['unsafe_chars'])
        self.assertEqual(item['host'], 'evil\\u202e.example.test')
        self.assertEqual(item['params'], ['\\x1b[201~'])
        self.assertIsNone(ri.UNSAFE_CHARS.search(json.dumps(item, ensure_ascii=False)))

    def test_concurrency_cap(self):
        svc = self.server.recon
        svc.url_slots.acquire()
        svc.url_slots.acquire()
        try:
            self.assertEqual(self.urls()[0], 503)
        finally:
            svc.url_slots.release()
            svc.url_slots.release()


class LargeIndexTests(unittest.TestCase):
    """Sparse filters on a big table: bounded pages that continue where they stopped."""

    def test_sparse_filter_is_budgeted_and_resumable(self):
        with tempfile.TemporaryDirectory(prefix='recon-big-') as tmp:
            path = make_large_url_index(Path(tmp) / 'big.sqlite', rows=400_000, hosts=40)
            started = time.monotonic()
            # Small windows and a tiny budget force the page to stop early.
            with mock.patch.object(ri, 'URL_SCAN_FIRST', 100), mock.patch.object(ri, 'URL_SCAN_MAX', 200):
                page = ri.list_urls(path, {'q': 'NO-SUCH-TEXT'}, 0, 50, budget=0.002, order='asc')
            self.assertLess(time.monotonic() - started, 2.0)
            self.assertEqual(page['items'], [])
            self.assertFalse(page['done'])
            self.assertIn(page['partial'], ('budget', 'timeout'))
            self.assertLess(page['next'], 400_000)
            cursor, rounds = page['next'], 0
            while True:
                rounds += 1
                page = ri.list_urls(path, {'q': 'NO-SUCH-TEXT'}, cursor, 50, budget=2.0, order='asc')
                if page['done'] or rounds > 50:
                    break
                self.assertGreaterEqual(page['next'], cursor)
                cursor = page['next']
            self.assertTrue(page['done'])
            # An unfiltered page is one small window and returns at once.
            started = time.monotonic()
            page = ri.list_urls(path, {}, 123_456, 50, order='asc')
            self.assertEqual([i['id'] for i in page['items']], list(range(123_457, 123_507)))
            self.assertLess(time.monotonic() - started, 2.0)
            # Newest first: the same bounded windows going down, resumable to the start.
            with mock.patch.object(ri, 'URL_SCAN_FIRST', 100), mock.patch.object(ri, 'URL_SCAN_MAX', 200):
                page = ri.list_urls(path, {'q': 'NO-SUCH-TEXT'}, 0, 50, budget=0.002)
            self.assertEqual((page['order'], page['done']), ('desc', False))
            self.assertGreater(page['next'], 1)
            cursor, rounds = page['next'], 0
            while True:
                rounds += 1
                page = ri.list_urls(path, {'q': 'NO-SUCH-TEXT'}, cursor, 50, budget=2.0)
                if page['done'] or rounds > 50:
                    break
                self.assertLessEqual(page['next'], cursor)
                cursor = page['next']
            self.assertTrue(page['done'])
            page = ri.list_urls(path, {}, 123_456, 50)
            self.assertEqual([i['id'] for i in page['items']], list(range(123_455, 123_405, -1)))
            top = ri.list_urls(path, {}, 0, 3)
            self.assertEqual([i['id'] for i in top['items']], [400_000, 399_999, 399_998])
            host = ri.list_urls(path, {'host': 'h7.example.test'}, 0, 20)
            self.assertTrue(all(i['host'] == 'h7.example.test' for i in host['items']))
            self.assertEqual(len(host['items']), 20)


class MarkTests(Base):
    writer = True

    def mark(self, item=None, **fields):
        # The synthetic index repeats some canonical URLs (BBH's unique url_hash prevents that);
        # static.example.test URLs are unique, so the fake resolves the same row BBH would.
        item = item or self.urls(status='untested', host='static.example.test', limit=1)[1]['items'][0]
        body = {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'root_instance': self.root_instance(),
                'url_id': item['id'], 'url': item['url'], 'test_lane': 'ssrf', 'status': 'surface_reviewed', **fields}
        body = {k: v for k, v in body.items() if v is not None}
        return item, self.request('POST', '/api/recon/mark', body=body)

    def log(self):
        path = self.base / 'writer.log'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_capability_advertised(self):
        caps = self.request('GET', '/api/data')[1]['capabilities']['ledger_actions']['url_mark']
        self.assertTrue(caps['enabled'])
        self.assertEqual(caps['statuses'], list(ri.MARK_STATUSES))
        self.assertEqual(caps['board_lane'], 'web')

    def test_mark_writes_the_database_the_view_reads_and_refreshes(self):
        svc = self.server.recon
        svc.program('web_bounty', 'acme-demo', 'web')
        self.assertTrue(svc.wait_idle(30))
        before = svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']
        self.assertEqual(before['result']['tested_urls']['value'], 4)
        item, (status, body) = self.mark(param='id', param_location='query', notes='checked with owned account')
        self.assertEqual(status, 200, body)
        self.assertEqual(self.log()[-1], ['agents/url_ingest.py', 'mark', 'acme-demo', f'--url={item["url"]}', '--lane=ssrf',
                                          '--status=surface_reviewed', '--agent-id=bounty-board', '--param=id', '--param-location=query',
                                          '--notes=checked with owned account'])
        self.assertEqual(body['item']['id'], item['id'])
        self.assertEqual(body['item']['tests'], 1)
        self.assertEqual(body['item']['lanes'][0], {'lane': 'ssrf', 'param_key': 'id', 'status': 'surface_reviewed', 'at': body['item']['lanes'][0]['at']})
        self.assertEqual(body['url']['test_runs'][0]['notes'], 'checked with owned account')
        # The summary is recomputed now, not after the 120 s refresh interval.
        self.assertTrue(svc.wait_idle(30))
        after = svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']
        self.assertEqual(after['result']['tested_urls']['value'], 5)
        self.assertGreater(after['computed_at'], before['computed_at'])
        self.assertEqual(self.urls(status='surface_reviewed', test_lane='ssrf')[1]['items'][0]['id'], item['id'])

    def test_agent_mark_during_the_call_does_not_fail_the_board_mark(self):
        (self.base / 'mode').write_text('concurrent')
        item, (status, body) = self.mark(param='id', param_location='query')
        self.assertEqual(status, 200, body)
        self.assertTrue(self.server.writer_enabled)
        db = sqlite3.connect(f'file:{self.db}?mode=ro', uri=True)
        try:
            agents = [r[0] for r in db.execute('SELECT agent_id FROM test_runs WHERE url_id = ? ORDER BY id', (item['id'],))]
        finally:
            db.close()
        self.assertEqual(agents, ['bounty-board', 'agent-x'])  # the agent's run is newer than the Board's
        self.assertEqual(self.mark()[1][0], 200)  # still enabled

    def test_bulk_marks_share_one_or_two_summary_recomputes(self):
        svc = self.server.recon
        self.assertEqual(svc.mark_debounce, ri.MARK_REFRESH_DEBOUNCE)  # 2 s
        svc.program('web_bounty', 'acme-demo', 'web')
        self.assertTrue(svc.wait_idle(30))
        computes = []
        original = svc._compute
        def counting(kind, path, level):
            if kind == 'url_index':
                computes.append(time.monotonic())
            return original(kind, path, level)
        svc._compute = counting
        db = sqlite3.connect(self.db)
        for n in range(20):
            db.execute("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen) "
                       "VALUES (?, ?, 'rb', 'pb', 'bulk.example.test', '/b', '[]', 's', 'a', 'b')", (f'https://bulk.example.test/b{n}', f'hb{n}'))
        db.commit()
        db.close()
        items = self.urls(host='bulk.example.test', limit=20)[1]['items']
        self.assertEqual(len(items), 20)
        for item in items:
            self.assertEqual(self.mark(item, test_lane='xss', status='discovered')[1][0], 200)
        time.sleep(svc.mark_debounce + 0.5)
        self.assertTrue(svc.wait_idle(30))
        self.assertLessEqual(len(computes), 2, f'{len(computes)} recomputes for 20 marks')
        self.assertGreaterEqual(len(computes), 1)
        self.assertEqual(svc.program('web_bounty', 'acme-demo', 'web')['sources']['url_index']['result']['tested_urls']['value'], 4 + 20)

    def test_trust_checks_and_validation_never_run_bbh(self):
        item = self.urls(limit=1)[1]['items'][0]
        good = {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'root_instance': self.root_instance(),
                'url_id': item['id'], 'url': item['url'], 'test_lane': 'xss', 'status': 'discovered'}
        post = lambda body=good, **headers: self.request('POST', '/api/recon/mark', body=body, headers=headers)[0]
        self.assertEqual(post(**{'X-Requested-With': 'x'}), 403)
        self.assertEqual(post(Origin='http://evil.example'), 403)
        self.assertEqual(post(**{'Content-Type': 'text/plain'}), 403)
        self.assertEqual(post(body=b'{bad json'), 400)
        self.assertEqual(post(body={**good, 'notes': 'x' * 20000}), 400)
        self.assertEqual(post(body={**good, 'status': 'validated'}), 400)  # BBH would print an error and exit 0
        self.assertEqual(post(body={**good, 'test_lane': 'rce'}), 400)
        self.assertEqual(post(body={**good, 'notes': 'two\nlines'}), 400)
        self.assertEqual(post(body={**good, 'notes': 'a\x1b[201~b'}), 400)
        self.assertEqual(post(body={**good, 'param_location': 'query'}), 400)  # location without a parameter
        self.assertEqual(post(body={**good, 'extra': 1}), 400)
        self.assertEqual(post(body={**good, 'url_id': '5'}), 400)
        self.assertEqual(post(body={**good, 'root_instance': 'f' * 64}), 409)
        self.assertEqual(post(body={**good, 'url': item['url'] + 'x'}), 409)
        self.assertEqual(post(body={**good, 'url_id': 999999}), 404)
        self.assertEqual(post(body={**good, 'program': 'other'}), 404)
        self.assertEqual(self.log(), [])

    def test_lane_and_home_mismatch_refused(self):
        api = make_lane(self.root, 'acme-demo', 'api')
        self.server.recon.lanes_cache = (0.0, None)
        item = self.urls(limit=1)[1]['items'][0]
        status, body = self.request('POST', '/api/recon/mark', body={
            'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'api', 'root_instance': self.root_instance(),
            'url_id': item['id'], 'url': item['url'], 'test_lane': 'xss', 'status': 'discovered'})
        self.assertEqual((status, body['error']), (409, 'mark_target_mismatch'))
        self.assertIn('only the web lane', body['message'])
        with mock.patch.dict(os.environ, {'HOME': str(self.base / 'elsewhere')}):
            _, (status, body) = self.mark()
        self.assertEqual((status, body['error']), (409, 'mark_target_mismatch'))
        self.assertIn('different database', body['message'])
        self.assertEqual(self.log(), [])
        self.assertTrue(api.exists())

    def test_bbh_failure_disables_writer(self):
        (self.base / 'mode').write_text('fail')
        _, (status, body) = self.mark()
        self.assertEqual((status, body['error']), (502, 'writer_failed'))
        self.assertFalse(self.server.writer_enabled)
        self.assertEqual(self.mark()[1][0], 503)

    def test_bbh_timeout_disables_writer(self):
        (self.base / 'mode').write_text('timeout')
        started = time.monotonic()
        _, (status, body) = self.mark()
        self.assertEqual((status, body['error']), (503, 'writer_unavailable'))
        self.assertLess(time.monotonic() - started, 8)
        self.assertFalse(self.server.writer_enabled)

    def test_verification_failure(self):
        for mode in ('wrong', 'newurl'):
            with self.subTest(mode=mode):
                self.server.writer_enabled = True
                (self.base / 'mode').write_text(mode)
                _, (status, body) = self.mark()
                self.assertEqual((status, body['error']), (502, 'verification_failed'))
                self.assertFalse(self.server.writer_enabled)

    def test_writer_off(self):
        self.root_instance()
        self.server.writer_enabled = False
        _, (status, body) = self.mark()
        self.assertEqual((status, body['error']), (503, 'writer_unavailable'))
        self.server.writer_enabled = True
        self.server.writer_features = frozenset()
        self.assertEqual(self.mark()[1][0], 503)
        self.assertEqual(self.log(), [])


class ScopeUrlTests(Base):
    """Scope in the URL browser (scope_check.py): cache-only verdicts, out-of-scope URLs still markable."""
    writer = True

    def setUp(self):
        from tests import scope_check_fixture as scope_fx
        self.scope_fx = scope_fx
        super().setUp()
        scope_fx.make_scope(self.root, 'acme-demo', include=['*.example.test'], exclude=['static.example.test'])
        # One launcher for both: classify goes to the scope fake, everything else to the recon fake.
        self.scope_bbh = scope_fx.write_fake_bbh(self.base / 'scope-bin')
        (self.base / 'recon-fake').write_text(FAKE_RECON_WRITER.replace('PYTHON', sys.executable))
        (self.base / 'recon-fake').chmod(0o700)
        launcher = self.base / 'bbh'
        launcher.write_text(f'#!/bin/sh\ncase "$1" in agents/scope_validator.py) exec "{self.scope_bbh}" "$@";; '
                            f'*) exec "{self.base / "recon-fake"}" "$@";; esac\n')
        launcher.chmod(0o700)

    def settled(self, **params):
        for _ in range(20):
            status, body = self.urls(**params)
            self.assertEqual(status, 200)
            if body.get('scope_summary', {}).get('state') != 'pending':
                return body
            self.server.recon.wait_idle(30)
        self.fail('scope stayed pending')

    def test_requests_only_queue_classify_work(self):
        root = self.root
        svc, checker = None, None
        import scope_check as sc
        checker = sc.ScopeChecker(lambda: root, self.scope_bbh)
        svc = ri.ReconIntel(lambda: root, lambda r: app.discover(r, inventory_only=True), app.read_file, app.ledger,
                            app.coverage, app.map_entries, scope=checker, start=False)
        self.addCleanup(svc.close)
        status, body = svc.urls('web_bounty', 'acme-demo', 'web', {'host': 'static.example.test'})
        self.assertEqual(status, 200)
        self.assertEqual(body['scope_summary']['state'], 'pending')
        self.assertTrue(all(i['scope']['state'] == 'unchecked' for i in body['items']))
        self.assertEqual(self.scope_fx.calls(self.scope_bbh), [])  # the request started no BBH process
        self.assertIn(('scope', 'acme-demo', 0), svc.queue)
        svc.thread.start()
        self.assertTrue(svc.wait_idle(30))
        status, body = svc.urls('web_bounty', 'acme-demo', 'web', {'host': 'static.example.test'})
        self.assertEqual(body['scope_summary']['state'], 'checked')
        self.assertEqual({i['scope']['state'] for i in body['items']}, {'out'})
        self.assertEqual(len(self.scope_fx.calls(self.scope_bbh)), 1)
        svc.urls('web_bounty', 'acme-demo', 'web', {'host': 'static.example.test'})
        self.assertTrue(svc.wait_idle(30))
        self.assertEqual(len(self.scope_fx.calls(self.scope_bbh)), 1)  # cached: no further call

    def test_items_history_and_marks_carry_scope_and_marking_is_not_gated(self):
        body = self.settled(host='static.example.test')
        self.assertEqual(body['scope_summary']['state'], 'checked')
        out = body['items'][0]
        self.assertEqual(out['scope'], {'state': 'out', 'rule': 'static.example.test', 'reason': 'excluded by static.example.test'})
        inside = self.settled(host='app.example.test', limit=3)['items'][0]
        self.assertEqual(inside['scope']['state'], 'in')
        status, history = self.request('GET', '/api/recon/url', {'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'id': out['id']})
        self.assertEqual((status, history['scope']['state']), (200, 'out'))
        # An operator may record a review of an out-of-scope URL (for example to dismiss it).
        status, marked = self.request('POST', '/api/recon/mark', body={
            'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'root_instance': self.root_instance(),
            'url_id': out['id'], 'url': out['url'], 'test_lane': 'recon', 'status': 'dismissed', 'notes': 'out of scope'})
        self.assertEqual(status, 200, marked)
        self.assertEqual(marked['item']['scope']['state'], 'out')

    def test_failed_scope_check_does_not_block_marking(self):
        (self.scope_bbh.parent / 'mode').write_text('fail')
        body = self.settled(host='static.example.test')
        self.assertEqual(body['scope_summary']['state'], 'failed')
        item = body['items'][0]
        self.assertEqual(item['scope']['state'], 'unchecked')
        status, marked = self.request('POST', '/api/recon/mark', body={
            'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'root_instance': self.root_instance(),
            'url_id': item['id'], 'url': item['url'], 'test_lane': 'xss', 'status': 'discovered'})
        self.assertEqual(status, 200, marked)


class WriterOffTests(Base):
    def test_capability_disabled_and_mark_refused(self):
        caps = self.request('GET', '/api/data')[1]['capabilities']['ledger_actions']['url_mark']
        self.assertFalse(caps['enabled'])
        item = self.urls(limit=1)[1]['items'][0]
        status, body = self.request('POST', '/api/recon/mark', body={
            'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'root_instance': self.root_instance(),
            'url_id': item['id'], 'url': item['url'], 'test_lane': 'xss', 'status': 'discovered'})
        self.assertEqual((status, body['error']), (503, 'writer_unavailable'))


@unittest.skipUnless((BBH_SOURCE / 'agents/url_ingest.py').exists(), 'needs a BBH checkout with agents/url_ingest.py')
class RealBbhMarkTests(Base):
    """The real BBH url_ingest.py mark, HOME pointed at a synthetic root: proves the mapping."""
    writer = True
    real_bbh = True

    def setUp(self):
        super().setUp()
        self.server.writer_timeout = 60

    def test_real_mark_lands_in_the_database_the_view_reads(self):
        self.assertIn('url_mark', self.server.writer_features)
        item = self.urls(status='untested', host='static.example.test', limit=1)[1]['items'][0]
        status, body = self.request('POST', '/api/recon/mark', body={
            'family': 'web_bounty', 'program': 'acme-demo', 'lane': 'web', 'root_instance': self.root_instance(),
            'url_id': item['id'], 'url': item['url'], 'test_lane': 'xss', 'status': 'deep_reviewed',
            'param': 'q', 'param_location': 'query', 'notes': 'synthetic real-BBH check'})
        self.assertEqual(status, 200, body)
        db = sqlite3.connect(f'file:{self.db}?mode=ro', uri=True)
        try:
            run = db.execute('SELECT url_id, lane, status, param_key, agent_id, notes FROM test_runs ORDER BY id DESC LIMIT 1').fetchone()
            urls = db.execute('SELECT COUNT(*) FROM urls').fetchone()[0]
        finally:
            db.close()
        self.assertEqual(run, (item['id'], 'xss', 'deep_reviewed', 'q', 'bounty-board', 'synthetic real-BBH check'))
        self.assertEqual(urls, 98)  # the existing URL was matched, nothing was "ingested as new"
        self.assertEqual(body['item']['lanes'][0]['status'], 'deep_reviewed')
        self.assertEqual([p.name for p in self.home.iterdir()], ['Shared'])  # BBH wrote nowhere else under HOME


if __name__ == '__main__':
    unittest.main()
