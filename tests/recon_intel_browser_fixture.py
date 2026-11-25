"""Disposable synthetic backend for the recon intel browser test.
Everything is fictional (hosts end in .example.test); the root is given by the test.
Programs: acme-demo (URL index, JS library, findings), globex-demo (URL index only,
more hosts), initech-demo (no recon stores: empty states)."""
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
server = app.make_server(root, port=0, artifact_root=root.parent / 'no-artifact-mount')
print(server.server_port, flush=True)
server.serve_forever()
