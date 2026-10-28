import { useEffect, useSyncExternalStore } from "react";
import {
  buildJobs,
  cachedUrls,
  defaultSelection,
  fontUrlsFromCss,
  runDownload,
  shellUrls,
  speedOf,
  staleUrls,
  type GroupKey,
  type PackManifest,
  type Progress,
} from "./offlinePack";

export { defaultSelection };
export type { GroupKey, PackManifest, Progress };

/** Separate from the service worker's own caches; sw.js never deletes `band-pack-*`. */
export const PACK_CACHE = "band-pack-v1";

const BASE = import.meta.env.BASE_URL;
const SAVED_KEY = "word-atlas:offline";
const NUDGE_KEY = "word-atlas:offline-nudge";

/** A finished run: which manifest version, when, and which groups it covered. */
export interface PackDone {
  version: string;
  at: number;
  groups: GroupKey[];
  /** Set only by the ?packLimit= test path; real downloads never have it. */
  limit?: number;
}

export interface PackState {
  manifest: PackManifest | null;
  manifestError: string | null;
  /** The learner's choice; null means "use the defaults for the current accent". */
  selection: GroupKey[] | null;
  done: PackDone | null;
  phase: "idle" | "running" | "paused" | "error";
  progress: Progress;
  /** Bytes per second over the last few seconds. */
  speed: number;
  /** Seconds left at the current speed, 0 when unknown. */
  eta: number;
  failed: string[];
  message: string | null;
  space: { used: number; quota: number } | null;
  /** Set when the remaining quota looks too small; the UI asks before starting anyway. */
  lowSpace: { remaining: number; needed: number } | null;
  persisted: boolean | null;
  /** The pack cache exists (possibly half-filled), so there is something to resume or delete. */
  cached: boolean;
}

const ZERO: Progress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full: the pack still works, it just forgets its status */
  }
}

const KEYS: GroupKey[] = ["base", "img", "uk", "us", "ex"];
const validDone = (v: unknown): v is PackDone =>
  !!v && typeof v === "object" && typeof (v as PackDone).version === "string" && typeof (v as PackDone).at === "number" && Array.isArray((v as PackDone).groups);

const saved = readJson<{ selection?: unknown; done?: unknown }>(SAVED_KEY);
let state: PackState = {
  manifest: null,
  manifestError: null,
  selection: Array.isArray(saved?.selection) ? (saved.selection as unknown[]).filter((k): k is GroupKey => KEYS.includes(k as GroupKey)) : null,
  done: validDone(saved?.done) ? saved.done : null,
  phase: "idle",
  progress: ZERO,
  speed: 0,
  eta: 0,
  failed: [],
  message: null,
  space: null,
  lowSpace: null,
  persisted: null,
  cached: false,
};

const subs = new Set<() => void>();
let lastEmit = 0;
let timer = 0;

function commit(patch: Partial<PackState>, soon = false) {
  state = { ...state, ...patch };
  if (patch.selection !== undefined || patch.done !== undefined) writeJson(SAVED_KEY, { selection: state.selection ?? undefined, done: state.done ?? undefined });
  const fire = () => {
    lastEmit = Date.now();
    timer = 0;
    subs.forEach((f) => f());
  };
  if (!soon || Date.now() - lastEmit > 150) {
    window.clearTimeout(timer);
    fire();
  } else if (!timer) timer = window.setTimeout(fire, 150);
}

export function usePack(): PackState {
  useEffect(() => {
    void loadManifest();
    void refreshSpace();
  }, []);
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
    () => state,
  );
}

let loading: Promise<void> | null = null;

