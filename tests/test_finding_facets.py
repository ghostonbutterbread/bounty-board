"""Shared facet-key cases (static/tests/facet-cases.json) against finding_facets.py.

static/tests/filter-rail.test.cjs runs the same file against the browser
mapping (BoardFilterRail.keys), so Recent and Submissions agree."""
import json
import unittest
from pathlib import Path

import finding_facets

CASES = json.loads((Path(__file__).resolve().parent.parent / 'static/tests/facet-cases.json').read_text(encoding='utf-8'))['cases']


class SharedCases(unittest.TestCase):
    def test_cases(self):
        self.assertGreaterEqual(len(CASES), 30)
        for case in CASES:
            with self.subTest(case=case['name']):
                f = case['finding']
                self.assertEqual((finding_facets.submission_key(f), finding_facets.severity_key(f), finding_facets.class_key(f)),
                                 (case['submission'], case['severity'], case['class']))

    def test_every_expected_key_is_an_option(self):
        subs = {k for k, _ in finding_facets.SUBMISSIONS}
        sevs = {k for k, _ in finding_facets.SEVERITIES}
        classes = {k for k, _ in finding_facets.class_options()}
        for case in CASES:
            self.assertIn(case['submission'], subs)
            self.assertIn(case['severity'], sevs)
            self.assertIn(case['class'], classes)

    def test_class_info_labels(self):
        info = finding_facets.class_info({'class_name': 'Cross-Site Scripting (stored)'})
        self.assertEqual(info, {'raw': 'Cross-Site Scripting (stored)', 'category': 'xss', 'subclass': 'stored',
                                'label': 'Cross-Site Scripting', 'subclass_label': 'Stored'})
        self.assertIsNone(finding_facets.class_info(None))
        self.assertEqual(finding_facets.class_info({'class_name': ''})['label'], 'Unclassified')

    def test_class_order(self):
        options = sorted(finding_facets.class_options(), key=lambda o: finding_facets.class_sort(*o))
        self.assertEqual([k for k, _ in options[-2:]], ['unclassified', 'none'])
        labels = [label.lower() for _, label in options[:-2]]
        self.assertEqual(labels, sorted(labels))


if __name__ == '__main__':
    unittest.main()
