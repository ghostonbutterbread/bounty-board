import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import taxonomy  # noqa: E402

CASES = json.loads((ROOT / 'static' / 'tests' / 'taxonomy-cases.json').read_text())


class TaxonomyTests(unittest.TestCase):
    def test_class_cases(self):
        for raw, category, subclass, confidence in CASES['class']:
            with self.subTest(raw=raw):
                got = taxonomy.normalize_class(raw)
                self.assertEqual((got['category'], got['subclass'], got['confidence']), (category, subclass, confidence))
                self.assertEqual(got['raw'], raw)  # raw value is carried, never rewritten

    def test_alternates(self):
        for raw, alternates in CASES['alternates']:
            self.assertEqual(taxonomy.normalize_class(raw)['alternates'], alternates, raw)

    def test_severity_cases(self):
        for raw, value, kind in CASES['severity']:
            with self.subTest(raw=raw):
                got = taxonomy.normalize_severity(raw)
                self.assertEqual((got['value'], got['kind']), (value, kind))

    def test_severity_matches_bbh_for_shared_inputs(self):
        # Mirrors bounty_core.finding.normalize_severity: P1-P5 and INFORMATIONAL aliases, else UNKNOWN.
        expected = {'P1': 'CRITICAL', 'P2': 'HIGH', 'P3': 'MEDIUM', 'P4': 'LOW', 'P5': 'INFO', 'INFORMATIONAL': 'INFO', 'P0': 'UNKNOWN', 'NONE': 'UNKNOWN', 'junk': 'UNKNOWN'}
        for raw, value in expected.items():
            self.assertEqual(taxonomy.normalize_severity(raw)['value'], value)

    def test_every_rule_target_exists(self):
        rules = json.loads(taxonomy.RULES_PATH.read_text())
        known = {c['id']: {s['id'] for s in c['subclasses']} for c in rules['categories']}
        for target in [r['to'] for r in rules['rules']] + list(rules['aliases'].values()):
            category, subclass = target.split('/')
            self.assertIn(subclass, known[category], target)

    def test_annotate_is_additive(self):
        entry = {'class_name': 'dom-xss', 'severity': 'P2'}
        self.assertEqual(taxonomy.annotate_finding(entry), {'class_category': 'xss', 'class_subclass': 'dom'})
        self.assertEqual(entry, {'class_name': 'dom-xss', 'severity': 'P2'})


if __name__ == '__main__':
    unittest.main()
