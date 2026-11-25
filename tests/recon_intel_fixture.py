"""Synthetic recon stores matching BBH url_ingest.py / js_analyzer.py schemas.

Everything is fictional: hosts end in .example.test, programs are made up.
Used by tests/test_recon_intel.py and the recon intel browser fixture."""
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

URL_SCHEMA = '''
CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, canonical_url TEXT NOT NULL, url_hash TEXT NOT NULL UNIQUE,
  route_hash TEXT NOT NULL, param_hash TEXT NOT NULL, host TEXT, path TEXT, param_keys TEXT, source TEXT,
  first_seen TIMESTAMP NOT NULL, last_seen TIMESTAMP NOT NULL);
CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, url_id INTEGER NOT NULL, lane TEXT NOT NULL,
  param_key TEXT NOT NULL DEFAULT '', param_location TEXT, status TEXT NOT NULL, agent_id TEXT, run_id TEXT,
  evidence_path TEXT, notes TEXT, created_at TIMESTAMP NOT NULL);
CREATE TABLE test_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, url_id INTEGER NOT NULL, lane TEXT NOT NULL,
  param_key TEXT NOT NULL DEFAULT '', param_location TEXT, skill TEXT NOT NULL, test_family TEXT NOT NULL, technique TEXT,
  status TEXT NOT NULL, depth TEXT, agent_id TEXT, run_id TEXT, evidence_path TEXT, request_variant TEXT,
  response_summary TEXT, notes TEXT, started_at TIMESTAMP NOT NULL, completed_at TIMESTAMP NOT NULL);
CREATE TABLE parameter_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, url_id INTEGER NOT NULL, param_key TEXT NOT NULL,
  location TEXT NOT NULL, source TEXT, source_ref TEXT, value_shape TEXT, lane_hints TEXT,
  confidence TEXT NOT NULL DEFAULT 'observed', first_seen TIMESTAMP NOT NULL, last_seen TIMESTAMP NOT NULL);
CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, program TEXT, run_id TEXT,
  urls_imported INTEGER, imported_at TIMESTAMP NOT NULL);
CREATE UNIQUE INDEX idx_urls_hash ON urls(url_hash);
CREATE INDEX idx_urls_route_hash ON urls(route_hash);
CREATE INDEX idx_urls_param_hash ON urls(param_hash);
CREATE INDEX idx_urls_host ON urls(host);
CREATE UNIQUE INDEX idx_obs_url_lane_param ON observations(url_id, lane, param_key);
CREATE INDEX idx_obs_status ON observations(status);
CREATE INDEX idx_test_runs_url ON test_runs(url_id);
CREATE INDEX idx_test_runs_lane ON test_runs(lane);
CREATE INDEX idx_test_runs_param ON test_runs(param_key);
CREATE INDEX idx_test_runs_completed_at ON test_runs(completed_at);
CREATE INDEX idx_param_obs_key ON parameter_observations(param_key);
CREATE INDEX idx_param_obs_url ON parameter_observations(url_id);
'''

JS_SCHEMA = '''
CREATE TABLE js_files (sha256 TEXT PRIMARY KEY, artifact_path TEXT NOT NULL, byte_count INTEGER NOT NULL, content_type TEXT,
  first_seen TEXT, last_seen TEXT, last_fetched_at TEXT, latest_run_id TEXT, target_host TEXT, source_map TEXT,
  chunk_count INTEGER, signal_counts_json TEXT, metadata_json TEXT NOT NULL);
CREATE TABLE js_url_aliases (js_url TEXT NOT NULL, sha256 TEXT NOT NULL, first_seen TEXT, last_seen TEXT, last_fetched_at TEXT,
  latest_run_id TEXT, status INTEGER, content_type TEXT, source TEXT, page_context TEXT, PRIMARY KEY (js_url, sha256));
CREATE TABLE js_observations (observation_id TEXT PRIMARY KEY, sha256 TEXT, js_url TEXT, packet_path TEXT, lens TEXT, run_id TEXT,
  agent_id TEXT, title TEXT, summary TEXT, status TEXT, confidence TEXT, evidence_json TEXT, next_action TEXT,
  artifact_path TEXT, created_at TEXT, updated_at TEXT, observation_json TEXT NOT NULL);
CREATE TABLE leads (lead_id TEXT PRIMARY KEY, lane TEXT, confidence TEXT, js_url TEXT, sha256 TEXT, local_path TEXT,
  packet_id TEXT, related_endpoint TEXT, next_action TEXT, run_id TEXT);
'''

