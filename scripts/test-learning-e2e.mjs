#!/usr/bin/env node
/**
 * P1 learning-record integration checks. Uses Vite dev, a disposable SQLite DB,
 * two fresh browser contexts, and temporary accounts. Does not use production,
 * an existing Chrome profile, or a user's study data. The appended R1 suite
 * uses production preview and its service worker: run npm run build first.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(process.env.BAND_LEARNING_E2E_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const apiPort = Number(process.env.BAND_LEARNING_E2E_API_PORT || 16189);
const webPort = Number(process.env.BAND_LEARNING_E2E_WEB_PORT || 16188);
assert.ok(Number.isInteger(apiPort) && apiPort > 1024 && apiPort < 65536);
assert.ok(Number.isInteger(webPort) && webPort > 1024 && webPort < 65536 && webPort !== apiPort);
const origin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "band-learning-e2e-"));
const dbPath = path.join(directory, "learning.sqlite3");
const suffix = randomBytes(5).toString("hex");
const accountA = `learn_a_${suffix}`;
const accountB = `learn_b_${suffix}`;
const password = randomBytes(24).toString("base64url");
const setupToken = randomBytes(24).toString("base64url");
const checks = [];
const pageErrors = [];
const apiReplies = [];
const logs = [];
let backend;
let vite;
let browser;
let phoneContext;
let desktopContext;
let phone;
let desktop;
let success = false;
let phase = "startup";
let failure;
let cleaning;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}

function launch(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const output of [child.stdout, child.stderr]) output.on("data", (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 40) logs.shift();
  });
  child.on("error", (error) => logs.push(error.message));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => null);
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    await Promise.all([phoneContext?.close().catch(() => null), desktopContext?.close().catch(() => null)]);
    await browser?.close().catch(() => null);
    await Promise.all([stop(vite), stop(backend)]);
    await fs.rm(directory, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
});
async function startBackend() {
  backend = launch(process.env.BAND_LEARNING_E2E_PYTHON || "python3", ["server/app.py", "--host", "127.0.0.1", "--port", String(apiPort), "--db", dbPath], {
    BAND_DB_PATH: dbPath, BAND_PUBLIC_ORIGIN: origin, BAND_COOKIE_SECURE: "0", BAND_TRUST_PROXY: "0",
    BAND_ALLOW_REGISTER: "1", BAND_MAX_ACCOUNTS: "2", BAND_SETUP_TOKEN: setupToken, BAND_SETUP_TOKEN_HASH: "",
    BAND_LEARNING_WRITES_ENABLED: "1",
  });
  await eventually(async () => {
    if (backend.exitCode !== null) throw new Error("temporary API exited");
    const response = await fetch(`${apiOrigin}/api/health`);
    return response.ok && (await response.json()).ok === true;
  }, "temporary API did not start", 15000);
}
async function moduleCall(page, name, ...args) {
  return page.evaluate(async ({ name, args }) => {
    const repository = await import("/src/study365/repository.ts");
    return repository[name](...args);
  }, { name, args });
}
const state = (page) => moduleCall(page, "getLearningState");
const sync = (page) => moduleCall(page, "syncNow");
const save = (page, value) => moduleCall(page, "saveRecord", value);
async function initialize(page) {
  await page.goto(`${origin}/#/me`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { store } = await import("/src/store/store.ts");
    store.useDataset("word-atlas-open");
    const repository = await import("/src/study365/repository.ts");
    repository.startLearningRecords();
  });
  await eventually(async () => (await state(page)).ready, "learning IndexedDB did not open");
}
async function login(page, username, create = false) {
  await page.evaluate(async ({ username, password, setupToken, create }) => {
    const cloud = await import("/src/store/cloudSync.ts");
    await cloud.loginCloud(username, password, setupToken, create);
  }, { username, password, setupToken: create ? setupToken : "", create });
  await eventually(async () => {
    const s = await state(page);
    return s.ready && s.userId !== null;
  }, "learning scope did not follow account login");
  await sync(page);
}
async function logout(page) {
  await page.evaluate(async () => { const cloud = await import("/src/store/cloudSync.ts"); await cloud.logoutCloud(); });
  await eventually(async () => { const s = await state(page); return s.ready && s.userId === null; }, "learning scope did not leave the old account");
}
async function pullUntil(page, predicate, description) {
  await eventually(async () => { await sync(page); return predicate(await state(page)); }, description);
}
async function serverRevisions(page, id) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/learning/v2/records/${encodeURIComponent(id)}/revisions`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error(`history returned ${r.status}`);
    return (await r.json()).items;
  }, id);
}
const planPayload = () => ({ startDate: "2026-11-03", timeZone: "Asia/Shanghai", studyBudgetMinutes: 120, targetBand: 8, sectionTargets: { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 }, enabled: true, syllabusUnit: 1, materialLevel: "A1", curriculumVersion: "p1-isolated-e2e" });
function observe(page, label) {
  page.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/learning/")) apiReplies.push({ status: response.status(), cache: response.headers()["cache-control"] || "", fromServiceWorker: response.fromServiceWorker() });
  });
}

try {
  await startBackend();
  vite = launch(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { BAND_API_TARGET: apiOrigin });
  await eventually(async () => {
    if (vite.exitCode !== null) throw new Error("Vite exited");
    const response = await fetch(`${origin}/api/capabilities`);
    return response.ok && (await response.json()).learningRecords === 2;
  }, "Vite did not proxy the learning API", 15000);
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
  desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  for (const context of [desktopContext, phoneContext]) await context.addInitScript(() => {
    localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", dailyNew: 0 }));
  });
  desktop = await desktopContext.newPage(); phone = await phoneContext.newPage();
  observe(desktop, "desktop"); observe(phone, "phone");
  await Promise.all([initialize(desktop), initialize(phone)]);

  phase = "same-account cross-device learning records";
  await login(desktop, accountA, true);
  await login(phone, accountA);
  const userA = (await state(desktop)).userId;
  assert.equal((await state(phone)).userId, userA);
  const plan = await save(desktop, { id: "p1-plan", kind: "plan", payload: planPayload() });
  await sync(desktop);
  const initialEssay = await save(desktop, { id: "p1-essay", kind: "essay", payload: { taskType: "task2", planId: plan.id, prompt: "Describe a useful daily habit.", text: "I read a short article every morning." } });
  await sync(desktop);
  await pullUntil(phone, (s) => s.records.some((r) => r.id === plan.id) && s.records.some((r) => r.revisionId === initialEssay.revisionId), "phone did not receive the plan and essay");
  checks.push("同账号电脑和手机能互见计划与作文");

  phase = "same-week human and AI calibration stays independent and appears on both devices";
  const calibrationPanel = (page) => page.getByRole("region", { name: "每周评分校准提示" });
  assert.equal(await calibrationPanel(desktop).count(), 0, "an uncalibrated draft must not claim a human comparison");
  const calibrationPayload = { planId: plan.id, kind: "weekly-calibration", weekIndex: 1, date: "2026-11-03",
    workId: initialEssay.id, workRevisionId: initialEssay.revisionId, inputHash: initialEssay.contentHash, taskType: "task2" };
  const humanCalibration = await save(desktop, { id: "p1-calibration-human", kind: "assessment", payload: {
    ...calibrationPayload, source: "human", bands: { taskResponse: 7, coherence: 7, lexical: 7, grammar: 7 },
  } });
  const aiCalibration = await save(desktop, { id: "p1-calibration-ai", kind: "assessment", payload: {
    ...calibrationPayload, source: "ai", bands: { taskResponse: 7.5, coherence: 7, lexical: 7, grammar: 7 },
  } });
  assert.notEqual(humanCalibration.id, aiCalibration.id);
  await sync(desktop);
  await pullUntil(phone, (s) => [humanCalibration, aiCalibration].every((record) => s.records.some((r) => r.revisionId === record.revisionId)), "phone did not receive both independent weekly calibrations");
  for (const page of [desktop, phone]) {
    const records = (await state(page)).records.filter((r) => [humanCalibration.id, aiCalibration.id].includes(r.id));
    assert.equal(records.length, 2, "human and AI calibration may not overwrite one another for the same week");
    assert.deepEqual(records.map((r) => r.payload.source).sort(), ["ai", "human"]);
    assert.ok(records.every((r) => r.planId === plan.id && r.payload.weekIndex === 1 && r.payload.workRevisionId === initialEssay.revisionId && r.payload.inputHash === initialEssay.contentHash));
    await eventually(async () => {
      const panel = calibrationPanel(page);
      if (!(await panel.isVisible())) return false;
      const text = await panel.innerText();
      return /第\s*1\s*周/.test(text) && text.includes("AI估分") && /高\s*0\.5/.test(text) && text.includes(initialEssay.id);
    }, "Me did not show the exact same-draft week 1 AI calibration difference");
  }
  for (const calibration of [humanCalibration, aiCalibration]) {
    const revisions = await serverRevisions(desktop, calibration.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revisionId, calibration.revisionId);
    assert.deepEqual(revisions[0].payload.bands, calibration.payload.bands);
  }
  checks.push("同周同稿真人与AI校准独立保存并同步到手机，我的页面显示第1周AI估分高0.5的练习偏差");

  phase = "recording blobs stay on the original device";
  await desktop.evaluate(async () => {
    const repository = await import("/src/study365/repository.ts");
    await repository.saveRecording("p1-take", new Blob(["isolated-recording-fixture"], { type: "audio/webm" }));
  });
  await save(desktop, { id: "p1-speaking", kind: "speaking", payload: { planId: plan.id, prompt: "Tell me about your morning.", transcript: "I read before work.", recordingId: "p1-take", recordingDevice: "isolated desktop", durationSeconds: 5 } });
  await sync(desktop);
  await pullUntil(phone, (s) => s.records.some((r) => r.id === "p1-speaking"), "phone did not receive speaking metadata");
  const blobState = async (page) => page.evaluate(async () => { const r = await import("/src/study365/repository.ts"); const blob = await r.getRecording("p1-take"); return { exists: !!blob, text: blob ? await blob.text() : null }; });
  assert.deepEqual(await blobState(desktop), { exists: true, text: "isolated-recording-fixture" });
  assert.deepEqual(await blobState(phone), { exists: false, text: null });
  checks.push("口语文字和录音元数据同步，录音Blob仅原设备可读");

  phase = "one user's learning identity spans vocabulary datasets";
  const mission = await save(desktop, { id: "p1-mission", kind: "mission", payload: { planId: plan.id, date: "2026-11-03", day: 1, taskId: "reading-practice", skill: "reading", status: "completed", plannedMinutes: 20, actualMinutes: 18 } });
  const assessment = await save(desktop, { id: "p1-assessment", kind: "assessment", payload: { planId: plan.id, kind: "baseline", source: "self", date: "2026-11-03", scores: { reading: null }, note: "Starting level is not yet established." } });
  await sync(desktop);
  const beforeDatasetSwitch = await state(desktop);
  const datasetB = "word-atlas-e2e-secondary";
  const switchDataset = async (page, datasetId) => page.evaluate(async (datasetId) => {
    const { store } = await import("/src/store/store.ts");
    store.useDataset(datasetId);
  }, datasetId);
  await switchDataset(desktop, datasetB);
  const inDatasetB = await state(desktop);
  assert.equal(inDatasetB.userId, userA);
  assert.equal(inDatasetB.records.length, beforeDatasetSwitch.records.length);
  for (const record of [plan, mission, assessment]) {
    assert.equal(inDatasetB.records.find((r) => r.id === record.id)?.revisionId, record.revisionId);
  }
  assert.ok(inDatasetB.records.some((r) => r.id === "p1-speaking"));
  assert.deepEqual(await blobState(desktop), { exists: true, text: "isolated-recording-fixture" });
  const datasetBEssay = await save(desktop, { id: "p1-source-b-essay", kind: "essay", payload: { taskType: "task2", planId: plan.id, text: "My learning plan follows my account across vocabulary datasets." } });
  assert.equal(datasetBEssay.datasetId, datasetB);
  await sync(desktop);
  await pullUntil(phone, (s) => [mission, assessment, datasetBEssay].every((record) => s.records.some((r) => r.revisionId === record.revisionId)), "phone filtered learning records from another source dataset");
  await switchDataset(desktop, "word-atlas-open");
  await sync(desktop);
  const afterDatasetSwitch = await state(desktop);
  assert.equal(afterDatasetSwitch.records.length, beforeDatasetSwitch.records.length + 1);
  assert.equal(new Set(afterDatasetSwitch.records.map((r) => r.id)).size, afterDatasetSwitch.records.length);
  assert.equal(afterDatasetSwitch.records.find((r) => r.id === datasetBEssay.id)?.datasetId, datasetB);
  assert.equal((await serverRevisions(desktop, datasetBEssay.id)).length, 1);
  assert.deepEqual(await blobState(desktop), { exists: true, text: "isolated-recording-fixture" });
  checks.push("同账号换词库仍可读计划、任务、测评和本机录音，来源B新记录切回后不重复");

  phase = "a permanently rejected record is isolated and reviewable in Me";
  const rejectedPath = "**/api/learning/v2/records/p1-quarantined-essay";
  const rejectedRequests = [];
  const rejectOneRecord = async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    rejectedRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ code: "invalid_learning_record", error: "Isolated permanent rejection for this draft." }) });
  };
  await desktop.route(rejectedPath, rejectOneRecord);
  const rejectedEssay = await save(desktop, { id: "p1-quarantined-essay", kind: "essay", payload: { taskType: "task2", planId: plan.id, text: "This original draft must remain exportable after a server rejection." } });
  const followingEssay = await save(desktop, { id: "p1-after-quarantine", kind: "essay", payload: { taskType: "task2", planId: plan.id, text: "An independent valid draft still reaches the server." } });
  await sync(desktop);
  await eventually(async () => {
    const s = await state(desktop);
    return s.quarantined === 1 && s.pending === 0 && s.syncStatus === "partial";
  }, "permanent rejection did not become a partial sync with one isolated record");
  assert.equal((await serverRevisions(desktop, followingEssay.id)).filter((r) => r.revisionId === followingEssay.revisionId).length, 1);
  assert.ok(rejectedRequests.length > 0);
  const rejectedRequest = rejectedRequests[0];
  await desktop.reload({ waitUntil: "domcontentloaded" });
  await moduleCall(desktop, "startLearningRecords");
  await eventually(async () => { const s = await state(desktop); return s.ready && s.userId === userA && s.quarantined === 1; }, "quarantine did not survive a page reload");
  await sync(desktop);
  await desktop.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "今日", exact: true }).click();
  const syncHint = desktop.locator('a[href="#/me?section=learning-sync"]').filter({ hasText: "查看同步问题" });
  await syncHint.waitFor({ timeout: 6000 });
  assert.match(await syncHint.innerText(), /有\s*1\s*条学习记录未同步/);
  await syncHint.click();
  await eventually(() => new URL(desktop.url()).hash === "#/me?section=learning-sync", "Today sync issue hint did not open the focused Me route");
  const issuesPanel = desktop.getByRole("region", { name: "未能同步的学习记录" });
  await issuesPanel.waitFor();
  assert.match(await issuesPanel.innerText(), /有 1 条记录未能同步/);
  const originalDownload = desktop.waitForEvent("download");
  await issuesPanel.getByRole("button", { name: "导出未同步原文", exact: true }).click();
  const original = await originalDownload;
  assert.match(original.suggestedFilename(), /^bandgalaxy-unsynced-.*\.json$/);
  const originalPath = path.join(directory, "unsynced-original.json");
  await original.saveAs(originalPath);
  const exportedOriginal = JSON.parse(await fs.readFile(originalPath, "utf8"));
  assert.equal(exportedOriginal.format, "band-galaxy-unsynced");
  assert.equal(exportedOriginal.records.length, 1);
  assert.equal(exportedOriginal.records[0].recordId, rejectedEssay.id);
  assert.equal(exportedOriginal.records[0].code, "invalid_learning_record");
  assert.deepEqual(exportedOriginal.records[0].body, rejectedRequest);
  assert.equal(exportedOriginal.records[0].body.payload.text, rejectedEssay.payload.text);
  await desktop.unroute(rejectedPath, rejectOneRecord);
  await issuesPanel.getByRole("button", { name: "重试同步", exact: true }).click();
  await eventually(async () => { const s = await state(desktop); return s.pending === 0 && s.quarantined === 0 && s.syncStatus === "synced"; }, "UI retry did not clear the recovered quarantine");
  assert.equal(await issuesPanel.count(), 0);
  const retried = (await serverRevisions(desktop, rejectedEssay.id)).filter((r) => r.revisionId === rejectedEssay.revisionId);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].payload.text, rejectedEssay.payload.text);
  checks.push("单条400坏记录持久隔离、后续好记录上传；今日提示可跳回我的页面导出原文并原ID重试清除");

  phase = "recording ZIP downloads and restores original bytes through Me";
  const recordingPanel = desktop.getByRole("region", { name: "学习录音备份" });
  const originalRecordingBytes = await desktop.evaluate(async () => {
    const r = await import("/src/study365/repository.ts");
    return [...new Uint8Array(await (await r.getRecording("p1-take")).arrayBuffer())];
  });
  const beforeBackup = await moduleCall(desktop, "listRecordingBackups");
  assert.equal(beforeBackup.length, 1);
  assert.equal(beforeBackup[0].prompt, "Tell me about your morning.");
  await eventually(async () => !(await recordingPanel.getByRole("button", { name: "导出录音ZIP", exact: true }).isDisabled()), "recording ZIP export did not become available");
  const zipDownload = desktop.waitForEvent("download");
  await recordingPanel.getByRole("button", { name: "导出录音ZIP", exact: true }).click();
  const zip = await zipDownload;
  assert.match(zip.suggestedFilename(), /^bandgalaxy-recordings-.*\.zip$/);
  const zipPath = path.join(directory, "recordings-original.zip");
  await zip.saveAs(zipPath);
  const zipBytes = await fs.readFile(zipPath);
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
  const cleared = await desktop.evaluate(async (userId) => {
    const scope = `account:${userId}`;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("band-learning-v1", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["recordings", "recordingMetadata"], "readwrite");
        const counts = { recordings: 0, recordingMetadata: 0 };
        for (const name of Object.keys(counts)) {
          const cursor = tx.objectStore(name).openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            if (Array.isArray(item.key) && item.key[0] === scope) { item.delete(); counts[name]++; }
            item.continue();
          };
        }
        tx.oncomplete = () => { db.close(); resolve(counts); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, userA);
  assert.equal(cleared.recordings, 1);
  assert.deepEqual(await blobState(desktop), { exists: false, text: null });
  await desktop.reload({ waitUntil: "domcontentloaded" });
  await moduleCall(desktop, "startLearningRecords");
  await eventually(async () => { const s = await state(desktop); return s.ready && s.userId === userA; }, "recording recovery did not reopen the account");
  await sync(desktop);
  await eventually(async () => (await recordingPanel.innerText()).includes("保存了 0 段录音"), "cleared recording list was not reflected in Me");
  assert.ok((await state(desktop)).records.some((r) => r.id === "p1-speaking"), "recording deletion must retain synchronized speaking metadata");
  await recordingPanel.getByLabel("选择录音ZIP备份").setInputFiles(zipPath);
  await eventually(async () => (await recordingPanel.innerText()).includes("已恢复 1 段录音，跳过 0 段相同录音"), "UI ZIP import did not restore the recording");
  const restoredRecordingBytes = await desktop.evaluate(async () => {
    const r = await import("/src/study365/repository.ts");
    return [...new Uint8Array(await (await r.getRecording("p1-take")).arrayBuffer())];
  });
  assert.deepEqual(restoredRecordingBytes, originalRecordingBytes);
  assert.deepEqual(await moduleCall(desktop, "listRecordingBackups"), beforeBackup);
  const restoredMetadata = await desktop.evaluate(async (userId) => {
    const db = await import("/src/study365/db.ts");
    return (await db.listRecordings(db.userScopeKey(userId))).find((r) => r.id === "p1-take")?.metadata;
  }, userA);
  assert.equal(restoredMetadata.prompt, beforeBackup[0].prompt);
  assert.equal(restoredMetadata.transcript, beforeBackup[0].transcript);
  await recordingPanel.getByLabel("选择录音ZIP备份").setInputFiles(zipPath);
  await eventually(async () => (await recordingPanel.innerText()).includes("已恢复 0 段录音，跳过 1 段相同录音"), "duplicate ZIP import was not idempotent");
  assert.equal((await moduleCall(desktop, "listRecordingBackups")).length, beforeBackup.length);
  assert.deepEqual(await blobState(phone), { exists: false, text: null });
  checks.push("我的页面下载录音ZIP，清除本账号音频与本地清单后导入恢复原字节，重复导入不增加");

  phase = "offline edit and durable outbox reload";
  await phoneContext.setOffline(true);
  const offlineEssay = await save(phone, { id: "p1-essay", kind: "essay", payload: { taskType: "task2", ...initialEssay.payload, text: "I read a short article every morning. I write down two useful phrases." } });
  assert.ok((await state(phone)).pending > 0);
  // Restore static-file connectivity while keeping synchronization unavailable.
  // Vite dev has no production app-shell cache; this tests IDB/outbox reload, not PWA caching.
  const unavailable = (route) => route.abort("failed");
  await phone.route("**/api/learning/**", unavailable);
  await phoneContext.setOffline(false);
  await phone.reload({ waitUntil: "domcontentloaded" });
  await moduleCall(phone, "startLearningRecords");
  await eventually(async () => { const s = await state(phone); return s.ready && s.userId === userA && s.pending > 0; }, "reload lost the account's durable outbox");
  assert.ok((await state(phone)).records.some((r) => r.revisionId === offlineEssay.revisionId));
  await phone.unroute("**/api/learning/**", unavailable);
  await sync(phone);
  await pullUntil(desktop, (s) => s.records.some((r) => r.revisionId === offlineEssay.revisionId), "offline essay did not reach desktop after reconnect");
  checks.push("离线修改、同步不可用时刷新、联网补传均保留同一修订和待上传队列");

  phase = "lost HTTP response retries the same immutable revision";
  const receiptPath = "**/api/learning/v2/records/p1-receipt-essay";
  const requestIds = [];
  let firstCommitted = false;
  let holdRetries = true;
  const loseResponse = async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON();
    requestIds.push({ revisionId: body.revisionId, mutationId: body.mutationId });
    if (!firstCommitted) {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      firstCommitted = true;
      await route.abort("failed");
    } else if (holdRetries) await route.abort("failed");
    else await route.continue();
  };
  await desktop.route(receiptPath, loseResponse);
  const receiptEssay = await save(desktop, { id: "p1-receipt-essay", kind: "essay", payload: { taskType: "task2", planId: plan.id, text: "A response can be lost without losing my work." } });
  await sync(desktop);
  await eventually(() => firstCommitted, "the first PUT did not commit before response loss");
  assert.ok((await state(desktop)).pending > 0);
  holdRetries = false;
  await sync(desktop);
  await eventually(async () => (await state(desktop)).pending === 0, "receipt retry did not acknowledge the outbox");
  await desktop.unroute(receiptPath, loseResponse);
  assert.ok(requestIds.length >= 2);
  assert.ok(requestIds.every((ids) => ids.revisionId === receiptEssay.revisionId && ids.mutationId === requestIds[0].mutationId));
  assert.equal((await serverRevisions(desktop, receiptEssay.id)).filter((r) => r.revisionId === receiptEssay.revisionId).length, 1);
  checks.push("服务端已提交但响应丢失后，重试沿用原ID且仅保留一份修订");

  phase = "offline concurrent edits retain both copies";
  await Promise.all([sync(phone), sync(desktop)]);
  const commonRevision = (await state(phone)).records.find((r) => r.id === "p1-essay").revisionId;
  assert.equal((await state(desktop)).records.find((r) => r.id === "p1-essay").revisionId, commonRevision);
  await Promise.all([phoneContext.setOffline(true), desktopContext.setOffline(true)]);
  const phoneEdit = await save(phone, { id: "p1-essay", kind: "essay", payload: { taskType: "task2", ...offlineEssay.payload, text: "Phone revision: I read before breakfast." } });
  const desktopEdit = await save(desktop, { id: "p1-essay", kind: "essay", payload: { taskType: "task2", ...offlineEssay.payload, text: "Desktop revision: I read after breakfast." } });
  await desktopContext.setOffline(false); await sync(desktop);
  await phoneContext.setOffline(false); await sync(phone);
  await pullUntil(phone, (s) => s.conflicts.some((r) => r.revisionId === phoneEdit.revisionId), "concurrent phone edit was not retained as a conflict copy");
  const history = await moduleCall(phone, "listRevisions", "p1-essay");
  assert.ok(history.some((r) => r.revisionId === phoneEdit.revisionId && r.payload.text === phoneEdit.payload.text));
  assert.ok(history.some((r) => r.revisionId === desktopEdit.revisionId && r.payload.text === desktopEdit.payload.text));
  const resolved = await moduleCall(phone, "resolveConflict", "p1-essay", phoneEdit.revisionId);
  await sync(phone);
  await pullUntil(desktop, (s) => s.records.some((r) => r.revisionId === resolved.revisionId), "chosen conflict resolution did not propagate");
  checks.push("双端离线并改保留两份原稿，并可选择一份形成新修订");

  phase = "legacy vocabulary writes cannot delete learning records";
  const legacyStatus = await desktop.evaluate(async () => {
    for (let i = 0; i < 5; i++) {
      const current = await (await fetch("/api/sync/word-atlas-open", { cache: "no-store", credentials: "same-origin" })).json();
      const response = await fetch("/api/sync/word-atlas-open", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: current.revision, commitId: crypto.randomUUID(), snapshot: { progress: { version: 2, datasetId: "word-atlas-open", cards: {}, session: null }, settings: {} } }) });
      if (response.status !== 409) return response.status;
    }
    return 409;
  });
  assert.equal(legacyStatus, 200);
  await sync(desktop);
  assert.ok((await state(desktop)).records.some((r) => r.id === plan.id));
  assert.ok((await serverRevisions(desktop, "p1-essay")).some((r) => r.revisionId === resolved.revisionId));
  checks.push("旧版合法词汇快照写回不会删除新计划、作文或历史修订");

  phase = "account switches do not upload another account's pending drafts";
  await phone.route("**/api/learning/**", unavailable);
  const pendingA = await save(phone, { id: "p1-pending-account-a", kind: "essay", payload: { taskType: "task2", planId: plan.id, text: "This pending draft belongs to account A only." } });
  await logout(phone);
  await login(phone, accountB, true);
  const userB = (await state(phone)).userId;
  assert.notEqual(userB, userA);
  assert.equal((await state(phone)).records.length, 0);
  assert.equal((await state(phone)).pending, 0);
  await phone.unroute("**/api/learning/**", unavailable);
  await sync(phone);
  const accountBRecords = await phone.evaluate(async () => (await (await fetch("/api/learning/v2/records", { cache: "no-store", credentials: "same-origin" })).json()).items);
  assert.equal(accountBRecords.length, 0);
  assert.deepEqual(await blobState(phone), { exists: false, text: null });
  await logout(phone); await login(phone, accountA);
  await pullUntil(desktop, (s) => s.records.some((r) => r.revisionId === pendingA.revisionId), "account A's pending draft did not resume after returning");
  checks.push("切换账号不混入旧账号待上传草稿，返回原账号后可续传");

  phase = "recording storage keys cannot collide across namespaces";
  const collision = await desktop.evaluate(async () => {
    const db = await import("/src/study365/db.ts");
    await db.putRecording("fixture:alpha", "beta:take", new Blob(["first namespace"]));
    await db.putRecording("fixture:alpha:beta", "take", new Blob(["second namespace"]));
    return [await (await db.readRecording("fixture:alpha", "beta:take")).text(), await (await db.readRecording("fixture:alpha:beta", "take")).text()];
  });
  assert.deepEqual(collision, ["first namespace", "second namespace"]);
  checks.push("录音的账号命名空间使用复合键，不会因冒号产生覆盖");

  phase = "visitor drafts and recordings require an explicit account import";
  const visitorContext = await browser.newContext({ serviceWorkers: "block" });
  await visitorContext.addInitScript(() => localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", dailyNew: 0 })));
  const visitor = await visitorContext.newPage();
  observe(visitor, "visitor");
  await initialize(visitor);
  const visitorPlan = await save(visitor, { id: "p1-visitor-plan", kind: "plan", payload: planPayload() });
  await save(visitor, { id: "p1-visitor-essay", kind: "essay", payload: { taskType: "task2", planId: visitorPlan.id, text: "This visitor draft is imported only when I choose." } });
  await visitor.evaluate(async () => {
    const r = await import("/src/study365/repository.ts");
    await r.saveRecording("p1-visitor-take", new Blob(["visitor recording"]));
    await r.saveRecord({ id: "p1-visitor-speaking", kind: "speaking", payload: { planId: "p1-visitor-plan", transcript: "A visitor recording.", recordingId: "p1-visitor-take" } });
  });
  await login(visitor, accountB);
  assert.equal((await state(visitor)).records.length, 0, "logging in must not silently import visitor records");
  assert.equal(await visitor.evaluate(async () => !!(await (await import("/src/study365/repository.ts")).getRecording("p1-visitor-take"))), false);
  await moduleCall(visitor, "adoptGuestRecords");
  await sync(visitor);
  assert.ok((await state(visitor)).records.some((r) => r.id === "p1-visitor-essay"));
  assert.equal((await state(visitor)).pending, 0);
  assert.equal(await visitor.evaluate(async () => (await (await import("/src/study365/repository.ts")).getRecording("p1-visitor-take")).text()), "visitor recording");
  assert.ok(!(await state(desktop)).records.some((r) => r.id === "p1-visitor-essay"));
  await visitorContext.close();
  checks.push("访客成果不会随登录自动上传，明确并入后文字同步且本机录音可读");

  phase = "SQLite and sessions survive backend restart";
  await stop(backend); await startBackend();
  await sync(desktop);
  assert.ok((await serverRevisions(desktop, "p1-essay")).some((r) => r.revisionId === resolved.revisionId));
  checks.push("临时SQLite中的学习记录、修订与账号会话可跨后端重启保留");

  assert.deepEqual(pageErrors, [], "uncaught browser errors");
  assert.ok(apiReplies.some((r) => r.status === 409), "the test must observe a genuine HTTP conflict");
  assert.ok(apiReplies.every((r) => !r.fromServiceWorker && r.cache.includes("no-store")), "learning replies must not use browser/service-worker caching");
  checks.push("真实409响应、学习API禁止缓存和无未捕获浏览器异常");
  success = true;
} catch (error) {
  failure = String(error.message || error).replaceAll(password, "[redacted]").replaceAll(setupToken, "[redacted]");
  process.exitCode = 1;
} finally {
  await cleanup();
  console.log(JSON.stringify({ success, checks, ...(failure ? { failedPhase: phase, error: failure } : {}) }, null, 2));
}

// Keep the P1 regression above intact, then verify the learner-facing R1 flow
// in an independent account/database and a genuine production offline shell.
if (success) {
  const { runR1LearningE2E } = await import("./test-r1-e2e.mjs");
  if (!(await runR1LearningE2E()).success) process.exitCode = 1;
}
