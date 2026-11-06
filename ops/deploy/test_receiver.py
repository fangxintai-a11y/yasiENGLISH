"""Isolated deployment/rollback failures; all paths and commands stay in a temp dir."""
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

OPS = Path(__file__).resolve().parent
REVISION = "abcdef1234567890abcdef1234567890abcdef12"
RELEASE_ID = "20261102T000000Z-" + REVISION[:8]
OLD_ID = "20261029T000000Z-11111111"
OLDER_ID = "20261028T000000Z-00000000"
STABLE_WORD_ONLY_SHA256 = "9b9b7a38e67eb5c9bc26983e5daf544f86df87b413739b7b84fc36be34379611"

FAKE_API = '''from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os, pathlib, importlib.util
spec = importlib.util.spec_from_file_location('candidate_helper', pathlib.Path(__file__).with_name('learning.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
assert helper.RUNTIME_MARKER == 'installed helper'
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        protected = self.path.startswith('/api/learning/')
        body = b'{"ok":true}' if self.path.endswith('/health') else b'{"learningRecords":2}' if self.path == '/api/capabilities' else b'{"user":null}'
        self.send_response(401 if protected else 200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
def create_server(host, port, db_path, **kwargs):
    if os.environ.get('CASE') == 'api_candidate': raise RuntimeError('candidate rejected')
    return ThreadingHTTPServer((host, port), Handler)
'''

MOCK = r'''#!PYTHON
import hashlib, json, os, pathlib, shutil, signal, sys
name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
root = pathlib.Path(os.environ['TASK_ROOT'])
case = os.environ['CASE']
def fail(code): sys.exit(code)
if name == 'git': fail(99)
elif name == 'df': print('Available\n' + os.environ.get('MOCK_AVAILABLE_KIB', '100000000'))
elif name == 'flock': pass
elif name == 'readlink': print(pathlib.Path(args[-1]).resolve())
elif name == 'sha256sum':
    digest, path = sys.stdin.read().strip().split(None, 1)
    if hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() != digest: fail(2)
elif name == 'mv':
    files = [x for x in args if not x.startswith('-')]
    os.rename(files[0], files[1])
    marker = root / 'static-switched'
    if case == 'signal' and files[1].endswith('/current') and not marker.exists():
        marker.touch()
        os.kill(os.getppid(), signal.SIGTERM)
elif name == 'rm':
    for arg in args:
        if arg.startswith('-'): continue
        path = pathlib.Path(arg).absolute()
        assert path.is_relative_to(root), path
        if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
        else: path.unlink(missing_ok=True)
elif name == 'stat': print(pathlib.Path(args[-1]).stat().st_size)
elif name == 'find':
    directory = pathlib.Path(args[0])
    if directory.exists():
        for child in directory.iterdir():
            if child.is_dir() and not child.is_symlink(): print(child)
elif name == 'install':
    files, mode, directory, index = [], 0o755, False, 0
    while index < len(args):
        arg = args[index]
        if arg == '-d': directory = True
        elif arg in ('-m', '-o', '-g'):
            index += 1
            if arg == '-m': mode = int(args[index], 8)
        elif not arg.startswith('-'): files.append(arg)
        index += 1
    if directory:
        for filename in files: pathlib.Path(filename).mkdir(parents=True, exist_ok=True)
    else: shutil.copyfile(files[0], files[1]); os.chmod(files[1], mode)
elif name == 'npm':
    if os.environ.get('PREBUILT_MODE') == '1': fail(77)
    if args[0] == 'ci' and case == 'ci': fail(8)
    if args[0] == 'run':
        if case == 'build': fail(9)
        for filename in ['index.html','sw.js','manifest.webmanifest','atlas/index.json','atlas/img/abandon.webp','atlas/audio/word-uk/abandon.mp3','offline/pack.json']:
            target = pathlib.Path('dist') / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{}')
        if case == 'missing': pathlib.Path('dist/sw.js').unlink()
elif name == 'nginx':
    fail(98) # Shared proxy commands must never be called.
elif name == 'runuser':
    import pwd
    expected = os.environ['BAND_DEPLOY_API_USER']
    assert args[:3] == ['-u', expected, '--'], args
    assert pwd.getpwnam(expected).pw_uid == os.geteuid(), 'The mock runs as the real non-root test service user'
    with (root / 'database-writers.log').open('a') as log: log.write(json.dumps(args) + '\n')
    os.execvp(args[3], args[3:])
elif name == 'systemctl':
    with (root / 'controls.log').open('a') as log: log.write(' '.join(args) + '\n')
    if args[0] == 'reload' or 'nginx' in args: fail(98)
    if args[0] == 'cat':
        entry = pathlib.Path(os.environ['BAND_DEPLOY_ROOT']) / ('app.py' if case == 'unmanaged_service' else 'api-current/app.py')
        print('[Service]\nExecStart=/usr/bin/python3 ' + str(entry))
    if args[0] == 'show': print(os.environ.get('MOCK_SERVICE_USER', ''))
    if args[0] == 'is-active': fail(0 if os.environ['API_PREVIOUS'] == '1' else 3)
    if args[:2] == ['restart', os.environ['BAND_DEPLOY_API_SERVICE']]:
        marker = root / 'restarted'
        first = not marker.exists()
        marker.touch()
        if case == 'api_restart' and first: fail(11)
        if case == 'api_signal' and first: os.kill(os.getppid(), signal.SIGTERM)
        if os.environ.get('R6_REAL_RUNTIME') == '1':
            import importlib.util
            entry = pathlib.Path(os.environ['BAND_DEPLOY_ROOT']) / 'api-current/app.py'
            spec = importlib.util.spec_from_file_location('real_systemd_fixture', entry)
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            server = module.create_server('127.0.0.1', 0, os.environ['BAND_DEPLOY_DB'], public_origin='http://localhost:5188', secure_cookie=False, single_user=True)
            server.server_close()
elif name == 'curl':
    with (root / 'curl.log').open('a') as log: log.write(' '.join(args) + '\n')
    url = next(arg for arg in args if arg.startswith('http'))
    if case == 'health' and url.endswith('/'): fail(12)
    if case == 'api_health' and url.startswith('http://127.0.0.1:' + os.environ['BAND_DEPLOY_API_PORT']): fail(13)
    if case == 'api_proxy' and url.startswith('https://') and url.endswith('/api/health'): fail(14)
    output = args[args.index('-o') + 1] if '-o' in args else '/dev/null'
    ranged = 'Range: bytes=0-99' in args
    if os.environ.get('R6_REAL_RUNTIME') == '1' and url.startswith('https://'):
        import sqlite3, time
        authenticated = False
        if '--cookie' in args:
            fields = pathlib.Path(args[args.index('--cookie') + 1]).read_text().splitlines()[-1].split('\t')
            token = fields[-1]
            with sqlite3.connect(os.environ['BAND_DEPLOY_DB']) as db:
                authenticated = db.execute('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?', (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone() is not None
            assert authenticated, 'Site check must use a live real-owner session'
        status = 206 if authenticated and ranged else 200 if authenticated else 302 if url.endswith('/') else 401
        if ranged and os.environ.get('SITE_RANGE_FAIL') == '1': status = 200
        if output != '/dev/null': pathlib.Path(output).write_bytes(b'0' * 100 if ranged else b'{"ok":true}')
        if '-w' in args: print(status, end='')
        fail(0)
    if output != '/dev/null': pathlib.Path(output).write_bytes(b'0' * 100 if ranged else b'{"ok":true}')
    if ranged: print('200' if case == 'range' else '206', end='')
'''


