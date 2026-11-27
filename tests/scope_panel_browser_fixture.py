"""Disposable synthetic backend for the scope panel browser test.
Everything is fictional (*.example.test); the root is given by the test. Programs and
scope state come from tests/scope_panel_fixture.py (acme-demo full inventory, stale;
globex-demo no inventory; initech-demo no scope directory)."""
import sys
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server
from tests.scope_panel_fixture import make_root

root = Path(sys.argv[1])
make_root(root)
server = make_test_server(root, port=0, artifact_root=root.parent / 'no-artifact-mount')
print(server.server_port, flush=True)
server.serve_forever()
