/** Independent learning records. Never add these fields to the vocabulary snapshot. */
import { WRITING_ERROR_CAUSES, writingChecklistIds } from "./writingChecklist";
export const LEARNING_KINDS = ["plan", "mission", "attempt", "essay", "speaking", "feedback", "assessment"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];
export type LearningPayload = Record<string, unknown>;
export const LEARNING_PROTOCOL = 2;
export const SECTION_TARGETS = Object.freeze({ listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 });
export const GATE_TARGETS = Object.freeze({
  G1: { overall: 6.5, listening: 7, reading: 7, writing: 6, speaking: 6 },
  G2: { overall: 7, listening: 7.5, reading: 7.5, writing: 6.5, speaking: 6.5 },
  G3: { overall: 7.5, listening: 8, reading: 8, writing: 7, speaking: 7 },
  G4: { overall: 8, listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 },
});
export const SCORE_SOURCES = ["self", "rules", "ai", "human", "official"] as const;
export const ERROR_CAUSES = ["synonym-miss", "locating-error", "spelling", "time-pressure", "word-limit", "vocab-unknown", "misread-question", "tfng-inference", "grammar", "lexical-misuse", "coherence", "task-response", "task-achievement", "fluency-pause", "pronunciation", "other"] as const;

export interface Revision {
  id: string;
  kind: LearningKind;
  datasetId: string | null;
  planId: string | null;
  revisionId: string;
  baseRevision: string | null;
  seq: number;
  payload: LearningPayload;
  contentHash: string;
  createdAt: number;
  conflict: boolean;
  deleted: boolean;
  payloadVersion?: 1 | 2;
}
export interface WriteRequest {
  /** Version 1 is retained only for unchanged pending requests and durable receipt replay. */
  schemaVersion: 1 | 2;
  revisionId: string;
  mutationId: string;
  baseRevision: string | null;
  kind: LearningKind;
  payload: LearningPayload;
  deleted?: boolean;
}
export interface QueuedMutation {
  recordId: string;
  body: WriteRequest;
  local: Revision;
  createdAt: number;
}
export interface LearningScope {
  heads: Record<string, Revision>;
  revisions: Record<string, Revision>;
  outbox: QueuedMutation[];
  cursor: number;
  quarantine: QuarantinedMutation[];
}
export interface QuarantinedMutation extends QueuedMutation { error: string; code: string; at: number }
export const emptyScope = (): LearningScope => ({ heads: {}, revisions: {}, outbox: [], cursor: 0, quarantine: [] });
export type SyncStatus = "local" | "syncing" | "synced" | "offline" | "signed-out" | "unavailable" | "error" | "partial";

