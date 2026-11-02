#!/usr/bin/env python3
"""Band Galaxy's same-origin, dependency-free progress sync API.

The database belongs outside application releases. Only Nginx should expose this
loopback service; do not publish its HTTP port to the internet.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import hmac
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit
import uuid


MAX_BODY = 8 * 1024 * 1024
SESSION_SECONDS = 30 * 24 * 60 * 60
SESSION_TOUCH_SECONDS = 60
HISTORY_LIMIT = 20
COOKIE_NAME = "band_session"
HASH_ITERATIONS = 600_000
DATASET = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\Z")
USERNAME = re.compile(r"[a-z0-9][a-z0-9_.-]{2,39}\Z")
PROGRESS_FIELDS = frozenset((
    "version", "datasetId", "cards", "skills", "bookmarks", "days", "typing",
    "session", "mistakes", "spell", "spellLog", "placement", "queue", "readings",
    "shadow", "hacks", "flashBest",
))
SETTINGS_FIELDS = frozenset((
    "accent", "autoplay", "dailyNew", "retention", "theme", "sfx", "spell",
    "startLevel", "onboarded", "dataset", "ambience", "ambienceVolume", "splash",
    "guessFirst", "sentenceFirst", "examDate", "dailyMinutes", "targetBand",
    "trackL", "trackP", "aiModel", "shadowAsr",
))
SENSITIVE_NAMES = frozenset((
    "apikey", "key", "password", "secret", "token", "authorization", "cookie",
    "accesstoken", "refreshtoken", "aikey",
))
SECRET_VALUE = re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), HASH_ITERATIONS)
    return f"pbkdf2-sha256${HASH_ITERATIONS}${salt}${digest.hex()}"


def password_matches(password: str, stored: str) -> bool:
    try:
        algorithm, rounds, salt, expected = stored.split("$")
        if algorithm != "pbkdf2-sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def device_name(user_agent: str) -> str:
    """Return a small fixed vocabulary, never echo an untrusted User-Agent."""
    agent = user_agent[:512].lower()
    if "iphone" in agent:
        device = "iPhone"
    elif "ipad" in agent:
        device = "iPad"
    elif "android" in agent:
        device = "安卓手机"
    elif "windows" in agent:
        device = "Windows"
    elif "macintosh" in agent or "mac os" in agent:
        device = "Mac"
    elif "linux" in agent:
        device = "Linux"
    else:
        device = "其他设备"
    if "edg/" in agent or "edgios/" in agent:
        browser = "Edge"
    elif "firefox/" in agent or "fxios/" in agent:
        browser = "Firefox"
    elif "chrome/" in agent or "crios/" in agent:
        browser = "Chrome"
    elif "safari/" in agent:
        browser = "Safari"
    else:
        browser = "浏览器"
    return f"{device}/{browser}"


def validate_snapshot(snapshot, dataset_id: str):
    """Allow learning data, never browser credentials or unknown root fields."""
    if not isinstance(snapshot, dict) or set(snapshot) != {"progress", "settings"}:
        raise ApiError(400, "同步数据格式不正确。")
    progress, settings = snapshot["progress"], snapshot["settings"]
    if not isinstance(progress, dict) or not isinstance(settings, dict):
        raise ApiError(400, "进度和设置必须是对象。")
    if set(progress) - PROGRESS_FIELDS or set(settings) - SETTINGS_FIELDS:
        raise ApiError(400, "同步数据包含不支持的字段。")
    if progress.get("version") != 2 or progress.get("datasetId") != dataset_id:
        raise ApiError(400, "同步词库或数据版本不匹配。")
    if progress.get("session") is not None:
        raise ApiError(400, "进行中的答题轮只保存在本机。")
    for name in ("cards", "skills", "days", "spell", "hacks", "shadow"):
        if name in progress and not isinstance(progress[name], dict):
            raise ApiError(400, "进度字段格式不正确。")
    for name in ("bookmarks", "typing", "mistakes", "spellLog", "queue", "readings"):
        if name in progress and not isinstance(progress[name], list):
            raise ApiError(400, "进度字段格式不正确。")
    if "cards" not in progress:
        raise ApiError(400, "缺少单词学习记录。")
    count = 0

    id_maps = {
        ("progress", "cards"), ("progress", "skills"), ("progress", "days"),
        ("progress", "spell"), ("progress", "hacks"),
        ("progress", "shadow", "days"), ("progress", "shadow", "done"),
    }

    def visit(value, depth=0, path=()):
        nonlocal count
        count += 1
        if count > 300_000 or depth > 16:
            raise ApiError(400, "同步数据结构过大。")
        if isinstance(value, dict):
            if len(value) > 50_000:
                raise ApiError(400, "同步数据条目过多。")
            for key, item in value.items():
                if len(key) > 256:
                    raise ApiError(400, "同步数据字段过长。")
                normalized = re.sub(r"[^a-z]", "", key.lower())
                # Word IDs include ordinary words such as "key" and "secret".
                if path not in id_maps and (normalized in SENSITIVE_NAMES or "apikey" in normalized):
                    raise ApiError(400, "同步数据不能包含密码或 API Key。")
                visit(item, depth + 1, (*path, key))
        elif isinstance(value, list):
            if len(value) > 50_000:
                raise ApiError(400, "同步数据条目过多。")
            for item in value:
                visit(item, depth + 1, (*path, "[]"))
        elif isinstance(value, str):
            if len(value) > 200_000 or SECRET_VALUE.search(value):
                raise ApiError(400, "同步文本过长或包含 API Key。")
        elif isinstance(value, float) and not math.isfinite(value):
            raise ApiError(400, "同步数据包含无效数字。")
        elif value is not None and not isinstance(value, (bool, int, float)):
            raise ApiError(400, "同步数据包含不支持的类型。")

    visit(snapshot)
    return snapshot


class Database:
    def __init__(self, path):
        self.path = str(Path(path).expanduser().resolve())
        directory = Path(self.path).parent
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS snapshots (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dataset_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (user_id, dataset_id)
                );
                CREATE TABLE IF NOT EXISTS snapshot_history (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dataset_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (user_id, dataset_id, revision)
                );
                CREATE TABLE IF NOT EXISTS commit_receipts (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dataset_id TEXT NOT NULL,
                    commit_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    PRIMARY KEY (user_id, dataset_id, commit_id)
                );
            """)
            # Existing deployments have only token_hash, user_id and expires_at.
            # Stable public IDs must be independent from authentication tokens.
            columns = {row["name"] for row in db.execute("PRAGMA table_info(sessions)")}
            for name, sql_type in (("session_id", "TEXT"), ("created_at", "INTEGER"),
                                   ("last_seen", "INTEGER"), ("device", "TEXT")):
                if name not in columns:
                    db.execute(f"ALTER TABLE sessions ADD COLUMN {name} {sql_type}")
            for row in db.execute("SELECT token_hash,expires_at FROM sessions WHERE session_id IS NULL OR session_id=''").fetchall():
                created = max(1, row["expires_at"] - SESSION_SECONDS)
                db.execute("UPDATE sessions SET session_id=?,created_at=COALESCE(created_at,?),"
                           "last_seen=COALESCE(last_seen,?),device=COALESCE(device,?) WHERE token_hash=?",
                           (secrets.token_hex(16), created, created, "旧设备/浏览器", row["token_hash"]))
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(session_id)")
            db.execute("PRAGMA user_version=2")
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA synchronous=FULL")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def session_for_token(self, token):
        if not token or len(token) > 200:
            return None
        now = int(time.time())
        with self.connect() as db:
            row = db.execute(
                "SELECT users.id,users.username,sessions.token_hash,sessions.session_id,sessions.last_seen "
                "FROM sessions JOIN users ON users.id=sessions.user_id "
                "WHERE sessions.token_hash=? AND sessions.expires_at>?",
                (hashlib.sha256(token.encode()).hexdigest(), now),
            ).fetchone()
            if row and (row["last_seen"] or 0) <= now - SESSION_TOUCH_SECONDS:
                db.execute("UPDATE sessions SET last_seen=? WHERE token_hash=? AND last_seen<=?",
                           (now, row["token_hash"], now - SESSION_TOUCH_SECONDS))
        return dict(row) if row else None

    def user_for_token(self, token):
        session = self.session_for_token(token)
        return {"id": session["id"], "username": session["username"]} if session else None

    @staticmethod
    def insert_session(db, user_id, device):
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        db.execute("INSERT INTO sessions (token_hash,user_id,expires_at,session_id,created_at,last_seen,device) VALUES (?,?,?,?,?,?,?)",
                   (hashlib.sha256(token.encode()).hexdigest(), user_id, now + SESSION_SECONDS,
                    secrets.token_hex(16), now, now, device))
        return token

    def new_session(self, user_id, device="其他设备/浏览器"):
        now = int(time.time())
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
            return self.insert_session(db, user_id, device)

    def list_sessions(self, current):
        now = int(time.time())
        with self.connect() as db:
            rows = db.execute("SELECT session_id,device,created_at,expires_at,last_seen,token_hash FROM sessions "
                              "WHERE user_id=? AND expires_at>? ORDER BY last_seen DESC,created_at DESC,session_id",
                              (current["id"], now)).fetchall()
        return [{"id": row["session_id"], "device": row["device"], "createdAt": row["created_at"] * 1000,
                 "expiresAt": row["expires_at"] * 1000, "lastSeenAt": row["last_seen"] * 1000,
                 "current": row["token_hash"] == current["token_hash"]} for row in rows]

    def get_snapshot(self, user_id, dataset_id, commit_id=None):
        with self.connect() as db:
            # SELECT alone does not begin a transaction in sqlite3. Keep the
            # snapshot and receipt in one WAL read view: a newer receipt paired
            # with an older payload would make the client acknowledge data it
            # has not actually received.
            db.execute("BEGIN")
            result = self._snapshot(db, user_id, dataset_id)
            if commit_id:
                result["applied"] = db.execute(
                    "SELECT 1 FROM commit_receipts WHERE user_id=? AND dataset_id=? AND commit_id=?",
                    (user_id, dataset_id, commit_id),
                ).fetchone() is not None
            return result

    @staticmethod
    def _snapshot(db, user_id, dataset_id):
        row = db.execute("SELECT revision,payload FROM snapshots WHERE user_id=? AND dataset_id=?",
                         (user_id, dataset_id)).fetchone()
        return {"revision": row["revision"], "snapshot": json.loads(row["payload"])} if row else {"revision": 0, "snapshot": None}

    def put_snapshot(self, user_id, dataset_id, revision, snapshot, commit_id):
        payload = encode(snapshot)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self._snapshot(db, user_id, dataset_id)
            receipt = db.execute(
                "SELECT 1 FROM commit_receipts WHERE user_id=? AND dataset_id=? AND commit_id=?",
                (user_id, dataset_id, commit_id),
            ).fetchone()
            if receipt:
                return True, {**current, "applied": True}
            if current["revision"] != revision:
                return False, {**current, "applied": False}
            next_revision, now = revision + 1, int(time.time())
            if current["snapshot"] is not None:
                db.execute("INSERT INTO snapshot_history VALUES (?,?,?,?,?)",
                           (user_id, dataset_id, revision, encode(current["snapshot"]), now))
            db.execute("INSERT INTO snapshots VALUES (?,?,?,?,?) "
                       "ON CONFLICT(user_id,dataset_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at",
                       (user_id, dataset_id, next_revision, payload, now))
            db.execute("DELETE FROM snapshot_history WHERE user_id=? AND dataset_id=? AND revision<=?",
                       (user_id, dataset_id, next_revision - HISTORY_LIMIT - 1))
            db.execute("INSERT INTO commit_receipts VALUES (?,?,?,?)", (user_id, dataset_id, commit_id, next_revision))
            return True, {"revision": next_revision, "snapshot": snapshot, "applied": True}

    def backup(self, destination):
        target = Path(destination).expanduser().resolve()
        if str(target) == self.path:
            raise ValueError("Backup destination must differ from the database")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.exists():
            raise ValueError("Backup destination already exists")
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        with self.connect() as source, sqlite3.connect(str(target)) as output:
            source.backup(output)


