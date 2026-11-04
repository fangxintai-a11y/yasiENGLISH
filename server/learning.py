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
from pathlib import Path
from urllib.parse import parse_qs, unquote

MAX_WRITE = 128 * 1024
MAX_PAGE = 1024 * 1024
KINDS = frozenset(("plan", "mission", "attempt", "essay", "speaking", "feedback", "assessment"))
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z")
SECRET = re.compile(r"\b(?:sk-ant-|sk-proj-|ghp_|gho_)[A-Za-z0-9_-]{10,}")
SENSITIVE = frozenset(("apikey", "aikey", "token", "accesstoken", "refreshtoken", "password", "secret", "authorization", "cookie"))
COMMON = {"datasetId", "planId"}
PROTOCOL_VERSION = 2
SECTION_TARGETS = {"listening": 8.5, "reading": 8.5, "writing": 7.5, "speaking": 7.5}
GATE_TARGETS = {
    "G1": {"overall": 6.5, "listening": 7, "reading": 7, "writing": 6, "speaking": 6},
    "G2": {"overall": 7, "listening": 7.5, "reading": 7.5, "writing": 6.5, "speaking": 6.5},
    "G3": {"overall": 7.5, "listening": 8, "reading": 8, "writing": 7, "speaking": 7},
    "G4": {"overall": 8, "listening": 8.5, "reading": 8.5, "writing": 7.5, "speaking": 7.5},
}
SCORE_SOURCES = frozenset(("self", "rules", "ai", "human", "official"))
ERROR_CAUSES = frozenset(("synonym-miss", "locating-error", "spelling", "time-pressure", "word-limit", "vocab-unknown", "misread-question", "tfng-inference", "grammar", "lexical-misuse", "coherence", "task-response", "task-achievement", "fluency-pause", "pronunciation", "other"))
WRITING_ERROR_CAUSES = frozenset(("task-achievement", "task-response", "coherence", "lexical-misuse", "grammar", "spelling", "word-limit", "time-pressure", "misread-question", "vocab-unknown", "other"))
_WRITING_SHARED_CHECKS = {"coherence-organisation", "coherence-progression", "coherence-cohesion", "lexical-precision", "lexical-range", "lexical-collocation", "grammar-range", "grammar-accuracy", "grammar-punctuation"}
WRITING_CHECKLIST_IDS = {
    "task1": _WRITING_SHARED_CHECKS | {"task-achievement-coverage", "task-achievement-accuracy", "task-achievement-relevance", "task1-overview", "task1-comparison", "task1-no-opinion"},
    "task2": _WRITING_SHARED_CHECKS | {"task-response-answer", "task-response-position", "task-response-support"},
}
WRITING_FEEDBACK_FIELDS = {"errorCauses", "spellingCheck", "checklist"}
SPEAKING_ERROR_CAUSES = ERROR_CAUSES - {"task-response", "task-achievement", "spelling", "word-limit"}
SPEAKING_CHECKLIST_IDS = frozenset((
    "speaking-fluency-development", "speaking-fluency-continuity", "speaking-fluency-linking",
    "speaking-lexical-precision", "speaking-lexical-paraphrase", "speaking-grammar-range", "speaking-grammar-accuracy",
    "speaking-pronunciation-intelligibility", "speaking-pronunciation-stress", "speaking-pronunciation-intonation",
))
FIELDS = {
    "plan": {"startDate", "timeZone", "curriculumVersion", "studyBudgetMinutes", "targetBand", "sectionTargets", "enabled", "syllabusUnit", "materialLevel", "title", "pauseIntervals"},
    "mission": {"date", "day", "taskId", "missionId", "skill", "status", "plannedMinutes", "actualMinutes", "timeSource"},
    "attempt": {"date", "day", "taskId", "contentId", "contentVersion", "skill", "answers", "correct", "score", "total", "actualMinutes", "elapsedSeconds", "conditions", "replayed", "viewedTranscript", "firstAttempt", "isCheckpoint", "note", "questionResults"},
    "essay": {"date", "day", "taskId", "contentId", "contentVersion", "prompt", "text", "wordCount", "parentRevisionId", "taskType", "scope", "stage", "elapsedSeconds", "conditions", "sourceRef"},
    "speaking": {"date", "day", "taskId", "contentId", "contentVersion", "prompt", "transcript", "durationSeconds", "recordingId", "recordingDevice", "parentRevisionId", "part", "prepSeconds", "conditions", "sourceRef", "recordingStatus"},
    "feedback": {"workId", "workRevisionId", "inputHash", "rubricVersion", "source", "sourceText", "assessedAt", "text", "bands", "taskType", "errorCauses", "spellingCheck", "checklist"},
    "assessment": {"date", "day", "kind", "source", "materialId", "score", "total", "bands", "scores", "conditions", "note", "notes", "gateId", "targets", "consecutiveIndex", "scoreSources", "weekIndex", "workId", "workRevisionId", "inputHash", "taskType", "selfBands", "machineBands", "machineSource"},
}
STRING_LIMITS = {
    "text": 20000, "transcript": 20000, "prompt": 8000, "note": 4000, "notes": 4000,
    "sourceText": 1000, "sourceRef": 300, "title": 300, "source": 200, "rubricVersion": 120,
    "recordingDevice": 200, "contentVersion": 120, "materialLevel": 80,
    "timeZone": 80, "curriculumVersion": 120, "conditions": 2000,
    "kind": 80, "timeSource": 40, "status": 40, "skill": 40,
    "taskType": 20, "gateId": 20, "machineSource": 20,
}


