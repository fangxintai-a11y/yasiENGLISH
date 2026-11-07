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
const origin = "http://127.0.0.1:16688",
  api = "http://127.0.0.1:16689";
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "band-assessment-e2e-"),
);
const processes = [],
  logs = [],
  checks = [],
  pageErrors = [];
const username = "assessment_fixture",
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
  dailyNew: 4,
  dailyMinutes: 15,
  theme: "light",
  examDate: "",
  shadowAsr: "off",
  guessFirst: true,
  sentenceFirst: false,
  trackL: true,
  trackP: true,
};
async function seed(context, fixture, overrides = {}) {
  await context.addInitScript(
    ({ settings, fixture, storageKey }) => {
      if (localStorage.getItem("assessment-fixture-ready")) return;
      localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
      if (fixture) localStorage.setItem(storageKey, JSON.stringify(fixture));
      localStorage.setItem("assessment-fixture-ready", "1");
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
  const overflow =
    sizes.scroll > expected
      ? await page.evaluate(() =>
          Array.from(
            document.querySelectorAll(
              ".atlas-head,.search,.search input,.filters,.filters-row,.segmented,.vocabulary-overview",
            ),
          ).map((element) => ({
            tag: element.tagName,
            class: element.className,
            width: element.getBoundingClientRect().width,
            right: element.getBoundingClientRect().right,
          })),
        )
      : [];
  assert.ok(sizes.scroll <= expected, JSON.stringify({ ...sizes, overflow }));
}

try {
  launch(
    "python3",
    [
      "server/app.py",
      "--host",
      "127.0.0.1",
      "--port",
      "16689",
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
      "16688",
      "--strictPort",
    ],
    { BAND_API_TARGET: api },
  );
  await eventually(
    async () => (await fetch(origin + "/api/health")).ok,
    "isolated services",
  );
  const index = JSON.parse(
    await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"),
  );
  const supplement = JSON.parse(
    await fs.readFile(path.join(root, "public/atlas/supplement.json"), "utf8"),
  );
  assert.ok(supplement.entries.length > 2500);
  const assessed = index.words.slice(0, 5),
    known = assessed[0],
    unknown = assessed.slice(1);
  const extra = supplement.entries.find((entry) => entry.w === "induce");
  assert.ok(extra && extra.m === 0);
  const stamp = Date.now();
  const oldCard = {
    due: stamp + 90 * 86400000,
    s: 25,
    d: 4,
    el: 0,
    sd: 90,
    ls: 0,
    reps: 1,
    lapses: 0,
    st: 2,
    last: stamp - 86400000,
    seen: stamp - 86400000,
    src: 1,
  };
  const fixture = {
    version: 2,
    datasetId: dataset,
    cards: { hut: oldCard },
    skills: {},
    bookmarks: [],
    days: {},
    typing: [],
    session: null,
    mistakes: [],
    spell: {},
    spellLog: [],
    placement: null,
    queue: [],
    readings: [],
    shadow: { days: {}, done: {}, best: 0 },
    hacks: {},
    flashBest: 0,
  };
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
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
  await page.goto(origin + "/#/assessment");
  await page
    .getByRole("heading", { name: "先把不会的，找出来。", exact: true })
    .waitFor();
  await page.getByRole("spinbutton", { name: /本批摸底数量/ }).fill("5");
  await page.getByRole("button", { name: "开始本批摸底", exact: true }).click();
  for (let i = 0; i < assessed.length; i++) {
    const question = page.getByRole("region", {
      name: "当前摸底词",
      exact: true,
    });
    assert.equal(
      await question.locator(".headword").innerText(),
      assessed[i][1],
    );
    assert.equal(
      await question
        .getByRole("region", { name: "摸底答案", exact: true })
        .count(),
      0,
    );
    await page.keyboard.press(i === 0 ? "1" : "2");
    await question
      .getByRole("region", { name: "摸底答案", exact: true })
      .waitFor();
    await page.keyboard.press("Space");
  }
  await page.getByText(/本批 5 词已保存/).waitFor();
  await eventually(
    async () =>
      Object.keys((await progress(page)).assessment?.marks ?? {}).length === 5,
    "all survey marks flushed to local storage",
  );
  const surveyed = await progress(page);
  assert.equal(Object.keys(surveyed.assessment.marks).length, 5);
  assert.equal(surveyed.assessment.marks[known[0]].state, "known");
  assert.deepEqual(
    surveyed.cards,
    fixture.cards,
    "survey must not seed or alter FSRS",
  );
  assert.deepEqual(surveyed.days, {});
  await page.reload();
  await page
    .getByRole("button", { name: "开始本批摸底", exact: true })
    .waitFor();
  assert.equal(Object.keys((await progress(page)).assessment.marks).length, 5);
  checks.push(
    "全词库分批逐词摸底：答案先隐藏、键盘标记、即时保存、刷新续测；认识不伪造掌握，不认识不重置历史卡",
  );

  await page.goto(origin + "/#/atlas?q=induce");
  await page
    .getByRole("button")
    .filter({ has: page.locator(".tile-word", { hasText: /^induce$/ }) })
    .click();
  const entry = page.getByRole("dialog", { name: "induce 词条", exact: true });
  await entry
    .getByRole("region", { name: "本词摸底标记", exact: true })
    .waitFor();
  assert.ok(
    await entry.locator(".plate").count(),
    "text-only supplement stays usable without an illustration",
  );
  await entry
    .getByRole("button", { name: "不认识／不确定", exact: true })
    .click();
  await entry.getByRole("button", { name: "关闭", exact: true }).click();
  await page.goto(origin + "/#/spelling");
  await page
    .getByRole("button", { name: "重点词：不会且已开始学习", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: /^开始拼写/ }).isDisabled(),
    true,
    "unlearned unknown words do not enter spelling prematurely",
  );
  checks.push(
    "补齐雅思来源缺词，缺图仍有真实词条、释义和标记；未开始学习的不会词暂不进入拼写",
  );

  await page.goto(origin + "/#/");
  await page
    .getByRole("button", { name: "开始今天的旅程", exact: true })
    .click();
  const learned = [];
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: /^查看释义/ }).waitFor();
    const word = await page.locator(".memory-question .headword").innerText();
    assert.ok(
      unknown.some((row) => row[1] === word),
      `learning picked outside unknown core words: ${word}`,
    );
    learned.push(word);
    await page.getByRole("button", { name: /^查看释义/ }).click();
    await page.getByRole("button", { name: "认识", exact: true }).click();
  }
  assert.equal(new Set(learned).size, 4);
  assert.deepEqual((await progress(page)).cards.hut, oldCard);
  await page.goto(origin + "/#/spelling");
  await page
    .getByRole("button", { name: "重点词：不会且已开始学习", exact: true })
    .waitFor();
  await page.getByRole("spinbutton").fill("2");
  const spellingSequence = unknown
    .map((row) => row[0])
    .sort((a, b) => a.localeCompare(b));
  const wordForId = (id) => index.words.find((row) => row[0] === id)[1];
  for (let round = 0; round < 2; round++) {
    await page
      .getByRole("button", { name: "开始拼写 2 词", exact: true })
      .click();
    for (const id of spellingSequence.slice(round * 2, round * 2 + 2)) {
      const input = page.locator(".recall-input");
      await input.waitFor();
      await input.fill(wordForId(id));
      await eventually(
        async () => !!(await progress(page)).skills[`p:${id}`],
        "focused spelling recorded first answer",
      );
    }
    await page.getByText(/首答正确 2/).waitFor();
    await page.getByRole("button", { name: "选下一轮", exact: true }).click();
  }
  const drilled = await progress(page);
  assert.equal(Object.keys(drilled.skills).length, 4);
  assert.equal(
    Object.values(drilled.days).reduce((n, day) => n + (day.sp || 0), 0),
    4,
  );
  assert.equal(
    Object.values(drilled.days).reduce((n, day) => n + (day.sc || 0), 0),
    4,
  );
  assert.equal(drilled.cards[extra.id], undefined);
  checks.push(
    "学习只覆盖不会词；重点拼写须先学再练、无英文答案；连续两轮轮换覆盖4个不同词，正确首答写入对应记忆轨与统计",
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
  await phone.goto(origin + "/#/assessment");
  await eventually(
    async () =>
      Object.keys((await progress(phone))?.assessment?.marks ?? {}).length ===
      6,
    "phone receives survey",
  );
  await phoneContext.route("**/api/sync/**", (route) => route.abort());
  await phone.getByRole("spinbutton", { name: /本批摸底数量/ }).fill("1");
  await phone
    .getByRole("button", { name: "开始本批摸底", exact: true })
    .click();
  const offlineWord = index.words[5];
  assert.equal(
    await phone.locator(".assessment-question .headword").innerText(),
    offlineWord[1],
  );
  await phone.getByRole("button", { name: /^不认识／不确定/ }).click();
  await phone.getByRole("button", { name: /^下一个/ }).click();
  await eventually(
    async () =>
      (await progress(phone)).assessment?.marks?.[offlineWord[0]]?.state ===
      "unknown",
    "offline survey mark persisted locally",
  );
  assert.equal(
    (await progress(phone)).assessment.marks[offlineWord[0]].state,
    "unknown",
  );
  const desktopWord = index.words[6];
  await page.goto(origin + "/#/atlas?w=" + desktopWord[0]);
  const detail = page.getByRole("region", {
    name: "本词摸底标记",
    exact: true,
  });
  await detail.getByRole("button", { name: "认识", exact: true }).click();
  await eventually(
    async () =>
      (
        await (
          await context.request.get(`${origin}/api/sync/${dataset}`)
        ).json()
      ).snapshot?.progress?.assessment?.marks?.[desktopWord[0]],
    "desktop mark saved",
  );
  await phoneContext.unroute("**/api/sync/**");
  await phone.evaluate(() => window.dispatchEvent(new Event("online")));
  await eventually(async () => {
    const value = (
      await (await context.request.get(`${origin}/api/sync/${dataset}`)).json()
    ).snapshot?.progress;
    return (
      value?.assessment?.marks?.[offlineWord[0]]?.state === "unknown" &&
      value?.assessment?.marks?.[desktopWord[0]]?.state === "known"
    );
  }, "offline and online marks converge");
  await phone.reload();
  await eventually(
    async () =>
      Object.keys((await progress(phone))?.assessment?.marks ?? {}).length ===
      8,
    "restart preserves merged assessment",
  );
  assert.deepEqual((await progress(phone)).cards.hut, oldCard);
  checks.push(
    "真实账号SQLite与第二设备同步；离线标记和另一设备在线标记合并，刷新后保留；旧FSRS卡不变",
  );

  for (const theme of ["light", "dark"]) {
    const visualContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: "Asia/Shanghai",
    });
    await seed(visualContext, fixture, { theme });
    const visual = await visualContext.newPage();
    observe(visual);
    for (const w of [320, 390, 768, 1280]) {
      await visual.setViewportSize({ width: w, height: 844 });
      await visual.goto(origin + "/#/assessment");
      await visual
        .getByRole("button", { name: "开始本批摸底", exact: true })
        .waitFor();
      await width(visual, w);
      await visual
        .getByRole("button", { name: "开始本批摸底", exact: true })
        .click();
      const mark = visual.getByRole("button", { name: /^不认识／不确定/ });
      await mark.scrollIntoViewIfNeeded();
      assert.equal(
        await mark.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return (
            document
              .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
              ?.closest("button") === element
          );
        }),
        true,
      );
      await mark.click();
      await width(visual, w);
      if (w === 390) {
        await fs.mkdir(path.join(root, "local-content"), { recursive: true });
        await visual.screenshot({
          path: path.join(root, `local-content/assessment-${theme}.png`),
        });
      }
      await visual.goto(origin + "/#/atlas?q=induce");
      await visual
        .locator(".tile-word")
        .filter({ hasText: /^induce$/ })
        .waitFor();
      await width(visual, w);
      if (w === 320) {
        const wideFont = await visual.addStyleTag({
          content: ".search input { font-family: monospace; font-size: 18px; }",
        });
        await width(visual, w);
        await wideFont.evaluate((element) => element.remove());
      }
    }
    await visualContext.close();
  }
  checks.push(
    "320/390/768/1280px、深浅主题：摸底、揭晓、缺图图鉴无横向溢出，按钮实际命中无导航遮挡",
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
