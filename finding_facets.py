"""Facet keys for a finding: submission bucket, severity key and class key.

One mapping, two sides: GET /api/recent-reports (the Recent and Submissions
lists) filters server-side with this module (search_index.py); the browser
uses static/modules/filter-bar.js (`BoardFilterBar.keys`) to tell, right after
a pill edit, whether a row still matches the list's filter. Both run the
shared cases in static/tests/facet-cases.json, so "Duplicate" or "Not
submitted" means the same thing on both sides. Display only: nothing here
writes a ledger.
"""
import taxonomy

NONE = 'none'  # the report maps to no finding

SUBMISSIONS = (('not_submitted', 'Not submitted'), ('submitted', 'Submitted, awaiting result'), ('valid', 'Valid'),
               ('duplicate', 'Duplicate'), ('dropped', 'Dropped'), ('other', 'Other'), (NONE, 'No linked finding'))
SEVERITIES = (('exceptional', 'Exceptional'), ('critical', 'Critical'), ('high', 'High'), ('medium', 'Medium'),
              ('low', 'Low'), ('info', 'Info'), ('unknown', 'Unknown'), (NONE, 'No linked finding'))
SEVERITY_RANK = {key: rank for rank, (key, _) in enumerate(SEVERITIES)}
UNCLASSIFIED = 'unclassified'
# Submission states that mean "not submitted yet" (finding-actions.js submission()).
NOT_SUBMITTED = frozenset({'', 'not_submitted', 'not submitted', 'none', 'draft', 'unsubmitted'})
RESULTS = frozenset({'valid', 'duplicate'})


def _text(value):
    return value.strip().lower() if isinstance(value, str) else ''


def submission_key(finding):
    """Bucket key for a finding dict ({submission: {state, result}, submission_status}), or 'none' for None."""
    if finding is None:
        return NONE
    nested = finding.get('submission') if isinstance(finding.get('submission'), dict) else {}
    result = _text(nested.get('result'))
    if result in RESULTS:
        return result
    state = _text(nested.get('state')) or _text(finding.get('submission_status'))
    if state in NOT_SUBMITTED:
        return 'not_submitted'
    if state in ('submitted', 'dropped'):
        return state
    return 'other'


def severity_key(finding):
    if finding is None:
        return NONE
    return taxonomy.normalize_severity(finding.get('severity'))['value'].lower()


def class_info(finding):
    """{raw, category, subclass, label, subclass_label} for a finding, or None for None.

    `label` is the category label alone ("Cross-Site Scripting"); the subclass
    label is separate so the UI can mute it."""
    if finding is None:
        return None
    raw = finding.get('class_name', finding.get('class'))
    if isinstance(raw, dict):  # an item.finding from /api/recent-reports: {raw, category, ...}
        raw = raw.get('raw')
    result = taxonomy.normalize_class(raw if isinstance(raw, str) else None)
    category, subclass = result['category'], result['subclass']
    label = result['label'].split(' > ')[0]
    sub_label = result['label'].split(' > ', 1)[1] if ' > ' in result['label'] else None
    return {'raw': raw if isinstance(raw, str) else None, 'category': category, 'subclass': subclass,
            'label': label, 'subclass_label': sub_label}


def class_key(finding):
    info = class_info(finding)
    return NONE if info is None else info['category']


def class_options():
    """[(key, label)] for every taxonomy category, then Unclassified and No linked finding."""
    rules = taxonomy._get()['rules']
    return [(c['id'], c['label']) for c in rules['categories']] + [
        (UNCLASSIFIED, rules['unclassified']['label']), (NONE, 'No linked finding')]


def class_sort(key, label):
    """Sort tuple for the Class order: labels A to Z, Unclassified then No linked finding last."""
    return (2 if key == NONE else 1 if key == UNCLASSIFIED else 0, label.lower())