class RateLimiter:
    def __init__(self):
        self.entries = {}
        self.lock = threading.Lock()

    def consume(self, key, limit, window=600):
        now = time.monotonic()
        with self.lock:
            if len(self.entries) > 10_000:
                self.entries = {k: v for k, v in self.entries.items() if v[0] > now}
                if len(self.entries) > 10_000:
                    raise ApiError(429, "登录请求过多，请稍后再试。")
            expiry, count = self.entries.get(key, (now + window, 0))
            if expiry <= now:
                expiry, count = now + window, 0
            if count >= limit:
                raise ApiError(429, "登录请求过多，请十分钟后再试。")
            self.entries[key] = (expiry, count + 1)


class ApiServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = True

    def __init__(self, address, database, public_origin, secure_cookie, allow_register, trust_proxy, auth_limit, max_accounts, setup_token_hash):
        super().__init__(address, Handler)
        self.database = database
        self.public_origin = public_origin.rstrip("/")
        self.secure_cookie = secure_cookie
        self.allow_register = allow_register
        self.trust_proxy = trust_proxy
        self.auth_limit = auth_limit
        self.max_accounts = max_accounts
        self.setup_token_hash = setup_token_hash
        self.limiter = RateLimiter()
        # Same PBKDF2 cost for non-existent accounts, without storing a credential.
        self.dummy_hash = password_hash(secrets.token_urlsafe(32))


