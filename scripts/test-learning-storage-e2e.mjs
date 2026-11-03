#!/usr/bin/env node
/** Fresh browser storage only; no account, production API, or existing profile. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.BAND_STORAGE_E2E_PORT || 19188), origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
for (const stream of [vite.stdout, vite.stderr]) stream.on("data", (data) => { logs = (logs + data.toString()).slice(-10000); });
try {
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(origin)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  if (process.env.BAND_STORAGE_BASELINE_COMMIT) {
    const commit = process.env.BAND_STORAGE_BASELINE_COMMIT;
    assert.match(commit, /^[a-f0-9]{7,40}$/);
    const original = execFileSync("git", ["show", `${commit}:src/study365/db.ts`], { cwd: root, encoding: "utf8" });
    const script = ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      .replaceAll('from "./protocol"', 'from "/src/study365/protocol.ts"');
    await page.route("**/src/study365/db.ts", (route) => route.fulfill({ contentType: "application/javascript", body: script }));
  }
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/storage-harness", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated storage checks</title>" }));
  await page.goto(`${origin}/storage-harness`);
  const checks = await page.evaluate(async () => {
    const checks = [];
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    const transaction = async (stores, run, version = 2) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("band-learning-v1", version);
        request.onupgradeneeded = () => { for (const name of stores) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite");
        let result;
        run(tx, (value) => { result = value; });
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      });
    };
    const empty = () => ({ heads: {}, revisions: {}, outbox: [], cursor: 0 });
    const revision = (id, bank, seq, kind = "plan") => ({ id, kind, datasetId: bank, planId: "plan-a", revisionId: `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      baseRevision: null, seq, payload: { datasetId: bank, planId: "plan-a", text: "Original historical content" }, contentHash: "0".repeat(64), createdAt: seq, deleted: false, conflict: false });
    const a = revision("plan-a", "bank-a", 1), b = revision("score-b", "bank-b", 2, "assessment");
    const first = { ...empty(), heads: { [a.id]: a }, revisions: { [a.revisionId]: a }, cursor: 70 };
    const second = { ...empty(), heads: { [b.id]: b }, revisions: { [b.revisionId]: b }, cursor: 90 };
    await transaction(["scopes", "recordings"], (tx) => {
      tx.objectStore("scopes").put(first, "storage-user:bank-a");
      tx.objectStore("scopes").put(second, "storage-user:bank-b");
      tx.objectStore("scopes").put(empty(), "different-user:bank-a");
      tx.objectStore("recordings").put(new Blob(["original audio A"], { type: "audio/webm" }), ["storage-user:bank-a", "voice-a"]);
      tx.objectStore("recordings").put(new Blob(["original audio B"], { type: "audio/webm" }), ["storage-user:bank-b", "voice-b"]);
    }, 1);
    const db = await import("/src/study365/db.ts"), codec = await import("/src/study365/recordings.ts");
    if (typeof db.migrateUserScopes === "function") await db.migrateUserScopes("storage-user");
    const scope = typeof db.userScopeKey === "function" ? db.userScopeKey("storage-user") : "account:storage-user";
    const merged = await db.readScope(scope);
    ensure(Object.keys(merged.heads).length === 2 && Object.keys(merged.revisions).length === 2, "bank switch lost plans or scores");
    ensure(merged.cursor === 0 && merged.revisions[a.revisionId].contentHash === a.contentHash, "migration changed immutable history or skipped old stream");
    ensure(await (await db.readRecording(scope, "voice-a")).text() === "original audio A", "audio A missing");
    ensure(await (await db.readRecording(scope, "voice-b")).text() === "original audio B", "audio B missing");
    const keys = await transaction(["scopes"], (tx, set) => { const request = tx.objectStore("scopes").getAllKeys(); request.onsuccess = () => set(request.result); });
    ensure(!keys.includes("storage-user:bank-a") && !keys.includes("storage-user:bank-b") && keys.includes("different-user:bank-a"), "migration did not atomically replace only this user's scopes");
    await db.migrateUserScopes("storage-user");
    ensure(Object.keys((await db.readScope(scope)).revisions).length === 2, "repeated migration duplicated history");
    checks.push("legacy vocabulary scopes and recordings merge once into a user scope, retaining other users and exact history");

    const audio = await db.listRecordings(scope);
    const zip = await codec.encodeRecordingArchive(audio.map((item) => ({ blob: item.blob, metadata: { recordingId: item.id, date: "2026-11-03", prompt: "A recorded question", transcript: "A recorded answer", durationSeconds: 10 } })));
    await transaction(["recordings", "recordingMetadata"], (tx) => { tx.objectStore("recordings").clear(); tx.objectStore("recordingMetadata").clear(); });
    ensure((await db.listRecordings(scope)).length === 0, "test failed to clear original IndexedDB recordings");
    const imported = await db.importRecordingEntries(scope, await codec.decodeRecordingArchive(zip));
    ensure(imported.imported === 2, "ZIP did not restore both recordings");
    ensure(await (await db.readRecording(scope, "voice-a")).text() === "original audio A", "restored bytes differ");
    ensure((await db.listRecordings(scope))[0].metadata.prompt === "A recorded question", "manifest metadata was not restored");
    const duplicate = await db.importRecordingEntries(scope, await codec.decodeRecordingArchive(zip));
    ensure(duplicate.imported === 0 && duplicate.duplicate === 2, "same recording IDs were not deduplicated");
    checks.push("recording ZIP restores exact bytes and metadata after IndexedDB recordings are cleared, then deduplicates re-import");

    let conflict = false;
    try { await db.importRecordingEntries(scope, [
      { id: "new-before-conflict", blob: new Blob(["new"]) }, { id: "voice-a", blob: new Blob(["different"]), metadata: undefined },
    ]); } catch { conflict = true; }
    ensure(conflict && !(await db.readRecording(scope, "new-before-conflict")), "conflicting import partially wrote new records");
    ensure(await (await db.readRecording(scope, "voice-a")).text() === "original audio A", "conflict overwrote original audio");
    checks.push("same ID with different audio aborts the complete import without overwrite or partial additions");

    const badA = revision("ambiguous", "one", 8), badB = { ...badA, payload: { ...badA.payload, text: "Different original" } };
    await transaction(["scopes"], (tx) => {
      tx.objectStore("scopes").put({ ...empty(), heads: { ambiguous: badA }, revisions: { [badA.revisionId]: badA } }, "bad-user:one");
      tx.objectStore("scopes").put({ ...empty(), heads: { ambiguous: badB }, revisions: { [badB.revisionId]: badB } }, "bad-user:two");
    });
    let refused = false;
    try { await db.migrateUserScopes("bad-user"); } catch { refused = true; }
    ensure(refused && Object.keys((await db.readScope("bad-user:one")).heads).length === 1 && Object.keys((await db.readScope("bad-user:two")).heads).length === 1, "failed migration deleted legacy copies");
    ensure(Object.keys((await db.readScope(db.userScopeKey("bad-user"))).heads).length === 0, "failed migration left a partial destination");
    checks.push("ambiguous immutable revisions abort migration while preserving both original scopes");
    return checks;
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, checks }, null, 2));
} finally {
  await browser?.close();
  if (vite.exitCode === null) { const exited = once(vite, "exit"); vite.kill("SIGTERM"); await exited; }
}
