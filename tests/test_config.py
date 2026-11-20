import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class ConfigCliTest(unittest.TestCase):
    def test_server_help_advertises_config_file(self):
        result = subprocess.run([sys.executable, str(ROOT / 'app.py'), '--help'], capture_output=True, text=True, check=True)
        self.assertIn('--config', result.stdout)

if __name__ == '__main__':
    unittest.main()