class Handler(BaseHTTPRequestHandler):
    server_version = "BandGalaxy"
    sys_version = ""
    timeout = 15

    def log_message(self, format, *args):
        # Request bodies, cookies and passwords are never written to access logs.
        return

    def send_json(self, status, payload, cookie=None):
        body = encode(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 429:
            self.send_header("Retry-After", "600")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def session_cookie(self, token, clear=False):
        value = f"{COOKIE_NAME}={token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={0 if clear else SESSION_SECONDS}"
        return value + ("; Secure" if self.server.secure_cookie else "")

    def token(self):
        try:
            cookies = SimpleCookie()
            cookies.load(self.headers.get("Cookie", ""))
            return cookies[COOKIE_NAME].value if COOKIE_NAME in cookies else None
        except Exception:
            return None

    def require_user(self):
        user = self.server.database.user_for_token(self.token())
        if not user:
            raise ApiError(401, "请先登录同步账号。")
        return user

    def require_session(self):
        session = self.server.database.session_for_token(self.token())
        if not session:
            raise ApiError(401, "请先登录同步账号。")
        return session

    def limit_account_action(self, user_id):
        ip = self.client_address[0]
        if self.server.trust_proxy and ip in ("127.0.0.1", "::1"):
            ip = self.headers.get("X-Real-IP", ip)[:128]
        self.server.limiter.consume(("account-action-ip", ip), max(100, self.server.auth_limit * 5))
        self.server.limiter.consume(("account-action", user_id), self.server.auth_limit)

    def check_origin(self):
        if self.headers.get("Origin") != self.server.public_origin:
            raise ApiError(403, "请求来源不受信任。")
        if self.headers.get("Sec-Fetch-Site", "") == "cross-site":
            raise ApiError(403, "不允许跨站请求。")

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(400, "不支持分块请求体。")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
            raise ApiError(415, "请使用 JSON 请求。")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "请求长度不正确。") from None
        if length < 1:
            raise ApiError(400, "请求内容为空。")
        if length > MAX_BODY:
            raise ApiError(413, "同步数据超过 8 MB。")
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ApiError(400, "请求内容不完整。")
            value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "请求不是有效的 JSON。") from None
        if not isinstance(value, dict):
            raise ApiError(400, "请求必须是 JSON 对象。")
        return value

    def dataset_id(self, path):
        if not path.startswith("/api/sync/"):
            return None
        value = unquote(path[len("/api/sync/"):])
        if not DATASET.fullmatch(value):
            raise ApiError(400, "词库标识无效。")
        return value

    def authenticate(self, data, register):
        allowed = {"username", "password", "setupToken"} if register else {"username", "password"}
        if not {"username", "password"}.issubset(data) or set(data) - allowed:
            raise ApiError(400, "请填写账号名和密码。")
        username, password = data["username"], data["password"]
        if not isinstance(username, str) or not isinstance(password, str):
            raise ApiError(400, "账号名或密码格式不正确。")
        username = username.strip().lower()
        if not USERNAME.fullmatch(username) or not 10 <= len(password) <= 256:
            raise ApiError(400, "账号名须为 3–40 位英文、数字或 ._-，密码须为 10–256 位。")
        ip = self.client_address[0]
        if self.server.trust_proxy and ip in ("127.0.0.1", "::1"):
            ip = self.headers.get("X-Real-IP", ip)[:128]
        self.server.limiter.consume(("ip", ip), max(100, self.server.auth_limit * 5))
        self.server.limiter.consume(("account", username), self.server.auth_limit)
        if register:
            if not self.server.allow_register:
                raise ApiError(403, "暂未开放新账号注册。")
            if self.server.public_origin.startswith("https://") and not self.server.setup_token_hash:
                raise ApiError(403, "服务器尚未配置首次注册配对码。")
            if self.server.setup_token_hash:
                setup_token = data.get("setupToken")
                if not isinstance(setup_token, str) or len(setup_token) > 256 or not hmac.compare_digest(
                    hashlib.sha256(setup_token.encode()).hexdigest(), self.server.setup_token_hash,
                ):
                    raise ApiError(403, "首次注册配对码不正确。")
            user = {"id": secrets.token_hex(16), "username": username}
            hashed = password_hash(password)
            try:
                with self.server.database.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    count = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
                    if count >= self.server.max_accounts:
                        raise ApiError(403, "同步账号已创建，请使用已有账号登录。")
                    db.execute("INSERT INTO users VALUES (?,?,?,?)", (user["id"], username, hashed, int(time.time())))
                    token = self.server.database.insert_session(db, user["id"], device_name(self.headers.get("User-Agent", "")))
            except sqlite3.IntegrityError:
                raise ApiError(409, "这个账号名已被使用。") from None
        else:
            with self.server.database.connect() as db:
                row = db.execute("SELECT id,username,password_hash FROM users WHERE username=?", (username,)).fetchone()
            if not password_matches(password, row["password_hash"] if row else self.server.dummy_hash) or not row:
                raise ApiError(401, "账号名或密码不正确。")
            user = {"id": row["id"], "username": row["username"]}
            # A concurrent password change must not let a verified old password
            # issue a fresh session after all old sessions were revoked.
            with self.server.database.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                latest = db.execute("SELECT password_hash FROM users WHERE id=?", (user["id"],)).fetchone()
                if not latest or latest["password_hash"] != row["password_hash"]:
                    raise ApiError(401, "密码已更新，请使用新密码登录。")
                db.execute("DELETE FROM sessions WHERE expires_at<=?", (int(time.time()),))
                token = self.server.database.insert_session(db, user["id"], device_name(self.headers.get("User-Agent", "")))
        self.send_json(201 if register else 200, {"user": user}, self.session_cookie(token))

    def manage_account(self, method, path):
        current = self.require_session()
        database = self.server.database
        if method == "GET" and path == "/api/account/sessions":
            return self.send_json(200, {"sessions": database.list_sessions(current)})
        if method != "POST":
            raise ApiError(404, "接口不存在。")
        self.limit_account_action(current["id"])
        data = self.body()
        if path == "/api/account/password":
            if set(data) != {"currentPassword", "newPassword"}:
                raise ApiError(400, "请填写当前密码和新密码。")
            old, new = data["currentPassword"], data["newPassword"]
            if not isinstance(old, str) or not 1 <= len(old) <= 256 or not isinstance(new, str) or not 10 <= len(new) <= 256:
                raise ApiError(400, "新密码须为 10–256 位。")
            with database.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT users.password_hash FROM users JOIN sessions ON sessions.user_id=users.id "
                                 "WHERE users.id=? AND sessions.token_hash=? AND sessions.expires_at>?",
                                 (current["id"], current["token_hash"], int(time.time()))).fetchone()
                if not row:
                    raise ApiError(401, "登录已过期，请重新登录。")
                if not password_matches(old, row["password_hash"]):
                    raise ApiError(401, "当前密码不正确。")
                db.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash(new), current["id"]))
                db.execute("DELETE FROM sessions WHERE user_id=?", (current["id"],))
                token = database.insert_session(db, current["id"], device_name(self.headers.get("User-Agent", "")))
            user = {"id": current["id"], "username": current["username"]}
            return self.send_json(200, {"ok": True, "user": user}, self.session_cookie(token))
        if path == "/api/account/sessions/revoke":
            if set(data) != {"id"} or not isinstance(data["id"], str) or not re.fullmatch(r"[a-f0-9]{32}", data["id"]):
                raise ApiError(400, "设备登录标识无效。")
            if data["id"] == current["session_id"]:
                raise ApiError(400, "当前设备请使用退出登录。")
            with database.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if not db.execute("SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?",
                                  (current["token_hash"], current["id"], int(time.time()))).fetchone():
                    raise ApiError(401, "登录已过期，请重新登录。")
                deleted = db.execute("DELETE FROM sessions WHERE user_id=? AND session_id=?",
                                     (current["id"], data["id"])).rowcount
            if not deleted:
                raise ApiError(404, "设备登录不存在或已退出。")
            return self.send_json(200, {"ok": True})
        if path == "/api/account/sessions/revoke-others":
            if data:
                raise ApiError(400, "请求格式不正确。")
            with database.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if not db.execute("SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?",
                                  (current["token_hash"], current["id"], int(time.time()))).fetchone():
                    raise ApiError(401, "登录已过期，请重新登录。")
                db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (current["id"], current["token_hash"]))
            return self.send_json(200, {"ok": True})
        raise ApiError(404, "接口不存在。")

    def dispatch(self, method):
        request_url = urlsplit(self.path)
        path = request_url.path
        if method in ("POST", "PUT"):
            self.check_origin()
        if method == "GET" and path == "/api/health":
            # A database read proves the path and schema are usable.
            with self.server.database.connect() as db:
                db.execute("SELECT id FROM users LIMIT 1").fetchone()
            return self.send_json(200, {"ok": True})
        if method == "GET" and path == "/api/auth/session":
            return self.send_json(200, {"user": self.server.database.user_for_token(self.token())})
        if method == "POST" and path in ("/api/auth/register", "/api/auth/login"):
            return self.authenticate(self.body(), path.endswith("/register"))
        if method == "POST" and path == "/api/auth/logout":
            token = self.token()
            if token:
                with self.server.database.connect() as db:
                    db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
            return self.send_json(200, {"ok": True}, self.session_cookie("", clear=True))
        if path.startswith("/api/account/"):
            return self.manage_account(method, path)
        dataset_id = self.dataset_id(path)
        if dataset_id:
            user = self.require_user()
            if method == "GET":
                query = parse_qs(request_url.query, keep_blank_values=True)
                if set(query) - {"commitId"} or len(query.get("commitId", [])) > 1:
                    raise ApiError(400, "同步查询格式不正确。")
                commit_id = self.commit_id(query["commitId"][0]) if "commitId" in query else None
                return self.send_json(200, self.server.database.get_snapshot(user["id"], dataset_id, commit_id))
            if method == "PUT":
                data = self.body()
                if set(data) != {"revision", "snapshot", "commitId"}:
                    raise ApiError(400, "同步请求格式不正确。")
                revision = data["revision"]
                if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision <= 9_007_199_254_740_990:
                    raise ApiError(400, "同步版本号无效。")
                snapshot = validate_snapshot(data["snapshot"], dataset_id)
                commit_id = self.commit_id(data["commitId"])
                ok, result = self.server.database.put_snapshot(user["id"], dataset_id, revision, snapshot, commit_id)
                return self.send_json(200 if ok else 409, result)
        raise ApiError(404, "接口不存在。")

    @staticmethod
    def commit_id(value):
        if not isinstance(value, str) or len(value) != 36:
            raise ApiError(400, "提交标识无效。")
        try:
            if str(uuid.UUID(value)) != value:
                raise ValueError()
        except ValueError:
            raise ApiError(400, "提交标识无效。") from None
        return value

    def handle_method(self, method):
        try:
            self.dispatch(method)
        except ApiError as error:
            self.send_json(error.status, {"error": error.message})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            # Never include request bodies or database details in error responses.
            self.send_json(500, {"error": "服务器暂时无法同步，请稍后重试。"})

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")

    def do_PUT(self):
        self.handle_method("PUT")


