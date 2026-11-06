import { replaceRevisionReferences } from './revisionReferences';
import { useSyncExternalStore } from "react";
import { getCloudState, subscribeCloudState } from "../store/cloudSync";
import { store } from "../store/store";
import { learningRequest, LearningApiError } from "./api";
import { importRecordingEntries, listRecordings, migrateGuestScopes, migrateUserScopes, orderMutations, putRecording, readRecording, readScope, updateScope, userScopeKey, type RecordingMetadata } from "./db";
import { decodeRevision, hashPayload, isIdentifier, isObject, projectLearningPayload, validatePayload, LEARNING_PROTOCOL, type LearningKind, type LearningPayload, type LearningScope, type QuarantinedMutation, type Revision, type SyncStatus, type WriteRequest } from "./protocol";
import { decodeRecordingArchive, encodeRecordingArchive } from "./recordings";
import { LearningSyncEngine } from "./syncEngine";

export type { Revision as LearningRecord } from "./protocol";
export interface LearningState {
  ready: boolean;
  records: Revision[];
  conflicts: Revision[];
  syncStatus: SyncStatus;
  error: string | null;
  pending: number;
  userId: string | null;
  quarantined: number;
  recordingsVersion: number;
}
interface Context { scope: string; userId: string | null; datasetId: string; epoch: number }
const listeners = new Set<() => void>();
let state: LearningState = { ready: false, records: [], conflicts: [], syncStatus: "local", error: null, pending: 0, userId: null, quarantined: 0, recordingsVersion: 0 };
let context: Context = { scope: "guest", userId: null, datasetId: "word-atlas-open", epoch: 0 };
let ready: Promise<void> = Promise.resolve();
let started = false;
let engine: LearningSyncEngine | null = null;
let timer: number | undefined;
let channel: BroadcastChannel | null = null;
let lastSyncAttemptAt = 0;
const scopeKey = (userId: string | null, _datasetId?: string) => userId ? userScopeKey(userId) : "guest";
const active = (c: Context) => c.epoch === context.epoch && c.scope === context.scope;
const assertActive = (c: Context) => { if (!active(c)) throw new Error("账号已经切换，此操作未应用到其他账号。"); };
const publish = (patch: Partial<LearningState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };

async function refresh(c = context) {
  const data = await readScope(c.scope);
  if (!active(c)) return;
  replaceRevisionReferences(Object.values(data.revisions));
  publish({
    ready: true,
    records: Object.values(data.heads).filter((r) => !r.deleted).sort((a, b) => b.createdAt - a.createdAt),
    conflicts: Object.values(data.revisions).filter((r) => r.conflict).sort((a, b) => b.seq - a.seq),
    pending: data.outbox.length,
    quarantined: data.quarantine.length,
    userId: c.userId,
  });
}

async function update(c: Context, fn: (data: LearningScope) => LearningScope, local = false) {
  assertActive(c);
  const data = await updateScope(c.scope, (current) => { assertActive(c); return fn(current); });
  await refresh(c);
  channel?.postMessage({ scope: c.scope, local });
  return data;
}

function scheduleSync() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { void syncNow(); }, 500);
}

function selectContext() {
  const userId = getCloudState().user?.id ?? null;
  const datasetId = store.get().progress.datasetId || "word-atlas-open";
  if (!isIdentifier(datasetId)) return;
  const scope = scopeKey(userId, datasetId);
  if (state.ready && scope === context.scope) {
    context = { ...context, datasetId };
    return;
  }
  const c: Context = { scope, userId, datasetId, epoch: context.epoch + 1 };
  context = c;
  replaceRevisionReferences([]);
  engine = null;
  publish({ ready: false, records: [], conflicts: [], pending: 0, quarantined: 0, userId, error: null, syncStatus: userId ? "local" : "signed-out" });
  ready = (userId ? migrateUserScopes(userId) : migrateGuestScopes()).then(() => refresh(c)).then(() => {
    if (!active(c) || !userId) return;
    engine = new LearningSyncEngine({
      userId, datasetId,
      read: () => readScope(c.scope),
      update: (fn) => update(c, fn),
      request: (method, path, body) => learningRequest(userId, method, path, body),
      active: () => active(c),
      changed: (patch) => { if (active(c)) publish({ ...patch, error: patch.error ?? null }); },
      exclusive: async (task) => {
        if (navigator.locks) await navigator.locks.request(`band-learning:${scope}`, task);
        else await task();
      },
    });
    scheduleSync();
  }).catch((error: unknown) => {
    if (active(c)) publish({ ready: false, error: error instanceof Error ? error.message : "学习记录未能打开。", syncStatus: "error" });
  });
}

