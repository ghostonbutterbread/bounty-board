"""Disposable synthetic backend for the recon intel browser test.
Everything is fictional (hosts end in .example.test); the root is given by the test.
Programs: acme-demo (URL index, JS library, findings), globex-demo (URL index only,
more hosts), initech-demo (no recon stores: empty states)."""
import json
import sqlite3
import sys
from pathlib import Path

import app
from tests.recon_intel_fixture import make_lane, make_url_index

root = Path(sys.argv[1])
make_lane(root, 'acme-demo', 'web', js_shared=True)
globex = make_lane(root, 'globex-demo', 'web', findings=False, url_index=False)
make_url_index(globex / 'recon/url_index/url_index.sqlite',
               hosts={'shop.example.test': 140, 'cdn.example.test': 20, 'auth.example.test': 12}, tests=False)
make_lane(root, 'initech-demo', 'web', findings=False, url_index=False)
# Target-controlled values as BBH stores them (parse_qsl-decoded): an ESC/Ctrl-U/CR
# parameter key and a host with a right-to-left override (review 9 blocker 2).
db = sqlite3.connect(globex / 'recon/url_index/url_index.sqlite')
cur = db.execute("INSERT INTO urls (canonical_url, url_hash, route_hash, param_hash, host, path, param_keys, source, first_seen, last_seen) "
                 "VALUES (?, 'hx', 'rx', 'px', ?, '/', ?, 'synthetic', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')",
                 ('https://evil\u202e.example.test/?a=1', 'evil\u202e.example.test', json.dumps(['\x1b[201~\x15touch PWNED\rredirect_url'])))
db.execute("INSERT INTO parameter_observations (url_id, param_key, location, source, value_shape, lane_hints, first_seen, last_seen) "
           "VALUES (?, ?, 'query', 'synthetic', 'text', '[\"open-redirect\"]', 'a', 'b')", (cur.lastrowid, '\x1b[201~\x15touch PWNED\rredirect_url'))
db.commit()
db.close()
server = app.make_server(root, port=0, artifact_root=root.parent / 'no-artifact-mount')
print(server.server_port, flush=True)
server.serve_forever()