class LearningError(Exception):
    def __init__(self, status, message, code="invalid_learning_record", **details):
        self.status = status
        self.body = {"error": message, "code": code, **details}
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


def safe_structure(value, depth=0, path=""):
    if depth > 6:
        reject("学习记录嵌套过深。")
    if isinstance(value, dict):
        if len(value) > 300:
            reject("学习记录字段过多。")
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 160:
                reject()
            normalized = re.sub(r"[^a-z]", "", key.lower())
            if normalized in SENSITIVE or "apikey" in normalized or key in {"__proto__", "constructor", "prototype"}:
                reject("学习记录不能包含密码或 API Key。")
            safe_structure(item, depth + 1, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        if len(value) > (20000 if path == "spellingCheck.items" else 300):
            reject("学习记录条目过多。")
        for item in value:
            safe_structure(item, depth + 1, f"{path}[]")
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
        if key == "sourceRef" and isinstance(value, str) and len(value.encode("utf-16-le")) // 2 > 300:
            reject("学习文本格式或长度不正确。")
        if kind in {"essay", "speaking"} and key == "conditions":
            if not isinstance(value, dict) or set(value) - {"timed", "firstAttempt", "unseen"} or any(not isinstance(item, bool) for item in value.values()):
                reject("作答条件格式不正确。")
            continue
        if value is None and key in {"datasetId", "parentRevisionId", "recordingId", "recordingDevice", "assessedAt"}:
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
                reject("学习记录数值超出范围。" if kind == "essay" else "学习记录格式不正确。")
        elif key in {"wordCount", "correct", "score", "total"}:
            if not number(value, 0, 100000):
                reject()
        elif key == "targetBand":
            if not number(value, 0, 9):
                reject()
        elif key in {"scores", "bands", "selfBands", "machineBands"}:
            validate_bands(value)
        elif key == "answers":
            if not isinstance(value, list) or any(v is not None and (isinstance(v, bool) or not isinstance(v, (str, int, float))) for v in value):
                reject("作答记录格式不正确。")
        elif key == "pauseIntervals":
            if not isinstance(value, list) or any(not isinstance(v, dict) or set(v) != {"start", "end"} or not valid_date(v["start"]) or not valid_date(v["end"]) or v["end"] < v["start"] for v in value):
                reject("暂停日期格式不正确。")
    if kind == "plan":
        if "startDate" not in payload:
            reject("计划缺少开始日期。")
        if not same_numbers(payload.get("sectionTargets"), SECTION_TARGETS):
            reject("四科目标必须为听8.5、读8.5、写7.5、说7.5。")
        if payload.get("targetBand") != 8:
            reject("项目目标固定为雅思总分8.0。")
        if payload.get("studyBudgetMinutes") != 120 or isinstance(payload.get("studyBudgetMinutes"), bool):
            reject("每日学习时长固定为 120 分钟。")
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
    if kind == "essay" and payload.get("taskType") not in {"task1", "task2"}:
        reject("作文必须明确 task1 或 task2。")
    if kind == "essay" and "scope" in payload and payload["scope"] not in ("full", "paragraph"):
        reject("作文练习范围无效。")
    if kind == "essay" and "stage" in payload and payload["stage"] not in ("draft", "submitted"):
        reject("作文保存阶段无效。")
    if kind == "speaking" and not isinstance(payload.get("transcript"), str):
        reject("口语记录缺少转写字段。")
    if kind == "speaking":
        validate_speaking_record(payload)
    if kind == "feedback" and not {"workRevisionId", "inputHash", "source", "text"}.issubset(payload):
        reject("反馈缺少原稿引用或来源。")
    if kind == "feedback":
        if payload.get("taskType") == "speaking":
            validate_speaking_feedback(payload)
        else:
            validate_writing_feedback(payload)
    if "correct" in payload and "total" in payload and payload["correct"] > payload["total"]:
        reject("正确数不能超过总题数。")
    if kind in {"feedback", "assessment"}:
        if payload.get("source") not in SCORE_SOURCES:
            reject("评分来源必须为 self、rules、ai、human 或 official。")
        for field in ("bands", "selfBands", "machineBands"):
            if field in payload:
                validate_task_bands(payload.get("taskType"), payload[field])
    if "taskType" in payload and not (kind == "feedback" and payload["taskType"] == "speaking") and payload["taskType"] not in {"task1", "task2"}:
        reject("作文任务类型无效。")
    if kind == "attempt" and "questionResults" in payload:
        if not isinstance(payload["questionResults"], list):
            reject("逐题错因格式无效。")
        ids = set()
        for result in payload["questionResults"]:
            if not isinstance(result, dict) or set(result) - {"questionId", "correct", "confidence", "errorCause", "note"} or "errorCause" not in result or not isinstance(result.get("correct"), bool) or not isinstance(result.get("confidence"), str) or result["confidence"] not in {"sure", "unsure"}:
                reject("逐题错因格式无效。")
            question_id = identifier(result.get("questionId"))
            if question_id in ids:
                reject("逐题错因题号不能重复。")
            ids.add(question_id)
            cause = result["errorCause"]
            if (result["correct"] and cause is not None) or (not result["correct"] and (not isinstance(cause, str) or cause not in ERROR_CAUSES)):
                reject("错因必须使用枚举编码，正确答案的错因为空。")
            if "note" in result and (not isinstance(result["note"], str) or len(result["note"]) > 4000):
                reject("错因说明格式无效。")
            if result.get("errorCause") == "other" and not str(result.get("note", payload.get("note", ""))).strip():
                reject("其他错因必须填写说明。")
    if kind == "assessment":
        validate_assessment(payload)
    return payload


def validate_speaking_record(payload):
    if "part" in payload and (not number(payload["part"], 1, 3) or payload["part"] not in (1, 2, 3)):
        reject("口语Part必须为1、2或3。")
    if "prepSeconds" in payload:
        seconds = payload["prepSeconds"]
        if not number(seconds, 0, 60) or int(seconds) != seconds:
            reject("口语准备时间必须为0至60的整数秒。")
        if seconds > 0 and payload.get("part") != 2:
            reject("只有 Part 2可以保存大于0的准备时间。")
    if "recordingStatus" in payload and payload["recordingStatus"] not in ("local", "none"):
        reject("录音状态只能为local或none，录音不上传。")


def validate_speaking_feedback(payload):
    if "spellingCheck" in payload:
        reject("口语反馈不能包含拼写检查。")
    if "errorCauses" in payload:
        causes = payload["errorCauses"]
        if not isinstance(causes, list) or any(not isinstance(cause, str) or cause not in SPEAKING_ERROR_CAUSES for cause in causes):
            reject("口语错因必须使用允许的枚举编码。")
        if len(set(causes)) != len(causes):
            reject("口语错因不能重复。")
        if "other" in causes and (not isinstance(payload.get("text"), str) or not payload["text"].strip()):
            reject("其他错因必须在反馈正文填写说明。")
    if "checklist" in payload:
        checklist = payload["checklist"]
        if not isinstance(checklist, dict) or any(key not in SPEAKING_CHECKLIST_IDS or value is not None and not isinstance(value, bool) for key, value in checklist.items()):
            reject("口语自查条目或状态无效。")


def validate_speaking_feedback_reference(feedback, work_kind, work):
    if feedback.get("taskType") != "speaking":
        reject("口语反馈必须明确speaking任务类型。")
    validate_speaking_feedback(feedback)
    if work_kind != "speaking" or not isinstance(work.get("transcript"), str):
        reject("口语反馈必须引用口语原稿。")


def validate_writing_feedback(payload):
    if not WRITING_FEEDBACK_FIELDS.intersection(payload):
        return
    task_type = payload.get("taskType")
    if not isinstance(task_type, str) or task_type not in WRITING_CHECKLIST_IDS:
        reject("写作自查必须明确任务类型。")
    if "errorCauses" in payload:
        causes = payload["errorCauses"]
        if not isinstance(causes, list) or any(not isinstance(cause, str) or cause not in WRITING_ERROR_CAUSES for cause in causes):
            reject("写作错因必须使用适用的枚举编码。")
        if len(set(causes)) != len(causes):
            reject("写作错因不能重复。")
        if task_type == "task1" and "task-response" in causes:
            reject("Task 1不能使用 task-response 错因。")
        if task_type == "task2" and "task-achievement" in causes:
            reject("Task 2不能使用 task-achievement 错因。")
        if "other" in causes and (not isinstance(payload.get("text"), str) or not payload["text"].strip()):
            reject("其他错因必须在反馈正文填写说明。")
    if "spellingCheck" in payload:
        check = payload["spellingCheck"]
        if not isinstance(check, dict) or set(check) != {"status", "count", "items"} or check["status"] not in ("unchecked", "checked") or not isinstance(check["items"], list):
            reject("拼写检查格式无效。")
        positions = set()
        for item in check["items"]:
            if not isinstance(item, dict) or set(item) != {"start", "end", "text", "confirmed"} or not number(item["start"], 0, 2**53-1) or int(item["start"]) != item["start"] or not number(item["end"], 0, 2**53-1) or int(item["end"]) != item["end"] or item["end"] <= item["start"] or not isinstance(item["text"], str) or not item["text"] or not isinstance(item["confirmed"], bool):
                reject("拼写位置或片段格式无效。")
            key = (item["start"], item["end"])
            if key in positions:
                reject("拼写位置不能重复。")
            positions.add(key)
        count = check["count"]
        if (check["status"] == "unchecked" and count is not None) or (check["status"] == "checked" and (not number(count, 0, 2**53-1) or int(count) != count or count != sum(item["confirmed"] for item in check["items"]))):
            reject("拼写检查数量必须匹配确认条数；未检查时为空。")
    if "checklist" in payload:
        checklist = payload["checklist"]
        if not isinstance(checklist, dict) or any(key not in WRITING_CHECKLIST_IDS[task_type] or value is not None and not isinstance(value, bool) for key, value in checklist.items()):
            reject("自查清单条目或状态无效。")


def validate_writing_feedback_reference(feedback, work):
    validate_writing_feedback(feedback)
    if not WRITING_FEEDBACK_FIELDS.intersection(feedback):
        return
    if not isinstance(work.get("text"), str) or work.get("taskType") not in ("task1", "task2") or feedback.get("taskType") != work["taskType"]:
        reject("写作自查任务类型与原稿不匹配。")
    # Browser textarea selections use UTF-16 code units; stored/hash text stays UTF-8.
    original = work["text"].encode("utf-16-le")
    for item in feedback.get("spellingCheck", {}).get("items", []):
        start, end = int(item["start"])*2, int(item["end"])*2
        try:
            actual = original[start:end].decode("utf-16-le")
        except UnicodeDecodeError:
            reject("拼写片段与原稿不一致。")
        if end > len(original) or actual != item["text"]:
            reject("拼写片段与原稿不一致。")


def same_numbers(value, expected):
    return isinstance(value, dict) and set(value) == set(expected) and all(number(value[key], 0, 9) and value[key] == expected[key] for key in expected)


def validate_bands(value):
    if not isinstance(value, dict) or set(value) - {"listening", "reading", "writing", "speaking", "taskAchievement", "taskResponse", "coherence", "lexical", "grammar", "fluency", "pronunciation"}:
        reject("测评分数字段不正确。")
    if any(v is not None and (not number(v, 0, 9) or int(v * 2) != v * 2) for v in value.values()):
        reject("测评分数必须为0至9的半分或空值。")


def validate_task_bands(task_type, bands):
    if task_type == "speaking":
        if set(bands) - {"fluency", "lexical", "grammar", "pronunciation"}:
            reject("口语评分维度无效。")
        return
    if {"taskAchievement", "taskResponse"} & set(bands) and task_type not in {"task1", "task2"}:
        reject("作文评分必须明确任务类型。")
    if task_type == "task1" and "taskResponse" in bands:
        reject("Task 1只能使用 taskAchievement。")
    if task_type == "task2" and "taskAchievement" in bands:
        reject("Task 2只能使用 taskResponse。")


def validate_assessment(payload):
    if payload.get("kind") not in {"baseline", "weekly-mock", "gate", "weekly-calibration", "official"}:
        reject("测评类型无效。")
    if payload["kind"] == "gate":
        if not valid_date(payload.get("date")):
            reject("门槛记录必须包含有效日期。")
        target = GATE_TARGETS.get(payload.get("gateId"))
        if target is None or not same_numbers(payload.get("targets"), target):
            reject("门槛目标与G1–G4定义不一致。")
        index = payload.get("consecutiveIndex")
        if (not number(index, 1, 2) or int(index) != index) if payload["gateId"] == "G3" else (index is not None and not number(index, 1, 1)):
            reject("门槛连续测评序号无效。")
        scores, sources = payload.get("scores"), payload.get("scoreSources")
        if not isinstance(scores, dict) or set(scores) != set(SECTION_TARGETS):
            reject("门槛必须保存四科实际分，未评估填空值。")
        if not isinstance(sources, dict) or set(sources) != set(SECTION_TARGETS):
            reject("门槛必须保存四科评分来源。")
        for key in SECTION_TARGETS:
            source = sources[key]
            if (scores[key] is None and source is not None) or (scores[key] is not None and (not isinstance(source, str) or source not in SCORE_SOURCES)):
                reject("门槛分数与来源不一致。")
            if key in {"writing", "speaking"} and scores[key] is not None and source not in {"human", "official"}:
                reject("写作和口语门槛分必须来自真人或正式成绩。")
            if payload["gateId"] == "G4" and scores[key] is not None and source != "official":
                reject("G4必须保存正式考试来源。")
        if payload["gateId"] == "G4" and payload.get("source") != "official":
            reject("G4必须保存正式考试来源。")
    if payload["kind"] == "weekly-calibration":
        week = payload.get("weekIndex")
        if not number(week, 1, 52) or int(week) != week:
            reject("真人校准周序必须在1至52之间。")
        revision_id(payload.get("workRevisionId"))
        bands = payload.get("bands")
        expected = {"taskAchievement", "coherence", "lexical", "grammar"} if payload.get("taskType") == "task1" else {"taskResponse", "coherence", "lexical", "grammar"} if payload.get("taskType") == "task2" else {"fluency", "lexical", "grammar", "pronunciation"}
        if not isinstance(bands, dict) or set(bands) != expected:
            reject("每周校准必须保存对应作品的四项分数。")
        if payload.get("source") in {"human", "official"} and any(value is None for value in bands.values()):
            reject("真人校准必须保存四项有效分数。")
        if "machineSource" in payload and payload["machineSource"] not in {"ai", "rules"}:
            reject("机器估分来源无效。")
        if "machineBands" in payload and payload.get("machineSource") not in {"ai", "rules"}:
            reject("机器估分必须明确来源。")
    if payload["kind"] == "official":
        scores = payload.get("scores")
        if payload.get("source") != "official" or not valid_date(payload.get("date")) or not isinstance(scores, dict) or set(scores) != set(SECTION_TARGETS) or any(value is None for value in scores.values()):
            reject("正式成绩必须包含日期、正式来源和完整四科分数。")


def content_hash(kind, payload):
    value = payload.get("text", "") if kind == "essay" else payload.get("transcript", "") if kind == "speaking" else encoded(payload)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class LearningStore:
    def __init__(self, database):
        self.database = database
        self.migration_backup_path = None
        with database.connect() as db:
            existing = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_records'").fetchone() is not None
            migrations = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_schema_migrations'").fetchone() is not None
            version = db.execute("SELECT COALESCE(MAX(version),0) FROM learning_schema_migrations").fetchone()[0] if migrations else 0
        # SQLite backup captures committed WAL data before any schema/data change.
        if existing and version < 2:
            destination = Path(database.path).with_name(Path(database.path).name + ".learning-v1-backup-" + uuid.uuid4().hex + ".sqlite3")
            database.backup(destination)
            self.migration_backup_path = str(destination)
        with database.connect() as db:
            if existing and version < 2:
                db.execute("PRAGMA foreign_keys=OFF")
            db.execute("BEGIN IMMEDIATE")
            for statement in (
                """CREATE TABLE IF NOT EXISTS learning_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)""",
                """CREATE TABLE IF NOT EXISTS learning_records(
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    id TEXT NOT NULL, kind TEXT NOT NULL, dataset_id TEXT, plan_id TEXT,
                    current_revision_id TEXT, deleted_at INTEGER, PRIMARY KEY(user_id,id))""",
                """CREATE TABLE IF NOT EXISTS learning_revisions(
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, revision_id TEXT NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    record_id TEXT NOT NULL, base_revision_id TEXT, payload TEXT NOT NULL,
                    content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
                    conflict INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
                    dataset_id TEXT, payload_version INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(user_id,revision_id),
                    FOREIGN KEY(user_id,record_id) REFERENCES learning_records(user_id,id) ON DELETE CASCADE)""",
                """CREATE TABLE IF NOT EXISTS learning_mutation_receipts(
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    status INTEGER NOT NULL, revision_id TEXT, conflict_revision_id TEXT,
                    PRIMARY KEY(user_id,mutation_id))""",
            ):
                db.execute(statement)
            current = db.execute("SELECT COALESCE(MAX(version),0) FROM learning_schema_migrations").fetchone()[0]
            if existing and current < 2:
                self._migrate_v2(db)
            for statement in (
                "CREATE INDEX IF NOT EXISTS learning_records_plan ON learning_records(user_id,plan_id,kind)",
                "CREATE INDEX IF NOT EXISTS learning_revisions_user_seq ON learning_revisions(user_id,seq)",
                "CREATE INDEX IF NOT EXISTS learning_revisions_record ON learning_revisions(user_id,record_id,seq)",
            ):
                db.execute(statement)
            now = int(time.time() * 1000)
            db.execute("INSERT OR IGNORE INTO learning_schema_migrations VALUES(1,?)", (now,))
            db.execute("INSERT OR IGNORE INTO learning_schema_migrations VALUES(2,?)", (now,))
            if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("Learning migration failed its foreign-key verification; original backup retained")
            db.commit()
            db.execute("PRAGMA foreign_keys=ON")

    @staticmethod
    def _migrate_v2(db):
        # Rebuild only mutable record metadata. Raw revision JSON/hash/IDs never change.
        associated_schema = [row["sql"] for row in db.execute("SELECT sql FROM sqlite_master WHERE tbl_name='learning_records' AND type IN ('index','trigger') AND sql IS NOT NULL")]
        db.execute("""CREATE TABLE learning_records_v2(
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            id TEXT NOT NULL, kind TEXT NOT NULL, dataset_id TEXT, plan_id TEXT,
            current_revision_id TEXT, deleted_at INTEGER, PRIMARY KEY(user_id,id))""")
        db.execute("INSERT INTO learning_records_v2 SELECT * FROM learning_records")
        db.execute("DROP TABLE learning_records")
        db.execute("ALTER TABLE learning_records_v2 RENAME TO learning_records")
        for statement in associated_schema:
            db.execute(statement)
        columns = {row["name"] for row in db.execute("PRAGMA table_info(learning_revisions)")}
        if "dataset_id" not in columns:
            db.execute("ALTER TABLE learning_revisions ADD COLUMN dataset_id TEXT")
        if "payload_version" not in columns:
            db.execute("ALTER TABLE learning_revisions ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1")
        rows = db.execute("SELECT v.seq,v.payload,r.dataset_id FROM learning_revisions v JOIN learning_records r ON r.user_id=v.user_id AND r.id=v.record_id").fetchall()
        for row in rows:
            payload = json.loads(row["payload"])
            db.execute("UPDATE learning_revisions SET dataset_id=? WHERE seq=?", (payload.get("datasetId", row["dataset_id"]), row["seq"]))
        receipt_columns = {row["name"] for row in db.execute("PRAGMA table_info(learning_mutation_receipts)")}
        if "response" in receipt_columns:
            db.execute("""CREATE TABLE learning_mutation_receipts_v2(
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                status INTEGER NOT NULL, revision_id TEXT, conflict_revision_id TEXT,
                PRIMARY KEY(user_id,mutation_id))""")
            for row in db.execute("SELECT * FROM learning_mutation_receipts").fetchall():
                response = json.loads(row["response"])
                revision = (response.get("record") or {}).get("revisionId")
                conflict = (response.get("conflict") or {}).get("revisionId")
                if row["status"] not in (200, 409) or not revision and not conflict:
                    raise RuntimeError("Cannot safely migrate an invalid learning receipt")
                db.execute("INSERT INTO learning_mutation_receipts_v2 VALUES(?,?,?,?,?,?)", (row["user_id"], row["mutation_id"], row["fingerprint"], row["status"], revision, conflict))
            db.execute("DROP TABLE learning_mutation_receipts")
            db.execute("ALTER TABLE learning_mutation_receipts_v2 RENAME TO learning_mutation_receipts")

    @staticmethod
    def item(db, user_id, revision):
        if revision is None:
            return None
        row = db.execute("""SELECT v.*,r.kind,r.plan_id FROM learning_revisions v
                            JOIN learning_records r ON r.user_id=v.user_id AND r.id=v.record_id
                            WHERE v.user_id=? AND v.revision_id=?""", (user_id, revision)).fetchone()
        if row is None:
            return None
        return {"id": row["record_id"], "kind": row["kind"], "datasetId": row["dataset_id"], "planId": row["plan_id"],
                "revisionId": row["revision_id"], "baseRevision": row["base_revision_id"], "seq": row["seq"],
                "payload": json.loads(row["payload"]), "contentHash": row["content_hash"], "createdAt": row["created_at"],
                "conflict": bool(row["conflict"]), "deleted": bool(row["deleted"]), "payloadVersion": row["payload_version"]}

    @classmethod
    def replay(cls, db, user_id, receipt):
        record = cls.item(db, user_id, receipt["revision_id"])
        if receipt["status"] == 200:
            return 200, {"record": record, "applied": True}
        return 409, {"error": "手机和电脑各有修改，两份均已保存。", "code": "revision_conflict", "record": record,
                     "conflict": cls.item(db, user_id, receipt["conflict_revision_id"]), "applied": False}

    @staticmethod
    def references(db, user_id, kind, payload, base, record_id):
        if base:
            row = db.execute("SELECT record_id FROM learning_revisions WHERE user_id=? AND revision_id=?", (user_id, base)).fetchone()
            if row is None or row["record_id"] != record_id:
                raise LearningError(422, "基础修订尚未同步或不属于此记录。", "missing_dependency", missingRevisionId=base)
        plan_id = payload.get("planId")
        if kind != "plan":
            plan = db.execute("SELECT kind,deleted_at FROM learning_records WHERE user_id=? AND id=?", (user_id, plan_id)).fetchone()
            if plan is None or plan["kind"] != "plan" or plan["deleted_at"] is not None:
                raise LearningError(422, "请先同步所属计划。", "missing_dependency", missingPlanId=plan_id)
        for field in ("workRevisionId", "parentRevisionId"):
            ref = payload.get(field)
            if ref:
                row = db.execute("""SELECT v.content_hash,v.record_id,v.deleted,v.payload,r.kind,r.plan_id FROM learning_revisions v
                                    JOIN learning_records r ON r.user_id=v.user_id AND r.id=v.record_id
                                    WHERE v.user_id=? AND v.revision_id=?""", (user_id, ref)).fetchone()
                if row is None or row["kind"] not in {"essay", "speaking"} or row["plan_id"] != plan_id or row["deleted"]:
                    raise LearningError(422, "原稿修订尚未同步或引用不正确。", "missing_dependency", missingRevisionId=ref)
                if field == "workRevisionId":
                    if ("inputHash" in payload and payload["inputHash"] != row["content_hash"]) or (payload.get("workId") and payload["workId"] != row["record_id"]):
                        reject("反馈与原稿版本不匹配。")
                    work = json.loads(row["payload"])
                    if kind == "feedback" and payload.get("taskType") == "speaking":
                        validate_speaking_feedback_reference(payload, row["kind"], work)
                    elif kind == "feedback" and WRITING_FEEDBACK_FIELDS.intersection(payload):
                        if row["kind"] != "essay":
                            reject("写作自查必须引用作文原稿。")
                        validate_writing_feedback_reference(payload, work)
                    if row["kind"] == "essay" and work.get("taskType"):
                        if payload.get("taskType") != work["taskType"] and any(field in payload for field in ("bands", "selfBands", "machineBands")):
                            reject("反馈作文类型与原稿不匹配。")
                        for field in ("bands", "selfBands", "machineBands"):
                            if field in payload:
                                validate_task_bands(work["taskType"], payload[field])

    def put(self, user_id, record_id, body, replay_only=False):
        identifier(record_id)
        if not isinstance(body, dict) or set(body) - {"schemaVersion", "revisionId", "mutationId", "baseRevision", "kind", "payload", "deleted"}:
            reject()
        if not {"schemaVersion", "revisionId", "mutationId", "baseRevision", "kind", "payload"}.issubset(body):
            reject()
        if type(body["schemaVersion"]) is not int or body["schemaVersion"] not in (1, 2) or not isinstance(body["kind"], str) or body["kind"] not in KINDS:
            reject("学习协议或记录类型不支持。")
        if "deleted" in body and not isinstance(body["deleted"], bool):
            reject()
        rev, mutation = revision_id(body["revisionId"]), revision_id(body["mutationId"])
        base = revision_id(body["baseRevision"]) if body["baseRevision"] is not None else None
        kind, deleted = body["kind"], body.get("deleted", False)
        try:
            request_text = encoded(body)
            request_bytes = request_text.encode("utf-8")
        except (ValueError, UnicodeError, TypeError):
            reject("学习请求包含无效JSON文本。")
        if len(request_bytes) > MAX_WRITE:
            reject("单条学习记录超过128 KiB。", 413)
        fingerprint = hashlib.sha256((record_id + "\n" + request_text).encode()).hexdigest()
        now = int(time.time() * 1000)
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM learning_mutation_receipts WHERE user_id=? AND mutation_id=?", (user_id, mutation)).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    reject("同一提交标识不能用于不同内容。")
                return self.replay(db, user_id, old)
            if replay_only:
                raise LearningError(426, "学习协议已更新，请更新客户端；本机成果和待上传请求应保留。", "unsupported_learning_protocol")
            if body["schemaVersion"] != PROTOCOL_VERSION:
                reject("历史请求尚未获服务端接收，请保留原文并修复为新修订后重试。")
            payload = validate_payload(kind, body["payload"], record_id, deleted)
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
                dataset_id = payload.get("datasetId")
                plan_id = record_id if kind == "plan" else payload["planId"]
                if record and record["plan_id"] != plan_id:
                    reject("记录归属不能变更。")
            current = record["current_revision_id"] if record else None
            conflict = current != base
            if not record:
                db.execute("INSERT INTO learning_records(user_id,id,kind,dataset_id,plan_id) VALUES(?,?,?,?,?)", (user_id, record_id, kind, dataset_id, plan_id))
            db.execute("""INSERT INTO learning_revisions(revision_id,user_id,record_id,base_revision_id,payload,content_hash,created_at,conflict,deleted,dataset_id,payload_version)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (rev, user_id, record_id, base, encoded(payload), content_hash(kind, payload), now, int(conflict), int(deleted), dataset_id, PROTOCOL_VERSION))
            incoming = self.item(db, user_id, rev)
            if conflict:
                status, response = 409, {"error": "手机和电脑各有修改，两份均已保存。", "code": "revision_conflict", "record": self.item(db, user_id, current), "conflict": incoming, "applied": False}
            else:
                db.execute("UPDATE learning_records SET current_revision_id=?,deleted_at=?,dataset_id=? WHERE user_id=? AND id=?", (rev, now if deleted else None, dataset_id, user_id, record_id))
                status, response = 200, {"record": incoming, "applied": True}
            db.execute("INSERT INTO learning_mutation_receipts VALUES(?,?,?,?,?,?)", (user_id, mutation, fingerprint, status,
                       response["record"]["revisionId"] if response.get("record") else None,
                       response["conflict"]["revisionId"] if response.get("conflict") else None))
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
        handler.send_json(200, {"vocabSnapshot": 2, "learningRecords": PROTOCOL_VERSION, "learningWriteEnabled": handler.server.learning_write_enabled})
        return True
    legacy = path.startswith("/api/learning/v1/")
    prefix = "/api/learning/v1/" if legacy else "/api/learning/v2/"
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
        status, response = store.put(user["id"], unquote(tail[len("records/"):]), handler.body(maximum=MAX_WRITE), replay_only=legacy)
        handler.send_json(status, response)
        return True
    if method != "GET":
        raise LearningError(404, "学习接口不存在。", "not_found")
    if legacy:
        raise LearningError(426, "学习协议已更新，请更新客户端；本机成果和待上传请求应保留。", "unsupported_learning_protocol")
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
