"""Disposable synthetic backend for report-link and Recent reports browser tests.

Usage: python3 tests/report_links_fixture.py ROOT
Env: SLOW_COMPLETE=1 delays the complete /api/data phase by 4 s, so a cold
deep link must open its report through the lazily loaded lane index first.
LIVE_EDIT=1 enables live editing (data in ROOT/data, private state in ROOT/live).
All names and texts are fictional; nothing outside ROOT is written.
"""
import json
import os
import sys
import time
from pathlib import Path

import app

live_edit = os.environ.get('LIVE_EDIT') == '1'
base_dir = Path(sys.argv[1])
root = base_dir / 'data' if live_edit else base_dir
NOW = time.time()
HOUR, DAY = 3600, 86400


def finding(fid, title, severity, report=None):
    entry = {'fid': fid, 'title': title, 'severity': severity, 'class_name': 'xss', 'status': 'raw'}
    if report:
        entry['report_path'] = f'reports/{report}'
    return entry


# (family, program, lane) -> (findings, {report path: (title, age seconds)})
LANES = {
    ('web_bounty', 'acme-cloud', 'web'): (
        [finding('AC-1', 'Stored XSS in project names', 'HIGH', 'confirmed/stored xss.md'),
         finding('AC-2', 'Invoice IDOR', 'CRITICAL', 'ac-2-invoice-idor.md'),
         finding('AC-3', 'Stale link finding', 'LOW', 'gone/missing.md')],
        {'confirmed/stored xss.md': ('Stored XSS report', 2 * HOUR),
         'ac-2-invoice-idor.md': ('Invoice IDOR report', 5 * DAY),
         'notes.md': ('Acme working notes', 40 * DAY),
         'index/xss.md': None}),
    ('web_bounty', 'acme-cloud', 'api'): (
        [finding('AC-9', 'Token leak', 'MEDIUM', 'api-token.md')],
        {'api-token.md': ('API token report', 20 * DAY)}),
    ('web_bounty', 'globex', 'web'): (
        [finding('GX-1', 'SQL injection in search', 'EXCEPTIONAL', 'gx-sqli.md')],
        {'gx-sqli.md': ('Globex SQLi report', 10 * 60),
         'drafts/old.md': ('Globex old draft', 200 * DAY)}),
    ('binaries', 'initech', 'apk'): (
        [],
        {'apk-notes.md': ('Initech APK notes', 3 * DAY)}),
}

for (family, program, lane_name), (findings, reports) in LANES.items():
    lane = root / family / program / lane_name
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': findings}))
    for rel, spec in reports.items():
        path = lane / 'reports' / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if spec is None:  # generated navigation stub, newest of all
            path.write_text('# Xss\n\n<!-- generated: bounty-core-report-navigation -->\n- Stored XSS report\n')
            os.utime(path, (NOW - 60, NOW - 60))
            continue
        title, age = spec
        path.write_text(f'# {title}\n\nSynthetic, fictional report text.\n')
        os.utime(path, (NOW - age, NOW - age))

if os.environ.get('SLOW_COMPLETE') == '1':
    discover = app.discover

    def slow_discover(*args, **kwargs):
        if kwargs.get('include_reports', True) and not kwargs.get('inventory_only'):
            time.sleep(4)
        return discover(*args, **kwargs)
    app.discover = slow_discover

live_dir = None
if live_edit:
    live_dir = base_dir / 'live'
    live_dir.mkdir(mode=0o700)
server = app.make_server(root, port=0, live_edit_dir=live_dir)
print(server.server_port, flush=True)
server.serve_forever()
