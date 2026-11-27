"""Isolated preference storage for synthetic Board servers.

Keep one temporary store per source path so restarting a synthetic server sees
its own settings but never the operator's HOME or a different fixture's state.
"""
import hashlib
import os
import tempfile
from pathlib import Path

import app


_store = tempfile.TemporaryDirectory(prefix='board-fixture-prefs-')


def make_server(root, *args, **kwargs):
    if 'user_config' not in kwargs:
        identity = hashlib.sha256(os.fsencode(os.path.abspath(root))).hexdigest()
        kwargs['user_config'] = Path(_store.name) / identity / 'user.conf'
    return app.make_server(root, *args, **kwargs)
