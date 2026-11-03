#!/usr/bin/env node
/**
 * S0 UI integration, disposable Chrome context only. Vite assets, word entries,
 * syllables and mnemonic chunks are warmed online, then setOffline(true) really
 * disconnects the context. SPA navigation uses the already loaded modules; this
 * checks in-session offline practice, not a production service-worker reload.
 * No account is created and no real model endpoint is contacted.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.BAND_SCORING_E2E_WEB_PORT || 17488);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const origin = `http://127.0.0.1:${port}`;
const checks = [], externalRequests = [], pageErrors = [], logs = [];
let vite, browser, context, page, success = false, phase = "startup", failure;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}
const moduleCall = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const store = await import("/src/store/store.ts");
  return store[name](...args);
}, { name, args });
async function route(value, word = null) {
  await page.evaluate(async ({ value, word }) => (await import("/src/lib/router.ts")).go(value, word), { value, word });
}
const state = () => page.evaluate(async () => (await import("/src/store/store.ts")).store.get());
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

try {
  vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  for (const output of [vite.stdout, vite.stderr]) output.on("data", (chunk) => { logs.push(chunk.toString()); if (logs.length > 20) logs.shift(); });
  await eventually(async () => {
    if (vite.exitCode !== null) throw new Error("temporary Vite exited");
    try { return (await fetch(origin)).ok; } catch { return false; }
  }, "temporary Vite did not start", 15000);
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
  context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("word-atlas:settings", JSON.stringify({ onboarded: true, autoplay: false, sfx: false, splash: false, ambience: "off", feedbackMode: "rules" }));
    localStorage.setItem("band-galaxy:ai-key", "isolated-obsolete-credential");
    localStorage.setItem("band-galaxy:syl-taps", "keep-this-fixture");
    window.__obsoleteCredentialReads = 0;
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === "band-galaxy:ai-key") window.__obsoleteCredentialReads++;
      return read.call(this, key);
    };
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  await page.goto(`${origin}/#/me`, { waitUntil: "networkidle" });
  await page.getByRole("region", { name: "评分与反馈" }).waitFor();
  const migration = await page.evaluate(() => ({ removed: !Object.hasOwn(localStorage, "band-galaxy:ai-key"), reads: window.__obsoleteCredentialReads,
    marker: localStorage.getItem("band-galaxy:llm-migrated"), unrelated: localStorage.getItem("band-galaxy:syl-taps") }));
  assert.deepEqual(migration, { removed: true, reads: 0, marker: "1", unrelated: "keep-this-fixture" });
  checks.push("首次渲染前清除唯一旧密钥，不读取值并保留其他本机键");

  phase = "local placeholder credential does not block ordinary learning text";
  const placeholder = await page.evaluate(async () => {
    const scoring = await import("/src/ielts/scoring/index.ts");
    const module = await import("/src/store/store.ts");
    scoring.saveFeedbackConfig({ version: 1, providers: [{ id: "local-placeholder", kind: "openai-compatible", label: "本机接口", baseURL: "http://localhost:11434/v1", model: "user-selected", jsonMode: "prompt-only", timeoutMs: 1000, tasks: ["essay"] }] });
    scoring.setCredential("local-placeholder", "ollama");
    const text = "I use ollama to test a method in the laboratory.";
    module.store.progress((p) => ({ ...p, hacks: { ...p.hacks, placeholder: { homophone: text, split: "test", scene: "正常学习笔记", at: 1 } } }));
    const backup = JSON.parse(module.exportBackup()), snapshot = module.store.cloudSnapshot();
    const preserved = module.store.get().progress.hacks.placeholder.homophone === text;
    module.store.progress((p) => ({ ...p, hacks: {} }));
    return { backup: backup.progress.hacks.placeholder.homophone === text, snapshot: snapshot?.progress.hacks.placeholder.homophone === text, preserved,
      provider: scoring.getFeedbackConfig().providers[0].baseURL };
  });
  assert.deepEqual(placeholder, { backup: true, snapshot: true, preserved: true, provider: "http://localhost:11434/v1" });
  checks.push("本机接口ollama占位配置合法，普通学习文本可备份与同步且原文保留");

  phase = "online fixture and static-resource warmup";
  const fixtures = await page.evaluate(async () => {
    const { loadOpenAtlas } = await import("/src/atlas/data.ts");
    const atlas = await loadOpenAtlas(), refs = [];
    for (const ref of atlas.words.slice(0, 120)) {
      const entry = await atlas.entry(ref.id);
      if (entry.ex.length >= 2 && entry.syn.length && /^[a-z]+$/i.test(ref.word)) refs.push({ id: ref.id, word: ref.word, order: ref.order });
      if (refs.length === 8) break;
    }
    if (refs.length !== 8) throw new Error("need eight real word entries for the isolated fixture");
    const { loadSyllables } = await import("/src/ielts/syllables.ts");
    const { loadMnemonic } = await import("/src/ielts/tags.ts");
    await loadSyllables(); await Promise.all(refs.map((ref) => loadMnemonic(ref.order, ref.id)));
    const { store } = await import("/src/store/store.ts");
    const card = { due: 1, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, seen: 1 };
    store.progress((p) => ({ ...p, cards: Object.fromEntries(refs.map((ref) => [ref.id, card])), skills: {}, mistakes: refs.map((ref) => ref.id), readings: [], hacks: {} }));
    return refs;
  });
  await route({ page: "ielts", tab: "reading" });
  await page.getByRole("button", { name: "生成一篇", exact: true }).click();
  await eventually(async () => (await state()).progress.readings.length === 1, "online warmup did not load the actual App's word-entry cache");
  await route({ page: "ielts", tab: "writing" });
  await page.locator(".writing-word").waitFor();
  const target = (await page.locator(".writing-word").innerText()).trim();
  const fixture = fixtures.find((item) => item.word === target);
  assert.ok(fixture);
  await page.evaluate(async () => { const { store } = await import("/src/store/store.ts"); store.progress((p) => ({ ...p, readings: [] })); });
  await context.setOffline(true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);

  phase = "real offline sentence scoring and one daily production review";
  const sentence = `Although the report mentions ${target}, our team will consider the available evidence carefully.`;
  await page.locator(".writing textarea").fill(sentence);
  await page.getByRole("button", { name: "批改句子", exact: true }).click();
  await page.locator(".grade-card").waitFor();
  assert.match(await page.locator(".grade-card").innerText(), /[0-3]\s*\/3/);
  assert.match(await page.locator(".grade-card").innerText(), /词库例句/);
  const production = (await state()).progress.skills[`p:${fixture.id}`];
  assert.ok(production && production.last);
  await page.getByRole("button", { name: "批改句子", exact: true }).click();
  await eventually(async () => !(await page.getByRole("button", { name: "批改句子", exact: true }).isDisabled()), "repeat scoring did not finish");
  assert.deepEqual((await state()).progress.skills[`p:${fixture.id}`], production, "a second same-day score must not repeat the production-card review");
  checks.push("真实断网造句得0–3分并更新p:id，当天重复批改不重复复习");

  phase = "offline manual prompt validation and replacement";
  await page.evaluate(async () => (await import("/src/store/store.ts")).store.settings({ feedbackMode: "manual" }));
  await page.getByRole("button", { name: "批改句子", exact: true }).click();
  const manual = page.getByRole("region", { name: "复制提示词与粘贴结果" });
  await manual.waitFor();
  assert.match(await manual.getByRole("textbox", { name: "评分提示词", exact: true }).inputValue(), /\$schema|"properties"/);
  await manual.getByRole("textbox", { name: "粘贴评分结果", exact: true }).fill("this is not JSON");
  await manual.getByRole("button", { name: "校验并使用", exact: true }).click();
  assert.match(await manual.getByRole("alert").innerText(), /[\u4e00-\u9fff]/);
  await manual.getByRole("textbox", { name: "粘贴评分结果", exact: true }).fill(JSON.stringify({ score: 3, usedCorrectly: true, verdict: "已根据原句给出反馈", corrected: sentence, better: `Although ${target} is relevant, a careful assessment requires clear evidence.`, notes: ["对照原稿检查搭配。"] }));
  await manual.getByRole("button", { name: "校验并使用", exact: true }).click();
  await eventually(async () => await manual.count() === 0, "valid manual feedback did not replace the local display");
  assert.match(await page.locator(".grade-card").innerText(), /8 分参考句/);
  assert.deepEqual((await state()).progress.skills[`p:${fixture.id}`], production);
  checks.push("断网可复制含JSON Schema提示词，非法粘贴给中文错误，合法粘贴替换显示且不重复复习");

  phase = "automatic failure keeps local feedback and opens manual input";
  await page.evaluate(async () => (await import("/src/store/store.ts")).store.settings({ feedbackMode: "auto" }));
  await page.getByRole("button", { name: "批改句子", exact: true }).click();
  await manual.waitFor();
  assert.match(await page.locator(".grade-card").innerText(), /词库例句/);
  assert.match(await manual.getByRole("textbox", { name: "评分提示词", exact: true }).inputValue(), /"properties"/);
  assert.deepEqual((await state()).progress.skills[`p:${fixture.id}`], production);
  await manual.getByRole("button", { name: "收起", exact: true }).click();
  checks.push("自动接口无可用配置时保留本地反馈并转到复制提示词，不额外记复习");

  phase = "real offline reading generation";
  const skillsBeforeReading = (await state()).progress.skills;
  await page.evaluate(async () => (await import("/src/store/store.ts")).store.settings({ feedbackMode: "rules" }));
  await route({ page: "ielts", tab: "reading" });
  await page.getByRole("button", { name: "生成一篇", exact: true }).click();
  await eventually(async () => (await state()).progress.readings.length === 1, "offline reading did not generate");
  const reading = (await state()).progress.readings[0];
  assert.equal(reading.src, "rules"); assert.ok(reading.questions.length >= 5);
  assert.deepEqual([...new Set(reading.questions.map((q) => q.a))].sort(), ["FALSE", "NOT GIVEN", "TRUE"]);
  assert.equal(await page.locator(".tfng > li").count(), reading.questions.length);
  assert.match(await page.locator(".reading-view").innerText(), /本地主题阅读/);
  assert.doesNotMatch(reading.passage, /These vocabulary examples describe separate situations|The compiler gives no information|Researchers discuss the term/);
  for (const question of reading.questions) assert.doesNotMatch(question.q, /^(?:It is not true that|The compiler preferred this alternative example)/i);
  const coverage = page.getByRole("region", { name: "目标词覆盖", exact: true });
  const missed = fixtures.filter((word) => !reading.words.includes(word.id));
  assert.match(await coverage.innerText(), new RegExp(`本篇已覆盖 ${reading.words.length} 个目标词`));
  assert.match(await coverage.innerText(), new RegExp(`本次未覆盖 ${missed.length} 个`));
  if (missed.length) assert.equal(await coverage.getByRole("list", { name: "未覆盖目标词", exact: true }).locator("li").count(), missed.length);
  const firstQuestion = page.locator(".tfng > li").first();
  assert.equal(await firstQuestion.locator(".tfng-why").count(), 0);
  await firstQuestion.getByRole("button", { name: reading.questions[0].a, exact: true }).click();
  await eventually(async () => (await state()).progress.readings[0].answers[0] === reading.questions[0].a, "the first reading answer was not retained");
  assert.equal(await firstQuestion.getByRole("button", { name: reading.questions[0].a, exact: true }).isDisabled(), true);
  assert.deepEqual((await state()).progress.skills, skillsBeforeReading, "reading answers must not count a second production review");
  checks.push("断网连贯主题阅读有三种判断题，无旧答案提示句式，覆盖与未覆盖如实展示，作答不重复记复习");

  phase = "real offline memory split and self-authored save";
  await route({ page: "ielts", tab: "reading" }, fixture.id);
  const ask = page.getByRole("button", { name: /老是忘？来个邪修记法|邪修一下：谐音/ });
  await ask.click();
  const hack = page.getByRole("region", { name: "邪修记法", exact: true });
  await hack.waitFor();
  assert.match(await hack.innerText(), /音节拆分/);
  await hack.getByRole("textbox", { name: "自写谐音", exact: true }).fill("我的测试谐音");
  await hack.getByRole("textbox", { name: "自写画面", exact: true }).fill("一个能提醒我词义的测试画面。");
  await hack.getByRole("button", { name: "保存自写记法", exact: true }).click();
  const saved = (await state()).progress.hacks[fixture.id];
  assert.equal(saved.homophone, "我的测试谐音"); assert.equal(saved.scene, "一个能提醒我词义的测试画面。");
  assert.equal(saved.src, "manual"); assert.ok(saved.split.length > 0);
  checks.push("真实断网显示音节拆分，能填写并保存自写谐音与画面");

  phase = "saved reading answers survive a real page reload without a duplicate review";
  await moduleCall("flush");
  await context.setOffline(false);
  await page.reload({ waitUntil: "networkidle" });
  await route({ page: "ielts", tab: "reading" });
  await eventually(async () => await page.locator(".tfng > li").count() === reading.questions.length, "saved reading did not reopen after reload");
  const recoveredReading = (await state()).progress.readings.find((item) => item.id === reading.id);
  assert.ok(recoveredReading);
  assert.equal(recoveredReading.answers[0], reading.questions[0].a);
  assert.equal(await page.locator(".tfng > li").first().getByRole("button", { name: reading.questions[0].a, exact: true }).isDisabled(), true);
  assert.deepEqual((await state()).progress.skills, skillsBeforeReading);
  checks.push("阅读题库与已答结果在真实刷新后恢复，产出卡复习记录不增加");

  assert.deepEqual(externalRequests, [], "practice must not request a third-party address");
  const backup = JSON.parse(await moduleCall("exportBackup"));
  assert.equal(backup.settings.feedbackMode, "rules");
  assert.ok(!JSON.stringify(backup).includes("isolated-obsolete-credential"));
  checks.push("全部阶段零外部请求、无未捕获浏览器异常，备份不带旧密钥");

  phase = "outbound secret prevention preserves local text and reports a recoverable UI error";
  let downloads = 0;
  page.on("download", () => { downloads++; });
  const privacy = await page.evaluate(async (id) => {
    const module = await import("/src/store/store.ts");
    const secret = "xai-" + "z".repeat(24);
    module.store.progress((p) => ({ ...p, hacks: { ...p.hacks, [id]: { ...p.hacks[id], homophone: secret } } }));
    const result = { backupBlocked: false, syncBlocked: false, originalPreserved: module.store.get().progress.hacks[id].homophone === secret };
    try { module.exportBackup(); } catch (error) { result.backupBlocked = error instanceof Error && /密钥/.test(error.message) && !error.message.includes(secret); }
    try { module.store.cloudSnapshot(); } catch (error) { result.syncBlocked = error instanceof Error && /密钥/.test(error.message) && !error.message.includes(secret); }
    return result;
  }, fixture.id);
  assert.deepEqual(privacy, { backupBlocked: true, syncBlocked: true, originalPreserved: true });
  const blockedSync = await page.evaluate(async () => (await import("/src/store/cloudSync.ts")).getCloudState());
  assert.equal(blockedSync.status, "error"); assert.match(blockedSync.message, /疑似接口密钥/);
  await route({ page: "me" });
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  await eventually(async () => (await page.locator(".toasts").innerText()).includes("疑似接口密钥"), "blocked export did not show a Chinese recovery message");
  assert.equal(downloads, 0, "a rejected backup must not create a download");
  const recovered = await page.evaluate(async (id) => {
    const module = await import("/src/store/store.ts");
    const originalPreserved = module.store.get().progress.hacks[id].homophone === "xai-" + "z".repeat(24);
    module.store.progress((p) => ({ ...p, hacks: { ...p.hacks, [id]: { ...p.hacks[id], homophone: "我的测试谐音" } } }));
    return { originalPreserved, snapshotReady: !!module.store.cloudSnapshot(), backupReady: !!module.exportBackup() };
  }, fixture.id);
  assert.deepEqual(recovered, { originalPreserved: true, snapshotReady: true, backupReady: true });
  checks.push("误贴密钥在导出和同步出站前阻断，界面中文提示不崩溃，原文保留且移除后恢复");
  assert.deepEqual(externalRequests, [], "privacy handling must not request third-party addresses");
  assert.deepEqual(pageErrors, [], "uncaught browser errors");
  success = true;
} catch (error) {
  failure = error.message || String(error);
  if (phase === "startup" && logs.length) failure += `\n${logs.join("").slice(-2000)}`;
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => null); await browser?.close().catch(() => null); await stop(vite);
  console.log(JSON.stringify({ success, checks, ...(failure ? { failedPhase: phase, error: failure } : {}) }, null, 2));
}
