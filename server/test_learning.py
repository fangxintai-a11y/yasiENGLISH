"""Learning records: disposable SQLite + real loopback HTTP, no production data."""
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import unittest
import uuid

try:
    from . import app
    from . import test_app as app_tests
    from .learning import MAX_PAGE, MAX_WRITE
except ImportError:
    import app
    import test_app as app_tests
    from learning import MAX_PAGE, MAX_WRITE

ORIGIN, snapshot, DATASET = app_tests.ORIGIN, app_tests.snapshot, app_tests.DATASET


def uid():
    return str(uuid.uuid4())


def write(kind, payload, base=None, **extra):
    return {"schemaVersion": 2, "revisionId": uid(), "mutationId": uid(), "baseRevision": base,
            "kind": kind, "payload": payload, **extra}


class LearningTest(unittest.TestCase):
    request = app_tests.ServerTest.request
    account = app_tests.ServerTest.account

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="band-learning-test-")
        cls.db_path = str(Path(cls.directory.name) / "test.sqlite3")
        cls.server = app.create_server(port=0, db_path=cls.db_path, public_origin=ORIGIN, max_accounts=1000, auth_limit=10000)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=5)
        cls.directory.cleanup()

    def plan(self, cookie, dataset=DATASET):
        plan = uid()
        body = write("plan", {"planId": plan, "datasetId": dataset, "startDate": "2026-11-03", "timeZone": "Asia/Shanghai",
                              "studyBudgetMinutes": 120, "targetBand": 8, "sectionTargets": {"listening": 8.5, "reading": 8.5, "writing": 7.5, "speaking": 7.5}, "enabled": True, "curriculumVersion": "1"})
        status, result, _ = self.put(cookie, plan, body)
        self.assertEqual(status, 200, result)
        return plan, result["record"]

    def put(self, cookie, record_id, body, **kwargs):
        return self.request("PUT", "/api/learning/v2/records/" + record_id, body, cookie, **kwargs)

    def essay(self, plan, text="A first draft."):
        return write("essay", {"planId": plan, "text": text, "taskType": "task2", "day": 1, "prompt": "Describe your day."})

    def changes(self, cookie, after=0, limit=100):
        return self.request("GET", f"/api/learning/v2/changes?after={after}&limit={limit}", cookie=cookie)

    def test_capabilities_health_and_user_cookie_required(self):
        status, data, headers = self.request("GET", "/api/capabilities")
        self.assertEqual((status, data), (200, {"vocabSnapshot": 2, "learningRecords": 2, "learningWriteEnabled": True}))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/api/health")[:2], (200, {"ok": True}))
        self.assertEqual(self.request("GET", "/api/learning/v2/changes")[0], 401)
        self.assertEqual(self.put(None, uid(), self.essay(uid()))[0], 401)

    def test_private_records_and_header_account_race(self):
        _, _, alice, alice_cookie = self.account()
        _, _, bob, bob_cookie = self.account()
        plan, _ = self.plan(alice_cookie)
        record_id, body = uid(), self.essay(plan)
        self.assertEqual(self.put(alice_cookie, record_id, body)[0], 200)
        self.assertEqual(self.changes(bob_cookie)[1]["items"], [])
        self.assertEqual(self.request("GET", f"/api/learning/v2/records/{record_id}/revisions", cookie=bob_cookie)[1]["items"], [])
        status, error, _ = self.put(bob_cookie, uid(), write("plan", {"startDate": "2026-11-03", "studyBudgetMinutes": 120}), headers={"X-Learning-User": alice["id"]})
        self.assertEqual((status, error["code"]), (403, "account_changed"))
        self.assertEqual(self.changes(bob_cookie)[1]["items"], [])
        self.assertEqual(self.request("GET", "/api/learning/v2/changes", cookie=alice_cookie, headers={"X-Learning-User": bob["id"]})[0], 403)

    def test_cas_conflict_keeps_both_drafts_and_allows_explicit_resolution(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        record_id = uid()
        first = self.put(cookie, record_id, self.essay(plan))[1]["record"]
        phone = self.essay(plan, "Phone changed paragraph one."); phone["baseRevision"] = first["revisionId"]
        desktop = self.essay(plan, "Desktop changed paragraph two."); desktop["baseRevision"] = first["revisionId"]
        self.assertEqual(self.put(cookie, record_id, phone)[0], 200)
        status, conflict, _ = self.put(cookie, record_id, desktop)
        self.assertEqual(status, 409)
        self.assertEqual(conflict["record"]["payload"]["text"], phone["payload"]["text"])
        self.assertEqual(conflict["conflict"]["revisionId"], desktop["revisionId"])
        self.assertTrue(conflict["conflict"]["conflict"])
        revisions = self.request("GET", f"/api/learning/v2/records/{record_id}/revisions", cookie=cookie)[1]["items"]
        self.assertEqual(len(revisions), 3)
        merged = self.essay(plan, "Phone first paragraph and desktop second paragraph.")
        merged["baseRevision"] = phone["revisionId"]
        self.assertEqual(self.put(cookie, record_id, merged)[0], 200)
        self.assertEqual(len(self.request("GET", f"/api/learning/v2/records/{record_id}/revisions", cookie=cookie)[1]["items"]), 4)

    def test_concurrent_writers_only_one_becomes_head(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        record_id = uid(); first = self.put(cookie, record_id, self.essay(plan))[1]["record"]
        barrier = threading.Barrier(2)
        def attempt(text):
            value = self.essay(plan, text); value["baseRevision"] = first["revisionId"]
            barrier.wait(timeout=5)
            return self.put(cookie, record_id, value)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(attempt, ("Phone", "Desktop")))
        self.assertEqual(sorted(x[0] for x in responses), [200, 409])
        self.assertEqual(len(self.request("GET", f"/api/learning/v2/records/{record_id}/revisions", cookie=cookie)[1]["items"]), 3)

    def test_idempotent_lost_responses_and_fingerprint_validation(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        record_id, first = uid(), self.essay(plan)
        accepted = self.put(cookie, record_id, first)
        newer = self.essay(plan, "Newer text"); newer["baseRevision"] = first["revisionId"]
        self.assertEqual(self.put(cookie, record_id, newer)[0], 200)
        self.assertEqual(self.put(cookie, record_id, first)[:2], accepted[:2])
        changed = copy.deepcopy(first); changed["payload"]["text"] = "Different payload"
        self.assertEqual(self.put(cookie, record_id, changed)[0], 400)
        first["mutationId"] = uid()
        self.assertEqual(self.put(cookie, record_id, first)[0], 400)
        stale = self.essay(plan, "Retriable conflict"); stale["baseRevision"] = first["revisionId"]
        response = self.put(cookie, record_id, stale)
        self.assertEqual(response[0], 409)
        self.assertEqual(self.put(cookie, record_id, stale)[:2], response[:2])
        self.assertEqual(len(self.request("GET", f"/api/learning/v2/records/{record_id}/revisions", cookie=cookie)[1]["items"]), 3)

    def test_dependencies_and_feedback_binding(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        missing = self.essay(uid())
        self.assertEqual(self.put(cookie, uid(), missing)[0], 422)
        record_id, essay = uid(), self.essay(plan, "My original text.\nNo normalization.")
        self.assertEqual(self.put(cookie, record_id, essay)[0], 200)
        digest = hashlib.sha256(essay["payload"]["text"].encode()).hexdigest()
        payload = {"planId": plan, "workId": record_id, "workRevisionId": essay["revisionId"], "inputHash": digest, "rubricVersion": "1", "source": "human", "text": "Clear main point."}
        self.assertEqual(self.put(cookie, uid(), write("feedback", payload))[0], 200)
        payload["inputHash"] = "0" * 64
        self.assertEqual(self.put(cookie, uid(), write("feedback", payload))[0], 400)
        *_, other = self.account(); other_plan, _ = self.plan(other)
        payload.update(planId=other_plan, inputHash=digest)
        self.assertEqual(self.put(other, uid(), write("feedback", payload))[0], 422)
        new_plan, _ = self.plan(cookie)
        payload["planId"] = new_plan
        self.assertEqual(self.put(cookie, uid(), write("feedback", payload))[0], 422)

    def test_pagination_never_skips_midstream_changes_and_deletions(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        record_id, essay = uid(), self.essay(plan)
        self.put(cookie, record_id, essay)
        first = self.changes(cookie, limit=1)[1]
        self.assertTrue(first["hasMore"])
        changed = self.essay(plan, "Changed during pagination."); changed["baseRevision"] = essay["revisionId"]
        self.put(cookie, record_id, changed)
        deletion = write("essay", {}, changed["revisionId"], deleted=True)
        self.put(cookie, record_id, deletion)
        cursor, rows = first["nextCursor"], list(first["items"])
        while True:
            page = self.changes(cookie, cursor, 1)[1]
            self.assertEqual(self.changes(cookie, cursor, 1)[1], page)
            rows += page["items"]; cursor = page["nextCursor"]
            if not page["hasMore"]: break
        self.assertEqual(len(rows), 4)
        self.assertTrue(rows[-1]["deleted"])
        self.assertEqual(self.changes(cookie, cursor)[1], {"items": [], "nextCursor": cursor, "hasMore": False})
        resurrection = self.essay(plan, "Offline stale resurrection."); resurrection["baseRevision"] = essay["revisionId"]
        self.assertEqual(self.put(cookie, record_id, resurrection)[0], 409)
        head = self.request("GET", f"/api/learning/v2/records?kind=essay&planId={plan}", cookie=cookie)[1]["items"][0]
        self.assertTrue(head["deleted"])

    def test_page_byte_ceiling_and_cursor_at_actual_returned_row(self):
        _, _, user, cookie = self.account(); plan, _ = self.plan(cookie)
        for _ in range(20):
            status, _ = self.server.learning.put(user["id"], uid(), self.essay(plan, "学" * 20000))
            self.assertEqual(status, 200)
        page = self.changes(cookie)[1]
        self.assertTrue(page["hasMore"])
        self.assertLessEqual(len(json.dumps(page, ensure_ascii=False, separators=(",", ":")).encode()), MAX_PAGE)
        self.assertEqual(page["nextCursor"], page["items"][-1]["seq"])
        rest = self.changes(cookie, page["nextCursor"])[1]
        self.assertEqual(len(page["items"]) + len(rest["items"]), 21)

    def test_schema_invalid_dates_secrets_payload_limits_and_origin(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        bad = [write("invalid", {}), write("essay", {"planId": plan, "text": "x", "apiKey": "secret"}),
               write("plan", {"startDate": "2026-02-30", "studyBudgetMinutes": 150}),
               write("attempt", {"planId": plan, "contentId": "sample", "skill": "reading", "answers": [], "correct": 4, "total": 3}),
               write("essay", {"planId": plan, "text": "x" * 20001}),
               write("essay", {"planId": plan, "text": "sk-ant-1234567890abcdef"}),
               write("essay", {"planId": plan, "text": "unpaired unicode: \ud800"}),
               write([], {})]
        for value in bad:
            with self.subTest(value=value["kind"]): self.assertEqual(self.put(cookie, uid(), value)[0], 400)
        self.assertEqual(self.put(cookie, uid(), self.essay(plan), origin="https://evil.example")[0], 403)
        self.assertEqual(self.put(cookie, uid(), self.essay(plan), headers={"Content-Length": str(MAX_WRITE + 1)})[0], 413)
        for query in ["after=-1", "limit=0", "limit=101", "after=1&after=2", "kind=not-real"]:
            self.assertEqual(self.request("GET", "/api/learning/v2/changes?" + query, cookie=cookie)[0], 400)

    def test_all_record_kinds_retain_exact_payload_and_custom_dataset(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie, "custom-dataset")
        cases = [
            ("mission", {"planId": plan, "day": 1, "missionId": "day1:reading", "status": "partial", "actualMinutes": 12}),
            ("attempt", {"planId": plan, "day": 1, "contentId": "reading-1", "skill": "reading", "answers": [1, "word", None], "correct": 2, "total": 3, "conditions": {"replays": 0, "transcriptViewed": False}, "isCheckpoint": True}),
            ("speaking", {"planId": plan, "transcript": "My home.", "durationSeconds": 12, "recordingId": "local-1", "day": 1}),
            ("assessment", {"planId": plan, "kind": "baseline", "day": 7, "source": "self", "scores": {"reading": None}, "notes": "Only a short passage, not a band score."}),
        ]
        for kind, payload in cases:
            with self.subTest(kind=kind):
                payload["datasetId"] = "custom-dataset"
                status, body, headers = self.put(cookie, uid(), write(kind, payload))
                self.assertEqual(status, 200, body)
                self.assertEqual(body["record"]["payload"], payload)
                self.assertEqual(body["record"]["datasetId"], "custom-dataset")
                self.assertEqual(headers["Cache-Control"], "no-store")

    def test_legacy_snapshot_migration_reentry_backup_and_write_switch(self):
        _, _, user, cookie = self.account(); plan, _ = self.plan(cookie)
        self.put(cookie, uid(), self.essay(plan))
        for count in (1, 2):
            self.assertEqual(self.request("PUT", "/api/sync/" + DATASET, {"revision": count - 1, "snapshot": snapshot(count), "commitId": uid()}, cookie)[0], 200)
        reopened = app.Database(self.db_path)
        again = app.learning_module.LearningStore(reopened)
        self.assertEqual(len(again.list(user["id"])["items"]), 2)
        with reopened.connect() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_schema_migrations").fetchone()[0], 2)
        backup = Path(self.directory.name) / (uid() + ".sqlite3")
        reopened.backup(backup)
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_records WHERE user_id=?", (user["id"],)).fetchone()[0], 2)
        self.server.learning_write_enabled = False
        try:
            self.assertFalse(self.request("GET", "/api/capabilities")[1]["learningWriteEnabled"])
            self.assertEqual(self.put(cookie, uid(), self.essay(plan))[0], 503)
            self.assertEqual(len(self.changes(cookie)[1]["items"]), 2)
        finally:
            self.server.learning_write_enabled = True

    def test_installed_api_artifact_imports_without_source_directory(self):
        with tempfile.TemporaryDirectory(prefix="band-api-artifact-") as directory:
            directory = Path(directory)
            for name in json.loads(Path(app.__file__).with_name("runtime-files.json").read_text()):
                shutil.copyfile(Path(app.__file__).with_name(name), directory / name)
            spec = importlib.util.spec_from_file_location("isolated_band_candidate", directory / "app.py")
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            server = module.create_server(port=0, db_path=directory / "candidate.sqlite3", public_origin=ORIGIN)
            try:
                self.assertEqual(server.learning.list("missing-user"), {"items": [], "nextCursor": 0, "hasMore": False})
            finally:
                server.server_close()

    def test_feedback_task_type_is_checked_against_original_revision(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        original = self.essay(plan); original["payload"]["taskType"] = "task1"
        record_id = uid()
        self.assertEqual(self.put(cookie, record_id, original)[0], 200)
        payload = {"planId": plan, "workId": record_id, "workRevisionId": original["revisionId"],
                   "inputHash": app.learning_module.content_hash("essay", original["payload"]), "source": "human", "text": "A clear overview.",
                   "taskType": "task1", "bands": {"taskAchievement": 7, "coherence": 7, "lexical": 7, "grammar": 7}}
        self.assertEqual(self.put(cookie, uid(), write("feedback", payload))[0], 200)
        # Self-reporting a different task type cannot bypass the real original.
        changed = {**payload, "taskType": "task2", "bands": {"taskResponse": 7, "coherence": 7, "lexical": 7, "grammar": 7}}
        status, error, _ = self.put(cookie, uid(), write("feedback", changed))
        self.assertEqual(status, 400)
        self.assertIn("原稿", error["error"])

    def test_weekly_calibration_sources_are_separate_records(self):
        *_, cookie = self.account(); plan, _ = self.plan(cookie)
        original = self.essay(plan); record_id = uid()
        self.assertEqual(self.put(cookie, record_id, original)[0], 200)
        for source in ("ai", "human"):
            payload = {"planId": plan, "kind": "weekly-calibration", "source": source, "weekIndex": 1,
                       "workRevisionId": original["revisionId"], "taskType": "task2",
                       "bands": {"taskResponse": 7, "coherence": 7, "lexical": 7, "grammar": 7}}
            self.assertEqual(self.put(cookie, uid(), write("assessment", payload))[0], 200)
        rows = self.request("GET", "/api/learning/v2/records?kind=assessment", cookie=cookie)[1]["items"]
        self.assertEqual({row["payload"]["source"] for row in rows}, {"ai", "human"})

    def test_legacy_learning_client_gets_upgrade_status_without_writing(self):
        *_, cookie = self.account()
        self.assertEqual(self.request("GET", "/api/learning/v1/changes", cookie=cookie)[0], 426)
        record_id = uid()
        body = write("plan", {"planId": record_id, "startDate": "2026-11-03", "studyBudgetMinutes": 120,
                              "targetBand": 8, "sectionTargets": {"listening": 8.5, "reading": 8.5, "writing": 7.5, "speaking": 7.5}})
        status, result, _ = self.request("PUT", "/api/learning/v1/records/" + record_id, body, cookie)
        self.assertEqual((status, result["code"]), (426, "unsupported_learning_protocol"))
        self.assertEqual(self.changes(cookie)[1]["items"], [])


if __name__ == "__main__":
    unittest.main()
