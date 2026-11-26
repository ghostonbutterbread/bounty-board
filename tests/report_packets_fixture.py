"""Serve the synthetic finding-packets lane (never real data).

Run as ``python3 tests/report_packets_fixture.py DIR [plain|edit|live]``;
prints the port. The lane is ``tests.test_report_packets.build``: packets with a
vuln-type main and sidecars, SUBMISSION.md over a registered REPORT.md, an old
REPORT.md-only packet, an evidence-only packet, a legacy copy, two folders
sharing an FID and a cross-host absolute report_path.

Modes: ``plain`` (read-only drafts), ``edit`` (shared drafts with autosave to
the Markdown file), ``live`` (live editing).
"""
import sys
from pathlib import Path

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import app
    from tests.test_report_packets import build
    target = Path(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else 'plain'
    (target / 'root').mkdir(parents=True, exist_ok=True)
    build(target / 'root')
    options = {'live': {'live_edit_dir': target / 'live-state'},
               'edit': {'collaboration_dir': target / 'private', 'report_autosave': True}}.get(mode, {})
    server = app.make_server(target / 'root', port=0, **options)
    print(server.server_port, flush=True)
    server.serve_forever()
