#!/usr/bin/env node
/** R3 production Chrome: real short fake-microphone captures, no recognition.
 * Build first. Disposable SQLite/accounts only; all study writes use the UI.
 * The test clock runs normally. Preparation alone advances by one minute;
 * recording uses real media time and independently decoded Blob duration.
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
import { unzipSync, strFromU8 } from "fflate";
import { chromium } from "playwright";
import { preview } from "vite";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixedTime = new Date("2026-11-12T04:00:00Z");
const transcripts = {
  1: "I enjoy walking near the river because the quiet surroundings help me relax after work.",
  2: "I would like to describe a quiet riverside path. I usually go there with a friend, and we discuss our plans while walking. The natural surroundings help us relax and think clearly.",
  3: "Cities can provide safe paths and accessible parks. However, they should also ask residents which facilities would be useful before spending the available budget.",
};
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function freePort() {
  return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
}
async function eventually(check, message, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { if (await check()) return; } catch (error) { last = error; } await delay(150); }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => null); child.kill("SIGTERM"); await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
async function localScope(page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("band-learning-v1"); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("scopes", "readonly"), rows = [], cursor = tx.objectStore("scopes").openCursor();
      cursor.onsuccess = () => { const item = cursor.result; if (!item) return; if (String(item.key).startsWith("account:")) rows.push({ key: item.key, ...item.value }); item.continue(); };
      tx.oncomplete = () => { db.close(); resolve(rows[0] ?? null); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function recording(page, scope, id) {
  return page.evaluate(async ({ scope, id }) => {
    const stored = await new Promise((resolve, reject) => {
      const request = indexedDB.open("band-learning-v1"); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(["recordings", "recordingMetadata"], "readonly"); let blob, metadata;
        const audio = tx.objectStore("recordings").get([scope, id]), info = tx.objectStore("recordingMetadata").get([scope, id]);
        audio.onsuccess = () => { blob = audio.result; }; info.onsuccess = () => { metadata = info.result; };
        tx.oncomplete = () => { db.close(); resolve({ blob, metadata }); }; tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    if (!stored.blob) return null;
    const bytes = new Uint8Array(await stored.blob.arrayBuffer()); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    const context = new AudioContext(); let decodedDuration;
    try { decodedDuration = (await context.decodeAudioData(bytes.slice().buffer)).duration; } finally { await context.close(); }
    return { bytes: bytes.length, base64: btoa(binary), sha256: digest, type: stored.blob.type, decodedDuration, metadata: stored.metadata ?? null };
  }, { scope, id });
}
async function serverRecords(page) {
  return page.evaluate(async () => { const response = await fetch("/api/learning/v2/records", { credentials: "same-origin", cache: "no-store" }); if (!response.ok) throw new Error(`records returned ${response.status}`); return (await response.json()).items; });
}
async function serverHistory(page, id) {
  return page.evaluate(async id => { const response = await fetch(`/api/learning/v2/records/${encodeURIComponent(id)}/revisions`, { credentials: "same-origin", cache: "no-store" }); if (!response.ok) throw new Error(`history returned ${response.status}`); return (await response.json()).items; }, id);
}
const workbench = page => page.getByRole("region", { name: "口语练习", exact: true });
const editor = page => page.getByRole("article", { name: "当前口语作答", exact: true });
const player = (page, id) => page.locator(`audio[data-recording-id="${id}"]`);
async function navigate(page, route) {
  await page.evaluate(route => { location.hash = `#/${route}`; }, route);
  // Hash updates precede the rendered route. Speaking and Me both contain a
  // recording-backup form, so wait for the destination before touching it.
  if (route === "speaking") await workbench(page).waitFor();
  if (route === "me") {
    await page.getByRole("heading", { name: "你的星空", exact: true }).waitFor();
    await workbench(page).waitFor({ state: "detached" });
  }
}
async function clickGeometry(button) {
  const pointerBox = await button.boundingBox();
  return button.evaluate((element, pointerBox) => {
    const box = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom });
    const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const identify = item => ({ tag: item.tagName, className: item.className, id: item.id });
    const bars = [...document.querySelectorAll(".topbar,.tabbar")].map(item => ({ ...identify(item), ...box(item.getBoundingClientRect()), position: getComputedStyle(item).position }));
    return {
      target: box(rect), pointerBox,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, visual: visualViewport && { width: visualViewport.width, height: visualViewport.height, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop, scale: visualViewport.scale } },
      horizontalOverflow: [...document.querySelectorAll("body *")].flatMap(item => {
        const rect = item.getBoundingClientRect(), style = getComputedStyle(item);
        if (rect.width <= 0 || (rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1)) return [];
        return [{ ...identify(item), ariaLabel: item.getAttribute("aria-label"), ...box(rect), scrollWidth: item.scrollWidth, minWidth: style.minWidth, maxWidth: style.maxWidth, overflowX: style.overflowX }];
      }).slice(0, 30),
      center: {
        x, y, receivesEvents: element.contains(document.elementFromPoint(x, y)),
        outsideBars: !bars.some(bar => bar.width > 0 && bar.height > 0 && x >= bar.x && x <= bar.x + bar.width && y >= bar.top && y <= bar.bottom),
      },
      elementsAtCenter: document.elementsFromPoint(x, y).slice(0, 6).map(identify),
      elementsAtPointerCenter: pointerBox ? document.elementsFromPoint(pointerBox.x + pointerBox.width / 2, pointerBox.y + pointerBox.height / 2).slice(0, 6).map(identify) : [],
      bars,
    };
  }, pointerBox);
}
async function openWork(page, id, { probeObstruction = false } = {}) {
  await navigate(page, "speaking");
  const button = page.getByTestId("speaking-work-list").locator(`[data-work-id="${id}"]`).first();
  await button.waitFor();
  let edge, centered;
  const screenshots = {};
  try {
    if (page.viewportSize()?.width <= 480) {
      const geometry = await clickGeometry(button);
      assert.ok(geometry.viewport.scrollWidth <= geometry.viewport.clientWidth,
        `mobile speaking page overflowed: ${geometry.viewport.scrollWidth}px > ${geometry.viewport.clientWidth}px`);
      assert.equal(geometry.viewport.visual?.offsetLeft ?? 0, 0, "mobile visual viewport must not be horizontally displaced");
      assert.equal(geometry.viewport.visual?.offsetTop ?? 0, 0, "mobile visual viewport must not be vertically displaced");
    }
    if (probeObstruction) {
      // Diagnostic only: show why viewport intersection alone does not prove
      // that a fixed navigation bar leaves the actual click point reachable.
      await button.evaluate(element => element.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" }));
      edge = await clickGeometry(button);
      screenshots.edge = `/private/tmp/band-r3-openwork-edge-${Date.now()}.png`;
      await page.screenshot({ path: screenshots.edge });
    }
    await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    await eventually(async () => {
      centered = await clickGeometry(button);
      return centered.center.receivesEvents && centered.center.outsideBars;
    }, "saved response button did not become reachable between navigation bars");
    if (probeObstruction) {
      screenshots.centered = `/private/tmp/band-r3-openwork-centered-${Date.now()}.png`;
      await page.screenshot({ path: screenshots.centered });
    }
    // Keep all Playwright actionability checks; prevent its default automatic
    // scrolling from moving the already verified point back under a bar.
    await button.click({ scroll: "none" });
  }
  catch (error) {
    const geometry = await clickGeometry(button).catch(() => null);
    const screenshot = `/private/tmp/band-r3-openwork-${Date.now()}.png`;
    await page.screenshot({ path: screenshot }).catch(() => null);
    error.message += `\nOpen-work click geometry: ${JSON.stringify({ edge, centered, geometry, screenshots, screenshot })}`;
    throw error;
  }
  await eventually(async () => await editor(page).getAttribute("data-work-id") === id, "saved speaking response did not open");
  return { edge, centered, screenshots };
}
async function verifyPlayback(page, id) {
  const element = player(page, id); await element.waitFor();
  await eventually(async () => element.evaluate(audio => !!audio.currentSrc && audio.readyState >= 1), "local audio source did not load metadata", 10000);
  await element.evaluate(async audio => { if (!audio.controls) throw new Error("audio player must expose controls"); audio.muted = true; audio.currentTime = 0; await audio.play(); });
  await eventually(async () => element.evaluate(audio => audio.currentTime > 0.1 && !audio.error), "imported audio did not actually play", 10000);
  await element.evaluate(audio => audio.pause());
}

export async function runR3SpeakingE2E() {
  const root = path.resolve(process.env.BAND_R3_E2E_ROOT || scriptRoot), dist = path.resolve(process.env.BAND_R3_E2E_DIST || path.join(root, "dist"));
  const apiPort = Number(process.env.BAND_R3_E2E_API_PORT || await freePort()); let webPort = Number(process.env.BAND_R3_E2E_WEB_PORT || await freePort());
  while (!process.env.BAND_R3_E2E_WEB_PORT && webPort === apiPort) webPort = await freePort();
  assert.ok(Number.isInteger(apiPort) && apiPort > 1024 && apiPort < 65536); assert.ok(Number.isInteger(webPort) && webPort > 1024 && webPort < 65536 && webPort !== apiPort);
  const origin = `http://127.0.0.1:${webPort}`, apiOrigin = `http://127.0.0.1:${apiPort}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "band-r3-e2e-")), dbPath = path.join(directory, "learning.sqlite3");
  const username = `r3_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("base64url"), setupToken = randomBytes(24).toString("base64url");
  const checks = [], evidence = {}, pageErrors = [], privateReplies = [], httpBodies = [], clips = [], works = [], practiceBounds = [];
  let backend, previewServer, browser, desktopContext, phoneContext, desktop, phone;
  let success = false, phase = "production build prerequisite", failure;
  const observeContext = (context, label) => {
    // Context events include service-worker initiated requests, unlike Page events.
    context.on("request", request => {
      if (!/^https?:/.test(request.url())) return;
      const body = request.postDataBuffer();
      if (body?.length) httpBodies.push({ device: label, method: request.method(), pathname: new URL(request.url()).pathname, type: request.headers()["content-type"] || "", body });
    });
    context.on("response", response => { if (new URL(response.url()).pathname.startsWith("/api/learning/")) privateReplies.push({ cache: response.headers()["cache-control"] || "", fromServiceWorker: response.fromServiceWorker() }); });
    context.on("page", page => page.on("pageerror", error => pageErrors.push(`${label}: ${error.message}`)));
  };
  const login = async (page, create) => {
    await page.goto(`${origin}/#/me`, { waitUntil: "networkidle" });
    const panel = page.getByRole("region", { name: "学习进度同步", exact: true }); await panel.waitFor();
    if (create) await panel.getByRole("button", { name: "首次设置", exact: true }).click();
    await panel.locator('input[name="username"]').fill(username); await panel.locator('input[name="password"]').fill(password);
    if (create) await panel.locator('input[name="setup-token"]').fill(setupToken);
    await panel.getByRole("button", { name: create ? "创建账号并同步" : "登录并同步", exact: true }).click();
    await eventually(async () => (await panel.innerText()).includes(`已登录 ${username}`), "isolated account login did not complete");
    await eventually(async () => !!await localScope(page), "account learning scope did not open"); evidence.uiAccountLogin = true;
  };
  const warm = async page => {
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; if (navigator.serviceWorker.controller && registration.active?.state === "activated") return; await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })); });
    await page.reload({ waitUntil: "networkidle" }); assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true); evidence.productionWorkerControlled = true;
  };
  const saveCaptured = async (part, transcript, prepare = false) => {
    let practiceStart;
    if (prepare) {
      const before = await desktop.evaluate(() => Date.now());
      await editor(desktop).getByRole("button", { name: "开始准备", exact: true }).click();
      practiceStart = { before, after: await desktop.evaluate(() => Date.now()) };
      await editor(desktop).getByLabel("准备笔记", { exact: true }).fill("Place, reason, personal example.");
      await desktop.clock.setSystemTime(new Date(await desktop.evaluate(() => Date.now()) + 60000));
      await eventually(async () => /准备剩余\s*0\s*秒/.test(await editor(desktop).innerText()), "Part 2 preparation did not reach its 60-second prompt");
    }
    const beforeBegin = await desktop.evaluate(() => Date.now());
    await editor(desktop).getByRole("button", { name: "开始录音", exact: true }).click();
    await eventually(async () => editor(desktop).getByRole("button", { name: "停止录音", exact: true }).isEnabled(), "fake microphone capture did not start");
    practiceStart ??= { before: beforeBegin, after: await desktop.evaluate(() => Date.now()) };
    await delay(1500); // Real media time, deliberately independent of page.clock.
    const beforeStop = await desktop.evaluate(() => Date.now());
    await editor(desktop).getByRole("button", { name: "停止录音", exact: true }).click();
    const afterStop = await desktop.evaluate(() => Date.now());
    practiceBounds.push({ minimum: Math.max(0, beforeStop - practiceStart.after) / 1000, maximum: Math.max(0, afterStop - practiceStart.before) / 1000 });
    // Stopping the recorder saves the audio and an initial response. Editing
    // its transcript then creates the ordinary same-work text revision.
    await editor(desktop).getByRole("button", { name: "保存转写", exact: true }).waitFor();
    await editor(desktop).getByLabel("手动转写", { exact: true }).fill(transcript);
    const id = await editor(desktop).getAttribute("data-work-id"); assert.ok(id);
    await editor(desktop).getByRole("button", { name: "保存转写", exact: true }).click();
    await eventually(async () => { const work = (await localScope(desktop))?.heads[id]; return work?.kind === "speaking" && work.payload.recordingStatus === "local" && work.payload.transcript === transcript; }, "recorded speaking response did not persist locally");
    const scope = await localScope(desktop), work = scope.heads[id];
    assert.equal(work.payload.part, part); assert.equal(work.contentHash, sha(Buffer.from(transcript, "utf8"))); assert.ok(work.payload.recordingId);
    const audio = await recording(desktop, scope.key, work.payload.recordingId); assert.ok(audio);
    assert.ok(audio.bytes > 0 && audio.bytes < 50 * 1024 * 1024);
    assert.ok(audio.decodedDuration > 0.2 && audio.decodedDuration < 15, "captured audio must be genuinely short, not a clock-generated 120 seconds");
    assert.ok(Math.abs(work.payload.durationSeconds - audio.decodedDuration) <= 0.15, "saved duration must follow the actual decoded capture");
    assert.equal(audio.sha256, sha(Buffer.from(audio.base64, "base64")));
    if (part === 2) { assert.equal(work.payload.prepSeconds, 60); assert.ok(work.payload.durationSeconds < 120); assert.match(await editor(desktop).innerText(), /未说满/); }
    await verifyPlayback(desktop, work.payload.recordingId);
    works.push(work); clips.push({ recordingId: work.payload.recordingId, work, ...audio }); return work;
  };
  try {
    await fs.access(path.join(dist, "index.html")).catch(() => { throw new Error("Production build missing: run npm run build first."); });
    phase = "temporary SQLite and production preview";
    backend = spawn(process.env.BAND_LEARNING_E2E_PYTHON || "python3", ["server/app.py", "--host", "127.0.0.1", "--port", String(apiPort), "--db", dbPath], { cwd: root, env: { ...process.env, BAND_DB_PATH: dbPath, BAND_PUBLIC_ORIGIN: origin, BAND_COOKIE_SECURE: "0", BAND_TRUST_PROXY: "0", BAND_ALLOW_REGISTER: "1", BAND_MAX_ACCOUNTS: "2", BAND_SETUP_TOKEN: setupToken, BAND_SETUP_TOKEN_HASH: "", BAND_LEARNING_WRITES_ENABLED: "1" }, stdio: "ignore" });
    await eventually(async () => (await fetch(`${apiOrigin}/api/health`)).ok, "temporary API did not start", 15000);
    previewServer = await preview({ root, configFile: false, base: "/", build: { outDir: dist }, preview: { host: "127.0.0.1", port: webPort, strictPort: true, proxy: { "/api": apiOrigin } } });
    const launch = { headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] };
    browser = await chromium.launch(process.env.CHROME_PATH ? { ...launch, executablePath: process.env.CHROME_PATH } : { ...launch, channel: "chrome" });
    desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "allow", permissions: ["microphone"] });
    phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "allow" });
    for (const [context, label] of [[desktopContext, "desktop"], [phoneContext, "phone"]]) {
      observeContext(context, label);
      await context.addInitScript(({ origin }) => {
        // New pages initially contain an opaque about:blank document. Only
        // initialise the disposable application origin, where storage exists.
        if (location.origin !== origin) return;
        if (!localStorage.getItem("word-atlas:settings")) localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", dailyNew: 0, feedbackMode: "rules" }));
        window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
      }, { origin });
    }
    desktop = await desktopContext.newPage(); phone = await phoneContext.newPage();
    await desktop.clock.install({ time: fixedTime }); await phone.clock.install({ time: fixedTime });
    phase = "UI plan activation and Today speaking entry";
    await login(desktop, true); await navigate(desktop, "today");
    const setup = desktop.getByRole("region", { name: "开启 8.0 计划", exact: true }); await setup.waitFor();
    await setup.getByLabel("开始日期", { exact: true }).fill("2026-11-09"); await setup.getByRole("button", { name: "开启 8.0 计划", exact: true }).click();
    const task = desktop.locator('[data-task-id="d4-speaking"]'); await task.waitFor(); evidence.uiPlanActivated = true;
    const startSpeaking = task.getByText("开始本节口语", { exact: true });
    if (await startSpeaking.isVisible()) await startSpeaking.click();
    else {
      // This isolated production fixture has no prepared private bank. Keep
      // the real course context while exercising the retained sample editor.
      assert.match(await task.innerText(), /缺|材料/);
      await navigate(desktop, "speaking?date=2026-11-12&day=4&task=d4-speaking");
    }
    await workbench(desktop).waitFor(); assert.ok(new URL(desktop.url()).hash.startsWith("#/speaking"));
    assert.equal(await desktop.evaluate(() => !window.SpeechRecognition && !window.webkitSpeechRecognition), true);
    checks.push("从今日口语块进入，浏览器语音识别置空仍可使用工作台");

    phase = "production shell offline and three actual microphone captures";
    await warm(desktop); await desktopContext.setOffline(true);
    assert.equal(await desktop.evaluate(() => navigator.onLine), false);
    assert.equal(await desktop.evaluate(() => fetch("/api/health", { cache: "no-store" }).then(() => true, () => false)), false); evidence.offlineApiUnavailable = true;
    for (const part of [1, 2, 3]) {
      await workbench(desktop).getByLabel("口语部分", { exact: true }).selectOption(String(part));
      const sampleQuestion = workbench(desktop).getByLabel("本组题目", { exact: true });
      if (await sampleQuestion.isVisible()) await sampleQuestion.selectOption("0");
      if (part === 1) assert.match(await editor(desktop).innerText(), /20\s*[–—-]\s*30\s*秒/);
      await saveCaptured(part, transcripts[part], part === 2);
    }
    checks.push("真实断网完成三Part短录、保存转写并回听；时长核对实际Blob，Part2标未说满");

    phase = "rerecord preserves both original audio and the exact parent revision";
    const first = works.find(work => work.payload.part === 1); await openWork(desktop, first.id);
    await workbench(desktop).getByRole("button", { name: "重录这题", exact: true }).click();
    const repeat = await saveCaptured(1, "I enjoy walking near the river, especially when I need a quiet place to consider a difficult problem.");
    assert.notEqual(repeat.id, first.id); assert.notEqual(repeat.payload.recordingId, first.payload.recordingId); assert.equal(repeat.payload.parentRevisionId, first.revisionId);
    const firstAudio = await recording(desktop, (await localScope(desktop)).key, first.payload.recordingId);
    assert.equal(firstAudio.sha256, clips.find(clip => clip.recordingId === first.payload.recordingId).sha256);
    checks.push("同题重录新建作答和录音，parent精确引用上一版，旧音频字节不变");

    phase = "self-review and no-band rules bind the current speaking revision";
    const review = desktop.getByRole("region", { name: "口语体检与自查", exact: true }); await review.waitFor();
    await review.getByRole("checkbox", { name: "口语自查 speaking-fluency-continuity", exact: true }).check();
    await review.getByRole("checkbox", { name: "口语错因 fluency-pause", exact: true }).check();
    await review.getByRole("button", { name: "保存口语自查", exact: true }).click();
    await eventually(async () => Object.values((await localScope(desktop)).heads).some(work => work.kind === "feedback" && work.payload.workRevisionId === repeat.revisionId && work.payload.source === "self"), "speaking self-review did not persist");
    await eventually(async () => Object.values((await localScope(desktop)).heads).some(work => work.kind === "feedback" && work.payload.workRevisionId === repeat.revisionId && work.payload.source === "rules"), "local transcript evidence did not persist");
    const self = Object.values((await localScope(desktop)).heads).find(work => work.kind === "feedback" && work.payload.workRevisionId === repeat.revisionId && work.payload.source === "self");
    const rules = Object.values((await localScope(desktop)).heads).filter(work => work.kind === "feedback" && work.payload.source === "rules");
    assert.equal(self.payload.taskType, "speaking"); assert.equal(self.payload.inputHash, repeat.contentHash); assert.equal(self.payload.checklist["speaking-fluency-continuity"], true); assert.ok(self.payload.errorCauses.includes("fluency-pause"));
    assert.ok(rules.every(work => Object.values(work.payload.bands).every(band => band === null)));
    checks.push("口语错因与自查绑定当前转写revision/hash，本地规则四维全为null");

    phase = "offline refresh retains all records and original playable audio";
    await workbench(desktop).getByRole("button", { name: "完成本次口语", exact: true }).click();
    await eventually(async () => Object.values((await localScope(desktop)).heads).some(work => work.kind === "mission" && work.payload.taskId === "d4-speaking" && work.payload.status === "completed"), "explicit completion did not update the speaking mission");
    const scopeBefore = await localScope(desktop), mission = Object.values(scopeBefore.heads).find(work => work.kind === "mission" && work.payload.taskId === "d4-speaking");
    const practiceMinimum = practiceBounds.reduce((sum, interval) => sum + interval.minimum, 0), practiceMaximum = practiceBounds.reduce((sum, interval) => sum + interval.maximum, 0);
    const actualSeconds = mission.payload.actualMinutes * 60;
    assert.ok(actualSeconds >= practiceMinimum - 0.2 && actualSeconds <= practiceMaximum + 0.2, `mission actual ${actualSeconds}s must fall within UI practice-clock bounds ${practiceMinimum}..${practiceMaximum}s`);
    assert.notEqual(mission.payload.actualMinutes, mission.payload.plannedMinutes, "a short practice must not receive its full planned minutes");
    evidence.practiceClock = { minimumSeconds: practiceMinimum, maximumSeconds: practiceMaximum, missionSeconds: actualSeconds, plannedMinutes: mission.payload.plannedMinutes };
    const offlineResponse = await desktop.reload({ waitUntil: "domcontentloaded" }); assert.equal(offlineResponse?.fromServiceWorker(), true); evidence.offlineReloadFromServiceWorker = true;
    await workbench(desktop).waitFor();
    for (const clip of clips) {
      await eventually(async () => (await localScope(desktop)).heads[clip.work.id]?.revisionId === clip.work.revisionId, "offline reload lost the exact speaking revision");
      const current = await recording(desktop, (await localScope(desktop)).key, clip.recordingId); assert.ok(current); assert.ok(Buffer.from(current.base64, "base64").equals(Buffer.from(clip.base64, "base64")), "offline refresh changed audio bytes");
    }
    await openWork(desktop, repeat.id); await verifyPlayback(desktop, repeat.payload.recordingId);
    checks.push("断网刷新保留四份作答与原字节录音，任务按真实准备和录音秒数完成");

    phase = "reconnect syncs text and metadata but not local recordings";
    await desktopContext.setOffline(false);
    await eventually(async () => (await localScope(desktop)).outbox.length === 0, "speaking records did not automatically synchronize");
    for (const work of works) { const history = await serverHistory(desktop, work.id); assert.equal(history.filter(value => value.revisionId === work.revisionId).length, 1); }
    await login(phone, false); evidence.mobileWorkClick = await openWork(phone, repeat.id, { probeObstruction: true });
    await eventually(async () => (await localScope(phone)).heads[repeat.id]?.revisionId === repeat.revisionId, "second device did not read the same speaking revision");
    for (const work of works) {
      const same = (await localScope(phone)).heads[work.id]; assert.equal(same.revisionId, work.revisionId); assert.equal(same.payload.transcript, work.payload.transcript);
    }
    assert.equal(await editor(phone).getByLabel("手动转写", { exact: true }).inputValue(), repeat.payload.transcript);
    assert.match(await editor(phone).innerText(), /录音在另一台设备上/);
    assert.equal(await recording(phone, (await localScope(phone)).key, repeat.payload.recordingId), null);
    assert.equal((await localScope(phone)).heads[self.id].revisionId, self.revisionId);
    checks.push("另一浏览器上下文读到同revision转写与自查，明确提示录音在原设备且本机无Blob");

    phase = "ZIP UI export preserves every recorded byte and its work metadata";
    await navigate(desktop, "me");
    const backup = desktop.getByRole("region", { name: "学习录音备份", exact: true }); await backup.waitFor();
    const download = desktop.waitForEvent("download"); await backup.getByRole("button", { name: "导出录音ZIP", exact: true }).click();
    const zip = await download, zipPath = path.join(directory, "r3-recordings.zip"); await zip.saveAs(zipPath);
    const archive = unzipSync(new Uint8Array(await fs.readFile(zipPath))), manifest = JSON.parse(strFromU8(archive["manifest.json"]));
    assert.equal(manifest.format, "band-galaxy-recordings"); assert.equal(manifest.recordings.length, clips.length);
    for (const clip of clips) {
      const item = manifest.recordings.find(item => item.recordingId === clip.recordingId); assert.ok(item);
      assert.equal(item.sha256, clip.sha256); assert.equal(item.bytes, clip.bytes); assert.equal(item.transcript, clip.work.payload.transcript); assert.equal(item.prompt, clip.work.payload.prompt);
      assert.ok(Buffer.from(archive[item.file]).equals(Buffer.from(clip.base64, "base64")), "ZIP file differs from the exact source Blob");
      assert.ok(Math.abs(item.durationSeconds - clip.decodedDuration) <= 0.15);
    }
    checks.push("通过我的页面导出ZIP，逐份核对原始完整字节/SHA256及题目转写时长");

    phase = "ZIP UI import on second device enables actual playback";
    await navigate(phone, "me"); const phoneBackup = phone.getByRole("region", { name: "学习录音备份", exact: true }); await phoneBackup.waitFor();
    await phoneBackup.getByLabel("选择录音ZIP备份", { exact: true }).setInputFiles(zipPath);
    await eventually(async () => (await phoneBackup.innerText()).includes(`已恢复 ${clips.length} 段录音`), "second-device ZIP UI did not restore the recordings");
    for (const clip of clips) {
      const imported = await recording(phone, (await localScope(phone)).key, clip.recordingId); assert.ok(imported); assert.equal(imported.sha256, clip.sha256);
      assert.ok(Buffer.from(imported.base64, "base64").equals(Buffer.from(clip.base64, "base64")), "ZIP import changed audio bytes");
      assert.equal(imported.metadata.transcript, clip.work.payload.transcript);
      await openWork(phone, clip.work.id); await verifyPlayback(phone, clip.recordingId);
    }
    checks.push("第二设备UI导入ZIP后四份原字节录音均可实际播放，按recordingId匹配");

    phase = "deleting a response retains its local audio and backup metadata";
    await openWork(phone, first.id);
    const preserved = await recording(phone, (await localScope(phone)).key, first.payload.recordingId);
    phone.once("dialog", dialog => dialog.accept());
    await workbench(phone).getByRole("button", { name: "删除作答", exact: true }).click();
    await eventually(async () => (await localScope(phone)).heads[first.id]?.deleted === true, "response deletion did not persist its tombstone");
    const orphan = await recording(phone, (await localScope(phone)).key, first.payload.recordingId); assert.ok(orphan);
    assert.ok(Buffer.from(orphan.base64, "base64").equals(Buffer.from(preserved.base64, "base64"))); assert.deepEqual(orphan.metadata, preserved.metadata);
    await eventually(async () => (await serverHistory(phone, first.id)).some(value => value.deleted), "response deletion did not synchronize its tombstone");
    checks.push("删除作答只删文字记录，本机录音完整字节与备份元数据继续保留");

    phase = "all HTTP requests exclude audio and private API replies bypass caches";
    const violations = [];
    for (const request of httpBodies) {
      const text = request.body.toString("utf8");
      const mediaType = /^(?:audio\/|multipart\/form-data|application\/octet-stream)/i.test(request.type);
      const embedded = /data:audio\//i.test(text) || /"(?:audioBase64|audioBytes|audioData|blob)"\s*:/.test(text) || clips.some(clip => request.body.includes(Buffer.from(clip.base64, "base64")) || text.includes(clip.base64.slice(0, 80)));
      if (mediaType || embedded) violations.push({ method: request.method, path: request.pathname, type: request.type });
    }
    assert.deepEqual(violations, [], "outgoing HTTP carried audio"); assert.ok(httpBodies.length > 0);
    assert.ok(privateReplies.every(reply => !reply.fromServiceWorker && reply.cache.includes("no-store")));
    assert.deepEqual(pageErrors, [], "uncaught speaking browser errors"); evidence.httpWritesObserved = httpBodies.length; evidence.audioUploadRequests = violations.length;
    evidence.actualCaptureDurations = clips.map(clip => ({ part: clip.work.payload.part, decodedSeconds: clip.decodedDuration, savedSeconds: clip.work.payload.durationSeconds, bytes: clip.bytes }));
    checks.push("含ServiceWorker在内的完整HTTP请求日志无音频，学习API禁止缓存且无未捕获异常"); success = true;
  } catch (error) {
    failure = String(error.message || error).replaceAll(password, "[redacted]").replaceAll(setupToken, "[redacted]");
    const page = phone && !phone.isClosed() && phone.url().startsWith(origin) ? phone : desktop;
    await page?.screenshot({ path: "/private/tmp/band-r3-e2e-failure.png", fullPage: true }).catch(() => null);
  } finally {
    await Promise.all([desktopContext?.close().catch(() => null), phoneContext?.close().catch(() => null)]); await browser?.close().catch(() => null);
    if (previewServer) await new Promise(resolve => previewServer.httpServer.close(resolve)); await stop(backend); await fs.rm(directory, { recursive: true, force: true });
  }
  const result = { suite: "R3 production speaking", success, checks, evidence, ...(failure ? { failedPhase: phase, error: failure } : {}) }; console.log(JSON.stringify(result, null, 2)); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { if (!(await runR3SpeakingE2E()).success) process.exitCode = 1; }
