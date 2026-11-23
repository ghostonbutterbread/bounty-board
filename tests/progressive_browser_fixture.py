"""Synthetic HTTP fixture: hold a report read at a cross-process barrier."""
import json
import os
import sys
import time
import threading
from pathlib import Path

import app

root = Path(sys.argv[1])
lane = root / 'source/web_bounty/alpha/web'
(lane / 'ledgers').mkdir(parents=True)
(lane / 'reports').mkdir()
(lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [{'fid': 'A1', 'title': 'Known synthetic finding'}]}))
(lane / 'reports/example.md').write_text('# Example\n')
read_file = app.read_file
read_lock = threading.Lock()
read_count = 0


def held_report(lane_root, relative, **kwargs):
    global read_count
    if relative == 'reports/example.md':
        with read_lock:
            read_count += 1
            number = read_count
        if number == 1 or not os.environ.get('FIRST_REPORT_ONLY'):
            (root / 'entered').write_text('held')
            deadline = time.monotonic() + 30
            while not (root / 'release').exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError('report barrier not released')
                time.sleep(.01)
    return read_file(lane_root, relative, **kwargs)


app.read_file = held_report
if os.environ.get('WRITER_FIXTURE'):
    app.writer_available = lambda writer: True
server = app.make_server(root / 'source', port=0, **(
    {'writer': root / 'fake-writer', 'accept_uncoordinated_writes': True}
    if os.environ.get('WRITER_FIXTURE') else {}))
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
