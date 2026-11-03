"""Integration tests use disposable SQLite databases and loopback HTTP only."""

import concurrent.futures
import copy
import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

try:
    from . import app as app_module
    from .app import create_server, Database, MAX_BODY, HISTORY_LIMIT, SESSION_SECONDS, password_hash
except ImportError:
    import app as app_module
    from app import create_server, Database, MAX_BODY, HISTORY_LIMIT, SESSION_SECONDS, password_hash


DATASET = "word-atlas-open"
ORIGIN = "http://localhost:5188"


def snapshot(count=1):
    return {
        "progress": {
            "version": 2, "datasetId": DATASET, "cards": {"library": {"reps": count}},
            "skills": {}, "bookmarks": [], "days": {"2026-11-02": {"n": 1, "r": count, "c": 1, "t": 12}},
            "typing": [], "session": None, "mistakes": [], "spell": {}, "spellLog": [],
            "placement": None, "queue": [], "readings": [],
            "shadow": {"days": {}, "best": 0, "done": {}}, "hacks": {}, "flashBest": 0,
        },
        "settings": {"accent": "uk", "dailyNew": 10, "targetBand": 6.5},
    }


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="band-sync-test-")
        cls.db_path = str(Path(cls.directory.name) / "progress.sqlite3")
        cls.server = create_server(port=0, db_path=cls.db_path, public_origin=ORIGIN,
                                   max_accounts=100, auth_limit=1000)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.directory.cleanup()

    def request(self, method, path, data=None, cookie=None, origin=ORIGIN, raw=None, headers=None, server=None):
        target = server or self.server
        connection = http.client.HTTPConnection(*target.server_address, timeout=10)
        request_headers = {"Content-Type": "application/json"}
        if origin is not None:
            request_headers["Origin"] = origin
        if cookie:
            request_headers["Cookie"] = cookie.split(";", 1)[0]
        if headers:
            request_headers.update(headers)
        body = raw if raw is not None else json.dumps(data).encode() if data is not None else None
        try:
            connection.request(method, path, body, request_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read()), dict(response.getheaders())
        finally:
            connection.close()

    def account(self):
        username = "user_" + uuid.uuid4().hex[:12]
        password = "correct horse battery staple"
        status, data, headers = self.request("POST", "/api/auth/register", {"username": username, "password": password})
        self.assertEqual(status, 201, data)
        return username, password, data["user"], headers["Set-Cookie"]

    def put(self, cookie, revision, value=None, commit_id=None):
        return self.request("PUT", "/api/sync/" + DATASET, {
            "revision": revision, "snapshot": snapshot() if value is None else value,
            "commitId": commit_id or str(uuid.uuid4()),
        }, cookie)

    def test_health_and_anonymous_session(self):
        status, data, headers = self.request("GET", "/api/health")
        self.assertEqual((status, data), (200, {"ok": True}))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/api/auth/session")[:2], (200, {"user": None}))

    def test_registration_login_logout_and_password_not_plaintext(self):
        username, password, user, cookie = self.account()
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertIn("Path=/api", cookie)
        self.assertEqual(self.request("GET", "/api/auth/session", cookie=cookie)[:2], (200, {"user": user}))
        with self.server.database.connect() as db:
            row = db.execute("SELECT password_hash FROM users WHERE id=?", (user["id"],)).fetchone()
            self.assertNotIn(password, row[0])
            self.assertTrue(row[0].startswith("pbkdf2-sha256$600000$"))
            token = cookie.split(";", 1)[0].split("=", 1)[1]
            self.assertIsNone(db.execute("SELECT 1 FROM sessions WHERE token_hash=?", (token,)).fetchone())
        self.assertEqual(self.request("POST", "/api/auth/login", {"username": username, "password": "wrong password"})[0], 401)
        status, data, headers = self.request("POST", "/api/auth/login", {"username": username.upper(), "password": password})
        self.assertEqual((status, data), (200, {"user": user}))
        second_cookie = headers["Set-Cookie"]
        self.assertEqual(self.request("POST", "/api/auth/logout", {}, second_cookie)[0], 200)
        self.assertEqual(self.request("GET", "/api/auth/session", cookie=second_cookie)[1], {"user": None})

    def test_snapshot_is_private_to_user_and_dataset(self):
        *_, alice = self.account()
        *_, bob = self.account()
        self.assertEqual(self.request("GET", "/api/sync/" + DATASET)[0], 401)
        self.assertEqual(self.put(None, 0)[0], 401)
        self.assertEqual(self.put(alice, 0)[0], 200)
        self.assertEqual(self.request("GET", "/api/sync/" + DATASET, cookie=bob)[1], {"revision": 0, "snapshot": None})
        self.assertEqual(self.request("GET", "/api/sync/other-dataset", cookie=alice)[1], {"revision": 0, "snapshot": None})

    def test_cas_rejects_stale_write_without_overwriting(self):
        *_, cookie = self.account()
        self.assertEqual(self.put(cookie, 0, snapshot(3))[1]["revision"], 1)
        status, data, _ = self.put(cookie, 0, snapshot(8))
        self.assertEqual(status, 409)
        self.assertFalse(data["applied"])
        self.assertEqual(data["revision"], 1)
        self.assertEqual(data["snapshot"], snapshot(3))
        self.assertEqual(self.put(cookie, 1, snapshot(9))[1]["revision"], 2)

    def test_concurrent_writers_cannot_both_commit_same_revision(self):
        *_, cookie = self.account()
        barrier = threading.Barrier(2)

        def write(count):
            barrier.wait(timeout=5)
            return self.put(cookie, 0, snapshot(count))

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(write, (4, 7)))
        self.assertEqual(sorted(item[0] for item in results), [200, 409])
        self.assertEqual(self.request("GET", "/api/sync/" + DATASET, cookie=cookie)[1]["revision"], 1)

    def test_lost_response_retry_is_idempotent_and_receipt_survives_newer_writes(self):
        *_, cookie = self.account()
        commit_id = str(uuid.uuid4())
        self.assertEqual(self.put(cookie, 0, snapshot(2), commit_id)[0], 200)
        self.assertEqual(self.put(cookie, 1, snapshot(5))[0], 200)
        status, data, _ = self.put(cookie, 0, snapshot(2), commit_id)
        self.assertEqual(status, 200)
        self.assertEqual(data["revision"], 2)
        self.assertEqual(data["snapshot"], snapshot(5))
        self.assertTrue(data["applied"])
        self.assertTrue(self.request("GET", f"/api/sync/{DATASET}?commitId={commit_id}", cookie=cookie)[1]["applied"])
        self.assertFalse(self.request("GET", f"/api/sync/{DATASET}?commitId={uuid.uuid4()}", cookie=cookie)[1]["applied"])

    def test_snapshot_and_receipt_use_one_consistent_wal_read_view(self):
        _, _, user, _ = self.account()
        database = self.server.database
        database.put_snapshot(user["id"], DATASET, 0, snapshot(1), str(uuid.uuid4()))
        pending_commit = str(uuid.uuid4())
        selected, resume = threading.Event(), threading.Event()
        original = Database._snapshot

        def paused_snapshot(db, user_id, dataset_id):
            result = original(db, user_id, dataset_id)
            if threading.current_thread().name.startswith("snapshot-reader"):
                selected.set()
                if not resume.wait(timeout=5):
                    raise RuntimeError("test reader did not resume")
            return result

        with patch.object(Database, "_snapshot", staticmethod(paused_snapshot)):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="snapshot-reader") as pool:
                reading = pool.submit(database.get_snapshot, user["id"], DATASET, pending_commit)
                self.assertTrue(selected.wait(timeout=5))
                try:
                    # WAL allows this writer to commit while the earlier reader
                    # is paused between its payload and receipt SELECTs.
                    accepted, _ = database.put_snapshot(user["id"], DATASET, 1, snapshot(2), pending_commit)
                    self.assertTrue(accepted)
                finally:
                    resume.set()
                before_commit = reading.result(timeout=5)
        self.assertEqual(before_commit, {"revision": 1, "snapshot": snapshot(1), "applied": False})
        self.assertEqual(database.get_snapshot(user["id"], DATASET, pending_commit),
                         {"revision": 2, "snapshot": snapshot(2), "applied": True})

    def test_history_is_bounded_but_receipts_remain(self):
        _, _, user, cookie = self.account()
        first_commit = str(uuid.uuid4())
        for i in range(HISTORY_LIMIT + 4):
            self.assertEqual(self.put(cookie, i, snapshot(i), first_commit if i == 0 else None)[0], 200)
        with self.server.database.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM snapshot_history WHERE user_id=?", (user["id"],)).fetchone()[0], HISTORY_LIMIT)
        self.assertTrue(self.request("GET", f"/api/sync/{DATASET}?commitId={first_commit}", cookie=cookie)[1]["applied"])

    def test_snapshot_rejects_credentials_unknown_fields_wrong_dataset_and_session(self):
        *_, cookie = self.account()
        cases = []
        value = snapshot(); value["settings"]["apiKey"] = "anything"; cases.append(value)
        value = snapshot(); value["progress"]["cards"]["library"]["token"] = "anything"; cases.append(value)
        value = snapshot(); value["progress"]["datasetId"] = "wrong"; cases.append(value)
        value = snapshot(); value["progress"]["session"] = {"id": "live"}; cases.append(value)
        value = snapshot(); value["progress"]["unknown"] = 1; cases.append(value)
        value = snapshot(); value["progress"]["readings"] = [{"passage": "sk-ant-1234567890abcdef"}]; cases.append(value)
        for value in cases:
            with self.subTest(value=value):
                self.assertEqual(self.put(cookie, 0, value)[0], 400)
        # These are real vocabulary IDs, not credential fields.
        value = snapshot()
        value["progress"]["cards"] = {word: {"reps": 1} for word in ("key", "secret", "password")}
        self.assertEqual(self.put(cookie, 0, value)[0], 200)

    def test_invalid_requests_and_csrf_are_rejected(self):
        *_, cookie = self.account()
        data = {"username": "another", "password": "good long password"}
        for origin in (None, "https://attacker.example"):
            self.assertEqual(self.request("POST", "/api/auth/login", data, origin=origin)[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/logout", {}, cookie, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("PUT", "/api/sync/" + DATASET, {}, cookie, headers={"Content-Length": str(MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.request("POST", "/api/auth/login", raw=b"{broken")[0], 400)
        self.assertEqual(self.request("POST", "/api/auth/login", data, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("GET", "/api/sync/..%2Fescape", cookie=cookie)[0], 400)
        self.assertEqual(self.request("GET", "/api/sync/" + DATASET + "?commitId=invalid", cookie=cookie)[0], 400)
        self.assertEqual(self.request("PUT", "/api/sync/" + DATASET, {"revision": True, "snapshot": snapshot(), "commitId": str(uuid.uuid4())}, cookie)[0], 400)
        self.assertEqual(self.request("PUT", "/api/sync/" + DATASET, {"revision": 0, "snapshot": snapshot(), "commitId": "invalid"}, cookie)[0], 400)

    def test_persisted_snapshot_and_consistent_backup(self):
        _, _, user, cookie = self.account()
        self.put(cookie, 0, snapshot(11))
        reopened = Database(self.db_path)
        self.assertEqual(reopened.get_snapshot(user["id"], DATASET)["snapshot"], snapshot(11))
        backup = Path(self.directory.name) / (uuid.uuid4().hex + ".sqlite3")
        reopened.backup(backup)
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("SELECT revision FROM snapshots WHERE user_id=?", (user["id"],)).fetchone()[0], 1)
        with self.assertRaises(ValueError):
            reopened.backup(backup)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

    def temporary_server(self, **kwargs):
        path = str(Path(self.directory.name) / (uuid.uuid4().hex + ".sqlite3"))
        server = create_server(port=0, db_path=path, public_origin=ORIGIN, **kwargs)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def test_single_account_cap_and_auth_rate_limit(self):
        server = self.temporary_server(auth_limit=2)
        data = {"username": "single", "password": "correct long password"}
        self.assertEqual(self.request("POST", "/api/auth/register", data, server=server)[0], 201)
        self.assertEqual(self.request("POST", "/api/auth/register", {**data, "username": "second"}, server=server)[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/login", {**data, "password": "wrong long password"}, server=server)[0], 401)
        self.assertEqual(self.request("POST", "/api/auth/login", data, server=server)[0], 429)

    def test_production_setup_token_and_secure_cookie(self):
        token = "test-only-one-time-pairing-code"
        server = self.temporary_server(secure_cookie=True, setup_token_hash=hashlib.sha256(token.encode()).hexdigest())
        data = {"username": "private", "password": "correct long password"}
        self.assertEqual(self.request("POST", "/api/auth/register", data, server=server)[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/register", {**data, "setupToken": "wrong"}, server=server)[0], 403)
        status, _, headers = self.request("POST", "/api/auth/register", {**data, "setupToken": token}, server=server)
        self.assertEqual(status, 201)
        self.assertIn("; Secure", headers["Set-Cookie"])

    def test_https_registration_requires_setup_configuration(self):
        server = self.temporary_server(secure_cookie=True)
        server.public_origin = "https://www.example.test"
        status, _, _ = self.request("POST", "/api/auth/register", {"username": "private", "password": "correct long password"},
                                    origin="https://www.example.test", server=server)
        self.assertEqual(status, 403)

    def test_session_list_uses_public_ids_short_devices_and_expiry(self):
        username, password, _, first = self.account()
        agent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1"
        status, _, headers = self.request("POST", "/api/auth/login", {"username": username, "password": password},
                                          headers={"User-Agent": agent})
        self.assertEqual(status, 200)
        phone = headers["Set-Cookie"]
        status, data, _ = self.request("GET", "/api/account/sessions", cookie=phone)
        self.assertEqual(status, 200)
        self.assertEqual(len(data["sessions"]), 2)
        current = next(row for row in data["sessions"] if row["current"])
        self.assertEqual(current["device"], "iPhone/Safari")
        self.assertEqual(set(current), {"id", "device", "createdAt", "expiresAt", "lastSeenAt", "current"})
        self.assertEqual(len(current["id"]), 32)
        self.assertGreater(current["createdAt"], 1_000_000_000_000)
        self.assertEqual(current["expiresAt"] - current["createdAt"], SESSION_SECONDS * 1000)
        token_hash = hashlib.sha256(phone.split(";", 1)[0].split("=", 1)[1].encode()).hexdigest()
        self.assertNotIn(token_hash, json.dumps(data))
        self.assertNotIn(agent, json.dumps(data))
        self.assertEqual(self.request("GET", "/api/account/sessions")[0], 401)
        with self.server.database.connect() as db:
            db.execute("UPDATE sessions SET expires_at=? WHERE token_hash=?", (int(time.time()) - 1, token_hash))
        self.assertEqual(self.request("GET", "/api/account/sessions", cookie=phone)[0], 401)
        self.assertIsNone(self.request("GET", "/api/auth/session", cookie=phone)[1]["user"])
        self.assertEqual(len(self.request("GET", "/api/account/sessions", cookie=first)[1]["sessions"]), 1)

    def test_session_touch_is_throttled(self):
        _, _, _, cookie = self.account()
        token_hash = hashlib.sha256(cookie.split(";", 1)[0].split("=", 1)[1].encode()).hexdigest()
        recent = int(time.time()) - 10
        with self.server.database.connect() as db:
            db.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (recent, token_hash))
        self.request("GET", "/api/auth/session", cookie=cookie)
        with self.server.database.connect() as db:
            self.assertEqual(db.execute("SELECT last_seen FROM sessions WHERE token_hash=?", (token_hash,)).fetchone()[0], recent)
            db.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (recent - 100, token_hash))
        self.request("GET", "/api/auth/session", cookie=cookie)
        with self.server.database.connect() as db:
            self.assertGreater(db.execute("SELECT last_seen FROM sessions WHERE token_hash=?", (token_hash,)).fetchone()[0], recent)

    def test_password_change_rotates_current_cookie_and_revokes_other_devices(self):
        username, old, user, first = self.account()
        _, _, headers = self.request("POST", "/api/auth/login", {"username": username, "password": old})
        second = headers["Set-Cookie"]
        self.put(first, 0, snapshot(12))
        new = "a completely different new password"
        self.assertEqual(self.request("POST", "/api/account/password", {"currentPassword": "incorrect", "newPassword": new}, first)[0], 401)
        self.assertEqual(self.request("POST", "/api/account/password", {"currentPassword": old, "newPassword": "short"}, first)[0], 400)
        self.assertEqual(self.request("GET", "/api/auth/session", cookie=second)[1]["user"], user)
        status, data, headers = self.request("POST", "/api/account/password", {"currentPassword": old, "newPassword": new}, first)
        self.assertEqual((status, data), (200, {"ok": True, "user": user}))
        rotated = headers["Set-Cookie"]
        self.assertNotEqual(rotated, first)
        self.assertEqual(self.request("GET", "/api/auth/session", cookie=rotated)[1]["user"], user)
        for obsolete in (first, second):
            self.assertIsNone(self.request("GET", "/api/auth/session", cookie=obsolete)[1]["user"])
            self.assertEqual(self.request("GET", "/api/sync/" + DATASET, cookie=obsolete)[0], 401)
        self.assertEqual(self.request("GET", "/api/sync/" + DATASET, cookie=rotated)[1]["snapshot"], snapshot(12))
        self.assertEqual(self.request("POST", "/api/auth/login", {"username": username, "password": old})[0], 401)
        self.assertEqual(self.request("POST", "/api/auth/login", {"username": username, "password": new})[0], 200)

    def test_session_revocation_is_owned_and_current_session_is_preserved(self):
        username, password, _, first = self.account()
        _, _, headers = self.request("POST", "/api/auth/login", {"username": username, "password": password})
        second = headers["Set-Cookie"]
        *_, stranger = self.account()
        rows = self.request("GET", "/api/account/sessions", cookie=first)[1]["sessions"]
        own_id = next(row["id"] for row in rows if row["current"])
        other_id = next(row["id"] for row in rows if not row["current"])
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke", {"id": own_id}, first)[0], 400)
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke", {"id": other_id}, stranger)[0], 404)
        self.assertIsNotNone(self.request("GET", "/api/auth/session", cookie=second)[1]["user"])
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke", {"id": other_id}, first)[0], 200)
        self.assertIsNone(self.request("GET", "/api/auth/session", cookie=second)[1]["user"])
        self.assertIsNotNone(self.request("GET", "/api/auth/session", cookie=first)[1]["user"])
        _, _, headers = self.request("POST", "/api/auth/login", {"username": username, "password": password})
        third = headers["Set-Cookie"]
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke-others", {}, first)[0], 200)
        self.assertIsNone(self.request("GET", "/api/auth/session", cookie=third)[1]["user"])
        self.assertIsNotNone(self.request("GET", "/api/auth/session", cookie=first)[1]["user"])
        self.assertIsNotNone(self.request("GET", "/api/auth/session", cookie=stranger)[1]["user"])

    def test_account_writes_require_origin_and_are_rate_limited(self):
        server = self.temporary_server(auth_limit=2)
        credentials = {"username": "limited", "password": "correct long password"}
        _, _, headers = self.request("POST", "/api/auth/register", credentials, server=server)
        cookie = headers["Set-Cookie"]
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke-others", {}, cookie, origin=None, server=server)[0], 403)
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke-others", {}, cookie, server=server)[0], 200)
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke-others", {}, cookie, server=server)[0], 200)
        self.assertEqual(self.request("POST", "/api/account/sessions/revoke-others", {}, cookie, server=server)[0], 429)

    def test_legacy_session_schema_migrates_without_invalidating_login(self):
        path = Path(self.directory.name) / (uuid.uuid4().hex + "-legacy.sqlite3")
        token = "legacy-test-session-token"
        hashed = hashlib.sha256(token.encode()).hexdigest()
        expiry = int(time.time()) + 1000
        with sqlite3.connect(path) as db:
            db.executescript("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,created_at INTEGER);"
                             "CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);")
            db.execute("INSERT INTO users VALUES (?,?,?,?)", ("legacy-user", "legacy", password_hash("legacy-long-password"), int(time.time())))
            db.execute("INSERT INTO sessions VALUES (?,?,?)", (hashed, "legacy-user", expiry))
        migrated = Database(path)
        current = migrated.session_for_token(token)
        self.assertEqual(current["id"], "legacy-user")
        rows = migrated.list_sessions(current)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["device"], "旧设备/浏览器")
        self.assertTrue(rows[0]["current"])
        self.assertNotEqual(rows[0]["id"], hashed)
        again = Database(path)
        self.assertEqual(again.list_sessions(again.session_for_token(token))[0]["id"], rows[0]["id"])
        with again.connect() as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)

    def test_old_password_login_in_flight_cannot_survive_password_change(self):
        username, password, user, _ = self.account()
        original = app_module.password_matches
        verified, resume = threading.Event(), threading.Event()

        def paused_match(plain, stored):
            result = original(plain, stored)
            verified.set()
            if not resume.wait(timeout=5):
                raise RuntimeError("test login did not resume")
            return result

        with patch.object(app_module, "password_matches", paused_match):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.request, "POST", "/api/auth/login", {"username": username, "password": password})
                self.assertTrue(verified.wait(timeout=5))
                with self.server.database.connect() as db:
                    db.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash("new replacement password"), user["id"]))
                    db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
                resume.set()
                self.assertEqual(pending.result(timeout=5)[0], 401)
        with self.server.database.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions WHERE user_id=?", (user["id"],)).fetchone()[0], 0)


