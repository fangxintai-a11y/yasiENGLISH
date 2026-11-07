#!/usr/bin/env node
// Built frontend, actual vocabulary API, disposable accounts/SQLite/browser contexts only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  await page.getByRole("checkbox", { name: /自动核对/ }).uncheck();
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
  const input = page.getByRole("textbox", {
    name: "输入英文单词",
    exact: true,
  });
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
  await phone.getByRole("checkbox", { name: /自动核对/ }).uncheck();
  await phone.getByLabel("本轮数量").fill("1");
  await phone.getByRole("button", { name: "开始拼写 1 词" }).click();
  const phoneInput = phone.getByRole("textbox", {
    name: "输入英文单词",
    exact: true,
  });
  await phoneInput.waitFor();
  await width(phone, 390);
  await phone.setViewportSize({ width: 390, height: 420 });
  await phoneInput.fill("accom");
  await eventually(async () => {
    const bounds = await phoneInput.boundingBox();
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
  // Answer feedback stays put, including the last word; the result page requires explicit continuation.
  assert.equal(await page.locator(".spelling-word-info .spelling-senses").count(), 1);
  assert.ok((await page.locator(".spelling-word-info").innerText()).length > 10);
  await delay(1100);
  assert.match(await page.locator(".spelling-round .eyebrow").innerText(), /第 1 \/ 1/);
  const feedbackNext = page.getByRole("button", { name: "查看本轮结果" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    for (const pixels of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width: pixels, height: 844 });
      await width(page, pixels);
      await feedbackNext.scrollIntoViewIfNeeded();
      const hit = await feedbackNext.evaluate((button) => {
        const r = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      assert.equal(hit, true, `feedback continue unobstructed: ${pixels}/${theme}`);
      if (pixels === 390) {
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
        await fs.mkdir(path.join(root, "local-content"), { recursive: true });
        await page.screenshot({ path: path.join(root, `local-content/spelling-feedback-${theme}.png`), fullPage: true });
      }
    }
  }
  checks.push("正确的最后一词也保留词条反馈；320/390/768/1280px深浅主题不溢出，继续按钮真实命中且无导航遮挡");
  // Real multi-item flow: native input stays mounted, no target glyphs/length clues,
  // committed IME text and rapid Enter events can never grade the same item twice.
  const rows = ["accommodation", "environment", "colour"].map((word) => {
    const row = index.words.find((item) => item[1] === word);
    assert.ok(row, word);
    return row;
  });
  const entries = await Promise.all(
    rows.map(async (row) => {
      const order = index.words.findIndex((item) => item[0] === row[0]);
      const chunk = JSON.parse(
        await fs.readFile(
          path.join(
            root,
            `public/atlas/entries/${Math.floor(order / index.chunk)}.json`,
          ),
          "utf8",
        ),
      );
      return chunk.find((entry) => entry.id === row[0]);
    }),
  );
  assert.ok(entries.every(Boolean));
  const flowContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await seed(flowContext, { ...fixture, bookmarks: rows.map((row) => row[0]) });
  const flow = await flowContext.newPage();
  observe(flow);
  // Observe only; the preload path must never call play() for a future answer.
  await flow.addInitScript(() => {
    window.audioPlays = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.audioPlays.push(this.src);
      return play.call(this);
    };
  });
  await flow.goto(origin + "/#/spelling");
  await flow.getByRole("button", { name: "收藏", exact: true }).click();
  await flow.getByLabel("本轮数量").fill("3");
  assert.equal(
    await flow.getByRole("checkbox", { name: /自动核对/ }).isChecked(),
    true,
  );
  const mediaRequests = [];
  flow.on("request", (request) => {
    if (/audio\/word-uk\//.test(request.url()))
      mediaRequests.push(request.url());
  });
  await flow.getByRole("button", { name: "开始拼写 3 词" }).click();
  const flowInput = flow.getByRole("textbox", {
    name: "输入英文单词",
    exact: true,
  });
  await flowInput.waitFor();
  const nativeInput = await flowInput.elementHandle();
  const firstFlowProgress = await localProgress(flow);
  const currentEntry = async (selector = ".spelling-round .spell-zh") => {
    const clue = await flow.locator(selector).innerText();
    const entry = entries.find((candidate) =>
      clue.includes(
        selector === ".typing-zh" ? candidate.ex[0].zh : candidate.senses[0].zh,
      ),
    );
    assert.ok(entry, `fixture clue: ${clue}`);
    return entry;
  };
  const hidden = async (page, area) => {
    const text = await page.locator(area).textContent();
    for (const entry of entries)
      assert.ok(
        !text.toLowerCase().includes(entry.w.toLowerCase()),
        `hidden target ${entry.w}`,
      );
    assert.equal(
      await page
        .locator(
          `${area} .slots, ${area} .slot, ${area} .typing-text, ${area} [lang="en"]:not(input)`,
        )
        .count(),
      0,
    );
    const field = page.locator(`${area} .recall-input`);
    assert.equal(await field.getAttribute("maxlength"), null);
    assert.doesNotMatch(await field.getAttribute("aria-label"), /\d/);
    assert.equal(await field.inputValue(), "");
  };
  const first = await currentEntry();
  await hidden(flow, ".spelling-round");
  await eventually(
    () => Promise.resolve(mediaRequests.length >= 2),
    "next two audio requests",
  );
  assert.deepEqual(
    await flow.evaluate(() => window.audioPlays),
    [],
    "preload must not play",
  );
  await flowInput.press("Control+j");
  await eventually(
    async () => (await flow.evaluate(() => window.audioPlays)).length === 1,
    "scoped replay shortcut",
  );
  await flowInput.press("Escape");
  assert.equal(
    await flowInput.evaluate((input) => document.activeElement === input),
    false,
  );
  await flowInput.click();
  const paste = await flowInput.evaluate((input) => {
    const event = new ClipboardEvent("paste", {
      cancelable: true,
      bubbles: true,
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(paste, true);
  assert.match(await flow.locator(".recall-input-help").innerText(), /不粘贴/);
  // Composition updates may contain the entire correct answer. They must not submit it.
  await flowInput.dispatchEvent("compositionstart");
  await flowInput.fill(first.w);
  assert.match(
    await flow.locator(".spelling-round .eyebrow").innerText(),
    /第 1 \/ 3/,
  );
  await flowInput.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    bubbles: true,
  });
  assert.equal(await flow.locator(".spelling-feedback").count(), 0);
  await flowInput.dispatchEvent("compositionend");
  await flow.getByRole("heading", { name: "拼写正确", exact: true }).waitFor();
  assert.equal(await flow.locator(".spelling-answer").innerText(), first.w);
  assert.ok((await flow.locator(".spelling-senses").innerText()).includes(first.senses[0].zh));
  assert.equal(await flow.locator(".spelling-example [lang=en]").innerText(), first.ex[0].en);
  assert.ok((await flow.locator(".spelling-example").innerText()).includes(first.ex[0].zh));
  assert.ok((await flow.locator(".spelling-phonetics").innerText()).includes(first.uk));
  await delay(1100);
  assert.match(await flow.locator(".spelling-round .eyebrow").innerText(), /第 1 \/ 3/);
  await flowInput.press("Enter");
  await eventually(
    async () =>
      /第 2 \/ 3/.test(
        await flow.locator(".spelling-round .eyebrow").innerText(),
      ),
    "committed answer shows full feedback and advances only on Enter",
  );
  assert.equal(
    await nativeInput.evaluate(
      (input) =>
        input === document.querySelector(".recall-input") &&
        input === document.activeElement,
    ),
    true,
  );
  await hidden(flow, ".spelling-round");
  const second = await currentEntry();
  // Wrong prefixes remain neutral and editable, with no answer feedback or live accuracy oracle.
  await flowInput.pressSequentially("xx");
  assert.equal(await flowInput.inputValue(), "xx");
  assert.equal(
    await flow.locator(".spelling-feedback, .is-bad, .is-ok").count(),
    0,
  );
  await flowInput.press("Backspace");
  await flowInput.press("Backspace");
  // Choose an unambiguously wrong whole answer, independent of target length.
  await flowInput.pressSequentially("wrongword");
  await flowInput.press("Enter");
  assert.equal(await flow.locator(".spelling-answer").innerText(), second.w);
  assert.equal(
    await flowInput.evaluate((input) => document.activeElement === input),
    true,
  );
  await flowInput.dispatchEvent("keydown", {
    key: "Enter",
    repeat: true,
    bubbles: true,
  });
  assert.match(
    await flow.locator(".spelling-round .eyebrow").innerText(),
    /第 2 \/ 3/,
  );
  await flowInput.press("Enter");
  await eventually(
    async () =>
      /第 3 \/ 3/.test(
        await flow.locator(".spelling-round .eyebrow").innerText(),
      ),
    "wrong answer continues with Enter",
  );
  assert.equal(
    await nativeInput.evaluate(
      (input) =>
        input === document.querySelector(".recall-input") &&
        input === document.activeElement,
    ),
    true,
  );
  await hidden(flow, ".spelling-round");
  await flow.getByRole("button", { name: "暂时想不起，查看答案" }).click();
  await flow.getByRole("button", { name: "查看本轮结果" }).click();
  await flow.getByRole("heading", { name: "首答正确 1 / 3" }).waitFor();
  await eventually(
    async () => (await localProgress(flow)).spellLog.length === 2,
    "first misses persisted",
  );
  const afterFlow = await localProgress(flow);
  assert.equal(
    afterFlow.spellLog.length,
    2,
    "one wrong record per submitted miss, including reveal",
  );
  assert.equal(
    afterFlow.spellLog.filter(
      (miss) => miss.id === second.id && miss.typed === "wrongword",
    ).length,
    1,
  );
  for (const key of [
    "cards",
    "skills",
    "session",
    "days",
    "typing",
    "bookmarks",
  ])
    assert.deepEqual(afterFlow[key], firstFlowProgress[key], key);
  checks.push(
    "自动核对后停留显示音标、词义和中英例句，手动继续；同一输入框与桌面焦点；无英文/字母槽/长度提示；错误前缀不泄题；IME确认后才判分；退格/粘贴/重听/Esc/长按Enter；首错与主动揭晓各只保存一次；两词音频预载不播放",
  );

  // Practice has no copying mode or live character feedback, including sentence dictation.
  await flow.goto(origin + "/#/practice");
  await flow.getByRole("button", { name: "收藏", exact: true }).click();
  await flow.getByRole("button", { name: "开始一轮", exact: true }).click();
  const practiceInput = flow.getByRole("textbox", {
    name: "输入英文单词",
    exact: true,
  });
  await practiceInput.waitFor();
  const stablePracticeInput = await practiceInput.elementHandle();
  for (let item = 0; item < 3; item++) {
    await hidden(flow, ".typing-stage");
    const entry = await currentEntry(".typing-cue");
    if (item === 1) {
      await practiceInput.pressSequentially("xx");
      assert.doesNotMatch(await flow.locator(".typing-top").innerText(), /%/);
      await practiceInput.press("Enter");
      await flow.getByRole("button", { name: "下一项" }).waitFor();
      assert.equal(
        await flow.locator(".typing-recall-feedback b").innerText(),
        entry.w,
      );
      await practiceInput.press("Enter");
    } else {
      const answer = entry.w === "colour" ? "color" : entry.w;
      await practiceInput.pressSequentially(answer);
      await flow.locator(".typing-recall-feedback").waitFor();
      assert.match(await flow.locator(".typing-recall-feedback").innerText(), /拼写正确/);
      assert.ok((await flow.locator(".spelling-senses").innerText()).includes(entry.senses[0].zh));
      await practiceInput.press("Enter");
    }
    if (item < 2)
      assert.equal(
        await stablePracticeInput.evaluate(
          (input) =>
            input === document.querySelector(".recall-input") &&
            input === document.activeElement,
        ),
        true,
      );
  }
  await flow.getByText("首答正确 2 / 3", { exact: false }).waitFor();
  await eventually(
    async () => (await localProgress(flow)).typing.length === 1,
    "completed round persisted",
  );
  const afterPractice = await localProgress(flow);
  assert.equal(
    afterPractice.typing.length,
    1,
    "one completed round, without duplicate completion",
  );
  assert.equal(afterPractice.typing[0].items, 3);
  for (const key of ["cards", "skills", "session", "days", "spellLog"])
    assert.deepEqual(afterPractice[key], afterFlow[key], key);
  await flow.getByRole("button", { name: "返回", exact: true }).click();
  await flow.getByRole("button", { name: "句子默写", exact: false }).click();
  await flow.getByRole("button", { name: "开始一轮", exact: true }).click();
  await hidden(flow, ".typing-stage");
  const sentenceEntry = await currentEntry(".typing-zh");
  const sentenceInput = flow.getByRole("textbox", {
    name: "输入英文句子",
    exact: true,
  });
  await sentenceInput.pressSequentially(sentenceEntry.ex[0].en);
  await flow.locator(".typing-recall-feedback").waitFor();
  assert.equal(await flow.locator(".typing-recall-feedback > b").innerText(), sentenceEntry.ex[0].en);
  assert.match(await flow.locator(".typing-meter").innerText(), /第 1 \/ 3/);
  await sentenceInput.press("Enter");
  await eventually(
    async () =>
      /第 2 \/ 3/.test(await flow.locator(".typing-meter").innerText()),
    "sentence recall reviews its answer before explicit continuation",
  );
  await flow.getByRole("button", { name: "结束", exact: true }).click();
  await flow.getByRole("button", { name: "句子听写", exact: false }).click();
  await flow.getByRole("button", { name: "开始一轮", exact: true }).click();
  await hidden(flow, ".typing-stage");
  assert.equal(
    await flow.locator(".typing-zh").count(),
    0,
    "audio only before submitting a sentence",
  );
  await flow.getByRole("button", { name: "再听一遍", exact: true }).waitFor();
  checks.push(
    "打字单词/整句/听写全部默写；英美拼写接受；核对后停留查看信息；无逐字对错或实时准确率泄题；手动切题只写一条轮次记录；FSRS与未完成复习不变",
  );

  // Formal review: no automatic first letter, and revealing an answer cannot earn Good.
  for (const kind of ["produce", "spell", "dictation"]) {
    const track = kind === "dictation" ? "l" : "p";
    const reviewContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await seed(reviewContext, {
      ...fixture,
      session: {
        ...fixture.session,
        id: `typing-review-${kind}`,
        steps: [{ id, kind }],
        reviewIds: [`${track}:${id}`],
      },
    });
    const review = await reviewContext.newPage();
    observe(review);
    await review.goto(origin + "/#/learn");
    const reviewInput = review.getByRole("textbox", {
      name: "输入英文单词",
      exact: true,
    });
    await reviewInput.waitFor();
    await hidden(review, ".quiz");
    await width(review, 390);
    await review.setViewportSize({ width: 390, height: 420 });
    await reviewInput.pressSequentially("accom");
    await eventually(async () => {
      const bounds = await reviewInput.boundingBox();
      return bounds && bounds.y >= 0 && bounds.y + bounds.height <= 360;
    }, "review input above simulated keyboard");
    if (kind === "produce") {
      await review
        .getByRole("button", { name: "暂时想不起，查看答案", exact: true })
        .click();
      await eventually(
        async () =>
          (await localProgress(review)).session?.graded?.[`p:${id}`] === 1,
        "answer reveal grades Again",
      );
    } else {
      await reviewInput.pressSequentially("modation");
      await eventually(
        async () =>
          (await localProgress(review)).session?.pending?.correct === true,
        `${kind} correct recall`,
      );
      const graded = (await localProgress(review)).session.graded;
      assert.deepEqual(Object.keys(graded), [`${track}:${id}`]);
      assert.equal(graded[`${track}:${id}`], 3);
    }
    await reviewContext.close();
  }
  checks.push(
    "正式拼写/产出/听写无首字母和词长提示；390px与缩小视口输入可见；主动看答案记重来，正确首答只更新对应记忆轨一次",
  );

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
