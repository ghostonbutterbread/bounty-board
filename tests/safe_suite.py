"""Run synthetic Python checks without launching the real BBH fixture."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def main():
    suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'))
    tests = list(flatten(suite))
    excluded_suffix = 'test_real_bbh_metadata_write_on_disposable_fixture'
    excluded = [test for test in tests if test.id().endswith(excluded_suffix)]
    if len(excluded) != 1:
        print('Expected exactly one real-BBH fixture test to exclude; refusing to run.', file=sys.stderr)
        return 2
    print(f'Excluded real-BBH test: {excluded[0].id()}', flush=True)
    selected = [test for test in tests if test is not excluded[0]]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(selected))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
