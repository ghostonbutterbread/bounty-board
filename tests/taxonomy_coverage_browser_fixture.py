"""Disposable synthetic backend for the taxonomy and coverage drill-down browser test.
Everything here is fictional; the root is provided by the test."""
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server

root = Path(sys.argv[1])
lane = root / 'web_bounty' / 'acme-demo' / 'web'
(lane / 'ledgers').mkdir(parents=True)
(lane / 'reports').mkdir()
(lane / 'reports' / 'idor-notes.md').write_text('# Synthetic notes\n')
findings = [
    ('F1', 'Stored script in profile', 'P2', 'stored-xss'),
    ('F2', 'Order id swap', 'HIGH', 'broken-object-level-authorization'),
    ('F3', 'Fetcher reaches loopback', 'MEDIUM', 'server-side-request-forgery'),
    ('F4', 'Template draft', 'LOW|MEDIUM|HIGH|CRITICAL', 'short vulnerability label'),
    ('F5', 'Range rating', 'LOW-MEDIUM', 'something-never-seen-before'),
    ('F6', 'Reset token leak', 'critical', 'ato'),
    ('F7', 'Config exposed', 'INFO', 'information-disclosure'),
]
(lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [
    {'fid': f, 'title': t, 'severity': s, 'class_name': c, 'status': 'raw'} for f, t, s, c in findings]}))
now = datetime.now(timezone.utc)
ago = lambda d: (now - timedelta(days=d)).isoformat()
db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
db.executescript('''CREATE TABLE surfaces (id TEXT PRIMARY KEY, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT,
  source_ref TEXT, run_id TEXT, fingerprint TEXT, first_seen TEXT, last_seen TEXT);
CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT,
  evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT, agent TEXT, assessment_run_id TEXT, updated_at TEXT);''')
kinds = ['endpoint', 'endpoint', 'endpoint', 'route', 'route', 'graphql_operation', 'graphql_operation', 'api_operation']
for n in range(1, 41):
    db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?,?,?,?)', (f's{n}', kinds[n % len(kinds)], 'app.example.test', f'/v1/item{n}',
               None, None, 'src', 'run1', f'fp{n}', ago(60), ago(2)))
def assess(n, cls, status, reason=None, boundary=None, evidence=(), days=3, fp='same'):
    db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (f's{n}', cls, status, '', reason, boundary, '{}',
               json.dumps(list(evidence)), 'new build' if status == 'blocked' else None, f'fp{n}' if fp == 'same' else 'old', 'agent-a' if status != 'no_assessment' else None,
               'r1' if status != 'no_assessment' else None, ago(days)))
for n in range(1, 11): assess(n, 'xss', 'bounded_review', 'covered sinks', 'query param only', ['reports/idor-notes.md'], days=5 + n)
for n in range(1, 6): assess(n, 'idor', 'bounded_review', 'two owned accounts', 'read paths only', ['reports/idor-notes.md'])
assess(11, 'idor', 'blocked', 'WAF challenge on every automated request', None, ['notes/waf.txt'])
assess(12, 'ssrf', 'blocked', 'Needs a paid account with the tenant role', None, ['notes/acct.txt'])
assess(13, 'ssrf', 'blocked', 'Waiting on source bundle', None, [])
for n in range(14, 18): assess(n, 'dom-xss', 'in_progress', 'sink census running', None, ['notes/census.txt'], days=1 if n < 16 else 70)
assess(18, 'xss', 'bounded_review', 'covered', 'one route', ['notes/a.txt'], fp='stale')
for n in range(19, 31): assess(n, 'access-control', 'no_assessment', None, None, [], days=9)
assess(31, 'rce', 'untested', None, None, [], days=9)
db.commit(); db.close()
server = make_test_server(root, port=0)
print(server.server_port, flush=True)
server.serve_forever()