/** Fetches pack.json (network-first, so a new deploy shows as an update) and checks the stored status still matches the cache. */
export function loadManifest(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch(`${BASE}offline/pack.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = (await res.json()) as PackManifest;
      if (!m || typeof m.version !== "string" || !Array.isArray(m.groups)) throw new Error("bad manifest");
      commit({ manifest: m, manifestError: null });
    } catch {
      loading = null;
      commit({ manifestError: "离线包清单加载失败（可能没有网络）。" });
    }
    // The browser may evict Cache Storage on its own (iOS after a week unused without persistence).
    if ("caches" in window) {
      try {
        const has = await caches.has(PACK_CACHE);
        commit({ cached: has, ...(has ? {} : { done: null }) });
      } catch {
        /* keep the stored status */
      }
    }
  })();
  return loading;
}

export async function refreshSpace() {
  try {
    const e = await navigator.storage?.estimate?.();
    if (e && typeof e.usage === "number" && typeof e.quota === "number") commit({ space: { used: e.usage, quota: e.quota } });
  } catch {
    /* estimate is optional */
  }
}

export function setSelection(keys: GroupKey[]) {
  commit({ selection: keys, lowSpace: null });
}

let run: { controller: AbortController; promise: Promise<void>; paused: boolean } | null = null;

/** Reads the testing-only ?packLimit=N, which caps each id list so an e2e run takes seconds. */
function testLimit(): number | undefined {
  try {
    const n = Number(new URLSearchParams(location.search).get("packLimit"));
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Same-origin build assets this page loaded, plus the fonts its stylesheets reference. */
async function shellAssets(signal: AbortSignal): Promise<string[]> {
  const names = performance.getEntriesByType("resource").map((e) => e.name);
  document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((s) => names.push(s.src));
  document.querySelectorAll<HTMLLinkElement>("link[href]").forEach((l) => names.push(l.href));
  const origin = location.origin;
  const urls = shellUrls(BASE, origin, names).filter((u) => !u.endsWith("/") && !u.endsWith("/index.html"));
  for (const css of urls.filter((u) => u.endsWith(".css"))) {
    try {
      const res = await fetch(css, { signal, headers: { "x-band-pack": "1" } });
      if (res.ok) urls.push(...fontUrlsFromCss(await res.text(), css));
    } catch {
      /* fonts fall back to the ones already loaded */
    }
  }
  return [...new Set(urls)];
}

/** index.html and the scope URL are not hashed, so they are always refreshed rather than skipped. */
async function refreshEntryPages(cache: Cache, signal: AbortSignal): Promise<string[]> {
  const failed: string[] = [];
  for (const path of [BASE, `${BASE}index.html`]) {
    const url = new URL(path, location.origin).href;
    try {
      const res = await fetch(url, { signal, cache: "no-cache", headers: { "x-band-pack": "1" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await cache.put(url, res);
    } catch {
      if (!signal.aborted) failed.push(url);
    }
  }
  return failed;
}

/** Download (or resume) the given groups. Cached files are skipped, so calling it again continues. */
export async function startPack(keys: GroupKey[], force = false) {
  const m = state.manifest;
  if (run || !m) return;
  if (!("caches" in window)) return commit({ phase: "error", message: "这个浏览器不支持离线存储。" });
  setSelection(keys);
  const limit = testLimit();
  const jobsFor = (assets: string[]) => [
    ...assets.map((url) => ({ url, est: 0 })),
    ...buildJobs(m, keys, BASE, location.origin, limit),
  ];

  let cache: Cache;
  try {
    cache = await caches.open(PACK_CACHE);
    commit({ cached: true });
  } catch {
    return commit({ phase: "error", message: "无法打开离线存储（隐私模式下通常不可用）。" });
  }

  // Recordings that moved or were dropped by a new deploy would otherwise sit in storage forever.
  const before = await cachedUrls(cache).catch(() => new Set<string>());
  await Promise.all(staleUrls(before, m, BASE, location.origin).map((u) => cache.delete(u).catch(() => false)));

  if (!force) {
    const have = await cachedUrls(cache).catch(() => new Set<string>());
    const needed = jobsFor([]).reduce((n, j) => n + (have.has(j.url) ? 0 : j.est), 0);
    await refreshSpace();
    const sp = state.space;
    if (sp && sp.quota - sp.used < needed) return commit({ lowSpace: { remaining: Math.max(0, sp.quota - sp.used), needed } });
  }

  const controller = new AbortController();
  const job = { controller, paused: false, promise: Promise.resolve() };
  run = job;
  commit({ phase: "running", failed: [], message: null, lowSpace: null, speed: 0, eta: 0, progress: ZERO });
  job.promise = (async () => {
    try {
      navigator.storage?.persist?.().then((ok) => commit({ persisted: ok }), () => null);
      const samples: [number, number][] = [];
      const failed = await refreshEntryPages(cache, controller.signal);
      const jobs = jobsFor(await shellAssets(controller.signal));
      const res = await runDownload({
        jobs,
        cache,
        signal: controller.signal,
        fetchFn: (url, init) => fetch(url, init),
        onProgress: (p) => {
          const now = Date.now();
          samples.push([now, p.bytesDone]);
          while (samples.length > 2 && now - samples[0][0] > 8000) samples.shift();
          const speed = speedOf(samples);
          commit({ progress: p, speed, eta: speed > 0 ? Math.max(0, p.bytesTotal - p.bytesDone) / speed : 0 }, true);
        },
      });
      failed.push(...res.failed);
      if (res.end === "quota") commit({ phase: "error", failed, message: res.message ?? null });
      else if (res.end === "aborted") commit({ phase: job.paused ? "paused" : "idle", failed, speed: 0, eta: 0 });
      else if (failed.length) commit({ phase: "idle", failed, speed: 0, eta: 0, message: `${failed.length} 个文件没下载成功，点「继续」重试。` });
      else {
        const prev = state.done && state.done.version === m.version && !state.done.limit && !limit ? state.done.groups : [];
        const groups = [...new Set<GroupKey>([...prev, ...keys, "base"])];
        commit({
          phase: "idle",
          failed: [],
          speed: 0,
          eta: 0,
          progress: { ...state.progress, bytesDone: state.progress.bytesTotal },
          done: { version: m.version, at: Date.now(), groups, ...(limit ? { limit } : {}) },
        });
      }
    } catch (e) {
      commit({ phase: "error", message: `下载中断：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      run = null;
      void refreshSpace();
    }
  })();
  return job.promise;
}

/** Stops fetching; what is already cached stays, and startPack continues from there. */
export function pausePack() {
  if (!run) return;
  run.paused = true;
  run.controller.abort();
}

/** Abort and forget the progress display; cached files stay for a later resume. */
export async function cancelPack() {
  const r = run;
  r?.controller.abort();
  await r?.promise;
  commit({ phase: "idle", progress: ZERO, speed: 0, eta: 0, failed: [], message: null, lowSpace: null });
}

export async function deletePack() {
  await cancelPack();
  try {
    await caches.delete(PACK_CACHE);
  } catch {
    /* nothing to delete */
  }
  commit({ done: null, cached: false });
  void refreshSpace();
}

/* ---------- Today page nudge ---------- */

export const nudgeDismissed = () => {
  try {
    return localStorage.getItem(NUDGE_KEY) === "1";
  } catch {
    return false;
  }
};
export function dismissNudge() {
  try {
    localStorage.setItem(NUDGE_KEY, "1");
  } catch {
    /* the card just comes back next visit */
  }
}
