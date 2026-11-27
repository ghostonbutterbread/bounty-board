"""Disposable synthetic backend for the integrated workspace browser test.

Usage: integrated_workspace_fixture.py BASE
One server on loopback (port 0) with every integrated feature on:
- live report editing (--live-edit; private state in BASE/live),
- a fake BBH metadata writer (the same script the ledger-action API tests use;
  its log is BASE/writer.log and BASE/mode selects its behavior),
- report artifacts next to a finding's report, a MapStore entry and a gadget,
- a small coverage database for the drill-down, and the search index.
All names, findings, reports and files are fictional. Everything is written
under BASE (a fresh temporary directory). Prints the port.
"""
import json
import os
import sqlite3
import struct
import sys
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server
from test_ledger_actions import FAKE_WRITER

base = Path(sys.argv[1])
root = base / 'data'
now = datetime.now(timezone.utc)
iso = lambda days: (now - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')

REPORT = '''# Stored XSS in project description

## Summary

Synthetic report used by the integrated workspace test.

## Steps

1. Create a project.
2. Save the description payload from [the PoC](poc/exploit.py).

![screenshot](evidence/screen.png)
'''


def png(width=48, height=30):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\x00' + b''.join(bytes((x * 5 % 256, y * 8 % 256, 170)) for x in range(width)) for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def finding(fid, title, severity, cls, status, first=None, last=None, state='not_submitted', result=None, report=None):
    entry = {'fid': fid, 'title': title, 'severity': severity, 'class_name': cls, 'status': status,
             'severity_rationale': f'Synthetic rationale for {fid}.', 'submission': {'state': state, **({'result': result} if result else {})}}
    if first:
        entry['first_seen'] = iso(first)
    if last:
        entry['last_seen'] = iso(last)
    if report:
        entry['report_path'] = report
        entry['report_dir'] = str(Path(report).parent)
    return entry


PROGRAMS = {
    ('web_bounty', 'acme-cloud', 'web'): [
        finding('A101', 'Stored XSS in project description', 'HIGH', 'stored-xss', 'confirmed', 12, 2, report='reports/A101/REPORT.md'),
        finding('A102', 'Invoice export reachable across organizations', 'CRITICAL', 'idor', 'novel', 3, 1, state='submitted', result='valid'),
        finding('A103', 'Open redirect on logout continuation', 'LOW', 'open-redirect', 'raw', 45, 30),
        finding('A104', 'Verbose stack trace on malformed upload', 'INFO', 'information-disclosure', 'dormant', 120, 100, state='dropped'),
        finding('A105', 'CSRF on notification preferences', 'MEDIUM', 'csrf', 'confirmed', 20, 6),
        finding('A106', 'Reflected XSS in search suggestions', 'P2', 'xss', 'raw'),
    ],
    ('web_bounty', 'globex-pay', 'api'): [
        finding('G201', 'Refund amount accepted as negative value', 'HIGH', 'business-logic', 'confirmed', 9, 4),
        finding('G202', 'Webhook fetcher reaches loopback', 'MEDIUM', 'ssrf', 'raw', 5, 5),
        finding('G203', 'Reflected XSS in error page', 'LOW', 'xss', 'raw', 60, 50),
    ],
    ('binaries', 'initech-desktop', 'exe'): [
        finding('N301', 'Update channel accepts unsigned manifest', 'EXCEPTIONAL', 'rce', 'novel', 2, 1),
        finding('N302', 'Debug port left enabled', 'N/A', 'misconfiguration', 'raw', 15, 15),
    ],
}

for (family, program, lane_name), findings in PROGRAMS.items():
    lane = root / family / program / lane_name
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'reports').mkdir()
    (lane / 'recon/maps').mkdir(parents=True)
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': findings}, indent=1))
    (lane / 'recon/maps/map.jsonl').write_text('')

acme = root / 'web_bounty/acme-cloud/web'
folder = acme / 'reports/A101'
(folder / 'poc').mkdir(parents=True)
(folder / 'evidence').mkdir()
(folder / 'REPORT.md').write_text(REPORT)
(folder / 'poc/exploit.py').write_text('# Synthetic PoC: prints a payload, sends nothing.\nprint("<svg onload=alert(1)>")\n')
(folder / 'evidence/screen.png').write_bytes(png())
(folder / 'evidence/request.har').write_text('{"log": {"entries": []}}\n')
(acme / 'reports/notes.md').write_text('# Lane notes\n\nSynthetic notes without an owner.\n')
entry_dir = acme / 'recon/maps/upload/_surface/upload-limits'
entry_dir.mkdir(parents=True)
(entry_dir / 'observation.md').write_text('# Upload size limits\n\nSynthetic observation.\n')
gadget_dir = acme / 'recon/maps/redirect/_surface/logout-redirect'
gadget_dir.mkdir(parents=True)
(gadget_dir / 'observation.md').write_text('# Logout redirect gadget\n\nSynthetic gadget.\n')
(acme / 'recon/maps/map.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in [
    {'title': 'Upload size limits', 'surface': 'upload', 'scope': 'surface', 'status': 'active', 'tags': ['limits'],
     'path': 'upload/_surface/upload-limits/observation.md', 'timestamp': iso(4)},
    {'title': 'Logout redirect gadget', 'surface': 'redirect', 'scope': 'surface', 'status': 'active', 'tags': ['gadget'],
     'path': 'redirect/_surface/logout-redirect/observation.md', 'timestamp': iso(8)},
]))

db = sqlite3.connect(acme / 'ledgers/surface_coverage.sqlite')
db.executescript('''CREATE TABLE surfaces (id TEXT PRIMARY KEY, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT,
  source_ref TEXT, run_id TEXT, fingerprint TEXT, first_seen TEXT, last_seen TEXT);
CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT,
  evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT, agent TEXT, assessment_run_id TEXT, updated_at TEXT);''')
kinds = ['endpoint', 'route', 'graphql_operation']
for n in range(1, 25):
    db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?,?,?,?)', (f's{n}', kinds[n % 3], 'app.example.test', f'/v1/item{n}',
               None, None, 'src', 'run1', f'fp{n}', iso(40), iso(2)))
rows = ([(n, 'xss', 'bounded_review', 'covered sinks', 'query param only', ['reports/A101/REPORT.md']) for n in range(1, 8)] +
        [(8, 'idor', 'blocked', 'WAF challenge on every automated request', None, ['notes/waf.txt']),
         (9, 'ssrf', 'blocked', 'Needs a second owned account with the admin role', None, []),
         (10, 'csrf', 'in_progress', 'token census running', None, ['notes/csrf.txt'])] +
        [(n, 'access-control', 'no_assessment', None, None, []) for n in range(11, 19)])
for n, cls, status, reason, boundary, evidence in rows:
    db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (f's{n}', cls, status, '', reason, boundary, '{}', json.dumps(evidence),
               'new build' if status == 'blocked' else None, f'fp{n}', 'agent-a', 'r1', iso(3 + n)))
db.commit()
db.close()

(base / 'bin').mkdir()
writer = base / 'bin/bbh'
writer.write_text(FAKE_WRITER)
writer.chmod(0o700)
os.environ['FAKE_LOG'] = str(base / 'writer.log')
os.environ['FAKE_MODE'] = str(base / 'mode')

server = make_test_server(root, port=0, writer=writer, accept_uncoordinated_writes=True, live_edit_dir=base / 'live')
server.live.poll_interval = 0.1
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
