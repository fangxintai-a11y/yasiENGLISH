/* Band Galaxy offline cache: app shell network-first, everything else cache-first.
   The 「离线包」 downloader (src/lib/offline.ts) fills its own `band-pack-*` cache; caches.match() searches it too. */
const VERSION = "band-v2";
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION) && !k.startsWith("band-pack-")).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// <range-helper> (src/lib/range.test.ts runs this exact block, so keep it self-contained)
/** Parse a Range header against a body of `size` bytes: {start,end} inclusive, "unsatisfiable", or null to ignore it. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== "" && Number(m[2]) < start) return null;
  }
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/** Answer a Range request from a full 200 response: 206 with the slice, 416, or the whole body when the header is unusable. */
async function sliceResponse(full, header) {
  const blob = await full.blob();
  const type = full.headers.get("content-type") || blob.type || "application/octet-stream";
  const r = parseRange(header, blob.size);
  if (r === null) return new Response(blob, { status: 200, headers: { "Content-Type": type, "Content-Length": String(blob.size), "Accept-Ranges": "bytes" } });
  if (r === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}`, "Accept-Ranges": "bytes" } });
  return new Response(blob.slice(r.start, r.end + 1, type), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(r.end - r.start + 1),
      "Content-Range": `bytes ${r.start}-${r.end}/${blob.size}`,
      "Accept-Ranges": "bytes",
    },
  });
}
// </range-helper>

/** Prefer the shell cache so a fresh index.html wins over an older copy in the pack cache. */
async function lookup(req) {
  const shell = await caches.open(SHELL);
  return (await shell.match(req)) || (await caches.match(req));
}

/** Offline: the cached copy, or for a page that was never cached, the app shell at the scope URL (works under any sub-path). */
async function offlineShell(req) {
  const hit = (await lookup(req)) || (req.mode === "navigate" ? await lookup(new URL("./", self.registration.scope).href) : undefined);
  return hit || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("x-band-pack")) return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Safari and Chrome stream <audio> with Range requests: serve them from a cached full copy, else go to the network.
  if (req.headers.has("range")) {
    event.respondWith(
      caches.match(req.url).then((hit) => (hit && hit.status === 200 ? sliceResponse(hit, req.headers.get("range")) : fetch(req))),
    );
    return;
  }
  const isShell =
    req.mode === "navigate" ||
    url.pathname.endsWith("/index.json") ||
    url.pathname.endsWith("/ielts/tags.json") ||
    url.pathname.endsWith("/offline/pack.json");
  if (isShell) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Clone now: cloning inside the then() runs after the page has consumed the body and throws.
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => offlineShell(req)),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            const name = /\/atlas\/(img|thumb|audio)\//.test(url.pathname) ? MEDIA : SHELL;
            caches.open(name).then((c) => c.put(req, copy)).then(() => name === MEDIA && trim(MEDIA, 1500));
          }
          return res;
        }),
    ),
  );
});
