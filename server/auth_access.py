"""Optional single-owner web boundary; no learning storage or migration changes."""
from pathlib import Path
from urllib.parse import unquote, quote
import mimetypes
import re

LOGIN_HTML = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 雅思星图</title><style>body{font:16px system-ui;max-width:26rem;margin:10vh auto;padding:1.2rem}label,input,button{display:block;box-sizing:border-box;width:100%;margin:.7rem 0}input,button{font:inherit;padding:.8rem}p{overflow-wrap:anywhere}</style><h1>雅思星图</h1><p>请登录你的学习账号。</p><form id="login"><label>账号<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录</button><p id="message" role="status"></p></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target,m=document.querySelector('#message'),b=f.querySelector('button');b.disabled=true;m.textContent='正在登录…';try{const r=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.username.value,password:f.password.value})});const d=await r.json();if(!r.ok)throw Error(d.error||'登录未完成。');location.replace('/');}catch(e){m.textContent=e.message;}finally{b.disabled=false;}};</script></html>'''

def send_bytes(handler, status, body, content_type, extra=(), head=False):
    handler.send_response(status)
    handler.send_header('Content-Type', content_type)
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    for key, value in extra:
        handler.send_header(key, value)
    handler.end_headers()
    if not head:
        handler.wfile.write(body)


def safe_file(root, relative):
    root = Path(root).resolve()
    decoded = unquote(relative)
    if '\x00' in decoded or '\\' in decoded or any(part in ('.', '..') for part in decoded.split('/')):
        return None
    path = (root / decoded.lstrip('/')).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        return None
    return path


def serve_file(handler, path, head=False, private=False):
    size = path.stat().st_size
    start, end, status = 0, size - 1, 200
    value = handler.headers.get('Range')
    if value:
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', value.strip())
        if not match or not any(match.groups()):
            send_bytes(handler, 416, b'', 'application/octet-stream', [('Content-Range', f'bytes */{size}')], head)
            return
        left, right = match.groups()
        if left:
            start = int(left)
            end = min(int(right), size - 1) if right else size - 1
        else:
            count = int(right)
            start = max(0, size - count)
        if start > end or start >= size or end < 0:
            send_bytes(handler, 416, b'', 'application/octet-stream', [('Content-Range', f'bytes */{size}')], head)
            return
        status = 206
    handler.send_response(status)
    handler.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
    handler.send_header('Content-Length', str(max(0, end - start + 1)))
    handler.send_header('Accept-Ranges', 'bytes')
    handler.send_header('Cache-Control', 'private, no-store' if private else 'private, no-cache')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    if status == 206:
        handler.send_header('Content-Range', f'bytes {start}-{end}/{size}')
    handler.end_headers()
    if not head:
        with path.open('rb') as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                block = source.read(min(65536, remaining))
                if not block:
                    break
                handler.wfile.write(block)
                remaining -= len(block)


def web_boundary(handler, method, path):
    """Return True if served. Caddy repeats this cookie check before any private file."""
    if not handler.server.single_user:
        return False
    if method in ('GET', 'HEAD') and path == '/login':
        send_bytes(handler, 200, LOGIN_HTML.encode(), 'text/html; charset=utf-8', head=method == 'HEAD')
        return True
    if path in ('/api/auth/login', '/api/auth/session'):
        return False
    if path == '/api/auth/register':
        handler.send_json(403, {'error': '本站只开放已有账号登录。'})
        return True
    user = handler.server.database.user_for_token(handler.token())
    if path == '/api/auth/check':
        handler.send_json(200 if user else 401, {'ok': bool(user)})
        return True
    # Operational health is loopback-only. The Caddy route still authenticates all API paths.
    if method == 'GET' and path == '/api/health' and handler.client_address[0] in ('127.0.0.1', '::1'):
        return False
    if not user:
        if path == '/' and method in ('GET', 'HEAD'):
            send_bytes(handler, 302, b'', 'text/plain', [('Location', '/login')], method == 'HEAD')
        else:
            handler.send_json(401, {'error': '请先登录学习账号。'})
        return True
    if path.startswith('/api/'):
        return False
    if method not in ('GET', 'HEAD'):
        handler.send_json(405, {'error': '不支持此请求。'})
        return True
    root, relative = handler.server.site_root, path
    if path.startswith('/private/'):
        root, relative = handler.server.private_root, path[len('/private/'):]
    elif path.startswith('/atlas/'):
        root, relative = handler.server.atlas_root, path[len('/atlas/'):]
    elif path.startswith(('/ielts/phrase/', '/sfx/')):
        # Only these legacy public audio locations are moved to the shared atlas.
        # Keep the root boundary at atlas_root; never relax site-root symlink checks.
        root, relative = handler.server.atlas_root, '_public/' + path.lstrip('/')
    elif path == '/':
        relative = 'index.html'
    file = safe_file(root, relative) if root else None
    if not file:
        handler.send_json(404, {'error': '文件不存在。'})
        return True
    serve_file(handler, file, method == 'HEAD', private=path.startswith('/private/'))
    return True
