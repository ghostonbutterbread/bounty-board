"""Synthetic scale check: 50 programs x 200 reports. Prints timings; asserts generous bounds."""
import statistics
import tempfile
import time
import unittest
from pathlib import Path

from tests.search_fixture import scale_root
from tests.test_search import make_index


class SearchScaleTests(unittest.TestCase):
    def test_scale_timings(self):
        with tempfile.TemporaryDirectory(prefix='search-scale-') as tmp:
            root = Path(tmp) / 'root'
            root.mkdir()
            scale_root(root, programs=50, reports=200, findings=40)
            index = make_index(root)
            self.addCleanup(index.close)
            t = time.perf_counter()
            index.refresh()
            cold = time.perf_counter() - t
            t = time.perf_counter()
            index.refresh()
            warm_pass = time.perf_counter() - t
            samples = {}
            for query in ('needle42', 'alpha issue', 'prog017', 'lorem ipsum dolor', 'xss high', 'zzzznotfound'):
                times = []
                for _ in range(15):
                    started = time.perf_counter()
                    out = index.search(query, limit=10)
                    times.append((time.perf_counter() - started) * 1000)
                samples[query] = (statistics.median(times), max(times), sum(out['counts'].values()))
            print(f'\nscale: {index._report_count} reports, {index._chars / 1e6:.1f}M chars indexed, state={index.state()}')
            print(f'scale: cold build {cold:.2f}s, no-change pass {warm_pass * 1000:.0f} ms')
            for query, (median, worst, matches) in samples.items():
                print(f'scale: q={query!r:24} median {median:6.1f} ms  max {worst:6.1f} ms  matches {matches}')
            self.assertEqual(index._report_count, 10000)
            self.assertEqual(index.state(), 'ready')
            self.assertLess(statistics.median(m for m, _, _ in samples.values()), 100)


if __name__ == '__main__':
    unittest.main()
