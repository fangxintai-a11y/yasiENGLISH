"""One synthetic v2 wire fixture interoperates with TypeScript and real SQLite."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

try:
    from .app import Database
    from .learning import GATE_TARGETS, SECTION_TARGETS, LearningError, LearningStore, content_hash, validate_payload
except ImportError:
    from app import Database
    from learning import GATE_TARGETS, SECTION_TARGETS, LearningError, LearningStore, content_hash, validate_payload

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "src/study365/fixtures/r0-records.json").read_text())


def fixture(record_id):
    return next(item for item in FIXTURE["records"] if item["recordId"] == record_id)


class R0ContractTest(unittest.TestCase):
    def test_shared_payloads_and_hashes_match_the_python_v2_contract(self):
        self.assertEqual(FIXTURE["fixtureVersion"], 2)
        self.assertEqual(FIXTURE["purpose"], "synthetic-wire-examples-not-user-learning-records")
        for item in FIXTURE["records"]:
            request = item["request"]
            with self.subTest(record=item["recordId"]):
                self.assertEqual(request["schemaVersion"], 2)
                validate_payload(request["kind"], request["payload"], item["recordId"])
                self.assertEqual(content_hash(request["kind"], request["payload"]), item["expectedContentHash"])

    def test_plan_section_targets_and_taskachievement_are_accepted(self):
        plan = fixture("r0-plan-band8")["request"]["payload"]
        self.assertEqual(plan["targetBand"], 8)
        self.assertEqual(plan["sectionTargets"], SECTION_TARGETS)
        self.assertEqual(plan["studyBudgetMinutes"], 120)
        self.assertNotIn("sectionMinimum", plan)
        validate_payload("plan", plan, "r0-plan-band8")
        task1 = fixture("r0-feedback-task1")["request"]["payload"]
        self.assertEqual(task1["taskType"], "task1")
        self.assertIn("taskAchievement", task1["bands"])
        validate_payload("feedback", task1, "r0-feedback-task1")

    def test_all_seven_kinds_round_trip_through_reopened_disposable_sqlite(self):
        with tempfile.TemporaryDirectory(prefix="band-r0-contract-") as directory:
            database = Database(Path(directory) / "fixtures.sqlite3")
            with database.connect() as db:
                db.execute("INSERT INTO users VALUES(?,?,?,?)", ("r0-test-user", "r0-contract-user", "unused-test-hash", 1))
            store = LearningStore(database)
            for item in FIXTURE["records"]:
                with self.subTest(record=item["recordId"]):
                    status, result = store.put("r0-test-user", item["recordId"], item["request"])
                    self.assertEqual(status, 200, result)
                    self.assertEqual(result["record"]["payloadVersion"], 2)
                    self.assertEqual(result["record"]["contentHash"], item["expectedContentHash"])
                    self.assertEqual(result["record"]["payload"], item["request"]["payload"])
                    self.assertEqual(store.put("r0-test-user", item["recordId"], item["request"]), (status, result))
            reopened = LearningStore(Database(database.path))
            actual = {item["id"]: item for item in reopened.list("r0-test-user", current=True)["items"]}
            self.assertEqual(set(actual), {item["recordId"] for item in FIXTURE["records"]})
            for item in FIXTURE["records"]:
                with self.subTest(reopened_record=item["recordId"]):
                    self.assertEqual(actual[item["recordId"]]["payload"], item["request"]["payload"])
            with reopened.database.connect() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM learning_revisions").fetchone()[0], len(FIXTURE["records"]))
                self.assertEqual(db.execute("SELECT count(*) FROM snapshots").fetchone()[0], 0)

    def test_gate_targets_and_calibration_sources_survive_round_trip(self):
        gates = [item["request"]["payload"] for item in FIXTURE["records"] if item["request"]["payload"].get("kind") == "gate"]
        self.assertEqual(sorted(value["gateId"] for value in gates), ["G1", "G2", "G3", "G3", "G4"])
        for value in gates:
            with self.subTest(gate=value["gateId"], date=value["date"]):
                self.assertEqual(value["targets"], GATE_TARGETS[value["gateId"]])
                validate_payload("assessment", value, "gate-fixture")
        weekly = [item["request"]["payload"] for item in FIXTURE["records"] if item["request"]["payload"].get("kind") == "weekly-calibration"]
        writing = [value for value in weekly if value["workId"] == "r0-essay-writing"]
        self.assertEqual(sorted(value["source"] for value in writing), ["ai", "human", "self"])
        for value in weekly:
            work = fixture(value["workId"])
            with self.subTest(calibration=value["source"], work=value["workId"]):
                self.assertEqual(value["workRevisionId"], work["request"]["revisionId"])
                self.assertEqual(value["inputHash"], work["expectedContentHash"])

    def test_independent_invalid_fields_report_their_specific_contract_error(self):
        cases = [
            ("r0-plan-band8", "missing sectionTargets", lambda p: p.pop("sectionTargets"), "四科目标"),
            ("r0-plan-band8", "sectionTargets.writing", lambda p: p["sectionTargets"].update(writing=7), "四科目标"),
            ("r0-plan-band8", "targetBand", lambda p: p.update(targetBand=7.5), r"项目目标固定为雅思总分8\.0"),
            ("r0-plan-band8", "studyBudgetMinutes", lambda p: p.update(studyBudgetMinutes=150), "每日学习时长固定为 120 分钟"),
            ("r0-plan-band8", "retired sectionMinimum", lambda p: p.update(sectionMinimum=6.5), "字段"),
            ("r0-feedback-task1", "Task1 bands.taskResponse", lambda p: p.update(bands={"taskResponse": 7}), "Task 1"),
            ("r0-feedback-writing", "Task2 bands.taskAchievement", lambda p: p.update(bands={"taskAchievement": 7}), "Task 2"),
            ("r0-feedback-writing", "source", lambda p: p.update(source="teacher"), "评分来源"),
            ("r0-gate-g1", "date", lambda p: p.pop("date"), "日期"),
            ("r0-gate-g2", "targets", lambda p: p.update(targets=GATE_TARGETS["G1"]), "门槛目标"),
            ("r0-gate-g1", "scoreSources.writing", lambda p: p["scoreSources"].update(writing="ai"), "真人"),
            ("r0-gate-g3-first", "consecutiveIndex", lambda p: p.update(consecutiveIndex=3), "连续测评序号"),
            ("r0-calibration-task2-human", "weekIndex", lambda p: p.update(weekIndex=53), "周序"),
            ("r0-calibration-task2-human", "workRevisionId", lambda p: p.pop("workRevisionId"), "修订"),
            ("r0-speaking-response", "future sessionId", lambda p: p.update(sessionId="future-session"), "字段"),
            ("r0-feedback-writing", "future reviewer", lambda p: p.update(reviewer={}), "字段"),
            ("r0-assessment-baseline", "future evidenceRefs", lambda p: p.update(evidenceRefs=[]), "字段"),
        ]
        for record_id, condition, mutate, message in cases:
            with self.subTest(record=record_id, field=condition):
                item = fixture(record_id)
                payload = copy.deepcopy(item["request"]["payload"])
                mutate(payload)
                with self.assertRaisesRegex(LearningError, message):
                    validate_payload(item["request"]["kind"], payload, record_id)


class R0ReferenceInteroperationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="band-r0-refs-")
        self.addCleanup(self.directory.cleanup)
        self.database = Database(Path(self.directory.name) / "fixtures.sqlite3")
        with self.database.connect() as db:
            db.execute("INSERT INTO users VALUES(?,?,?,?)", ("r0-test-user", "r0-contract-user", "unused-test-hash", 1))
        self.store = LearningStore(self.database)
        for item in FIXTURE["records"]:
            self.store.put("r0-test-user", item["recordId"], item["request"])

    def tearDown(self):
        self.directory.cleanup()

    def check_rejected_reference(self, record_id, mutate, status, message):
        item = fixture(record_id)
        body = copy.deepcopy(item["request"])
        body["revisionId"] = "30000000-0000-4000-8000-000000000001"
        body["mutationId"] = "40000000-0000-4000-8000-000000000001"
        mutate(body["payload"])
        # These requests are independently valid v2 payloads; only the actual
        # SQLite original/hash/ownership relationship must reject them.
        validate_payload(body["kind"], body["payload"], "rejected-example")
        with self.assertRaisesRegex(LearningError, message) as error:
            self.store.put("r0-test-user", "rejected-example", body)
        self.assertEqual(error.exception.status, status)
        with self.database.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM learning_revisions").fetchone()[0], len(FIXTURE["records"]))

    def test_feedback_changed_input_hash_is_rejected_by_actual_sqlite_reference(self):
        self.check_rejected_reference("r0-feedback-writing", lambda p: p.update(inputHash="0" * 64), 400, "原稿版本不匹配")

    def test_calibration_changed_work_id_is_rejected_by_actual_sqlite_reference(self):
        self.check_rejected_reference("r0-calibration-task2-human", lambda p: p.update(workId="r0-essay-task1"), 400, "原稿版本不匹配")

    def test_calibration_missing_work_revision_preserves_dependency_error(self):
        self.check_rejected_reference("r0-calibration-task2-human", lambda p: p.update(workRevisionId="50000000-0000-4000-8000-000000000001"), 422, "原稿修订")

    def test_task1_feedback_cannot_claim_task2_against_real_original(self):
        self.check_rejected_reference("r0-feedback-task1", lambda p: p.update(taskType="task2", bands={"taskResponse": 7}), 400, "作文类型与原稿不匹配")


if __name__ == "__main__":
    unittest.main()
