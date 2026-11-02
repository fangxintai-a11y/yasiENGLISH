import { useSyncExternalStore } from "react";
import { CloudError, CloudSyncEngine, sameSnapshot, type CloudState, type CloudUser, type SyncMeta } from "./cloudSyncEngine";
import { sanitizeProgress, sanitizeSettings, store } from "./store";
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
const engine = new CloudSyncEngine({
  request: accountRequest,
  snapshot: () => {
    const snapshot = store.cloudSnapshot();
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
  changed: (next) => { state = next; listeners.forEach((fn) => fn()); },
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
  let previous = store.cloudSnapshot();
  store.subscribe(() => {
    const current = store.cloudSnapshot();
    if (applying) { previous = current; return; }
    if (!current || sameSnapshot(current, previous)) return;
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
export function useCloudSync(): CloudState {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => state, () => state);
}
