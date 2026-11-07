#!/usr/bin/env node
// Built frontend + disposable API/SQLite/accounts. Never accesses production data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://127.0.0.1:16388",
  api = "http://127.0.0.1:16389";
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "band-quantity-e2e-"),
);
const processes = [],
  logs = [],
  checks = [],
  pageErrors = [];
const username = "quantity_fixture",
  password = randomBytes(24).toString("base64url"),
  setupToken = randomBytes(24).toString("base64url");
const dataset = "word-atlas-open",
  storageKey = `word-atlas:v2:${dataset}`;
let browser,
  success = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, label) {
  let last;
  for (let i = 0; i < 150; i++) {
    try {
      if (await fn()) return;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`${label}: ${last?.message ?? "timed out"}`);
}
function launch(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs.push(chunk.toString());
      if (logs.length > 60) logs.shift();
    });
}
const day = (offset) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offset * 86400000));
const settings = {
  onboarded: true,
  autoplay: false,
  sfx: false,
  splash: false,
  ambience: "off",
  dailyNew: 30,
  dailyMinutes: 15,
  theme: "light",
  examDate: day(3),
  trackL: false,
  trackP: false,
};
async function seed(context, fixture, overrides = {}) {
  await context.addInitScript(
    ({ settings, fixture, storageKey }) => {
      if (localStorage.getItem("quantity-fixture-ready")) return;
      localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
      if (fixture) localStorage.setItem(storageKey, JSON.stringify(fixture));
      localStorage.setItem("quantity-fixture-ready", "1");
    },
    { settings: { ...settings, ...overrides }, fixture, storageKey },
  );
}
const progress = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
const preferences = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("word-atlas:settings")));
function observe(page) {
  page.on("pageerror", (error) => pageErrors.push(error.message));
}
async function width(page, expected) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.equal(sizes.viewport, expected);
  assert.ok(sizes.scroll <= expected, JSON.stringify(sizes));
}
async function daily(page, count) {
  await page.getByRole("button", { name: "调整每日数量", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "设置每日新词",
    exact: true,
  });
  await dialog.getByRole("spinbutton", { name: /每日新词数量/ }).fill(String(count));
  await dialog
    .getByRole("button", { name: "保存每日数量", exact: true })
    .click();
  await eventually(
    async () => (await preferences(page)).dailyNew === count,
    "saved daily goal",
  );
}
try {
  launch(
    "python3",
    [
      "server/app.py",
      "--host",
      "127.0.0.1",
      "--port",
      "16389",
      "--db",
      path.join(temporary, "progress.sqlite3"),
    ],
    {
      BAND_PUBLIC_ORIGIN: origin,
      BAND_COOKIE_SECURE: "0",
      BAND_SINGLE_USER: "0",
      BAND_ALLOW_REGISTER: "1",
      BAND_SETUP_TOKEN: setupToken,
      BAND_SETUP_TOKEN_HASH: "",
    },
  );
  launch(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "16388",
      "--strictPort",
    ],
    { BAND_API_TARGET: api },
  );
  await eventually(
    async () => (await fetch(origin + "/api/health")).ok,
    "isolated app/API",
  );
  const index = JSON.parse(
    await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"),
  );
  const now = Date.now();
  const card = {
    due: now + 10 * 86400000,
    s: 3,
    d: 5,
    el: 0,
    sd: 1,
    ls: 0,
    reps: 2,
    lapses: 0,
    st: 2,
    last: now,
    seen: now,
  };
  const fixture = {
    version: 2,
    datasetId: dataset,
    cards: Object.fromEntries(
      index.words.slice(0, 12).map((word) => [word[0], card]),
    ),
    skills: {},
    bookmarks: [],
    days: { [day(0)]: { n: 12, r: 12, c: 12, t: 200 } },
    typing: [],
    mistakes: [],
    spell: {},
    spellLog: [],
    placement: null,
    queue: [],
    readings: [],
    shadow: { days: {}, best: 0, done: {} },
    hacks: {},
    flashBest: 0,
    session: null,
  };
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Shanghai",
  });
  const register = await desktop.request.post(origin + "/api/auth/register", {
    data: { username, password, setupToken },
    headers: { Origin: origin },
  });
  assert.equal(register.status(), 201);
  await seed(desktop, fixture);
  const page = await desktop.newPage();
  observe(page);
  await page.goto(origin + "/#/");
  await page
    .getByRole("button", { name: "调整每日数量", exact: true })
    .waitFor();
  const goal = page.getByRole("region", { name: "每日新词目标", exact: true });
  // A section with an accessible name is exposed as a region.
  assert.match(await goal.innerText(), /每天 30 个新词/);
  assert.match(await goal.innerText(), /今天已学 12 个 · 计划内还可学 18 个/);
  assert.doesNotMatch(
    await page.locator(".journey").innerText(),
    /只复习|暂停新词/,
  );
  const before = await progress(page);
  await daily(page, 27);
  assert.match(await goal.innerText(), /还可学 15 个/);
  await page.reload();
  assert.match(await goal.innerText(), /每天 27 个新词/);
  await page.getByRole("button", { name: "调整每日数量", exact: true }).click();
  const picker = page.getByRole("dialog", {
    name: "设置每日新词",
    exact: true,
  });
  const countInput = picker.getByRole("spinbutton", { name: /每日新词数量/ }),
    save = picker.getByRole("button", { name: "保存每日数量", exact: true });
  for (const invalid of ["", "101", "-1", "1.5"]) {
    await countInput.fill(invalid);
    assert.equal(await save.isEnabled(), false, invalid);
  }
  await countInput.fill("88");
  await picker.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(
    (await preferences(page)).dailyNew,
    27,
    "cancelling a draft never saves it",
  );
  await daily(page, 100);
  assert.match(await goal.innerText(), /还可学 88 个/);
  await daily(page, 10);
  await page
    .getByRole("button", { name: "继续学新词 · 自选数量", exact: true })
    .click();
  const extra = page.getByRole("dialog", { name: "继续学新词", exact: true });
  const extraInput = extra.getByRole("spinbutton", { name: /本轮加学数量/ }),
    begin = extra.getByRole("button", { name: "开始这一轮", exact: true });
  for (const invalid of ["0", "101", "1.5"]) {
    await extraInput.fill(invalid);
    assert.equal(await begin.isEnabled(), false);
  }
  await extra.getByRole("button", { name: "30 个", exact: true }).click();
  assert.match(await extra.innerText(), /本轮将学习 30 个新词/);
  await extraInput.fill("17");
  await begin.click();
  await page.getByRole("button", { name: "暂停并返回", exact: true }).waitFor();
  await eventually(
    async () => (await progress(page)).session?.newIds?.length === 17,
    "selected 17-word round persists",
  );
  const running = (await progress(page)).session;
  assert.equal(
    running.steps.filter((step) => step.kind === "intro").length,
    17,
  );
  assert.ok(running.newIds.every((id) => !before.cards[id]));
  assert.equal(
    (await preferences(page)).dailyNew,
    10,
    "one extra batch never changes the daily goal",
  );
  await page.getByRole("button", { name: "暂停并返回", exact: true }).click();
  await daily(page, 35);
  assert.deepEqual(
    (await progress(page)).session,
    running,
    "changing the quota preserves the entire unfinished round",
  );
  await page.getByRole("button", { name: "继续旅程", exact: true }).click();
  assert.deepEqual((await progress(page)).session, running);
  await page.getByRole("button", { name: "暂停并返回", exact: true }).click();
  const after = await progress(page);
  for (const key of ["cards", "skills", "days", "typing", "spellLog"])
    assert.deepEqual(after[key], before[key], key);
  checks.push(
    "设定考前3天仍按自定目标补足；自定义/0–100校验/取消/刷新；加学17词不再固定5词；调整目标保留未完成轮次及FSRS数据",
  );

  await eventually(
    async () =>
      (
        await (
          await desktop.request.get(`${origin}/api/sync/${dataset}`)
        ).json()
      ).snapshot?.settings?.dailyNew === 35,
    "server receives daily quota",
  );
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Shanghai",
  });
  await seed(phoneContext, null);
  assert.equal(
    (
      await phoneContext.request.post(origin + "/api/auth/login", {
        data: { username, password },
        headers: { Origin: origin },
      })
    ).status(),
    200,
  );
  const phone = await phoneContext.newPage();
  observe(phone);
  await phone.goto(origin + "/#/");
  await eventually(
    async () => (await preferences(phone)).dailyNew === 35,
    "second device receives goal",
  );
  await width(phone, 390);
  await phone
    .getByRole("button", { name: "调整每日数量", exact: true })
    .click();
  await width(phone, 390);
  const phonePicker = phone.getByRole("dialog", {
    name: "设置每日新词",
    exact: true,
  });
  await phonePicker.getByRole("spinbutton", { name: /每日新词数量/ }).fill("49");
  await phonePicker
    .getByRole("button", { name: "保存每日数量", exact: true })
    .click();
  await eventually(
    async () =>
      (
        await (
          await desktop.request.get(`${origin}/api/sync/${dataset}`)
        ).json()
      ).snapshot?.settings?.dailyNew === 49,
    "phone goal in SQLite",
  );
  await page.reload();
  await eventually(
    async () => (await preferences(page)).dailyNew === 49,
    "desktop receives phone goal",
  );
  assert.deepEqual((await progress(page)).session, running);
  await phone.goto(origin + "/#/me");
  assert.equal(await phone.getByRole("spinbutton", { name: /每日新词数量/ }).inputValue(), "49");
  await width(phone, 390);
  await phone.getByRole("spinbutton", { name: /每日新词数量/ }).fill("0");
  await phone
    .getByRole("button", { name: "保存每日数量", exact: true })
    .click();
  await phone.goto(origin + "/#/");
  assert.match(
    await phone.locator(".daily-word-goal").innerText(),
    /每天 0 个新词/,
  );
  await phone
    .getByRole("button", { name: "继续学新词 · 自选数量", exact: true })
    .click();
  await width(phone, 390);
  assert.equal(await phone.getByRole("spinbutton", { name: /本轮加学数量/ }).inputValue(), "20");
  checks.push(
    "每日数量沿原账号SQLite快照同步；第二设备修改后电脑接收且不中断复习；390px首页/选择器/我的均不溢出；0词只复习仍可加学",
  );

  // A deliberately small atlas fixture uses the real first three entries/media.
  // This exercises the end-of-pool boundary without fabricating thousands of learned cards.
  const tinyContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "Asia/Shanghai",
  });
  const tiny = {
    ...fixture,
    cards: Object.fromEntries(
      index.words.slice(0, 2).map((word) => [word[0], card]),
    ),
    days: {},
    session: null,
  };
  await tinyContext.route("**/atlas/supplement.json", (route) => route.fulfill({ json: { entries: [] } }));
  await tinyContext.route("**/atlas/index.json", (route) =>
    route.fulfill({
      json: { ...index, words: index.words.slice(0, 3), count: 3 },
    }),
  );
  await seed(tinyContext, tiny, { dailyNew: 0 });
  const end = await tinyContext.newPage();
  observe(end);
  await end.goto(origin + "/#/");
  await end
    .getByRole("button", { name: "继续学新词 · 自选数量", exact: true })
    .click();
  await end.getByRole("spinbutton", { name: /本轮加学数量/ }).fill("100");
  assert.match(
    await end
      .getByRole("dialog", { name: "继续学新词", exact: true })
      .innerText(),
    /本轮将学习 1 个新词（当前仅剩 1 个）/,
  );
  await end.getByRole("button", { name: "开始这一轮", exact: true }).click();
  await eventually(
    async () => (await progress(end)).session?.newIds?.length === 1,
    "only the remaining real word is started",
  );
  const exhaustedContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "Asia/Shanghai",
  });
  await exhaustedContext.route("**/atlas/supplement.json", (route) => route.fulfill({ json: { entries: [] } }));
  await exhaustedContext.route("**/atlas/index.json", (route) =>
    route.fulfill({
      json: { ...index, words: index.words.slice(0, 3), count: 3 },
    }),
  );
  await seed(exhaustedContext, {
    ...tiny,
    cards: Object.fromEntries(
      index.words.slice(0, 3).map((word) => [word[0], card]),
    ),
  });
  const exhausted = await exhaustedContext.newPage();
  observe(exhausted);
  await exhausted.goto(origin + "/#/");
  assert.equal(
    await exhausted
      .getByRole("button", { name: "当前词库新词已学完", exact: true })
      .isEnabled(),
    false,
  );
  checks.push(
    "剩余不足所选数量时显示实际数量并按实际开课；新词用尽不创建空轮次；现有词汇版与默写功能保留",
  );
  assert.deepEqual(pageErrors, []);
  success = true;
} catch (error) {
  console.error(error.stack || error);
  console.error(logs.join("\n"));
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of processes.reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(1200),
    ]);
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  }
  console.log(
    JSON.stringify(
      { success, checks, pageErrors, fixtureDirectory: temporary },
      null,
      2,
    ),
  );
}
