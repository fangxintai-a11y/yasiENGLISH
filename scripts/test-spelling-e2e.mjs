#!/usr/bin/env node
// Built frontend, actual vocabulary API, disposable accounts/SQLite/browser contexts only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://127.0.0.1:16288",
  api = "http://127.0.0.1:16289";
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "band-spelling-e2e-"),
);
const processes = [],
  logs = [],
  checks = [],
  pageErrors = [];
const username = "spelling_fixture",
  password = randomBytes(24).toString("base64url"),
  setupToken = randomBytes(24).toString("base64url");
const dataset = "word-atlas-open",
  storageKey = `word-atlas:v2:${dataset}`;
let browser,
  success = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, label) {
  let last;
  for (let i = 0; i < 120; i++) {
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
      if (logs.length > 80) logs.shift();
    });
  return child;
}
const settings = {
  onboarded: true,
  autoplay: false,
  sfx: false,
  splash: false,
  ambience: "off",
  dailyNew: 0,
  theme: "light",
};
async function seed(context, fixture) {
  await context.addInitScript(
    ({ settings, fixture, storageKey }) => {
      if (localStorage.getItem("spelling-fixture-ready")) return;
      localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
      if (fixture) localStorage.setItem(storageKey, JSON.stringify(fixture));
      localStorage.setItem("spelling-fixture-ready", "1");
    },
    { settings, fixture, storageKey },
  );
}
async function localProgress(page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
}
function observe(page) {
  page.on("pageerror", (error) => pageErrors.push(error.message));
}
async function width(page, pixels) {
  const sizes = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.equal(sizes.width, pixels);
  if (sizes.scroll > pixels) {
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .map((element) => ({
          tag: element.tagName,
          class: element.className,
          right: element.getBoundingClientRect().right,
        }))
        .filter((element) => element.right > innerWidth)
        .slice(0, 12),
    );
    throw new Error(JSON.stringify({ ...sizes, overflowing }));
  }
}

