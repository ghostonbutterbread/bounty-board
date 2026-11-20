import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class ConfigCliTest(unittest.TestCase):
    def test_writer_is_explicit_cli_opt_in(self):
        import app
        self.assertIsNone(app.parse_config([]).bbh)
        self.assertEqual(app.parse_config(['--bbh', '/opt/bbh']).bbh, Path('/opt/bbh'))

    def test_json_toml_and_cli_overrides(self):
        import tempfile
        import app
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            for suffix, content in [('json', '{"root":"data","port":9123}'), ('toml', 'root = "data"\nport = 9123\n')]:
                config = base / ('config.' + suffix)
                config.write_text(content)
                args = app.parse_config(['--config', str(config)])
                self.assertEqual(args.root, base / 'data')
                self.assertEqual(args.port, 9123)
                args = app.parse_config(['--config', str(config), '--root', '/override', '--port', '9001'])
                self.assertEqual(args.root, Path('/override'))
                self.assertEqual(args.port, 9001)

    def test_invalid_config_fails_with_clear_error(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'bad.json'
            config.write_text('{invalid')
            result = subprocess.run([sys.executable, str(ROOT / 'app.py'), '--config', str(config)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('config', result.stderr.lower())
            self.assertNotIn('Traceback', result.stderr)

    def test_server_help_advertises_config_file(self):
        result = subprocess.run([sys.executable, str(ROOT / 'app.py'), '--help'], capture_output=True, text=True, check=True)
        self.assertIn('--config', result.stdout)

if __name__ == '__main__':
    unittest.main()
