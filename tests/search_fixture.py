"""Synthetic multi-program roots for search tests (never real data)."""
import json
from pathlib import Path

WORDS = ('alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet')


def write_lane(root, family, program, lane, findings, reports):
    base = Path(root) / family / program / lane
    (base / 'ledgers').mkdir(parents=True, exist_ok=True)
    (base / 'ledgers/ledger.json').write_text(json.dumps({'findings': findings}))
    for rel, text in reports.items():
        path = base / 'reports' / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return base


def small_root(root):
    write_lane(root, 'web_bounty', 'acme', 'web', [
        {'fid': 'AC-1', 'title': 'Stored XSS in profile bio', 'severity': 'HIGH', 'class_name': 'xss', 'status': 'confirmed',
         'report_path': 'reports/confirmed/xss-profile.md'},
        {'fid': 'AC-2', 'title': 'IDOR on invoices', 'severity': 'CRITICAL', 'class_name': 'idor', 'status': 'raw'},
        {'fid': 'AC-3', 'title': 'Open redirect', 'severity': 'LOW', 'class_name': 'redirect', 'status': 'raw',
         'evidence_path': 'reports/raw/redirect-evidence.md'},
    ], {
        'confirmed/xss-profile.md': '# Profile XSS\n\nThe bio field renders <img src=x onerror=alert(1)> unescaped.\n',
        'raw/redirect-evidence.md': '# Redirect notes\n\nlogin?next= accepts absolute URLs.\n',
        'raw/unowned.md': '# Scratch\n\nnothing about invoices here, only the word zebra.\n',
        'index/xss.md': '# Xss\n',
    })
    write_lane(root, 'web_bounty', 'acme', 'api', [
        {'fid': 'AC-API-1', 'title': 'Token leak in error body', 'severity': 'MEDIUM', 'class_name': 'info-disclosure', 'status': 'raw'},
    ], {})
    write_lane(root, 'web_bounty', 'globex', 'web', [
        {'fid': 'GX-1', 'title': 'SQL injection in search', 'severity': 'EXCEPTIONAL', 'class_name': 'sqli', 'status': 'confirmed',
         'report_path': 'reports/sqli.md'},
    ], {'sqli.md': '# SQLi in search\n\nUNION based extraction through the q parameter.\n'})
    write_lane(root, 'binaries', 'initech', 'apk', [
        {'fid': 'IN-1', 'title': 'Exported activity leak', 'severity': 'LOW', 'class_name': 'intent', 'status': 'dormant'},
    ], {'notes.md': '# APK notes\n\nExported activity MainActivity can be started by any app.\n'})
    return root


def scale_root(root, programs=50, reports=200, findings=40):
    for p in range(programs):
        name = f'prog{p:03d}-{WORDS[p % 10]}'
        items = [{'fid': f'F{p}-{i}', 'title': f'{WORDS[(p + i) % 10]} issue {i}', 'severity': ('HIGH', 'LOW', 'MEDIUM')[i % 3],
                  'class_name': ('xss', 'idor', 'ssrf')[i % 3], 'status': 'raw',
                  'report_path': f'reports/r{i}.md' if i < reports else None} for i in range(findings)]
        body = {f'r{i}.md': f'# Report {i} for {name}\n\n' + (f'{WORDS[i % 10]} lorem ipsum dolor sit amet ' * 40) + f'\nneedle{i % 97}\n'
                for i in range(reports)}
        write_lane(root, 'web_bounty', name, 'web', items, body)
    return root