const common = ["datasetId", "planId"];
const fields: Record<LearningKind, readonly string[]> = {
  plan: ["startDate", "timeZone", "curriculumVersion", "studyBudgetMinutes", "targetBand", "sectionTargets", "enabled", "syllabusUnit", "materialLevel", "title", "pauseIntervals"],
  mission: ["date", "day", "taskId", "missionId", "skill", "status", "plannedMinutes", "actualMinutes", "timeSource"],
  attempt: ["date", "day", "taskId", "contentId", "contentVersion", "skill", "answers", "correct", "score", "total", "actualMinutes", "elapsedSeconds", "conditions", "replayed", "viewedTranscript", "firstAttempt", "isCheckpoint", "note", "questionResults"],
  essay: ["date", "day", "taskId", "contentId", "contentVersion", "prompt", "text", "wordCount", "parentRevisionId", "taskType", "scope", "stage", "elapsedSeconds", "conditions", "sourceRef"],
  speaking: ["date", "day", "taskId", "contentId", "contentVersion", "prompt", "transcript", "durationSeconds", "recordingId", "recordingDevice", "parentRevisionId"],
  feedback: ["workId", "workRevisionId", "inputHash", "rubricVersion", "source", "sourceText", "assessedAt", "text", "bands", "taskType", "errorCauses", "spellingCheck", "checklist"],
  assessment: ["date", "day", "kind", "source", "materialId", "score", "total", "bands", "scores", "conditions", "note", "notes", "gateId", "targets", "consecutiveIndex", "scoreSources", "weekIndex", "workId", "workRevisionId", "inputHash", "taskType", "selfBands", "machineBands", "machineSource"],
};
const sensitive = /^(?:apikey|aikey|token|accesstoken|refreshtoken|password|secret|authorization|cookie)$/;
const secret = /\b(?:sk-ant-|sk-proj-|ghp_|gho_)[A-Za-z0-9_-]{10,}/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isIdentifier = (v: unknown): v is string => typeof v === "string" && identifier.test(v);
export const isRevisionId = (v: unknown): v is string => typeof v === "string" && uuid.test(v);
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function safe(value: unknown, depth = 0, path = ""): void {
  if (depth > 6) throw new Error("学习记录嵌套过深。");
  if (typeof value === "string") {
    if (value.length > 20000 || secret.test(value)) throw new Error("学习文本过长或包含凭据，未保存。");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("学习记录包含无效数字。");
  } else if (Array.isArray(value)) {
    if (value.length > (path === "spellingCheck.items" ? 20000 : 300)) throw new Error("学习记录条目过多。");
    value.forEach((item) => safe(item, depth + 1, `${path}[]`));
  } else if (isObject(value)) {
    if (Object.keys(value).length > 300) throw new Error("学习记录字段过多。");
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
      if (sensitive.test(normalized) || normalized.includes("apikey") || ["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("学习记录不能包含密码或 API Key。");
      safe(item, depth + 1, path ? `${path}.${key}` : key);
    }
  } else if (value !== null && typeof value !== "boolean") throw new Error("学习记录包含不支持的数据。");
}

function validate(kind: LearningKind, payload: LearningPayload, deleted = false, legacy = false): void {
  if (!LEARNING_KINDS.includes(kind) || !isObject(payload)) throw new Error("学习记录类型不正确。");
  if (Object.keys(payload).some((key) => !common.includes(key) && !fields[kind].includes(key) && !(legacy && kind === "plan" && key === "sectionMinimum"))) throw new Error("学习记录包含不支持的字段。");
  safe(payload);
  if (deleted) {
    if (Object.keys(payload).length) throw new Error("删除记录必须使用空内容。");
    return;
  }
  if ((payload.datasetId !== undefined && payload.datasetId !== null && !isIdentifier(payload.datasetId)) || !isIdentifier(payload.planId)) throw new Error("学习记录缺少计划标识或来源词库无效。");
  const textLimits: Record<string, number> = { prompt: 8000, note: 4000, notes: 4000, sourceText: 1000, sourceRef: 300, title: 300, source: 200, rubricVersion: 120, recordingDevice: 200, contentVersion: 120, materialLevel: 80, timeZone: 80, curriculumVersion: 120, kind: 80, timeSource: 40, status: 40, skill: 40, taskType: 20, gateId: 20, machineSource: 20 };
  const nullable = new Set(["datasetId", "parentRevisionId", "recordingId", "recordingDevice", "assessedAt", ...(legacy ? ["sectionMinimum"] : [])]);
  for (const [key, value] of Object.entries(payload)) {
    if (value === null && nullable.has(key)) continue;
    if (key in textLimits && !(key === "conditions" && isObject(value)) && (typeof value !== "string" || value.length > textLimits[key])) throw new Error("学习文本的格式或长度不正确。");
    if (["datasetId", "planId", "taskId", "missionId", "contentId", "materialId", "recordingId", "workId"].includes(key) && !isIdentifier(value)) throw new Error("学习记录标识无效。");
    if (["workRevisionId", "parentRevisionId"].includes(key) && !isRevisionId(value)) throw new Error("作品修订标识无效。");
    if (key === "inputHash" && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) throw new Error("作品校验值无效。");
    if (["date", "startDate"].includes(key)) {
      if (!validDate(value)) throw new Error("学习日期无效。");
    }
    if (["enabled", "replayed", "viewedTranscript", "firstAttempt", "isCheckpoint"].includes(key) && typeof value !== "boolean") throw new Error("学习状态格式不正确。");
    const numeric: Record<string, [number, number]> = { day: [1, 365], syllabusUnit: [1, 365], plannedMinutes: [0, 1440], actualMinutes: [0, 1440], durationSeconds: [0, 86400], elapsedSeconds: [0, 86400], wordCount: [0, 100000], correct: [0, 100000], score: [0, 100000], total: [0, 100000], targetBand: [0, 9], sectionMinimum: [0, 9] };
    if (key in numeric && (typeof value !== "number" || !Number.isFinite(value) || value < numeric[key][0] || value > numeric[key][1] || (["day", "syllabusUnit"].includes(key) && !Number.isInteger(value)))) throw new Error("学习记录数值超出范围。");
    if (key === "timeZone") { try { new Intl.DateTimeFormat("en", { timeZone: String(value) }); } catch { throw new Error("计划时区无效。"); } }
    if (key === "answers" && (!Array.isArray(value) || value.some((a) => a !== null && typeof a !== "string" && typeof a !== "number"))) throw new Error("作答格式不正确。");
    if (key === "conditions") {
      if (kind === "essay" ? !isObject(value) || Object.entries(value).some(([key, item]) => !["timed", "firstAttempt", "unseen"].includes(key) || typeof item !== "boolean") : typeof value === "string" ? value.length > 2000 : !isObject(value) || Object.entries(value).some(([k, v]) => k === "replays" ? !Number.isInteger(v) || Number(v) < 0 || Number(v) > 1000 : !["transcriptViewed", "replayed", "viewedTranscript", "firstAttempt", "unseen", "timed"].includes(k) || typeof v !== "boolean")) throw new Error("作答条件格式不正确。");
    }
    if (["bands", "scores", "selfBands", "machineBands"].includes(key)) validateBands(value, legacy);
    if (key === "pauseIntervals" && (!Array.isArray(value) || value.some((v) => !isObject(v) || Object.keys(v).sort().join() !== "end,start" || !validDate(v.start) || !validDate(v.end) || v.end < v.start))) throw new Error("暂停日期格式不正确。");
  }
  if (kind === "plan" && typeof payload.startDate !== "string") throw new Error("计划缺少开始日期。");
  if (kind === "plan" && !legacy) {
    if (!sameNumbers(payload.sectionTargets, SECTION_TARGETS)) throw new Error("四科目标必须为听8.5、读8.5、写7.5、说7.5。");
    if (payload.targetBand !== 8) throw new Error("项目目标固定为雅思总分8.0。");
    if (payload.studyBudgetMinutes !== 120) throw new Error("每日学习时长固定为 120 分钟。");
  }
  if (kind === "plan" && legacy && (typeof payload.studyBudgetMinutes !== "number" || ![120, 150, 180].includes(payload.studyBudgetMinutes))) throw new Error("历史计划时间预算无效。");
  if (kind === "essay" && typeof payload.text !== "string") throw new Error("作文缺少正文。");
  if (kind === "essay" && !legacy && !["task1", "task2"].includes(String(payload.taskType))) throw new Error("作文必须明确 task1 或 task2。");
  if (kind === "essay" && payload.scope !== undefined && payload.scope !== "full" && payload.scope !== "paragraph") throw new Error("作文练习范围无效。");
  if (kind === "essay" && payload.stage !== undefined && payload.stage !== "draft" && payload.stage !== "submitted") throw new Error("作文保存阶段无效。");
  if (kind === "speaking" && typeof payload.transcript !== "string") throw new Error("口语记录缺少转写字段。");
  if (kind === "feedback" && (!isRevisionId(payload.workRevisionId) || typeof payload.inputHash !== "string" || typeof payload.text !== "string" || typeof payload.source !== "string")) throw new Error("反馈缺少原稿引用或来源。");
  if (kind === "mission" && (!isIdentifier(payload.taskId ?? payload.missionId) || !["not_started", "in_progress", "completed", "partial", "minimum", "skipped"].includes(String(payload.status)))) throw new Error("任务标识或状态不正确。");
  if (kind === "attempt" && (!isIdentifier(payload.contentId) || !Array.isArray(payload.answers) || typeof payload.skill !== "string")) throw new Error("练习缺少材料或作答。");
  if (typeof payload.correct === "number" && typeof payload.total === "number" && payload.correct > payload.total) throw new Error("正确数不能超过总题数。");
  if (kind === "feedback") validateWritingFeedback(payload);
  if (legacy) return;
  if ((kind === "feedback" || kind === "assessment") && !SCORE_SOURCES.includes(payload.source as typeof SCORE_SOURCES[number])) throw new Error("评分来源必须为 self、rules、ai、human 或 official。");
  if (payload.taskType !== undefined && !["task1", "task2"].includes(String(payload.taskType))) throw new Error("作文任务类型无效。");
  if (kind === "feedback" || kind === "assessment") {
    for (const field of ["bands", "selfBands", "machineBands"]) if (payload[field] !== undefined) validateTaskBands(payload.taskType, payload[field]);
  }
  if (kind === "attempt" && payload.questionResults !== undefined) {
    if (!Array.isArray(payload.questionResults)) throw new Error("逐题错因格式无效。");
    const ids = new Set<string>();
    for (const result of payload.questionResults) {
      if (!isObject(result) || Object.keys(result).some((key) => !["questionId", "correct", "confidence", "errorCause", "note"].includes(key)) || !isIdentifier(result.questionId) || typeof result.correct !== "boolean" || !["sure", "unsure"].includes(String(result.confidence))) throw new Error("逐题错因格式无效。");
      if (ids.has(result.questionId)) throw new Error("逐题错因题号不能重复。");
      ids.add(result.questionId);
      if (result.correct ? result.errorCause !== null : !ERROR_CAUSES.includes(result.errorCause as typeof ERROR_CAUSES[number])) throw new Error("错因必须使用枚举编码，正确答案的错因为空。");
      if (result.note !== undefined && (typeof result.note !== "string" || result.note.length > 4000)) throw new Error("错因说明格式无效。");
      if (result.errorCause === "other" && !String(result.note ?? payload.note ?? "").trim()) throw new Error("其他错因必须填写说明。");
    }
  }
  if (kind === "assessment") validateAssessment(payload);
}

const writingFeedbackFields = ["errorCauses", "spellingCheck", "checklist"] as const;
function validateWritingFeedback(payload: LearningPayload): void {
  if (!writingFeedbackFields.some((key) => Object.hasOwn(payload, key))) return;
  if (payload.taskType !== "task1" && payload.taskType !== "task2") throw new Error("写作自查必须明确任务类型。");
  if (payload.errorCauses !== undefined) {
    const causes = payload.errorCauses;
    if (!Array.isArray(causes) || causes.some((cause) => !WRITING_ERROR_CAUSES.includes(cause))) throw new Error("写作错因必须使用适用的枚举编码。");
    if (new Set(causes).size !== causes.length) throw new Error("写作错因不能重复。");
    if (payload.taskType === "task1" && causes.includes("task-response")) throw new Error("Task 1不能使用 task-response 错因。");
    if (payload.taskType === "task2" && causes.includes("task-achievement")) throw new Error("Task 2不能使用 task-achievement 错因。");
    if (causes.includes("other") && (typeof payload.text !== "string" || !payload.text.trim())) throw new Error("其他错因必须在反馈正文填写说明。");
  }
  if (payload.spellingCheck !== undefined) {
    const check = payload.spellingCheck;
    if (!isObject(check) || Object.keys(check).sort().join() !== "count,items,status" || check.status !== "unchecked" && check.status !== "checked" || !Array.isArray(check.items)) throw new Error("拼写检查格式无效。");
    const positions = new Set<string>();
    for (const item of check.items) {
      if (!isObject(item) || Object.keys(item).sort().join() !== "confirmed,end,start,text" || !Number.isSafeInteger(item.start) || Number(item.start) < 0 || !Number.isSafeInteger(item.end) || Number(item.end) <= Number(item.start) || typeof item.text !== "string" || !item.text.length || typeof item.confirmed !== "boolean") throw new Error("拼写位置或片段格式无效。");
      const key = `${item.start}:${item.end}`;
      if (positions.has(key)) throw new Error("拼写位置不能重复。");
      positions.add(key);
    }
    if (check.status === "unchecked" ? check.count !== null : typeof check.count !== "number" || !Number.isInteger(check.count) || check.count < 0 || check.count !== check.items.filter((item) => item.confirmed).length) throw new Error("拼写检查数量必须匹配确认条数；未检查时为空。");
  }
  if (payload.checklist !== undefined && (!isObject(payload.checklist) || Object.entries(payload.checklist).some(([key, value]) => !writingChecklistIds(payload.taskType as "task1" | "task2").includes(key) || value !== null && typeof value !== "boolean"))) throw new Error("自查清单条目或状态无效。");
}

/** UTF-16 offsets follow textarea selection/slice; never normalize the source. */
export function validateWritingFeedbackReference(feedback: LearningPayload, work: LearningPayload): void {
  validateWritingFeedback(feedback);
  if (!writingFeedbackFields.some((key) => Object.hasOwn(feedback, key))) return;
  if (typeof work.text !== "string" || (work.taskType !== "task1" && work.taskType !== "task2") || feedback.taskType !== work.taskType) throw new Error("写作自查任务类型与原稿不匹配。");
  if (!isObject(feedback.spellingCheck) || !Array.isArray(feedback.spellingCheck.items)) return;
  const text = work.text;
  const boundary = (index: number) => !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]));
  for (const item of feedback.spellingCheck.items) {
    const start = Number(item.start), end = Number(item.end);
    if (end > text.length || !boundary(start) || !boundary(end) || text.slice(start, end) !== item.text) throw new Error("拼写片段与原稿不一致。");
  }
}

