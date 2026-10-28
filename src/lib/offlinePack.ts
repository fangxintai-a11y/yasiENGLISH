/* Pure parts of the 「离线包」 downloader: manifest maths, shell discovery and the resumable download loop.
   No DOM or import.meta access here, so node:test can drive it with fakes. */

export type GroupKey = "base" | "img" | "uk" | "us" | "ex";

/** A directory of same-extension files: pattern "atlas/img/{id}.webp" plus the ids. */
export interface PackSet {
  p: string;
  ids: string[];
}

export interface PackGroup {
  key: GroupKey;
  label: string;
  required?: boolean;
  bytes: number;
  count: number;
  files: string[];
  sets: PackSet[];
}

export interface PackManifest {
  version: string;
  groups: PackGroup[];
}

/** One file to store: absolute URL plus an estimated size for progress of skipped files. */
export interface Job {
  url: string;
  est: number;
}

/** Every site-relative path of a group, optionally keeping only the first `limit` ids of each set (test runs). */
export function groupPaths(g: PackGroup, limit?: number): string[] {
  const out = [...g.files];
  for (const s of g.sets) for (const id of limit ? s.ids.slice(0, limit) : s.ids) out.push(s.p.replace("{id}", id));
  return out;
}

export function defaultSelection(accent: "uk" | "us"): GroupKey[] {
  return ["base", "img", accent, "ex"];
}

/** Keeps manifest order, drops unknown keys and always includes required groups. */
export function selectGroups(m: PackManifest, keys: readonly string[]): PackGroup[] {
  return m.groups.filter((g) => g.required || keys.includes(g.key));
}

export function selectionSize(m: PackManifest, keys: readonly string[]) {
  const picked = selectGroups(m, keys);
  return { files: picked.reduce((n, g) => n + g.count, 0), bytes: picked.reduce((n, g) => n + g.bytes, 0) };
}

/** The pack is complete for `keys` when a finished run covered every selected group. */
export function missingGroups(m: PackManifest, keys: readonly string[], done: readonly string[]): GroupKey[] {
  return selectGroups(m, keys)
    .filter((g) => !done.includes(g.key))
    .map((g) => g.key);
}

/** Jobs for the selected groups in manifest order (base first), skipping duplicates. */
export function buildJobs(m: PackManifest, keys: readonly string[], base: string, origin: string, limit?: number): Job[] {
  const seen = new Set<string>();
  const jobs: Job[] = [];
  for (const g of selectGroups(m, keys)) {
    const paths = groupPaths(g, limit);
    const est = g.count ? g.bytes / g.count : 0;
    for (const p of paths) {
      const url = new URL(base + p, origin).href;
      if (seen.has(url)) continue;
      seen.add(url);
      jobs.push({ url, est });
    }
  }
  return jobs;
}

/** Media folders the pack owns: a cached file there that the manifest no longer lists is left over. */
const OWNED = ["atlas/", "ielts/"];

/**
 * Cached URLs a new manifest no longer lists, such as recordings that moved to a new folder.
 * Only the pack's media folders are considered; app files and anything else are left alone.
 */
export function staleUrls(have: Iterable<string>, m: PackManifest, base: string, origin: string): string[] {
  const keep = new Set<string>();
  for (const g of m.groups) for (const p of groupPaths(g)) keep.add(new URL(base + p, origin).href);
  const roots = OWNED.map((d) => new URL(base + d, origin).href);
  return [...have].filter((u) => !keep.has(u) && roots.some((r) => u.startsWith(r)));
}

/** The minimal Cache surface the downloader needs (real Cache satisfies it). */
export interface CacheLike {
  keys(): Promise<readonly { url: string }[]>;
  put(request: string, response: Response): Promise<void>;
}

/** Absolute URLs already stored; one keys() call beats thousands of match() calls. */
export async function cachedUrls(cache: CacheLike): Promise<Set<string>> {
  return new Set((await cache.keys()).map((r) => r.url));
}

export interface Progress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export type RunEnd = "complete" | "aborted" | "quota";

export interface RunResult {
  end: RunEnd;
  failed: string[];
  message?: string;
}

