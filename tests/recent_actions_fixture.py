"""Disposable synthetic backend for the Recent actions / report N/A browser tests.

Usage: recent_actions_fixture.py <base> [writer|readonly|nostate]
Creates synthetic programs in the current BBH packet shape
(reports/<FID>-<slug>/EVIDENCE.md, the submission report, _meta/), one legacy
report (reports/findings/<bucket>/<FID> - <title>.md), unmapped files and
generated navigation, plus the fake BBH writer from test_ledger_actions unless
readonly. nostate runs with the writer but without a Board state directory.
Prints the port. Synthetic data only.
"""
import json
import os
import sys
import time
from pathlib import Path

import app
from test_ledger_actions import FAKE_WRITER

base = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'writer'
root = base / 'data'
NAV = '<!-- generated: bounty-core-report-navigation -->\n# Active\n'


def finding(fid, title, cls, sev, status='confirmed', **extra):
    return {'fid': fid, 'title': title, 'class_name': cls, 'severity': sev, 'status': status, **extra}


programs = {
    'orchard': [
        finding('F001', 'Stored cross-site scripting in the profile display name renders in the admin moderation queue', 'xss', 'HIGH',
                submission={'state': 'not_submitted'}, packet='f001-stored-xss', target='orchard.example'),
        finding('F002', 'IDOR on invoice export', 'idor', 'CRITICAL', submission={'state': 'submitted', 'result': 'valid'},
                packet='f002-invoice-idor', target='billing.orchard.example'),
        finding('F003', 'Open redirect on logout', 'open-redirect', 'LOW', packet='f003-open-redirect', target='orchard.example'),
        finding('F004', 'Verbose stack trace on malformed upload', 'information-disclosure', 'INFO', packet='f004-stack-trace', target='upload.orchard.example'),
        finding('F005', 'SSRF through webhook preview', 'ssrf', 'MEDIUM', submission={'state': 'dropped'}),
        finding('F006', 'Reflected XSS in search suggestions', 'xss', 'MEDIUM', legacy=True),
    ],
    'lantern': [
        finding('L010', 'Account takeover through email change race', 'race-condition', 'HIGH', packet='l010-email-race', target='lantern.example'),
        finding('L011', 'Missing rate limit on OTP verification', 'rate-limit', 'LOW', submission={'state': 'submitted', 'result': 'duplicate'},
                packet='l011-otp-rate-limit', target='auth.lantern.example'),
        finding('L012', 'Template injection in export filename', 'ssti', 'MEDIUM'),
        finding('L013', 'Stored XSS in shared board titles', 'xss', 'EXCEPTIONAL', submission={'state': 'submitted', 'result': 'duplicate'}),
    ],
}
now = time.time()
age = 0
for name, items in programs.items():
    lane = root / 'web_bounty' / name / 'web'
    reports = lane / 'reports'
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'recon/maps').mkdir(parents=True)
    (lane / 'recon/maps/map.jsonl').write_text('')
    reports.mkdir()
    files = []
    ledger = []
    for f in items:
        packet, target, legacy = f.pop('packet', None), f.pop('target', None), f.pop('legacy', False)
        if packet:
            folder = f"{f['fid']}-{packet.split('-', 1)[1]}"
            report = f"{folder}/{target}-{f['class_name']}-{f['fid']}.md"
            files += [(report, f"# {f['title']}\n\nSynthetic submission report.\n"),
                      (f'{folder}/EVIDENCE.md', f"# Evidence for {f['fid']}\n\nSynthetic evidence.\n"),
                      (f'{folder}/_meta/notes.md', '# Notes\n')]
            f['report_path'] = f'reports/{report}'
            f['evidence_path'] = f'reports/{folder}/EVIDENCE.md'
        if legacy:
            files.append((f"findings/medium/{f['fid']} - {f['title']}.md", f"# {f['title']}\n\nLegacy report.\n"))
        ledger.append(f)
    files += [('active.md', NAV), ('scratch/unmapped-notes.md', '# Unmapped scratch notes\n')]
    for rel, text in files:
        path = reports / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        age += 1
        os.utime(path, (now - age * 600, now - age * 600))
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': ledger}))

writer = None
if mode != 'readonly':
    (base / 'bin').mkdir()
    writer = base / 'bin/bbh'
    writer.write_text(FAKE_WRITER)
    writer.chmod(0o700)
    os.environ['FAKE_LOG'] = str(base / 'writer.log')
    os.environ['FAKE_MODE'] = str(base / 'mode')
    os.environ['FAKE_HELP'] = ('--edit-finding --patch-file --root --family --lane --from-file --set-submission '
                               '--submission-state --submission-result --submission-report --delete-finding --actor')
server = app.make_server(root, port=0, writer=writer, accept_uncoordinated_writes=writer is not None,
                         state_dir=None if mode == 'nostate' else base / 'state', user_config=base / 'config' / 'user.conf')
print(server.server_port, flush=True)
server.serve_forever()
