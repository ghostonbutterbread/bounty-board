"""Disposable synthetic backend for the interactive Recon browser test.

Usage: recon_interactive_fixture.py <base> [writer|readonly]
Synthetic root at <base>/home/Shared (HOME points at <base>/home, as BBH
resolves its URL index from $HOME/Shared). In writer mode a fake BBH dispatches
url_ingest.py to the recon fake (tests/test_recon_urls.py) and everything else
to the ledger fake (tests/test_ledger_actions.py). Prints the port.
Everything is fictional: hosts end in .example.test."""
import json
import os
import sqlite3
import sys
from pathlib import Path

import app
from tests.recon_intel_fixture import make_lane
from tests.test_ledger_actions import FAKE_WRITER
from tests.test_recon_urls import FAKE_RECON_WRITER
from tests import scope_check_fixture as scope_fx

base = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'writer'
home = base / 'home'
root = home / 'Shared'
root.mkdir(parents=True)
os.environ['HOME'] = str(home)
lane = make_lane(root, 'acme-demo', 'web', js_shared=True)
(lane / 'reports/D01').mkdir(parents=True)
(lane / 'reports/D01/REPORT.md').write_text('# Reflected value report\n')
(lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [
    {'fid': 'D01', 'title': 'Reflected value in search', 'severity': 'MEDIUM', 'class_name': 'xss', 'status': 'confirmed',
     'asset': 'https://app.example.test/r0?q=v', 'submission': {'state': 'not_submitted'}, 'report_path': str(lane / 'reports/D01/REPORT.md')},
    {'fid': 'D02', 'title': 'Order id swap', 'severity': 'HIGH', 'class_name': 'idor', 'status': 'raw', 'asset': 'api.example.test'},
    {'fid': 'D03', 'title': 'Fetcher reaches loopback', 'severity': 'LOW', 'class_name': 'ssrf', 'status': 'raw', 'asset': 'app.example.test'},
    {'fid': 'D04', 'title': 'Second reflected value', 'severity': 'LOW', 'class_name': 'xss', 'status': 'raw', 'asset': 'app.example.test'},
    {'fid': 'D05', 'title': 'Old archived note', 'severity': 'INFO', 'class_name': 'info', 'status': 'archive'},
]}))
# A target-controlled URL with a right-to-left override: shown escaped, never marked.
db = sqlite3.connect(lane / 'recon/url_index/url_index.sqlite')
db.execute("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen) "
           "VALUES (?, 'hx', 'rx', 'px', 'app.example.test', '/x', '[]', 'synthetic', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')",
           ('https://app.example.test/evil\u202e/x',))
db.commit()
db.close()
make_lane(root, 'globex-demo', 'web', findings=False)
# initech-demo has a scope that excludes static.example.test (acme-demo and globex-demo have
# none: open scope, so their flows are unchanged).
make_lane(root, 'initech-demo', 'web', findings=False)
scope_fx.make_scope(root, 'initech-demo', include=['*.example.test'], exclude=['static.example.test'])

writer = None
if mode == 'writer':
    bin_dir = base / 'bin'
    bin_dir.mkdir()
    (bin_dir / 'ledger-fake').write_text(FAKE_WRITER)
    (bin_dir / 'recon-fake').write_text(FAKE_RECON_WRITER)
    scope_fake = scope_fx.write_fake_bbh(base / 'scope-bin')
    writer = bin_dir / 'bbh'
    writer.write_text(f'#!/bin/sh\ncase "$1" in agents/url_ingest.py) exec "{bin_dir}/recon-fake" "$@";; '
                      f'agents/scope_validator.py) exec "{scope_fake}" "$@";; *) exec "{bin_dir}/ledger-fake" "$@";; esac\n')
    for name in ('ledger-fake', 'recon-fake', 'bbh'):
        (bin_dir / name).chmod(0o700)
    os.environ['FAKE_LOG'] = str(base / 'writer.log')
    os.environ['FAKE_MODE'] = str(base / 'mode')
    os.environ['FAKE_HELP'] = ('--edit-finding --patch-file --root --family --lane --from-file --set-submission --submission-state '
                               '--submission-result --submission-report --delete-finding')
server = app.make_server(root, port=0, writer=writer, accept_uncoordinated_writes=writer is not None)
print(server.server_port, flush=True)
server.serve_forever()
