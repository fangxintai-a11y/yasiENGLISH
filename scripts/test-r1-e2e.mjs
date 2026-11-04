#!/usr/bin/env node
/**
 * R1 learner journey against a production build, real Chrome, and a disposable
 * SQLite API. Run npm run build first. No source-module imports or synthetic
 * learning writes are made in the browser; plans, missions and scores use UI.
 * BAND_R1_E2E_ROOT can point at an exported baseline. The offline-entry proof
 * mode independently records the old production UI's exact offline boundary.
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
import { preview } from "vite";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => null);
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

/** Read-only IndexedDB inspection: writes still pass through the learner UI. */
async function localScope(page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("band-learning-v1");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("scopes", "readonly"), store = tx.objectStore("scopes");
      const rows = [], cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { if (String(item.key).startsWith("account:")) rows.push({ key: item.key, ...item.value }); item.continue(); }
      };
      tx.oncomplete = () => { db.close(); resolve(rows[0] ?? null); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function serverRecords(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/learning/v2/records", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`learning records returned ${response.status}`);
    return (await response.json()).items;
  });
}
async function serverHistory(page, id) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/learning/v2/records/${encodeURIComponent(id)}/revisions`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`learning history returned ${response.status}`);
    return (await response.json()).items;
  }, id);
}

export async function runR1LearningE2E() {
  const root = path.resolve(process.env.BAND_R1_E2E_ROOT || scriptRoot);
  const dist = path.resolve(process.env.BAND_R1_E2E_DIST || path.join(root, "dist"));
  const apiPort = Number(process.env.BAND_R1_E2E_API_PORT || 16289);
  const webPort = Number(process.env.BAND_R1_E2E_WEB_PORT || 16288);
  assert.ok(Number.isInteger(apiPort) && apiPort > 1024 && apiPort < 65536);
  assert.ok(Number.isInteger(webPort) && webPort > 1024 && webPort < 65536 && webPort !== apiPort);
  const origin = `http://127.0.0.1:${webPort}`, apiOrigin = `http://127.0.0.1:${apiPort}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "band-r1-e2e-"));
  const dbPath = path.join(directory, "learning.sqlite3");
  const username = `r1_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url"), setupToken = randomBytes(24).toString("base64url");
  const checks = [], pageErrors = [], apiReplies = [], writes = [], evidence = {};
  let backend, previewServer, browser, desktopContext, phoneContext;
  let phase = "production build prerequisite", success = false, failure;
  const observe = (page, label) => {
    page.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/learning/")) {
        const body = request.postDataJSON(); writes.push({ id: new URL(request.url()).pathname.split("/").at(-1), revisionId: body.revisionId, mutationId: body.mutationId });
      }
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/learning/")) apiReplies.push({ cache: response.headers()["cache-control"] || "", fromServiceWorker: response.fromServiceWorker() });
    });
  };
  const navigate = async (page, route) => {
    await page.evaluate((route) => { location.hash = route; }, `#/${route}`);
  };
  const login = async (page, create) => {
    await page.goto(`${origin}/#/me`, { waitUntil: "networkidle" });
    const panel = page.getByRole("region", { name: "学习进度同步", exact: true });
    await panel.waitFor();
    if (create) await panel.getByRole("button", { name: "首次设置", exact: true }).click();
    await panel.locator('input[name="username"]').fill(username);
    await panel.locator('input[name="password"]').fill(password);
    if (create) await panel.locator('input[name="setup-token"]').fill(setupToken);
    await panel.getByRole("button", { name: create ? "创建账号并同步" : "登录并同步", exact: true }).click();
    await eventually(async () => (await panel.innerText()).includes(`已登录 ${username}`), "isolated account did not log in through UI");
    await eventually(async () => !!await localScope(page), "account learning scope did not open");
    evidence.uiAccountLogin = true;
  };
  const warmProductionShell = async (page) => {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller && registration.active?.state === "activated") return;
      await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    });
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, "production service worker must control the page");
    evidence.productionWorkerControlled = true;
    await eventually(async () => page.evaluate(async () => {
      const entries = await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)));
      return entries.flat().some((url) => new URL(url).pathname === "/");
    }), "production app shell was not cached");
  };
  const assertOffline = async (page) => {
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.equal(await page.evaluate(() => fetch("/api/health", { cache: "no-store" }).then(() => true, () => false)), false, "network API must really be unavailable offline");
    evidence.offlineApiUnavailable = true;
  };
  try {
    await fs.access(path.join(dist, "index.html")).catch(() => { throw new Error("Production build missing: run npm run build before npm run test:learning."); });
    phase = "temporary SQLite and production preview";
    backend = spawn(process.env.BAND_LEARNING_E2E_PYTHON || "python3", ["server/app.py", "--host", "127.0.0.1", "--port", String(apiPort), "--db", dbPath], {
      cwd: root, env: { ...process.env, BAND_DB_PATH: dbPath, BAND_PUBLIC_ORIGIN: origin, BAND_COOKIE_SECURE: "0", BAND_TRUST_PROXY: "0", BAND_ALLOW_REGISTER: "1", BAND_MAX_ACCOUNTS: "2", BAND_SETUP_TOKEN: setupToken, BAND_SETUP_TOKEN_HASH: "", BAND_LEARNING_WRITES_ENABLED: "1" }, stdio: "ignore",
    });
    await eventually(async () => (await fetch(`${apiOrigin}/api/health`)).ok, "temporary SQLite API did not start", 15000);
    previewServer = await preview({ root, configFile: false, base: "/", build: { outDir: dist }, preview: { host: "127.0.0.1", port: webPort, strictPort: true, proxy: { "/api": apiOrigin } } });
    assert.equal((await (await fetch(`${origin}/api/capabilities`)).json()).learningRecords, 2);
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
    desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "allow" });
    phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "allow" });
    for (const context of [desktopContext, phoneContext]) await context.addInitScript(() => {
      if (!localStorage.getItem("word-atlas:settings")) localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", dailyNew: 0 }));
    });
    const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
    for (const [page, label] of [[desktop, "desktop"], [phone, "phone"]]) {
      observe(page, label); await page.clock.setFixedTime(new Date("2026-11-12T04:00:00Z"));
    }

    if (process.env.BAND_R1_E2E_PROOF === "offline-entry") {
      phase = "legacy proof: offline production Today learner entry";
      await desktop.goto(`${origin}/#/today`, { waitUntil: "networkidle" });
      await warmProductionShell(desktop);
      await desktopContext.setOffline(true);
      await assertOffline(desktop);
      const response = await desktop.reload({ waitUntil: "domcontentloaded" });
      assert.equal(response?.fromServiceWorker(), true, "offline proof must reload from the production service worker");
      evidence.offlineReloadFromServiceWorker = true;
      await desktop.getByRole("region", { name: /开启 8.0 计划|365天学习计划/ }).waitFor({ timeout: 6000 });
      checks.push("生产SW控制且真实断网刷新后，今日仍有学习计划入口");
    } else {
      phase = "UI activation of one account's 8.0 plan";
      await login(desktop, true);
      await navigate(desktop, "today");
      const setup = desktop.getByRole("region", { name: "开启 8.0 计划", exact: true });
      await setup.waitFor({ timeout: 6000 });
      await setup.getByLabel("开始日期", { exact: true }).fill("2026-11-09");
      await setup.getByLabel("计划时区", { exact: true }).fill("Asia/Shanghai");
      await setup.getByRole("button", { name: "开启 8.0 计划", exact: true }).click();
      const todayPanel = desktop.getByRole("region", { name: "365天学习计划", exact: true });
      await eventually(async () => /第\s*4\s*天/.test(await todayPanel.innerText()), "UI did not activate day 4 of the Monday plan");
      await eventually(async () => (await serverRecords(desktop)).some((record) => record.kind === "plan"), "UI-created plan did not synchronize");
      const plan = (await serverRecords(desktop)).find((record) => record.kind === "plan");
      assert.equal(plan.payload.startDate, "2026-11-09");
      assert.equal(plan.payload.studyBudgetMinutes, 120);
      assert.equal(plan.payload.targetBand, 8);
      assert.deepEqual(plan.payload.sectionTargets, { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 });
      checks.push("电脑从真实UI开启周一8.0计划并写入临时SQLite");

      phase = "UI completion partial and skipped day blocks";
      const states = { vocabulary: "completed", listening: "completed", reading: "partial", writing: "completed", speaking: "skipped" };
      const statusButtons = { completed: "完成", partial: "部分完成", skipped: "跳过" };
      for (const [id, status] of Object.entries(states)) {
        const task = todayPanel.locator(`[data-task-id="d4-${id}"]`);
        await task.waitFor();
        if (status === "partial") await task.getByRole("spinbutton").fill("10");
        await task.getByRole("button", { name: statusButtons[status], exact: true }).click();
      }
      await eventually(async () => {
        const missions = (await serverRecords(desktop)).filter((record) => record.kind === "mission" && record.planId === plan.id);
        return missions.length === 5 && missions.every((record) => record.payload.status === states[record.payload.taskId.replace("d4-", "")]);
      }, "day-block UI states were not synchronized accurately");
      const firstMissions = (await serverRecords(desktop)).filter((record) => record.kind === "mission" && record.planId === plan.id);
      assert.equal(new Set(firstMissions.map((record) => record.id)).size, 5);
      assert.equal(firstMissions.find((record) => record.payload.taskId === "d4-reading").payload.actualMinutes, 10);
      checks.push("当天五块由UI登记，包含完成、部分完成、跳过且每块只有一条mission");

      phase = "UI baseline score registration";
      await navigate(desktop, "progress");
      const assessment = desktop.getByRole("form", { name: "登记成绩", exact: true });
      await assessment.waitFor();
      await assessment.getByLabel("测评类型", { exact: true }).selectOption("baseline");
      for (const [skill, value] of [["听力", "6.5"], ["阅读", "6.5"], ["写作", "6"], ["口语", "6"]]) await assessment.getByLabel(`${skill}分数`, { exact: true }).fill(value);
      await assessment.getByLabel("成绩材料标识", { exact: true }).fill("r1-isolated-baseline");
      await assessment.getByRole("button", { name: "保存成绩", exact: true }).click();
      await eventually(async () => (await serverRecords(desktop)).some((record) => record.kind === "assessment" && record.payload.kind === "baseline"), "UI baseline did not synchronize");
      const baseline = (await serverRecords(desktop)).find((record) => record.kind === "assessment" && record.payload.kind === "baseline");
      assert.deepEqual(baseline.payload.scores, { listening: 6.5, reading: 6.5, writing: 6, speaking: 6 });
      assert.equal(baseline.payload.scoreSources.writing, "human"); assert.equal(baseline.payload.scoreSources.speaking, "human");
      checks.push("成绩表单登记完整四科基线，写说来源为真人");

      phase = "second-device UI and immutable record readback";
      await login(phone, false);
      await navigate(phone, "today");
      const phoneToday = phone.getByRole("region", { name: "365天学习计划", exact: true });
      await eventually(async () => /第\s*4\s*天/.test(await phoneToday.innerText()), "phone did not show the same day plan");
      await eventually(async () => {
        const scope = await localScope(phone); return [plan, baseline, ...firstMissions].every((record) => scope?.heads[record.id]?.revisionId === record.revisionId);
      }, "phone did not read exactly the same plan mission and baseline revisions");
      for (const [id, status] of Object.entries(states)) {
        const task = phoneToday.locator(`[data-task-id="d4-${id}"]`);
        assert.match(await task.getByRole("status").innerText(), new RegExp({ completed: "已完成", partial: "部分完成", skipped: "已跳过" }[status]));
      }
      await navigate(phone, "progress");
      const scoreBook = phone.getByRole("region", { name: "成绩本", exact: true });
      await eventually(async () => (await scoreBook.innerText()).includes("6.5") && (await scoreBook.innerText()).includes("真人"), "phone score book did not show the synchronized baseline");
      checks.push("手机同账号读到相同plan/五块状态/基线revision，今日与成绩本均可见");

      phase = "true offline production reload and durable UI mission update";
      await navigate(phone, "today");
      await warmProductionShell(phone);
      assert.ok((await phone.evaluate(() => caches.keys())).includes("band-v5-shell"), "R1 production shell must use band-v5");
      await phoneContext.setOffline(true);
      await assertOffline(phone);
      const offlineResponse = await phone.reload({ waitUntil: "domcontentloaded" });
      assert.equal(offlineResponse?.fromServiceWorker(), true, "offline Today must be loaded by the production service worker");
      await eventually(async () => /第\s*4\s*天/.test(await phoneToday.innerText()), "offline reload did not restore today's plan from IndexedDB");
      assert.equal(await phoneToday.locator("[data-task-id]").count(), 5);
      const speaking = phoneToday.locator('[data-task-id="d4-speaking"]');
      await speaking.getByRole("button", { name: "完成", exact: true }).click();
      await eventually(async () => {
        const scope = await localScope(phone); return scope?.outbox.some((item) => item.body.kind === "mission" && item.body.payload.taskId === "d4-speaking" && item.body.payload.status === "completed");
      }, "offline UI update did not persist its immutable outbox request");
      const pending = (await localScope(phone)).outbox.find((item) => item.body.payload.taskId === "d4-speaking");
      assert.equal(pending.recordId, firstMissions.find((record) => record.payload.taskId === "d4-speaking").id);
      await phone.reload({ waitUntil: "domcontentloaded" });
      await eventually(async () => (await localScope(phone))?.outbox.some((item) => item.body.revisionId === pending.body.revisionId && item.body.mutationId === pending.body.mutationId), "second offline refresh lost the original queued request");
      await eventually(async () => /已完成/.test(await speaking.getByRole("status").innerText()), "offline refresh did not render the persisted task completion");
      checks.push("生产band-v5 SW真实断网刷新仍有五块任务，离线勾选再刷新保留同一outbox ID");

      phase = "reconnect once and cross-device readback without duplicate missions";
      await phoneContext.setOffline(false);
      await eventually(async () => (await localScope(phone))?.outbox.length === 0, "reconnection did not automatically upload the offline task");
      await eventually(async () => (await serverRecords(phone)).some((record) => record.revisionId === pending.body.revisionId), "server did not acknowledge the original offline revision");
      const history = await serverHistory(phone, pending.recordId);
      assert.equal(history.filter((record) => record.revisionId === pending.body.revisionId).length, 1);
      assert.equal(history.length, 2, "one skipped revision plus one offline completion, with no duplicate revisions");
      assert.ok(writes.some((request) => request.revisionId === pending.body.revisionId && request.mutationId === pending.body.mutationId));
      assert.ok(writes.filter((request) => request.revisionId === pending.body.revisionId).every((request) => request.mutationId === pending.body.mutationId));
      await navigate(desktop, "today");
      await desktop.reload({ waitUntil: "networkidle" });
      await eventually(async () => (await localScope(desktop))?.heads[pending.recordId]?.revisionId === pending.body.revisionId, "desktop did not receive the original offline completion");
      const finalMissions = (await serverRecords(desktop)).filter((record) => record.kind === "mission" && record.planId === plan.id);
      assert.equal(finalMissions.length, 5); assert.equal(new Set(finalMissions.map((record) => record.id)).size, 5);
      assert.match(await todayPanel.locator('[data-task-id="d4-speaking"]').getByRole("status").innerText(), /已完成/);
      checks.push("联网自动补传原mutation/revision，电脑回读同ID；SQLite五块无重复且该修订仅一份");
    }
    assert.deepEqual(pageErrors, [], "uncaught production browser errors");
    assert.ok(apiReplies.every((reply) => !reply.fromServiceWorker && reply.cache.includes("no-store")), "learning API must never be cached by production service worker");
    success = true;
  } catch (error) {
    failure = String(error.message || error).replaceAll(password, "[redacted]").replaceAll(setupToken, "[redacted]");
  } finally {
    await Promise.all([desktopContext?.close().catch(() => null), phoneContext?.close().catch(() => null)]);
    await browser?.close().catch(() => null);
    if (previewServer) await new Promise((resolve) => previewServer.httpServer.close(resolve));
    await stop(backend); await fs.rm(directory, { recursive: true, force: true });
  }
  const result = { suite: "R1 production UI and offline", success, checks, evidence, ...(failure ? { failedPhase: phase, error: failure } : {}) };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runR1LearningE2E(); if (!result.success) process.exitCode = 1;
}
