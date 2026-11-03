import { canonical, emptyScope, type LearningScope, type QueuedMutation, type Revision } from "./protocol";

const DATABASE = "band-learning-v1";
let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  let abandoned = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    const clear = () => { if (opening === pending) opening = null; };
    request.onupgradeneeded = () => {
      if (abandoned) { request.transaction?.abort(); return; }
      for (const name of ["scopes", "recordings", "recordingMetadata"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => { db.close(); clear(); };
      resolve(db);
    };
    request.onerror = () => { clear(); reject(new Error("无法打开学习记录存储。请允许网站保存数据。")); };
    request.onblocked = () => { abandoned = true; clear(); reject(new Error("请关闭其他旧页面后重新打开学习记录。")); };
  });
  opening = pending;
  void pending.catch(() => { if (opening === pending) opening = null; });
  return pending;
}
const transactionError = () => new Error("学习记录未能保存。请释放设备存储空间后重试，勿关闭未保存的内容。");
const scopeValue = (value?: LearningScope): LearningScope => ({ ...emptyScope(), ...value, quarantine: value?.quarantine ?? [] });

export const userScopeKey = (userId: string) => `account:${userId}`;
export interface RecordingMetadata {
  recordingId: string;
  date: string | null;
  prompt: string;
  transcript: string;
  durationSeconds: number | null;
}
export interface StoredRecording { id: string; blob: Blob; metadata?: RecordingMetadata }

/** Local clocks may differ across old bank scopes; dependency order wins over
 * timestamps when merging or explicitly retrying queued requests. */
export function orderMutations(items: QueuedMutation[]): QueuedMutation[] {
  const remaining = [...items].sort((a, b) => a.createdAt - b.createdAt), output: QueuedMutation[] = [];
  const byRevision = new Map(items.map((item) => [item.body.revisionId, item]));
  const plans = new Map<string, QueuedMutation>();
  for (const item of remaining) if (item.body.kind === "plan" && !plans.has(item.recordId)) plans.set(item.recordId, item);
  const done = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex((item) => {
      const payload = item.body.payload;
      const dependencies = [item.body.baseRevision, payload.workRevisionId, payload.parentRevisionId]
        .flatMap((id) => typeof id === "string" && byRevision.has(id) ? [byRevision.get(id)!] : []);
      const plan = plans.get(String(payload.planId ?? item.local.planId));
      if (item.body.kind !== "plan" && plan) dependencies.push(plan);
      return dependencies.every((dependency) => dependency === item || done.has(dependency.body.mutationId));
    });
    if (index < 0) { output.push(...remaining); break; }
    const [item] = remaining.splice(index, 1); output.push(item); done.add(item.body.mutationId);
  }
  return output;
}

/** Merge raw immutable revisions. Never rewrite a payload, request ID, or hash. */
export function mergeLearningScopes(values: LearningScope[]): LearningScope {
  const result = emptyScope();
  const queued = new Map<string, QueuedMutation>();
  const quarantine = new Map<string, LearningScope["quarantine"][number]>();
  const heads: Revision[] = [];
  for (const raw of values) {
    const value = scopeValue(raw);
    for (const revision of [...Object.values(value.revisions), ...Object.values(value.heads)]) {
      const previous = result.revisions[revision.revisionId];
      if (previous && canonical(previous) !== canonical(revision)) throw new Error("旧学习记录有相同修订ID但内容不同，原存储未删除，请先导出并处理冲突。");
      result.revisions[revision.revisionId] = revision;
    }
    heads.push(...Object.values(value.heads));
    for (const mutation of [...value.outbox, ...value.quarantine]) {
      const previous = queued.get(mutation.body.mutationId);
      if (previous && (previous.recordId !== mutation.recordId || canonical(previous.body) !== canonical(mutation.body)))
        throw new Error("旧待同步请求ID发生冲突，原存储未删除。");
      queued.set(mutation.body.mutationId, mutation);
    }
    for (const mutation of value.quarantine) quarantine.set(mutation.body.mutationId, mutation);
  }
  result.quarantine = [...quarantine.values()].sort((a, b) => a.createdAt - b.createdAt);
  result.outbox = orderMutations([...queued.values()].filter((item) => !quarantine.has(item.body.mutationId)));
  const pending = new Map<string, number>();
  for (const mutation of [...result.outbox, ...result.quarantine])
    pending.set(mutation.local.revisionId, mutation.createdAt);
  for (const revision of heads) {
    const previous = result.heads[revision.id];
    const weight = (item: Revision) => [pending.has(item.revisionId) ? 1 : 0, pending.get(item.revisionId) ?? item.seq, item.createdAt];
    const a = previous ? weight(previous) : [-1, -1, -1], b = weight(revision);
    if (!previous || b[0] > a[0] || b[0] === a[0] && (b[1] > a[1] || b[1] === a[1] && b[2] > a[2])) result.heads[revision.id] = revision;
  }
  // Old per-dataset cursors skipped other datasets. Replaying from zero is safe;
  // using their maximum would permanently omit this user's older revisions.
  result.cursor = 0;
  return result;
}

