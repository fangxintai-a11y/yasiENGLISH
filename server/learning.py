"""Versioned learning records, separate from the legacy vocabulary snapshot.

Only authenticated metadata and typed text records live here. Audio blobs and
provider credentials never enter this protocol. SQLite owns ordering; device
clocks are informational and are never used to resolve an edit conflict.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import re
import time
import uuid
from urllib.parse import parse_qs, unquote

MAX_WRITE = 128 * 1024
MAX_PAGE = 1024 * 1024
KINDS = frozenset(("plan", "mission", "attempt", "essay", "speaking", "feedback", "assessment"))
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z")
SECRET = re.compile(r"\b(?:sk-ant-|sk-proj-|ghp_|gho_)[A-Za-z0-9_-]{10,}")
SENSITIVE = frozenset(("apikey", "aikey", "token", "accesstoken", "refreshtoken", "password", "secret", "authorization", "cookie"))
COMMON = {"datasetId", "planId"}
FIELDS = {
    "plan": {"startDate", "timeZone", "curriculumVersion", "studyBudgetMinutes", "targetBand", "sectionMinimum", "enabled", "syllabusUnit", "materialLevel", "title", "pauseIntervals"},
    "mission": {"date", "day", "taskId", "missionId", "skill", "status", "plannedMinutes", "actualMinutes", "timeSource"},
    "attempt": {"date", "day", "taskId", "contentId", "contentVersion", "skill", "answers", "correct", "score", "total", "actualMinutes", "elapsedSeconds", "conditions", "replayed", "viewedTranscript", "firstAttempt", "isCheckpoint", "note"},
    "essay": {"date", "day", "taskId", "contentId", "contentVersion", "prompt", "text", "wordCount", "parentRevisionId"},
    "speaking": {"date", "day", "taskId", "contentId", "contentVersion", "prompt", "transcript", "durationSeconds", "recordingId", "recordingDevice", "parentRevisionId"},
    "feedback": {"workId", "workRevisionId", "inputHash", "rubricVersion", "source", "sourceText", "assessedAt", "text", "bands"},
    "assessment": {"date", "day", "kind", "source", "materialId", "score", "total", "bands", "scores", "conditions", "note", "notes"},
}
STRING_LIMITS = {
    "text": 20000, "transcript": 20000, "prompt": 8000, "note": 4000, "notes": 4000,
    "sourceText": 1000, "title": 300, "source": 200, "rubricVersion": 120,
    "recordingDevice": 200, "contentVersion": 120, "materialLevel": 80,
    "timeZone": 80, "curriculumVersion": 120, "conditions": 2000,
    "kind": 80, "timeSource": 40, "status": 40, "skill": 40,
}


class LearningError(Exception):
    def __init__(self, status, message, code="invalid_learning_record"):
        self.status = status
        self.body = {"error": message, "code": code}
        super().__init__(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def reject(message="学习记录格式不正确。", status=400):
    raise LearningError(status, message)


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        reject("学习记录标识无效。")
    return value


def revision_id(value):
    if not isinstance(value, str):
        reject("修订标识无效。")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
    except ValueError:
        reject("修订标识无效。")
    return value


def number(value, low=0, high=1440):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high and math.isfinite(value)


def valid_date(value):
    try:
        return isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) and datetime.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def safe_structure(value, depth=0):
    if depth > 6:
        reject("学习记录嵌套过深。")
    if isinstance(value, dict):
        if len(value) > 300:
            reject("学习记录字段过多。")
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 160:
                reject()
            normalized = re.sub(r"[^a-z]", "", key.lower())
            if normalized in SENSITIVE or "apikey" in normalized:
                reject("学习记录不能包含密码或 API Key。")
            safe_structure(item, depth + 1)
    elif isinstance(value, list):
        if len(value) > 300:
            reject("学习记录条目过多。")
        for item in value:
            safe_structure(item, depth + 1)
    elif isinstance(value, str):
        if len(value) > 20000 or SECRET.search(value) or any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            reject("学习文本过长或包含凭据。")
    elif isinstance(value, float) and not math.isfinite(value):
        reject("学习记录包含无效数字。")
    elif value is not None and not isinstance(value, (bool, int, float)):
        reject()


def validate_payload(kind, payload, record_id, deleted=False):
    if not isinstance(payload, dict) or set(payload) - COMMON - FIELDS[kind]:
        reject("学习记录包含不支持的字段。")
    safe_structure(payload)
    if deleted:
        if payload:
            reject("删除记录时请使用空内容。")
        return payload
    for key, value in payload.items():
        if value is None and key in {"sectionMinimum", "parentRevisionId", "recordingId", "recordingDevice", "assessedAt"}:
            continue
        if key in STRING_LIMITS:
            if key == "conditions" and isinstance(value, dict):
                if set(value) - {"replays", "transcriptViewed", "replayed", "viewedTranscript", "firstAttempt", "unseen", "timed"}:
                    reject("作答条件包含不支持字段。")
                for label, item in value.items():
                    if label == "replays":
                        if not number(item, 0, 1000) or int(item) != item:
                            reject()
                    elif not isinstance(item, bool):
                        reject()
            elif not isinstance(value, str) or len(value) > STRING_LIMITS[key]:
                reject("学习文本格式或长度不正确。")
        elif key in {"datasetId", "planId", "taskId", "missionId", "contentId", "materialId", "recordingId", "workId"}:
            identifier(value)
        elif key in {"workRevisionId", "parentRevisionId"}:
            revision_id(value)
        elif key == "inputHash":
            if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
                reject("作品校验值格式不正确。")
        elif key in {"date", "startDate"}:
            if not valid_date(value):
                reject("学习日期格式不正确。")
        elif key in {"enabled", "replayed", "viewedTranscript", "firstAttempt", "isCheckpoint"}:
            if not isinstance(value, bool):
                reject()
        elif key in {"day", "syllabusUnit"}:
            if not number(value, 1, 365) or int(value) != value:
                reject()
        elif key in {"plannedMinutes", "actualMinutes"}:
            if not number(value):
                reject()
        elif key in {"durationSeconds", "elapsedSeconds"}:
            if not number(value, 0, 86400):
                reject()
        elif key in {"wordCount", "correct", "score", "total"}:
            if not number(value, 0, 100000):
                reject()
        elif key in {"targetBand", "sectionMinimum"}:
            if not number(value, 0, 9):
                reject()
        elif key == "studyBudgetMinutes":
            if value not in (120, 150, 180) or isinstance(value, bool):
                reject("请选择120、150或180分钟。")
        elif key in {"scores", "bands"}:
            if not isinstance(value, dict) or set(value) - {"listening", "reading", "writing", "speaking", "taskResponse", "coherence", "lexical", "grammar", "fluency", "pronunciation"}:
                reject("测评分数字段不正确。")
            if any(v is not None and not number(v, 0, 9) for v in value.values()):
                reject("测评分数必须在0至9之间。")
        elif key == "answers":
            if not isinstance(value, list) or any(v is not None and (isinstance(v, bool) or not isinstance(v, (str, int, float))) for v in value):
                reject("作答记录格式不正确。")
        elif key == "pauseIntervals":
            if not isinstance(value, list) or any(not isinstance(v, dict) or set(v) != {"start", "end"} or not valid_date(v["start"]) or not valid_date(v["end"]) or v["end"] < v["start"] for v in value):
                reject("暂停日期格式不正确。")
    if kind == "plan":
        if not {"startDate", "studyBudgetMinutes"}.issubset(payload):
            reject("计划缺少开始日期或时间预算。")
        if payload.get("planId", record_id) != record_id:
            reject("计划标识不匹配。")
        if "timeZone" in payload:
            try:
                from zoneinfo import ZoneInfo
                ZoneInfo(payload["timeZone"])
            except (KeyError, ValueError):
                reject("计划时区无效。")
    elif not payload.get("planId"):
        reject("学习记录缺少计划标识。")
    if kind == "mission":
        if not (payload.get("taskId") or payload.get("missionId")):
            reject("任务缺少标识。")
        if payload.get("status") not in {"not_started", "in_progress", "completed", "partial", "minimum", "skipped"}:
            reject("任务状态无效。")
    if kind == "attempt" and not {"contentId", "skill", "answers"}.issubset(payload):
        reject("练习缺少材料或作答。")
    if kind == "essay" and not isinstance(payload.get("text"), str):
        reject("作文缺少正文。")
    if kind == "speaking" and not isinstance(payload.get("transcript"), str):
        reject("口语记录缺少转写字段。")
    if kind == "feedback" and not {"workRevisionId", "inputHash", "source", "text"}.issubset(payload):
        reject("反馈缺少原稿引用或来源。")
    if "correct" in payload and "total" in payload and payload["correct"] > payload["total"]:
        reject("正确数不能超过总题数。")
    return payload


def content_hash(kind, payload):
    value = payload.get("text", "") if kind == "essay" else payload.get("transcript", "") if kind == "speaking" else encoded(payload)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class LearningStore:
    def __init__(self, database):
        self.database = database
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for statement in (
                """CREATE TABLE IF NOT EXISTS learning_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)""",
                """CREATE TABLE IF NOT EXISTS learning_records(
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    id TEXT NOT NULL, kind TEXT NOT NULL, dataset_id TEXT NOT NULL, plan_id TEXT,
                    current_revision_id TEXT, deleted_at INTEGER, PRIMARY KEY(user_id,id))""",
                """CREATE TABLE IF NOT EXISTS learning_revisions(
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, revision_id TEXT NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    record_id TEXT NOT NULL, base_revision_id TEXT, payload TEXT NOT NULL,
                    content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
                    conflict INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(user_id,revision_id),
                    FOREIGN KEY(user_id,record_id) REFERENCES learning_records(user_id,id) ON DELETE CASCADE)""",
                """CREATE TABLE IF NOT EXISTS learning_mutation_receipts(
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    status INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id,mutation_id))""",
                "CREATE INDEX IF NOT EXISTS learning_records_plan ON learning_records(user_id,plan_id,kind)",
                "CREATE INDEX IF NOT EXISTS learning_revisions_user_seq ON learning_revisions(user_id,seq)",
                "CREATE INDEX IF NOT EXISTS learning_revisions_record ON learning_revisions(user_id,record_id,seq)",
            ):
                db.execute(statement)
            db.execute("INSERT OR IGNORE INTO learning_schema_migrations VALUES(1,?)", (int(time.time() * 1000),))

    @staticmethod
    def item(db, user_id, revision):
        if revision is None:
            return None
        row = db.execute("""SELECT v.*,r.kind,r.dataset_id,r.plan_id FROM learning_revisions v
                            JOIN learning_records r ON r.user_id=v.user_id AND r.id=v.record_id
                            WHERE v.user_id=? AND v.revision_id=?""", (user_id, revision)).fetchone()
        if row is None:
            return None
        return {"id": row["record_id"], "kind": row["kind"], "datasetId": row["dataset_id"], "planId": row["plan_id"],
                "revisionId": row["revision_id"], "baseRevision": row["base_revision_id"], "seq": row["seq"],
                "payload": json.loads(row["payload"]), "contentHash": row["content_hash"], "createdAt": row["created_at"],
                "conflict": bool(row["conflict"]), "deleted": bool(row["deleted"])}

    @staticmethod
    def references(db, user_id, kind, payload, base, record_id):
        if base:
            row = db.execute("SELECT record_id FROM learning_revisions WHERE user_id=? AND revision_id=?", (user_id, base)).fetchone()
            if row is None or row["record_id"] != record_id:
                raise LearningError(422, "基础修订尚未同步或不属于此记录。", "missing_dependency")
        plan_id = payload.get("planId")
        if kind != "plan":
            plan = db.execute("SELECT kind,deleted_at,dataset_id FROM learning_records WHERE user_id=? AND id=?", (user_id, plan_id)).fetchone()
            if plan is None or plan["kind"] != "plan" or plan["deleted_at"] is not None:
                raise LearningError(422, "请先同步所属计划。", "missing_dependency")
            if payload.get("datasetId", plan["dataset_id"]) != plan["dataset_id"]:
                reject("记录与计划的词库不匹配。")
        for field in ("workRevisionId", "parentRevisionId"):
            ref = payload.get(field)
            if ref:
                row = db.execute("""SELECT v.content_hash,v.record_id,v.deleted,r.kind,r.plan_id FROM learning_revisions v
                                    JOIN learning_records r ON r.user_id=v.user_id AND r.id=v.record_id
                                    WHERE v.user_id=? AND v.revision_id=?""", (user_id, ref)).fetchone()
                if row is None or row["kind"] not in {"essay", "speaking"} or row["plan_id"] != plan_id or row["deleted"]:
                    raise LearningError(422, "原稿修订尚未同步或引用不正确。", "missing_dependency")
                if field == "workRevisionId":
                    if payload["inputHash"] != row["content_hash"] or (payload.get("workId") and payload["workId"] != row["record_id"]):
                        reject("反馈与原稿版本不匹配。")

    def put(self, user_id, record_id, body):
        identifier(record_id)
        if not isinstance(body, dict) or set(body) - {"schemaVersion", "revisionId", "mutationId", "baseRevision", "kind", "payload", "deleted"}:
            reject()
        if not {"schemaVersion", "revisionId", "mutationId", "baseRevision", "kind", "payload"}.issubset(body):
            reject()
        if type(body["schemaVersion"]) is not int or body["schemaVersion"] != 1 or not isinstance(body["kind"], str) or body["kind"] not in KINDS:
            reject("学习协议或记录类型不支持。")
        if "deleted" in body and not isinstance(body["deleted"], bool):
            reject()
        rev, mutation = revision_id(body["revisionId"]), revision_id(body["mutationId"])
        base = revision_id(body["baseRevision"]) if body["baseRevision"] is not None else None
        kind, deleted = body["kind"], body.get("deleted", False)
        payload = validate_payload(kind, body["payload"], record_id, deleted)
        if len(encoded(body).encode("utf-8")) > MAX_WRITE:
            reject("单条学习记录超过128 KiB。", 413)
        fingerprint = hashlib.sha256((record_id + "\n" + encoded(body)).encode()).hexdigest()
        now = int(time.time() * 1000)
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM learning_mutation_receipts WHERE user_id=? AND mutation_id=?", (user_id, mutation)).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    reject("同一提交标识不能用于不同内容。")
                return old["status"], json.loads(old["response"])
            if db.execute("SELECT 1 FROM learning_revisions WHERE user_id=? AND revision_id=?", (user_id, rev)).fetchone():
                reject("修订标识已使用，请创建新的修订。")
            record = db.execute("SELECT * FROM learning_records WHERE user_id=? AND id=?", (user_id, record_id)).fetchone()
            if record and record["kind"] != kind:
                reject("记录类型不能变更。")
            if deleted:
                if not record:
                    raise LearningError(404, "学习记录不存在。", "not_found")
                self.references(db, user_id, "plan", {}, base, record_id)
                dataset_id, plan_id = record["dataset_id"], record["plan_id"]
            else:
                self.references(db, user_id, kind, payload, base, record_id)
                dataset_id = payload.get("datasetId", "word-atlas-open") if kind == "plan" else db.execute(
                    "SELECT dataset_id FROM learning_records WHERE user_id=? AND id=?", (user_id, payload["planId"])
                ).fetchone()["dataset_id"]
                plan_id = record_id if kind == "plan" else payload["planId"]
                if record and (record["dataset_id"] != dataset_id or record["plan_id"] != plan_id):
                    reject("记录归属不能变更。")
            current = record["current_revision_id"] if record else None
            conflict = current != base
            if not record:
                db.execute("INSERT INTO learning_records(user_id,id,kind,dataset_id,plan_id) VALUES(?,?,?,?,?)", (user_id, record_id, kind, dataset_id, plan_id))
            db.execute("""INSERT INTO learning_revisions(revision_id,user_id,record_id,base_revision_id,payload,content_hash,created_at,conflict,deleted)
                          VALUES(?,?,?,?,?,?,?,?,?)""", (rev, user_id, record_id, base, encoded(payload), content_hash(kind, payload), now, int(conflict), int(deleted)))
            incoming = self.item(db, user_id, rev)
            if conflict:
                status, response = 409, {"error": "手机和电脑各有修改，两份均已保存。", "code": "revision_conflict", "record": self.item(db, user_id, current), "conflict": incoming, "applied": False}
            else:
                db.execute("UPDATE learning_records SET current_revision_id=?,deleted_at=? WHERE user_id=? AND id=?", (rev, now if deleted else None, user_id, record_id))
                status, response = 200, {"record": incoming, "applied": True}
            db.execute("INSERT INTO learning_mutation_receipts VALUES(?,?,?,?,?)", (user_id, mutation, fingerprint, status, encoded(response)))
            return status, response

    def list(self, user_id, after=0, limit=100, kind=None, plan_id=None, record_id=None, current=False):
        clauses, args = ["v.user_id=?", "v.seq> ?"], [user_id, after]
        if current:
            clauses.append("r.current_revision_id=v.revision_id")
        if kind:
            clauses.append("r.kind=?"); args.append(kind)
        if plan_id:
            clauses.append("r.plan_id=?"); args.append(plan_id)
        if record_id:
            clauses.append("r.id=?"); args.append(record_id)
        query = "SELECT v.revision_id FROM learning_revisions v JOIN learning_records r ON r.user_id=v.user_id AND r.id=v.record_id WHERE " + " AND ".join(clauses) + " ORDER BY v.seq LIMIT ?"
        args.append(limit + 1)
        with self.database.connect() as db:
            db.execute("BEGIN")
            rows = db.execute(query, args).fetchall()
            result, size = [], 64
            for row in rows:
                item = self.item(db, user_id, row["revision_id"])
                cost = len(encoded(item).encode("utf-8")) + 1
                if len(result) >= limit or size + cost > MAX_PAGE:
                    break
                result.append(item); size += cost
            return {"items": result, "nextCursor": result[-1]["seq"] if result else after, "hasMore": len(result) < len(rows)}


def dispatch(handler, method, path, query):
    """Return true when this module handled a request."""
    if path == "/api/capabilities" and method == "GET":
        handler.send_json(200, {"vocabSnapshot": 2, "learningRecords": 1, "learningWriteEnabled": handler.server.learning_write_enabled})
        return True
    prefix = "/api/learning/v1/"
    if not path.startswith(prefix):
        return False
    user = handler.require_user()
    expected_user = handler.headers.get("X-Learning-User")
    if expected_user is not None and expected_user != user["id"]:
        raise LearningError(403, "登录账号已变更，请重新连接后再同步。", "account_changed")
    store = handler.server.learning
    tail = path[len(prefix):]
    params = parse_qs(query, keep_blank_values=True)
    if any(len(v) != 1 for v in params.values()):
        reject("学习查询格式不正确。")
    if method == "PUT" and tail.startswith("records/") and "/" not in tail[len("records/"):]:
        if params:
            reject("写入接口不接受查询参数。")
        if not handler.server.learning_write_enabled:
            raise LearningError(503, "学习记录暂时不可同步，已保存的本机内容会保留。", "learning_write_disabled")
        status, response = store.put(user["id"], unquote(tail[len("records/"):]), handler.body(maximum=MAX_WRITE))
        handler.send_json(status, response)
        return True
    if method != "GET":
        raise LearningError(404, "学习接口不存在。", "not_found")
    if set(params) - {"after", "limit", "kind", "planId"}:
        reject("学习查询格式不正确。")
    def integer(name, default, high):
        value = params.get(name, [str(default)])[0]
        if not re.fullmatch(r"\d{1,16}", value) or not 0 <= int(value) <= high:
            reject("分页参数无效。")
        return int(value)
    after, limit = integer("after", 0, 9_007_199_254_740_991), integer("limit", 100, 100)
    if limit < 1:
        reject("分页条数无效。")
    kind, plan_id = params.get("kind", [None])[0], params.get("planId", [None])[0]
    if kind and kind not in KINDS:
        reject("记录类型无效。")
    if plan_id:
        identifier(plan_id)
    if tail == "changes":
        if kind or plan_id:
            reject("增量同步不能过滤记录。")
        result = store.list(user["id"], after, limit)
    elif tail == "records":
        result = store.list(user["id"], after, limit, kind, plan_id, current=True)
    elif tail.startswith("records/") and tail.endswith("/revisions"):
        record_id = identifier(unquote(tail[len("records/"):-len("/revisions")]))
        result = store.list(user["id"], after, limit, record_id=record_id)
    else:
        raise LearningError(404, "学习接口不存在。", "not_found")
    handler.send_json(200, result)
    return True