try {
  launch(
    "python3",
    [
      "server/app.py",
      "--host",
      "127.0.0.1",
      "--port",
      "16289",
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
      "16288",
      "--strictPort",
    ],
    { BAND_API_TARGET: api },
  );
  await eventually(
    async () => (await fetch(`${origin}/api/health`)).ok,
    "temporary app/API",
  );
  const index = JSON.parse(
    await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"),
  );
  const target = index.words.find((row) => row[1] === "accommodation");
  assert.ok(target, "real word required");
  const id = target[0],
    now = Date.now();
  const card = {
    due: now + 86400000,
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
    cards: { [id]: card },
    skills: { [`p:${id}`]: card },
    bookmarks: [id],
    days: { "2026-11-01": { n: 1, r: 2, c: 1, t: 20 } },
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
    session: {
      id: "unfinished-vocabulary-review",
      started: now,
      steps: [{ id, kind: "meaning", options: [id] }],
      index: 0,
      graded: {},
      newIds: [],
      reviewIds: [id],
    },
  };
  const chrome =
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const registered = await desktop.request.post(`${origin}/api/auth/register`, {
    data: { username, password, setupToken },
    headers: { Origin: origin },
  });
  assert.equal(registered.status(), 201);
  await seed(desktop, fixture);
  const page = await desktop.newPage();
  observe(page);
  await page.goto(origin + "/#/");
  await page.getByRole("link", { name: "开始拼写" }).waitFor();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /365|四科任务|今日四科/,
  );
  await eventually(
    async () =>
      (await desktop.request.get(`${origin}/api/sync/${dataset}`)).ok(),
    "vocabulary sync",
  );
  await page.getByRole("link", { name: "开始拼写" }).click();
  await page.getByRole("heading", { name: "想得起，也拼得出。" }).waitFor();
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  await page.getByLabel("本轮数量").fill("0");
  assert.equal(
    await page.getByRole("button", { name: /开始拼写 \d+ 词/ }).isEnabled(),
    false,
  );
  await page.getByLabel("本轮数量").fill("1");
  const before = await localProgress(page);
  assert.equal(
    before.session.id,
    fixture.session.id,
    "unfinished review must load intact",
  );
  await page.getByRole("button", { name: "开始拼写 1 词" }).click();
  const input = page.getByRole("textbox", { name: /^拼写，/ });
  await input.waitFor();
  assert.doesNotMatch(
    await page.locator(".spelling-round").innerText(),
    /accommodation/i,
    "answer must remain hidden",
  );
  await input.fill("accomodation");
  await page.getByRole("button", { name: "确认" }).click();
  assert.equal(
    await page.locator(".spelling-answer").innerText(),
    "accommodation",
  );
  assert.ok(await page.locator(".spelling-answer .is-bad").count());
  await page.getByRole("button", { name: "查看本轮结果" }).click();
  await page.getByRole("heading", { name: "首答正确 0 / 1" }).waitFor();
  await eventually(
    async () =>
      (await localProgress(page)).spellLog.some((miss) => miss.id === id),
    "durable spelling miss",
  );
  const after = await localProgress(page);
  for (const key of [
    "cards",
    "skills",
    "session",
    "days",
    "typing",
    "bookmarks",
  ])
    assert.deepEqual(after[key], before[key], key);
  checks.push(
    "首页/独立导航无365计划；自选数量；答案隐藏；错字反馈持久保存；原FSRS、统计及未完成复习不变",
  );
  await page.getByRole("button", { name: "重练本轮错词" }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), "");
  await input.fill("accommodation");
  await page.getByRole("button", { name: "确认" }).click();
  await page.getByRole("heading", { name: "拼写正确", exact: true }).waitFor();
  await page.getByRole("button", { name: "查看本轮结果" }).click();
  await page.getByRole("heading", { name: "首答正确 1 / 1" }).waitFor();
  await eventually(async () => {
    const response = await desktop.request.get(`${origin}/api/sync/${dataset}`);
    return (await response.json()).snapshot?.progress?.spellLog?.some(
      (miss) => miss.id === id,
    );
  }, "server receives spelling miss");
  checks.push("错词重练、切题清空输入、正确判定及真实SQLite同步");
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await seed(phoneContext, null);
  const login = await phoneContext.request.post(`${origin}/api/auth/login`, {
    data: { username, password },
    headers: { Origin: origin },
  });
  assert.equal(login.status(), 200);
  const phone = await phoneContext.newPage();
  observe(phone);
  await phone.goto(origin + "/#/spelling");
  await eventually(
    async () =>
      (await localProgress(phone))?.spellLog?.some((miss) => miss.id === id),
    "second device receives miss",
  );
  await phone.getByRole("button", { name: "错词本", exact: true }).click();
  await phone.getByLabel("本轮数量").fill("1");
  await phone.getByRole("button", { name: "开始拼写 1 词" }).click();
  const phoneInput = phone.getByRole("textbox", { name: /^拼写，/ });
  await phoneInput.waitFor();
  await width(phone, 390);
  await phone.setViewportSize({ width: 390, height: 420 });
  await phoneInput.fill("accom");
  await eventually(async () => {
    const bounds = await phone.locator(".slots").boundingBox();
    return bounds && bounds.y >= 0 && bounds.y + bounds.height <= 360;
  }, "visible answer with simulated small keyboard viewport");
  await width(phone, 390);
  await phone.setViewportSize({ width: 390, height: 844 });
  await phoneInput.fill("accommodation");
  await phone.getByRole("button", { name: "确认" }).click();
  await phone.getByRole("button", { name: "查看本轮结果" }).click();
  await phone.getByRole("heading", { name: "首答正确 1 / 1" }).waitFor();
  checks.push(
    "第二设备读到错词；390px无横向溢出；缩小可视高度时输入可见（非真实iPhone键盘验收）",
  );
  await page.getByRole("button", { name: "返回设置" }).click();
  for (const pixels of [768, 1280]) {
    await page.setViewportSize({ width: pixels, height: 900 });
    await width(page, pixels);
  }
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  await page.getByRole("button", { name: "听音拼写" }).click();
  await page.getByRole("button", { name: "开始拼写 1 词" }).click();
  await page.getByRole("button", { name: "再听一遍", exact: true }).waitFor();
  await input.fill("accommodation");
  await page.getByRole("button", { name: "确认" }).click();
  await page.getByRole("heading", { name: "拼写正确", exact: true }).waitFor();
  assert.equal(
    (
      await desktop.request.get(origin + "/api/learning/v2/changes?after=0")
    ).status(),
    404,
  );
  assert.deepEqual(
    await (await desktop.request.get(origin + "/api/capabilities")).json(),
    { vocabularySnapshots: 2, learningRecords: 0 },
  );
  assert.deepEqual(pageErrors, []);
  checks.push("768/1280px布局；听音拼写入口；四科API移除；无页面错误");
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
      delay(1500),
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