interface Snapshot {
  scopes: Map<string, LearningScope>;
  recordings: { key: IDBValidKey; scope: string; id: string; blob: Blob }[];
  metadata: Map<string, RecordingMetadata>;
}
interface Prepared<T> { value: T; apply(tx: IDBTransaction): void }

/** Keep the write transaction alive while checking Blob bytes. No source can
 * change between validation and writes; a failure aborts all copies/deletes. */
async function atomic<T>(prepare: (snapshot: Snapshot) => Promise<Prepared<T>>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["scopes", "recordings", "recordingMetadata"], "readwrite");
    const snapshot: Snapshot = { scopes: new Map(), recordings: [], metadata: new Map() };
    let prepared: Prepared<T> | undefined, failure: unknown, finishedReads = 0;
    const failed = (error: unknown) => { failure = error; try { tx.abort(); } catch { /* already aborted */ } };
    const read = (name: string, accept: (key: IDBValidKey, value: unknown) => void) => {
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (cursor) { accept(cursor.key, cursor.value); cursor.continue(); }
          else if (++finishedReads === 3) void prepare(snapshot).then((result) => { prepared = result; }, failed);
        } catch (error) { failed(error); }
      };
    };
    read("scopes", (key, value) => { if (typeof key === "string") snapshot.scopes.set(key, scopeValue(value as LearningScope)); });
    read("recordings", (key, value) => {
      if (Array.isArray(key) && typeof key[0] === "string" && typeof key[1] === "string" && value instanceof Blob)
        snapshot.recordings.push({ key, scope: key[0], id: key[1], blob: value });
    });
    read("recordingMetadata", (key, value) => { snapshot.metadata.set(JSON.stringify(key), value as RecordingMetadata); });
    const pulse = () => {
      const request = tx.objectStore("scopes").get("__migration_keepalive__");
      request.onsuccess = () => {
        if (prepared) { try { prepared.apply(tx); } catch (error) { failed(error); } }
        else if (!failure) pulse();
      };
    };
    pulse();
    tx.oncomplete = () => prepared ? resolve(prepared.value) : reject(transactionError());
    tx.onabort = tx.onerror = () => reject(failure ?? transactionError());
  });
}

const blobHash = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((n) => n.toString(16).padStart(2, "0")).join("");

