"""Disposable backend for the search browser test; the root is provided by the test."""
import sys
from pathlib import Path

import app
from tests.fixture_preferences import make_server as make_test_server
from tests.search_fixture import small_root

root = Path(sys.argv[1])
small_root(root)
server = make_test_server(root, port=0)
server.search_index.interval = 0.2
print(server.server_port, flush=True)
server.serve_forever()