function sameNumbers(value: unknown, expected: Record<string, number>): boolean {
  return isObject(value) && Object.keys(value).sort().join() === Object.keys(expected).sort().join() && Object.entries(expected).every(([key, number]) => value[key] === number);
}
function validateBands(value: unknown, legacy = false): void {
  if (!isObject(value) || Object.entries(value).some(([key, number]) => !["listening", "reading", "writing", "speaking", "taskAchievement", "taskResponse", "coherence", "lexical", "grammar", "fluency", "pronunciation"].includes(key) || (number !== null && (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 9 || (!legacy && !Number.isInteger(number * 2)))))) throw new Error("测评分数格式不正确。");
}
function validateTaskBands(taskType: unknown, bands: unknown): void {
  if (!isObject(bands)) return;
  if (("taskAchievement" in bands || "taskResponse" in bands) && !["task1", "task2"].includes(String(taskType))) throw new Error("作文评分必须明确任务类型。");
  if (taskType === "task1" && "taskResponse" in bands) throw new Error("Task 1只能使用 taskAchievement。");
  if (taskType === "task2" && "taskAchievement" in bands) throw new Error("Task 2只能使用 taskResponse。");
}
function validateAssessment(payload: LearningPayload): void {
  if (!["baseline", "weekly-mock", "gate", "weekly-calibration", "official"].includes(String(payload.kind))) throw new Error("测评类型无效。");
  if (payload.kind === "gate") {
    if (!validDate(payload.date)) throw new Error("门槛记录必须包含有效日期。");
    const target = Object.hasOwn(GATE_TARGETS, String(payload.gateId)) ? GATE_TARGETS[payload.gateId as keyof typeof GATE_TARGETS] : undefined;
    if (!target || !sameNumbers(payload.targets, target)) throw new Error("门槛目标与G1–G4定义不一致。");
    if (payload.gateId === "G3" ? ![1, 2].includes(Number(payload.consecutiveIndex)) || typeof payload.consecutiveIndex !== "number" : payload.consecutiveIndex !== undefined && payload.consecutiveIndex !== 1) throw new Error("门槛连续测评序号无效。");
    const keys = Object.keys(SECTION_TARGETS);
    if (!isObject(payload.scores) || Object.keys(payload.scores).sort().join() !== keys.sort().join()) throw new Error("门槛必须保存四科实际分，未评估填空值。");
    if (!isObject(payload.scoreSources) || Object.keys(payload.scoreSources).sort().join() !== keys.sort().join()) throw new Error("门槛必须保存四科评分来源。");
    for (const key of keys) {
      const source = payload.scoreSources[key];
      if (payload.scores[key] === null ? source !== null : !SCORE_SOURCES.includes(source as typeof SCORE_SOURCES[number])) throw new Error("门槛分数与来源不一致。");
      if (["writing", "speaking"].includes(key) && payload.scores[key] !== null && !["human", "official"].includes(String(source))) throw new Error("写作和口语门槛分必须来自真人或正式成绩。");
      if (payload.gateId === "G4" && payload.scores[key] !== null && source !== "official") throw new Error("G4必须保存正式考试来源。");
    }
    if (payload.gateId === "G4" && payload.source !== "official") throw new Error("G4必须保存正式考试来源。");
  }
  if (payload.kind === "weekly-calibration") {
    if (!Number.isInteger(payload.weekIndex) || Number(payload.weekIndex) < 1 || Number(payload.weekIndex) > 52) throw new Error("真人校准周序必须在1至52之间。");
    if (!isRevisionId(payload.workRevisionId)) throw new Error("每周校准必须引用原稿修订。");
    if (!isObject(payload.bands)) throw new Error("每周校准必须保存四项分数。");
    const expected = payload.taskType === "task1" ? ["taskAchievement", "coherence", "lexical", "grammar"] : payload.taskType === "task2" ? ["taskResponse", "coherence", "lexical", "grammar"] : ["fluency", "lexical", "grammar", "pronunciation"];
    if (Object.keys(payload.bands).sort().join() !== expected.sort().join()) throw new Error("每周校准必须保存对应作品的四项分数。");
    if (["human", "official"].includes(String(payload.source)) && Object.values(payload.bands).some((value) => value === null)) throw new Error("真人校准必须保存四项有效分数。");
    if (payload.machineSource !== undefined && !["ai", "rules"].includes(String(payload.machineSource))) throw new Error("机器估分来源无效。");
    if (payload.machineBands !== undefined && !["ai", "rules"].includes(String(payload.machineSource))) throw new Error("机器估分必须明确来源。");
  }
  if (payload.kind === "official" && (payload.source !== "official" || !validDate(payload.date) || !isObject(payload.scores) || Object.keys(payload.scores).sort().join() !== Object.keys(SECTION_TARGETS).sort().join() || Object.values(payload.scores).some((value) => value === null))) throw new Error("正式成绩必须包含日期、正式来源和完整四科分数。");
}
export function validatePayload(kind: LearningKind, payload: LearningPayload, deleted = false): void { validate(kind, payload, deleted); }
export function validateStoredPayload(kind: LearningKind, payload: LearningPayload, deleted = false): void { validate(kind, payload, deleted, true); }
/** Business-only projection. Never replace a raw revision/outbox body with this view. */
export function projectLearningPayload(kind: LearningKind, payload: LearningPayload): LearningPayload {
  if (kind === "essay") return { ...payload, scope: payload.scope === undefined ? "full" : payload.scope, stage: payload.stage === undefined ? "submitted" : payload.stage };
  if (kind !== "plan") return { ...payload };
  const { sectionMinimum: _legacyMinimum, ...rest } = payload;
  return { ...rest, targetBand: 8, sectionTargets: { ...SECTION_TARGETS }, studyBudgetMinutes: 120 };
}

