"""Synthetic HTTP fixture: hold a report read at a cross-process barrier."""
import json
import os
import sys
import time
from pathlib import Path

import app

root = Path(sys.argv[1])
lane = root / 'source/web_bounty/alpha/web'
(lane / 'ledgers').mkdir(parents=True)
(lane / 'reports').mkdir()
(lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'A1', 'title': 'Known synthetic finding'}]}))
(lane / 'reports/example.md').write_text('# Example\n')
read_file = app.read_file


def held_report(lane_root, relative):
    if relative == 'reports/example.md':
        (root / 'entered').write_text('held')
        deadline = time.monotonic() + 30
        while not (root / 'release').exists():
            if time.monotonic() >= deadline:
                raise TimeoutError('report barrier not released')
            time.sleep(.01)
    return read_file(lane_root, relative)


app.read_file = held_report
server = app.make_server(root / 'source', port=0)
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
