import { useSyncExternalStore } from "react";
import { getCloudState, subscribeCloudState } from "../store/cloudSync";
import { store } from "../store/store";
import { learningRequest, LearningApiError } from "./api";
import { putRecording, readRecording, readScope, updateScope } from "./db";
import { decodeRevision, hashPayload, isIdentifier, isObject, validatePayload, type LearningKind, type LearningPayload, type LearningScope, type Revision, type SyncStatus, type WriteRequest } from "./protocol";
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
}
interface Context { scope: string; userId: string | null; datasetId: string; epoch: number }
const listeners = new Set<() => void>();
let state: LearningState = { ready: false, records: [], conflicts: [], syncStatus: "local", error: null, pending: 0, userId: null };
let context: Context = { scope: "guest:word-atlas-open", userId: null, datasetId: "word-atlas-open", epoch: 0 };
let ready: Promise<void> = Promise.resolve();
let started = false;
let engine: LearningSyncEngine | null = null;
let timer: number | undefined;
let channel: BroadcastChannel | null = null;
const scopeKey = (userId: string | null, datasetId: string) => `${userId ?? "guest"}:${datasetId}`;
const active = (c: Context) => c.epoch === context.epoch && c.scope === context.scope;
const assertActive = (c: Context) => { if (!active(c)) throw new Error("账号或词库已经切换，此操作未应用到其他账号。"); };
const publish = (patch: Partial<LearningState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };

async function refresh(c = context) {
  const data = await readScope(c.scope);
  if (!active(c)) return;
  publish({
    ready: true,
    records: Object.values(data.heads).filter((r) => !r.deleted).sort((a, b) => b.createdAt - a.createdAt),
    conflicts: Object.values(data.revisions).filter((r) => r.conflict).sort((a, b) => b.seq - a.seq),
    pending: data.outbox.length,
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
  if (state.ready && scope === context.scope) return;
  const c: Context = { scope, userId, datasetId, epoch: context.epoch + 1 };
  context = c;
  engine = null;
  publish({ ready: false, records: [], conflicts: [], pending: 0, userId, error: null, syncStatus: userId ? "local" : "signed-out" });
  ready = refresh(c).then(() => {
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
        void refresh().catch(() => undefined);
        if (event.data.local) scheduleSync();
      }
    };
  }
  const resume = () => {
    if (document.visibilityState === "visible") void syncNow();
  };
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  window.setInterval(resume, 15000);
  selectContext();
}

async function ensureReady() {
  startLearningRecords();
  await ready;
  if (!state.ready) throw new Error(state.error ?? "本机学习记录暂不可用。");
  return context;
}

export function getLearningState() { return state; }
export function useLearning(): LearningState {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getLearningState, getLearningState);
}

type SaveInput = { id?: string; kind: LearningKind; payload: LearningPayload; baseRevision?: string | null; deleted?: boolean };
async function saveInContext(c: Context, input: SaveInput): Promise<Revision> {
  assertActive(c);
  const id = input.id ?? crypto.randomUUID();
  if (!isIdentifier(id)) throw new Error("学习记录标识无效。");
  const payload: LearningPayload = input.deleted ? {} : { ...input.payload, datasetId: c.datasetId };
  if (input.payload.datasetId && input.payload.datasetId !== c.datasetId) throw new Error("不能在当前词库保存其他词库的学习记录。");
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
    const body: WriteRequest = { schemaVersion: 1, revisionId, mutationId, baseRevision, kind: input.kind, payload, ...(input.deleted ? { deleted: true } : {}) };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 128 * 1024) throw new Error("学习记录超过128 KiB，请缩短后重试；原内容未被覆盖。");
    saved = { id, kind: input.kind, datasetId: c.datasetId, planId: input.deleted ? current.planId : String(payload.planId), revisionId, baseRevision, seq: 0, payload, contentHash, createdAt: Date.now(), conflict: false, deleted: !!input.deleted };
    return { ...data, heads: { ...data.heads, [id]: saved }, revisions: { ...data.revisions, [revisionId]: saved }, outbox: [...data.outbox, { recordId: id, body, local: saved, createdAt: saved.createdAt }] };
  }, true);
  if (active(c)) { publish({ error: null, syncStatus: c.userId ? "local" : "signed-out" }); scheduleSync(); }
  return saved;
}

export async function saveRecord(input: SaveInput): Promise<Revision> {
  return saveInContext(await ensureReady(), input);
}

export async function removeRecord(id: string) {
  const c = await ensureReady();
  const current = (await readScope(c.scope)).heads[id];
  assertActive(c);
  if (!current) throw new Error("找不到需要删除的记录。");
  return saveInContext(c, { id, kind: current.kind, payload: {}, deleted: true });
}

export async function syncNow(): Promise<void> {
  let c: Context | undefined;
  try {
    c = await ensureReady();
    if (!context.userId || !engine) return;
    await engine.sync();
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
        const result = await learningRequest(c.userId, "GET", `/api/learning/v1/records/${encodeURIComponent(id)}/revisions?after=${after}&limit=100`);
        if (!active(c)) return [];
        if (!isObject(result) || !Array.isArray(result.items) || !Number.isSafeInteger(result.nextCursor) || typeof result.hasMore !== "boolean") throw new Error("学习服务返回了无效的历史记录。");
        const items = result.items.map(decodeRevision);
        if (items.some((r) => r.id !== id || r.datasetId !== c.datasetId)) throw new Error("历史记录不属于当前词库。");
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
}
export async function getRecording(id: string) {
  const c = await ensureReady();
  const blob = await readRecording(c.scope, id);
  assertActive(c);
  return blob;
}

/** An explicit action only: logging in never silently uploads visitor drafts. */
export async function adoptGuestRecords(): Promise<void> {
  const c = await ensureReady();
  if (!c.userId) throw new Error("请先登录，再选择并入本机访客记录。");
  const guest = await readScope(scopeKey(null, c.datasetId));
  assertActive(c);
  // An explicit import also copies the visitor's audio into this account's local namespace.
  for (const revision of Object.values(guest.revisions)) {
    const id = revision.kind === "speaking" ? revision.payload.recordingId : null;
    if (typeof id !== "string") continue;
    const blob = await readRecording(scopeKey(null, c.datasetId), id);
    assertActive(c);
    if (blob) await putRecording(c.scope, id, blob);
  }
  await update(c, (data) => {
    const known = new Set([...Object.keys(data.revisions), ...data.outbox.map((item) => item.local.revisionId)]);
    const additions = guest.outbox.filter((item) => !known.has(item.local.revisionId));
    const heads = { ...data.heads }, revisions = { ...data.revisions };
    for (const item of additions) { heads[item.recordId] = item.local; revisions[item.local.revisionId] = item.local; }
    return { ...data, heads, revisions, outbox: [...data.outbox, ...additions] };
  }, true);
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
