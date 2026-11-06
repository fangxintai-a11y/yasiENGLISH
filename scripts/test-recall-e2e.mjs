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
const origin = "http://127.0.0.1:16488",
  api = "http://127.0.0.1:16489";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "band-recall-e2e-"));
const processes = [],
  logs = [],
  checks = [],
  pageErrors = [];
const username = "recall_fixture",
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
  guessFirst: true,
  sentenceFirst: false,
  trackL: false,
  trackP: false,
};
async function seed(context, fixture, overrides = {}) {
  await context.addInitScript(
    ({ settings, fixture, storageKey }) => {
      if (localStorage.getItem("recall-fixture-ready")) return;
      localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
      if (fixture) localStorage.setItem(storageKey, JSON.stringify(fixture));
      localStorage.setItem("recall-fixture-ready", "1");
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

async function controlsFit(page, enabled) {
  const issues = await page.locator(".memory-grade").evaluateAll((buttons) =>
    buttons.flatMap((button) => {
      const box = button.getBoundingClientRect();
      const children = [...button.children].map((element) => ({
        text: element.textContent,
        rect: element.getBoundingClientRect(),
      }));
      return children
        .filter(
          ({ rect }) =>
            rect.top < box.top - 1 ||
            rect.bottom > box.bottom + 1 ||
            rect.left < box.left - 1 ||
            rect.right > box.right + 1,
        )
        .map(
          ({ text }) =>
            `button ${button.getAttribute("aria-label")}: overflowing ${text}`,
        );
    }),
  );
  const overlaps = await page.evaluate(() => {
    const content = document
      .querySelector(".memory-question,.memory-answer")
      ?.getBoundingClientRect();
    const controls = document
      .querySelector(".memory-reveal,.memory-rating-help")
      ?.getBoundingClientRect();
    const footer = document
      .querySelector(".memory-ratings")
      ?.getBoundingClientRect();
    return {
      contentOverlapsControls:
        content && controls ? content.bottom > controls.top + 1 : true,
      footerOutsideViewport: footer ? footer.bottom > innerHeight + 1 : true,
    };
  });
  assert.deepEqual(
    overlaps,
    { contentOverlapsControls: false, footerOutsideViewport: false },
    "content and controls need separate visible areas",
  );
  assert.deepEqual(
    issues,
    [],
    "every label, interval and hint must stay inside its button",
  );
  const audioControl = page.locator(".memory-question > .speak");
  const audio = (await audioControl.count())
    ? await audioControl.boundingBox()
    : null;
  if (audio)
    assert.ok(
      audio.height >= 40 && audio.height <= 48,
      `audio button stretched: ${audio.height}`,
    );
  if (enabled)
    for (const name of ["认识", "不认识", "不太记得"]) {
      const button = page.getByRole("button", { name, exact: true });
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
        `${name} must not be covered`,
      );
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
      "16489",
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
      "16488",
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
  const rows = ["accommodation", "environment"].map((word) =>
    index.words.find((row) => row[1] === word),
  );
  assert.ok(rows.every(Boolean));
  const [id, second] = rows.map((row) => row[0]);
  const now = Date.now();
  const skill = {
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
    cards: {},
    skills: { [`l:${id}`]: skill, [`p:${id}`]: skill },
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
    session: {
      id: "legacy-unfinished-recall",
      started: now,
      steps: [
        { id, kind: "intro" },
        { id: second, kind: "intro" },
        { id, kind: "meaning", options: [id, second] },
      ],
      index: 0,
      graded: {},
      newIds: [id, second],
      reviewIds: [],
    },
  };
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const hut = index.words.find((row) => row[1] === "hut");
  assert.ok(hut);
  for (const theme of ["light", "dark"]) {
    const visualContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: "Asia/Shanghai",
    });
    await seed(
      visualContext,
      {
        ...fixture,
        session: {
          ...fixture.session,
          steps: [{ id: hut[0], kind: "intro" }],
          newIds: [hut[0]],
        },
      },
      { theme, sentenceFirst: true },
    );
    const visual = await visualContext.newPage();
    observe(visual);
    for (const [widthPx, height] of [
      [320, 568],
      [390, 844],
      [768, 900],
      [1280, 900],
    ]) {
      await visual.setViewportSize({ width: widthPx, height });
      if (visual.url() === origin + "/#/learn") await visual.reload();
      else await visual.goto(origin + "/#/learn");
      await visual.getByRole("button", { name: /^查看释义/ }).waitFor();
      await visual.locator(".learn-stage").evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      await width(visual, widthPx);
      await controlsFit(visual, false);
      if (widthPx === 390)
        await visual.screenshot({
          path: path.join(root, `local-content/recognition-front-${theme}.png`),
        });
      await visual.getByRole("button", { name: /^查看释义/ }).click();
      await width(visual, widthPx);
      await controlsFit(visual, true);
      if (widthPx === 390 || widthPx === 1280)
        await visual.screenshot({
          path: path.join(
            root,
            `local-content/recognition-answer-${theme}-${widthPx}.png`,
          ),
        });
    }
    await visualContext.close();
  }
  checks.push(
    "样式矩阵：320/390/768/1280px、浅色/深色、长例句、揭晓前后；三档所有文字均在按钮内，发音控件44px，评级按钮无覆盖且可点击",
  );
  const intervals = {};
  let main, mainContext;
  for (const [grade, label, widthPx] of [
    [3, "认识", 1280],
    [1, "不认识", 390],
    [2, "不太记得", 390],
  ]) {
    const context = await browser.newContext({
      viewport: { width: widthPx, height: 844 },
      isMobile: widthPx === 390,
      hasTouch: widthPx === 390,
      timezoneId: "Asia/Shanghai",
    });
    if (grade === 1) {
      assert.equal(
        (
          await context.request.post(origin + "/api/auth/register", {
            data: { username, password, setupToken },
            headers: { Origin: origin },
          })
        ).status(),
        201,
      );
      mainContext = context;
    }
    await seed(context, fixture);
    const page = await context.newPage();
    observe(page);
    await page.clock.install({ time: new Date(now) });
    await page.goto(origin + "/#/learn");
    await page.getByRole("button", { name: /^查看释义/ }).waitFor();
    assert.equal(
      await page.locator(".memory-question .headword").innerText(),
      rows[0][1],
    );
    assert.equal(
      await page.locator(".senses, .ex-zh, .memory-answer").count(),
      0,
      "no answer in the prompt DOM before recall",
    );
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /我早就会了|想好了，看答案|看完了，下一个/,
    );
    for (const choice of ["认识", "不认识", "不太记得"])
      assert.equal(
        await page
          .getByRole("button", { name: choice, exact: true })
          .isEnabled(),
        false,
      );
    await width(page, widthPx);
    await controlsFit(page, false);
    await page.getByRole("button", { name: /^查看释义/ }).click();
    await page.locator(".memory-answer .senses").waitFor();
    const choice = page.getByRole("button", { name: label, exact: true });
    const expectedMinutes = { 1: 1, 2: 6, 3: 10 }[grade];
    assert.match(
      await choice.innerText(),
      new RegExp(`约${expectedMinutes}分后`),
    );
    assert.match(
      await page.locator(".memory-rating-help").innerText(),
      /看答案才想起，请选“不认识”/,
    );
    await width(page, widthPx);
    await controlsFit(page, true);
    if (grade === 1) {
      await fs.mkdir(path.join(root, "local-content"), { recursive: true });
      await page.screenshot({
        path: path.join(root, "local-content/recognition-ratings-mobile.png"),
      });
    }
    await choice.click();
    await eventually(
      async () => (await progress(page)).cards[id]?.reps === 1,
      "real FSRS card persisted",
    );
    const after = await progress(page);
    intervals[grade] = after.cards[id].due - after.cards[id].last;
    assert.equal(intervals[grade], expectedMinutes * 60000);
    assert.equal(after.session.graded[id], grade);
    assert.equal(after.cards[id].src, undefined);
    assert.equal(
      after.days[day(0)].n,
      1,
      "even a known new word uses one chosen daily slot",
    );
    assert.deepEqual(
      after.skills,
      fixture.skills,
      "recognition never grades listening/production",
    );
    assert.equal(
      after.session.steps.filter((step) => step.id === id && !step.retry)
        .length,
      1,
      "legacy duplicate objective question is removed only after rating this word",
    );
    await eventually(
      async () =>
        (await page.locator(".memory-question .headword").innerText()) ===
        rows[1][1],
      "next word",
    );
    assert.equal(
      await page.getByRole("button", { name: "认识", exact: true }).isEnabled(),
      false,
      "a held/extra Enter cannot select Good on the next question",
    );
    if (grade === 1) main = page;
    else await context.close();
  }
  assert.ok(intervals[1] < intervals[2] && intervals[2] < intervals[3]);
  checks.push(
    "三个按钮移除旧操作；先主动回忆再揭晓；实际FSRS分别为1/6/10分钟初学步；认识计入每日数量；旧轮次不清空；390/1280px无溢出；听写和产出曲线不变",
  );

  // Let the failed first word become due while the learner is on another word.
  await main.clock.fastForward(61000);
  assert.equal(
    await main.locator(".memory-question .headword").innerText(),
    rows[1][1],
    "no mid-question interruption",
  );
  await main.getByRole("button", { name: /^查看释义/ }).click();
  await main.getByRole("button", { name: "认识", exact: true }).click();
  await eventually(
    async () =>
      (await main.locator(".memory-question .headword").innerText()) ===
      rows[0][1],
    "due first word returns at the boundary",
  );
  assert.match(await main.locator(".stage-label").innerText(), /到期复习/);
  await main.getByRole("button", { name: /^查看释义/ }).click();
  await main.getByRole("button", { name: "不太记得", exact: true }).click();
  await main.getByRole("button", { name: "完成", exact: true }).waitFor();
  await eventually(
    async () => (await progress(main)).cards[id]?.reps === 2,
    "due rating updates FSRS again",
  );
  const repeated = await progress(main);
  assert.equal(
    repeated.session.graded[id],
    1,
    "first miss remains in round history",
  );
  assert.equal(repeated.days[day(0)].n, 2, "a due repeat is not a new word");
  assert.equal(repeated.days[day(0)].r, 3);
  assert.equal(repeated.cards[id].due - repeated.cards[id].last, 6 * 60000);
  await main.getByRole("button", { name: "完成", exact: true }).click();
  await main
    .getByRole("button", { name: "调整每日数量", exact: true })
    .waitFor();
  assert.equal(
    await main
      .getByRole("button", { name: "开始今天的旅程", exact: true })
      .count(),
    0,
  );
  await main.clock.fastForward(6 * 60000 + 2000);
  await main
    .getByRole("button", { name: "开始今天的旅程", exact: true })
    .waitFor();
  assert.match(await main.locator(".journey").innerText(), /复习/);
  await main
    .getByRole("button", { name: "开始今天的旅程", exact: true })
    .click();
  await main.getByRole("button", { name: /^查看释义/ }).waitFor();
  assert.equal(
    await main.locator(".memory-question .headword").innerText(),
    rows[0][1],
  );
  checks.push(
    "模拟时间到期：不打断正在作答；切词时重新入队；重复评分更新FSRS且不重复计新词；首页无需刷新自动出现到期复习",
  );

  await eventually(
    async () =>
      (
        await (
          await mainContext.request.get(`${origin}/api/sync/${dataset}`)
        ).json()
      ).snapshot?.progress?.cards?.[id]?.reps === 2,
    "real SQLite receives the complete card",
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
    async () => (await progress(phone))?.cards?.[id]?.reps === 2,
    "second device receives recall history",
  );
  assert.deepEqual((await progress(phone)).cards[id], repeated.cards[id]);
  assert.deepEqual((await progress(phone)).skills, fixture.skills);
  checks.push(
    "SQLite和第二设备保留完整FSRS状态及原听写/产出状态，没有新增同步协议或清理数据",
  );
  assert.deepEqual(pageErrors, []);
  success = true;
} catch (error) {
  console.error(error.stack || error);
  for (const [i, page] of (
    browser?.contexts().flatMap((context) => context.pages()) ?? []
  ).entries()) {
    console.error(`page ${i}: ${page.url()}`);
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      ).slice(0, 3000),
    );
    await page
      .screenshot({
        path: path.join(temporary, `failure-${i}.png`),
        timeout: 3000,
      })
      .catch(() => {});
  }
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