class SnapshotFeedbackTest(unittest.TestCase):
    def test_legacy_settings_are_accepted_but_not_stored_in_sqlite(self):
        value = snapshot()
        value["settings"]["aiModel"] = "legacy-model-id"
        clean = app_module.validate_snapshot(value, DATASET)
        self.assertNotIn("aiModel", clean["settings"])
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "progress.sqlite3")
            with database.connect() as db:
                db.execute("INSERT INTO users VALUES (?,?,?,?)", ("fixture-user", "fixture-user", "not-an-auth-fixture", 1))
            accepted, result = database.put_snapshot("fixture-user", DATASET, 0, clean, str(uuid.uuid4()))
            self.assertTrue(accepted)
            self.assertNotIn("aiModel", result["snapshot"]["settings"])
            with database.connect() as db:
                stored = json.loads(db.execute("SELECT payload FROM snapshots").fetchone()[0])
            self.assertNotIn("aiModel", stored["settings"])

    def test_feedback_mode_only_accepts_the_three_supported_values(self):
        for mode in ("rules", "manual", "auto"):
            with self.subTest(mode=mode):
                value = snapshot(); value["settings"]["feedbackMode"] = mode
                self.assertEqual(app_module.validate_snapshot(value, DATASET)["settings"]["feedbackMode"], mode)
        for mode in ("unknown", None, 1, {}, []):
            with self.subTest(mode=mode):
                value = snapshot(); value["settings"]["feedbackMode"] = mode
                with self.assertRaises(app_module.ApiError):
                    app_module.validate_snapshot(value, DATASET)

    def test_secrets_are_rejected_even_inside_ordinary_progress_text(self):
        for secret in ("sk-" + "a" * 20, "sk-proj-" + "b" * 24, "xai-" + "c" * 24, "AIza" + "d" * 30, "ghp_" + "e" * 24, "gho_" + "f" * 24, "sk-ant-" + "g" * 24):
            with self.subTest(prefix=secret[:8]):
                value = snapshot(); value["progress"]["readings"] = [{"passage": "Stored text " + secret}]
                with self.assertRaises(app_module.ApiError):
                    app_module.validate_snapshot(value, DATASET)


if __name__ == "__main__":
    unittest.main()
