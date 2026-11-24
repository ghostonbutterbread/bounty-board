"""Disposable synthetic backend for the finding-actions browser tests.

Usage: finding_actions_fixture.py <base> [writer|readonly|nodelete]
Creates synthetic findings and report files under <base>/data and, unless
readonly, the fake BBH writer from test_ledger_actions (which also implements
--delete-finding). Prints the port. Synthetic data only.
"""
import json
import os
import sys
from pathlib import Path

import app
from test_ledger_actions import FAKE_WRITER

base = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'writer'
root = base / 'data'
GENERATED = '<!-- generated: bounty-core-finding-report -->\n# Synthetic generated report\n'
TEMPLATE = 'LOW|MEDIUM|HIGH|CRITICAL'
alpha_lane = root / 'web_bounty' / 'alpha' / 'web'
programs = {
    'alpha': {
        'findings': [
            {'fid': 'A01', 'title': 'Alpha critical idor', 'class_name': 'idor', 'severity': 'CRITICAL', 'status': 'confirmed',
             'submission': {'state': 'not_submitted'}, 'report_path': str(alpha_lane / 'reports/A01/REPORT.md')},
            {'fid': 'A02', 'title': 'Alpha high xss', 'class_name': 'xss', 'severity': 'HIGH', 'status': 'raw'},
            {'fid': 'A03', 'title': 'Alpha medium xss', 'class_name': 'xss', 'severity': 'MEDIUM', 'status': 'confirmed',
             'report_path': str(alpha_lane / 'reports/A03/missing.md')},
            {'fid': 'A04', 'title': 'Alpha low ssrf', 'class_name': 'ssrf', 'severity': 'LOW', 'status': 'pending-review',
             'evidence_path': str(alpha_lane / 'reports/A04/EVIDENCE.md')},
            {'fid': 'A05', 'title': 'short vulnerability label', 'type': 'short vulnerability label', 'class_name': 'xss', 'severity': TEMPLATE, 'status': 'raw'},
            {'fid': 'A06', 'title': 'short novel pattern label', 'type': 'short novel pattern label', 'class_name': 'idor', 'severity': TEMPLATE, 'status': 'raw'},
            {'fid': 'A07', 'title': 'Alpha archived info', 'class_name': 'xss', 'severity': 'INFO', 'status': 'archive'},
            {'fid': 'A08', 'title': 'Alpha submitted high', 'class_name': 'idor', 'severity': 'HIGH', 'status': 'confirmed',
             'submission': {'state': 'submitted', 'result': 'valid'}},
            # Bounty Core lifecycle value for an archived finding.
            {'fid': 'A09', 'title': 'Alpha archived by bounty core', 'class_name': 'ssrf', 'severity': 'LOW', 'status': 'archived'},
        ],
        'reports': {'A01/REPORT.md': '# Alpha critical idor report\n', 'drafts/A02-notes.md': '# Draft notes\n',
                    'A05/REPORT.md': GENERATED, 'A010/REPORT.md': '# Unrelated id prefix\n',
                    'A04/EVIDENCE.md': '# Evidence\n'},
    },
    'beta': {
        'findings': [
            {'fid': 'B01', 'title': 'Beta medium xss', 'class_name': 'xss', 'severity': 'MEDIUM', 'status': 'raw'},
            {'fid': 'B02', 'title': 'Beta low idor', 'class_name': 'idor', 'severity': 'LOW', 'status': 'confirmed'},
        ],
        'reports': {},
    },
}
for name, spec in programs.items():
    lane = root / 'web_bounty' / name / 'web'
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'reports').mkdir()
    (lane / 'recon/maps').mkdir(parents=True)
    (lane / 'recon/maps/map.jsonl').write_text('')
    for rel, text in spec['reports'].items():
        (lane / 'reports' / rel).parent.mkdir(parents=True, exist_ok=True)
        (lane / 'reports' / rel).write_text(text)
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': spec['findings']}))

writer = None
if mode != 'readonly':
    (base / 'bin').mkdir()
    writer = base / 'bin/bbh'
    writer.write_text(FAKE_WRITER)
    writer.chmod(0o700)
    os.environ['FAKE_LOG'] = str(base / 'writer.log')
    os.environ['FAKE_MODE'] = str(base / 'mode')
    help_text = ('--edit-finding --patch-file --root --family --lane --from-file --set-submission '
                 '--submission-state --submission-result --submission-report')
    os.environ['FAKE_HELP'] = help_text if mode == 'nodelete' else help_text + ' --delete-finding --actor'
# Private Board state (previous status of archived findings), outside the data root.
server = app.make_server(root, port=0, writer=writer, accept_uncoordinated_writes=writer is not None, state_dir=base / 'state')
print(server.server_port, flush=True)
server.serve_forever()
