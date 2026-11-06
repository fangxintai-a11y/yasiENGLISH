import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('site_check', Path(__file__).with_name('check-site.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StandardHttpsTests(unittest.TestCase):
    def test_standard_port_is_denied_without_explicit_existing_site_opt_in(self):
        with patch.dict(os.environ, {'BAND_DEPLOY_ALLOW_STANDARD_HTTPS': '0'}):
            with self.assertRaises(ValueError):
                module.check_site('/not-accessed', 'example.com', 443, 'atlas/audio/test.mp3')

    def test_existing_https_probe_cleans_up_only_its_own_session(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'fixture.sqlite3'
            with sqlite3.connect(database) as db:
                db.executescript('CREATE TABLE users(id TEXT); INSERT INTO users VALUES("owner"); CREATE TABLE sessions(token_hash TEXT,user_id TEXT,expires_at INTEGER,session_id TEXT,created_at INTEGER,last_seen INTEGER,device TEXT); INSERT INTO sessions(token_hash,user_id) VALUES("existing-session","owner");')

            def curl(args, **_kwargs):
                self.assertIn('example.com:443:127.0.0.1', args)
                body = Path(args[args.index('-o') + 1])
                authenticated = '--cookie' in args
                if args[-1].endswith('/api/health') and authenticated:
                    status, content = 200, b'{"ok": true}'
                elif '-H' in args and authenticated:
                    status, content = 206, b'x' * 100
                elif args[-1].endswith('/'):
                    status, content = (200 if authenticated else 302), b'page'
                else:
                    status, content = 401, b'unauthorized'
                body.write_bytes(content)
                return str(status)

            with patch.dict(os.environ, {'BAND_DEPLOY_ALLOW_STANDARD_HTTPS': '1'}), patch.object(module.subprocess, 'check_output', curl):
                module.check_site(database, 'example.com', 443, 'atlas/audio/test.mp3')
            with sqlite3.connect(database) as db:
                self.assertEqual(db.execute('SELECT token_hash FROM sessions').fetchall(), [('existing-session',)])