def create_server(host="127.0.0.1", port=5189, db_path=None, public_origin=None,
                  secure_cookie=None, allow_register=True, trust_proxy=False, auth_limit=20,
                  max_accounts=1, setup_token_hash=None):
    db_path = db_path or os.environ.get("BAND_DB_PATH", "./var/band-galaxy.sqlite3")
    public_origin = public_origin or os.environ.get("BAND_PUBLIC_ORIGIN", "http://localhost:5188")
    parsed = urlsplit(public_origin)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("BAND_PUBLIC_ORIGIN must be one HTTP(S) origin")
    if secure_cookie is None:
        secure_cookie = os.environ.get("BAND_COOKIE_SECURE", "1" if parsed.scheme == "https" else "0") == "1"
    if parsed.scheme == "https" and not secure_cookie:
        raise ValueError("HTTPS origins require secure session cookies")
    setup_token_hash = setup_token_hash or os.environ.get("BAND_SETUP_TOKEN_HASH", "")
    setup_token = os.environ.get("BAND_SETUP_TOKEN", "")
    if setup_token and not setup_token_hash:
        setup_token_hash = hashlib.sha256(setup_token.encode()).hexdigest()
    if setup_token_hash and not re.fullmatch(r"[a-f0-9]{64}", setup_token_hash):
        raise ValueError("BAND_SETUP_TOKEN_HASH must be a lowercase SHA-256 hash")
    if not isinstance(max_accounts, int) or not 1 <= max_accounts <= 1000:
        raise ValueError("BAND_MAX_ACCOUNTS must be between 1 and 1000")
    return ApiServer((host, port), Database(db_path), public_origin, secure_cookie, allow_register, trust_proxy, auth_limit, max_accounts, setup_token_hash)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5189)
    parser.add_argument("--db", default=os.environ.get("BAND_DB_PATH", "./var/band-galaxy.sqlite3"))
    parser.add_argument("--backup", metavar="DESTINATION", help="Create a consistent SQLite backup and exit")
    args = parser.parse_args()
    if args.backup:
        if not Path(args.db).expanduser().is_file():
            parser.error("Backup source database does not exist")
        Database(args.db).backup(args.backup)
        print("Database backup completed.")
        return
    server = create_server(args.host, args.port, args.db,
                           allow_register=os.environ.get("BAND_ALLOW_REGISTER", "1") == "1",
                           trust_proxy=os.environ.get("BAND_TRUST_PROXY", "0") == "1",
                           max_accounts=int(os.environ.get("BAND_MAX_ACCOUNTS", "1")))
    print(f"Band Galaxy sync listening on {args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
