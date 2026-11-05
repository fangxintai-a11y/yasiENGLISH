#!/usr/bin/env python3
"""Validate production Caddy JSON, then exercise that route graph on loopback HTTP ports."""
import argparse
import copy
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time

OPS = Path(__file__).resolve().parent
ROOT = OPS.parent.parent


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main(caddy):
    original = json.loads(subprocess.check_output([caddy, 'adapt', '--config', str(OPS / 'Caddyfile'), '--adapter', 'caddyfile'], text=True))
    servers = original['apps']['http']['servers']
    assert sorted(address for server in servers.values() for address in server['listen']) == [':80', ':8443']
    assert original['apps']['http']['http_port'] == 80
    assert original['apps']['http']['https_port'] == 8443
    assert original['apps']['tls']['automation']['policies'][0]['issuers'][0]['challenges']['tls-alpn']['disabled'] is True
    spec = importlib.util.spec_from_file_location('band_web_probe', ROOT / 'server/app.py')
    app = importlib.util.module_from_spec(spec); spec.loader.exec_module(app)
    with tempfile.TemporaryDirectory(prefix='band-caddy-web-') as scratch:
        scratch = Path(scratch)
        site, private, atlas = [scratch / name for name in ('site', 'private', 'atlas')]
        for directory in (site, private, atlas): directory.mkdir()
        (site / 'index.html').write_text('<h1>authenticated fixture app</h1>')
        (site / 'app.js').write_text('window.selfAuthoredFixture=true;')
        (private / 'test.m4a').write_bytes(bytes(range(255)) * 4)
        (private / 'manifest.json').write_text('{"synthetic":true}')
        port = free_port()
        origin = f'http://127.0.0.1:{port}'
        api = app.create_server(port=0, db_path=scratch / 'fixture.sqlite3', public_origin=origin,
                                single_user=True, secure_cookie=False, site_root=site, private_root=private, atlas_root=atlas)
        with api.database.connect() as db:
            db.execute('INSERT INTO users VALUES (?,?,?,?)', ('fixture-owner', 'owner', app.password_hash('fixture password only'), int(time.time())))
        thread = threading.Thread(target=api.serve_forever, daemon=True); thread.start()
        graph = copy.deepcopy(next(server for server in servers.values() if ':8443' in server['listen']))
        graph['listen'] = [f'127.0.0.1:{port}']; graph['automatic_https'] = {'disable': True}
        graph.pop('tls_connection_policies', None)
        serialized = json.dumps(graph).replace('127.0.0.1:5189', f'127.0.0.1:{api.server_port}').replace('ibaz.cn', '127.0.0.1').replace('/srv/yasi/current', str(site)).replace('/srv/yasi/private', str(private))
        config = {'admin': {'disabled': True}, 'apps': {'http': {'servers': {'isolated': json.loads(serialized)}}}}
        config_file = scratch / 'caddy.json'; config_file.write_text(json.dumps(config))
        log = (scratch / 'caddy.log').open('w')
        process = subprocess.Popen([caddy, 'run', '--config', str(config_file)], stdout=log, stderr=log,
                                   env=os.environ | {'XDG_DATA_HOME': str(scratch / 'data'), 'XDG_CONFIG_HOME': str(scratch / 'config')})
        def request(method, path, data=None, cookie=None, ranged=False):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            headers = {'Origin': origin, 'Content-Type': 'application/json'}
            if cookie: headers['Cookie'] = cookie.split(';')[0]
            if ranged: headers['Range'] = 'bytes=11-20'
            try:
                connection.request(method, path, json.dumps(data).encode() if data is not None else None, headers)
                response = connection.getresponse()
                return response.status, response.read(), dict(response.getheaders())
            finally: connection.close()
        try:
            for _ in range(100):
                if process.poll() is not None: raise RuntimeError((scratch / 'caddy.log').read_text())
                try:
                    if request('GET', '/login')[0] == 200: break
                except OSError: pass
                time.sleep(.05)
            else: raise RuntimeError('Isolated Caddy did not become ready')
            assert request('GET', '/')[0] == 302
            for path in ['/app.js', '/api/learning/v2/changes', '/private/test.m4a', '/private/manifest.json']:
                assert request('GET', path)[0] in (401, 403), path
            status, _, headers = request('POST', '/api/auth/login', {'username': 'owner', 'password': 'fixture password only'})
            assert status == 200
            cookie = headers['Set-Cookie']
            for path in ['/', '/app.js', '/api/learning/v2/changes', '/private/manifest.json']:
                assert request('GET', path, cookie=cookie)[0] == 200, path
            status, body, headers = request('GET', '/private/test.m4a', cookie=cookie, ranged=True)
            assert status == 206 and body == bytes(range(11, 21)) and headers['Content-Range'] == 'bytes 11-20/1020'
            assert 'max-age=' in headers['Strict-Transport-Security']
            assert request('POST', '/api/auth/register', {'username': 'other', 'password': 'second owner forbidden'}, cookie=cookie)[0] == 403
            with api.database.connect() as db: assert db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1
            assert request('POST', '/api/auth/logout', {}, cookie=cookie)[0] == 200
            assert request('GET', '/private/test.m4a', cookie=cookie)[0] == 401
            print(json.dumps({'success': True, 'checks': ['production listeners are only 80/8443; HTTP-01 with TLS-ALPN disabled', 'real Caddy forwards login and validates cookie for app/API/private', 'anonymous private manifest/audio cannot be read', 'authenticated private audio Range returns exact 206 bytes', 'second account is rejected and logout invalidates private access'], 'productionWrites': False}))
        finally:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            log.close(); api.shutdown(); api.server_close(); thread.join(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--caddy', default=os.environ.get('BAND_CADDY_BIN', 'caddy'))
    main(parser.parse_args().caddy)
