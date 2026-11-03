#!/usr/bin/env node
/**
 * P1 learning-record integration checks. Uses Vite dev, a disposable SQLite DB,
 * two fresh browser contexts, and temporary accounts. Does not use production,
 * an existing Chrome profile, or a user's study data. No build is required.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    const r = await fetch(`/api/learning/v1/records/${encodeURIComponent(id)}/revisions`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error(`history returned ${r.status}`);
    return (await r.json()).items;
  }, id);
}
const planPayload = () => ({ startDate: "2026-11-03", timeZone: "Asia/Shanghai", studyBudgetMinutes: 150, targetBand: 7, enabled: true, syllabusUnit: 1, materialLevel: "A1", curriculumVersion: "p1-isolated-e2e" });
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
    return response.ok && (await response.json()).learningRecords === 1;
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
  const initialEssay = await save(desktop, { id: "p1-essay", kind: "essay", payload: { planId: plan.id, prompt: "Describe a useful daily habit.", text: "I read a short article every morning." } });
  await sync(desktop);
  await pullUntil(phone, (s) => s.records.some((r) => r.id === plan.id) && s.records.some((r) => r.revisionId === initialEssay.revisionId), "phone did not receive the plan and essay");
  checks.push("同账号电脑和手机能互见计划与作文");

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

  phase = "offline edit and durable outbox reload";
  await phoneContext.setOffline(true);
  const offlineEssay = await save(phone, { id: "p1-essay", kind: "essay", payload: { ...initialEssay.payload, text: "I read a short article every morning. I write down two useful phrases." } });
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
  const receiptPath = "**/api/learning/v1/records/p1-receipt-essay";
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
  const receiptEssay = await save(desktop, { id: "p1-receipt-essay", kind: "essay", payload: { planId: plan.id, text: "A response can be lost without losing my work." } });
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
  const phoneEdit = await save(phone, { id: "p1-essay", kind: "essay", payload: { ...offlineEssay.payload, text: "Phone revision: I read before breakfast." } });
  const desktopEdit = await save(desktop, { id: "p1-essay", kind: "essay", payload: { ...offlineEssay.payload, text: "Desktop revision: I read after breakfast." } });
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
  const pendingA = await save(phone, { id: "p1-pending-account-a", kind: "essay", payload: { planId: plan.id, text: "This pending draft belongs to account A only." } });
  await logout(phone);
  await login(phone, accountB, true);
  const userB = (await state(phone)).userId;
  assert.notEqual(userB, userA);
  assert.equal((await state(phone)).records.length, 0);
  assert.equal((await state(phone)).pending, 0);
  await phone.unroute("**/api/learning/**", unavailable);
  await sync(phone);
  const accountBRecords = await phone.evaluate(async () => (await (await fetch("/api/learning/v1/records", { cache: "no-store", credentials: "same-origin" })).json()).items);
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
  checks.push("录音的账号/词库命名空间使用复合键，不会因冒号产生覆盖");

  phase = "visitor drafts and recordings require an explicit account import";
  const visitorContext = await browser.newContext({ serviceWorkers: "block" });
  await visitorContext.addInitScript(() => localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", dailyNew: 0 })));
  const visitor = await visitorContext.newPage();
  observe(visitor, "visitor");
  await initialize(visitor);
  const visitorPlan = await save(visitor, { id: "p1-visitor-plan", kind: "plan", payload: planPayload() });
  await save(visitor, { id: "p1-visitor-essay", kind: "essay", payload: { planId: visitorPlan.id, text: "This visitor draft is imported only when I choose." } });
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
