#!/usr/bin/env python3
"""Authenticated loopback HTTPS smoke check using a temporary existing-owner session."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import tempfile
import time


def check_site(database, host, port, audio):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', host) or not (1024 <= port <= 65535 or port == 443 and os.environ.get('BAND_DEPLOY_ALLOW_STANDARD_HTTPS') == '1'):
        raise ValueError('Use the dedicated HTTPS host and port')
    if not re.fullmatch(r'atlas/[A-Za-z0-9_./-]+', audio) or '..' in audio.split('/'):
        raise ValueError('Use a checked atlas audio path')
    root = f'https://{host}:{port}'
    common = ['curl', '--silent', '--show-error', '--max-time', '30', '--retry', '5', '--retry-all-errors', '--retry-delay', '1', '--resolve', f'{host}:{port}:127.0.0.1']
    with tempfile.TemporaryDirectory(prefix='band-site-check-') as scratch:
        scratch = Path(scratch)
        def request(path, cookie=None, range_=False):
            output = scratch / 'body'
            args = common + ['-o', str(output), '-w', '%{http_code}']
            if cookie:
                args += ['--cookie', str(cookie)]
            if range_:
                args += ['-H', 'Range: bytes=0-99']
            value = subprocess.check_output(args + [root + path], text=True).strip()
            return int(value), output.read_bytes()
        for path in ['/api/learning/v2/changes', '/private/__access-check.m4a']:
            status, _ = request(path)
            if status not in (401, 403):
                raise RuntimeError(f'Anonymous protected path returned {status}, expected 401/403')
        status, _ = request('/')
        if status not in (301, 302, 303, 307, 308, 401, 403):
            raise RuntimeError('Anonymous root did not require login')
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with sqlite3.connect(database, timeout=30) as db:
            owners = db.execute('SELECT id FROM users').fetchall()
            if len(owners) != 1:
                raise RuntimeError('Exactly one owner is required before publication')
            now = int(time.time())
            db.execute('INSERT INTO sessions(token_hash,user_id,expires_at,session_id,created_at,last_seen,device) VALUES(?,?,?,?,?,?,?)',
                       (digest, owners[0][0], now + 300, secrets.token_hex(16), now, now, '发布核验（短效会话）'))
        try:
            cookie = scratch / 'cookie'
            cookie.write_text(f'# Netscape HTTP Cookie File\n{host}\tFALSE\t/\tTRUE\t{now + 300}\tband_session\t{token}\n')
            cookie.chmod(0o600)
            status, _ = request('/', cookie)
            if status != 200:
                raise RuntimeError(f'Authenticated root returned {status}, expected 200')
            status, body = request('/api/health', cookie)
            if status != 200 or body.replace(b' ', b'').strip() != b'{"ok":true}':
                raise RuntimeError('Authenticated API health check failed')
            status, body = request('/' + audio, cookie, True)
            if status != 206 or len(body) != 100:
                raise RuntimeError('Authenticated atlas audio Range did not return 206/100 bytes')
        finally:
            with sqlite3.connect(database, timeout=30) as db:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (digest,))
    print('Single-owner HTTPS gate, authenticated API and audio Range passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--audio', required=True)
    args = parser.parse_args()
    check_site(args.db, args.host, args.port, args.audio)
