#!/usr/bin/env node
/**
 * Local integration test using disposable browser contexts and a temporary SQLite database.
 * Run `npm run build` first, then `node scripts/test-sync-e2e.mjs`.
 * Never uses a deployed website, an existing browser profile, or a user's learning records.
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
const apiPort = Number(process.env.BAND_E2E_API_PORT || 15189);
const webPort = Number(process.env.BAND_E2E_WEB_PORT || 15188);
assert.ok(Number.isInteger(apiPort) && apiPort > 1024 && apiPort < 65536);
assert.ok(Number.isInteger(webPort) && webPort > 1024 && webPort < 65536 && webPort !== apiPort);
const origin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "band-sync-e2e-"));
const dbPath = path.join(artifacts, "test-progress.sqlite3");
const username = `e2e_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const setupToken = randomBytes(24).toString("base64url");
const dataset = "word-atlas-open";
const progressKey = `word-atlas:v2:${dataset}`;
const checks = [];
const errors = [];
const processLogs = [];
const apiResponses = [];
const diagnostics = [];
let backend;
let preview;
let browser;
let phoneContext;
let desktopContext;
let success = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await wait(150);
  }
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ""}`);
}
function launchProcess(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const output of [child.stdout, child.stderr]) output.on("data", (chunk) => {
    processLogs.push(chunk.toString());
    if (processLogs.length > 100) processLogs.shift();
  });
  child.on("error", (error) => processLogs.push(error.message));
  return child;
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => null);
  child.kill("SIGTERM");
  await Promise.race([exited, wait(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function startBackend() {
  backend = launchProcess(process.env.BAND_E2E_PYTHON || "python3", ["server/app.py", "--host", "127.0.0.1", "--port", String(apiPort), "--db", dbPath], {
    BAND_DB_PATH: dbPath, BAND_PUBLIC_ORIGIN: origin, BAND_COOKIE_SECURE: "0", BAND_TRUST_PROXY: "0",
    BAND_ALLOW_REGISTER: "1", BAND_MAX_ACCOUNTS: "1", BAND_SETUP_TOKEN: setupToken, BAND_SETUP_TOKEN_HASH: "",
  });
  await eventually(async () => {
    if (backend.exitCode !== null) throw new Error("The temporary Python API exited.");
    const response = await fetch(`${apiOrigin}/api/health`);
    return response.ok && (await response.json()).ok === true;
  }, "temporary Python API health", 15000);
}
function progress(id, historicalDay, at) {
  return {
    version: 2, datasetId: dataset,
    cards: { [id]: { due: at + 86400000, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, last: at, seen: at } },
    skills: {}, bookmarks: [], days: { [historicalDay]: { n: 1, r: 1, c: 1, t: 10 } }, typing: [], session: null,
    mistakes: [], spell: {}, spellLog: [], placement: null, queue: [], readings: [], shadow: { days: {}, best: 0, done: {} }, hacks: {}, flashBest: 0,
  };
}
async function seedContext(context, fixture) {
  await context.addInitScript(({ progress, progressKey }) => {
    if (localStorage.getItem("band-e2e:seeded")) return;
    localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", dailyNew: 0 }));
    localStorage.setItem(progressKey, JSON.stringify(progress));
    localStorage.setItem("band-e2e:seeded", "1");
  }, { progress: fixture, progressKey });
}
function observe(page, device) {
  page.on("pageerror", (error) => errors.push(`${device}: ${error.message}`));
  page.on("requestfailed", (request) => diagnostics.push({ event: "requestfailed", device, url: request.url(), failure: request.failure() }));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/atlas/index.json") diagnostics.push({
      event: "index-response", device, status: response.status(), fromServiceWorker: response.fromServiceWorker(),
      requestHeaders: response.request().headers(), responseHeaders: response.headers(),
    });
    if (new URL(response.url()).pathname.startsWith("/api/")) apiResponses.push({
      device, path: new URL(response.url()).pathname, status: response.status(),
      fromServiceWorker: response.fromServiceWorker(), cacheControl: response.headers()["cache-control"] ?? "",
    });
  });
}
const panel = (page) => page.locator(".sync-panel");
async function openMe(page) {
  await page.goto(`${origin}/#/me`, { waitUntil: "networkidle" });
  await panel(page).getByRole("heading", { name: "学习进度同步", exact: true }).waitFor();
}
async function signIn(page, create = false, pass = password) {
  const form = panel(page);
  if (create) await form.getByRole("button", { name: "首次设置", exact: true }).click();
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(pass);
  if (create) await form.locator('input[name="setup-token"]').fill(setupToken);
  await form.getByRole("button", { name: create ? "创建账号并同步" : "登录并同步", exact: true }).click();
  await eventually(async () => (await form.locator(".sync-status").textContent())?.includes("已同步"), "UI account login and initial synchronization");
  assert.ok((await form.textContent()).includes(username));
}
async function localProgress(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), progressKey);
}
async function remoteSnapshot(page) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/sync/${id}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(`snapshot API status ${response.status}`);
    return response.json();
  }, dataset);
}
async function hasWords(page, ids) {
  const value = await localProgress(page);
  return ids.every((id) => value?.cards[id]);
}
async function resume(page) {
  await page.bringToFront();
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
}
async function primeOffline(page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await eventually(() => page.evaluate(() => !!navigator.serviceWorker.controller), "production service worker controls page");
  await page.reload({ waitUntil: "networkidle" });
  // Force a controlled fetch instead of relying on a warm browser HTTP-cache request.
  await page.evaluate(async () => {
    const response = await fetch("/atlas/index.json", { cache: "reload" });
    if (!response.ok) throw new Error(`word index status ${response.status}`);
    await response.arrayBuffer();
  });
  await eventually(async () => page.evaluate(async () => !!(await caches.match(new URL("/atlas/index.json", location.origin).href))), "service worker cached the word index");
}
async function importOfflineStudy(page, id, at) {
  const current = await localProgress(page);
  delete current._cloudStamp;
  delete current._cloudSettings;
  current.cards[id] = { due: at + 86400000, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, last: at, seen: at };
  current.days["2026-11-02"] = { n: 1, r: 1, c: 1, t: 10 };
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("word-atlas:settings") || "{}"));
  const backup = { app: "word-atlas", version: 2, exported: new Date().toISOString(), progress: current, settings };
  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({ name: "isolated-e2e-study.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await eventually(() => hasWords(page, [id]), "offline imported study is persisted in the browser");
}

try {
  await fs.access(path.join(root, "dist/index.html"));
  const index = JSON.parse(await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"));
  const ids = index.words.slice(0, 4).map((row) => row[0]);
  assert.equal(new Set(ids).size, 4);
  await startBackend();
  preview = launchProcess(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { BAND_API_TARGET: apiOrigin });
  await eventually(async () => {
    if (preview.exitCode !== null) throw new Error("Vite preview exited.");
    const response = await fetch(`${origin}/api/health`);
    return response.ok && response.headers.get("content-type")?.includes("json") && (await response.json()).ok === true;
  }, "production Vite preview proxies the real Python API", 15000);

  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
  phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "allow" });
  desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "allow" });
  const now = Date.now();
  await seedContext(phoneContext, progress(ids[0], "2026-10-30", now - 30000));
  await seedContext(desktopContext, progress(ids[1], "2026-10-31", now - 20000));
  const phone = await phoneContext.newPage();
  const desktop = await desktopContext.newPage();
  observe(phone, "phone");
  observe(desktop, "desktop");
  await Promise.all([openMe(phone), openMe(desktop)]);
  await signIn(phone, true);
  await signIn(desktop);
  await resume(phone);
  await eventually(() => hasWords(phone, ids.slice(0, 2)), "phone automatically receives desktop's existing local history");
  await eventually(() => hasWords(desktop, ids.slice(0, 2)), "desktop merges phone's existing history");
  checks.push("UI registration/login and merging both devices' existing local progress");

  await Promise.all([primeOffline(phone), primeOffline(desktop)]);
  await Promise.all([phoneContext.setOffline(true), desktopContext.setOffline(true)]);
  await Promise.all([importOfflineStudy(phone, ids[2], now + 10), importOfflineStudy(desktop, ids[3], now + 20)]);
  await phone.reload({ waitUntil: "domcontentloaded" });
  await eventually(() => hasWords(phone, [ids[2]]), "offline reload keeps the phone's new study");
  diagnostics.push(await phone.evaluate(async () => ({
    phase: "offline-reload", appReady: !!document.querySelector(".sync-panel"),
    indexCaches: await Promise.all((await caches.keys()).map(async (name) => {
      const cache = await caches.open(name);
      const request = (await cache.keys()).find((request) => new URL(request.url).pathname === "/atlas/index.json");
      const response = request ? await cache.match(request) : null;
      return { name, requestHeaders: request ? Object.fromEntries(request.headers) : null, responseHeaders: response ? Object.fromEntries(response.headers) : null };
    })),
  })));
  await panel(phone).getByRole("heading", { name: "学习进度同步", exact: true }).waitFor({ timeout: 10000 });
  checks.push("offline UI import and an offline app reload preserve records and keep the app usable");
  await Promise.all([phoneContext.setOffline(false), desktopContext.setOffline(false)]);
  await Promise.all([resume(phone), resume(desktop)]);
  await eventually(async () => {
    const remote = await remoteSnapshot(phone);
    return ids.every((id) => remote.snapshot?.progress.cards[id]) && remote.snapshot.progress.days["2026-11-02"]?.r === 2;
  }, "both offline deltas are automatically uploaded exactly once");
  await Promise.all([resume(phone), resume(desktop)]);
  await eventually(async () => (await hasWords(phone, ids)) && (await hasWords(desktop, ids)), "both devices automatically converge");
  assert.equal((await localProgress(phone)).days["2026-11-02"].r, 2);
  assert.equal((await localProgress(desktop)).days["2026-11-02"].r, 2);
  checks.push("two offline devices automatically converge with correct additive daily review counts");

  for (const page of [phone, desktop]) {
    const cachedAPI = await page.evaluate(async () => {
      const urls = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys())
        if (new URL(request.url).pathname.startsWith("/api/")) urls.push(request.url);
      return urls;
    });
    assert.deepEqual(cachedAPI, [], "account/progress APIs must never enter service-worker caches");
  }
  assert.ok(apiResponses.length > 0);
  assert.ok(apiResponses.every((response) => !response.fromServiceWorker), "API replies must come from the server");
  assert.ok(apiResponses.filter((response) => response.status < 400).every((response) => response.cacheControl.includes("no-store")));
  checks.push("production service worker and HTTP cache both exclude account/progress APIs");

  const beforeRestart = await remoteSnapshot(phone);
  await stopProcess(backend);
  await startBackend();
  assert.deepEqual(await remoteSnapshot(phone), beforeRestart, "SQLite state survives a backend process restart");
  const session = await desktop.evaluate(async () => (await fetch("/api/auth/session", { cache: "no-store" })).json());
  assert.equal(session.user.username, username, "SQLite-backed sessions survive restart");
  checks.push("database snapshots and authenticated sessions survive a Python service restart");

  await desktop.getByText("账号管理", { exact: true }).click();
  const account = desktop.locator(".account-panel");
  await eventually(async () => (await account.locator(".account-device-list li").count()) === 2, "account management lists the two isolated login sessions");
  await account.getByRole("button", { name: /^退出其他设备/ }).click();
  await account.getByText("其他设备已退出，当前设备保持登录。", { exact: true }).waitFor();
  await resume(phone);
  await eventually(async () => (await panel(phone).locator(".sync-status").textContent())?.includes("请重新登录"), "revoking another device requires it to reauthenticate");
  assert.ok(await hasWords(phone, ids), "revoking a session preserves local study");
  await signIn(phone);
  checks.push("account device list and revoke-other-devices UI keep local progress while requiring login");

  const newPassword = randomBytes(24).toString("base64url");
  await account.locator('input[name="current-password"]').fill(password);
  await account.locator('input[name="new-password"]').fill(newPassword);
  await account.locator('input[name="confirm-new-password"]').fill(newPassword);
  await account.getByRole("button", { name: "修改密码", exact: true }).click();
  await account.getByText("密码已修改。其他设备需要使用新密码重新登录。", { exact: true }).waitFor();
  await resume(phone);
  await eventually(async () => (await panel(phone).locator(".sync-status").textContent())?.includes("请重新登录"), "password change revokes the other device session");
  const login = panel(phone);
  await login.locator('input[name="username"]').fill(username);
  await login.locator('input[name="password"]').fill(password);
  await login.getByRole("button", { name: "登录并同步", exact: true }).click();
  await eventually(async () => (await login.getByRole("alert").textContent())?.includes("密码"), "old password is rejected after change");
  await signIn(phone, false, newPassword);
  assert.ok(await hasWords(phone, ids));
  assert.ok(await hasWords(desktop, ids));
  assert.equal((await remoteSnapshot(phone)).snapshot.progress.days["2026-11-02"].r, 2);
  checks.push("UI password change rejects the old password, revokes other devices, and preserves synchronized progress");

  const cookies = await phoneContext.cookies(`${origin}/api/auth/session`);
  const sessionCookie = cookies.find((cookie) => cookie.name === "band_session");
  assert.ok(sessionCookie?.httpOnly && sessionCookie.sameSite === "Strict", "the login cookie is HttpOnly and SameSite=Strict");
  assert.ok(apiResponses.every((response) => !response.fromServiceWorker));
  assert.ok(apiResponses.filter((response) => response.status < 400).every((response) => response.cacheControl.includes("no-store")));
  await desktop.getByText("账号管理", { exact: true }).click();

  await panel(desktop).scrollIntoViewIfNeeded();
  await desktop.screenshot({ path: path.join(artifacts, "desktop-sync.png") });
  await panel(phone).scrollIntoViewIfNeeded();
  await phone.screenshot({ path: path.join(artifacts, "phone-sync.png") });
  assert.deepEqual(errors, [], "no uncaught browser errors");
  success = true;
} catch (error) {
  errors.push(error.stack ?? error.message);
  for (const [name, context] of [["phone", phoneContext], ["desktop", desktopContext]]) {
    const page = context?.pages()[0];
    if (page) {
      await page.screenshot({ path: path.join(artifacts, `${name}-failure.png`) }).catch(() => null);
      diagnostics.push(await page.evaluate(async () => ({
        name: document.title, status: document.querySelector(".sync-panel")?.textContent,
        controller: navigator.serviceWorker.controller?.scriptURL,
        caches: await Promise.all((await caches.keys()).map(async (name) => ({ name, keys: (await (await caches.open(name)).keys()).map((request) => request.url) }))),
      })).catch(() => null));
    }
  }
  throw error;
} finally {
  await phoneContext?.close().catch(() => null);
  await desktopContext?.close().catch(() => null);
  await browser?.close().catch(() => null);
  await stopProcess(preview);
  await stopProcess(backend);
  await fs.writeFile(path.join(artifacts, "report.json"), JSON.stringify({ success, checks, errors, apiResponses, diagnostics, processLogs }, null, 2));
  console.log(JSON.stringify({ success, checks, artifacts }, null, 2));
}
