"""Synthetic scope directories for the scope panel (scope_inventory.py).

Everything is fictional (*.example.test). Times are relative to `now` so stale and
fresh states are stable. Programs:
  acme-demo     full inventory: pull 34 days old with a failed last attempt, 14 in-scope
                and 4 out-of-scope enforced rules, apps/exe/source/other assets, release
                states (changed after the apk lane's newest file: lane stale), history with
                a baseline and changes, a hostile program policy; binaries apk and exe lanes.
  globex-demo   no inventory yet: in-scope.txt / out-of-scope.txt and a program policy only
                (pull time estimated from the in-scope.txt mtime).
  initech-demo  no scope directory: open scope.
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

DAY = 86400
HOSTILE_POLICY = ('# Acme demo policy\n\n'
                  'Test only with accounts you own.\n\n'
                  '- No denial of service\n- No social engineering of staff or support\n'
                  '- Physical access to offices is out of scope\n\n'
                  '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\n\n'
                  '[click](javascript:window.__pwned=3) **bold** `code`\n\n'
                  'Bidi ‮evil‬ and ESC \x1b[201~ stay inert.\n')


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def lane(root, family, program, name):
    path = Path(root) / family / program / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content if isinstance(content, str) else json.dumps(content, indent=1), encoding='utf-8')
    return path


def item(kind, identifier, now, *, name=None, in_scope=True, enforced=False, tier=None, release=None, **extra):
    return {'key': f'{kind}:{identifier}', 'kind': kind, 'identifier': identifier, 'name': name or identifier,
            'in_scope': in_scope, 'tier': tier, 'max_severity': 'critical', 'eligible_for_bounty': in_scope,
            'enforced': enforced, 'platform_type': None, 'description': None,
            'first_seen': iso(now - 50 * DAY), 'last_seen': iso(now - 34 * DAY), 'release': release,
            'future_key': {'ignored': True}, **extra}


def make_acme(root, now=None):
    now = now or time.time()
    scopes = Path(root) / 'scopes' / 'acme-demo'
    in_hosts = ['*.acme.example.test', '*.acme-cdn.example.test', 'api.acme.example.test',
                'https://pay.acme.example.test/api/*', '192.0.2.0/28'] + [f'svc{i}.acme.example.test' for i in range(9)]
    out_hosts = ['blog.acme.example.test', 'status.acme.example.test', 'customer.*.isp.acme.example.test',
                 'https://acme.example.test/careers/*']
    items = [item('web_wildcard' if h.startswith('*') else 'web_host', h, now, enforced=True) for h in in_hosts]
    items += [item('web_host', h, now, enforced=True, in_scope=False) for h in out_hosts]
    items += [
        item('android_app', 'com.acme.example.app', now, name='Acme for Android', tier='1', platform_type='GOOGLE_PLAY_APP_ID',
             release={'method': 'play_page', 'signal': 'Updated on Nov 20, 2026', 'version': None,
                      'checked_at': iso(now - 34 * DAY), 'changed_at': iso(now - 5 * DAY),
                      'previous_signal': 'Updated on Oct 2, 2026', 'error': None, 'extra': 1}),
        item('ios_app', '1234567890', now, name='Acme for iOS', tier='1', platform_type='APPLE_STORE_APP_ID',
             release={'method': 'itunes_lookup', 'signal': '5.3.0', 'version': '5.3.0', 'checked_at': iso(now - 34 * DAY),
                      'changed_at': None, 'previous_signal': None, 'error': None}),
        item('executable', 'acmesetup.exe', now, name='Acme Desktop', tier='2', platform_type='DOWNLOADABLE_EXECUTABLES',
             release={'method': 'download_head', 'signal': None, 'version': None, 'checked_at': iso(now - 34 * DAY),
                      'changed_at': None, 'previous_signal': None, 'error': 'no download URL'}),
        item('source_code', 'github.com/acme/legacy-sdk', now, name='acme-legacy-sdk', in_scope=False),
        item('other', '3rd party services', now, name='3rd party services', in_scope=False),
        item('mystery_kind', 'thing-‮evil', now, name='Unknown \x1b[31mkind'),
    ]
    write(scopes / 'scope-items.json', {'version': 1, 'program': 'acme-demo', 'generated_at': iso(now - 34 * DAY),
                                        'source': 'pull', 'items': items, 'unknown_top': [1, 2]})
    write(scopes / 'scope-pull.json', {'version': 1, 'program': 'acme-demo', 'platform': 'hackerone',
                                       'source_url': 'https://hackerone.example.test/acme', 'pulled_at': iso(now - 34 * DAY),
                                       'last_attempt_at': iso(now - 1 * DAY), 'last_attempt_status': 'failed',
                                       'last_error': 'HTTP 429 from platform', 'items': len(items), 'items_hash': '0' * 64})
    write(scopes / 'in-scope.txt', '\n'.join(in_hosts) + '\n')
    write(scopes / 'out-of-scope.txt', '\n'.join(out_hosts) + '\n')
    write(scopes / 'program-policy.md', HOSTILE_POLICY + ''.join(f'\nRule paragraph {i} about testing limits.\n' for i in range(30)))
    history = [
        {'at': iso(now - 50 * DAY), 'source': 'baseline', 'added': [], 'removed': [], 'changed': [], 'release_changed': []},
        {'at': iso(now - 40 * DAY), 'source': 'pull', 'added': [], 'removed': [],
         'changed': [{'key': 'web_host:status.acme.example.test', 'field': 'in_scope', 'from': True, 'to': False}], 'release_changed': []},
        {'at': iso(now - 34 * DAY), 'source': 'pull',
         'added': [{'key': 'ios_app:1234567890', 'kind': 'ios_app', 'name': 'Acme for iOS', 'in_scope': True},
                   {'key': 'web_wildcard:*.acme-cdn.example.test', 'kind': 'web_wildcard', 'name': '*.acme-cdn.example.test', 'in_scope': True}],
         'removed': [{'key': 'web_host:legacy.acme.example.test', 'kind': 'web_host', 'name': 'legacy.acme.example.test', 'in_scope': True}],
         'changed': [],
         'release_changed': [{'key': 'android_app:com.acme.example.app', 'name': 'Acme for Android',
                              'previous': 'Updated on Oct 2, 2026', 'signal': 'Updated on Nov 20, 2026'}]},
    ]
    write(scopes / 'scope-history.jsonl', '\n'.join(json.dumps(h) for h in history) + '\n{not json\n')
    # Binaries lanes: apk last touched 12 days ago (older than the release change), exe yesterday.
    apk = lane(root, 'binaries', 'acme-demo', 'apk')
    exe = lane(root, 'binaries', 'acme-demo', 'exe')
    for path, age in ((write(apk / 'notes.md', 'apk notes'), 12), (write(exe / 'notes.md', 'exe notes'), 1)):
        os.utime(path, (now - age * DAY, now - age * DAY))
    (apk / 'input').mkdir(exist_ok=True)  # a directory is not a "top-level file"
    return scopes


def make_globex(root, now=None):
    scopes = Path(root) / 'scopes' / 'globex-demo'
    write(scopes / 'in-scope.txt', '# comment\n*.globex.example.test\nshop.globex.example.test\n\n')
    write(scopes / 'out-of-scope.txt', 'admin.globex.example.test\n')
    write(scopes / 'program-policy.md', '# Globex policy\n\nBe kind.\n')
    return scopes


def make_root(root, now=None):
    """Board root with web lanes for the three programs and their scope state."""
    now = now or time.time()
    for program in ('acme-demo', 'globex-demo', 'initech-demo'):
        lane(root, 'web_bounty', program, 'web')
    make_acme(root, now)
    make_globex(root, now)
    return Path(root)
