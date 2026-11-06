#!/usr/bin/env node
/** R2 production UI journey. Build first; disposable accounts/SQLite only.
 * All learning writes use the UI. API/IndexedDB are inspected read-only.
 * An exported R1 baseline can be replayed via BAND_R2_E2E_ROOT.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
const initialTime = new Date("2026-11-15T04:00:00Z");
const prompt = "Some people believe that cities should invest more in public parks. Discuss the benefits and possible limitations of this policy, and give your own view.";
const outline = "Position: invest carefully. Benefit: shared exercise space. Limitation: maintenance costs. Example: a local park near housing. Conclusion: balance access and funding.";
const originalText = `Public parks can improve daily life when a city plans them around the needs of its residents. I believe that local authorities should support such spaces, while also checking whether the money could solve more urgent problems. A useful policy needs a clear purpose rather than an attractive announcement.

One benefit is that a park gives people a place to exercise without paying an entrance fee. Children can play, older residents can walk, and neighbours can meet outside their homes. These activities may strengthen local relationships. For example, a small green area beside several apartment buildings could be useful throughout the week because people would not need a long journey to reach it. Protecting the enviroment can also become more meaningful when residents can see a healthy natural space close to their daily routines.

However, a new park also creates continuing responsibilities. Trees need care, equipment requires inspection, and paths must remain safe. If a city pays only for construction and ignores maintenance, the space may become difficult to use. The same budget might sometimes achieve more by repairing an existing park or improving access to it. Authorities should therefore explain both the initial cost and the expected running costs before choosing a project.

In conclusion, public parks deserve investment, but the strongest case depends on local evidence. A city should identify areas where residents lack accessible outdoor space, compare realistic alternatives, and reserve enough funding for future care. This approach would make the policy useful over time rather than simply impressive on the day it opens.`;
const revisedText = originalText.replace("enviroment", "environment") + "\n\nResidents should also be invited to review the design before the final decision is made.";
const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
async function eventually(check, message, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => null); child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
async function localData(page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("band-learning-v1");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, names = ["scopes", ...(db.objectStoreNames.contains("writingDrafts") ? ["writingDrafts"] : [])];
      const tx = db.transaction(names, "readonly"), scopes = [], drafts = [];
      for (const name of names) {
        const cursor = tx.objectStore(name).openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result; if (!item) return;
          if (name === "scopes" && String(item.key).startsWith("account:")) scopes.push({ key: item.key, ...item.value });
          if (name === "writingDrafts" && Array.isArray(item.key) && String(item.key[0]).startsWith("account:")) drafts.push(item.value);
          item.continue();
        };
      }
      tx.oncomplete = () => { db.close(); resolve({ scope: scopes[0] ?? null, drafts }); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function serverRecords(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/learning/v2/records", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`records returned ${response.status}`); return (await response.json()).items;
  });
}
async function serverHistory(page, id) {
  return page.evaluate(async id => {
    const response = await fetch(`/api/learning/v2/records/${encodeURIComponent(id)}/revisions`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`history returned ${response.status}`); return (await response.json()).items;
  }, id);
}
const workbench = page => page.getByRole("region", { name: "写作工作台", exact: true });
const editor = page => page.getByRole("article", { name: "写作 Task 2", exact: true });
const body = page => editor(page).getByLabel("作文正文", { exact: true });
const review = page => page.getByRole("region", { name: "写作体检与自查", exact: true });
// Each editor is inside a fieldset; its submission controls are siblings in
// the enclosing draft section, including when Sunday's pair is restored.
const draftSection = page => editor(page).locator("xpath=../..");
const submit = page => draftSection(page).getByTestId("writing-submit");
const checkpointButton = page => draftSection(page).getByTestId("writing-checkpoint");
async function advance(page, seconds) { await page.clock.setFixedTime(new Date(await page.evaluate(() => Date.now()) + seconds * 1000)); }
async function navigate(page, route) { await page.evaluate(route => { location.hash = `#/${route}`; }, route); }
async function openWork(page, id) {
  await navigate(page, "writing");
  const button = page.getByTestId("writing-work-list").locator(`[data-work-id="${id}"]`).first();
  await button.waitFor(); await button.click();
}
async function waitForDraft(page, text) {
  await eventually(async () => (await localData(page)).drafts.some(draft => draft.text === text), "UI draft did not reach account-scoped IndexedDB");
  return (await localData(page)).drafts.find(draft => draft.text === text);
}

async function holdDraftDebounce(page, hold) {
  await page.evaluate(hold => {
    if (hold) {
      const set = window.setTimeout, clear = window.clearTimeout, pending = new Map();
      window.__r2Debounce = { set, clear, pending };
      window.setTimeout = function(handler, ms, ...args) {
        if (ms !== 300) return set.call(window, handler, ms, ...args);
        const id = set.call(window, () => {}, 60000); pending.set(id, { handler, args }); return id;
      };
      window.clearTimeout = function(id) { pending.delete(id); return clear.call(window, id); };
    } else if (window.__r2Debounce) {
      const { set, clear, pending } = window.__r2Debounce;
      window.setTimeout = set; window.clearTimeout = clear; delete window.__r2Debounce;
      for (const [id, { handler, args }] of pending) { clear.call(window, id); set.call(window, handler, 0, ...args); }
    }
  }, hold);
}

export async function runR2LearningE2E({ proof = process.env.BAND_R2_E2E_PROOF } = {}) {
  const root = path.resolve(process.env.BAND_R2_E2E_ROOT || scriptRoot), dist = path.resolve(process.env.BAND_R2_E2E_DIST || path.join(root, "dist"));
  const apiPort = Number(process.env.BAND_R2_E2E_API_PORT || await freePort());
  let webPort = Number(process.env.BAND_R2_E2E_WEB_PORT || await freePort());
  while (!process.env.BAND_R2_E2E_WEB_PORT && webPort === apiPort) webPort = await freePort();
  assert.ok(Number.isInteger(apiPort) && apiPort > 1024 && apiPort < 65536);
  assert.ok(Number.isInteger(webPort) && webPort > 1024 && webPort < 65536 && webPort !== apiPort);
  const origin = `http://127.0.0.1:${webPort}`, apiOrigin = `http://127.0.0.1:${apiPort}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "band-r2-e2e-")), dbPath = path.join(directory, "learning.sqlite3");
  const username = `r2_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("base64url"), setupToken = randomBytes(24).toString("base64url");
  const checks = [], evidence = {}, pageErrors = [], replies = [], writes = [];
  let backend, previewServer, browser, desktopContext, phoneContext, desktop, phone;
  let success = false, phase = "production build prerequisite", failure;
  const observe = (page, label) => {
    page.on("pageerror", error => pageErrors.push(`${label}: ${error.message}`));
    page.on("response", response => { if (new URL(response.url()).pathname.startsWith("/api/learning/")) replies.push({ status: response.status(), cache: response.headers()["cache-control"] || "", fromServiceWorker: response.fromServiceWorker() }); });
    page.on("request", request => { if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/learning/")) { const payload = request.postDataJSON(); writes.push({ revisionId: payload.revisionId, mutationId: payload.mutationId }); } });
  };
  const newPage = async (context, label, time = initialTime) => { const page = await context.newPage(); observe(page, label); await page.clock.setFixedTime(time); return page; };
  const login = async (page, create) => {
    await page.goto(`${origin}/#/me`, { waitUntil: "networkidle" });
    const panel = page.getByRole("region", { name: "学习进度同步", exact: true }); await panel.waitFor();
    if (create) await panel.getByRole("button", { name: "首次设置", exact: true }).click();
    await panel.locator('input[name="username"]').fill(username); await panel.locator('input[name="password"]').fill(password);
    if (create) await panel.locator('input[name="setup-token"]').fill(setupToken);
    await panel.getByRole("button", { name: create ? "创建账号并同步" : "登录并同步", exact: true }).click();
    await eventually(async () => (await panel.innerText()).includes(`已登录 ${username}`), "isolated account login did not complete through UI");
    await eventually(async () => !!(await localData(page)).scope, "account learning scope did not open");
    evidence.uiAccountLogin = true;
  };
  const warm = async page => {
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; if (navigator.serviceWorker.controller && registration.active?.state === "activated") return; await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })); });
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true); evidence.productionWorkerControlled = true;
  };
  const offline = async (context, page) => {
    await context.setOffline(true); assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.equal(await page.evaluate(() => fetch("/api/health", { cache: "no-store" }).then(() => true, () => false)), false); evidence.offlineApiUnavailable = true;
  };
  try {
    await fs.access(path.join(dist, "index.html")).catch(() => { throw new Error("Production build missing: run npm run build first."); });
    phase = "temporary SQLite and production preview";
    backend = spawn(process.env.BAND_LEARNING_E2E_PYTHON || "python3", ["server/app.py", "--host", "127.0.0.1", "--port", String(apiPort), "--db", dbPath], { cwd: root, env: { ...process.env, BAND_DB_PATH: dbPath, BAND_PUBLIC_ORIGIN: origin, BAND_COOKIE_SECURE: "0", BAND_TRUST_PROXY: "0", BAND_ALLOW_REGISTER: "1", BAND_MAX_ACCOUNTS: "2", BAND_SETUP_TOKEN: setupToken, BAND_SETUP_TOKEN_HASH: "", BAND_LEARNING_WRITES_ENABLED: "1" }, stdio: "ignore" });
    await eventually(async () => (await fetch(`${apiOrigin}/api/health`)).ok, "temporary API did not start", 15000);
    previewServer = await preview({ root, configFile: false, base: "/", build: { outDir: dist }, preview: { host: "127.0.0.1", port: webPort, strictPort: true, proxy: { "/api": apiOrigin } } });
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
    desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "allow" });
    phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "allow" });
    for (const context of [desktopContext, phoneContext]) await context.addInitScript(() => { if (!localStorage.getItem("word-atlas:settings")) localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", dailyNew: 0, feedbackMode: "rules" })); });
    desktop = await newPage(desktopContext, "desktop"); phone = await newPage(phoneContext, "phone");

    phase = "UI plan activation and Today writing entry";
    await login(desktop, true); await navigate(desktop, "today");
    const setup = desktop.getByRole("region", { name: "开启 8.0 计划", exact: true }); await setup.waitFor();
    await setup.getByLabel("开始日期", { exact: true }).fill("2026-11-09");
    await setup.getByRole("button", { name: "开启 8.0 计划", exact: true }).click();
    const writingTask = desktop.locator('[data-task-id="d7-writing"]'); await writingTask.waitFor();
    evidence.uiPlanActivated = true;
    const startWriting = writingTask.getByText("开始本节写作", { exact: true });
    if (await startWriting.isVisible()) await startWriting.click();
    else {
      assert.match(await writingTask.innerText(), /缺|材料/);
      await navigate(desktop, "writing?date=2026-11-15&day=7&task=d7-writing");
    }
    await workbench(desktop).waitFor();
    assert.ok(new URL(desktop.url()).hash.startsWith("#/writing"));
    await workbench(desktop).getByLabel("练习类型", { exact: true }).selectOption("task2");
    // Keep edited drafts newer than the untouched Sunday Task 1 starter.
    await advance(desktop, 1);
    await editor(desktop).getByLabel("题目来源", { exact: true }).selectOption("custom");
    await editor(desktop).getByLabel("题目", { exact: true }).fill(prompt);
    await editor(desktop).getByLabel("提纲", { exact: true }).fill(outline);
    await body(desktop).fill(originalText);
    if (proof) {
      await waitForDraft(desktop, originalText);
      const draft = (await localData(desktop)).drafts.find(value => value.text === originalText);
      if (proof === "checkpoint-quota") {
        phase = "checkpoint final local persist failure recovers its committed base";
        await desktop.evaluate(({ recordId, oldBase }) => {
          const original = IDBObjectStore.prototype.put; window.__r2OriginalPut = original; window.__r2QuotaTriggered = false;
          IDBObjectStore.prototype.put = function(value, ...args) {
            if (!window.__r2QuotaTriggered && this.name === "writingDrafts" && value.recordId === recordId && value.stage === "draft" && value.baseRevision && value.baseRevision !== oldBase) {
              window.__r2QuotaTriggered = true; throw new DOMException("Isolated final draft persistence failure", "QuotaExceededError");
            }
            return original.call(this, value, ...args);
          };
        }, { recordId: draft.recordId, oldBase: draft.baseRevision });
        await checkpointButton(desktop).click();
        await eventually(async () => desktop.evaluate(() => window.__r2QuotaTriggered), "the intended final draft write was not exercised");
        await desktop.evaluate(() => { IDBObjectStore.prototype.put = window.__r2OriginalPut; delete window.__r2OriginalPut; });
        const committed = Object.values((await localData(desktop)).scope.heads).find(value => value.id === draft.recordId && value.kind === "essay");
        assert.ok(committed, "essay must exist before the injected final local failure");
        evidence.finalPersistFailedAfterEssayCommit = true;
        await eventually(async () => (await localData(desktop)).drafts.some(value => value.recordId === draft.recordId && value.baseRevision === committed.revisionId), "checkpoint failure did not recover the already-created base revision", 6000);
        await checkpointButton(desktop).click();
        await eventually(async () => (await localData(desktop)).scope.outbox.length === 0, "checkpoint retry did not synchronize");
        const history = await serverHistory(desktop, draft.recordId);
        assert.ok(history.every(value => !value.conflict));
        assert.equal(replies.some(reply => reply.status === 409), false, "retrying a recovered base must not invent a conflict");
        checks.push("检查点最后本机写失败后恢复已创建base，重试不产生虚假409或丢稿");
      } else {
        phase = "shared checkpoint setup for focused recovery regression";
        await checkpointButton(desktop).click();
        await eventually(async () => (await serverRecords(desktop)).some(value => value.id === draft.recordId && value.payload.stage === "draft"), "initial checkpoint did not synchronize");
        const first = (await serverRecords(desktop)).find(value => value.id === draft.recordId);
        await openWork(desktop, first.id); await login(phone, false); await openWork(phone, first.id);
        await eventually(async () => await body(phone).inputValue() === originalText, "phone did not open the shared checkpoint");
        const remoteText = originalText + "\n\nA remote checkpoint adds evidence about accessible paths.";
        await body(phone).fill(remoteText); await checkpointButton(phone).click();
        await eventually(async () => (await serverRecords(phone)).some(value => value.id === first.id && value.payload.text === remoteText), "remote checkpoint did not synchronize");
        const remote = (await serverRecords(phone)).find(value => value.id === first.id);
        if (proof === "clean-checkpoint") {
          phase = "clean local checkpoint receives a newer remote checkpoint";
          await desktop.reload({ waitUntil: "networkidle" }); await openWork(desktop, first.id);
          await eventually(async () => (await localData(desktop)).scope.heads[first.id]?.revisionId === remote.revisionId, "remote revision did not reach the first device");
          evidence.remoteCheckpointArrived = true;
          await eventually(async () => await body(desktop).inputValue() === remoteText, "clean local draft hid the newer remote checkpoint", 6000);
          await eventually(async () => (await localData(desktop)).drafts.find(value => value.recordId === first.id)?.baseRevision === remote.revisionId, "clean recovery did not persist the newer base revision", 6000);
          checks.push("本机无编辑的检查点自动采用另一设备新正文与base，不凭空制造冲突");
        } else {
          assert.equal(proof, "dirty-checkpoint");
          phase = "remote checkpoint preserves an edit before its debounce is persisted";
          await holdDraftDebounce(desktop, true);
          try {
            const dirtyText = originalText + "\n\nThis local change has not reached IndexedDB yet.";
            await body(desktop).fill(dirtyText);
            assert.notEqual((await localData(desktop)).drafts.find(value => value.recordId === first.id).text, dirtyText);
            evidence.localEditUnpersistedBeforeRemotePull = true;
            await desktop.bringToFront(); await desktop.evaluate(() => window.dispatchEvent(new Event("focus")));
            await eventually(async () => (await localData(desktop)).scope.heads[first.id]?.revisionId === remote.revisionId, "remote checkpoint did not arrive during the local edit");
            await delay(200);
            evidence.remoteArrivedBeforeLocalPersistence = (await localData(desktop)).drafts.find(value => value.recordId === first.id).text !== dirtyText;
            assert.equal(await body(desktop).inputValue(), dirtyText, "new remote head overwrote the unpersisted local edit");
          } finally { await holdDraftDebounce(desktop, false); }
          checks.push("远端head抵达300ms自动保存回调前，本机未落盘编辑完整保留");
        }
      }
    } else {
    await editor(desktop).getByRole("button", { name: "开始计时", exact: true }).click();
    await waitForDraft(desktop, originalText);
    await eventually(async () => (await localData(desktop)).drafts.some(draft => draft.text === originalText && draft.timer.runningSince !== null), "the running timer was not persisted before reload");
    evidence.timerSavedRunningBeforeReload = true;
    await advance(desktop, 125);
    checks.push("电脑从今日周日写作块进入Task2工作台，题目、提纲、正文与计时写入本机草稿");

    phase = "true production offline refresh close and draft recovery";
    await warm(desktop); await offline(desktopContext, desktop);
    const offlineResponse = await desktop.reload({ waitUntil: "domcontentloaded" });
    assert.equal(offlineResponse?.fromServiceWorker(), true); evidence.offlineReloadFromServiceWorker = true;
    await eventually(async () => await body(desktop).inputValue() === originalText, "offline refresh lost the exact essay draft");
    evidence.timerAfterOfflineReload = (await localData(desktop)).drafts.find(draft => draft.text === originalText)?.timer;
    assert.equal(await editor(desktop).getByLabel("提纲", { exact: true }).inputValue(), outline);
    const workUrl = desktop.url(), reopenedTime = new Date(await desktop.evaluate(() => Date.now())); await desktop.close();
    desktop = await newPage(desktopContext, "desktop-reopened", reopenedTime);
    await desktop.goto(workUrl, { waitUntil: "domcontentloaded" });
    await eventually(async () => await body(desktop).inputValue() === originalText, "closing and reopening offline lost the draft");
    evidence.timerAfterOfflineReopen = (await localData(desktop)).drafts.find(draft => draft.text === originalText)?.timer;
    assert.equal(await editor(desktop).getByLabel("题目", { exact: true }).inputValue(), prompt);
    assert.equal(await editor(desktop).getByLabel("提纲", { exact: true }).inputValue(), outline);
    await editor(desktop).getByRole("button", { name: "暂停计时", exact: true }).click();
    await eventually(async () => (await localData(desktop)).drafts.some(draft => draft.text === originalText && draft.timer.elapsedSeconds === 125 && draft.timer.runningSince === null), "restored timer did not retain its actual 125 seconds");
    checks.push("真实生产SW断网刷新、关闭重开后，题目/原文/提纲/125秒计时均恢复");

    phase = "offline submission and exact feedback binding";
    await submit(desktop).click();
    await eventually(async () => Object.values((await localData(desktop)).scope.heads).some(record => record.kind === "essay" && record.payload.text === originalText && record.payload.stage === "submitted"), "offline submission did not create an immutable essay revision");
    const initial = Object.values((await localData(desktop)).scope.heads).find(record => record.kind === "essay" && record.payload.text === originalText && record.payload.stage === "submitted");
    assert.equal(initial.payload.scope, "full"); assert.equal(initial.payload.taskType, "task2"); assert.equal(initial.contentHash, hash(originalText)); assert.equal(initial.payload.elapsedSeconds, 125);
    assert.equal(await body(desktop).isEditable(), false, "submitted original must be read-only");
    await review(desktop).waitFor(); assert.match(await review(desktop).innerText(), /拼写：未检查/);
    await review(desktop).getByRole("button", { name: /^标记拼写 enviroment / }).click();
    await review(desktop).getByRole("button", { name: "拼写已检查", exact: true }).click();
    await review(desktop).getByRole("checkbox", { name: "task-response-answer", exact: true }).check();
    await review(desktop).getByRole("checkbox", { name: "语法", exact: true }).check();
    assert.equal(await review(desktop).getByRole("checkbox", { name: "task1-no-opinion", exact: true }).count(), 0);
    await review(desktop).getByRole("button", { name: "保存自查", exact: true }).click();
    await eventually(async () => Object.values((await localData(desktop)).scope.heads).some(record => record.kind === "feedback" && record.payload.workRevisionId === initial.revisionId && record.payload.source === "self"), "offline self-review was not saved");
    await eventually(async () => Object.values((await localData(desktop)).scope.heads).some(record => record.kind === "feedback" && record.payload.workRevisionId === initial.revisionId && record.payload.source === "rules"), "local rules evidence was not saved");
    const feedback = Object.values((await localData(desktop)).scope.heads).filter(record => record.kind === "feedback" && record.payload.workRevisionId === initial.revisionId);
    const self = feedback.find(record => record.payload.source === "self"), rules = feedback.find(record => record.payload.source === "rules");
    assert.ok(rules, "local rules must save evidence independently");
    assert.ok(Object.values(rules.payload.bands).every(value => value === null));
    assert.equal(self.payload.spellingCheck.count, 1); assert.equal(self.payload.spellingCheck.status, "checked");
    assert.equal(self.payload.checklist["task-response-answer"], true); assert.ok(self.payload.errorCauses.includes("grammar"));
    for (const mark of self.payload.spellingCheck.items) assert.equal(originalText.slice(mark.start, mark.end), mark.text);
    assert.ok(feedback.every(record => record.payload.inputHash === initial.contentHash && record.payload.workId === initial.id));
    const mission = Object.values((await localData(desktop)).scope.heads).find(record => record.kind === "mission" && record.payload.taskId === "d7-writing");
    assert.equal(mission.payload.timeSource, "timer"); assert.equal(mission.payload.status, "partial"); assert.ok(Math.abs(mission.payload.actualMinutes - 125 / 60) <= 1 / 60);
    const initialRequest = (await localData(desktop)).scope.outbox.find(item => item.body.revisionId === initial.revisionId);
    assert.ok(initialRequest); await desktopContext.setOffline(false);
    await eventually(async () => (await localData(desktop)).scope.outbox.length === 0, "offline essay and reviews did not automatically synchronize");
    assert.equal((await serverHistory(desktop, initial.id)).filter(record => record.revisionId === initial.revisionId).length, 1);
    assert.ok(writes.some(item => item.revisionId === initial.revisionId && item.mutationId === initialRequest.body.mutationId));
    assert.ok(writes.filter(item => item.revisionId === initial.revisionId).every(item => item.mutationId === initialRequest.body.mutationId));
    checks.push("断网提交首稿锁定原文，体检全null分、自查/拼写1/错因准确绑定；联网原ID补传并联动计时mission");

    phase = "second device original and review readback";
    await login(phone, false); await openWork(phone, initial.id);
    await eventually(async () => await body(phone).inputValue() === originalText, "phone did not show the submitted original");
    const phoneScope = (await localData(phone)).scope;
    for (const record of [initial, self, rules]) assert.equal(phoneScope.heads[record.id].revisionId, record.revisionId);
    assert.match(await review(phone).innerText(), /拼写错误：1处/);
    assert.equal(await review(phone).getByRole("checkbox", { name: "task-response-answer", exact: true }).isChecked(), true);
    assert.equal(await review(phone).getByRole("checkbox", { name: "语法", exact: true }).isChecked(), true);
    checks.push("手机同账号读到相同作品revision/hash及rules/self反馈、拼写数、自查与错因");

    phase = "phone revision and desktop chain comparison";
    await workbench(phone).getByRole("button", { name: "写修改稿", exact: true }).click();
    await body(phone).fill(revisedText); await submit(phone).click();
    await eventually(async () => (await serverRecords(phone)).some(record => record.kind === "essay" && record.payload.parentRevisionId === initial.revisionId && record.payload.stage === "submitted"), "phone rewrite did not synchronize its parent revision");
    const rewritten = (await serverRecords(phone)).find(record => record.kind === "essay" && record.payload.parentRevisionId === initial.revisionId && record.payload.stage === "submitted");
    assert.notEqual(rewritten.id, initial.id); assert.equal(rewritten.payload.text, revisedText);
    await desktop.reload({ waitUntil: "networkidle" }); await openWork(desktop, rewritten.id);
    await eventually(async () => (await localData(desktop)).scope.heads[rewritten.id]?.revisionId === rewritten.revisionId, "desktop did not read the phone rewrite");
    const comparison = desktop.getByRole("region", { name: "修改稿对比", exact: true }); await comparison.waitFor();
    assert.match(await comparison.locator("del").allTextContents().then(values => values.join(" ")), /enviroment/);
    assert.match(await comparison.locator("ins").allTextContents().then(values => values.join(" ")), /environment/);
    assert.match(await desktop.getByRole("region", { name: "写作修改链", exact: true }).innerText(), /首稿/);
    assert.match(await desktop.getByRole("region", { name: "写作修改链", exact: true }).innerText(), /修改稿/);
    assert.match(await review(desktop).innerText(), /拼写：未检查/, "old self-review must not appear under the new original");
    checks.push("手机新记录提交修改稿，电脑看到parent链和真实增删高亮；旧自查不串到新修订");

    phase = "shared draft checkpoint and concurrent offline edits";
    await workbench(desktop).getByRole("button", { name: "写修改稿", exact: true }).click();
    const checkpointText = revisedText + "\n\nThis checkpoint is shared before the two devices edit independently.";
    await body(desktop).fill(checkpointText);
    await checkpointButton(desktop).click();
    await eventually(async () => (await serverRecords(desktop)).some(record => record.kind === "essay" && record.payload.text === checkpointText && record.payload.stage === "draft"), "cloud checkpoint was not synchronized");
    const checkpoint = (await serverRecords(desktop)).find(record => record.kind === "essay" && record.payload.text === checkpointText && record.payload.stage === "draft");
    await phone.reload({ waitUntil: "networkidle" }); await openWork(phone, checkpoint.id);
    await eventually(async () => await body(phone).inputValue() === checkpointText, "phone did not resume the same cloud checkpoint");
    for (const page of [desktop, phone]) {
      await eventually(async () => (await localData(page)).drafts.some(draft => draft.recordId === checkpoint.id && draft.baseRevision === checkpoint.revisionId), "device did not retain the shared checkpoint base");
      await warm(page);
    }
    await offline(desktopContext, desktop); await offline(phoneContext, phone);
    const desktopText = checkpointText + "\nDesktop adds evidence about maintenance.", phoneText = checkpointText + "\nPhone adds evidence about accessibility.";
    await body(desktop).fill(desktopText); await checkpointButton(desktop).click();
    await body(phone).fill(phoneText); await checkpointButton(phone).click();
    await eventually(async () => [await localData(desktop), await localData(phone)].every(data => data.scope.outbox.some(item => item.recordId === checkpoint.id)), "both offline edits must preserve independent queued checkpoints");
    const desktopEdit = (await localData(desktop)).scope.outbox.find(item => item.recordId === checkpoint.id).local;
    const phoneEdit = (await localData(phone)).scope.outbox.find(item => item.recordId === checkpoint.id).local;
    assert.equal(desktopEdit.baseRevision, checkpoint.revisionId); assert.equal(phoneEdit.baseRevision, checkpoint.revisionId);
    await desktopContext.setOffline(false);
    await eventually(async () => (await serverRecords(desktop)).some(record => record.revisionId === desktopEdit.revisionId), "desktop edit was not first committed");
    await phoneContext.setOffline(false);
    const conflicts = phone.getByTestId("writing-conflicts"); await conflicts.waitFor();
    assert.match(await conflicts.innerText(), /有两个版本/); assert.ok((await conflicts.innerText()).includes(desktopText)); assert.ok((await conflicts.innerText()).includes(phoneText));
    assert.ok(await submit(phone).count() === 0 || !await submit(phone).isEnabled(), "an unresolved conflict must block submission");
    await conflicts.locator(`[data-revision-id="${phoneEdit.revisionId}"]`).getByRole("button", { name: "选择此版本", exact: true }).click();
    await eventually(async () => (await serverRecords(phone)).some(record => record.id === checkpoint.id && record.revisionId !== desktopEdit.revisionId && record.revisionId !== phoneEdit.revisionId && record.payload.text === phoneText), "choosing a conflict did not produce a new immutable revision");
    const history = await serverHistory(phone, checkpoint.id);
    assert.ok(history.some(record => record.revisionId === desktopEdit.revisionId && record.payload.text === desktopText));
    assert.ok(history.some(record => record.revisionId === phoneEdit.revisionId && record.payload.text === phoneText));
    assert.ok(history.some(record => record.baseRevision === desktopEdit.revisionId && record.payload.text === phoneText && !record.conflict));
    assert.ok(replies.some(reply => reply.status === 409), "concurrent checkpoints must exercise a genuine server conflict");
    checks.push("同一云端检查点双端断网各改，真实409保留两份；选择后新建修订且两份历史原文仍在");

    phase = "Sunday human review bound to the exact submitted revision";
    await openWork(phone, rewritten.id);
    const human = phone.getByRole("region", { name: "写作真人评阅", exact: true }); await human.waitFor();
    await human.getByRole("button", { name: "交给真人评分", exact: true }).click();
    await eventually(async () => (await human.innerText()).includes("待评阅"), "submitted work was not marked pending human review");
    assert.equal((await serverRecords(phone)).some(record => record.kind === "assessment" && record.payload.kind === "weekly-calibration" && record.payload.workRevisionId === rewritten.revisionId), false, "pending is not a zero-valued assessment");
    for (const name of ["任务回应", "连贯与衔接", "词汇", "语法"]) await human.getByLabel(`真人${name}分数`, { exact: true }).fill("7.5");
    await human.getByRole("button", { name: "保存真人评分", exact: true }).click();
    await eventually(async () => (await serverRecords(phone)).some(record => record.kind === "assessment" && record.payload.kind === "weekly-calibration" && record.payload.workRevisionId === rewritten.revisionId), "human dimensions did not synchronize");
    const calibration = (await serverRecords(phone)).find(record => record.kind === "assessment" && record.payload.kind === "weekly-calibration" && record.payload.workRevisionId === rewritten.revisionId);
    assert.equal(calibration.payload.source, "human"); assert.equal(calibration.payload.workId, rewritten.id); assert.equal(calibration.payload.inputHash, rewritten.contentHash); assert.equal(calibration.payload.weekIndex, 1);
    assert.deepEqual(calibration.payload.bands, { taskResponse: 7.5, coherence: 7.5, lexical: 7.5, grammar: 7.5 }); assert.equal(Object.hasOwn(calibration.payload, "scores"), false);
    await desktop.reload({ waitUntil: "networkidle" }); await openWork(desktop, rewritten.id);
    await eventually(async () => (await localData(desktop)).scope.heads[calibration.id]?.revisionId === calibration.revisionId, "desktop did not receive the exact human review revision");
    assert.match(await desktop.getByRole("region", { name: "同版四维评分", exact: true }).innerText(), /真人/);
    assert.match(await desktop.getByRole("region", { name: "同版四维评分", exact: true }).innerText(), /7\.5/);
    checks.push("周日作品待评阅不记0，真人四维绑定交付revision/hash并同步；单篇分数未冒充写作单科分");
    }
    assert.deepEqual(pageErrors, [], "uncaught production browser errors");
    assert.ok(replies.every(reply => !reply.fromServiceWorker && reply.cache.includes("no-store")), "learning API must bypass service-worker caches");
    success = true;
  } catch (error) {
    failure = String(error.message || error).replaceAll(password, "[redacted]").replaceAll(setupToken, "[redacted]");
    const failurePage = phone && !phone.isClosed() && phone.url().startsWith(origin) ? phone : desktop;
    await failurePage?.screenshot({ path: "/private/tmp/band-r2-e2e-failure.png", fullPage: true }).catch(() => null);
  } finally {
    await Promise.all([desktopContext?.close().catch(() => null), phoneContext?.close().catch(() => null)]); await browser?.close().catch(() => null);
    if (previewServer) await new Promise(resolve => previewServer.httpServer.close(resolve));
    await stop(backend); await fs.rm(directory, { recursive: true, force: true });
  }
  if (success && !proof) for (const mode of ["clean-checkpoint", "dirty-checkpoint", "checkpoint-quota"]) {
    const regression = await runR2LearningE2E({ proof: mode });
    if (!regression.success) { success = false; phase = regression.failedPhase; failure = regression.error; break; }
    checks.push(...regression.checks);
  }
  const result = { suite: proof ? `R2 ${proof}` : "R2 production writing", success, checks, evidence, ...(failure ? { failedPhase: phase, error: failure } : {}) };
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { if (!(await runR2LearningE2E()).success) process.exitCode = 1; }
