"""Synthetic data root for sandbox terminal tests (disposable, under TMPDIR).

Follows the BBH report packet format: every finding has a packet folder
``reports/<FID>-<slug>/`` (or legacy ``reports/<FID>/``) with EVIDENCE.md, the
submission report ``<target-domain>-<vuln-type>-<FID>.md``, optional poc.py
and ``_meta/``. Files directly in reports/ are generated navigation.
"""
import json
import os
from pathlib import Path

FAMILY, PROGRAM, LANE = 'web_bounty', 'synthetic-term', 'web'

PRIMARY = 'D1-sqli-login/example-com-sqli-D1.md'      # packet folder, report with code blocks
SECOND = 'D10-xss/example-com-xss-D10.md'             # D10 packet (D1 vs D10 edge)
THIRD = 'AC-1/EVIDENCE.md'                            # legacy FID-only packet, FID containing '-'
LEGACY = 'findings/confirmed/D10 - HIGH - stored xss.md'   # maps to D10 by file name
LEGACY_LEDGER = 'findings/open/D7 - LOW - redirect.md'     # maps to D7 by ledger report_path
NAVIGATION = 'active.md'                              # generated navigation: not a report to test

REPORT = """# Synthetic finding

Steps:

```bash
echo step-one-ok
```

```
ls poc.py
```

```python
print("hello from python")
```

```console
$ echo console-ok
console-ok
```

```bash
echo step-one-ok
```

```sh
for i in 1 2; do
  echo loop-$i
done
```
"""


def selector(path=PRIMARY):
    return {'family': FAMILY, 'program': PROGRAM, 'lane': LANE, 'path': path}


def packet(lane, name, report=None, text='# Report\n'):
    folder = lane / 'reports' / name
    (folder / '_meta').mkdir(parents=True)
    (folder / 'EVIDENCE.md').write_text('# Evidence\n')
    if report:
        (folder / report).write_text(text)
    return folder


def make_root(base):
    root = Path(base) / 'root'
    lane = root / FAMILY / PROGRAM / LANE
    d1 = packet(lane, 'D1-sqli-login', 'example-com-sqli-D1.md', REPORT)
    (d1 / 'poc.py').write_text('print("poc-ran-ok")\n')
    packet(lane, 'D10-xss', 'example-com-xss-D10.md', '# D10\n\n```bash\necho d10\n```\n')
    packet(lane, 'AC-1')
    packet(lane, 'D7-open-redirect')
    reports = lane / 'reports'
    (reports / 'findings/confirmed').mkdir(parents=True)
    (reports / LEGACY).write_text('# legacy D10\n')
    (reports / 'findings/open').mkdir(parents=True)
    (reports / LEGACY_LEDGER).write_text('# legacy D7\n')
    (reports / 'findings/confirmed/Z9 - unknown.md').write_text('# unmapped\n')
    (reports / 'findings/confirmed/D5 - no packet.md').write_text('# D5 has no packet folder\n')
    (reports / NAVIGATION).write_text('# Active findings\n')
    (reports / 'index').mkdir()
    (reports / 'index/all.md').write_text('# Index\n')
    # Folders that must not count as packets.
    for odd in ('D1-Bad-Slug', 'D1_odd', 'D1-', 'D100-x', 'd1-lower', 'D1--double'):
        (reports / odd).mkdir()
        (reports / odd / 'x.md').write_text('# odd\n')
    (lane / 'ledgers').mkdir()
    (lane / 'ledgers/ledger.json').write_text(json.dumps({'findings': [
        {'fid': 'D1', 'report_dir': 'reports/D1-sqli-login', 'evidence_path': 'reports/D1-sqli-login/EVIDENCE.md'},
        {'fid': 'D10', 'report_dir': 'reports/D10-xss'},
        {'fid': 'AC-1'},
        {'fid': 'D7', 'report_path': f'reports/{LEGACY_LEDGER}', 'report_dir': 'reports/D7-open-redirect'},
        {'fid': 'D5', 'report_dir': 'reports/D5-missing'},
    ]}))
    (root / 'outside-secret.txt').write_text('must never be visible in a sandbox\n')
    return root


def add_findings(root, fids):
    """Add packet folders and ledger entries (tests that need many reports)."""
    lane = root / FAMILY / PROGRAM / LANE
    ledger_path = lane / 'ledgers/ledger.json'
    ledger = json.loads(ledger_path.read_text())
    for fid in fids:
        packet(lane, fid)
        ledger['findings'].append({'fid': fid})
    ledger_path.write_text(json.dumps(ledger))


def tmp_base(name):
    base = Path(os.environ.get('TMPDIR', '/tmp')) / 'bbterm-tests'
    base.mkdir(parents=True, exist_ok=True)
    import tempfile
    return Path(tempfile.mkdtemp(prefix=name + '-', dir=base))
