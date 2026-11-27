"""Task-owned synthetic source with a barrier on an unrelated lane."""
import json
import os
import sqlite3
import sys
import time
import threading
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server

root = Path(sys.argv[1])
source = root / 'source'
for name in ('alpha', 'zeta'):
    lane = source / 'web_bounty' / name / 'web'
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'recon/maps').mkdir(parents=True)
    (lane / 'reports').mkdir()
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': name, 'title': name + ' finding'}]}))
    (lane / 'recon/maps/map.jsonl').write_text(json.dumps({'title': name + ' map', 'tags': ['gadget']}) + '\n')
    (lane / 'reports/report.md').write_text('# synthetic\n')
    if os.environ.get('BOARD_COLLAB_MODE'):
        (lane / 'reports/zz-nav.md').write_text('<!-- generated: bounty-core-report-navigation -->\n# index\n')
    db = sqlite3.connect(lane / 'ledgers/surface_coverage.sqlite')
    db.executescript('''CREATE TABLE surfaces (id TEXT, kind TEXT, host TEXT, surface_key TEXT, input_key TEXT, consumer TEXT, fingerprint TEXT, run_id TEXT);
    CREATE TABLE assessments (surface_id TEXT, class_name TEXT, status TEXT, pressure TEXT, reason TEXT, boundary TEXT, axes_json TEXT, evidence_json TEXT, reopen_when TEXT, assessed_fingerprint TEXT);''')
    db.execute('INSERT INTO surfaces VALUES (?,?,?,?,?,?,?,?)', ('1','endpoint','example.test','/alpha',None,None,None,None))
    db.execute('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?)', ('1','xss','untested',None,None,None,'[]','[]',None,None))
    db.commit(); db.close()

held = os.environ['HELD_SOURCE']
original = getattr(app, held)
counter_lock = threading.Lock()
count = 0
def barrier(lane, warnings):
    global count
    if lane.parent.name == 'zeta':
        with counter_lock:
            count += 1
            (root / f'entered-{count}').write_text(held)
        (root / 'entered').write_text(held)
        deadline = time.monotonic() + 30
        while not (root / 'release').exists():
            if time.monotonic() > deadline:
                raise TimeoutError('unreleased source barrier')
            time.sleep(.01)
    return original(lane, warnings)
setattr(app, held, barrier)
mode = os.environ.get('BOARD_COLLAB_MODE', '')
options = ({'collaboration_dir': root / 'private', 'report_autosave': mode == 'autosave'} if mode else {})
server = make_test_server(source, port=0, **options)
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
