"""Disposable backend fixture for the browser test; root is provided by the test."""
import json
import sqlite3
import sys
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server

root = Path(sys.argv[1])
for name, findings in {
    'alpha': [
        {'fid': 'A1', 'title': 'Alpha finding', 'severity': 'HIGH', 'class_name': 'xss', 'status': 'raw', 'submission_status': 'submitted', 'platform_outcome': 'duplicate'},
        {'fid': 'A2', 'title': 'Second alpha', 'severity': 'LOW', 'class_name': 'idor', 'status': 'confirmed', 'submission': {'state': 'nested', 'result': 'accepted'}, 'submission_status': 'ignored', 'platform_outcome': 'ignored'}],
    'beta': [{'fid': 'B1', 'title': 'Beta finding', 'severity': 'LOW', 'class_name': 'idor', 'status': 'raw', 'submission': {'state': '', 'result': None}, 'submission_status': 'draft'}],
}.items():
    lane = root / 'web_bounty' / name / 'web'
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'reports').mkdir()
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': findings}))
    db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
    db.executescript('''CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT);
    CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);''')
    db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('1','endpoint','example.test','/<img src=x onerror=alert(1)>','q','handler',None,None))
    db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('2','endpoint','example.test','/known',None,None,None,None))
    db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', ('2','xss','untested',None,None,None,'[]','[]',None,None))
    db.commit(); db.close()
server = make_test_server(root, port=0)
print(server.server_port, flush=True)
server.serve_forever()