class Fixture:
    def __init__(self, root, case, has_api=False, previous_api=False):
        self.root, self.case, self.has_api, self.previous_api = Path(root).resolve(), case, has_api, previous_api
        self.project = self.root / "opt/bandgalaxy"
        self.web = self.root / "var/www/bandgalaxy"
        self.binary = self.root / "bin"
        self.state = self.root / "var/lib/band-galaxy"
        for path in (self.project / "incoming", self.project / "releases", self.project / "api-releases", self.web, self.binary, self.root / "run/lock", self.root / "etc", self.state):
            path.mkdir(parents=True, exist_ok=True)
        self.previous, self.obsolete = self.project / "releases" / OLD_ID, self.project / "releases" / OLDER_ID
        for path in (self.previous, self.obsolete):
            path.mkdir()
            (path / "index.html").write_text("previous stable version")
        self.current = self.web / "current"
        self.current.symlink_to(self.previous)
        self.api_current = self.project / "api-current"
        self.old_api = self.project / "api-releases" / OLD_ID
        if previous_api:
            self.old_api.mkdir()
            (self.old_api / "app.py").write_text("previous API")
            self.api_current.symlink_to(self.old_api)
        with sqlite3.connect(self.state / "progress.sqlite3") as db:
            db.execute("CREATE TABLE preserve_me (value TEXT)")
            db.execute("INSERT INTO preserve_me VALUES ('actual progress')")
        (self.root / "etc/band-galaxy.env").write_text("test configuration, no real secret\n")
        helper = self.root / "usr/local/lib/band-galaxy/backup.py"
        helper.parent.mkdir(parents=True)
        # The mocked service cannot execute real legacy code. Use exact reviewed
        # fixture hashes in its private helper; production retains only f3384e.
        fixture_hashes = ', '.join(json.dumps(hashlib.sha256(code.encode()).hexdigest()) for code in ('previous API', 'target API'))
        helper.write_text((OPS / "backup-sync.py").read_text().replace("/var/lib/band-galaxy", str(self.state)).replace(json.dumps(STABLE_WORD_ONLY_SHA256), fixture_hashes))
        for command in ('git', 'df', 'flock', 'readlink', 'sha256sum', 'mv', 'rm', 'stat', 'find', 'install', 'npm', 'nginx', 'systemctl', 'curl', 'runuser'):
            path = self.binary / command
            path.write_text(MOCK.replace('#!PYTHON', '#!' + sys.executable))
            path.chmod(0o755)
        (self.binary / 'python3').symlink_to(sys.executable)
        self.env = os.environ | {'CASE': case, 'TASK_ROOT': str(self.root), 'API_PREVIOUS': '1' if previous_api else '0',
            'BAND_DEPLOY_ROOT': str(self.project), 'BAND_DEPLOY_WEB_ROOT': str(self.web),
            'BAND_DEPLOY_HOST': 'ibaz.cn', 'BAND_DEPLOY_HTTPS_PORT': '8443',
            'BAND_DEPLOY_API_PORT': '5189', 'BAND_DEPLOY_API_SERVICE': 'band-galaxy.service',
            'BAND_DEPLOY_MIN_FREE_MB': '1024', 'BAND_DEPLOY_LOCK': str(self.root / 'run/lock/band.lock'),
            'BAND_DEPLOY_ENV_FILE': str(self.root / 'etc/band-galaxy.env'),
            'BAND_DEPLOY_DB': str(self.state / 'progress.sqlite3'),
            'BAND_DEPLOY_BACKUP_DIR': str(self.state / 'backups'),
            'BAND_DEPLOY_BACKUP_SCRIPT': str(helper)}

    def rewritten(self, name):
        code = (OPS / name).read_text()
        code = code.replace('[[ $EUID -eq 0 ]]', 'true')
        code = code.replace('export PATH=', 'export PATH=' + str(self.binary) + ':')
        target = self.root / name
        target.write_text(code)
        return target

    def assert_database_unchanged(self):
        with sqlite3.connect(self.state / 'progress.sqlite3') as db:
            assert db.execute('SELECT value FROM preserve_me').fetchall() == [('actual progress',)]
        controls = (self.root / 'controls.log').read_text() if (self.root / 'controls.log').exists() else ''
        assert 'reload' not in controls and 'nginx' not in controls, controls

    def deploy(self):
        archive = self.project / 'incoming' / (RELEASE_ID + '.tar.gz')
        files = {'package.json': '{}', 'package-lock.json': '{}'}
        if self.has_api:
            files['server/app.py'] = FAKE_API
            files['server/learning.py'] = "RUNTIME_MARKER = 'installed helper'\n"
            files['server/runtime-files.json'] = json.dumps(['app.py'] if self.case == 'api_missing_module' else ['app.py', 'learning.py'])
            files['server/test_app.py'] = 'import unittest\nfrom app import create_server\nclass CandidateTest(unittest.TestCase):\n    def test_fixture_exports_factory(self): self.assertTrue(callable(create_server))\n'
        if self.case == 'escape': files['../escape.txt'] = '{}'
        with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': ('0' * 40 if self.case == 'commit' else REVISION) + '\n'}) as tar:
            for name, content in files.items():
                item = tarfile.TarInfo(name)
                body = content.encode()
                item.size = len(body)
                tar.addfile(item, io.BytesIO(body))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest() if self.case != 'checksum' else '0' * 64
        result = subprocess.run(['bash', str(self.rewritten('yasi-deploy')), str(archive), digest, REVISION, RELEASE_ID], env=self.env, capture_output=True, text=True, timeout=60)
        success = self.case == 'success'
        assert (result.returncode == 0) == success, (self.case, result.stdout, result.stderr)
        expected_failure = {'checksum': 2, 'commit': 1, 'escape': 1, 'ci': 8, 'build': 9, 'missing': 1, 'health': 12, 'range': 1, 'signal': 143, 'api_candidate': 1, 'api_missing_module': 1, 'api_restart': 11, 'api_health': 13, 'api_proxy': 14, 'api_signal': 143}
        if not success:
            assert result.returncode == expected_failure[self.case], ('wrong failure phase', self.case, result.stdout, result.stderr)
        assert self.current.resolve() == (self.project / 'releases' / RELEASE_ID if success else self.previous), (self.case, result.stdout, result.stderr)
        assert (self.previous / 'index.html').read_text() == 'previous stable version'
        if self.has_api:
            if success:
                assert self.api_current.resolve() == self.project / 'api-releases' / RELEASE_ID
                assert list((self.state / 'backups').glob('predeploy-*.sqlite3'))
                assert not (self.current / 'server').exists(), 'API code leaked into static root'
                data = json.loads((self.project / 'deployments' / (RELEASE_ID + '.json')).read_text())
                assert data['api_release'] == str(self.api_current.resolve())
                assert (self.api_current / 'learning.py').read_text() == "RUNTIME_MARKER = 'installed helper'\n"
            elif self.previous_api:
                assert self.api_current.resolve() == self.old_api
            else:
                assert not self.api_current.is_symlink(), (self.case, result.stdout, result.stderr)
        if success:
            assert not self.obsolete.exists()
            assert not archive.exists()
            assert not (self.project / 'builds' / RELEASE_ID).exists()
        assert not (self.project / 'builds' / RELEASE_ID / 'escape.txt').exists()
        self.assert_database_unchanged()

    def rollback(self, target_has_api):
        if target_has_api:
            target_api = self.project / 'api-releases' / OLDER_ID
            target_api.mkdir()
            (target_api / 'app.py').write_text('target API')
        result = subprocess.run(['bash', str(self.rewritten('yasi-rollback')), str(self.obsolete)], env=self.env, capture_output=True, text=True, timeout=30)
        success = self.case == 'success'
        assert (result.returncode == 0) == success, (self.case, result.stdout, result.stderr)
        assert self.current.resolve() == (self.obsolete if success else self.previous)
        if success and target_has_api:
            assert self.api_current.resolve() == self.project / 'api-releases' / OLDER_ID
        elif success:
            assert not self.api_current.is_symlink()
            assert 'stop band-galaxy.service' in (self.root / 'controls.log').read_text()
        else:
            assert self.api_current.resolve() == self.old_api
        self.assert_database_unchanged()


