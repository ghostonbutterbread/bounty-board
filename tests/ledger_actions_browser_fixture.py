"""Disposable synthetic backend for the ledger-actions browser test.

Usage: ledger_actions_browser_fixture.py <root> [writer|readonly]
Creates synthetic findings under <root>/data and, in writer mode, a fake BBH
writer (the same script the API tests use) under <root>/bin. Prints the port.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import app
from test_ledger_actions import FAKE_WRITER

base = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'writer'
root = base / 'data'
now = datetime.now(timezone.utc)
iso = lambda days: (now - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')
programs = {
    'alpha': [
        {'fid': 'D01', 'title': 'Alpha low <img src=x onerror="window.__ledger_xss=1">', 'class_name': 'xss', 'severity': 'LOW', 'status': 'confirmed',
         'first_seen': iso(200), 'last_seen': iso(2), 'submission': {'state': 'not_submitted'}, 'evidence_path': 'reports/D01/EVIDENCE.md'},
        {'fid': 'D02', 'title': 'Alpha critical', 'class_name': 'idor', 'severity': 'CRITICAL', 'status': 'confirmed',
         'first_seen': iso(3), 'last_seen': iso(1), 'submission': {'state': 'not_submitted'}},
        {'fid': 'D03', 'title': 'Alpha informational', 'class_name': 'xss', 'severity': 'INFO', 'status': 'raw',
         'first_seen': iso(40), 'last_seen': iso(40)},
        {'fid': 'D04', 'title': 'Alpha legacy na', 'class_name': 'info-leak', 'severity': 'N/A', 'status': 'raw'},
        {'fid': 'D05', 'title': 'Alpha high', 'class_name': 'ssrf', 'severity': 'HIGH', 'status': 'raw',
         'first_seen': iso(10), 'last_seen': iso(5)},
    ],
    'beta': [
        {'fid': 'D01', 'title': 'Beta xss', 'class_name': 'xss', 'severity': 'MEDIUM', 'status': 'raw', 'first_seen': iso(20)},
    ],
}
for name, findings in programs.items():
    lane = root / 'web_bounty' / name / 'web'
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'reports').mkdir()
    (lane / 'recon/maps').mkdir(parents=True)
    (lane / 'recon/maps/map.jsonl').write_text('')
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': findings}))

writer = None
if mode == 'writer':
    (base / 'bin').mkdir()
    writer = base / 'bin/bbh'
    writer.write_text(FAKE_WRITER)
    writer.chmod(0o700)
    os.environ['FAKE_LOG'] = str(base / 'writer.log')
    os.environ['FAKE_MODE'] = str(base / 'mode')
server = app.make_server(root, port=0, writer=writer, accept_uncoordinated_writes=writer is not None)
print(server.server_port, flush=True)
server.serve_forever()
