"""Disposable synthetic backend for the recon intel browser test.
Everything is fictional (hosts end in .example.test); the root is given by the test.
Programs: acme-demo (URL index, JS library, findings; no scope on file: open scope),
globex-demo (URL index only, more hosts; scope on file: shop is excluded, cdn is
partly in scope), initech-demo (no recon stores: empty states).
Scope verdicts come from a fake bbh (tests/scope_check_fixture.py) outside the root;
it is given to the scope checker only, so metadata writes stay off."""
import json
import sqlite3
import sys
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server
from tests.recon_intel_fixture import make_lane, make_url_index
from tests.scope_check_fixture import make_scope, write_fake_bbh

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
make_scope(root, 'globex-demo', include=['*.example.test'], exclude=['shop.example.test', 'https://cdn.example.test/private/*'])
bbh = write_fake_bbh(root.parent / 'fake-bbh')
server = make_test_server(root, port=0, artifact_root=root.parent / 'no-artifact-mount')
server.recon.scope.bbh = bbh
print(server.server_port, flush=True)
server.serve_forever()