class PrebuiltTests(unittest.TestCase):
    def run_prebuilt(self, missing_helper=False, configuration=None, missing_api=False):
        scratch = tempfile.TemporaryDirectory(prefix='band-prebuilt-check-')
        self.addCleanup(scratch.cleanup)
        fixture = Fixture(scratch.name, 'success', has_api=True, previous_api=True)
        fixture.env.update({
            'PREBUILT_MODE': '1', 'MOCK_AVAILABLE_KIB': '1048576',
            'BAND_DEPLOY_ROOT': str(fixture.project), 'BAND_DEPLOY_WEB_ROOT': str(fixture.web),
            'BAND_DEPLOY_HOST': 'ibaz.cn', 'BAND_DEPLOY_HTTPS_PORT': '8443',
            'BAND_DEPLOY_API_PORT': '5189', 'BAND_DEPLOY_API_SERVICE': 'band-galaxy.service',
            'BAND_DEPLOY_MIN_FREE_MB': '1024', 'BAND_DEPLOY_LOCK': str(fixture.root / 'run/lock/band.lock'),
            'BAND_DEPLOY_ENV_FILE': str(fixture.root / 'etc/band-galaxy.env'),
            'BAND_DEPLOY_DB': str(fixture.state / 'progress.sqlite3'),
            'BAND_DEPLOY_BACKUP_DIR': str(fixture.state / 'backups'),
            'BAND_DEPLOY_BACKUP_SCRIPT': str(fixture.root / 'usr/local/lib/band-galaxy/backup.py'),
        })
        fixture.env.update(configuration or {})
        files = {name: '{}' for name in ['dist/index.html', 'dist/sw.js', 'dist/manifest.webmanifest',
                 'dist/atlas/index.json', 'dist/offline/pack.json', 'dist/atlas/audio/word-uk/example.mp3',
                 'dist/atlas/img/example.webp']}
        files.update({'server/app.py': FAKE_API, 'server/runtime-files.json': json.dumps(['app.py', 'learning.py'])})
        if not missing_helper:
            files['server/learning.py'] = "RUNTIME_MARKER = 'installed helper'\n"
        if missing_api:
            del files['server/app.py']
        archive = fixture.project / 'incoming' / (RELEASE_ID + '.tar.gz')
        with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': REVISION + '\n'}) as tar:
            for name, content in files.items():
                item = tarfile.TarInfo(name); body = content.encode(); item.size = len(body)
                tar.addfile(item, io.BytesIO(body))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        result = subprocess.run(['bash', str(fixture.rewritten('yasi-deploy')), '--prebuilt', str(archive), digest, REVISION, RELEASE_ID],
                                env=fixture.env, capture_output=True, text=True, timeout=60)
        return fixture, result

    def test_prebuilt_mode_runs_without_npm_and_with_1gb_free(self):
        fixture, result = self.run_prebuilt()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(fixture.current.resolve(), fixture.project / 'releases' / RELEASE_ID)
        self.assertTrue((fixture.api_current / 'learning.py').is_file())
        fixture.assert_database_unchanged()

    def test_custom_host_port_8443_used_for_health_checks(self):
        fixture, result = self.run_prebuilt()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = (fixture.root / 'curl.log').read_text()
        self.assertIn('--resolve ibaz.cn:8443:127.0.0.1', calls)
        self.assertIn('https://ibaz.cn:8443/', calls)
        self.assertNotIn(':443:', calls)
        self.assertNotIn('reload nginx', (fixture.root / 'controls.log').read_text())

    def test_existing_https_443_requires_explicit_opt_in(self):
        fixture, rejected = self.run_prebuilt(configuration={'BAND_DEPLOY_HTTPS_PORT': '443'})
        self.assertEqual(rejected.returncode, 2, rejected.stdout + rejected.stderr)
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        fixture.assert_database_unchanged()
        allowed, result = self.run_prebuilt(configuration={'BAND_DEPLOY_HTTPS_PORT': '443', 'BAND_DEPLOY_ALLOW_STANDARD_HTTPS': '1'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('--resolve ibaz.cn:443:127.0.0.1', (allowed.root / 'curl.log').read_text())
        self.assertNotIn('reload nginx', (allowed.root / 'controls.log').read_text())
        allowed.assert_database_unchanged()

    def test_missing_learning_py_aborts_and_rolls_back(self):
        fixture, result = self.run_prebuilt(missing_helper=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('Missing API runtime file: learning.py', result.stderr)
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        self.assertEqual(fixture.api_current.resolve(), fixture.old_api)
        fixture.assert_database_unchanged()

    def test_prebuilt_package_requires_the_api_entry_module(self):
        fixture, result = self.run_prebuilt(missing_api=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('Prebuilt artifact requires server/app.py', result.stderr)
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        self.assertEqual(fixture.api_current.resolve(), fixture.old_api)
        fixture.assert_database_unchanged()

    def test_shared_443_port_is_rejected_before_any_service_action(self):
        fixture, result = self.run_prebuilt(configuration={'BAND_DEPLOY_HTTPS_PORT': '443'})
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertFalse((fixture.root / 'controls.log').exists())
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        fixture.assert_database_unchanged()

    def test_existing_flat_api_service_is_not_automatically_reconfigured(self):
        fixture, result = self.run_prebuilt(configuration={'CASE': 'unmanaged_service'})
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('must already run api-current/app.py', result.stderr)
        self.assertNotIn('restart', (fixture.root / 'controls.log').read_text())
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        fixture.assert_database_unchanged()


class CompatibilityTests(unittest.TestCase):
    def fixture(self, case='success'):
        scratch = tempfile.TemporaryDirectory(prefix='band-rollback-compat-')
        self.addCleanup(scratch.cleanup)
        return Fixture(scratch.name, case, has_api=True, previous_api=True)

    def target(self, fixture, schema=None):
        target = fixture.project / 'api-releases' / OLDER_ID
        target.mkdir()
        (target / 'app.py').write_text(FAKE_API)
        (target / 'learning.py').write_text("RUNTIME_MARKER = 'installed helper'\n")
        if schema is not None:
            files = ['app.py', 'learning.py']
            metadata = {'learningProtocolVersion': 2, 'learningSchemaVersion': schema,
                        'moduleSha256': {name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in files}}
            (target / 'runtime-meta.json').write_text(json.dumps(metadata))
        return target

    def set_schema(self, fixture, version=2):
        with sqlite3.connect(fixture.state / 'progress.sqlite3') as db:
            db.execute('CREATE TABLE learning_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
            db.execute('INSERT INTO learning_schema_migrations VALUES(?,0)', (version,))

    def rollback(self, fixture):
        return subprocess.run(['bash', str(fixture.rewritten('yasi-rollback')), str(fixture.obsolete)],
                              env=fixture.env, capture_output=True, text=True, timeout=30)

    def test_current_learning_entry_without_helper_is_not_a_word_only_api(self):
        fixture = self.fixture(); self.set_schema(fixture)
        target = fixture.project / 'api-releases' / OLDER_ID
        target.mkdir()
        (target / 'app.py').write_bytes((OPS.parent.parent / 'server/app.py').read_bytes())
        result = subprocess.run([sys.executable, str(OPS / 'backup-sync.py'), '--db', str(fixture.state / 'progress.sqlite3'), '--verify-api', str(target)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        fixture.assert_database_unchanged()

    def test_unrecognized_word_only_entry_is_not_implicitly_trusted(self):
        fixture = self.fixture(); self.set_schema(fixture)
        target = fixture.project / 'api-releases' / OLDER_ID
        target.mkdir()
        (target / 'app.py').write_text('print("An unreviewed standalone API")\n')
        result = self.rollback(fixture)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn('restart', (fixture.root / 'controls.log').read_text())
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        fixture.assert_database_unchanged()

    def test_verified_word_only_api_can_rollback_without_restoring_the_database(self):
        fixture = self.fixture(); self.set_schema(fixture)
        target = fixture.project / 'api-releases' / OLDER_ID
        target.mkdir()
        (target / 'app.py').write_text('target API')
        result = self.rollback(fixture)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(fixture.api_current.resolve(), target)
        self.assertEqual(fixture.current.resolve(), fixture.obsolete)
        fixture.assert_database_unchanged()

    def test_unmarked_old_learning_api_cannot_resume_writes_after_migration(self):
        fixture = self.fixture(); self.set_schema(fixture); self.target(fixture)
        result = self.rollback(fixture)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        self.assertEqual(fixture.api_current.resolve(), fixture.old_api)
        fixture.assert_database_unchanged()

    def test_matching_schema_and_module_metadata_allow_verified_v2_rollback(self):
        fixture = self.fixture(); self.set_schema(fixture); target = self.target(fixture, schema=2)
        result = self.rollback(fixture)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(fixture.api_current.resolve(), target)
        self.assertEqual(fixture.current.resolve(), fixture.obsolete)
        fixture.assert_database_unchanged()

    def test_mismatched_schema_refuses_learning_api_rollback(self):
        fixture = self.fixture(); self.set_schema(fixture); self.target(fixture, schema=1)
        result = self.rollback(fixture)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(fixture.api_current.resolve(), fixture.old_api)
        self.assertNotIn('restart', (fixture.root / 'controls.log').read_text())
        fixture.assert_database_unchanged()

    def test_automatic_restore_stops_an_unverified_previous_learning_api(self):
        fixture = self.fixture(case='api_health')
        (fixture.old_api / 'learning.py').write_text('unverified historical learning code')
        fixture.deploy()
        controls = (fixture.root / 'controls.log').read_text()
        self.assertIn('stop band-galaxy.service', controls)
        self.assertEqual(fixture.api_current.resolve(), fixture.old_api)
        fixture.assert_database_unchanged()


class R6ReleaseTests(unittest.TestCase):
    def shared_fixture(self, first=False, fail=False, unsafe=False, missing=False):
        scratch = tempfile.TemporaryDirectory(prefix='band-r6-shared-release-')
        self.addCleanup(scratch.cleanup)
        fixture = Fixture(scratch.name, 'success', has_api=True, previous_api=False)
        fixture.env['PREBUILT_MODE'] = '1'
        atlas = fixture.root / 'shared-atlas'
        for name, content in {'index.json': '{}', 'audio/word-uk/example.mp3': '0' * 1000,
                              'img/example.webp': 'original image', '_public/sfx/correct.mp3': 'original effect'}.items():
            path = atlas / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content)
        fixture.env['BAND_DEPLOY_ATLAS_ROOT'] = str(atlas)
        if first:
            fixture.current.unlink()
            fixture.env['BAND_DEPLOY_FIRST_INSTALL'] = '1'
        if fail:
            fixture.env['CASE'] = 'health'
        paths = [{'path': '../escape' if unsafe else 'sfx', 'sharedPath': '_public/sfx'}]
        files = {name: '{}' for name in ['dist/index.html', 'dist/sw.js', 'dist/manifest.webmanifest', 'dist/offline/pack.json']}
        files.update({'release-manifest.json': json.dumps({'formatVersion': 1, 'sharedAtlas': True, 'commit': REVISION, 'sharedPaths': paths}),
                      'server/app.py': FAKE_API, 'server/learning.py': "RUNTIME_MARKER = 'installed helper'\n",
                      'server/runtime-files.json': json.dumps(['app.py', 'learning.py'])})
        if missing:
            (atlas / '_public/sfx/correct.mp3').unlink(); (atlas / '_public/sfx').rmdir()
        archive = fixture.project / 'incoming' / (RELEASE_ID + '.tar.gz')
        with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': REVISION}) as tar:
            for name, content in files.items():
                member = tarfile.TarInfo(name); body = content.encode(); member.size = len(body); tar.addfile(member, io.BytesIO(body))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        result = subprocess.run(['bash', str(fixture.rewritten('yasi-deploy')), '--prebuilt', str(archive), digest, REVISION, RELEASE_ID],
                                env=fixture.env, capture_output=True, text=True, timeout=60)
        return fixture, atlas, result

    def test_empty_machine_first_prebuilt_install_links_shared_media_without_copying(self):
        fixture, atlas, result = self.shared_fixture(first=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        release = fixture.project / 'releases' / RELEASE_ID
        self.assertEqual(fixture.current.resolve(), release)
        self.assertTrue((release / 'atlas').is_symlink())
        self.assertEqual((release / 'atlas').resolve(), atlas)
        self.assertTrue((release / 'sfx').is_symlink())
        self.assertEqual((release / 'sfx/correct.mp3').read_text(), 'original effect')
        self.assertEqual(len(list(fixture.project.joinpath('releases').iterdir())), 1)
        fixture.assert_database_unchanged()

    def test_first_install_failure_removes_new_links_but_retains_database_and_shared_media(self):
        fixture, atlas, result = self.shared_fixture(first=True, fail=True)
        self.assertEqual(result.returncode, 12, result.stdout + result.stderr)
        self.assertFalse(fixture.current.exists()); self.assertFalse(fixture.current.is_symlink())
        self.assertFalse(fixture.api_current.is_symlink())
        self.assertEqual((atlas / 'audio/word-uk/example.mp3').read_text(), '0' * 1000)
        fixture.assert_database_unchanged()

    def test_shared_path_traversal_and_missing_media_are_rejected(self):
        for options in ({'unsafe': True}, {'missing': True}):
            with self.subTest(options=options):
                fixture, atlas, result = self.shared_fixture(**options)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(fixture.current.resolve(), fixture.previous)
                self.assertEqual((atlas / 'img/example.webp').read_text(), 'original image')
                fixture.assert_database_unchanged()

    def test_backup_keeps_latest_fourteen_complete_copies_without_deleting_unrelated_files(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('r6_backup_helper', OPS / 'backup-sync.py')
        helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory(prefix='band-r6-backup-') as scratch:
            database, backup_dir = Path(scratch) / 'source.sqlite3', Path(scratch) / 'backups'
            with sqlite3.connect(database) as db: db.execute('CREATE TABLE preserved(value)'); db.execute('INSERT INTO preserved VALUES(42)')
            backup_dir.mkdir(); unrelated = backup_dir / 'user-copy.sqlite3'; unrelated.write_text('do not delete')
            for index in range(17):
                helper.backup_database(database, backup_dir, 'daily' if index % 2 else 'predeploy', now=1700000000 + index)
            owned = [p for p in backup_dir.glob('*.sqlite3') if p.name != unrelated.name]
            self.assertEqual(len(owned), 14)
            self.assertEqual(unrelated.read_text(), 'do not delete')
            for copy in owned:
                with sqlite3.connect(copy) as db:
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                    self.assertEqual(db.execute('SELECT value FROM preserved').fetchone()[0], 42)

    def test_backup_retention_orders_mixed_prefixes_by_timestamp_not_prefix(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('r6_backup_timestamp_helper', OPS / 'backup-sync.py')
        helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory(prefix='band-r6-mixed-backup-') as scratch:
            database, backup_dir = Path(scratch) / 'source.sqlite3', Path(scratch) / 'backups'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE preserved(value)')
                db.execute('INSERT INTO preserved VALUES(42)')
            backup_dir.mkdir()
            unrelated = backup_dir / 'user-copy.sqlite3'
            unrelated.write_text('keep this unrelated backup')
            # Old predeploy copies must not outrank newer daily copies; the final
            # newer predeploy copies must likewise remain among the newest 14.
            prefixes = ['predeploy'] * 7 + ['daily'] * 13 + ['predeploy'] * 5
            created = [helper.backup_database(database, backup_dir, prefix, now=1700000000 + index)
                       for index, prefix in enumerate(prefixes)]
            actual = {copy.name for copy in backup_dir.glob('*.sqlite3') if copy != unrelated}
            self.assertEqual(actual, {copy.name for copy in created[-14:]})
            self.assertEqual(unrelated.read_text(), 'keep this unrelated backup')
            self.assertFalse(any(copy.exists() for copy in created[:-14]))


class R6SingleOwnerReceiverTests(unittest.TestCase):
    """Real runtime/owner/SQLite; service/curl/runuser edges are simulated locally.

    The test service identity is the actual non-root process user. The runuser
    mock checks its requested account, then execs real Python code under that UID.
    This proves command identity and real file readability without claiming a
    root-to-another-UID kernel transition was performed on the developer Mac.
    """
    def fixture(self):
        import pwd
        if os.geteuid() == 0:
            self.skipTest('The local identity simulation requires a real non-root test service account')
        scratch = tempfile.TemporaryDirectory(prefix='band-r6-real-owner-')
        self.addCleanup(scratch.cleanup)
        fixture = Fixture(scratch.name, 'success', has_api=True, previous_api=False)
        fixture.current.unlink()
        for path in (fixture.previous, fixture.obsolete):
            import shutil
            shutil.rmtree(path)
        database = Path(fixture.env['BAND_DEPLOY_DB'])
        database.unlink()
        account = pwd.getpwuid(os.geteuid()).pw_name
        fixture.env.update({'PREBUILT_MODE': '1', 'BAND_DEPLOY_FIRST_INSTALL': '1',
                            'BAND_DEPLOY_SINGLE_USER': '1', 'BAND_DEPLOY_API_USER': account,
                            'MOCK_SERVICE_USER': account, 'R6_REAL_RUNTIME': '1'})
        password = fixture.root / 'initial-password'
        password.write_text('only a disposable fixture password')
        password.chmod(0o600)
        fixture.env.update({'BAND_DEPLOY_OWNER_USERNAME': 'only-owner', 'BAND_DEPLOY_OWNER_PASSWORD_FILE': str(password)})
        tools = Path(fixture.env['BAND_DEPLOY_BACKUP_SCRIPT']).parent
        for name in ('check-site.py',):
            (tools / name).write_bytes((OPS / name).read_bytes())
        return fixture, password, account

    def deploy_real(self, fixture, release_id=RELEASE_ID):
        files = {name: '{}' for name in ['dist/index.html', 'dist/sw.js', 'dist/manifest.webmanifest',
                 'dist/atlas/index.json', 'dist/offline/pack.json', 'dist/atlas/audio/word-uk/example.mp3', 'dist/atlas/img/example.webp']}
        runtime = OPS.parent.parent / 'server'
        names = json.loads((runtime / 'runtime-files.json').read_text())
        files['server/runtime-files.json'] = json.dumps(names)
        for name in names: files['server/' + name] = (runtime / name).read_text()
        archive = fixture.project / 'incoming' / (release_id + '.tar.gz')
        with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': REVISION}) as tar:
            for name, content in files.items():
                body = content.encode(); member = tarfile.TarInfo(name); member.size = len(body); tar.addfile(member, io.BytesIO(body))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        return subprocess.run(['bash', str(fixture.rewritten('yasi-deploy')), '--prebuilt', str(archive), digest, REVISION, release_id],
                              env=fixture.env, capture_output=True, text=True, timeout=90)

    def assert_owner_files_and_no_probe_session(self, fixture, account):
        import pwd
        uid = pwd.getpwnam(account).pw_uid
        database = Path(fixture.env['BAND_DEPLOY_DB'])
        self.assertEqual(database.stat().st_uid, uid)
        self.assertEqual(database.stat().st_mode & 0o777, 0o600)
        for file in [database, *database.parent.glob(database.name + '-*')]:
            self.assertEqual(file.stat().st_uid, uid)
        with sqlite3.connect(database) as db:
            self.assertEqual(db.execute('SELECT username FROM users').fetchall(), [('only-owner',)])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
        self.assertTrue((fixture.root / 'database-writers.log').is_file(), 'Single-user DB commands must run as the verified API service identity')
        writers = [json.loads(line) for line in (fixture.root / 'database-writers.log').read_text().splitlines()]
        self.assertTrue(writers)
        self.assertTrue(all(call[:3] == ['-u', account, '--'] for call in writers))
        self.assertTrue(any('--create-owner' in call for call in writers))
        self.assertTrue(any(any(part.endswith('check-site.py') for part in call) for call in writers))
        self.assertTrue(any('--prefix' in call for call in writers))
        backups = list(Path(fixture.env['BAND_DEPLOY_BACKUP_DIR']).glob('predeploy-*.sqlite3'))
        for file in backups:
            self.assertEqual(file.stat().st_uid, uid)
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with sqlite3.connect(file) as db: self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_real_single_owner_first_install_and_two_release_rollback_preserve_private_files(self):
        fixture, password, account = self.fixture()
        first = self.deploy_real(fixture)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertNotIn(password.read_text(), first.stdout + first.stderr)
        self.assert_owner_files_and_no_probe_session(fixture, account)
        database = Path(fixture.env['BAND_DEPLOY_DB'])
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE r6_preserved(value)'); db.execute('INSERT INTO r6_preserved VALUES(42)')
        later_id = '20261106T000000Z-' + REVISION[:8]
        fixture.env['API_PREVIOUS'] = '1'
        second = self.deploy_real(fixture, later_id)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(len(list(fixture.project.joinpath('releases').iterdir())), 2)
        self.assertEqual(len(list(fixture.project.joinpath('api-releases').iterdir())), 2)
        backups = Path(fixture.env['BAND_DEPLOY_BACKUP_DIR'])
        before = len(list(backups.glob('predeploy-*.sqlite3')))
        result = subprocess.run(['bash', str(fixture.rewritten('yasi-rollback')), str(fixture.project / 'releases' / RELEASE_ID)],
                                env=fixture.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(list(backups.glob('predeploy-*.sqlite3'))), before + 1)
        self.assertEqual(fixture.current.resolve(), fixture.project / 'releases' / RELEASE_ID)
        with sqlite3.connect(database) as db: self.assertEqual(db.execute('SELECT value FROM r6_preserved').fetchone()[0], 42)
        self.assert_owner_files_and_no_probe_session(fixture, account)

    def test_real_single_owner_site_failure_revokes_probe_and_retains_database(self):
        fixture, _, account = self.fixture()
        fixture.env['SITE_RANGE_FAIL'] = '1'
        result = self.deploy_real(fixture)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(fixture.current.is_symlink())
        self.assertFalse(fixture.api_current.is_symlink())
        self.assert_owner_files_and_no_probe_session(fixture, account)

    def test_single_owner_refuses_mismatched_or_root_service_identity_before_bootstrap(self):
        fixture, _, _ = self.fixture()
        fixture.env['MOCK_SERVICE_USER'] = 'root'
        result = self.deploy_real(fixture)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(Path(fixture.env['BAND_DEPLOY_DB']).exists())
        self.assertFalse(fixture.current.is_symlink())
        self.assertFalse((fixture.root / 'database-writers.log').exists())

    def test_rollback_backup_failure_never_switches_links_or_restarts_service(self):
        scratch = tempfile.TemporaryDirectory(prefix='band-r6-rollback-backup-fail-')
        self.addCleanup(scratch.cleanup)
        fixture = Fixture(scratch.name, 'success', has_api=False, previous_api=False)
        Path(fixture.env['BAND_DEPLOY_BACKUP_SCRIPT']).write_text('raise SystemExit(71)\n')
        inode = fixture.current.lstat().st_ino
        result = subprocess.run(['bash', str(fixture.rewritten('yasi-rollback')), str(fixture.obsolete)],
                                env=fixture.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 71)
        self.assertEqual(fixture.current.resolve(), fixture.previous)
        self.assertEqual(fixture.current.lstat().st_ino, inode)
        controls = (fixture.root / 'controls.log').read_text() if (fixture.root / 'controls.log').exists() else ''
        self.assertNotIn('restart', controls); self.assertNotIn('stop', controls)
        fixture.assert_database_unchanged()



def main():
    count = 0
    for has_api, cases in ((False, ['checksum', 'commit', 'escape', 'ci', 'build', 'missing', 'health', 'range', 'signal', 'success']), (True, ['api_candidate', 'api_missing_module', 'api_restart', 'api_health', 'api_proxy', 'health', 'range', 'api_signal', 'success'])):
        for case in cases:
            with tempfile.TemporaryDirectory(prefix='yasi-receiver-check-') as scratch:
                Fixture(scratch, case, has_api, previous_api=has_api).deploy()
            count += 1
            print(f'PASS deploy api={has_api} {case}', flush=True)
    for case in ('api_restart', 'api_health', 'api_proxy', 'success'):
        with tempfile.TemporaryDirectory(prefix='yasi-first-api-check-') as scratch:
            Fixture(scratch, case, has_api=True, previous_api=False).deploy()
        count += 1
        print(f'PASS first API {case}', flush=True)
    for target_has_api in (False, True):
        for case in ('success',) + (('api_restart', 'api_health', 'api_proxy') if target_has_api else ()):
            with tempfile.TemporaryDirectory(prefix='yasi-rollback-check-') as scratch:
                Fixture(scratch, case, previous_api=True).rollback(target_has_api)
            count += 1
            print(f'PASS rollback api={target_has_api} {case}', flush=True)
    suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(PrebuiltTests),
                                unittest.defaultTestLoader.loadTestsFromTestCase(CompatibilityTests),
                                unittest.defaultTestLoader.loadTestsFromTestCase(R6ReleaseTests),
                                unittest.defaultTestLoader.loadTestsFromTestCase(R6SingleOwnerReceiverTests)])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print(f'{count + result.testsRun} isolated deployment and rollback scenarios passed. No server-side Git or production paths used.')


if __name__ == '__main__':
    main()