export function decodeRevision(value: unknown): Revision {
  if (!isObject(value) || !isIdentifier(value.id) || !LEARNING_KINDS.includes(value.kind as LearningKind) || (value.datasetId !== null && !isIdentifier(value.datasetId))
    || (value.planId !== null && !isIdentifier(value.planId)) || !isRevisionId(value.revisionId)
    || (value.baseRevision !== null && !isRevisionId(value.baseRevision)) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1
    || !isObject(value.payload) || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || typeof value.conflict !== "boolean" || typeof value.deleted !== "boolean"
    || (value.payloadVersion !== undefined && value.payloadVersion !== 1 && value.payloadVersion !== 2))
    throw new Error("学习服务返回了无效的修订。");
  if ((!value.deleted && value.payload.datasetId !== undefined && value.payload.datasetId !== value.datasetId) || (!value.deleted && value.payload.planId !== undefined && value.payload.planId !== value.planId)) throw new Error("学习修订的归属不一致。");
  const checked = value.deleted ? value.payload : { ...value.payload, planId: value.planId };
  const payloadVersion = value.payloadVersion ?? 1;
  if (payloadVersion === 2) validatePayload(value.kind as LearningKind, checked, value.deleted);
  else validateStoredPayload(value.kind as LearningKind, checked, value.deleted);
  // Preserve exact immutable wire content: projected legacy goals belong in a separate business view.
  return { ...value, payloadVersion } as unknown as Revision;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as LearningPayload)[key])}`).join(",")}}`;
}
export async function hashPayload(kind: LearningKind, payload: LearningPayload): Promise<string> {
  const text = kind === "essay" ? String(payload.text ?? "") : kind === "speaking" ? String(payload.transcript ?? "") : canonical(payload);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}
