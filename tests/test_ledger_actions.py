"""Ledger action endpoints against a disposable fake BBH writer (synthetic data only)."""
import json
import os
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

import app

FAKE_WRITER = r'''#!PYTHON
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ['FAKE_LOG'])
if '--help' in args:
    if args[0] == 'agents/map_store.py':
        print(os.environ.get('FAKE_STORE_HELP', 'usage: map_store.py [-h] {behavior,init,write,query,update-status} ...'))
    else:
        print(os.environ.get('FAKE_HELP', '--edit-finding --patch-file --root --family --lane --from-file --set-submission --submission-state --submission-result --submission-report'))
    sys.exit(0)
with log.open('a') as f:
    f.write(json.dumps(args) + '\n')
mode = Path(os.environ['FAKE_MODE']).read_text().strip() if Path(os.environ['FAKE_MODE']).exists() else 'ok'
if mode == 'fail' or (mode == 'fail-edit' and '--edit-finding' in args):
    sys.exit(3)
def opt(name):
    for arg in args:
        if arg.startswith(name + '='):
            return arg[len(name) + 1:]
    if name not in args:
        return None
    value = args[args.index(name) + 1]
    if value.startswith('-'):
        sys.exit(2)  # argparse: "expected one argument"
    return value
if args[0] == 'agents/map_store.py':
    maps = Path(opt('--root')) / opt('--family') / opt('--program') / opt('--lane') / 'recon/maps'
    rel = f"{opt('--surface')}/_surface/{opt('--run-id')}/index.md"
    (maps / rel).parent.mkdir(parents=True, exist_ok=True)
    (maps / rel).write_text(Path(opt('--body-file')).read_text())
    (log.parent / 'last-body.md').write_text(Path(opt('--body-file')).read_text())
    with (maps / 'map.jsonl').open('a') as f:
        f.write(json.dumps({'title': opt('--title'), 'surface': opt('--surface'), 'scope': opt('--scope'), 'path': rel,
                            'tags': sorted(opt('--tags').split(',')), 'status': 'active'}) + '\n')
    if mode == 'touch-ledger':
        path = Path(opt('--root')) / opt('--family') / opt('--program') / opt('--lane') / 'ledgers/ledger.json'
        data = json.loads(path.read_text()); data['findings'][0]['severity'] = 'HIGH'; path.write_text(json.dumps(data))
    sys.exit(0)
root, family, lane, program = opt('--root'), opt('--family'), opt('--lane'), args[1]
path = Path(root) / family / program / lane / 'ledgers/ledger.json'
data = json.loads(path.read_text())
if '--set-submission' in args:
    fid = opt('--set-submission')
    for f in data['findings']:
        if f['fid'] == fid:
            sub = dict(f.get('submission') or {})
            sub['state'] = 'dropped' if mode == 'wrong' else opt('--submission-state')
            for key, flag in (('result', '--submission-result'), ('report', '--submission-report')):
                if opt(flag):
                    sub[key] = opt(flag).strip()
            f['submission'] = sub
elif '--edit-finding' in args:
    patch = json.loads(Path(opt('--patch-file')).read_text())
    for f in data['findings']:
        if f['fid'] == opt('--edit-finding'):
            f.update(patch)
elif '--from-file' in args:
    note = Path(opt('--from-file')).read_text()
    (log.parent / 'last-note.md').write_text(note)
    if mode == 'dedupe':
        print('Duplicate: D01 overlaps with Synthetic one')
        sys.exit(1)
    else:
        fields = dict(line.split(': ', 1) for line in note.splitlines() if ': ' in line)
        fid = 'D%02d' % (len(data['findings']) + 1)
        data['findings'].append({'fid': fid, 'title': fields['Title'], 'class_name': fields['Class'],
                                 'severity': fields['Severity'], 'first_seen': '2026-01-02T00:00:00Z',
                                 'submission': {'state': 'not_submitted'}})
if mode == 'touch-other':
    for f in data['findings']:
        if f['fid'] == 'D02':
            f['severity'] = 'CRITICAL'
# BBH replaces the ledger atomically (new inode); mirror that.
tmp = path.with_name('ledger.json.tmp')
tmp.write_text(json.dumps(data))
tmp.replace(path)
'''.replace('PYTHON', sys.executable)


class LedgerActionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / 'root'
        lane = self.root / 'web_bounty/fictional/web'
        (lane / 'ledgers').mkdir(parents=True)
        (lane / 'reports').mkdir()
        self.ledger = lane / 'ledgers/ledger.json'
        self.ledger.write_text(json.dumps({'findings': [
            {'fid': 'D01', 'title': 'Synthetic one', 'class_name': 'xss', 'severity': 'LOW',
             'first_seen': '2026-01-01T00:00:00Z', 'last_seen': '2026-02-01T00:00:00Z',
             'submission': {'state': 'not_submitted'}, 'evidence_path': 'reports/D01/EVIDENCE.md'},
            {'fid': 'D02', 'title': 'Synthetic two', 'class_name': 'idor', 'severity': 'MEDIUM'}]}))
        self.log = self.base / 'writer.log'
        self.mode = self.base / 'mode'
        writer = self.base / 'bbh'
        writer.write_text(FAKE_WRITER)
        writer.chmod(0o700)
        self.writer = writer
        self.env = {k: os.environ.get(k) for k in ('FAKE_LOG', 'FAKE_MODE', 'FAKE_HELP')}
        os.environ['FAKE_LOG'] = str(self.log)
        os.environ['FAKE_MODE'] = str(self.mode)
        os.environ.pop('FAKE_HELP', None)
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.shutdown()
            self.thread.join()
            self.server.server_close()
        for key, value in self.env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def start(self, writer=True):
        self.server = app.make_server(self.root, 0, writer=self.writer if writer else None, accept_uncoordinated_writes=writer)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, path, payload=None, headers=None):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        base = {'Origin': f'http://127.0.0.1:{self.server.server_port}', 'Content-Type': 'application/json',
                'X-Requested-With': 'Bounty-Board'}
        base.update(headers or {})
        conn.request(method, path, body=json.dumps(payload) if payload is not None else None,
                     headers={k: v for k, v in base.items() if v is not None})
        response = conn.getresponse()
        body = json.loads(response.read() or b'null')
        conn.close()
        return response.status, body

    def data(self):
        return self.request('GET', '/api/data')[1]

    def invocations(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def submission_payload(self, **submission):
        data = self.data()
        finding = data['programs'][0]['lanes'][0]['findings'][0]
        return {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'D01',
                'expected_revision': finding['metadata_revision'], 'root_instance': data['root_instance'],
                'submission': submission or {'state': 'submitted'}}

    def test_capabilities_and_dates(self):
        self.start()
        data = self.data()
        actions = data['capabilities']['ledger_actions']
        self.assertTrue(actions['submission']['enabled'])
        self.assertTrue(actions['submission']['local_only'])
        self.assertEqual(actions['submission']['states'], ['not_submitted', 'submitted', 'dropped'])
        self.assertTrue(actions['add_finding']['enabled'])
        for store in ('gadgets', 'map'):
            self.assertTrue(actions['reclassify'][store]['enabled'])
        finding = data['programs'][0]['lanes'][0]['findings'][0]
        self.assertEqual(finding['first_seen'], '2026-01-01T00:00:00Z')
        self.assertEqual(finding['last_seen'], '2026-02-01T00:00:00Z')

    def test_capabilities_disabled_without_writer_or_flags(self):
        self.start(writer=False)
        actions = self.data()['capabilities']['ledger_actions']
        self.assertFalse(actions['submission']['enabled'])
        self.assertFalse(actions['add_finding']['enabled'])
        self.assertFalse(actions['reclassify']['gadgets']['enabled'])
        status, body = self.request('POST', '/api/finding/submission', {'x': 1})
        self.assertEqual(status, 503)
        self.assertEqual(self.invocations(), [])

    def test_writer_without_submission_flags_keeps_action_disabled(self):
        os.environ['FAKE_HELP'] = '--edit-finding --patch-file --root --family --lane'
        self.start()
        actions = self.data()['capabilities']['ledger_actions']
        self.assertFalse(actions['submission']['enabled'])
        self.assertFalse(actions['add_finding']['enabled'])
        self.assertEqual(self.request('POST', '/api/finding/submission', self.submission_payload())[0], 503)
        self.assertEqual(self.invocations(), [])

    def test_submission_success_records_exact_local_state(self):
        self.start()
        payload = self.submission_payload(state='submitted', result='duplicate', report='R-17')
        status, body = self.request('POST', '/api/finding/submission', payload)
        self.assertEqual(status, 200, body)
        self.assertEqual(body['finding']['submission'], {'state': 'submitted', 'result': 'duplicate', 'report': 'R-17'})
        args = self.invocations()[-1]
        self.assertEqual(args[:2], ['agents/manual_hunter.py', 'fictional'])
        self.assertEqual(args[args.index('--set-submission'):],
                         ['--set-submission', 'D01', '--submission-state', 'submitted',
                          '--submission-result', 'duplicate', '--submission-report=R-17'])
        self.assertEqual(args[args.index('--root') + 1], str(self.root.absolute()))
        # Revision moved on: the old payload is now stale and refused.
        self.assertEqual(self.request('POST', '/api/finding/submission', payload)[1]['error'], 'finding_changed')
        self.assertEqual(len(self.invocations()), 1)

    def test_untouched_rows_get_rebased_revisions_only(self):
        self.start()
        data = self.data()
        old = {f['fid']: f['metadata_revision'] for f in data['programs'][0]['lanes'][0]['findings']}
        status, body = self.request('POST', '/api/finding/submission', self.submission_payload())
        self.assertEqual(status, 200, body)
        new = {f['fid']: f['metadata_revision'] for f in self.data()['programs'][0]['lanes'][0]['findings']}
        self.assertNotEqual(old['D02'], new['D02'], 'atomic ledger replacement changes every revision')
        self.assertEqual(body['revisions'], {'D02': [old['D02'], new['D02']]})
        # The rebased revision is accepted for the untouched row.
        payload = {**self.submission_payload(), 'fid': 'D02', 'expected_revision': body['revisions']['D02'][1]}
        self.assertEqual(self.request('POST', '/api/finding/submission', payload)[0], 200)
        # A row changed during the write is not rolled forward.
        self.mode.write_text('touch-other')
        status, body = self.request('POST', '/api/finding/submission', self.submission_payload(state='dropped'))
        self.assertEqual(status, 200, body)
        self.assertNotIn('D02', body['revisions'])
        self.assertNotIn('D01', body['revisions'])

    def test_submission_refusals_do_not_invoke_writer(self):
        self.start()
        payload = self.submission_payload()
        cases = {
            'no requested-with': (403, payload, {'X-Requested-With': None}),
            'cross origin': (403, payload, {'Origin': 'http://evil.test'}),
            'form content type': (403, payload, {'Content-Type': 'text/plain'}),
            'missing revision': (400, {k: v for k, v in payload.items() if k != 'expected_revision'}, None),
            'extra key': (400, {**payload, 'patch': {}}, None),
            'bad state': (400, {**payload, 'submission': {'state': 'accepted'}}, None),
            'bad result': (400, {**payload, 'submission': {'state': 'submitted', 'result': 'triaged'}}, None),
            'newline report': (400, {**payload, 'submission': {'state': 'submitted', 'report': 'a\nb'}}, None),
            'extra submission key': (400, {**payload, 'submission': {'state': 'submitted', 'url': 'x'}}, None),
            'bad fid': (400, {**payload, 'fid': '../D01'}, None),
            'bad program': (400, {**payload, 'program': '../x'}, None),
            'stale revision': (409, {**payload, 'expected_revision': '0' * 64}, None),
            'root mismatch': (409, {**payload, 'root_instance': '0' * 64}, None),
            'unknown fid': (404, {**payload, 'fid': 'D99'}, None),
        }
        for name, (expected, body, headers) in cases.items():
            with self.subTest(name):
                self.assertEqual(self.request('POST', '/api/finding/submission', body, headers)[0], expected)
        self.assertEqual(self.invocations(), [])

    def test_submission_verification_failure_disables_writer(self):
        self.start()
        self.mode.write_text('wrong')
        payload = self.submission_payload()
        status, body = self.request('POST', '/api/finding/submission', payload)
        self.assertEqual((status, body['error']), (502, 'verification_failed'))
        self.assertFalse(self.data()['capabilities']['finding_metadata'])
        self.assertEqual(self.request('POST', '/api/finding/submission', payload)[0], 503)
        self.assertEqual(len(self.invocations()), 1)

    def test_submission_writer_failure_disables_writer(self):
        self.start()
        self.mode.write_text('fail')
        status, body = self.request('POST', '/api/finding/submission', self.submission_payload())
        self.assertEqual((status, body['error']), (502, 'writer_failed'))
        self.assertFalse(self.data()['capabilities']['ledger_actions']['submission']['enabled'])

    def add_payload(self, **finding):
        data = self.data()
        return {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'root_instance': data['root_instance'],
                'finding': finding or {'title': 'Synthetic added', 'class_name': 'idor', 'severity': 'INFO',
                                       'file': 'src/x.js', 'description': 'Fixture only.'}}

    def test_add_finding_success_and_note_format(self):
        self.start()
        status, body = self.request('POST', '/api/finding/new', self.add_payload())
        self.assertEqual(status, 200, body)
        self.assertEqual(body['finding']['fid'], 'D03')
        self.assertEqual(body['finding']['class_name'], 'idor')
        self.assertEqual((self.base / 'last-note.md').read_text(),
                         'Title: Synthetic added\nClass: idor\nSeverity: INFO\nFile: src/x.js\nDescription: Fixture only.\n')
        self.assertIn('--from-file', self.invocations()[-1])
        self.assertEqual(len(json.loads(self.ledger.read_text())['findings']), 3)

    def test_add_finding_dedupe_is_reported_without_disabling(self):
        self.start()
        self.mode.write_text('dedupe')
        status, body = self.request('POST', '/api/finding/new', self.add_payload())
        self.assertEqual((status, body['error']), (409, 'not_added'))
        self.assertEqual(len(json.loads(self.ledger.read_text())['findings']), 2)
        self.assertTrue(self.data()['capabilities']['ledger_actions']['add_finding']['enabled'])

    def test_add_finding_refusals(self):
        self.start()
        good = self.add_payload()['finding']
        for name, finding in {
            'newline title': {**good, 'title': 'a\nClass: rce'},
            'short title': {**good, 'title': 'ab'},
            'bad class': {**good, 'class_name': 'XSS Stored'},
            'na severity': {**good, 'severity': 'N/A'},
            'extra field': {**good, 'status': 'raw'},
            'newline description': {**good, 'description': 'x\nSeverity: CRITICAL'},
            'missing class': {k: v for k, v in good.items() if k != 'class_name'},
            'missing file': {k: v for k, v in good.items() if k != 'file'},
            'empty description': {**good, 'description': '  '},
        }.items():
            with self.subTest(name):
                self.assertEqual(self.request('POST', '/api/finding/new', self.add_payload(**finding))[0], 400)
        self.assertEqual(self.request('POST', '/api/finding/new', {**self.add_payload(), 'root_instance': '0' * 64})[0], 409)
        self.assertEqual(self.request('POST', '/api/finding/new', {**self.add_payload(), 'program': 'missing'})[0], 404)
        self.mode.write_text('fail')
        self.assertEqual(self.invocations(), [])

    def reclassify_payload(self, destination='gadgets', **details):
        payload = self.submission_payload()
        del payload['submission']
        base = {'title': 'Synthetic gadget', 'surface': 'xss', 'note': 'Line one\nLine two', 'tags': ['legacy'], 'archive_original': False}
        if destination == 'gadgets':
            base.update(tier='confirmed', capability={'grants': 'synthetic effect', 'requires': 'none', 'crosses': 'client->server',
                                                       'chain_status': 'deferred', 'chain_watch': 'later'})
        base.update(details)
        return {**payload, 'destination': destination, 'details': base}

    def test_reclassify_to_gadgets_creates_entry_and_keeps_finding(self):
        self.start()
        self.assertTrue(self.data()['capabilities']['ledger_actions']['reclassify']['gadgets']['enabled'])
        before = json.loads(self.ledger.read_text())['findings'][0]
        status, body = self.request('POST', '/api/finding/reclassify', self.reclassify_payload(archive_original=True))
        self.assertEqual(status, 200, body)
        self.assertEqual(body['map_entry']['tags'], sorted(['gadget', 'finding-d01', 'from-ledger', 'legacy']))
        after = json.loads(self.ledger.read_text())['findings']
        self.assertEqual(len(after), 2)
        self.assertEqual(after[0]['evidence_path'], before['evidence_path'])
        self.assertEqual(after[0]['severity'], 'LOW')
        self.assertEqual(after[0]['status'], 'archive')
        self.assertIn('Reclassified to Gadgets', after[0]['review_notes'])
        self.assertIn('recon/maps/xss/_surface/', after[0]['review_notes'])
        body_text = (self.base / 'last-body.md').read_text()
        for expected in ('Source finding: D01 (web_bounty/fictional/web)', 'Severity as recorded on the finding: LOW',
                         'Capability:\n- grants: synthetic effect', '- chain_status: deferred', 'Line one\nLine two'):
            self.assertIn(expected, body_text)
        store_call, edit_call = self.invocations()
        self.assertEqual(store_call[:2], ['agents/map_store.py', 'write'])
        self.assertEqual(store_call[store_call.index('--scope') + 1], 'surface')
        self.assertIn('--edit-finding', edit_call)
        gadgets = self.data()['programs'][0]['lanes'][0]['gadgets']
        self.assertEqual([g['title'] for g in gadgets], ['Synthetic gadget'])
        # A second move of the same finding is refused before any writer call.
        status, body = self.request('POST', '/api/finding/reclassify', {**self.reclassify_payload(), 'expected_revision': self.data()['programs'][0]['lanes'][0]['findings'][0]['metadata_revision']})
        self.assertEqual((status, body['error']), (409, 'already_reclassified'))
        self.assertEqual(len(self.invocations()), 2)

    def test_reclassify_to_mapstore_preserves_existing_notes(self):
        data = json.loads(self.ledger.read_text())
        data['findings'][0]['review_notes'] = 'Earlier note.'
        self.ledger.write_text(json.dumps(data))
        self.start()
        status, body = self.request('POST', '/api/finding/reclassify', self.reclassify_payload('map'))
        self.assertEqual(status, 200, body)
        self.assertNotIn('gadget', body['map_entry']['tags'])
        finding = json.loads(self.ledger.read_text())['findings'][0]
        self.assertTrue(finding['review_notes'].startswith('Earlier note.\n\nReclassified to MapStore'))
        self.assertNotIn('status', finding)
        self.assertEqual(self.data()['programs'][0]['lanes'][0]['gadgets'], [])

    def test_reclassify_refusals(self):
        self.start()
        cap = {'grants': 'x', 'requires': 'y', 'crosses': 'z', 'chain_status': 'ready'}
        cases = {
            'bad destination': {**self.reclassify_payload(), 'destination': 'reports'},
            'gadget tag on map': self.reclassify_payload('map', tags=['gadget']),
            'finding tag': self.reclassify_payload('map', tags=['finding-d09']),
            'capability on map': self.reclassify_payload('map', capability=cap),
            'missing capability': self.reclassify_payload(capability={'grants': 'x'}),
            'bad chain status': self.reclassify_payload(capability={**cap, 'chain_status': 'done'}),
            'residual without fields': self.reclassify_payload(tier='residual', capability=cap),
            'newline in capability': self.reclassify_payload(capability={**cap, 'grants': 'a\nCapability:'}),
            'bad surface': self.reclassify_payload(surface='../x'),
            'archive not bool': self.reclassify_payload(archive_original='yes'),
        }
        for name, body in cases.items():
            with self.subTest(name):
                self.assertEqual(self.request('POST', '/api/finding/reclassify', body)[0], 400)
        self.assertEqual(self.request('POST', '/api/finding/reclassify', {**self.reclassify_payload(), 'expected_revision': '0' * 64})[0], 409)
        self.assertEqual(self.request('POST', '/api/finding/reclassify', self.reclassify_payload(), {'Origin': 'http://evil.test'})[0], 403)
        self.assertEqual(self.invocations(), [])

    def test_reclassify_partial_when_finding_changes_between_steps(self):
        self.start()
        self.mode.write_text('touch-ledger')
        status, body = self.request('POST', '/api/finding/reclassify', self.reclassify_payload())
        self.assertEqual((status, body['error']), (409, 'partial_reclassify'))
        self.assertIn('xss/_surface/', body['map_entry']['path'])
        self.assertEqual(len(self.invocations()), 1)
        self.assertNotIn('review_notes', json.loads(self.ledger.read_text())['findings'][0])

    def test_reclassify_retry_finishes_a_half_finished_move(self):
        self.start()
        self.mode.write_text('touch-ledger')
        self.assertEqual(self.request('POST', '/api/finding/reclassify', self.reclassify_payload())[1]['error'], 'partial_reclassify')
        self.mode.write_text('ok')
        # A retry to the other store is not folded into the existing entry.
        self.assertEqual(self.request('POST', '/api/finding/reclassify', self.reclassify_payload('map'))[1]['error'], 'already_reclassified')
        status, body = self.request('POST', '/api/finding/reclassify', self.reclassify_payload())
        self.assertEqual(status, 200, body)
        finding = json.loads(self.ledger.read_text())['findings'][0]
        self.assertIn(f"recon/maps/{body['map_entry']['path']}", finding['review_notes'])
        self.assertEqual(len(self.data()['programs'][0]['lanes'][0]['gadgets']), 1, 'no second entry')
        self.assertEqual([c[0] for c in self.invocations()], ['agents/map_store.py', 'agents/manual_hunter.py'])
        # Once annotated, a further move is a real duplicate.
        self.assertEqual(self.request('POST', '/api/finding/reclassify', self.reclassify_payload())[1]['error'], 'already_reclassified')
        self.assertEqual(len(self.invocations()), 2)

    def test_values_starting_with_a_dash_reach_the_writer_intact(self):
        self.start()
        status, body = self.request('POST', '/api/finding/submission', self.submission_payload(state='submitted', report='-x'))
        self.assertEqual(status, 200, body)
        self.assertEqual(body['finding']['submission']['report'], '-x')
        status, body = self.request('POST', '/api/finding/reclassify', self.reclassify_payload('map', title='-abc'))
        self.assertEqual(status, 200, body)
        self.assertEqual(body['map_entry']['title'], '-abc')
        self.assertTrue(self.data()['capabilities']['finding_metadata'])

    def test_unicode_line_breaks_are_refused_in_single_line_values(self):
        self.start()
        good = self.add_payload()['finding']
        for sep in ('\x85', '\u2028', '\u2029'):
            for field in ('title', 'file', 'description'):
                with self.subTest(sep=repr(sep), field=field):
                    body = {**self.add_payload(), 'finding': {**good, field: f'abc{sep}Severity: CRITICAL'}}
                    self.assertEqual(self.request('POST', '/api/finding/new', body)[0], 400)
            with self.subTest(sep=repr(sep), field='report'):
                payload = self.submission_payload(state='submitted', report=f'R{sep}1')
                self.assertEqual(self.request('POST', '/api/finding/submission', payload)[0], 400)
            with self.subTest(sep=repr(sep), field='move title'):
                self.assertEqual(self.request('POST', '/api/finding/reclassify', self.reclassify_payload('map', title=f'abc{sep}x'))[0], 400)
        self.assertEqual(self.invocations(), [])

    def test_submission_report_is_stripped_before_writing_and_checking(self):
        self.start()
        status, body = self.request('POST', '/api/finding/submission', self.submission_payload(state='submitted', report=' R-1\x85'))
        self.assertEqual(status, 200, body)
        self.assertEqual(body['finding']['submission']['report'], 'R-1')
        self.assertIn('--submission-report=R-1', self.invocations()[-1])
        self.assertTrue(self.data()['capabilities']['finding_metadata'])

    def test_reclassify_annotation_failure_disables_writer(self):
        self.start()
        self.mode.write_text('fail-edit')
        status, body = self.request('POST', '/api/finding/reclassify', self.reclassify_payload())
        self.assertEqual((status, body['error']), (502, 'writer_failed'))
        self.assertFalse(self.data()['capabilities']['finding_metadata'])

    def test_reclassify_disabled_without_store_writer(self):
        os.environ['FAKE_STORE_HELP'] = 'usage: map_store.py [-h] {init,query} ...'
        try:
            self.start()
            cap = self.data()['capabilities']['ledger_actions']['reclassify']['map']
            self.assertFalse(cap['enabled'])
            self.assertIn('map_store.py write', cap['reason'])
            self.assertEqual(self.request('POST', '/api/finding/reclassify', self.reclassify_payload('map'))[0], 503)
        finally:
            os.environ.pop('FAKE_STORE_HELP', None)
        self.assertEqual(self.invocations(), [])

    def test_patch_finding_still_uses_shared_precheck(self):
        self.start()
        data = self.data()
        finding = data['programs'][0]['lanes'][0]['findings'][0]
        payload = {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': 'D01', 'patch': {'severity': 'HIGH'},
                   'expected_revision': '0' * 64, 'root_instance': data['root_instance']}
        self.assertEqual(self.request('PATCH', '/api/finding', payload)[1]['error'], 'finding_changed')
        self.assertEqual(self.request('PATCH', '/api/finding', {**payload, 'root_instance': '0' * 64})[1]['error'], 'root_changed')
        self.assertEqual(self.request('PATCH', '/api/finding', {**payload, 'fid': 'D09', 'expected_revision': finding['metadata_revision']})[1]['error'], 'finding_not_found')
        self.assertEqual(self.invocations(), [])


if __name__ == '__main__':
    unittest.main()
