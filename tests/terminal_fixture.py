"""Synthetic data root for sandbox terminal tests (disposable, under TMPDIR)."""
import json
import os
from pathlib import Path

FAMILY, PROGRAM, LANE = 'web_bounty', 'synthetic-term', 'web'

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


def selector(path='finding-a/REPORT.md'):
    return {'family': FAMILY, 'program': PROGRAM, 'lane': LANE, 'path': path}


def make_root(base):
    """Build a lane with three report layouts:

    - reports/finding-a/REPORT.md        dedicated folder (folder convention) with poc.py
    - reports/flat.md, reports/other.md  reports directly in reports/ (shared root)
    - reports/bucket/one.md, two.md      a bucket folder holding several reports
    - reports/solo/notes.md              a non-dedicated folder with a single report
    """
    root = Path(base) / 'root'
    lane = root / FAMILY / PROGRAM / LANE
    folder = lane / 'reports' / 'finding-a'
    folder.mkdir(parents=True)
    (folder / 'REPORT.md').write_text(REPORT)
    (folder / 'poc.py').write_text('print("poc-ran-ok")\n')
    (lane / 'reports' / 'flat.md').write_text('# Flat\n\n```bash\necho flat\n```\n')
    (lane / 'reports' / 'other.md').write_text('# Other\n')
    (lane / 'reports' / 'secret-sibling.txt').write_text('sibling\n')
    (lane / 'reports' / 'bucket').mkdir()
    (lane / 'reports' / 'bucket' / 'one.md').write_text('# One\n')
    (lane / 'reports' / 'bucket' / 'two.md').write_text('# Two\n')
    (lane / 'reports' / 'solo').mkdir()
    (lane / 'reports' / 'solo' / 'notes.md').write_text('# Solo\n')
    (lane / 'reports' / 'solo' / 'run.sh').write_text('echo solo\n')
    (lane / 'ledgers').mkdir()
    (lane / 'ledgers' / 'ledger.json').write_text(json.dumps({'findings': []}))
    (root / 'outside-secret.txt').write_text('must never be visible in a sandbox\n')
    return root


def tmp_base(name):
    base = Path(os.environ.get('TMPDIR', '/tmp')) / 'bbterm-tests'
    base.mkdir(parents=True, exist_ok=True)
    import tempfile
    return Path(tempfile.mkdtemp(prefix=name + '-', dir=base))
