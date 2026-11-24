"""POST /api/finding/delete against the disposable fake BBH writer (synthetic data only).

Archive is the recoverable state; delete is the permanent step and only
applies to archived findings. The fake writer mirrors the BBH contract of
`manual_hunter.py --delete-finding FID` (see tests/test_ledger_actions.py).
"""
import json
import os
import unittest

import test_ledger_actions

HELP_WITH_DELETE = ('--edit-finding --patch-file --root --family --lane --from-file --set-submission '
                    '--submission-state --submission-result --submission-report --delete-finding --actor')
GENERATED = '<!-- generated: bounty-core-finding-report -->\n# Synthetic generated report\n'


class FindingDeleteTests(test_ledger_actions.LedgerActionTests):
    def setUp(self):
        super().setUp()
        os.environ['FAKE_HELP'] = HELP_WITH_DELETE
        data = json.loads(self.ledger.read_text())
        data['findings'][0]['status'] = 'archive'
        self.ledger.write_text(json.dumps(data))
        reports = self.ledger.parent.parent / 'reports'
        (reports / 'D01').mkdir()
        (reports / 'D01/REPORT.md').write_text(GENERATED)
        (reports / 'D01/notes.md').write_text('# Hand written notes\n')
        (reports / 'D02').mkdir()
        (reports / 'D02/REPORT.md').write_text(GENERATED)

    def payload(self, fid='D01', **extra):
        data = self.data()
        finding = next(f for f in data['programs'][0]['lanes'][0]['findings'] if f['fid'] == fid)
        return {'family': 'web_bounty', 'program': 'fictional', 'lane': 'web', 'fid': fid,
                'expected_revision': finding['metadata_revision'], 'root_instance': data['root_instance'], **extra}

    def fids(self):
        return [f['fid'] for f in json.loads(self.ledger.read_text())['findings']]

    def test_delete_capability_follows_writer_help(self):
        self.start()
        self.assertEqual(self.data()['capabilities']['ledger_actions']['delete'], {'enabled': True, 'requires_status': 'archive'})

    def test_delete_capability_off_without_option_or_writer(self):
        os.environ['FAKE_HELP'] = HELP_WITH_DELETE.replace(' --delete-finding', '')
        self.start()
        self.assertFalse(self.data()['capabilities']['ledger_actions']['delete']['enabled'])
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual((status, body['error']), (503, 'writer_unavailable'))
        self.assertEqual(self.invocations(), [])
        self.assertEqual(self.fids(), ['D01', 'D02'])

    def test_delete_disabled_without_writer(self):
        self.start(writer=False)
        self.assertFalse(self.data()['capabilities']['ledger_actions']['delete']['enabled'])
        self.assertEqual(self.request('POST', '/api/finding/delete', {'x': 1})[0], 503)

    def test_delete_archived_finding_runs_exact_argv_and_verifies(self):
        self.start()
        before = self.data()['programs'][0]['lanes'][0]['findings']
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual(status, 200, body)
        self.assertEqual(body['deleted'], 'D01')
        self.assertFalse(body['warnings'])
        self.assertEqual(self.fids(), ['D02'])
        self.assertEqual(self.invocations(), [['agents/manual_hunter.py', 'fictional', '--family', 'web_bounty', '--lane', 'web',
                                               '--root', str(self.root), '--delete-finding', 'D01', '--actor', 'bounty-board']])
        reports = self.ledger.parent.parent / 'reports'
        self.assertFalse((reports / 'D01/REPORT.md').exists())
        self.assertTrue((reports / 'D01/notes.md').exists(), 'hand written files are not BBH generated')
        self.assertTrue((reports / 'D02/REPORT.md').exists())
        # The untouched sibling's revision rolls forward.
        old = next(f for f in before if f['fid'] == 'D02')['metadata_revision']
        new = next(f for f in self.data()['programs'][0]['lanes'][0]['findings'] if f['fid'] == 'D02')['metadata_revision']
        self.assertEqual(body['revisions'], {'D02': [old, new]})
        self.assertTrue(self.data()['capabilities']['ledger_actions']['delete']['enabled'])

    def test_delete_refuses_non_archived_before_invoking_bbh(self):
        self.start()
        status, body = self.request('POST', '/api/finding/delete', self.payload('D02'))
        self.assertEqual((status, body['error']), (409, 'not_archived'))
        self.assertEqual(self.invocations(), [])
        self.assertEqual(self.fids(), ['D01', 'D02'])

    def test_delete_stale_revision_and_root_conflicts_do_not_invoke(self):
        self.start()
        payload = self.payload()
        self.assertEqual(self.request('POST', '/api/finding/delete', {**payload, 'expected_revision': 'a' * 64})[1]['error'], 'finding_changed')
        self.assertEqual(self.request('POST', '/api/finding/delete', {**payload, 'root_instance': 'b' * 64})[1]['error'], 'root_changed')
        self.assertEqual(self.request('POST', '/api/finding/delete', {**payload, 'fid': 'D99'})[1]['error'], 'finding_not_found')
        self.assertEqual(self.invocations(), [])

    def test_delete_validation_and_trust_checks(self):
        self.start()
        payload = self.payload()
        for bad in ({**payload, 'fid': '../D01'}, {**payload, 'lane': 'apk'}, {**payload, 'family': 'other'},
                    {**payload, 'program': '../x'}, {**payload, 'extra': 1}, {k: v for k, v in payload.items() if k != 'expected_revision'},
                    {**payload, 'expected_revision': 'nothex'}):
            self.assertEqual(self.request('POST', '/api/finding/delete', bad)[0], 400, bad)
        self.assertEqual(self.request('POST', '/api/finding/delete', payload, {'Origin': 'http://evil.invalid'})[0], 403)
        self.assertEqual(self.request('POST', '/api/finding/delete', payload, {'X-Requested-With': None})[0], 403)
        self.assertEqual(self.request('POST', '/api/finding/delete', payload, {'Content-Type': 'text/plain'})[0], 403)
        self.assertEqual(self.invocations(), [])
        self.assertEqual(self.fids(), ['D01', 'D02'])

    def test_delete_refused_by_bbh_keeps_writer_enabled(self):
        self.start()
        self.mode.write_text('delete-refuse')
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual((status, body['error']), (409, 'delete_refused'))
        self.assertEqual(body['reason'], "refusing to delete D01: status is 'archive', not 'archive'")
        self.assertEqual(self.fids(), ['D01', 'D02'])
        self.assertTrue(self.data()['capabilities']['finding_metadata'])

    def test_delete_with_warnings_is_verified_success(self):
        self.start()
        self.mode.write_text('delete-warn')
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual(status, 200, body)
        self.assertTrue(body['warnings'])
        self.assertEqual(body['warning_text'], ['could not delete reports/notes.md (kept)'])
        self.assertIn('D02', body['revisions'])
        self.assertEqual(self.fids(), ['D02'])

    def test_delete_highest_fid_refusal_reason_is_relayed(self):
        self.start()
        self.mode.write_text('delete-highest')
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual((status, body['error']), (409, 'delete_refused'))
        self.assertIn('it is the highest FID of its prefix', body['reason'])
        self.assertTrue(self.data()['capabilities']['ledger_actions']['delete']['enabled'])

    def test_delete_without_actor_option_omits_it(self):
        os.environ['FAKE_HELP'] = HELP_WITH_DELETE.replace(' --actor', '')
        self.start()
        self.assertEqual(self.request('POST', '/api/finding/delete', self.payload())[0], 200)
        self.assertEqual(self.invocations()[-1][-2:], ['--delete-finding', 'D01'])

    def test_delete_usage_error_disables_writer(self):
        self.start()
        self.mode.write_text('usage')
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual((status, body['error']), (502, 'writer_failed'))
        self.assertEqual(self.fids(), ['D01', 'D02'])
        self.assertFalse(self.data()['capabilities']['finding_metadata'])

    def test_delete_unverified_disables_writer(self):
        self.start()
        self.mode.write_text('delete-keep')
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual((status, body['error']), (502, 'verification_failed'))
        self.assertFalse(self.data()['capabilities']['finding_metadata'])

    def test_delete_writer_failure_disables_writer(self):
        self.start()
        self.mode.write_text('fail')
        status, body = self.request('POST', '/api/finding/delete', self.payload())
        self.assertEqual((status, body['error']), (502, 'writer_failed'))
        self.assertFalse(self.data()['capabilities']['ledger_actions']['delete']['enabled'])


# Reuse the harness only; the inherited ledger-action tests run in their own module.
for _name in dir(test_ledger_actions.LedgerActionTests):
    if _name.startswith('test_'):
        setattr(FindingDeleteTests, _name, None)


if __name__ == '__main__':
    unittest.main()