export interface RunOptions {
  jobs: Job[];
  cache: CacheLike;
  /** fetch-like; receives the abort signal and the marker header that keeps the service worker out of the way. */
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
  concurrency?: number;
  retries?: number;
  /** Wait between attempts; overridable for tests. */
  backoff?: (attempt: number, signal: AbortSignal) => Promise<void>;
}

const isQuota = (e: unknown) => !!e && typeof e === "object" && ((e as { name?: string }).name === "QuotaExceededError" || (e as { code?: number }).code === 22);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Downloads every job that is not already in the cache, `concurrency` at a time. Cached URLs count as done,
 * so a second run (after a pause, reload or app kill) continues where the last one stopped.
 */
export async function runDownload(o: RunOptions): Promise<RunResult> {
  const { jobs, cache, signal } = o;
  const retries = o.retries ?? 3;
  const backoff = o.backoff ?? ((n, s) => sleep(400 * n, s));
  const have = await cachedUrls(cache);
  const p: Progress = { filesDone: 0, filesTotal: jobs.length, bytesDone: 0, bytesTotal: jobs.reduce((n, j) => n + j.est, 0) };
  const todo: Job[] = [];
  for (const j of jobs) {
    if (have.has(j.url)) {
      p.filesDone++;
      p.bytesDone += j.est;
    } else todo.push(j);
  }
  o.onProgress({ ...p });

  const failed: string[] = [];
  let quota = false;
  let next = 0;

  const fetchOne = async (j: Job) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal.aborted) return;
      try {
        const res = await o.fetchFn(j.url, { signal, headers: { "x-band-pack": "1" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (signal.aborted) return;
        const type = res.headers.get("content-type");
        try {
          await cache.put(j.url, new Response(blob, { status: 200, headers: type ? { "Content-Type": type } : {} }));
        } catch (e) {
          if (isQuota(e)) {
            quota = true;
            return;
          }
          throw e;
        }
        p.filesDone++;
        p.bytesDone += blob.size;
        o.onProgress({ ...p });
        return;
      } catch {
        if (signal.aborted || quota) return;
        if (attempt === retries) {
          failed.push(j.url);
          p.filesDone++;
          p.bytesDone += j.est;
          o.onProgress({ ...p });
          return;
        }
        await backoff(attempt, signal);
      }
    }
  };

  const worker = async () => {
    while (!signal.aborted && !quota) {
      const j = todo[next++];
      if (!j) return;
      await fetchOne(j);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 6, todo.length) }, worker));

  if (quota) return { end: "quota", failed, message: "存储空间不足，已停止。已下载的部分会保留，腾出空间后点「继续」即可。" };
  if (signal.aborted) return { end: "aborted", failed };
  return { end: "complete", failed };
}

/* ---------- app shell ---------- */

/** Same-origin URLs of the built app: the entry pages plus everything under <base>assets/ the page loaded. */
export function shellUrls(base: string, origin: string, loaded: readonly string[]): string[] {
  const out = new Set([new URL(base, origin).href, new URL(`${base}index.html`, origin).href]);
  for (const raw of loaded) {
    let u: URL;
    try {
      u = new URL(raw, origin);
    } catch {
      continue;
    }
    if (u.origin === origin && u.pathname.startsWith(`${base}assets/`)) out.add(u.origin + u.pathname);
  }
  return [...out];
}

/** woff2 files a stylesheet points to, so font subsets the page has not needed yet are cached too. */
export function fontUrlsFromCss(css: string, cssUrl: string): string[] {
  const out = new Set<string>();
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+?\.woff2)["']?\s*\)/g)) {
    try {
      out.add(new URL(m[1], cssUrl).href);
    } catch {
      /* ignore malformed url() */
    }
  }
  return [...out];
}

/* ---------- display helpers ---------- */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} 分 ${Math.round(seconds % 60)} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** Rolling-window speed (bytes/s) from [time ms, bytesDone] samples. */
export function speedOf(samples: readonly (readonly [number, number])[], windowMs = 5000): number {
  if (samples.length < 2) return 0;
  const [t1, b1] = samples[samples.length - 1];
  const first = samples.find(([t]) => t1 - t <= windowMs) ?? samples[0];
  const dt = (t1 - first[0]) / 1000;
  return dt > 0 ? Math.max(0, (b1 - first[1]) / dt) : 0;
}
