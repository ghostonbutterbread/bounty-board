"""Synthetic source tree and real board server for the MapStore browser test."""
import json
import sys
from pathlib import Path
import app
from tests.fixture_preferences import make_server as make_test_server

root = Path(sys.argv[1])
for name in ('alpha', 'beta'):
    maps = root / 'web_bounty' / name / 'web/recon/maps'
    maps.mkdir(parents=True)
    entries = [
        {'title': f'{name} gadget', 'path': '_app/gadget/index.md', 'tags': ['gadget', 'residual'], 'status': 'archived'},
        {'title': f'{name} missing', 'path': 'xss/_surface/missing/index.md', 'tags': []},
        {'title': f'{name} legacy', 'tags': []},
    ]
    index = ''.join(json.dumps(item) + '\n' for item in entries)
    if len(sys.argv) > 2 and sys.argv[2] == 'nonfinite' and name == 'alpha':
        index += '{"title":1e999,"tags":["gadget"]}\n'
    (maps / 'map.jsonl').write_text(index)
    body = maps / entries[0]['path']
    body.parent.mkdir(parents=True)
    body.write_text(f'{name} Capability:\n- grants: observed\n<img src="https://evil.invalid/pixel" onerror="alert(1)">\n[link](https://evil.invalid/)')
server = make_test_server(root, port=0)
print(server.server_port, flush=True)
server.serve_forever()