export function startLearningRecords() {
  if (started) return;
  started = true;
  subscribeCloudState(selectContext);
  store.subscribe(selectContext);
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("band-learning-records");
    channel.onmessage = (event) => {
      if (event.data?.scope === context.scope) {
        if (event.data.media) publish({ recordingsVersion: state.recordingsVersion + 1 });
        void refresh().catch(() => undefined);
        if (event.data.local) scheduleSync();
      }
    };
  }
  const resume = () => {
    if (document.visibilityState === "visible") void syncNow({ verify: true });
  };
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  // Idle tabs poll no more often than once per minute. Active/focus events and
  // local writes still resume promptly; hidden tabs make no timer requests.
  window.setInterval(() => {
    if (document.visibilityState === "visible" && context.userId && Date.now() - lastSyncAttemptAt >= 60000) void syncNow();
  }, 60000);
  selectContext();
}

async function ensureReady() {
  startLearningRecords();
  await ready;
  if (!state.ready) throw new Error(state.error ?? "本机学习记录暂不可用。");
  return context;
}

export function getLearningState() { return state; }
/** Distinguish a new login to the same account from an older in-flight operation. */
export function getLearningContextEpoch() { return context.epoch; }
export function useLearning(): LearningState {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getLearningState, getLearningState);
}

type SaveInput = { id?: string; kind: LearningKind; payload: LearningPayload; baseRevision?: string | null; deleted?: boolean };
async function saveInContext(c: Context, input: SaveInput): Promise<Revision> {
  assertActive(c);
  const id = input.id ?? crypto.randomUUID();
  if (!isIdentifier(id)) throw new Error("学习记录标识无效。");
  const sourceDataset = input.payload.datasetId === null ? null : typeof input.payload.datasetId === "string" ? input.payload.datasetId : c.datasetId;
  const payload: LearningPayload = input.deleted ? {} : { ...input.payload, datasetId: sourceDataset };
  if (!input.deleted && input.kind === "plan") payload.planId = id;
  const revisionId = crypto.randomUUID(), mutationId = crypto.randomUUID();
  validatePayload(input.kind, payload, !!input.deleted);
  const contentHash = await hashPayload(input.kind, payload);
  assertActive(c);
  let saved!: Revision;
  await update(c, (data) => {
    const current = data.heads[id];
    if (current && current.kind !== input.kind) throw new Error("不能改变已有记录的类型。");
    if (input.deleted && !current) throw new Error("找不到需要删除的学习记录。");
    const baseRevision = input.baseRevision === undefined ? current?.revisionId ?? null : input.baseRevision;
    const body: WriteRequest = { schemaVersion: LEARNING_PROTOCOL, revisionId, mutationId, baseRevision, kind: input.kind, payload, ...(input.deleted ? { deleted: true } : {}) };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 128 * 1024) throw new Error("学习记录超过128 KiB，请缩短后重试；原内容未被覆盖。");
    saved = { id, kind: input.kind, datasetId: input.deleted ? current.datasetId : sourceDataset, planId: input.deleted ? current.planId : String(payload.planId), revisionId, baseRevision, seq: 0, payload, contentHash, createdAt: Date.now(), conflict: false, deleted: !!input.deleted, payloadVersion: LEARNING_PROTOCOL };
    return { ...data, heads: { ...data.heads, [id]: saved }, revisions: { ...data.revisions, [revisionId]: saved }, outbox: [...data.outbox, { recordId: id, body, local: saved, createdAt: saved.createdAt }] };
  }, true);
  assertActive(c);
  if (active(c)) { publish({ error: null, syncStatus: c.userId ? "local" : "signed-out" }); scheduleSync(); }
  return saved;
}

export async function saveRecord(input: SaveInput, expectedUserId?: string | null): Promise<Revision> {
  const expectedContext = context, current = await ensureReady();
  if (expectedUserId !== undefined) {
    assertActive(expectedContext);
    if (current.userId !== expectedUserId) throw new Error("账号已经切换，此操作未应用到其他账号。");
  }
  return saveInContext(current, input);
}

