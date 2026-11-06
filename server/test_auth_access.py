"""Single-owner HTTP boundary uses disposable files, accounts and SQLite only."""
import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest

try:
    from . import app
except ImportError:
    import app


class SingleOwnerAccessTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='band-single-owner-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.site, self.private, self.atlas = [self.root / name for name in ('site', 'private', 'atlas')]
        for directory in (self.site, self.private, self.atlas):
            directory.mkdir()
        (self.site / 'index.html').write_text('<h1>Authenticated app</h1>')
        (self.site / 'app.js').write_text('window.syntheticFixture=true;')
        (self.private / 'x.mp3').write_bytes(bytes(range(255)) * 4)
        (self.private / 'manifest.json').write_text('{"fixture":true}')
        self.server = app.create_server(port=0, db_path=self.root / 'data.sqlite3', public_origin='http://localhost:5188',
                                        single_user=True, secure_cookie=False, site_root=self.site,
                                        private_root=self.private, atlas_root=self.atlas, auth_limit=1000)
        with self.server.database.connect() as db:
            db.execute('INSERT INTO users VALUES (?,?,?,?)', ('owner-id', 'owner', app.password_hash('fixture password only'), int(time.time())))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, method, path, data=None, cookie=None, headers=None):
        request_headers = {'Origin': 'http://localhost:5188', 'Content-Type': 'application/json'}
        if cookie:
            request_headers['Cookie'] = cookie.split(';')[0]
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=10)
        try:
            connection.request(method, path, json.dumps(data).encode() if data is not None else None, request_headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def login(self):
        status, _, headers = self.request('POST', '/api/auth/login', {'username': 'owner', 'password': 'fixture password only'})
        self.assertEqual(status, 200)
        return headers['Set-Cookie']

    def test_anonymous_root_redirects_but_api_private_and_assets_refuse(self):
        status, _, headers = self.request('GET', '/')
        self.assertEqual(status, 302)
        self.assertEqual(headers['Location'], '/login')
        for path in ('/app.js', '/api/learning/v2/changes', '/private/x.mp3', '/private/manifest.json', '/api/auth/check'):
            self.assertEqual(self.request('GET', path)[0], 401, path)
        status, body, _ = self.request('GET', '/login')
        self.assertEqual(status, 200)
        self.assertIn('autocomplete="current-password"', body.decode())

    def test_owner_cookie_opens_root_api_and_private_file(self):
        cookie = self.login()
        for path in ('/', '/app.js', '/private/x.mp3', '/private/manifest.json', '/api/auth/check'):
            self.assertEqual(self.request('GET', path, cookie=cookie)[0], 200, path)
        self.assertIn('Path=/', cookie)
        self.assertNotIn('Path=/api', cookie)
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)

    def test_production_cookie_is_secure_and_registration_remains_closed(self):
        self.server.secure_cookie = True
        cookie = self.login()
        self.assertIn('; Secure', cookie)
        self.assertFalse(self.server.allow_register)
        self.assertEqual(self.server.max_accounts, 1)
        self.assertEqual(self.request('POST', '/api/auth/register', {'username': 'second', 'password': 'never create another owner', 'setupToken': 'any'})[0], 403)
        with self.server.database.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)

    def test_authenticated_vocabulary_app_has_no_four_skill_record_endpoints(self):
        cookie = self.login()
        for path in ('/api/learning/v2/changes?after=0', '/api/learning/v2/records'):
            self.assertEqual(self.request('GET', path, cookie=cookie)[0], 404, path)
        status, body, _ = self.request('GET', '/api/capabilities', cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'vocabularySnapshots': 2, 'learningRecords': 0})

    def test_private_range_and_head_require_login_then_return_exact_bytes(self):
        self.assertEqual(self.request('GET', '/private/x.mp3', headers={'Range': 'bytes=4-11'})[0], 401)
        cookie = self.login()
        status, body, headers = self.request('GET', '/private/x.mp3', cookie=cookie, headers={'Range': 'bytes=4-11'})
        self.assertEqual((status, body), (206, bytes(range(4, 12))))
        self.assertEqual(headers['Content-Range'], 'bytes 4-11/1020')
        self.assertEqual(self.request('HEAD', '/private/x.mp3', cookie=cookie)[1], b'')
        self.assertEqual(self.request('GET', '/private/x.mp3', cookie=cookie, headers={'Range': 'bytes=9000-'})[0], 416)

    def test_extra_shared_media_uses_only_allowed_prefixes_without_escaping_atlas_root(self):
        files = {'sfx/tap.mp3': b'synthetic effect', 'ielts/phrase/hello.mp3': b'synthetic phrase'}
        for relative, body in files.items():
            target = self.atlas / '_public' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        for relative in ('sfx', 'ielts/phrase'):
            link = self.site / relative
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(self.atlas / '_public' / relative, target_is_directory=True)
        cookie = self.login()
        for relative, body in files.items():
            self.assertEqual(self.request('GET', '/' + relative)[0], 401)
            status, actual, _ = self.request('GET', '/' + relative, cookie=cookie)
            self.assertEqual((status, actual), (200, body))
        secret = self.root / 'outside-shared.txt'
        secret.write_text('outside the shared directory')
        (self.atlas / '_public/sfx/outside').symlink_to(secret)
        for path in ('/sfx/%2e%2e/%2e%2e/%2e%2e/outside-shared.txt', '/sfx/outside'):
            status, body, _ = self.request('GET', path, cookie=cookie)
            self.assertEqual(status, 404)
            self.assertNotIn(secret.read_bytes(), body)

    def test_expired_or_revoked_session_cannot_reopen_private_files(self):
        cookie = self.login()
        token = cookie.split(';')[0].split('=', 1)[1]
        with self.server.database.connect() as db:
            db.execute('UPDATE sessions SET expires_at=? WHERE token_hash=?', (int(time.time()) - 1, hashlib.sha256(token.encode()).hexdigest()))
        for path in ('/api/auth/check', '/api/learning/v2/changes', '/private/x.mp3'):
            self.assertEqual(self.request('GET', path, cookie=cookie)[0], 401)
        self.assertEqual(self.request('GET', '/', cookie=cookie)[0], 302)

    def test_private_paths_cannot_escape_the_content_directory(self):
        (self.root / 'secret.txt').write_text('not content')
        (self.private / 'link').symlink_to(self.root / 'secret.txt')
        cookie = self.login()
        for path in ('/private/%2e%2e/secret.txt', '/private/link', '/private/%2f..%2fsecret.txt'):
            status, body, _ = self.request('GET', path, cookie=cookie)
            self.assertEqual(status, 404)
            self.assertNotIn(b'not content', body)

    def test_owner_cli_creates_only_one_account_and_keeps_password_out_of_output(self):
        database = self.root / 'bootstrap.sqlite3'
        password = self.root / 'initial-owner-password'
        password.write_text('temporary owner credential only')
        password.chmod(0o600)
        command = [sys.executable, app.__file__, '--db', str(database), '--create-owner', 'only-owner', '--password-file', str(password)]
        first = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertNotIn(password.read_text(), first.stdout + first.stderr)
        again = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(again.returncode, 0)
        with sqlite3.connect(database) as db:
            username, hashed = db.execute('SELECT username,password_hash FROM users').fetchone()
            self.assertEqual(username, 'only-owner')
            self.assertNotIn(password.read_text(), hashed)
        password.chmod(0o644)
        refused = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('mode 600', refused.stderr)

    def test_single_owner_mode_does_not_silently_accept_a_multi_account_database(self):
        with self.server.database.connect() as db:
            db.execute('INSERT INTO users VALUES (?,?,?,?)', ('second-id', 'second', app.password_hash('fixture second owner'), int(time.time())))
        with self.assertRaisesRegex(ValueError, 'multi-account'):
            app.create_server(port=0, db_path=self.root / 'data.sqlite3', public_origin='http://localhost:5188', single_user=True)


if __name__ == '__main__':
    unittest.main()
