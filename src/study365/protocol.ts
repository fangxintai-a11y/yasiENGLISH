/** Independent learning records. Never add these fields to the vocabulary snapshot. */
export const LEARNING_KINDS = ["plan", "mission", "attempt", "essay", "speaking", "feedback", "assessment"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];
export type LearningPayload = Record<string, unknown>;

export interface Revision {
  id: string;
  kind: LearningKind;
  datasetId: string;
  planId: string | null;
  revisionId: string;
  baseRevision: string | null;
  seq: number;
  payload: LearningPayload;
  contentHash: string;
  createdAt: number;
  conflict: boolean;
  deleted: boolean;
}
export interface WriteRequest {
  schemaVersion: 1;
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
}
export const emptyScope = (): LearningScope => ({ heads: {}, revisions: {}, outbox: [], cursor: 0 });
export type SyncStatus = "local" | "syncing" | "synced" | "offline" | "signed-out" | "unavailable" | "error";

const common = ["datasetId", "planId"];
const fields: Record<LearningKind, readonly string[]> = {
  plan: ["startDate", "timeZone", "curriculumVersion", "studyBudgetMinutes", "targetBand", "sectionMinimum", "enabled", "syllabusUnit", "materialLevel", "title", "pauseIntervals"],
  mission: ["date", "day", "taskId", "missionId", "skill", "status", "plannedMinutes", "actualMinutes", "timeSource"],
  attempt: ["date", "day", "taskId", "contentId", "contentVersion", "skill", "answers", "correct", "score", "total", "actualMinutes", "elapsedSeconds", "conditions", "replayed", "viewedTranscript", "firstAttempt", "isCheckpoint", "note"],
  essay: ["date", "day", "taskId", "contentId", "contentVersion", "prompt", "text", "wordCount", "parentRevisionId"],
  speaking: ["date", "day", "taskId", "contentId", "contentVersion", "prompt", "transcript", "durationSeconds", "recordingId", "recordingDevice", "parentRevisionId"],
  feedback: ["workId", "workRevisionId", "inputHash", "rubricVersion", "source", "sourceText", "assessedAt", "text", "bands"],
  assessment: ["date", "day", "kind", "source", "materialId", "score", "total", "bands", "scores", "conditions", "note", "notes"],
};
const sensitive = /^(?:apikey|aikey|token|accesstoken|refreshtoken|password|secret|authorization|cookie)$/;
const secret = /\b(?:sk-ant-|sk-proj-|ghp_|gho_)[A-Za-z0-9_-]{10,}/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isIdentifier = (v: unknown): v is string => typeof v === "string" && identifier.test(v);
export const isRevisionId = (v: unknown): v is string => typeof v === "string" && uuid.test(v);
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function safe(value: unknown, depth = 0): void {
  if (depth > 6) throw new Error("学习记录嵌套过深。");
  if (typeof value === "string") {
    if (value.length > 20000 || secret.test(value)) throw new Error("学习文本过长或包含凭据，未保存。");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("学习记录包含无效数字。");
  } else if (Array.isArray(value)) {
    if (value.length > 300) throw new Error("学习记录条目过多。");
    value.forEach((item) => safe(item, depth + 1));
  } else if (isObject(value)) {
    if (Object.keys(value).length > 300) throw new Error("学习记录字段过多。");
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
      if (sensitive.test(normalized) || normalized.includes("apikey") || ["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("学习记录不能包含密码或 API Key。");
      safe(item, depth + 1);
    }
  } else if (value !== null && typeof value !== "boolean") throw new Error("学习记录包含不支持的数据。");
}

export function validatePayload(kind: LearningKind, payload: LearningPayload, deleted = false): void {
  if (!LEARNING_KINDS.includes(kind) || !isObject(payload)) throw new Error("学习记录类型不正确。");
  if (Object.keys(payload).some((key) => !common.includes(key) && !fields[kind].includes(key))) throw new Error("学习记录包含不支持的字段。");
  safe(payload);
  if (deleted) {
    if (Object.keys(payload).length) throw new Error("删除记录必须使用空内容。");
    return;
  }
  if (!isIdentifier(payload.datasetId) || !isIdentifier(payload.planId)) throw new Error("学习记录缺少词库或计划标识。");
  const textLimits: Record<string, number> = { prompt: 8000, note: 4000, notes: 4000, sourceText: 1000, title: 300, source: 200, rubricVersion: 120, recordingDevice: 200, contentVersion: 120, materialLevel: 80, timeZone: 80, curriculumVersion: 120, kind: 80, timeSource: 40, status: 40, skill: 40 };
  const nullable = new Set(["sectionMinimum", "parentRevisionId", "recordingId", "recordingDevice", "assessedAt"]);
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
      if (typeof value === "string" ? value.length > 2000 : !isObject(value) || Object.entries(value).some(([k, v]) => k === "replays" ? !Number.isInteger(v) || Number(v) < 0 || Number(v) > 1000 : !["transcriptViewed", "replayed", "viewedTranscript", "firstAttempt", "unseen", "timed"].includes(k) || typeof v !== "boolean")) throw new Error("作答条件格式不正确。");
    }
    if (["bands", "scores"].includes(key) && (!isObject(value) || Object.entries(value).some(([k, v]) => !["listening", "reading", "writing", "speaking", "taskResponse", "coherence", "lexical", "grammar", "fluency", "pronunciation"].includes(k) || (v !== null && (typeof v !== "number" || v < 0 || v > 9))))) throw new Error("测评分数格式不正确。");
    if (key === "pauseIntervals" && (!Array.isArray(value) || value.some((v) => !isObject(v) || Object.keys(v).sort().join() !== "end,start" || !validDate(v.start) || !validDate(v.end) || v.end < v.start))) throw new Error("暂停日期格式不正确。");
  }
  if (kind === "plan" && (typeof payload.startDate !== "string" || typeof payload.studyBudgetMinutes !== "number" || ![120, 150, 180].includes(payload.studyBudgetMinutes))) throw new Error("计划缺少开始日期或时间预算。");
  if (kind === "essay" && typeof payload.text !== "string") throw new Error("作文缺少正文。");
  if (kind === "speaking" && typeof payload.transcript !== "string") throw new Error("口语记录缺少转写字段。");
  if (kind === "feedback" && (!isRevisionId(payload.workRevisionId) || typeof payload.inputHash !== "string" || typeof payload.text !== "string" || typeof payload.source !== "string")) throw new Error("反馈缺少原稿引用或来源。");
  if (kind === "mission" && (!isIdentifier(payload.taskId ?? payload.missionId) || !["not_started", "in_progress", "completed", "partial", "minimum", "skipped"].includes(String(payload.status)))) throw new Error("任务标识或状态不正确。");
  if (kind === "attempt" && (!isIdentifier(payload.contentId) || !Array.isArray(payload.answers) || typeof payload.skill !== "string")) throw new Error("练习缺少材料或作答。");
  if (typeof payload.correct === "number" && typeof payload.total === "number" && payload.correct > payload.total) throw new Error("正确数不能超过总题数。");
}

export function decodeRevision(value: unknown): Revision {
  if (!isObject(value) || !isIdentifier(value.id) || !LEARNING_KINDS.includes(value.kind as LearningKind) || !isIdentifier(value.datasetId)
    || (value.planId !== null && !isIdentifier(value.planId)) || !isRevisionId(value.revisionId)
    || (value.baseRevision !== null && !isRevisionId(value.baseRevision)) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1
    || !isObject(value.payload) || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || typeof value.conflict !== "boolean" || typeof value.deleted !== "boolean")
    throw new Error("学习服务返回了无效的修订。");
  // The protocol always supplies the scope in metadata; older allowed payloads may omit datasetId.
  if ((!value.deleted && value.payload.datasetId !== undefined && value.payload.datasetId !== value.datasetId) || (!value.deleted && value.payload.planId !== undefined && value.payload.planId !== value.planId)) throw new Error("学习修订的归属不一致。");
  const payload = value.deleted ? value.payload : { ...value.payload, datasetId: value.datasetId, planId: value.planId };
  validatePayload(value.kind as LearningKind, payload, value.deleted);
  return { ...value, payload } as unknown as Revision;
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
