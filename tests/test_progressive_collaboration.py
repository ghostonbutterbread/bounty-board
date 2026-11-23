"""Progressive collaborative reads on isolated synthetic sources."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import app


class CollaborativeProgressiveTests(unittest.TestCase):
    def test_root_replacement_during_selected_reads_and_stale_write(self):
        for mode in ('shared', 'autosave'):
            for endpoint in ('lane', 'lane-reports', 'report'):
                with self.subTest(mode=mode, endpoint=endpoint), tempfile.TemporaryDirectory(prefix='bc-swap-') as tmp:
                    root = Path(tmp) / 'source'
                    lane = root / 'web_bounty/alpha/web'
                    (lane / 'reports').mkdir(parents=True)
                    (lane / 'reports/report.md').write_text('old\n')
                    server = app.make_server(root, 0, collaboration_dir=Path(tmp)/'private', report_autosave=mode == 'autosave')
                    thread = threading.Thread(target=server.serve_forever); thread.start()
                    base = f'http://127.0.0.1:{server.server_port}'
                    try:
                        with urlopen(base + '/api/data?phase=summary', timeout=5) as r:
                            summary = json.load(r)
                        query = {'root_instance': summary['root_instance'], 'family':'web_bounty', 'program':'alpha', 'lane':'web'}
                        identity = {'root_identity':summary['root_identity'], 'family':'web_bounty', 'program':'alpha', 'lane':'web', 'path':'report.md'}
                        with urlopen(base + '/api/collaboration?' + urlencode(identity), timeout=5) as r:
                            revision = json.load(r)['revision']
                        hook = {'lane':'coverage', 'lane-reports':'reports', 'report':'read_file'}[endpoint]
                        original = getattr(app, hook)
                        fired = []
                        def replace(*args, **kwargs):
                            value = original(*args, **kwargs)
                            if not fired:
                                fired.append(True)
                                root.rename(root.with_name('old'))
                                new_lane = root / 'web_bounty/alpha/web/reports'
                                new_lane.mkdir(parents=True)
                                (new_lane/'report.md').write_text('replacement\n')
                            return value
                        request_query = {**query, **({'path':'report.md'} if endpoint == 'report' else {})}
                        with patch.object(app, hook, replace):
                            with self.assertRaises(HTTPError) as err:
                                urlopen(base + '/api/' + endpoint + '?' + urlencode(request_query), timeout=5)
                        self.assertTrue(fired)
                        self.assertEqual(err.exception.code, 409); err.exception.close()
                        payload = json.dumps({'base':revision,'content':'stale write\n','request_id':'stale'}).encode()
                        request = Request(base + '/api/collaboration?' + urlencode(identity), payload,
                                          {'Content-Type':'application/json','X-Requested-With':'Bounty-Board','Origin':base}, method='POST')
                        with self.assertRaises(HTTPError) as err:
                            urlopen(request, timeout=5)
                        self.assertEqual(err.exception.code, 409); err.exception.close()
                        self.assertEqual((root/'web_bounty/alpha/web/reports/report.md').read_text(), 'replacement\n')
                    finally:
                        server.shutdown(); server.server_close(); thread.join(5)
                        self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()
