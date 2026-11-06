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
const origin = "http://127.0.0.1:16588",
  api = "http://127.0.0.1:16589";
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "band-shadow-priority-e2e-"),
);
const processes = [],
  logs = [],
  checks = [],
  pageErrors = [];
const username = "shadow_priority_fixture",
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
  dailyNew: 0,
  dailyMinutes: 15,
  theme: "light",
  examDate: "",
  shadowAsr: "off",
  guessFirst: true,
  sentenceFirst: false,
  trackL: false,
  trackP: false,
};
async function seed(context, fixture, overrides = {}) {
  await context.addInitScript(
    ({ settings, fixture, storageKey }) => {
      if (localStorage.getItem("shadow-priority-fixture-ready")) return;
      localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
      if (fixture) localStorage.setItem(storageKey, JSON.stringify(fixture));
      localStorage.setItem("shadow-priority-fixture-ready", "1");
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

try {
  launch(
    "python3",
    [
      "server/app.py",
      "--host",
      "127.0.0.1",
      "--port",
      "16589",
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
      "16588",
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
  const find = (word) => {
    const row = index.words.find((row) => row[1] === word);
    assert.ok(row, word);
    return row[0];
  };
  const hut = find("hut"),
    shelter = find("shelter"),
    environment = find("environment"),
    colour = find("colour");
  const now = Date.now();
  const card = {
    due: now + 90 * 86400000,
    s: 25,
    d: 4,
    el: 0,
    sd: 90,
    ls: 0,
    reps: 5,
    lapses: 0,
    st: 2,
    last: now,
    seen: now - 30 * 86400000,
  };
  const unfinished = {
    id: "do-not-overwrite-this-round",
    started: now,
    steps: [
      { id: environment, kind: "intro" },
      { id: colour, kind: "intro" },
    ],
    index: 0,
    graded: {},
    newIds: [environment, colour],
    reviewIds: [],
  };
  const fixture = {
    version: 2,
    datasetId: dataset,
    cards: { [hut]: card },
    skills: { [`l:${hut}`]: card, [`p:${hut}`]: card },
    bookmarks: [],
    days: {},
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
    session: unfinished,
  };
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["microphone"],
    timezoneId: "Asia/Shanghai",
  });
  assert.equal(
    (
      await context.request.post(origin + "/api/auth/register", {
        data: { username, password, setupToken },
        headers: { Origin: origin },
      })
    ).status(),
    201,
  );
  await seed(context, fixture);
  const page = await context.newPage();
  observe(page);
  await page.goto(origin + "/#/shadow?go=1");
  await page.getByRole("button", { name: /^查看单词 huts/ }).waitFor();
  await eventually(
    async () =>
      (
        await (
          await context.request.get(`${origin}/api/sync/${dataset}`)
        ).json()
      ).snapshot?.progress?.cards?.[hut],
    "account profile settled",
  );
  await page.getByRole("button", { name: /^查看单词 huts/ }).click();
  const sheet = page.getByRole("dialog", { name: "跟读生词", exact: true });
  await sheet.getByRole("region", { name: "词条释义", exact: true }).waitFor();
  assert.equal(
    await sheet
      .getByRole("group", { name: "可能的词条", exact: true })
      .getByRole("button", { name: "hut", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await sheet
    .getByRole("button", { name: "不认识，加入优先学习", exact: true })
    .click();
  await sheet.getByText("已在优先待学池中", { exact: true }).waitFor();
  await sheet.getByRole("button", { name: "继续跟读", exact: true }).click();
  await eventually(
    async () => (await progress(page)).queue.includes(`review:${hut}`),
    "forgotten known word saved",
  );
  assert.deepEqual(
    (await progress(page)).cards[hut],
    card,
    "marking alone does not reset memory",
  );
  assert.deepEqual((await progress(page)).session, unfinished);
  assert.ok(await page.locator(".shadow-word-token.is-pending-word").count());
  await page.getByRole("button", { name: /^查看单词 shelter/ }).click();
  await sheet
    .getByRole("button", { name: "不认识，加入优先学习", exact: true })
    .click();
  await sheet.getByRole("button", { name: "继续跟读", exact: true }).click();
  await page.getByRole("button", { name: /^查看单词 shelter/ }).click();
  assert.equal(
    await sheet
      .getByRole("button", { name: "不认识，加入优先学习", exact: true })
      .count(),
    0,
  );
  await sheet.getByRole("button", { name: "移出待学池", exact: true }).click();
  await sheet
    .getByRole("button", { name: "不认识，加入优先学习", exact: true })
    .click();
  await sheet.getByRole("button", { name: "继续跟读", exact: true }).click();
  await eventually(
    async () => (await progress(page)).queue.length === 2,
    "deduplicated pool",
  );
  const queued = await progress(page);
  for (const key of ["cards", "skills", "days", "session", "spellLog"])
    assert.deepEqual(queued[key], fixture[key], key);
  checks.push(
    "跟读点词、huts还原hut、明确加入/移出、重复去重；新词和已学忘记词均保存；标记不改FSRS、不覆盖原轮次",
  );

  await page.getByRole("button", { name: "听原声", exact: true }).click();
  await page.getByRole("button", { name: "跟读", exact: true }).click();
  await page.getByRole("button", { name: "自己说", exact: true }).click();
  assert.equal(
    await page.locator(".shadow-word-token").count(),
    0,
    "hidden-text phase never exposes target words for selection",
  );
  await page.getByRole("button", { name: "偷看一眼", exact: true }).click();
  await page.getByRole("button", { name: "开始说", exact: true }).click();
  await page.getByRole("button", { name: "说完了", exact: true }).waitFor();
  const disabled = await page
    .locator(".shadow-word-token")
    .evaluateAll((words) => words.every((word) => word.disabled));
  assert.equal(
    disabled,
    true,
    "recording cannot be interrupted by opening a word sheet",
  );
  await delay(250); // Capture a real MediaRecorder chunk from the synthetic test microphone.
  await page.getByRole("button", { name: "说完了", exact: true }).click();
  await page.getByRole("button", { name: "我的", exact: true }).waitFor();
  await page.getByRole("button", { name: /^查看单词 shelter/ }).click();
  await sheet.press("Space");
  assert.ok(
    await page.locator(".shadow-card.phase-compare").count(),
    "sheet shortcut must not advance the sentence",
  );
  await sheet.getByLabel("查找词库原形").fill("xylophonicvillagenotfound");
  await sheet.getByText(/现有词库尚未匹配/).waitFor();
  assert.equal(
    await sheet
      .getByRole("button", { name: "不认识，加入优先学习", exact: true })
      .count(),
    0,
  );
  await sheet.getByRole("button", { name: "继续跟读", exact: true }).click();
  await page.getByRole("button", { name: "结束跟读", exact: true }).click();
  await eventually(
    async () =>
      /1/.test(
        await page
          .locator(".shadow-stats > div")
          .filter({ hasText: "声音日记" })
          .innerText(),
      ),
    "recording remains in the local diary",
  );
  checks.push(
    "听/跟/说/比原流程保留；隐藏原文时不泄题；录音时禁用点词，合成麦克风录音与本机声音日记保留；弹窗空格不误推进；未收录明确提示",
  );

  await page.goto(origin + "/#/");
  const pool = page.getByRole("region", { name: "优先待学", exact: true });
  assert.match(await pool.innerText(), /新词 1 个 · 需要再学 1 个/);
  await page.getByRole("button", { name: "学习待学词", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "学习待学词", exact: true });
  await picker.getByRole("spinbutton", { name: /本轮待学数量/ }).fill("2");
  await picker
    .getByRole("button", { name: "开始学习待学词", exact: true })
    .click();
  await page.getByRole("button", { name: /^查看释义/ }).waitFor();
  await eventually(
    async () => (await progress(page)).session.steps.length === 4,
    "priority words join the preserved round",
  );
  const combined = (await progress(page)).session;
  assert.equal(combined.id, unfinished.id);
  assert.equal(combined.index, unfinished.index);
  assert.deepEqual(combined.steps[0], unfinished.steps[0]);
  assert.deepEqual(
    combined.steps.slice(1).map((step) => step.id),
    [shelter, hut, colour],
  );
  assert.equal((await preferences(page)).dailyNew, 0);
  await eventually(
    async () =>
      (
        await (
          await context.request.get(`${origin}/api/sync/${dataset}`)
        ).json()
      ).snapshot?.progress?.queue?.includes(`review:${hut}`),
    "SQLite stores review marker",
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
    async () => (await progress(phone))?.queue?.includes(`review:${hut}`),
    "phone receives both queue forms",
  );
  await width(phone, 390);
  await phone.getByRole("button", { name: "学习待学词", exact: true }).click();
  await width(phone, 390);
  await phone
    .getByRole("button", { name: "开始学习待学词", exact: true })
    .click();
  await phone.getByRole("button", { name: /^查看释义/ }).waitFor();
  assert.match(await phone.locator(".stage-label").innerText(), /优先复习/);
  assert.equal(
    await phone.locator(".memory-question .headword").innerText(),
    "hut",
  );
  checks.push(
    "每日额度0仍可自选学习待学词；原轮次当前题保留、优先词接在后面；SQLite与另一设备同步；未来90天的已学词能立即进入优先复习",
  );

  for (const expectedWord of ["environment", "shelter", "hut"]) {
    assert.equal(
      await page.locator(".memory-question .headword").innerText(),
      expectedWord,
    );
    await page.getByRole("button", { name: /^查看释义/ }).click();
    await page
      .getByRole("button", {
        name: expectedWord === "hut" ? "不认识" : "认识",
        exact: true,
      })
      .click();
  }
  await eventually(
    async () => (await progress(page)).queue.length === 0,
    "actual recall consumes priority entries",
  );
  const after = await progress(page);
  assert.deepEqual(after.skills, fixture.skills);
  assert.equal(after.cards[hut].seen, card.seen);
  assert.equal(after.cards[hut].lapses, card.lapses + 1);
  assert.ok(after.cards[hut].due < card.due);
  await eventually(
    async () =>
      (
        await (
          await context.request.get(`${origin}/api/sync/${dataset}`)
        ).json()
      ).snapshot?.progress?.queue?.length === 0,
    "consumption persisted",
  );
  await phone.reload();
  await eventually(
    async () => (await progress(phone)).queue.length === 0,
    "another device does not resurrect consumed words",
  );
  checks.push(
    "实际学习后移出待学池并进入FSRS复习；保留原seen与听写/产出，另一设备不复活已消费项",
  );

  for (const theme of ["light", "dark"]) {
    const visualContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: "Asia/Shanghai",
    });
    await seed(visualContext, fixture, { theme });
    const visual = await visualContext.newPage();
    observe(visual);
    for (const widthPx of [320, 390, 768, 1280]) {
      await visual.setViewportSize({
        width: widthPx,
        height: widthPx < 500 ? 844 : 900,
      });
      if (visual.url() === origin + "/#/shadow?go=1") await visual.reload();
      else await visual.goto(origin + "/#/shadow?go=1");
      await visual.getByRole("button", { name: /^查看单词 huts/ }).waitFor();
      await visual
        .locator(".learn-stage")
        .evaluate((element) =>
          Promise.all(
            element
              .getAnimations()
              .map((animation) => animation.finished.catch(() => {})),
          ),
        );
      await width(visual, widthPx);
      await visual.getByRole("button", { name: /^查看单词 huts/ }).click();
      const dialog = visual.getByRole("dialog", {
        name: "跟读生词",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "不认识，加入优先学习", exact: true })
        .waitFor();
      await width(visual, widthPx);
      const box = await dialog.boundingBox();
      assert.ok(
        box && box.x >= 0 && box.y >= 0 && box.x + box.width <= widthPx + 1,
      );
      const button = dialog.getByRole("button", {
        name: "不认识，加入优先学习",
        exact: true,
      });
      await button.scrollIntoViewIfNeeded();
      assert.equal(
        await button.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return (
            document
              .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
              ?.closest("button") === element
          );
        }),
        true,
      );
      if (widthPx === 390) {
        await fs.mkdir(path.join(root, "local-content"), { recursive: true });
        await visual.screenshot({
          path: path.join(root, `local-content/shadow-vocabulary-${theme}.png`),
        });
      }
    }
    await visualContext.close();
  }
  checks.push(
    "320/390/768/1280px与深浅主题：原文点词、弹窗尺寸、添加按钮点击区域无覆盖或横向溢出",
  );
  assert.deepEqual(pageErrors, []);
  success = true;
} catch (error) {
  console.error(error.stack || error);
  for (const page of browser
    ?.contexts()
    .flatMap((context) => context.pages()) ?? [])
    console.error(
      page.url(),
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      ).slice(0, 1800),
    );
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
