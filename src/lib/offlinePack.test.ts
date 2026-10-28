import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildJobs,
  cachedUrls,
  defaultSelection,
  fontUrlsFromCss,
  formatBytes,
  formatEta,
  groupPaths,
  missingGroups,
  runDownload,
  selectGroups,
  selectionSize,
  shellUrls,
  speedOf,
  staleUrls,
  type CacheLike,
  type PackManifest,
} from "./offlinePack";

const MB = 1048576;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${String(i).padStart(3, "0")}`);
const manifest: PackManifest = {
  version: "v1",
  groups: [
    { key: "base", label: "基础（必选）", required: true, bytes: 10 * MB, count: 4, files: ["atlas/index.json"], sets: [{ p: "atlas/entries/{id}.json", ids: ["0", "1", "2"] }] },
    { key: "img", label: "插画", bytes: 100 * MB, count: 10, files: [], sets: [{ p: "atlas/img/{id}.webp", ids: ids(10) }] },
    { key: "uk", label: "英音发音", bytes: 20 * MB, count: 10, files: [], sets: [{ p: "atlas/audio/uk/{id}.mp3", ids: ids(10) }] },
    { key: "us", label: "美音发音", bytes: 22 * MB, count: 10, files: [], sets: [{ p: "atlas/audio/us/{id}.mp3", ids: ids(10) }] },
    { key: "ex", label: "例句朗读", bytes: 50 * MB, count: 12, files: [], sets: [{ p: "atlas/audio/ex/{id}.mp3", ids: ids(10) }, { p: "atlas/audio/ex2/{id}.mp3", ids: ids(2) }] },
  ],
};

test("default selection follows the accent and always has base", () => {
  assert.deepEqual(defaultSelection("uk"), ["base", "img", "uk", "ex"]);
  assert.deepEqual(defaultSelection("us"), ["base", "img", "us", "ex"]);
});

test("selection always includes required groups and keeps manifest order", () => {
  assert.deepEqual(selectGroups(manifest, ["ex", "uk"]).map((g) => g.key), ["base", "uk", "ex"]);
  assert.deepEqual(selectGroups(manifest, ["nope"]).map((g) => g.key), ["base"]);
});

test("selectionSize sums files and bytes of the selected groups", () => {
  assert.deepEqual(selectionSize(manifest, []), { files: 4, bytes: 10 * MB });
  assert.deepEqual(selectionSize(manifest, defaultSelection("uk")), { files: 36, bytes: 180 * MB });
  assert.deepEqual(selectionSize(manifest, defaultSelection("us")), { files: 36, bytes: 182 * MB });
});

test("missingGroups reports what a finished run did not cover", () => {
  assert.deepEqual(missingGroups(manifest, ["img", "uk"], ["base", "img"]), ["uk"]);
  assert.deepEqual(missingGroups(manifest, ["img"], ["base", "img", "uk"]), []);
});

test("groupPaths expands sets and honours the test limit", () => {
  const base = manifest.groups[0];
  assert.deepEqual(groupPaths(base), ["atlas/index.json", "atlas/entries/0.json", "atlas/entries/1.json", "atlas/entries/2.json"]);
  assert.equal(groupPaths(manifest.groups[1], 3).length, 3);
  assert.equal(groupPaths(manifest.groups[4]).length, 12);
});

test("buildJobs prefixes the base path, sets absolute URLs and applies the limit", () => {
  const jobs = buildJobs(manifest, ["uk"], "/yasiENGLISH/", "https://x.test");
  assert.equal(jobs.length, 14);
  assert.equal(jobs[0].url, "https://x.test/yasiENGLISH/atlas/index.json");
  assert.equal(jobs[4].url, "https://x.test/yasiENGLISH/atlas/audio/uk/w000.mp3");
  assert.equal(jobs[4].est, 2 * MB);
  assert.equal(buildJobs(manifest, ["uk"], "/", "https://x.test", 2).length, 1 + 2 + 2);
});

/** In-memory Cache fake: only what the downloader uses. */
function fakeCache(initial: string[] = [], opts: { quotaAfter?: number } = {}) {
  const store = new Map<string, number>(initial.map((u) => [u, 1]));
  const cache: CacheLike = {
    async keys() {
      return [...store.keys()].map((url) => ({ url }));
    },
    async put(request, response) {
      if (opts.quotaAfter !== undefined && store.size >= opts.quotaAfter) throw new DOMException("full", "QuotaExceededError");
      store.set(request, (await response.blob()).size);
    },
  };
  return { cache, store };
}

const okFetch = (log: string[]) => async (url: string) => {
  log.push(url);
  return new Response(new Uint8Array(1000), { headers: { "Content-Type": "audio/mpeg" } });
};
const noWait = async () => {};

test("cachedUrls reads every key once", async () => {
  const { cache } = fakeCache(["https://x.test/a", "https://x.test/b"]);
  assert.deepEqual([...(await cachedUrls(cache))].sort(), ["https://x.test/a", "https://x.test/b"]);
});

test("runDownload stores every file with the marker header and reports progress", async () => {
  const jobs = buildJobs(manifest, ["uk"], "/", "https://x.test");
  const { cache, store } = fakeCache();
  const seen: string[] = [];
  const headers: (string | undefined)[] = [];
  let last = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
  const res = await runDownload({
    jobs,
    cache,
    signal: new AbortController().signal,
    fetchFn: async (url, init) => {
      headers.push((init.headers as Record<string, string>)["x-band-pack"]);
      return okFetch(seen)(url);
    },
    onProgress: (p) => (last = p),
    backoff: noWait,
  });
  assert.equal(res.end, "complete");
  assert.equal(store.size, 14);
  assert.equal(seen.length, 14);
  assert.ok(headers.every((h) => h === "1"));
  assert.equal(last.filesDone, 14);
  assert.equal(last.filesTotal, 14);
  assert.equal(last.bytesDone, 14 * 1000);
});

test("resume: a second run skips URLs already in the cache", async () => {
  const jobs = buildJobs(manifest, ["uk"], "/", "https://x.test");
  const firstHalf = jobs.slice(0, 9).map((j) => j.url);
  const { cache, store } = fakeCache(firstHalf);
  const seen: string[] = [];
  let first = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
  let count = 0;
  const res = await runDownload({
    jobs,
    cache,
    signal: new AbortController().signal,
    fetchFn: okFetch(seen),
    onProgress: (p) => {
      if (!count++) first = p;
    },
  });
  assert.equal(res.end, "complete");
  assert.deepEqual(seen.sort(), jobs.slice(9).map((j) => j.url).sort());
  assert.equal(store.size, 14);
  assert.equal(first.filesDone, 9);
  // Skipped files count with their estimated size right away.
  assert.equal(first.bytesDone, jobs.slice(0, 9).reduce((n, j) => n + j.est, 0));

  const again: string[] = [];
  await runDownload({ jobs, cache, signal: new AbortController().signal, fetchFn: okFetch(again), onProgress: () => {} });
  assert.deepEqual(again, []);
});

test("pause: aborting stops the run and keeps what was stored, then a resume finishes", async () => {
  const jobs = buildJobs(manifest, ["uk", "ex"], "/", "https://x.test");
  const { cache, store } = fakeCache();
  const ctl = new AbortController();
  let n = 0;
  const slow = async (url: string, init: RequestInit) => {
    if (++n === 8) ctl.abort();
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return okFetch([])(url);
  };
  const r1 = await runDownload({ jobs, cache, signal: ctl.signal, fetchFn: slow, onProgress: () => {}, concurrency: 2, backoff: noWait });
  assert.equal(r1.end, "aborted");
  assert.ok(store.size > 0 && store.size < jobs.length);
  const stored = store.size;
  const left: string[] = [];
  const r2 = await runDownload({ jobs, cache, signal: new AbortController().signal, fetchFn: okFetch(left), onProgress: () => {} });
  assert.equal(r2.end, "complete");
  assert.equal(left.length, jobs.length - stored);
  assert.equal(store.size, jobs.length);
});

test("a file is tried three times, then reported as failed without stopping the rest", async () => {
  const jobs = buildJobs(manifest, ["uk"], "/", "https://x.test").slice(0, 6);
  const bad = jobs[2].url;
  const tries = new Map<string, number>();
  const { cache, store } = fakeCache();
  const res = await runDownload({
    jobs,
    cache,
    signal: new AbortController().signal,
    fetchFn: async (url) => {
      tries.set(url, (tries.get(url) ?? 0) + 1);
      return url === bad ? new Response("nope", { status: 503 }) : new Response(new Uint8Array(10));
    },
    onProgress: () => {},
    backoff: noWait,
  });
  assert.equal(res.end, "complete");
  assert.deepEqual(res.failed, [bad]);
  assert.equal(tries.get(bad), 3);
  assert.equal(store.size, 5);

  // A flaky file that succeeds on the second try is not a failure.
  let calls = 0;
  const flaky = await runDownload({
    jobs: jobs.slice(0, 1),
    cache: fakeCache().cache,
    signal: new AbortController().signal,
    fetchFn: async () => (++calls === 1 ? new Response("", { status: 500 }) : new Response(new Uint8Array(10))),
    onProgress: () => {},
    backoff: noWait,
  });
  assert.deepEqual(flaky.failed, []);
  assert.equal(calls, 2);
});

test("QuotaExceededError stops the run with a message and keeps what fit", async () => {
  const jobs = buildJobs(manifest, ["uk"], "/", "https://x.test");
  const { cache, store } = fakeCache([], { quotaAfter: 5 });
  const res = await runDownload({ jobs, cache, signal: new AbortController().signal, fetchFn: okFetch([]), onProgress: () => {}, concurrency: 1, backoff: noWait });
  assert.equal(res.end, "quota");
  assert.match(res.message ?? "", /存储空间不足/);
  assert.equal(store.size, 5);
});

test("downloads run with bounded parallelism", async () => {
  const jobs = buildJobs(manifest, ["img", "uk", "us", "ex"], "/", "https://x.test");
  let live = 0;
  let peak = 0;
  await runDownload({
    jobs,
    cache: fakeCache().cache,
    signal: new AbortController().signal,
    fetchFn: async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return new Response(new Uint8Array(5));
    },
    onProgress: () => {},
  });
  assert.equal(peak, 6);
});

test("shellUrls keeps same-origin build assets under the base path only", () => {
  const out = shellUrls("/yasiENGLISH/", "https://x.test", [
    "https://x.test/yasiENGLISH/assets/index-abc.js",
    "https://x.test/yasiENGLISH/assets/index-abc.js?x=1",
    "https://x.test/yasiENGLISH/atlas/thumb/a.webp",
    "https://cdn.example/yasiENGLISH/assets/evil.js",
    "https://x.test/other/assets/y.js",
    "not a url at all %%",
  ]);
  assert.deepEqual(out, ["https://x.test/yasiENGLISH/", "https://x.test/yasiENGLISH/index.html", "https://x.test/yasiENGLISH/assets/index-abc.js"]);
});

test("fontUrlsFromCss resolves woff2 urls against the stylesheet", () => {
  const css = `@font-face{src:url(./fraunces-latin.woff2) format("woff2"),url(./fraunces-latin.woff) format("woff")}@font-face{src:url("fonts/b.woff2")}`;
  assert.deepEqual(fontUrlsFromCss(css, "https://x.test/yasiENGLISH/assets/index-1.css"), [
    "https://x.test/yasiENGLISH/assets/fraunces-latin.woff2",
    "https://x.test/yasiENGLISH/assets/fonts/b.woff2",
  ]);
});

test("formatting and speed helpers", () => {
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(12.34 * MB), "12.3 MB");
  assert.equal(formatBytes(576 * MB), "576 MB");
  assert.equal(formatBytes(1.5 * 1024 * MB), "1.50 GB");
  assert.equal(formatEta(0), "—");
  assert.equal(formatEta(42.2), "43 秒");
  assert.equal(formatEta(125), "2 分 5 秒");
  assert.equal(speedOf([[0, 0]]), 0);
  assert.equal(speedOf([[0, 0], [1000, 2000], [2000, 6000]]), 3000);
  // Samples older than the window are ignored.
  assert.equal(speedOf([[0, 0], [10000, 1000], [11000, 3000]], 5000), 2000);
});

test("staleUrls finds media the manifest dropped and leaves everything else", () => {
  const o = "https://x.test";
  const have = [
    `${o}/app/atlas/audio/ex/w000.mp3`, // moved away: stale
    `${o}/app/atlas/audio/uk/w000.mp3`, // still listed
    `${o}/app/ielts/phrase/old-one.mp3`, // dropped: stale
    `${o}/app/assets/index-abc.js`, // app shell: not the pack's business
    `${o}/other/atlas/audio/ex/w000.mp3`, // another base
  ];
  const m: PackManifest = { ...manifest, groups: manifest.groups.map((g) => (g.key === "ex" ? { ...g, sets: [{ p: "atlas/audio/say/{id}.mp3", ids: ids(10) }] } : g)) };
  assert.deepEqual(staleUrls(have, m, "/app/", o), [`${o}/app/atlas/audio/ex/w000.mp3`, `${o}/app/ielts/phrase/old-one.mp3`]);
});
