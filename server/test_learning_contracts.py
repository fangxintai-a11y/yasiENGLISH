"""P1 contract corrections: strict new writes, preserved historical revisions and receipts."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

try:
    from . import app
    from .learning import LearningError, LearningStore, content_hash, encoded, validate_payload
except ImportError:
    import app
    from learning import LearningError, LearningStore, content_hash, encoded, validate_payload

TARGETS = {"listening": 8.5, "reading": 8.5, "writing": 7.5, "speaking": 7.5}
SCOPE = {"datasetId": "atlas-a", "planId": "plan-one"}
REV = "11111111-1111-4111-8111-111111111111"

def plan():
    return {**SCOPE, "startDate": "2026-11-03", "studyBudgetMinutes": 120, "targetBand": 8, "sectionTargets": dict(TARGETS)}

def request(kind, payload, index):
    return {"schemaVersion": 2, "revisionId": f"10000000-0000-4000-8000-{index:012d}", "mutationId": f"20000000-0000-4000-8000-{index:012d}", "baseRevision": None, "kind": kind, "payload": payload}

class LearningContractTest(unittest.TestCase):
    def rejects(self, kind, payload, message):
        with self.assertRaisesRegex(LearningError, message):
            validate_payload(kind, payload, "plan-one" if kind == "plan" else "record-one")

    def test_plan_requires_band8_section_targets_and_120_minutes(self):
        missing = plan(); del missing["sectionTargets"]
        cases = [
            ("missing sectionTargets", missing, "四科目标"),
            ("target below 8", {**plan(), "targetBand": 7.5}, r"项目目标固定为雅思总分8\.0"),
            ("150 minute budget", {**plan(), "studyBudgetMinutes": 150}, "每日学习时长固定为 120 分钟"),
            ("180 minute budget", {**plan(), "studyBudgetMinutes": 180}, "每日学习时长固定为 120 分钟"),
            ("retired sectionMinimum field", {**plan(), "sectionMinimum": 6.5}, "字段"),
        ]
        for name, payload, message in cases:
            with self.subTest(condition=name):
                self.rejects("plan", payload, message)
        with self.subTest(condition="valid fixed plan"):
            validate_payload("plan", plan(), "plan-one")

    def test_gate_record_validation(self):
        gate = {**SCOPE, "kind": "gate", "source": "human", "gateId": "G3", "date": "2027-09-03", "consecutiveIndex": 1,
                "targets": {"overall": 7.5, "listening": 8, "reading": 8, "writing": 7, "speaking": 7},
                "scores": {"listening": 8, "reading": 8, "writing": 7, "speaking": 7},
                "scoreSources": {"listening": "rules", "reading": "rules", "writing": "human", "speaking": "human"}}
        with self.subTest(condition="valid dated G3"):
            validate_payload("assessment", gate, "gate-one")
        missing = dict(gate); del missing["date"]
        cases = [
            ("missing date", missing, "日期"),
            ("G2 with G3 target values", {**gate, "gateId": "G2"}, "门槛目标"),
            ("AI writing source", {**gate, "scoreSources": {**gate["scoreSources"], "writing": "ai"}}, "真人"),
        ]
        for name, payload, message in cases:
            with self.subTest(condition=name):
                self.rejects("assessment", payload, message)

    def test_task1_uses_taskachievement_and_task2_uses_taskresponse(self):
        feedback = {**SCOPE, "workRevisionId": REV, "inputHash": "a"*64, "source": "human", "text": "Comments", "taskType": "task1", "bands": {"taskAchievement": 7, "coherence": 7, "lexical": 7, "grammar": 7}}
        with self.subTest(condition="explicit Task 1 essay"):
            validate_payload("essay", {**SCOPE, "taskType": "task1", "text": "Original."}, "essay-one")
        with self.subTest(condition="Task Achievement accepted for Task 1"):
            validate_payload("feedback", feedback, "feedback-one")
        with self.subTest(condition="Task Response rejected for Task 1"):
            self.rejects("feedback", {**feedback, "bands": {"taskResponse": 7}}, "Task 1")
        with self.subTest(condition="Task Achievement rejected for Task 2"):
            self.rejects("feedback", {**feedback, "taskType": "task2"}, "Task 2")

    def test_error_causes_must_be_enumerated_codes(self):
        attempt = {**SCOPE, "contentId": "reading-one", "skill": "reading", "answers": ["a"], "questionResults": [{"questionId": "q1", "correct": False, "confidence": "sure", "errorCause": "synonym-miss"}]}
        with self.subTest(condition="enumerated synonym miss cause"):
            validate_payload("attempt", attempt, "attempt-one")
        with self.subTest(condition="free text cause"):
            self.rejects("attempt", {**attempt, "questionResults": [{**attempt["questionResults"][0], "errorCause": "听错了"}]}, "错因")
        with self.subTest(condition="other without explanation"):
            self.rejects("attempt", {**attempt, "questionResults": [{**attempt["questionResults"][0], "errorCause": "other"}]}, "说明")

    def test_weekly_calibration_is_distinguishable_from_ai_and_self_scores(self):
        with self.subTest(condition="unrecognised teacher source"):
            self.rejects("feedback", {**SCOPE, "workRevisionId": REV, "inputHash": "a"*64, "source": "teacher", "text": "Comments"}, "来源")
        weekly = {**SCOPE, "kind": "weekly-calibration", "source": "human", "weekIndex": 1, "workRevisionId": REV, "taskType": "task2", "bands": {"taskResponse": 7, "coherence": 7, "lexical": 7, "grammar": 7}}
        with self.subTest(condition="week 53"):
            self.rejects("assessment", {**weekly, "weekIndex": 53}, "周")
        for source in ("ai", "human"):
            with self.subTest(condition="separate source result", source=source):
                validate_payload("assessment", {**weekly, "source": source}, "weekly-one")

    def test_gate_null_scores_and_sources_are_paired(self):
        gate = {**SCOPE, "kind": "gate", "source": "human", "gateId": "G3", "date": "2027-09-03", "consecutiveIndex": 2,
                "targets": {"overall": 7.5, "listening": 8, "reading": 8, "writing": 7, "speaking": 7},
                "scores": {"listening": 8, "reading": 8, "writing": None, "speaking": 7},
                "scoreSources": {"listening": "rules", "reading": "rules", "writing": None, "speaking": "human"}}
        with self.subTest(condition="unknown score with null source"):
            validate_payload("assessment", gate, "gate-one")
        with self.subTest(condition="unknown score with invented human source"):
            self.rejects("assessment", {**gate, "scoreSources": {**gate["scoreSources"], "writing": "human"}}, "分数与来源")
        with self.subTest(condition="known score without source"):
            self.rejects("assessment", {**gate, "scores": {**gate["scores"], "writing": 7}}, "分数与来源")

    def test_g4_requires_official_sources_but_does_not_invent_missing_scores(self):
        gate = {**SCOPE, "kind": "gate", "source": "official", "gateId": "G4", "date": "2027-11-03",
                "targets": {"overall": 8, **TARGETS}, "scores": dict(TARGETS),
                "scoreSources": {key: "official" for key in TARGETS}}
        with self.subTest(condition="complete official evidence"):
            validate_payload("assessment", gate, "gate-four")
        with self.subTest(condition="overall human source"):
            self.rejects("assessment", {**gate, "source": "human"}, "G4.*正式")
        with self.subTest(condition="listening rules source"):
            self.rejects("assessment", {**gate, "scoreSources": {**gate["scoreSources"], "listening": "rules"}}, "G4.*正式")
        with self.subTest(condition="unknown section stays null"):
            validate_payload("assessment", {**gate, "scores": {**gate["scores"], "writing": None}, "scoreSources": {**gate["scoreSources"], "writing": None}}, "gate-four")


class LearningMigrationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="band-learning-v2-")
        self.path = Path(self.directory.name) / "test.sqlite3"
        self.database = app.Database(self.path)
        with self.database.connect() as db:
            db.execute("INSERT INTO users VALUES(?,?,?,?)", ("user-one", "fixture-user", "unused-fixture-hash", 1))

    def tearDown(self):
        self.directory.cleanup()

    def legacy_database(self):
        """Create the exact v1 tables without invoking today's migration code."""
        payloads = [
            ("plan-one", "plan", {"planId": "plan-one", "datasetId": "atlas-a", "startDate": "2026-11-03", "studyBudgetMinutes": 150, "targetBand": 7, "sectionMinimum": 6.5}),
            ("essay-old", "essay", {"planId": "plan-one", "text": "Original legacy essay.\nUnclassified, not presumed Task 2."}),
        ]
        old = []
        with self.database.connect() as db:
            db.executescript("""
                CREATE TABLE learning_schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
                INSERT INTO learning_schema_migrations VALUES(1,1);
                CREATE TABLE learning_records(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,kind TEXT NOT NULL,dataset_id TEXT NOT NULL,plan_id TEXT,current_revision_id TEXT,deleted_at INTEGER,PRIMARY KEY(user_id,id));
                CREATE TABLE learning_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,revision_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,record_id TEXT NOT NULL,base_revision_id TEXT,payload TEXT NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL,conflict INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,revision_id),FOREIGN KEY(user_id,record_id) REFERENCES learning_records(user_id,id) ON DELETE CASCADE);
                CREATE TABLE learning_mutation_receipts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,mutation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status INTEGER NOT NULL,response TEXT NOT NULL,PRIMARY KEY(user_id,mutation_id));
                CREATE INDEX custom_record_source ON learning_records(user_id,dataset_id);
            """)
            for index, (record_id, kind, payload) in enumerate(payloads, 21):
                body = request(kind, payload, index); body["schemaVersion"] = 1
                digest = content_hash(kind, payload)
                db.execute("INSERT INTO learning_records VALUES(?,?,?,?,?,?,?)", ("user-one", record_id, kind, "atlas-a", "plan-one", body["revisionId"], None))
                cursor = db.execute("INSERT INTO learning_revisions(revision_id,user_id,record_id,payload,content_hash,created_at) VALUES(?,?,?,?,?,?)", (body["revisionId"], "user-one", record_id, encoded(payload), digest, 1))
                record = {"id": record_id, "kind": kind, "datasetId": "atlas-a", "planId": "plan-one", "revisionId": body["revisionId"], "baseRevision": None, "seq": cursor.lastrowid, "payload": payload, "contentHash": digest, "createdAt": 1, "conflict": False, "deleted": False}
                fingerprint = hashlib.sha256((record_id + "\n" + encoded(body)).encode()).hexdigest()
                db.execute("INSERT INTO learning_mutation_receipts VALUES(?,?,?,?,?)", ("user-one", body["mutationId"], fingerprint, 200, encoded({"record": record, "applied": True})))
                old.append({"recordId": record_id, "request": body, "record": record})
        return old

    def test_records_survive_dataset_switch_and_migration_v2(self):
        import sqlite3
        old = self.legacy_database()
        store = LearningStore(self.database)
        backup = Path(store.migration_backup_path)
        self.assertTrue(backup.is_file())
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("SELECT MAX(version) FROM learning_schema_migrations").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_revisions").fetchone()[0], 2)
        with self.database.connect() as db:
            columns = {row["name"]: row for row in db.execute("PRAGMA table_info(learning_records)")}
            self.assertEqual(columns["dataset_id"]["notnull"], 0)
            self.assertEqual(db.execute("SELECT MAX(version) FROM learning_schema_migrations").fetchone()[0], 2)
            self.assertIsNotNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='custom_record_source'").fetchone())
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            for item in old:
                actual = store.item(db, "user-one", item["request"]["revisionId"])
                self.assertEqual(actual["payload"], item["record"]["payload"])
                self.assertEqual(actual["contentHash"], item["record"]["contentHash"])
                self.assertEqual(actual["payloadVersion"], 1)
                self.assertNotIn("taskType", actual["payload"])
        # Each revision retains the bank used at the time, but the plan is account-wide.
        body = request("essay", {**SCOPE, "datasetId": "atlas-b", "taskType": "task1", "text": "A graph description."}, 31)
        status, first = store.put("user-one", "essay-new", body)
        self.assertEqual(status, 200)
        second = request("essay", {**body["payload"], "datasetId": "atlas-c", "text": "A revised graph description."}, 32)
        second["baseRevision"] = first["record"]["revisionId"]
        self.assertEqual(store.put("user-one", "essay-new", second)[0], 200)
        with self.database.connect() as db:
            self.assertEqual(store.item(db, "user-one", body["revisionId"])["datasetId"], "atlas-b")
            self.assertEqual(store.item(db, "user-one", second["revisionId"])["datasetId"], "atlas-c")
        self.assertEqual(len(store.list("user-one")["items"]), 4)
        again = LearningStore(app.Database(self.path))
        self.assertIsNone(again.migration_backup_path)
        self.assertEqual(len(again.list("user-one")["items"]), 4)

    def test_old_applied_mutations_replay_before_new_strict_validation(self):
        old = self.legacy_database()
        store = LearningStore(self.database)
        for item in old:
            status, result = store.put("user-one", item["recordId"], item["request"])
            self.assertEqual(status, 200)
            self.assertEqual(result["record"]["payload"], item["record"]["payload"])
            self.assertEqual(result["record"]["contentHash"], item["record"]["contentHash"])
            changed = copy.deepcopy(item["request"])
            changed["payload"]["date"] = "2026-11-04"
            with self.assertRaisesRegex(LearningError, "同一提交"):
                store.put("user-one", item["recordId"], changed)
        with self.database.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_revisions").fetchone()[0], 2)
            self.assertNotIn("response", {row["name"] for row in db.execute("PRAGMA table_info(learning_mutation_receipts)")})

    def test_receipt_does_not_duplicate_payload(self):
        store = LearningStore(self.database)
        store.put("user-one", "plan-one", request("plan", plan(), 1))
        text = "An original essay which must only live in its revision payload."
        body = request("essay", {**SCOPE, "taskType": "task2", "text": text}, 2)
        accepted = store.put("user-one", "essay-one", body)
        with self.database.connect() as db:
            row = db.execute("SELECT * FROM learning_mutation_receipts WHERE mutation_id=?", (body["mutationId"],)).fetchone()
            self.assertEqual(set(row.keys()), {"user_id", "mutation_id", "fingerprint", "status", "revision_id", "conflict_revision_id"})
            self.assertNotIn(text, json.dumps(dict(row)))
        self.assertEqual(store.put("user-one", "essay-one", body), accepted)

    def test_v1_conflict_receipt_replays_both_frozen_revisions_after_a_new_head(self):
        old = self.legacy_database()
        original = old[1]["record"]
        body = request("essay", {"planId": "plan-one", "text": "An old offline conflicting draft."}, 24)
        body["schemaVersion"] = 1; body["baseRevision"] = original["revisionId"]
        incoming = {**original, "revisionId": body["revisionId"], "baseRevision": original["revisionId"], "payload": body["payload"], "contentHash": content_hash("essay", body["payload"]), "conflict": True}
        with self.database.connect() as db:
            cursor = db.execute("INSERT INTO learning_revisions(revision_id,user_id,record_id,base_revision_id,payload,content_hash,created_at,conflict) VALUES(?,?,?,?,?,?,?,?)", (body["revisionId"], "user-one", "essay-old", body["baseRevision"], encoded(body["payload"]), incoming["contentHash"], 2, 1))
            incoming["seq"] = cursor.lastrowid
            response = {"error": "手机和电脑各有修改，两份均已保存。", "code": "revision_conflict", "record": original, "conflict": incoming, "applied": False}
            fingerprint = hashlib.sha256(("essay-old\n" + encoded(body)).encode()).hexdigest()
            db.execute("INSERT INTO learning_mutation_receipts VALUES(?,?,?,?,?)", ("user-one", body["mutationId"], fingerprint, 409, encoded(response)))
        store = LearningStore(self.database)
        next_body = request("essay", {**SCOPE, "taskType": "task2", "text": "A later new-protocol draft."}, 25)
        next_body["baseRevision"] = original["revisionId"]
        self.assertEqual(store.put("user-one", "essay-old", next_body)[0], 200)
        status, replay = store.put("user-one", "essay-old", body)
        self.assertEqual(status, 409)
        self.assertEqual(replay["record"]["payload"], original["payload"])
        self.assertEqual(replay["conflict"]["payload"], incoming["payload"])
        self.assertEqual(replay["conflict"]["contentHash"], incoming["contentHash"])

    def test_migration_failure_rolls_back_schema_and_retains_backup(self):
        from unittest.mock import patch
        old = self.legacy_database()
        original = LearningStore._migrate_v2
        def fail_after_copy(db):
            original(db)
            raise RuntimeError("injected migration failure")
        with patch.object(LearningStore, "_migrate_v2", staticmethod(fail_after_copy)):
            with self.assertRaisesRegex(RuntimeError, "injected"):
                LearningStore(self.database)
        self.assertEqual(len(list(self.path.parent.glob("*.learning-v1-backup-*.sqlite3"))), 1)
        with self.database.connect() as db:
            self.assertEqual(db.execute("SELECT MAX(version) FROM learning_schema_migrations").fetchone()[0], 1)
            self.assertIn("response", {row["name"] for row in db.execute("PRAGMA table_info(learning_mutation_receipts)")})
            self.assertNotIn("payload_version", {row["name"] for row in db.execute("PRAGMA table_info(learning_revisions)")})
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_revisions").fetchone()[0], len(old))


if __name__ == "__main__":
    unittest.main()