async function migrateScopes(prefix: string, destination: string): Promise<void> {
  await atomic(async (snapshot) => {
    const sources = [...snapshot.scopes.keys()].filter((key) => key.startsWith(prefix));
    const recordingSources = snapshot.recordings.filter((item) => item.scope.startsWith(prefix));
    if (!sources.length && !recordingSources.length) return { value: undefined, apply() {} };
    const merged = mergeLearningScopes([scopeValue(snapshot.scopes.get(destination)), ...sources.map((key) => scopeValue(snapshot.scopes.get(key)))]);
    const audio = new Map(snapshot.recordings.filter((item) => item.scope === destination).map((item) => [item.id, item.blob]));
    for (const item of recordingSources) {
      const previous = audio.get(item.id);
      if (previous && await blobHash(previous) !== await blobHash(item.blob))
        throw new Error("旧词库中存在相同ID的不同录音，原记录完整保留，请先分别导出后处理。");
      audio.set(item.id, item.blob);
    }
    return { value: undefined, apply(tx) {
      tx.objectStore("scopes").put(merged, destination);
      for (const item of recordingSources) {
        tx.objectStore("recordings").put(item.blob, [destination, item.id]);
        const metadata = snapshot.metadata.get(JSON.stringify(item.key));
        if (metadata) tx.objectStore("recordingMetadata").put(metadata, [destination, item.id]);
      }
      for (const key of sources) tx.objectStore("scopes").delete(key);
      for (const item of recordingSources) {
        tx.objectStore("recordings").delete(item.key);
        tx.objectStore("recordingMetadata").delete(item.key);
      }
    } };
  });
}

export const migrateUserScopes = (userId: string) => migrateScopes(`${userId}:`, userScopeKey(userId));
/** Visitor records are one local identity, never silently merged into a login. */
export const migrateGuestScopes = () => migrateScopes("guest:", "guest");

export async function readScope(scope: string): Promise<LearningScope> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("scopes").objectStore("scopes").get(scope);
    request.onsuccess = () => resolve(scopeValue(request.result));
    request.onerror = () => reject(transactionError());
  });
}

/** A single IDB transaction commits heads, revision history, outbox and cursor together. */
export async function updateScope(scope: string, change: (state: LearningScope) => LearningScope): Promise<LearningScope> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("scopes", "readwrite");
    const store = tx.objectStore("scopes");
    let next: LearningScope;
    let failure: unknown;
    const request = store.get(scope);
    request.onsuccess = () => {
      try { next = change(scopeValue(request.result)); store.put(next, scope); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next!);
    tx.onabort = tx.onerror = () => reject(failure ?? transactionError());
  });
}

export async function putRecording(scope: string, id: string, blob: Blob): Promise<void> {
  if (!blob.size || blob.size > 50 * 1024 * 1024) throw new Error("录音为空或超过50 MB，请重新录制或缩短后重试。");
  await importRecordingEntries(scope, [{ id, blob }]);
}
export async function readRecording(scope: string, id: string): Promise<Blob | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("recordings").objectStore("recordings").get([scope, id]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(transactionError());
  });
}

export async function listRecordings(scope: string): Promise<StoredRecording[]> {
  return atomic(async (snapshot) => ({ value: snapshot.recordings.filter((item) => item.scope === scope).map((item) => ({
    id: item.id, blob: item.blob, metadata: snapshot.metadata.get(JSON.stringify(item.key)),
  })), apply() {} }));
}

export async function importRecordingEntries(scope: string, entries: StoredRecording[]): Promise<{ imported: number; duplicate: number }> {
  return atomic(async (snapshot) => {
    const existing = new Map(snapshot.recordings.filter((item) => item.scope === scope).map((item) => [item.id, item.blob]));
    const additions: StoredRecording[] = [];
    const restoredMetadata: StoredRecording[] = [];
    let duplicate = 0;
    for (const entry of entries) {
      const old = existing.get(entry.id);
      if (old) {
        if (await blobHash(old) !== await blobHash(entry.blob)) throw new Error(`录音 ${entry.id} 已存在且音频不同，未覆盖任何原录音。`);
        duplicate++;
        if (entry.metadata && !snapshot.metadata.has(JSON.stringify([scope, entry.id]))) restoredMetadata.push(entry);
      } else { additions.push(entry); existing.set(entry.id, entry.blob); }
    }
    return { value: { imported: additions.length, duplicate }, apply(tx) {
      for (const entry of additions) {
        tx.objectStore("recordings").put(entry.blob, [scope, entry.id]);
        if (entry.metadata) tx.objectStore("recordingMetadata").put(entry.metadata, [scope, entry.id]);
      }
      for (const entry of restoredMetadata) tx.objectStore("recordingMetadata").put(entry.metadata, [scope, entry.id]);
    } };
  });
}
