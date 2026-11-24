"""Synthetic live-edit Board for browser tests (disposable root, loopback, port 0).

Usage: live_browser_fixture.py ROOT. Prints the port. Reuses ROOT on restart
(PORT env selects a fixed port). A save waits at a cross-process barrier while
ROOT/hold-save exists: it writes ROOT/save-entered and waits for
ROOT/release-save.
"""
import json
import os
import sys
import time
from pathlib import Path

import app
import live_editing

root = Path(sys.argv[1])
source = root / 'source'
lane = source / 'web_bounty' / 'alpha' / 'web'
if not lane.exists():
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'reports').mkdir()
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'A1', 'title': 'Synthetic finding'}]}))
    (lane / 'reports/report.md').write_text('# Synthetic report\n\nIntro line.\n\nMiddle line.\n\nClosing line.\n')
    (lane / 'reports/zz-nav.md').write_text('<!-- generated: bounty-core-report-navigation -->\n# Index\n')

original_save = live_editing.LiveReports.save


def held_save(self, *args, **kwargs):
    if (root / 'hold-save').exists():
        (root / 'save-entered').write_text('entered')
        deadline = time.monotonic() + 30
        while not (root / 'release-save').exists():
            if time.monotonic() > deadline:
                raise TimeoutError('save barrier not released')
            time.sleep(0.01)
        (root / 'hold-save').unlink(missing_ok=True)
    return original_save(self, *args, **kwargs)


live_editing.LiveReports.save = held_save
server = app.make_server(source, port=int(os.environ.get('PORT', '0')), live_edit_dir=root / 'state')
server.live.poll_interval = 0.1
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
