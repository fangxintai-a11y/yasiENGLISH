import { useSyncExternalStore } from "react";
import { CloudError, CloudSyncEngine, sameSnapshot, type CloudState, type CloudUser, type SyncMeta } from "./cloudSyncEngine";
import { assertSafeOutbound, OutboundPrivacyError, sanitizeProgress, sanitizeSettings, store } from "./store";
import type { SyncSnapshot } from "./syncMerge";
import { accountRequest } from "../account/api";

const USER_KEY = "band-galaxy:sync-user";
let dbPromise: Promise<IDBDatabase> | null = null;
function metadataDB(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("band-cloud-sync", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("metadata");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(new CloudError("浏览器无法保存同步日志，请允许网站使用本地存储。", 507)); };
    request.onblocked = () => reject(new CloudError("请关闭其他旧版本页面后重试同步。", 507));
  });
  return dbPromise;
}
const metaKey = (user: CloudUser, dataset: string) => `${user.id}:${user.username}:${dataset}`;
async function loadMeta(user: CloudUser, dataset: string): Promise<SyncMeta> {
  const db = await metadataDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction("metadata").objectStore("metadata").get(metaKey(user, dataset));
    request.onsuccess = () => resolve(request.result ?? { base: null });
    request.onerror = () => reject(new CloudError("无法读取本机同步日志，学习进度仍保存在本机。", 507));
  });
}
async function saveMeta(user: CloudUser, dataset: string, meta: SyncMeta): Promise<void> {
  const db = await metadataDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("metadata", "readwrite");
    tx.objectStore("metadata").put(meta, metaKey(user, dataset));
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new CloudError("无法保存同步日志，已暂停上传以保护学习记录。请释放设备存储空间后重试。", 507));
  });
}

let applying = false;
const listeners = new Set<() => void>();
let state: CloudState;
let blockedMessage: string | null = null;
function publish(next: CloudState) {
  state = blockedMessage ? { ...next, status: "error", pending: true, message: blockedMessage } : next;
  listeners.forEach((fn) => fn());
}
function localSnapshot(): SyncSnapshot | null {
  try {
    const snapshot = store.cloudSnapshot();
    if (blockedMessage) { blockedMessage = null; publish(engine.state); }
    return snapshot;
  } catch (error) {
    blockedMessage = error instanceof OutboundPrivacyError ? error.message : "学习记录暂时无法安全同步，原文仍保存在本机。";
    publish(engine.state);
    return null;
  }
}
const engine = new CloudSyncEngine({
  request: async (method, path, body) => {
    if (method === "PUT" && path.startsWith("/api/sync/")) {
      // Also inspect durable pending commits and merged server history before fetch.
      try { assertSafeOutbound(body); }
      catch (error) { throw new CloudError(error instanceof OutboundPrivacyError ? error.message : "进度未能安全发送，原文仍保存在本机。", 400); }
    }
    return accountRequest(method, path, body);
  },
  snapshot: () => {
    const snapshot = localSnapshot();
    // Dataset selection belongs to this device; each dataset already has its own server record.
    return snapshot ? { ...snapshot, settings: { ...snapshot.settings, dataset: "open" } } : null;
  },
  apply: (snapshot, stamp) => {
    applying = true;
    try { store.applyCloud(snapshot, stamp); }
    finally { applying = false; }
  },
  appliedStamp: store.appliedCloudStamp,
  load: loadMeta,
  save: saveMeta,
  remember: (user) => {
    try { user ? localStorage.setItem(USER_KEY, JSON.stringify(user)) : localStorage.removeItem(USER_KEY); } catch { /* only a UI hint */ }
  },
  decode: (value, dataset): SyncSnapshot | null => {
    if (value === null) return null;
    const s = value as SyncSnapshot;
    if (!s || s.progress?.datasetId !== dataset || s.progress.version !== 2 || !s.settings)
      throw new CloudError("服务器返回的词库进度不匹配，已暂停同步。", 502);
    return { progress: { ...sanitizeProgress(s.progress, dataset), session: null }, settings: { ...sanitizeSettings(s.settings), dataset: "open" } };
  },
  uuid: () => crypto.randomUUID(),
  exclusive: async (task) => {
    if (navigator.locks) await navigator.locks.request("band-galaxy-cloud-sync", async () => { await task(); });
    else await task();
  },
  changed: publish,
});
state = engine.state;

let started = false;
let saveTimer: number | undefined;
export function startCloudSync() {
  if (started) return;
  started = true;
  try {
    const cached = JSON.parse(localStorage.getItem(USER_KEY) ?? "null") as CloudUser | null;
    if (cached && typeof cached.id === "string" && cached.id.length > 0 && typeof cached.username === "string") engine.restoreUser(cached);
  } catch { /* a missing hint never blocks local learning */ }
  void engine.connect();
  let previous = localSnapshot();
  store.subscribe(() => {
    const wasBlocked = blockedMessage !== null;
    const current = localSnapshot();
    if (!current) { window.clearTimeout(saveTimer); return; }
    if (applying) { previous = current; return; }
    if (!wasBlocked && sameSnapshot(current, previous)) return;
    previous = current;
    engine.markChanged();
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void engine.sync(); }, 1200);
  });
  const resume = () => {
    if (document.visibilityState === "visible") void (state.user ? engine.sync() : engine.connect());
  };
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  window.setInterval(resume, 15000);
}

export const loginCloud = (username: string, password: string, setupToken?: string, create?: boolean) => engine.login(username, password, setupToken, create);
export const logoutCloud = () => engine.logout();
export const syncNow = () => engine.sync();
/** Account identity notifications for independent learning-record storage. */
export const getCloudState = () => state;
export function subscribeCloudState(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useCloudSync(): CloudState {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => state, () => state);
}