export async function removeRecord(id: string) {
  const c = await ensureReady();
  const current = (await readScope(c.scope)).heads[id];
  assertActive(c);
  if (!current) throw new Error("找不到需要删除的记录。");
  return saveInContext(c, { id, kind: current.kind, payload: {}, deleted: true });
}

export async function syncNow(options?: { verify?: boolean }): Promise<void> {
  let c: Context | undefined;
  try {
    c = await ensureReady();
    if (!context.userId || !engine) return;
    lastSyncAttemptAt = Date.now();
    if (options?.verify) { await migrateUserScopes(c.userId!); await refresh(c); assertActive(c); }
    await engine.sync(options);
  } catch (error) { if (!c || active(c)) publish({ syncStatus: "error", error: error instanceof Error ? error.message : "本机记录未能保存。" }); }
}

/** Choosing a conflict creates a new immutable revision; both original versions remain. */
export async function resolveConflict(id: string, revisionId: string): Promise<Revision> {
  const c = await ensureReady();
  const data = await readScope(c.scope);
  assertActive(c);
  if (data.outbox.some((item) => item.recordId === id)) throw new Error("请先同步此记录的本机修改，再处理两份版本。");
  const selected = data.revisions[revisionId], head = data.heads[id];
  if (!selected || selected.id !== id) throw new Error("找不到这份修订。");
  return saveInContext(c, { id, kind: selected.kind, payload: selected.payload, baseRevision: head?.revisionId ?? null, deleted: selected.deleted });
}

export async function listRevisions(id: string): Promise<Revision[]> {
  const c = await ensureReady();
  let data = await readScope(c.scope);
  if (c.userId && navigator.onLine) {
    try {
      let after = 0;
      for (let page = 0; page < 1000; page++) {
        const result = await learningRequest(c.userId, "GET", `/api/learning/v2/records/${encodeURIComponent(id)}/revisions?after=${after}&limit=100`);
        if (!active(c)) return [];
        if (!isObject(result) || !Array.isArray(result.items) || !Number.isSafeInteger(result.nextCursor) || typeof result.hasMore !== "boolean") throw new Error("学习服务返回了无效的历史记录。");
        const items = result.items.map(decodeRevision);
        if (items.some((r) => r.id !== id)) throw new Error("历史记录标识与请求不一致。");
        data = await update(c, (s) => ({ ...s, revisions: { ...s.revisions, ...Object.fromEntries(items.map((r) => [r.revisionId, r])) } }));
        if (!result.hasMore) break;
        if (Number(result.nextCursor) <= after) throw new Error("学习历史分页未能推进。");
        after = Number(result.nextCursor);
      }
    } catch (error) {
      if (active(c)) publish({ error: error instanceof Error ? error.message : "未能读取云端历史，本机历史仍可查看。" });
    }
  }
  assertActive(c);
  return Object.values(data.revisions).filter((r) => r.id === id).sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
}

export async function saveRecording(id: string, blob: Blob) {
  const c = await ensureReady();
  if (!isIdentifier(id)) throw new Error("录音标识无效。");
  await putRecording(c.scope, id, blob);
  assertActive(c);
  publish({ recordingsVersion: state.recordingsVersion + 1 });
  channel?.postMessage({ scope: c.scope, media: true });
}
export async function getRecording(id: string) {
  const c = await ensureReady();
  const blob = await readRecording(c.scope, id);
  assertActive(c);
  return blob;
}

/** Views may adapt a legacy plan. Raw Revision.payload/contentHash and queued
 * requests remain untouched for history, receipts, and feedback references. */
export function getLearningPayload(record: Revision): LearningPayload {
  return projectLearningPayload(record.kind, record.payload);
}

export async function getSyncIssues(): Promise<QuarantinedMutation[]> {
  const c = await ensureReady(), data = await readScope(c.scope);
  assertActive(c);
  return data.quarantine;
}

export async function retrySyncIssues(mutationIds?: string[]): Promise<void> {
  const c = await ensureReady();
  await update(c, (data) => {
    const chosen = new Set(mutationIds ?? data.quarantine.map((item) => item.body.mutationId));
    const existing = new Set(data.outbox.map((item) => item.body.mutationId));
    const retry = data.quarantine.filter((item) => chosen.has(item.body.mutationId) && !existing.has(item.body.mutationId));
    const outbox = orderMutations([...retry, ...data.outbox]);
    return { ...data, outbox, quarantine: data.quarantine.filter((item) => !chosen.has(item.body.mutationId)) };
  }, true);
  assertActive(c);
  await syncNow({ verify: true });
}

