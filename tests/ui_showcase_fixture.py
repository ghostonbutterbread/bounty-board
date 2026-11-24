"""Disposable synthetic showcase backend for UI screenshots and UI browser tests.

Usage: python3 tests/ui_showcase_fixture.py ROOT   (LIVE_EDIT=1 enables live editing;
the data tree then lives in ROOT/data and private live state in ROOT/live)
All program names, findings and reports are fictional. ROOT must be a fresh
temporary directory; nothing outside it is written.
"""
import json
import os
import sqlite3
import sys
from pathlib import Path

import app

live_edit = os.environ.get('LIVE_EDIT') == '1'
base_dir = Path(sys.argv[1])
root = base_dir / 'data' if live_edit else base_dir

SEV = ['EXCEPTIONAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN']


def finding(fid, title, severity, cls, status, state=None, result=None, report=None):
    entry = {'fid': fid, 'title': title, 'severity': severity, 'class_name': cls, 'status': status,
             'severity_rationale': f'Synthetic rationale for {fid}.'}
    if state:
        entry['submission'] = {'state': state, **({'result': result} if result else {})}
    if report:
        entry['report_path'] = f'reports/{report}'
    return entry


PROGRAMS = {
    ('web_bounty', 'acme-cloud'): {
        'web': [
            finding('AC-101', 'Stored XSS in project description renders for invited members', 'HIGH', 'xss', 'confirmed', 'submitted', 'valid', 'ac-101-stored-xss.md'),
            finding('AC-102', 'Invoice export reachable across organizations by numeric ID', 'CRITICAL', 'idor', 'novel', 'not_submitted', None, 'ac-102-invoice-idor.md'),
            finding('AC-103', 'Open redirect on logout continuation parameter', 'LOW', 'open_redirect', 'raw'),
            finding('AC-104', 'Verbose stack trace on malformed upload metadata', 'INFO', 'info_disclosure', 'dormant', 'dropped'),
            finding('AC-105', 'CSRF on notification preferences endpoint', 'MEDIUM', 'csrf', 'confirmed', 'submitted', 'duplicate'),
        ],
        'api': [
            finding('AC-201', 'GraphQL batching bypasses per-user rate limit on OTP verify', 'HIGH', 'auth_bypass', 'novel', None, None, 'ac-201-otp-batching.md'),
            finding('AC-202', 'Webhook URL validator allows internal metadata host', 'EXCEPTIONAL', 'ssrf', 'confirmed', 'not_submitted', None, 'ac-202-webhook-ssrf.md'),
            finding('AC-203', 'Team role downgrade does not revoke API tokens', 'MEDIUM', 'access_control', 'raw'),
        ],
    },
    ('web_bounty', 'northwind-retail'): {
        'web': [
            finding('NW-11', 'Coupon stacking through parallel checkout requests', 'HIGH', 'race_condition', 'confirmed', 'submitted', 'valid', 'nw-11-coupon-race.md'),
            finding('NW-12', 'Reflected XSS in store locator search', 'MEDIUM', 'xss', 'raw', 'not_submitted'),
            finding('NW-13', 'Order history leaks masked card BIN to other sessions', 'LOW', 'info_disclosure', 'archive', 'dropped'),
            finding('NW-14', 'Unclassified behavior in gift card balance check', 'UNKNOWN', None, 'raw'),
        ],
    },
    ('web_bounty', 'globex-identity'): {
        'web': [
            finding('GX-1', 'OAuth state not bound to session allows login CSRF', 'MEDIUM', 'csrf', 'novel'),
            finding('GX-2', 'Password reset token valid after email change', 'HIGH', 'ato', 'confirmed', 'not_submitted', None, 'gx-2-reset-token.md'),
        ],
        'api': [],
    },
    ('binaries', 'initech-mobile'): {
        'apk': [
            finding('IN-7', 'Exported activity accepts arbitrary deep link URL into WebView', 'HIGH', 'webview', 'confirmed', 'submitted', None, 'in-7-deeplink-webview.md'),
            finding('IN-8', 'Debug logging writes session token to logcat', 'MEDIUM', 'info_disclosure', 'raw'),
        ],
    },
    ('binaries', 'umbrella-desktop'): {
        'exe': [finding('UM-3', 'Updater follows unsigned redirect manifest', 'CRITICAL', 'rce', 'novel', 'not_submitted')],
        'mac': [],
    },
}

REPORT_BODY = """# {title}

## Summary

A synthetic, fictional report used only for UI screenshots. **No real target.**

## Steps

- Sign in as test user A
- Open the affected view
- Observe the behavior

```
GET /synthetic/example HTTP/1.1
```
"""

for (family, program), lanes in PROGRAMS.items():
    for lane_name, findings in lanes.items():
        lane = root / family / program / lane_name
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'reports').mkdir()
        (lane / 'recon' / 'maps').mkdir(parents=True)
        (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': findings}))
        for item in findings:
            if item.get('report_path'):
                (lane / item['report_path']).write_text(REPORT_BODY.format(title=item['title']))
        (lane / 'reports' / 'notes.md').write_text('# Working notes\n\nScratch notes for this lane.\n')
        entries = [
            {'title': f'{program} login flow', 'url': 'https://example.test/login', 'surface': 'auth', 'scope': 'in', 'status': 'mapped', 'path': 'recon/maps/login.md', 'tags': ['auth'], 'timestamp': '2026-11-01T10:00:00Z'},
            {'title': f'{program} billing API', 'url': 'https://example.test/api/billing', 'surface': 'api', 'scope': 'in', 'status': 'reviewed', 'path': 'recon/maps/billing.md', 'tags': ['api', 'billing'], 'timestamp': '2026-11-12T15:30:00Z'},
        ]
        (lane / 'recon/maps/map.jsonl').write_text('\n'.join(json.dumps(e) for e in entries) + '\n')
        (lane / 'recon/maps/login.md').write_text('Synthetic login observation.\n')
        (lane / 'recon/maps/billing.md').write_text('Synthetic billing observation.\n')
        db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
        db.execute('PRAGMA journal_mode=OFF')  # disposable fixture: skip slow fsyncs
        db.execute('PRAGMA synchronous=OFF')
        db.executescript('''CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT);
        CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);''')
        db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('1', 'endpoint', 'example.test', '/api/projects', 'id', 'handler', None, None))
        db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('2', 'endpoint', 'example.test', '/settings', None, None, None, None))
        db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', ('1', 'idor', 'reviewed', None, None, 'org boundary', '[]', '[]', None, None))
        db.commit()
        db.close()

live_dir = None
if live_edit:
    live_dir = base_dir / 'live'
    live_dir.mkdir(mode=0o700)
server = app.make_server(root, port=0, live_edit_dir=live_dir)
print(server.server_port, flush=True)
server.serve_forever()
