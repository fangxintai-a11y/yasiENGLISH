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

OPS = Path(__file__).resolve().parent
REVISION = "abcdef1234567890abcdef1234567890abcdef12"
RELEASE_ID = "20261102T000000Z-" + REVISION[:8]
OLD_ID = "20261029T000000Z-11111111"
OLDER_ID = "20261028T000000Z-00000000"

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
        body = b'{"ok":true}' if self.path.endswith('/health') else b'{"learningRecords":1}' if self.path == '/api/capabilities' else b'{"user":null}'
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
elif name == 'df': print('Available\n100000000')
elif name == 'flock': pass
elif name == 'readlink': print(pathlib.Path(args[-1]).resolve())
elif name == 'sha256sum':
    digest, path = sys.stdin.read().strip().split(None, 1)
    if hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() != digest: fail(2)
elif name == 'mv':
    files = [x for x in args if not x.startswith('-')]
    os.rename(files[0], files[1])
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
    if args[0] == 'ci' and case == 'ci': fail(8)
    if args[0] == 'run':
        if case == 'build': fail(9)
        for filename in ['index.html','sw.js','manifest.webmanifest','atlas/index.json','atlas/img/abandon.webp','atlas/audio/word-uk/abandon.mp3','offline/pack.json']:
            target = pathlib.Path('dist') / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{}')
        if case == 'missing': pathlib.Path('dist/sw.js').unlink()
elif name == 'nginx':
    if case == 'nginx': fail(10)
elif name == 'systemctl':
    with (root / 'controls.log').open('a') as log: log.write(' '.join(args) + '\n')
    if args[0] == 'is-active': fail(0 if os.environ['API_PREVIOUS'] == '1' else 3)
    if args[:2] == ['restart', 'band-galaxy.service']:
        marker = root / 'restarted'
        first = not marker.exists()
        marker.touch()
        if case == 'api_restart' and first: fail(11)
        if case == 'api_signal' and first: os.kill(os.getppid(), signal.SIGTERM)
    if args[:2] == ['reload', 'nginx']:
        marker = root / 'reloaded'
        first = not marker.exists()
        marker.touch()
        if case == 'reload' and first: fail(11)
        if case == 'signal' and first: os.kill(os.getppid(), signal.SIGTERM)
elif name == 'curl':
    url = next(arg for arg in args if arg.startswith('http'))
    if case == 'health' and url.endswith('/'): fail(12)
    if case == 'api_health' and url.startswith('http://127.0.0.1:5189'): fail(13)
    if case == 'api_proxy' and url.startswith('https://') and url.endswith('/api/health'): fail(14)
    output = args[args.index('-o') + 1] if '-o' in args else '/dev/null'
    ranged = 'Range: bytes=0-99' in args
    if output != '/dev/null': pathlib.Path(output).write_bytes(b'0' * 100 if ranged else b'{"ok":true}')
    if ranged: print('200' if case == 'range' else '206', end='')
'''


class Fixture:
    def __init__(self, root, case, has_api=False, previous_api=False):
        self.root, self.case, self.has_api, self.previous_api = Path(root).resolve(), case, has_api, previous_api
        self.project = self.root / "opt/yasi"
        self.web = self.root / "var/www/yasi"
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
        helper.write_text((OPS / "backup-sync.py").read_text().replace("/var/lib/band-galaxy", str(self.state)))
        for command in ('git', 'df', 'flock', 'readlink', 'sha256sum', 'mv', 'rm', 'stat', 'find', 'install', 'npm', 'nginx', 'systemctl', 'curl'):
            path = self.binary / command
            path.write_text(MOCK.replace('#!PYTHON', '#!' + sys.executable))
            path.chmod(0o755)
        (self.binary / 'python3').symlink_to(sys.executable)
        self.env = os.environ | {'CASE': case, 'TASK_ROOT': str(self.root), 'API_PREVIOUS': '1' if previous_api else '0'}

    def rewritten(self, name):
        code = (OPS / name).read_text()
        for source in ('/opt/yasi', '/var/www/yasi', '/var/lib/band-galaxy', '/run/lock', '/etc/band-galaxy.env', '/usr/local/lib/band-galaxy/backup.py'):
            code = code.replace(source, str(self.root) + source)
        code = code.replace('[[ $EUID -eq 0 ]]', 'true')
        code = code.replace('export PATH=', 'export PATH=' + str(self.binary) + ':')
        target = self.root / name
        target.write_text(code)
        return target

    def assert_database_unchanged(self):
        with sqlite3.connect(self.state / 'progress.sqlite3') as db:
            assert db.execute('SELECT value FROM preserve_me').fetchall() == [('actual progress',)]

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
        expected_failure = {'checksum': 2, 'commit': 1, 'escape': 1, 'ci': 8, 'build': 9, 'missing': 1, 'nginx': 10, 'reload': 11, 'health': 12, 'range': 1, 'signal': 143, 'api_candidate': 1, 'api_missing_module': 1, 'api_restart': 11, 'api_health': 13, 'api_proxy': 14, 'api_signal': 143}
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


def main():
    count = 0
    for has_api, cases in ((False, ['checksum', 'commit', 'escape', 'ci', 'build', 'missing', 'nginx', 'reload', 'health', 'range', 'signal', 'success']), (True, ['api_candidate', 'api_missing_module', 'api_restart', 'api_health', 'api_proxy', 'reload', 'health', 'range', 'api_signal', 'success'])):
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
        for case in ('reload', 'success') + (('api_restart', 'api_health', 'api_proxy') if target_has_api else ()):
            with tempfile.TemporaryDirectory(prefix='yasi-rollback-check-') as scratch:
                Fixture(scratch, case, previous_api=True).rollback(target_has_api)
            count += 1
            print(f'PASS rollback api={target_has_api} {case}', flush=True)
    print(f'{count} isolated deployment and rollback scenarios passed. No server-side Git or production paths used.')


if __name__ == '__main__':
    main()
