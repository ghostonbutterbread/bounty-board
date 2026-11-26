"""Serve the synthetic evidence-artifacts lane (never real data).

Run as ``python3 tests/evidence_artifacts_fixture.py DIR [live|plain]``; prints
the port. The lane is ``tests.test_evidence_artifacts.build``: a BBH packet
with a submission report and EVIDENCE.md, evidence-only findings, an
evidence_path with another name, a report_path named EVIDENCE.md, an
absolute evidence_path from another host and unowned evidence files.
"""
import sys
from pathlib import Path

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import app
    from tests.test_evidence_artifacts import build
    target = Path(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else 'plain'
    (target / 'root').mkdir(parents=True, exist_ok=True)
    build(target / 'root')
    options = {'live_edit_dir': target / 'live-state'} if mode == 'live' else {}
    server = app.make_server(target / 'root', port=0, **options)
    print(server.server_port, flush=True)
    server.serve_forever()