export async function exportSyncIssues(): Promise<Blob> {
  const c = await ensureReady(), data = await readScope(c.scope);
  assertActive(c);
  return new Blob([JSON.stringify({ format: "band-galaxy-unsynced", version: 1, exportedAt: new Date().toISOString(), records: data.quarantine }, null, 2)], { type: "application/json" });
}

export interface RecordingBackupInfo extends RecordingMetadata { bytes: number }
export async function listRecordingBackups(): Promise<RecordingBackupInfo[]> {
  const c = await ensureReady();
  const [audio, data] = await Promise.all([listRecordings(c.scope), readScope(c.scope)]);
  assertActive(c);
  const workByRecording = new Map<string, Revision>();
  for (const record of Object.values(data.revisions).sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)) {
    const id = record.kind === "speaking" && !record.deleted ? record.payload.recordingId : null;
    if (typeof id === "string") workByRecording.set(id, record);
  }
  for (const record of Object.values(data.heads)) {
    const id = record.kind === "speaking" && !record.deleted ? record.payload.recordingId : null;
    if (typeof id === "string") workByRecording.set(id, record);
  }
  return audio.map((item) => {
    const work = workByRecording.get(item.id);
    const payload = work?.payload;
    return { recordingId: item.id, date: typeof payload?.date === "string" ? payload.date : item.metadata?.date ?? null,
      prompt: typeof payload?.prompt === "string" ? payload.prompt : item.metadata?.prompt ?? "",
      transcript: typeof payload?.transcript === "string" ? payload.transcript : item.metadata?.transcript ?? "",
      durationSeconds: typeof payload?.durationSeconds === "number" ? payload.durationSeconds : item.metadata?.durationSeconds ?? null,
      bytes: item.blob.size };
  });
}

export async function exportRecordings(recordingIds?: string[]): Promise<Blob> {
  const c = await ensureReady();
  const [audio, metadata] = await Promise.all([listRecordings(c.scope), listRecordingBackups()]);
  assertActive(c);
  const chosen = recordingIds ? new Set(recordingIds) : null;
  const records = audio.filter((item) => !chosen || chosen.has(item.id)).map((item) => {
    const found = metadata.find((entry) => entry.recordingId === item.id)!;
    const { bytes: _bytes, ...entry } = found;
    return { blob: item.blob, metadata: entry };
  });
  const archive = await encodeRecordingArchive(records);
  assertActive(c);
  return archive;
}

export async function importRecordings(archive: Blob): Promise<{ imported: number; duplicate: number }> {
  const c = await ensureReady();
  const entries = await decodeRecordingArchive(archive);
  assertActive(c);
  const result = await importRecordingEntries(c.scope, entries);
  assertActive(c);
  await refresh(c);
  publish({ recordingsVersion: state.recordingsVersion + 1 });
  channel?.postMessage({ scope: c.scope, media: true });
  return result;
}

/** An explicit action only: logging in never silently uploads visitor drafts. */
export async function adoptGuestRecords(): Promise<void> {
  const c = await ensureReady();
  if (!c.userId) throw new Error("请先登录，再选择并入本机访客记录。");
  const guest = await readScope(scopeKey(null, c.datasetId));
  assertActive(c);
  // Preflight all audio before copying. An ID collision cannot overwrite an
  // existing account recording or erase the still-separate visitor originals.
  const visitorAudio = await listRecordings(scopeKey(null));
  assertActive(c);
  await importRecordingEntries(c.scope, visitorAudio);
  assertActive(c);
  await update(c, (data) => {
    const known = new Set([...Object.keys(data.revisions), ...data.outbox.map((item) => item.local.revisionId)]);
    const additions = guest.outbox.filter((item) => !known.has(item.local.revisionId));
    const heads = { ...data.heads }, revisions = { ...data.revisions };
    for (const item of additions) { heads[item.recordId] = item.local; revisions[item.local.revisionId] = item.local; }
    return { ...data, heads, revisions, outbox: [...data.outbox, ...additions] };
  }, true);
  assertActive(c);
  publish({ recordingsVersion: state.recordingsVersion + 1 });
  channel?.postMessage({ scope: c.scope, media: true });
  if (active(c)) scheduleSync();
}

export function deviceId() {
  try {
    const key = "band-learning:device";
    let id = localStorage.getItem(key);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
    return id;
  } catch { return "local-device"; }
}

export { LearningApiError };
