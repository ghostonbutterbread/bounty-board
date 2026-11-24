"""Synthetic report-artifact fixture. Disposable data only; no real targets.

``build(root)`` creates one lane with:
- reports/F1/ (ledger-owned dedicated folder): REPORT.md, EVIDENCE.md, poc/ and
  evidence/ files, plus things that must be skipped (dot files, _meta,
  __pycache__, symlinks out of the lane).
- reports/findings/confirmed/ (flat, shared): two findings' reports side by
  side; neither may list the other's files.
- reports/D04/ (no ledger entry, REPORT.md marker) and reports/loose/ (no marker).

Run as a script to serve it: ``python3 tests/report_artifacts_fixture.py ROOT [live|plain]``.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

LANE = 'web_bounty/alpha/web'


def png(width=24, height=16):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\x00' + b''.join(bytes((x * 10 % 256, y * 15 % 256, 160)) for x in range(width))
                   for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


_MP4 = []


def mp4(path):
    """A tiny playable clip when ffmpeg exists; otherwise placeholder bytes (cached per process)."""
    if not _MP4:
        data = b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 64
        if shutil.which('ffmpeg'):
            result = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10',
                                     '-t', '1', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'],
                                    capture_output=True, timeout=60)
            if result.returncode == 0 and result.stdout:
                data = result.stdout
        _MP4.append(data)
    path.write_bytes(_MP4[0])


def build(root):
    root = Path(root)
    lane = root / LANE
    reports = lane / 'reports'
    elsewhere = '/elsewhere/host/Shared/' + LANE  # ledger written on another machine
    f1 = reports / 'F1'
    for sub in ('poc', 'evidence', '_meta', '__pycache__'):
        (f1 / sub).mkdir(parents=True)
    (lane / 'ledgers').mkdir(parents=True)
    (lane / 'evidence').mkdir()
    (f1 / 'REPORT.md').write_text('# Synthetic finding F1\n\nSee the [demo video](poc/demo.mp4) and '
                                  '![shared shot](../../evidence/shared-shot.png).\n\n'
                                  'Outside the lane: [nope](../../../../beta/web/reports/x.md), '
                                  '[remote](https://example.invalid/a.js).\n')
    (f1 / 'EVIDENCE.md').write_text('# Evidence F1\n\nSynthetic steps.\n')
    (f1 / 'poc/exploit.py').write_text('print("synthetic proof of concept")\n')
    (f1 / 'poc/payload.js').write_text('console.log("<b>synthetic</b>");\n')
    mp4(f1 / 'poc/demo.mp4')
    (f1 / 'evidence/screenshot.png').write_bytes(png())
    (f1 / 'evidence/diagram.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgRan=1</script></svg>\n')
    (f1 / 'evidence/page.html').write_text('<!doctype html><script>window.htmlRan=1</script><p>synthetic</p>\n')
    (f1 / 'evidence/capture.har').write_text('{"log": {"entries": []}}\n')
    (f1 / 'evidence/notes.txt').write_text('synthetic note\n' * 5000)
    (f1 / '_meta/state.json').write_text('{}\n')
    (f1 / '__pycache__/exploit.cpython-314.pyc').write_bytes(b'\x00')
    (f1 / '.hidden').write_text('hidden\n')
    outside = root / 'outside-secret.txt'
    outside.write_text('outside the lane\n')
    os.symlink(outside, f1 / 'evidence/escape.txt')
    os.symlink('../../..', f1 / 'evidence/linkdir')
    (lane / 'evidence/shared-shot.png').write_bytes(png(8, 8))
    (lane / 'evidence/F1-replay.js').write_text('// synthetic replay helper\n')

    flat = reports / 'findings/confirmed'
    flat.mkdir(parents=True)
    (flat / 'F2 - HIGH - sample.md').write_text('# F2\n\n[log](F2-log.txt)\n')
    (flat / 'F2-log.txt').write_text('f2 log\n')
    (flat / 'F3 - LOW - other.md').write_text('# F3\n')
    (flat / 'F3-notes.txt').write_text('f3 notes\n')

    (reports / 'D04').mkdir()
    (reports / 'D04/REPORT.md').write_text('# D04\n')
    (reports / 'D04/poc.py').write_text('print(4)\n')
    (reports / 'loose').mkdir()
    (reports / 'loose/notes.md').write_text('# loose\n')
    (reports / 'loose/other.py').write_text('print(0)\n')

    findings = [
        {'fid': 'F1', 'title': 'Synthetic F1', 'severity': 'HIGH', 'class_name': 'xss', 'status': 'confirmed',
         'report_path': f'{elsewhere}/reports/F1/REPORT.md', 'evidence_path': f'{elsewhere}/reports/F1/EVIDENCE.md',
         'report_dir': f'{elsewhere}/reports/F1', 'poc': 'evidence/F1-replay.js'},
        {'fid': 'F2', 'title': 'Synthetic F2', 'severity': 'HIGH', 'class_name': 'idor', 'status': 'confirmed',
         'report_path': 'reports/findings/confirmed/F2 - HIGH - sample.md', 'report_dir': 'reports/findings/confirmed',
         'poc': 'Send the request twice and compare responses.'},
        {'fid': 'F3', 'title': 'Synthetic F3', 'severity': 'LOW', 'class_name': 'info', 'status': 'confirmed',
         'report_path': 'reports/findings/confirmed/F3 - LOW - other.md', 'report_dir': 'reports/findings/confirmed'},
    ]
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': findings}))
    return lane


if __name__ == '__main__':
    import app
    target = Path(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else 'live'
    build(target / 'root')
    options = {'live_edit_dir': target / 'live-state'} if mode == 'live' else {}
    server = app.make_server(target / 'root', port=0, **options)
    print(server.server_port, flush=True)
    server.serve_forever()
