// Writes public/offline/pack.json: what the 「离线包」 downloader stores in Cache Storage.
//
// Each group lists its files two ways to keep the manifest small:
//   files: literal site-relative paths
//   sets:  { p: "atlas/img/{id}.webp", ids: [...] }  (a directory of same-extension files)
// Paths have no leading slash; the client prefixes import.meta.env.BASE_URL.
// Deterministic: sorted input, no timestamps; version = short hash of every path and size.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const out = path.join(root, "offline", "pack.json");

/** Directories with at least this many files of one extension become a `set`. */
const SET_MIN = 20;

const GROUPS = [
  { key: "base", label: "基础（必选）", required: true },
  { key: "img", label: "插画" },
  { key: "uk", label: "英音发音" },
  { key: "us", label: "美音发音" },
  { key: "ex", label: "例句朗读" },
];

const BASE_FILES = new Set(["atlas/index.json", "ielts/tags.json", "favicon.svg", "icon-512.png", "manifest.webmanifest"]);
const BASE_DIRS = ["atlas/entries/", "ielts/mnemo/", "atlas/thumb/", "brand/", "sfx/"];

function groupOf(rel) {
  if (BASE_FILES.has(rel) || BASE_DIRS.some((d) => rel.startsWith(d))) return "base";
  if (rel.startsWith("atlas/img/")) return "img";
  if (rel.startsWith("atlas/audio/uk/")) return "uk";
  if (rel.startsWith("atlas/audio/us/")) return "us";
  if (rel.startsWith("atlas/audio/ex/") || rel.startsWith("atlas/audio/ex2/")) return "ex";
  return null;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const groups = new Map(GROUPS.map((g) => [g.key, { ...g, bytes: 0, count: 0, paths: [] }]));
const skipped = [];
const lines = [];

for (const full of walk(root)) {
  const rel = path.relative(root, full).split(path.sep).join("/");
  if (rel === "sw.js" || rel.startsWith("offline/")) continue;
  const key = groupOf(rel);
  if (!key) {
    skipped.push(rel);
    continue;
  }
  const size = fs.statSync(full).size;
  const g = groups.get(key);
  g.bytes += size;
  g.count++;
  g.paths.push(rel);
  lines.push(`${rel}:${size}`);
}

function pack(paths) {
  const buckets = new Map();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dot = p.lastIndexOf(".");
    const ext = dot > slash ? p.slice(dot) : "";
    const k = `${p.slice(0, slash + 1)}\0${ext}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(p);
  }
  const files = [];
  const sets = [];
  for (const [k, list] of [...buckets].sort((a, b) => cmp(a[0], b[0]))) {
    const [dir, ext] = k.split("\0");
    if (list.length >= SET_MIN) sets.push({ p: `${dir}{id}${ext}`, ids: list.map((p) => p.slice(dir.length, p.length - ext.length)).sort(cmp) });
    else files.push(...list);
  }
  return { files: files.sort(cmp), sets };
}

const version = createHash("sha1").update(lines.sort(cmp).join("\n")).digest("hex").slice(0, 10);
const manifest = {
  version,
  groups: [...groups.values()].map(({ key, label, required, bytes, count, paths }) => ({
    key,
    label,
    ...(required ? { required: true } : {}),
    bytes,
    count,
    ...pack(paths),
  })),
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(manifest) + "\n");

const mb = (n) => (n / 1048576).toFixed(1) + " MB";
console.log(`offline pack ${version}: ${manifest.groups.map((g) => `${g.key} ${g.count} files ${mb(g.bytes)}`).join(", ")}`);
if (skipped.length) console.warn(`not in any group: ${skipped.join(", ")}`);