HINTS = {'url': ['open-redirect', 'ssrf'], 'next': ['open-redirect'], 'file': ['lfi'], 'q': ['xss'], 'id': ['idor'], 'page': []}


def iso(days=0.0, now=None):
    return ((now or datetime.now(timezone.utc)) - timedelta(days=days)).isoformat()


def make_url_index(path, hosts=None, tests=True):
    """A small URL index. hosts: {host: url_count}. Returns the path."""
    hosts = hosts or {'app.example.test': 60, 'api.example.test': 30, 'static.example.test': 8}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript(URL_SCHEMA)
    ids = {}
    n = 0
    for host, count in hosts.items():
        for i in range(count):
            n += 1
            key = list(HINTS)[(i // 2) % len(HINTS)] if i % 2 == 0 else None
            route = f'/r{i % 7}' if host != 'static.example.test' else f'/s{i}'
            url = f'https://{host}{route}' + (f'?{key}=v' if key else '')
            db.execute('INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen) '
                       'VALUES (?,?,?,?,?,?,?,?,?,?)', (url, f'h{n}', f'rt-{route}', f'p-{key}', host, route,
                                                       json.dumps([key] if key else []), 'synthetic', iso(10), iso(1)))
            ids.setdefault(host, []).append(n)
            if key:
                db.execute('INSERT INTO parameter_observations (url_id, param_key, location, source, value_shape, lane_hints, first_seen, last_seen) '
                           'VALUES (?,?,?,?,?,?,?,?)', (n, key, 'query', 'synthetic', 'url' if key in ('url', 'next') else 'text',
                                                        json.dumps(HINTS[key]), iso(10), iso(1)))
    if tests:
        app = ids.get('app.example.test', [])
        rows = [
            (app[0], 'xss', 'q', 'xss-reflect', 'reflection', 'surface_reviewed', 0.2, 'agent-a', 'reports/xss-notes.md', 'reflected safely'),
            (app[2], 'open-redirect', 'url', 'redirect', 'redirect-basic', 'deep_reviewed', 3, 'agent-b', '/elsewhere/out.txt', 'no redirect'),
            (app[4], 'idor', 'id', 'manual', 'general-review', 'dismissed', 20, 'agent-c', None, 'x' * 400),
            (app[6], 'recon', '', 'manual', 'general-review', 'discovered', 40, 'agent-a', None, 'seen'),
        ]
        for url_id, lane, key, skill, family, status, days, agent, evidence, notes in rows:
            db.execute('INSERT INTO test_runs (url_id, lane, param_key, param_location, skill, test_family, status, agent_id, run_id, '
                       'evidence_path, notes, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (url_id, lane, key, 'query' if key else None, skill, family, status, agent, 'run-1', evidence, notes, iso(days), iso(days)))
            db.execute('INSERT OR IGNORE INTO observations (url_id, lane, param_key, status, agent_id, run_id, evidence_path, notes, created_at) '
                       'VALUES (?,?,?,?,?,?,?,?,?)', (url_id, lane, key, status, agent, 'run-1', evidence, notes, iso(days)))
    db.execute("INSERT INTO imports (source_file, program, run_id, urls_imported, imported_at) VALUES ('synthetic.txt', 'demo', 'r', ?, ?)",
               (n, iso(1)))
    db.commit()
    db.close()
    return path


def make_large_url_index(path, rows=400_000, hosts=40):
    """A big URL index (no tests) generated with SQL, for budget and cache tests."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript(URL_SCHEMA)
    db.execute('PRAGMA synchronous=OFF')
    db.execute('''WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
        INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen)
        SELECT 'https://h' || (i % ?) || '.example.test/p' || i || CASE WHEN i % 3 = 0 THEN '?url=x' ELSE '' END,
               'u' || i, 'r' || (i % 5000), 'p' || (i % 3 = 0), 'h' || (i % ?) || '.example.test', '/p' || i,
               CASE WHEN i % 3 = 0 THEN '["url"]' ELSE '[]' END, 'gen', '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00'
        FROM seq''', (rows, hosts, hosts))
    db.execute('''INSERT INTO parameter_observations (url_id, param_key, location, source, value_shape, lane_hints, first_seen, last_seen)
        SELECT id, 'url', 'query', 'gen', 'url', '["open-redirect", "ssrf"]', first_seen, last_seen FROM urls WHERE id % 3 = 0''')
    db.commit()
    db.close()
    return path


def make_js_library(path, hosts=None):
    hosts = hosts or {'static.example.test': 12, 'app.example.test': 3}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript(JS_SCHEMA)
    n = 0
    for host, count in hosts.items():
        for i in range(count):
            n += 1
            sha = f'{n:064x}'
            db.execute('INSERT INTO js_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (sha, f'downloads/{sha}.js', 1000 * n, 'application/javascript', iso(5), iso(1), iso(1), 'run-js', host,
                        f'https://{host}/a{i}.js.map' if i % 4 == 0 else None, 2,
                        json.dumps({'endpoints': i + 1, 'secret_hints': i % 2, 'sinks': 1}), '{}'))
            db.execute('INSERT INTO js_url_aliases (js_url, sha256, first_seen, last_seen) VALUES (?,?,?,?)',
                       (f'https://{host}/a{i}.js', sha, iso(5), iso(1)))
    observations = [('o1', 'endpoints', 'open', 'high', 'Hidden admin route', 'probe the admin route with an owned account'),
                    ('o2', 'secrets', 'done', 'low', 'Public key only', 'none needed'),
                    ('o3', 'sinks', 'new', 'medium', 'innerHTML sink', 'trace the sink source'),
                    ('o4', 'endpoints', 'open', 'medium', 'No next step', '')]
    for oid, lens, status, conf, title, nxt in observations:
        db.execute('INSERT INTO js_observations (observation_id, sha256, js_url, lens, status, confidence, title, summary, next_action, '
                   'agent_id, run_id, created_at, updated_at, observation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (oid, f'{1:064x}', 'https://static.example.test/a0.js', lens, status, conf, title, 'synthetic', nxt, 'agent-js', 'run-js',
                    iso(2), iso(1), '{}'))
    db.execute("INSERT INTO leads VALUES ('L1', 'xss', 'medium', 'https://static.example.test/a0.js', NULL, NULL, NULL, '/api/render', "
               "'check the render endpoint', 'run-js')")
    db.commit()
    db.close()
    return path


def make_lane(root, program='acme-demo', lane='web', findings=True, url_index=True, js_shared=False):
    lane_dir = Path(root) / 'web_bounty' / program / lane
    (lane_dir / 'ledgers').mkdir(parents=True, exist_ok=True)
    (lane_dir / 'reports').mkdir(exist_ok=True)
    (lane_dir / 'reports' / 'xss-notes.md').write_text('# Synthetic notes\n')
    if findings:
        (lane_dir / 'ledgers' / 'ledger.json').write_text(json.dumps({'findings': [
            {'fid': 'F1', 'title': 'Reflected value', 'severity': 'MEDIUM', 'class_name': 'reflected-xss', 'status': 'raw',
             'asset': 'https://app.example.test/r0?q=v', 'last_seen': iso(2)},
            {'fid': 'F2', 'title': 'Order swap', 'severity': 'HIGH', 'class_name': 'idor', 'status': 'confirmed', 'asset': 'api.example.test'},
            {'fid': 'F3', 'title': 'Old one', 'severity': 'LOW', 'class_name': 'info', 'status': 'archive', 'asset': 'app.example.test'},
        ]}))
    if url_index:
        make_url_index(lane_dir / 'recon' / 'url_index' / 'url_index.sqlite')
    agg = lane_dir / 'recon' / 'aggregated'
    agg.mkdir(parents=True, exist_ok=True)
    (agg / 'urls.txt').write_text(''.join(f'https://app.example.test/x{i}\n' for i in range(120)))
    (agg / 'hosts.txt').write_text('app.example.test\napi.example.test\nstatic.example.test')
    if js_shared:
        make_js_library(lane_dir / 'recon' / 'js' / '_library' / 'js_info.sqlite')
    return lane_dir
