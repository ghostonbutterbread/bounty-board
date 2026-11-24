"""Display-time severity and finding-class normalization.

Reads static/taxonomy-rules.json, the same rules file the browser module
(static/modules/taxonomy.js) uses. Nothing here writes to a ledger: raw values
stay as recorded and only additive display fields are produced.
Severity handling mirrors bounty_core.finding.normalize_severity (BBH).
"""
import json
import re
from pathlib import Path

RULES_PATH = Path(__file__).resolve().parent / 'static' / 'taxonomy-rules.json'

_state = {}


def _compile():
    rules = json.loads(RULES_PATH.read_text(encoding='utf-8'))
    categories = {c['id']: c for c in rules['categories']}
    subclasses = {c['id']: {s['id']: s for s in c['subclasses']} for c in rules['categories']}
    compiled = [(r['id'], r['to'], [re.compile(p) for p in r['patterns']]) for r in rules['rules']]
    return {'rules': rules, 'categories': categories, 'subclasses': subclasses, 'compiled': compiled,
            'ranges': re.compile(rules['severity']['ranges']),
            'junk': set(rules['junk']), 'aliases': rules['aliases']}


def _get():
    if not _state:
        _state.update(_compile())
    return _state


def normalize_label(raw):
    return re.sub(r'[^a-z0-9]+', ' ', str(raw).lower()).strip()


def _result(category, subclass, raw, confidence, reason=None, alternates=()):
    t = _get()
    if category == 'unclassified':
        label = t['rules']['unclassified']['label']
    else:
        label = t['categories'][category]['label']
        if subclass:
            label += ' > ' + t['subclasses'][category][subclass]['label']
    out = {'category': category, 'subclass': subclass, 'label': label, 'raw': raw,
           'confidence': confidence, 'alternates': list(alternates)}
    if reason:
        out['reason'] = reason
    return out


def normalize_class(raw):
    t = _get()
    if raw is None or isinstance(raw, (dict, list)):
        return _result('unclassified', None, raw, 'none', 'empty')
    text = normalize_label(raw)
    if text in t['junk']:
        return _result('unclassified', None, raw, 'none', 'placeholder' if text else 'empty')
    if text in t['aliases']:
        category, subclass = t['aliases'][text].split('/')
        return _result(category, subclass, raw, 'high')
    hits = []
    for _rule_id, target, patterns in t['compiled']:
        if any(p.search(text) for p in patterns):
            hits.append(target.split('/'))
    if not hits:
        return _result('unclassified', None, raw, 'none', 'no_rule')
    category, subclass = hits[0]
    alternates = []
    for other, _ in hits[1:]:
        if other != category and other not in alternates:
            alternates.append(other)
    words = len(text.split())
    confidence = 'low' if words > 8 or re.search(r'\b(hunter|auditor)$', text) else 'medium'
    return _result(category, subclass, raw, confidence, alternates=alternates)


def normalize_severity(raw):
    """Return {value, raw, kind, note}. value is always a BBH enum member (or
    EXCEPTIONAL, which the Board already lists); kind says how it was derived."""
    t = _get()
    sev = t['rules']['severity']
    text = '' if raw is None else str(raw).strip()
    upper = text.upper()
    if not upper:
        return {'value': 'UNKNOWN', 'raw': raw, 'kind': 'missing', 'note': None}
    if upper in sev['canonical'] or upper in sev['passthrough']:
        return {'value': upper, 'raw': raw, 'kind': 'canonical', 'note': None}
    if upper in sev['aliases']:
        return {'value': sev['aliases'][upper], 'raw': raw, 'kind': 'alias', 'note': None}
    if upper in sev['placeholders']:
        return {'value': 'UNKNOWN', 'raw': raw, 'kind': 'placeholder', 'note': 'Template placeholder, not a rating.'}
    if t['ranges'].match(upper):
        return {'value': 'UNKNOWN', 'raw': raw, 'kind': 'range', 'note': 'Range recorded; a single rating is needed.'}
    return {'value': 'UNKNOWN', 'raw': raw, 'kind': 'unmapped', 'note': sev['unmapped_notes'].get(upper)}


def annotate_finding(entry):
    """Additive display fields; the raw class_name and severity stay untouched."""
    result = normalize_class(entry.get('class_name'))
    return {'class_category': result['category'], 'class_subclass': result['subclass']}
