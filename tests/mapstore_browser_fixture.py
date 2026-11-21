"""Synthetic source tree and real board server for the MapStore browser test."""
import json
import sys
from pathlib import Path
import app

root = Path(sys.argv[1])
for name in ('alpha', 'beta'):
    maps = root / 'web_bounty' / name / 'web/recon/maps'
    maps.mkdir(parents=True)
    entries = [
        {'title': f'{name} gadget', 'path': '_app/gadget/index.md', 'tags': ['gadget', 'residual'], 'status': 'archived'},
        {'title': f'{name} missing', 'path': 'xss/_surface/missing/index.md', 'tags': []},
        {'title': f'{name} legacy', 'tags': []},
    ]
    (maps / 'map.jsonl').write_text(''.join(json.dumps(item) + '\n' for item in entries))
    body = maps / entries[0]['path']
    body.parent.mkdir(parents=True)
    body.write_text(f'{name} Capability:\n- grants: observed\n<img src="https://evil.invalid/pixel" onerror="alert(1)">\n[link](https://evil.invalid/)')
server = app.make_server(root, port=0)
print(server.server_port, flush=True)
server.serve_forever()
