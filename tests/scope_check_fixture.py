"""Synthetic scope directories and a fake `bbh` implementing the classify contract.

Everything is fictional (*.example.test). The fake lives in a temp directory
outside the Board root; it appends one line per call to calls.log next to itself
so tests can count subprocess calls and the targets each one carried.

Rules understood by the fake (one per line, # comments):
  *.domain            any subdomain of domain
  host                exactly that host
  https://host/path*  URLs on host under /path (path-limited)
"""
import json
import stat
from pathlib import Path

FAKE = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
from urllib.parse import urlsplit

MODE = %(mode)r
HERE = Path(__file__).resolve().parent
args = sys.argv[1:]
if args[:2] != ['agents/scope_validator.py', 'classify'] or '--json' not in args:
    print('usage: classify <program> --scopes-base DIR --json', file=sys.stderr); sys.exit(2)
program = args[2]
base = Path(args[args.index('--scopes-base') + 1]) if '--scopes-base' in args else Path.home() / 'Shared' / 'scopes'
body = json.loads(sys.stdin.read())
targets = body['targets']
with open(HERE / 'calls.log', 'a') as log:
    log.write(json.dumps({'program': program, 'targets': len(targets)}) + '\n')
mode = (HERE / 'mode').read_text().strip() if (HERE / 'mode').exists() else MODE
if mode == 'fail' or (mode == 'fail-hooli' and program.startswith('hooli')):
    print('scope file unreadable', file=sys.stderr); sys.exit(3)
if mode == 'timeout':
    time.sleep(30)
if mode == 'badjson':
    print('{not json'); sys.exit(0)

def lines(name):
    path = base / program / name
    if not path.exists():
        return []
    return [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.strip().startswith('#')]

includes = lines('in-scope.txt')
excludes = lines('out-of-scope.txt') + lines('excluded.txt')
state = 'missing' if not (base / program).is_dir() else ('loaded' if includes else 'empty')

def rule_parts(rule):
    if '://' in rule:
        u = urlsplit(rule)
        return (u.hostname or '').lower(), (u.path or '/').rstrip('*')
    return rule.lower(), None

def host_match(rule_host, host):
    if rule_host.startswith('*.'):
        return host.endswith(rule_host[1:])
    return host == rule_host

def classify(target):
    if state != 'loaded':
        return 'unchecked', None, 'no scope on file'
    is_url = '://' in target
    if is_url:
        u = urlsplit(target)
        host, path = (u.hostname or '').lower(), u.path or '/'
    else:
        host, path = target.lower(), None
    for rule in excludes:
        rh, rp = rule_parts(rule)
        if host_match(rh, host) and (rp is None or (path is not None and path.startswith(rp))):
            return 'out', rule, f'excluded by {rule}'
    path_excl = [r for r in excludes if rule_parts(r)[1] is not None and host_match(rule_parts(r)[0], host)]
    for rule in includes:
        rh, rp = rule_parts(rule)
        if not host_match(rh, host):
            continue
        if rp is None:
            if path is None and path_excl:
                return 'partial', rule, f'in scope except paths under {rule_parts(path_excl[0])[1]}'
            return 'in', rule, f'matches {rule}'
        if path is None:
            return 'partial', rule, f'only paths under {rp} are in scope'
        if path.startswith(rp):
            return 'in', rule, f'matches {rule}'
    return 'out', None, 'no in-scope rule matches'

results = []
for t in targets:
    s, r, why = classify(t)
    results.append({'target': t, 'state': s, 'rule': r, 'reason': why})
if mode == 'wrongcount':
    results = results[:-1] if results else [{'target': 'x', 'state': 'in', 'rule': None, 'reason': ''}]
print(json.dumps({'version': 1, 'program': program, 'scope_dir': str(base / program), 'scope_state': state,
                  'signature': '0' * 64, 'entries': len(includes), 'exclusions': len(excludes), 'results': results}))
'''


def write_fake_bbh(directory, mode='ok'):
    """Write the fake bbh executable into directory (outside the Board root). Returns its path."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'bbh'
    path.write_text(FAKE % {'mode': mode})
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
    return path


def set_mode(bbh, mode):
    (Path(bbh).parent / 'mode').write_text(mode)


def calls(bbh):
    log = Path(bbh).parent / 'calls.log'
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def make_scope(root, program, include=(), exclude=(), exclude_file='out-of-scope.txt'):
    directory = Path(root) / 'scopes' / program
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'in-scope.txt').write_text(''.join(f'{line}\n' for line in include))
    if exclude:
        (directory / exclude_file).write_text(''.join(f'{line}\n' for line in exclude))
    return directory
