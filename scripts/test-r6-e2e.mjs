#!/usr/bin/env node
/** R6 production smoke: isolated API/SQLite, authenticated private media, real UI work.
 * Historical setup is explicitly synthetic API fixture data, never claimed as UI work.
 * Frozen day budgets are respected: missing subjects use the nearest valid subject day.
 * Day 366 is a negative boundary, not a fabricated extra day. Real-device PWA is pending.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { packPrivateAudio } from "./release/pack-private-audio.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(",")}}`
      : (JSON.stringify(value) ?? "null");
const keyOf = (material) =>
  `${material.id}@${material.version}@${material.contentHash}`;
const recipe = JSON.parse(
  await fs.readFile(
    path.join(root, "scripts/fixtures/r6-scenarios.json"),
    "utf8",
  ),
);
assert.equal(recipe.fixtureVersion, 1);
const dateFor = (day) =>
  new Date(Date.parse(`${recipe.startDate}T04:00:00Z`) + (day - 1) * 86400000);
const dateText = (day) => dateFor(day).toISOString().slice(0, 10);
async function port() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close((e) => (e ? reject(e) : resolve(p)));
    });
  });
}
async function eventually(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch (e) {
      last = e;
    }
    await delay(100);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => null);
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function click(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
}
/** Since 879abe2cf pickers are collapsed under a <details> summary; open it once. */
async function openPicker(area, summary) {
  const details = area.locator("details", {
    has: area.page().getByText(summary, { exact: true }),
  });
  await details.first().waitFor();
  if (!(await details.first().evaluate((element) => element.open)))
    await click(area.getByText(summary, { exact: true }));
}
async function navigate(page, route) {
  await page.evaluate((value) => {
    location.hash = `#/${value}`;
  }, route);
}
async function scope(page, compact = false) {
  return page.evaluate(
    (compact) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("band-learning-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("scopes"),
            store = tx.objectStore("scopes"),
            cursor = store.openCursor();
          let result;
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            if (String(row.key).startsWith("account:"))
              result = { key: row.key, ...row.value };
            row.continue();
          };
          tx.oncomplete = () => {
            db.close();
            if (!compact || !result) return resolve(result ?? null);
            const historical = Object.values(result.heads ?? {}).filter(
              (record) =>
                !record.deleted &&
                !record.conflict &&
                record.id.startsWith("r6-history-"),
            );
            resolve({
              historyCount: historical.length,
              historyIds: new Set(historical.map((record) => record.id)).size,
              historyRevisions: new Set(
                historical.map((record) => record.revisionId),
              ).size,
              outboxLength: result.outbox.length,
            });
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    compact,
  );
}
async function heads(page, kind) {
  return Object.values((await scope(page))?.heads ?? {}).filter(
    (r) => (!kind || r.kind === kind) && !r.deleted && !r.conflict,
  );
}
async function revision(page, id) {
  return (await scope(page))?.heads[id];
}
async function allServerRecords(page, stream = "records") {
  return page.evaluate(async (stream) => {
    let cursor = 0;
    const all = [];
    while (true) {
      const response = await fetch(
        `/api/learning/v2/${stream}?after=${cursor}&limit=100`,
        { cache: "no-store", credentials: "same-origin" },
      );
      if (!response.ok) throw new Error(`records ${response.status}`);
      const value = await response.json();
      all.push(...value.items);
      if (!value.hasMore) return all;
      cursor = value.nextCursor;
    }
  }, stream);
}
async function width(page) {
  await eventually(
    async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
            document.documentElement.clientWidth &&
          (visualViewport?.offsetLeft ?? 0) === 0,
      ),
    "390px horizontal overflow",
    5000,
  );
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    offset: visualViewport?.offsetLeft ?? 0,
  }));
}
async function weeklyReady(page) {
  const weekly = page.getByRole("region", { name: "本周校准", exact: true });
  await weekly
    .getByRole("heading", {
      name: "第 52 周：本周校准与调整",
      exact: true,
    })
    .waitFor();
  const text = await weekly.innerText();
  assert.ok(text.includes("2027-10-12 至 2027-11-08"));
  assert.ok(text.includes("听力：5.0（正式）· 差距 3.5"));
  assert.ok(text.includes("当前有效分差最大：听力"));
  await weekly
    .getByText("近28天题型、错因与订正复测", { exact: true })
    .waitFor();
}
const bench = (page, skill) =>
  page.getByRole("region", {
    name: skill === "reading" ? "阅读练习" : "听力练习",
    exact: true,
  });
const review = (page) =>
  page.getByRole("region", { name: "听读 A-B 复盘", exact: true });
async function fillAnswers(area, answers, questionNumbers) {
  for (const [i, value] of answers.entries()) {
    const field = area.getByLabel(`第${questionNumbers?.[i] ?? i + 1}题`, {
      exact: true,
    });
    if (await field.evaluate((e) => e.tagName === "SELECT"))
      await field.selectOption(value);
    else await field.fill(value);
  }
}
async function completeAB(page, answers, wrong = [], questionNumbers) {
  const area = review(page);
  await area
    .getByRole("heading", { name: "A轮：先自己改答案", exact: true })
    .waitFor();
  assert.equal(await area.getByText(/接受答案：/).count(), 0);
  await fillAnswers(area, answers, questionNumbers);
  await click(
    area.getByRole("button", { name: "保存A轮，查看答案", exact: true }),
  );
  for (const number of wrong)
    await area
      .getByLabel(`第${number}题错因`, { exact: true })
      .selectOption("spelling");
  await click(area.getByRole("button", { name: "完成B轮复盘", exact: true }));
  await area.getByRole("status").filter({ hasText: "复盘已保存" }).waitFor();
}
function wav(index) {
  const rate = 16000,
    frames = rate,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(
      Math.round(
        Math.sin((2 * Math.PI * (250 + index * 13) * i) / rate) * 1000,
      ),
      44 + i * 2,
    );
  return bytes;
}
function hashMaterial(body) {
  return { ...body, contentHash: sha(canonical(body)) };
}
export async function makeR6SmokeFixtures(directory) {
  const materials = [],
    prompts = [],
    audioRoot = path.join(directory, "originals");
  await fs.mkdir(path.join(audioRoot, "audio"), { recursive: true });
  let serial = 0;
  for (const point of recipe.points) {
    for (const group of ["original", "fresh"])
      for (let part = 1; part <= 4; part++) {
        const id = `r6-d${point.checkpoint}-${group}-s${part}`,
          audioPath = `audio/${id}.wav`,
          bytes = wav(++serial),
          answer = recipe.partAnswers[part - 1];
        await fs.writeFile(path.join(audioRoot, audioPath), bytes);
        materials.push(
          hashMaterial({
            id,
            version: "1",
            skill: "listening",
            title: `Self-authored QA ${point.checkpoint} ${group} part ${part}`,
            deliveryMode: "local-import",
            scope: "section",
            pool: "practice",
            examId: `R6-D${point.checkpoint}-${group.toUpperCase()}`,
            section: part,
            source: {
              materialSource: "cambridge",
              sourceRef: `synthetic:r6-d${point.checkpoint}-${group}-${part}`,
              rights:
                "Self-authored automated QA fixture. Source category simulates a Cambridge record; this is not actual Cambridge or IELTS content.",
              answerVerified: true,
            },
            audio: { path: audioPath, durationSeconds: 1, sha256: sha(bytes) },
            transcript: `Synthetic checkpoint ${point.checkpoint} ${group} part ${part}. The fictional service is the ${answer}. These generated tones only test playback transport, not listening comprehension.`,
            questions: Array.from({ length: 10 }, (_, i) => ({
              id: `${id}-q${i + 1}`,
              number: (part - 1) * 10 + i + 1,
              type: "sentence-completion",
              prompt: `For synthetic QA slot ${i + 1}, write the named fictional service.`,
              answer: { accepted: [answer], maxWords: 1 },
              evidence: { quote: answer, startSeconds: 0.2, endSeconds: 0.8 },
              answerVerified: true,
            })),
          }),
        );
      }
    const id = `r6-d${point.checkpoint}-reading`,
      passage = `This self-authored QA passage concerns fictional checkpoint ${point.checkpoint}. A council created a reading room beside a garden. The room opens every weekday. Visitors may borrow books for two weeks. Staff record visits to compare demand. The trial lasts three months, after which the council reviews its budget. These statements exist only to test a complete forty-answer form and are not exam material.`;
    materials.push(
      hashMaterial({
        id,
        version: "1",
        skill: "reading",
        title: `Self-authored QA full reading ${point.checkpoint}`,
        deliveryMode: "local-import",
        scope: "full",
        pool: "practice",
        examId: `R6-D${point.checkpoint}-READING`,
        source: {
          materialSource: "unofficial",
          sourceRef: `synthetic:${id}`,
          rights:
            "Self-authored automated QA fixture, not IELTS exam material.",
          answerVerified: true,
        },
        passage,
        paragraphs: [{ id: "p1", text: passage }],
        questions: Array.from({ length: 40 }, (_, i) => ({
          id: `${id}-q${i + 1}`,
          number: i + 1,
          type: "true-false-not-given",
          prompt: `The fictional checkpoint number is ${point.checkpoint}.`,
          answer: { accepted: ["TRUE"], maxWords: 3 },
          evidence: {
            quote: `checkpoint ${point.checkpoint}`,
            paragraphId: "p1",
          },
          answerVerified: true,
        })),
      }),
    );
    for (const n of [1, 2]) {
      const prompt = {
        id: `r6-d${point.checkpoint}-writing-${n}`,
        version: "1",
        skill: "writing",
        taskType: "task2",
        questionType: "opinion",
        prompt:
          recipe.prompt +
          ` (Self-authored QA variation ${point.checkpoint}-${n}.)`,
        sourceRef: `synthetic:r6-writing-${point.checkpoint}-${n}`,
        materialSource: "unofficial",
        rights: "Self-authored automated QA prompt, not actual exam material.",
        pool: "practice",
        ready: true,
      };
      prompts.push(hashMaterial(prompt));
    }
    for (const part of [1, 2, 3]) {
      const prompt = {
        id: `r6-d${point.checkpoint}-speaking-${part}`,
        version: "1",
        skill: "speaking",
        part,
        prompt: `Describe how public places support local people. Self-authored QA checkpoint ${point.checkpoint}, Part ${part}.`,
        sourceRef: `synthetic:r6-speaking-${point.checkpoint}-${part}`,
        materialSource: "unofficial",
        rights: "Self-authored automated QA prompt, not actual exam material.",
        pool: "practice",
        ready: true,
      };
      prompts.push(hashMaterial(prompt));
    }
  }
  const bank = path.join(directory, "original-bank.json"),
    promptFile = path.join(directory, "prompts.json"),
    privateRoot = path.join(directory, "private");
  await fs.writeFile(bank, JSON.stringify({ importVersion: 1, materials }));
  await fs.writeFile(promptFile, JSON.stringify({ importVersion: 1, prompts }));
  const packed = await packPrivateAudio({
    bank,
    audioRoot,
    out: privateRoot,
    prompts: promptFile,
  });
  return { materials, prompts, privateRoot, packed };
}
async function cookieHeader(context, origin) {
  return (await context.cookies(origin))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
function syntheticHistory(planId) {
  const records = [];
  for (let day = 1; day <= 365; day++) {
    const date = dateText(day);
    for (let i = 0; i < 41 + (day <= 35 ? 1 : 0); i++) {
      const id = `r6-history-d${day}-${i}`,
        payload = { planId, date, day };
      if (i < 5)
        records.push({
          id,
          kind: "mission",
          payload: {
            ...payload,
            taskId: `r6-history-${day}-${i}`,
            skill: [
              "listening",
              "reading",
              "writing",
              "speaking",
              "vocabulary",
            ][i],
            status: "partial",
            plannedMinutes: 0,
            actualMinutes: 0,
            timeSource: "timer",
          },
        });
      else if (i < 17)
        records.push({
          id,
          kind: "attempt",
          payload: {
            ...payload,
            contentId: `r6-history-material-${i}`,
            contentVersion: "1",
            contentHash: "a".repeat(64),
            skill: i % 2 ? "reading" : "listening",
            materialSource: "unofficial",
            sourceRef: "synthetic:history-only",
            scope: "type-drill",
            answers: ["fixture"],
            score: 1,
            correct: 1,
            total: 1,
            firstAttempt: false,
            conditions: {
              timed: true,
              firstAttempt: false,
              unseen: false,
              replayed: false,
              transcriptViewed: false,
              replays: 0,
            },
            questionResults: [
              {
                questionId: `r6-history-q${i}`,
                correct: true,
                reviewCorrect: true,
                confidence: "sure",
                errorCause: null,
                answerDisputed: false,
              },
            ],
          },
        });
      else if (i < 25) {
        const text = `Synthetic QA history day ${day}, essay ${i}. ${recipe.essay}`;
        records.push({
          id,
          kind: "essay",
          payload: {
            ...payload,
            contentId: `r6-history-writing-${i}`,
            contentVersion: "1",
            prompt: "Self-authored historical benchmark prompt.",
            text,
            taskType: "task2",
            scope: "full",
            stage: "submitted",
            wordCount: text.trim().split(/\s+/).length,
            elapsedSeconds: 60,
            conditions: { timed: true, firstAttempt: false, unseen: false },
          },
        });
      } else if (i < 33)
        records.push({
          id,
          kind: "speaking",
          payload: {
            ...payload,
            contentId: `r6-history-speaking-${i}`,
            contentVersion: "1",
            prompt: "Self-authored historical benchmark oral question.",
            transcript: `Synthetic historical QA day ${day}, sample ${i}. ${recipe.speaking[1]}`,
            durationSeconds: 12,
            part: 1,
            prepSeconds: 0,
            recordingStatus: "none",
            conditions: { timed: true, firstAttempt: false, unseen: false },
          },
        });
      else if (i < 41) {
        const speaking = i >= 37,
          parentIndex = speaking ? i - 12 : i - 16;
        records.push({
          id,
          kind: "feedback",
          referenceTo: `r6-history-d${day}-${parentIndex}`,
          payload: {
            planId,
            workId: `r6-history-d${day}-${parentIndex}`,
            rubricVersion: "r6-synthetic-history-self-v1",
            source: "self",
            sourceText:
              "Synthetic benchmark self-review, not human calibration.",
            assessedAt: dateFor(day).getTime(),
            text: `Synthetic historical self-review for day ${day}. This is fixture data, not an actual learner result.`,
            bands: speaking
              ? { fluency: 7, lexical: 7, grammar: 7, pronunciation: 7 }
              : { taskResponse: 7, coherence: 7, lexical: 7, grammar: 7 },
            taskType: speaking ? "speaking" : "task2",
            errorCauses: [],
          },
        });
      } else
        records.push({
          id,
          kind: "assessment",
          payload: {
            ...payload,
            kind: "weekly-mock",
            source: "self",
            materialId: `r6-history-unqualified-mock-${day}`,
            scores: { listening: 6, reading: 6, writing: 6, speaking: 6 },
            scoreSources: {
              listening: "self",
              reading: "self",
              writing: "self",
              speaking: "self",
            },
            conditions: {
              timed: true,
              unseen: false,
              replayed: false,
              viewedTranscript: false,
            },
            note: "Synthetic self-estimate only. No official/Cambridge full attempt or human writing/speaking rating; must not replace qualified goals.",
          },
        });
    }
  }
  assert.equal(records.length, 15000);
  return records;
}
async function seedHistory(origin, cookie, planId) {
  const rows = syntheticHistory(planId),
    started = performance.now(),
    revisions = [],
    parents = new Map();
  let done = 0;
  const concurrency = 3;
  const upload = async (items) => {
    let cursor = 0,
      firstProblem;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < items.length && !firstProblem) {
          const row = items[cursor++],
            revisionId = randomUUID();
          try {
            const parent = row.referenceTo
              ? parents.get(row.referenceTo)
              : null;
            if (row.referenceTo)
              assert.ok(parent, `Missing benchmark parent ${row.referenceTo}`);
            const payload = parent
              ? {
                  ...row.payload,
                  workRevisionId: parent.revisionId,
                  inputHash: parent.contentHash,
                }
              : row.payload;
            const body = {
              schemaVersion: 2,
              revisionId,
              mutationId: randomUUID(),
              baseRevision: null,
              kind: row.kind,
              payload,
            };
            const response = await fetch(
              `${origin}/api/learning/v2/records/${row.id}`,
              {
                method: "PUT",
                headers: {
                  Cookie: cookie,
                  Origin: origin,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
              },
            );
            const result = await response.json();
            assert.equal(
              response.status,
              200,
              `history fixture ${row.id}: ${JSON.stringify(result)}`,
            );
            assert.equal(result.record.revisionId, revisionId);
            parents.set(row.id, result.record);
            revisions.push(revisionId);
            done++;
          } catch (error) {
            error.message += ` [historical setup record=${row.id}, kind=${row.kind}, completed=${done}, concurrency=${concurrency}]`;
            firstProblem = error;
          }
        }
      }),
    );
    if (firstProblem) throw firstProblem;
  };
  await upload(rows.filter((row) => !row.referenceTo));
  await upload(rows.filter((row) => row.referenceTo));
  return {
    count: done,
    revisionIds: revisions,
    seconds: (performance.now() - started) / 1000,
    concurrency,
    kinds: rows.reduce(
      (counts, row) => ({ ...counts, [row.kind]: (counts[row.kind] ?? 0) + 1 }),
      {},
    ),
    startDate: dateText(1),
    endDate: dateText(365),
    planId,
  };
}
export async function runR6ReleaseE2E({ historyOnly = false } = {}) {
  const started = performance.now(),
    dist = path.resolve(
      process.env.BAND_R6_E2E_DIST || path.join(root, "dist"),
    ),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "band-r6-e2e-"));
  let backendLog = "";
  let backend,
    web,
    browser,
    context,
    phoneContext,
    page,
    phone,
    success = false,
    failure,
    phase = "fixture preparation";
  const pageErrors = [],
    checks = [],
    evidence = {
      points: [],
      realDevicePWA: {
        status: "pending-after-approved-deployment",
        iphoneSafari: false,
        macInstall: false,
        simulated390IsNotRealDevice: true,
      },
    },
    external = [],
    privateResponses = [],
    mediaEvents = [];
  let apiPort = await port(),
    webPort = await port();
  while (webPort === apiPort) webPort = await port();
  const origin = `http://127.0.0.1:${webPort}`,
    apiOrigin = `http://127.0.0.1:${apiPort}`,
    db = path.join(directory, "learning.sqlite3"),
    username = `r6_${randomBytes(5).toString("hex")}`,
    password = randomBytes(24).toString("base64url"),
    passwordFile = path.join(directory, "owner-password");
  let fixtures, plan, firstListening, lastWriting;
  const workIds = [];
  const observe = (ctx, label) => {
    ctx.on("page", (p) =>
      p.on("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`)),
    );
    ctx.on("request", (r) => {
      if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin)
        external.push(r.url());
    });
    ctx.on("response", (r) => {
      if (new URL(r.url()).pathname.startsWith("/private/"))
        privateResponses.push({
          status: r.status(),
          cache: r.headers()["cache-control"],
          worker: r.fromServiceWorker(),
        });
    });
  };
  const login = async (p) => {
    await p.goto(`${origin}/login`, { waitUntil: "networkidle" });
    await p.getByLabel("账号", { exact: true }).fill(username);
    await p.getByLabel("密码", { exact: true }).fill(password);
    await click(p.getByRole("button", { name: "登录", exact: true }));
    await eventually(
      () => !p.url().includes("/login"),
      "web login redirects into authenticated application",
    );
    await navigate(p, "me");
    const area = p.getByRole("region", { name: "学习进度同步", exact: true });
    await area.waitFor();
    await eventually(
      async () => (await area.innerText()).includes(`已登录 ${username}`),
      "UI account login",
    );
    await eventually(
      async () => !!(await scope(p)),
      "account scope initialized",
    );
  };
  const warm = async (p) => {
    await p.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      if (
        navigator.serviceWorker.controller &&
        registration.active?.state === "activated"
      )
        return;
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
    });
    await p.reload({ waitUntil: "networkidle" });
    assert.equal(
      await p.evaluate(() => !!navigator.serviceWorker.controller),
      true,
    );
  };
  const prepareBank = async (p) => {
    await navigate(p, "me");
    const area = p.getByRole("region", { name: "本机题库", exact: true });
    await click(
      area.getByRole("button", { name: "准备服务器私有听读题库", exact: true }),
    );
    await eventually(
      async () => /已准备\d+份听读原件/.test(await area.innerText()),
      "authenticated private bank prepared",
    );
    await click(
      area.getByRole("button", { name: "准备服务器私有写说题库", exact: true }),
    );
    await eventually(
      async () => /已准备\d+份写说题目/.test(await area.innerText()),
      "authenticated private prompts prepared",
    );
  };
  const day = async (n) => {
    await page.clock.setSystemTime(dateFor(n));
    await page.reload({ waitUntil: "networkidle" });
    await navigate(page, "today");
    if (n <= 365)
      await eventually(
        async () =>
          /第\s*\d+\s*天/.test(
            await page
              .getByRole("region", { name: "365天学习计划", exact: true })
              .innerText(),
          ) &&
          (await page
            .getByLabel("查看学习日期", { exact: true })
            .inputValue()) === dateText(n),
        `plan day ${n}`,
      );
  };
  const routeFor = (skill, n, extra = {}) =>
    `${skill}?${new URLSearchParams({ date: dateText(n), day: String(n), ...extra })}`;
  const choose = async (skill, n, material) => {
    await day(n);
    await navigate(page, routeFor(skill, n));
    const area = bench(page, skill);
    await area.waitFor();
    // Since 879abe2cf the platform pre-selects material; the picker sits in a
    // collapsed "查看或更换材料（可选）" block until the learner opens it.
    await openPicker(area, "查看或更换材料（可选）");
    if (material.__sequence) {
      let value;
      await eventually(async () => {
        const values = await area
          .getByLabel("练习材料", { exact: true })
          .locator("option")
          .evaluateAll((options) => options.map((o) => o.value));
        value = values.find((v) => v.split("@")[0] === material.id);
        return !!value;
      }, `full sequence ${material.id} finishes loading`);
      assert.ok(value, `full sequence ${material.id} available`);
      const [id, version, contentHash] = value.split("@");
      Object.assign(material, { id, version, contentHash });
      await area.getByLabel("练习材料", { exact: true }).selectOption(value);
    } else
      await area
        .getByLabel("练习材料", { exact: true })
        .selectOption(keyOf(material));
    return area;
  };
  const savedFor = async (material) => {
    let result;
    await eventually(async () => {
      result = (await heads(page, "attempt")).find(
        (r) =>
          r.payload.contentId === material.id &&
          r.payload.contentHash === material.contentHash,
      );
      return !!result;
    }, "first answer persisted");
    workIds.push(result.id);
    return result;
  };
  const listen = async (material, n, wrong = []) => {
    const area = await choose("listening", n, material);
    await click(
      area.getByRole("button", { name: "开始限时首答", exact: true }),
    );
    const answers = material.questions.map((q) => q.answer.accepted[0]);
    await fillAnswers(
      area.getByRole("region", { name: "作答题目", exact: true }),
      answers.map((v, i) => (wrong.includes(i + 1) ? "incorrect" : v)),
    );
    const control = area.getByRole("button", {
      name: material.scope === "full" ? "开始四节连续播放" : "播放一次",
      exact: true,
    });
    if (material.scope === "full") {
      await click(control);
      await area
        .getByRole("timer", { name: "整套听力检查倒计时", exact: true })
        .waitFor();
      const remaining = await area
        .getByRole("timer", { name: "整套听力检查倒计时", exact: true })
        .innerText();
      const natural = await page.evaluate(() => window.__r6Media);
      const ended = natural.filter((event) => event.event === "ended");
      assert.equal(
        ended.length,
        4,
        "all four real media ended events are required",
      );
      assert.ok(
        ended.every(
          (event) =>
            event.trusted &&
            event.duration > 0 &&
            event.position >= event.duration - 0.1,
        ),
        "the test clock does not replace real playback",
      );
      mediaEvents.push({ materialId: material.id, ended });
      assert.ok(
        Number(remaining.match(/\d+/)?.[0]) <= 120,
        "first check frame exceeds120",
      );
      assert.equal(
        await area
          .getByRole("button", { name: "提交首答", exact: true })
          .isEnabled(),
        false,
      );
      await page.clock.fastForward(120100);
    } else {
      const play = area.getByRole("button", {
        name: /开始播放听力/,
        exact: false,
      });
      await click(play);
      await area.getByRole("timer").filter({ hasText: /检查/ }).waitFor();
      await page.clock.fastForward(60100);
    }
    await eventually(
      () =>
        area.getByRole("button", { name: "提交首答", exact: true }).isEnabled(),
      "listening final check completed",
    );
    await click(area.getByRole("button", { name: "提交首答", exact: true }));
    const work = await savedFor(material);
    assert.equal(work.payload.score, material.questions.length - wrong.length);
    assert.equal(work.payload.scope, material.scope);
    if (material.scope === "full") {
      assert.equal(work.payload.total, 40);
      assert.equal(work.payload.conditions.sequential, true);
    }
    await completeAB(page, answers, wrong);
    return await revision(page, work.id);
  };
  const write = async (point) => {
    const n = point.writing;
    await day(n);
    await navigate(page, routeFor("writing", n));
    const area = page.getByRole("region", { name: "写作工作台", exact: true });
    await area.waitFor();
    await area.getByLabel("练习类型", { exact: true }).selectOption("task2");
    const prompt = fixtures.prompts.find(
      (p) => p.id === `r6-d${point.checkpoint}-writing-1`,
    );
    await openPicker(area, "查看/更换写作材料");
    await area
      .getByLabel("本机写作题库", { exact: true })
      .selectOption(keyOf(prompt));
    await click(area.getByRole("button", { name: "开始计时", exact: true }));
    await area.getByLabel("作文正文", { exact: true }).fill(recipe.essay);
    await page.clock.fastForward(1100);
    await click(area.getByRole("button", { name: "提交首稿", exact: true }));
    let work;
    await eventually(async () => {
      work = (await heads(page, "essay")).find(
        (r) =>
          r.payload.contentId === prompt.id && r.payload.stage === "submitted",
      );
      return !!work;
    }, "Task2 submitted through UI");
    assert.ok(work.payload.wordCount >= 250);
    assert.equal(work.payload.scope, "full");
    const self = page.getByRole("region", {
      name: "写作体检与自查",
      exact: true,
    });
    await self.waitFor();
    await eventually(
      async () => (await self.innerText()).includes("标注错因"),
      "writing local feedback ready",
    );
    for (const checkbox of await self.getByRole("checkbox").all())
      await checkbox.uncheck();
    await click(self.getByRole("button", { name: "拼写已检查", exact: true }));
    for (const label of ["任务回应", "连贯与衔接", "词汇", "语法"]) {
      const select = self.getByLabel(`自评${label}`, { exact: true });
      if (await select.count()) await select.selectOption("7");
    }
    await click(self.getByRole("button", { name: "保存自查", exact: true }));
    await self
      .getByRole("status")
      .filter({ hasText: "自查已保存在本机" })
      .waitFor();
    const feedback = (await heads(page, "feedback")).find(
      (r) =>
        r.payload.workRevisionId === work.revisionId &&
        r.payload.source === "self",
    );
    assert.ok(feedback);
    assert.equal(feedback.payload.inputHash, work.contentHash);
    assert.ok(Object.values(feedback.payload.bands).some((v) => v === 7));
    assert.match(await self.innerText(), /自评|估分/);
    workIds.push(work.id);
    lastWriting = work;
    return {
      id: work.id,
      day: n,
      wordCount: work.payload.wordCount,
      estimateOnly: true,
      feedback: feedback.id,
    };
  };
  const speak = async (point) => {
    const n = point.speaking;
    await day(n);
    await navigate(page, routeFor("speaking", n));
    const area = page.getByRole("region", { name: "口语练习", exact: true });
    await area.waitFor();
    const results = [];
    for (const part of [1, 2, 3]) {
      await area
        .getByLabel("口语部分", { exact: true })
        .selectOption(String(part));
      const prompt = fixtures.prompts.find(
        (p) => p.id === `r6-d${point.checkpoint}-speaking-${part}`,
      );
      await openPicker(area, "查看/更换口语材料");
      await area
        .getByLabel("本机口语题库", { exact: true })
        .selectOption(keyOf(prompt));
      const editor = area.getByRole("article", {
        name: "当前口语作答",
        exact: true,
      });
      if (part === 2) {
        await click(
          editor.getByRole("button", { name: "开始准备", exact: true }),
        );
        await editor
          .getByLabel("准备笔记", { exact: true })
          .fill("Public place, reason, example.");
        await page.clock.fastForward(60001);
      }
      await click(
        editor.getByRole("button", { name: "开始录音", exact: true }),
      );
      await eventually(
        () =>
          editor
            .getByRole("button", { name: "停止录音", exact: true })
            .isEnabled(),
        "microphone genuinely started",
      );
      await delay(1100);
      await click(
        editor.getByRole("button", { name: "停止录音", exact: true }),
      );
      await editor
        .getByRole("button", { name: "保存转写", exact: true })
        .waitFor();
      await editor
        .getByLabel("手动转写", { exact: true })
        .fill(recipe.speaking[part]);
      const id = await editor.getAttribute("data-work-id");
      await click(
        editor.getByRole("button", { name: "保存转写", exact: true }),
      );
      let work;
      await eventually(async () => {
        work = await revision(page, id);
        return (
          work?.payload.transcript === recipe.speaking[part] &&
          work.payload.recordingStatus === "local"
        );
      }, "real recording and transcript saved");
      assert.equal(work.payload.part, part);
      assert.ok(
        work.payload.durationSeconds > 0.2 && work.payload.durationSeconds < 15,
      );
      const captured = await page.evaluate(
        async ({ accountScope, recordingId }) => {
          const blob = await new Promise((resolve, reject) => {
            const open = indexedDB.open("band-learning-v1");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const database = open.result,
                transaction = database.transaction("recordings");
              const request = transaction
                .objectStore("recordings")
                .get([accountScope, recordingId]);
              transaction.oncomplete = () => {
                database.close();
                resolve(request.result);
              };
              transaction.onerror = transaction.onabort = () => {
                database.close();
                reject(transaction.error);
              };
            };
          });
          if (!(blob instanceof Blob)) return null;
          const bytes = await blob.arrayBuffer(),
            decoder = new AudioContext();
          try {
            return {
              bytes: bytes.byteLength,
              duration: (await decoder.decodeAudioData(bytes.slice(0)))
                .duration,
            };
          } finally {
            await decoder.close();
          }
        },
        {
          accountScope: (await scope(page)).key,
          recordingId: work.payload.recordingId,
        },
      );
      assert.ok(captured && captured.bytes > 0 && captured.duration > 0.2);
      assert.ok(
        Math.abs(captured.duration - work.payload.durationSeconds) <= 0.15,
      );
      const audio = area.locator(
        `audio[data-recording-id="${work.payload.recordingId}"]`,
      );
      await audio.waitFor();
      await eventually(
        () => audio.evaluate((a) => a.readyState >= 1),
        "local recording playable metadata",
      );
      await audio.evaluate(async (a) => {
        a.muted = true;
        await a.play();
      });
      await eventually(
        () => audio.evaluate((a) => a.currentTime > 0.1 && !a.error),
        "local recording actually plays",
      );
      await audio.evaluate((a) => a.pause());
      results.push({
        id: work.id,
        part,
        duration: work.payload.durationSeconds,
        decodedBytes: captured.bytes,
        decodedDuration: captured.duration,
        day: n,
      });
      workIds.push(work.id);
    }
    return results;
  };
  const dictation = async (point) => {
    await day(point.vocabulary);
    const learnedCount = await page.evaluate(
      () =>
        Object.keys(
          JSON.parse(
            localStorage.getItem("word-atlas:v2:word-atlas-open") || "{}",
          ).cards || {},
        ).length,
    );
    if (learnedCount === 0) {
      await navigate(page, "learn");
      const known = page.getByRole("button", {
        name: "我早就会了",
        exact: true,
      });
      await known.waitFor();
      await click(known);
      await click(
        page.getByRole("button", { name: "暂停并返回", exact: true }),
      );
    }
    await navigate(page, "ielts?tab=spell");
    const confirmations = [];
    const confirmPractice = async (dialog) => {
      confirmations.push({ type: dialog.type(), message: dialog.message() });
      if (
        dialog.type() === "confirm" &&
        /今天的旅程还没走完/.test(dialog.message())
      )
        await dialog.accept();
      else await dialog.dismiss();
    };
    page.once("dialog", confirmPractice);
    const previousSessionId = await page.evaluate(() => {
      const progress = JSON.parse(
        localStorage.getItem("word-atlas:v2:word-atlas-open") || "{}",
      );
      return progress.session?.id ?? null;
    });
    await click(
      page.getByRole("button", { name: "随机听写 12 词", exact: true }),
    );
    const field = page.getByLabel("听写", { exact: true });
    await field.waitFor();
    page.off("dialog", confirmPractice);
    assert.ok(
      confirmations.every(
        (d) => d.type === "confirm" && /今天的旅程还没走完/.test(d.message),
      ),
    );
    let target;
    await eventually(async () => {
      target = await page.evaluate((previousSessionId) => {
        const p = JSON.parse(
          localStorage.getItem("word-atlas:v2:word-atlas-open") || "{}",
        );
        return p.session?.practice &&
          p.session.id !== previousSessionId &&
          p.session.steps[p.session.index]?.kind === "dictation"
          ? p.session.steps[p.session.index].id
          : null;
      }, previousSessionId);
      return !!target;
    }, "fresh dictation session persisted before reading its expected answer");
    assert.ok(target);
    const index = JSON.parse(
        await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"),
      ),
      word = index.words.find((row) => row[0] === target)?.[1];
    assert.ok(word);
    await field.fill(word);
    await click(page.getByRole("button", { name: /^确认/ }));
    await page.getByRole("status").filter({ hasText: "答对了" }).waitFor();
    await click(page.getByRole("button", { name: "暂停并返回", exact: true }));
    return { day: point.vocabulary, id: target, correct: true };
  };
  const correct = async (source, n) => {
    await day(n);
    await navigate(page, "review");
    const panel = page.getByRole("region", { name: "订正任务", exact: true });
    await click(panel.getByRole("button", { name: /生成待订正任务/ }));
    let correction;
    await eventually(async () => {
      correction = (await heads(page, "correction")).find(
        (r) => r.payload.sourceRevisionId === source.revisionId,
      );
      return !!correction;
    }, "source correction generated");
    for (const item of correction.payload.items) {
      const area = panel
        .locator(`[data-correction-id="${correction.id}"]`)
        .getByRole("region", {
          name: `订正项 ${item.questionId}`,
          exact: true,
        });
      await click(
        area.getByRole("button", { name: "开始本项订正计时", exact: true }),
      );
      await area
        .getByLabel(`订正说明 question:${item.questionId}`, { exact: true })
        .fill(
          "I compared the original evidence, checked the word spelling and wrote the correct form. This is one correction, not mastery.",
        );
      await page.clock.fastForward(1100);
      await click(
        area.getByRole("button", { name: "完成本项订正", exact: true }),
      );
      await eventually(
        async () =>
          (await revision(page, correction.id)).payload.items.find(
            (v) => v.questionId === item.questionId,
          ).status === "corrected",
        "correction saved",
      );
    }
    return await revision(page, correction.id);
  };
  const retest = async (correction, n) => {
    await day(n);
    await navigate(page, "review");
    const round = page
        .getByRole("region", { name: "跨天新题复测", exact: true })
        .locator(`[data-retest-correction-id="${correction.id}"]`),
      anchor = round.getByRole("link", {
        name: "开始这份新题复测",
        exact: true,
      });
    await anchor.waitFor();
    assert.ok(
      await anchor.getAttribute("href"),
      "existing same-subject budget admits retest",
    );
    await click(anchor);
    const area = bench(page, "listening");
    await area.waitFor();
    let material;
    await eventually(async () => {
      const chosen = await area
        .getByLabel("练习材料", { exact: true })
        .inputValue();
      material = fixtures.materials.find(
        (candidate) => keyOf(candidate) === chosen,
      );
      return !!material;
    }, "exact locked retest material finishes loading");
    assert.ok(
      material &&
        material.skill === "listening" &&
        material.scope === "section",
    );
    assert.notEqual(material.contentHash, correction.contentHash);
    await click(
      area.getByRole("button", { name: "开始限时首答", exact: true }),
    );
    const answers = material.questions.map((q) => q.answer.accepted[0]);
    await fillAnswers(
      area.getByRole("region", { name: "作答题目", exact: true }),
      answers,
      material.questions.map((question) => question.number),
    );
    const play = area.getByRole("button", { name: /开始播放听力/ });
    await click(play);
    await area.getByRole("timer").filter({ hasText: /检查/ }).waitFor();
    await page.clock.fastForward(60100);
    await eventually(
      () =>
        area.getByRole("button", { name: "提交首答", exact: true }).isEnabled(),
      "retest audio check completed",
    );
    await click(area.getByRole("button", { name: "提交首答", exact: true }));
    await completeAB(
      page,
      answers,
      [],
      material.questions.map((question) => question.number),
    );
    const work = (await heads(page, "attempt")).find(
      (r) => r.payload.correctionId === correction.id && r.payload.retestOf,
    );
    assert.ok(work);
    assert.equal(work.payload.firstAttempt, true);
    await navigate(page, "review");
    const fresh = page
      .getByRole("region", { name: "跨天新题复测", exact: true })
      .locator(`[data-retest-correction-id="${correction.id}"]`);
    await click(
      fresh.getByRole("button", { name: "记录本次复测结果", exact: true }),
    );
    await eventually(
      async () =>
        (await revision(page, correction.id)).payload.items.every(
          (v) => v.status === "retested-pass",
        ),
      "same-type retest passed",
    );
    workIds.push(work.id);
    return {
      id: work.id,
      day: n,
      correctionId: correction.id,
      materialId: material.id,
    };
  };
  try {
    await fs.access(path.join(dist, "index.html"));
    fixtures = await makeR6SmokeFixtures(directory);
    await fs.writeFile(passwordFile, password, { mode: 0o600 });
    execFileSync(
      process.env.BAND_LEARNING_E2E_PYTHON || "python3",
      [
        "server/app.py",
        "--db",
        db,
        "--create-owner",
        username,
        "--password-file",
        passwordFile,
      ],
      {
        cwd: root,
        env: { ...process.env, BAND_SINGLE_USER: "1" },
        stdio: "pipe",
      },
    );
    await fs.rm(passwordFile);
    backend = spawn(
      process.env.BAND_LEARNING_E2E_PYTHON || "python3",
      [
        "server/app.py",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--db",
        db,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BAND_DB_PATH: db,
          BAND_PUBLIC_ORIGIN: origin,
          BAND_COOKIE_SECURE: "0",
          BAND_TRUST_PROXY: "0",
          BAND_ALLOW_REGISTER: "0",
          BAND_MAX_ACCOUNTS: "1",
          BAND_SINGLE_USER: "1",
          BAND_SITE_ROOT: dist,
          BAND_PRIVATE_ROOT: fixtures.privateRoot,
          BAND_ATLAS_ROOT: path.join(root, "public/atlas"),
          BAND_LEARNING_WRITES_ENABLED: "1",
          BAND_SETUP_TOKEN: "",
          BAND_SETUP_TOKEN_HASH: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [backend.stdout, backend.stderr])
      stream.on("data", (bytes) => {
        backendLog = (backendLog + bytes.toString()).slice(-50000);
      });
    await eventually(
      async () => (await fetch(`${origin}/api/health`)).ok,
      "isolated single-owner API started",
      20000,
    );
    const anonymous = await fetch(origin, { redirect: "manual" });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), "/login");
    assert.equal(
      (await fetch(`${origin}/api/learning/v2/records`)).status,
      401,
    );
    assert.equal((await fetch(`${origin}/private/manifest.json`)).status, 401);
    browser = await chromium.launch({
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: "chrome" }),
      headless: true,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: "allow",
      permissions: ["microphone"],
    });
    phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "allow",
    });
    for (const [ctx, label] of [
      [context, "desktop"],
      [phoneContext, "390px"],
    ]) {
      observe(ctx, label);
      await ctx.route("**/*", (r) =>
        new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
      );
      await ctx.addInitScript(
        ({ origin }) => {
          if (location.origin !== origin) return;
          if (!localStorage.getItem("word-atlas:settings"))
            localStorage.setItem(
              "word-atlas:settings",
              JSON.stringify({
                onboarded: true,
                autoplay: false,
                sfx: false,
                splash: false,
                ambience: "off",
                dailyNew: 3,
                feedbackMode: "rules",
              }),
            );
          window.SpeechRecognition = undefined;
          window.webkitSpeechRecognition = undefined;
          window.__r6Media = [];
          for (const name of ["play", "ended"])
            document.addEventListener(
              name,
              (e) => {
                const audio = e.target;
                if (
                  audio instanceof HTMLAudioElement &&
                  audio.dataset.testid === "listening-sequence-audio"
                )
                  window.__r6Media.push({
                    event: name,
                    label: audio.getAttribute("aria-label"),
                    trusted: e.isTrusted,
                    duration: audio.duration,
                    position: audio.currentTime,
                  });
              },
              true,
            );
        },
        { origin },
      );
    }
    page = await context.newPage();
    await page.clock.install({ time: dateFor(1) });
    phone = await phoneContext.newPage();
    await phone.clock.install({ time: dateFor(365) });
    phase = "single-owner login and candidate version";
    await login(page);
    const cookies = await context.cookies(origin);
    assert.ok(
      cookies.some((c) => c.httpOnly && c.path === "/" && c.sameSite === "Lax"),
    );
    await navigate(page, "me");
    const buildInfo = JSON.parse(
      await fs.readFile(path.join(dist, "build-info.json"), "utf8"),
    );
    assert.equal(buildInfo.version, "365.0.0-rc2");
    assert.match(buildInfo.fullCommit, /^[a-f0-9]{40}$/);
    const buildDisplay = page.getByTestId("about-build");
    await buildDisplay.waitFor();
    assert.match(await buildDisplay.innerText(), /365\.0\.0-rc2/);
    assert.ok(
      (await buildDisplay.innerText()).includes(
        buildInfo.fullCommit.slice(0, 9),
      ),
      "About displays the exact compiled source commit, not the later docs HEAD",
    );
    evidence.buildInfo = buildInfo;
    await navigate(page, "today");
    const setup = page.getByRole("region", {
      name: "开启 8.0 计划",
      exact: true,
    });
    await setup.getByLabel("开始日期", { exact: true }).fill(recipe.startDate);
    await click(
      setup.getByRole("button", { name: "开启 8.0 计划", exact: true }),
    );
    await page.locator('[data-task-id="d1-listening"]').waitFor();
    plan = (await heads(page, "plan"))[0];
    assert.ok(plan);
    await navigate(page, "progress");
    const form = page.getByRole("form", { name: "登记成绩", exact: true });
    await form.getByLabel("测评类型", { exact: true }).selectOption("official");
    for (const [label, value] of [
      ["听力", "5"],
      ["阅读", "7"],
      ["写作", "7"],
      ["口语", "7"],
    ])
      await form.getByLabel(`${label}分数`, { exact: true }).fill(value);
    await form
      .getByLabel("成绩材料标识", { exact: true })
      .fill("r6-synthetic-benchmark-not-a-real-exam");
    await form
      .getByLabel("成绩备注", { exact: true })
      .fill(
        "Synthetic disposable QA baseline used to exercise the normal weak-listening task. Not an actual learner result.",
      );
    await click(form.getByRole("button", { name: "保存成绩", exact: true }));
    await form
      .getByRole("status")
      .filter({ hasText: "成绩已保存在本机" })
      .waitFor();
    const assessmentsBefore = (await heads(page, "assessment")).map((r) => ({
      id: r.id,
      revisionId: r.revisionId,
      contentHash: r.contentHash,
      payload: r.payload,
    }));
    await prepareBank(page);
    await warm(page);
    evidence.privateFixture = {
      originalMaterials: fixtures.materials.length,
      prompts: fixtures.prompts.length,
      packed: fixtures.packed,
    };
    checks.push(
      "真实单用户登录、候选版本、固定120分钟计划及显式准备鉴权后的私有题库",
    );
    if (!historyOnly) {
      for (const point of recipe.points) {
        const entry = { checkpoint: point.checkpoint, actualDays: point };
        phase = `day${point.checkpoint} actual calendar and accessible workbenches`;
        await day(point.checkpoint);
        const today = page.getByRole("region", {
          name: "365天学习计划",
          exact: true,
        });
        const tasks = await today
          .locator("[data-task-id] h3")
          .allTextContents();
        assert.equal(
          tasks.reduce(
            (sum, text) =>
              sum + Number(text.match(/·\s*(\d+)\s*分钟/)?.[1] ?? 0),
            0,
          ),
          120,
        );
        entry.tasks = tasks;
        await navigate(page, routeFor("writing", point.checkpoint));
        const writingBench = page.getByRole("region", {
          name: "写作工作台",
          exact: true,
        });
        await writingBench.waitFor();
        // Since 879abe2cf a route without a task opens anytime practice: a day
        // without a writing block is no longer a locked page.
        if ([1, 365].includes(point.checkpoint)) {
          await eventually(
            async () => /自主练习/.test(await writingBench.innerText()),
            `day${point.checkpoint} writing opens anytime practice`,
          );
          assert.match(await writingBench.innerText(), /不完成当天课程任务/);
        }
        await navigate(page, routeFor("speaking", point.checkpoint));
        const speakingBench = page.getByRole("region", {
          name: "口语练习",
          exact: true,
        });
        await speakingBench.waitFor();
        if ([1, 365].includes(point.checkpoint)) {
          await eventually(
            async () => /自主练习/.test(await speakingBench.innerText()),
            `day${point.checkpoint} speaking opens anytime practice`,
          );
          assert.match(await speakingBench.innerText(), /不完成当天课程任务/);
        }
        phase = `day${point.checkpoint} full listening and reading`;
        const parts = fixtures.materials
          .filter((m) => m.examId === `R6-D${point.checkpoint}-ORIGINAL`)
          .sort((a, b) => a.section - b.section);
        const full = {
          ...parts[0],
          id: `sequence-cambridge-r6-d${point.checkpoint}-original`,
          scope: "full",
          questions: parts.flatMap((p) => p.questions),
          __sequence: true,
        };
        const listeningWork = await listen(full, point.listening, [1, 2]);
        assert.equal(listeningWork.payload.total, 40);
        firstListening ??= listeningWork;
        entry.listening = {
          id: listeningWork.id,
          day: point.listening,
          score: listeningWork.payload.score,
          scope: listeningWork.payload.scope,
        };
        const readingMaterial = fixtures.materials.find(
            (m) => m.id === `r6-d${point.checkpoint}-reading`,
          ),
          readingArea = await choose("reading", point.reading, readingMaterial);
        await click(
          readingArea.getByRole("button", {
            name: "开始限时首答",
            exact: true,
          }),
        );
        await fillAnswers(
          readingArea.getByRole("region", { name: "作答题目", exact: true }),
          Array(40).fill("TRUE"),
        );
        await page.clock.fastForward(1100);
        await click(
          readingArea.getByRole("button", { name: "提交首答", exact: true }),
        );
        const readingWork = await savedFor(readingMaterial);
        assert.equal(readingWork.payload.score, 40);
        assert.equal(readingWork.payload.scope, "full");
        await completeAB(page, Array(40).fill("TRUE"));
        entry.reading = { id: readingWork.id, day: point.reading, total: 40 };
        phase = `day${point.checkpoint} correction and fresh next-valid-day retest`;
        const correction = await correct(listeningWork, point.correction);
        entry.retest = await retest(correction, point.retest);
        assert.ok(point.retest > point.correction);
        assert.equal(
          (await revision(page, listeningWork.id)).payload.score,
          38,
        );
        phase = `day${point.checkpoint} Task2 estimate and P1-P3 real recordings`;
        entry.writing = await write(point);
        entry.speaking = await speak(point);
        entry.dictation = await dictation(point);
        entry.width = await width(page);
        evidence.points.push(entry);
        checks.push(
          `第${point.checkpoint}天真实预算与页面；合法同科日完整听读、订正新题、Task2自评估分、P1–P3短录及单词听写`,
        );
      }
      phase = "365-day upper boundary";
      await day(366);
      await page
        .getByRole("region", { name: "365天学习计划", exact: true })
        .getByText(/365天计划日历已结束/)
        .waitFor();
      const beforeBoundary = (await heads(page, "attempt")).map(
        (r) => r.revisionId,
      );
      await navigate(page, routeFor("listening", 366));
      await bench(page, "listening").waitFor();
      const start = bench(page, "listening").getByRole("button", {
        name: "开始限时首答",
        exact: true,
      });
      if (await start.count()) assert.equal(await start.isEnabled(), false);
      assert.deepEqual(
        (await heads(page, "attempt")).map((r) => r.revisionId),
        beforeBoundary,
      );
      evidence.day366 = {
        active: false,
        newAttempts: 0,
        explanation:
          "Day365 subject coverage uses legal adjacent days; no fabricated day366 retest or altered calendar.",
      };
      phase = "authenticated private Range and real offline cached listening";
      await day(365);
      await navigate(
        page,
        routeFor("listening", Number(firstListening.payload.day), {
          work: firstListening.id,
        }),
      );
      await review(page).waitFor();
      const sample = JSON.parse(
        await fs.readFile(
          path.join(fixtures.privateRoot, "manifest.json"),
          "utf8",
        ),
      ).audioTransports[0];
      const range = await page.evaluate(async (url) => {
        const r = await fetch(url, {
          headers: { Range: "bytes=0-31" },
          credentials: "same-origin",
          cache: "no-store",
        });
        return {
          status: r.status,
          bytes: (await r.arrayBuffer()).byteLength,
          range: r.headers.get("content-range"),
        };
      }, sample.path);
      assert.equal(range.status, 206);
      assert.equal(range.bytes, 32);
      await warm(page);
      await context.setOffline(true);
      const response = await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(response?.fromServiceWorker(), true);
      evidence.offlineAudioSets = [];
      for (const point of evidence.points.slice(0, 3)) {
        await navigate(
          page,
          routeFor("listening", point.listening.day, {
            work: point.listening.id,
          }),
        );
        await review(page).waitFor();
        const decodedParts = [];
        for (let part = 0; part < 4; part++) {
          await page
            .getByLabel("回听分节", { exact: true })
            .selectOption(String(part));
          const element = page.locator(
            `audio[aria-label="第${part + 1}节听力音频"]`,
          );
          await eventually(
            () => element.evaluate((a) => a.readyState >= 1),
            "offline cached audio metadata",
          );
          await element.evaluate(async (a) => {
            a.muted = true;
            a.currentTime = 0.2;
            await a.play();
          });
          await eventually(
            () => element.evaluate((a) => a.currentTime > 0.3 && !a.error),
            "offline cached audio actually plays after seeking",
          );
          decodedParts.push(
            await element.evaluate((a) => ({
              part: a.getAttribute("aria-label"),
              duration: a.duration,
              position: a.currentTime,
            })),
          );
          await element.evaluate((a) => a.pause());
        }
        evidence.offlineAudioSets.push({
          workId: point.listening.id,
          parts: decodedParts,
        });
      }
      await context.setOffline(false);
      evidence.privateRange = range;
      checks.push(
        "鉴权私有AAC Range206；真实SW断网刷新后从账号IDB切换、拖动并回听3套12节，原始题库hash保持不变",
      );
      phase = "expired login retains exact outbox and reconnects";
      await day(365);
      await navigate(
        page,
        routeFor("writing", Number(lastWriting.payload.day), {
          work: lastWriting.id,
        }),
      );
      const writing = page.getByRole("region", {
        name: "写作工作台",
        exact: true,
      });
      await writing.waitFor();
      await click(
        writing.getByRole("button", { name: "写修改稿", exact: true }),
      );
      await context.setOffline(true);
      await writing
        .getByLabel("作文正文", { exact: true })
        .fill(
          recipe.essay +
            " This final sentence is an offline revision in a temporary QA account.",
        );
      await click(
        writing.getByRole("button", { name: "提交修改稿", exact: true }),
      );
      await eventually(
        async () => (await scope(page)).outbox.length > 0,
        "offline revision queued",
      );
      const queued = (await scope(page)).outbox.map((q) => ({
        recordId: q.recordId,
        body: q.body,
      }));
      execFileSync(process.env.BAND_LEARNING_E2E_PYTHON || "python3", [
        "-c",
        'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.execute("UPDATE sessions SET expires_at=0"); c.commit(); c.close()',
        db,
      ]);
      await context.setOffline(false);
      await eventually(
        async () =>
          page.evaluate(
            async () =>
              (await fetch("/api/learning/v2/records", { cache: "no-store" }))
                .status === 401,
          ),
        "real session expiration denies API",
      );
      await navigate(page, "me");
      await eventually(
        async () =>
          /请重新登录|重新登录|登录并同步/.test(
            await page
              .getByRole("region", { name: "学习进度同步", exact: true })
              .innerText(),
          ),
        "expired session visibly requests login again",
      );
      const afterExpiration = (await scope(page)).outbox.map((q) => ({
        recordId: q.recordId,
        body: q.body,
      }));
      assert.deepEqual(afterExpiration, queued);
      await login(page);
      await eventually(
        async () => (await scope(page)).outbox.length === 0,
        "reauthenticated outbox acknowledged",
      );
      const synced = await allServerRecords(page, "changes");
      for (const q of queued)
        assert.equal(
          synced.filter((r) => r.revisionId === q.body.revisionId).length,
          1,
        );
      evidence.expiration = {
        preserved: queued.length,
        acknowledgedExactlyOnce: true,
      };
      checks.push(
        "真实服务端会话过期拒绝API，离线修改的原始outbox不变，重新登录自动同步且不重复",
      );
      phase = "390px second context synchronization";
      await login(phone);
      await prepareBank(phone);
      await navigate(phone, "today");
      await phone.locator('[data-task-id^="d365-"]').first().waitFor();
      evidence.phone = { today: await width(phone) };
      for (const route of [
        "progress",
        "review?tab=weekly",
        "writing",
        "speaking",
        routeFor("listening", Number(firstListening.payload.day), {
          work: firstListening.id,
        }),
        routeFor("reading", evidence.points.at(-1).reading.day, {
          work: evidence.points.at(-1).reading.id,
        }),
      ]) {
        await navigate(phone, route);
        if (route === "progress")
          await phone
            .getByRole("region", { name: "最终目标差距", exact: true })
            .waitFor();
        if (route.startsWith("review"))
          await phone
            .getByRole("heading", { name: "订正与校准", exact: true })
            .waitFor();
        if (route === "writing")
          await phone
            .getByRole("region", { name: "写作工作台", exact: true })
            .waitFor();
        if (route === "speaking")
          await phone
            .getByRole("region", { name: "口语练习", exact: true })
            .waitFor();
        if (route.startsWith("listening")) {
          await bench(phone, "listening").waitFor();
          await review(phone).waitFor();
        }
        if (route.startsWith("reading")) {
          await bench(phone, "reading").waitFor();
          await review(phone).waitFor();
        }
        evidence.phone[route] = await width(phone);
      }
      await navigate(phone, "speaking");
      const openSpeaking = phone
        .getByTestId("speaking-work-list")
        .locator("button[data-work-id]")
        .first();
      await openSpeaking.evaluate((element) =>
        element.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant",
        }),
      );
      await click(openSpeaking);
      await phone
        .getByRole("article", { name: "当前口语作答", exact: true })
        .waitFor();
      await phone.getByText(/录音在另一台设备/).waitFor();
      evidence.phone.savedSpeakingButtonClickable = true;
      await eventually(async () => {
        const value = await scope(phone);
        return workIds.every((id) => value?.heads[id]);
      }, "second context receives every real UI work");
      const expectedCorrections = (await heads(page, "correction")).filter(
        (record) =>
          evidence.points.some(
            (point) => point.retest.correctionId === record.id,
          ),
      );
      assert.equal(expectedCorrections.length, 4);
      await eventually(async () => {
        const value = await scope(phone);
        return expectedCorrections.every(
          (record) =>
            value?.heads[record.id]?.revisionId === record.revisionId &&
            value.heads[record.id].payload.items.every(
              (item) => item.status === "retested-pass",
            ),
        );
      }, "second context receives the exact four completed correction revisions");
      checks.push(
        "第二个390px触摸上下文读到本轮全部作品和订正，各主页面无横向溢出；不冒称真实iPhone验收",
      );
    } else {
      await login(phone);
      await prepareBank(phone);
    }
    phase = "15000 synthetic historical records over365days";
    await navigate(phone, "about");
    await day(365);
    await navigate(page, "progress");
    const qualifiedGoalBeforeHistory = await page
      .getByRole("region", { name: "最终目标差距", exact: true })
      .innerText();
    await navigate(page, "today");
    await eventually(
      async () => (await scope(page)).outbox.length === 0,
      "before history sync empty",
    );
    const beforeHistory = (await heads(page)).map(
      ({ id, kind, revisionId, contentHash, payload }) => ({
        id,
        kind,
        revisionId,
        contentHash,
        payload,
      }),
    );
    const seeded = await seedHistory(
      origin,
      await cookieHeader(context, origin),
      plan.id,
    );
    evidence.historySeed = {
      count: seeded.count,
      seconds: seeded.seconds,
      kinds: Object.keys(seeded.kinds),
      setupConcurrency: seeded.concurrency,
      kindCounts: seeded.kinds,
      planId: seeded.planId,
      dateRange: [seeded.startDate, seeded.endDate],
      existingKindCounts: beforeHistory.reduce(
        (counts, row) => ({
          ...counts,
          [row.kind]: (counts[row.kind] ?? 0) + 1,
        }),
        {},
      ),
      note: "Only benchmark setup writes via real API; all current-subject submissions above used UI.",
    };
    await page.reload({ waitUntil: "networkidle" });
    await eventually(
      async () => (await scope(page, true)).historyCount === 15000,
      "all15000 history records reach account IDB",
      300000,
    );
    await eventually(
      async () => (await scope(phone, true)).historyCount === 15000,
      "second context receives all15000 historical records",
      300000,
    );
    const phoneHistory = await scope(phone, true);
    assert.equal(phoneHistory.historyIds, 15000);
    assert.equal(phoneHistory.historyRevisions, 15000);
    const local = await heads(page),
      history = local.filter((r) => r.id.startsWith("r6-history-"));
    assert.equal(history.length, 15000);
    assert.equal(new Set(history.map((r) => r.id)).size, 15000);
    assert.equal(new Set(history.map((r) => r.revisionId)).size, 15000);
    const afterHistoryById = new Map(
      local.map(({ id, kind, revisionId, contentHash, payload }) => [
        id,
        { id, kind, revisionId, contentHash, payload },
      ]),
    );
    for (const record of beforeHistory)
      assert.deepEqual(
        afterHistoryById.get(record.id),
        record,
        `history import changed existing ${record.kind} ${record.id}`,
      );
    const seededIds = new Set(seeded.revisionIds);
    assert.ok(history.every((r) => seededIds.has(r.revisionId)));
    const serverHistory = (await allServerRecords(page)).filter((r) =>
      r.id.startsWith("r6-history-"),
    );
    assert.equal(serverHistory.length, 15000);
    assert.equal(new Set(serverHistory.map((r) => r.id)).size, 15000);
    const signature = ({ id, kind, revisionId, contentHash }) => ({
      id,
      kind,
      revisionId,
      contentHash,
    });
    const phoneRecordsById = new Map(
      (await heads(phone)).map((record) => [record.id, signature(record)]),
    );
    for (const record of local)
      assert.deepEqual(
        phoneRecordsById.get(record.id),
        signature(record),
        `second device changed the revision/hash of ${record.id}`,
      );
    const serverHistoryById = new Map(
      serverHistory.map((record) => [record.id, signature(record)]),
    );
    for (const record of history)
      assert.deepEqual(
        serverHistoryById.get(record.id),
        signature(record),
        `server changed the historical revision/hash of ${record.id}`,
      );
    evidence.historySeed.allReplicaRevisionHashesMatch = true;
    assert.deepEqual(
      (await heads(page, "assessment"))
        .filter((record) =>
          assessmentsBefore.some((original) => original.id === record.id),
        )
        .map((r) => ({
          id: r.id,
          revisionId: r.revisionId,
          contentHash: r.contentHash,
          payload: r.payload,
        })),
      assessmentsBefore,
    );
    assert.equal(
      history.filter((record) => record.kind === "assessment").length,
      35,
    );
    await navigate(page, "progress");
    assert.equal(
      await page
        .getByRole("region", { name: "最终目标差距", exact: true })
        .innerText(),
      qualifiedGoalBeforeHistory,
      "Unqualified self-estimates must not replace the qualified goal gaps",
    );
    evidence.historySeed.qualifiedGoalPreserved = true;
    evidence.performance = [];
    for (const [route, selector] of [
      ["today", '[data-task-id^="d365-"]'],
      ["progress", '[aria-label="最终目标差距"]'],
      ["review?tab=weekly", '[aria-label="本周校准"]'],
    ]) {
      await navigate(page, "about");
      await page.locator(".page.about").waitFor();
      const start = performance.now();
      await navigate(page, route);
      await page.locator(selector).first().waitFor();
      if (route === "review?tab=weekly") await weeklyReady(page);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const elapsed = performance.now() - start;
      evidence.performance.push({
        route,
        firstScreenMs: Math.round(elapsed),
        historyHeads: 15000,
      });
      assert.ok(
        elapsed < 2000,
        `${route} first screen ${elapsed.toFixed(1)}ms exceeds2000 after15000 history records`,
      );
      await width(page);
      if (route === "review?tab=weekly") {
        // Detailed statistics are deliberately folded below the visible overview.
        // Time the actual first screen, then exercise its disclosure as a user.
        await click(
          page.getByText("近28天题型、错因与订正复测", { exact: true }),
        );
        await page
          .getByRole("region", { name: "阅读周统计", exact: true })
          .waitFor();
      }
    }
    const reloadStart = performance.now();
    await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-task-id^="d365-"]').first().waitFor();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const reloadElapsed = performance.now() - reloadStart;
    evidence.performance.push({
      route: "cold-reload-today",
      firstScreenMs: Math.round(reloadElapsed),
      historyHeads: 15000,
    });
    assert.ok(
      reloadElapsed < 2000,
      `cold today first screen ${reloadElapsed.toFixed(1)}ms exceeds2000 after15000 history records`,
    );
    await eventually(
      async () => (await scope(page, true)).historyCount === 15000,
      "durable history reload",
    );
    evidence.phone ??= {};
    evidence.phone.historyPages = {};
    for (const [route, selector] of [
      ["today", '[data-task-id^="d365-"]'],
      ["progress", '[aria-label="最终目标差距"]'],
      ["review?tab=weekly", '[aria-label="本周校准"]'],
    ]) {
      await navigate(phone, route);
      await phone.locator(selector).first().waitFor();
      if (route === "review?tab=weekly") {
        await weeklyReady(phone);
        await click(
          phone.getByText("近28天题型、错因与订正复测", { exact: true }),
        );
        await phone
          .getByRole("region", { name: "阅读周统计", exact: true })
          .waitFor();
      }
      evidence.phone.historyPages[route] = await width(phone);
    }
    assert.equal((await scope(page)).outbox.length, 0);
    checks.push(
      "365天15000条合成历史经真实API/IDB同步无丢失或重复，今日/统计/周校准首屏均小于2秒",
    );
    assert.deepEqual(external, []);
    assert.deepEqual(pageErrors, []);
    if (!historyOnly) assert.ok(privateResponses.some((r) => r.status === 206));
    assert.ok(privateResponses.every((r) => !r.worker));
    evidence.historySeed.revisionIds = undefined;
    evidence.workerPrivateCaching =
      "No private fetch response came from the global Service Worker; decoded audio lives in account IDB.";
    evidence.fourPartNaturalMedia = mediaEvents;
    success = true;
  } catch (error) {
    failure = error.stack ?? String(error);
    evidence.backend = {
      exitCode: backend?.exitCode,
      signalCode: backend?.signalCode,
      outputTail: backendLog,
    };
    if (error.cause)
      evidence.errorCause = {
        message: String(error.cause.message ?? error.cause),
        code: error.cause.code,
        errno: error.cause.errno,
        syscall: error.cause.syscall,
      };
    evidence.failureUrl = page?.url();
    evidence.failureText = await page
      ?.locator("body")
      .innerText()
      .then((v) => v.slice(-14000))
      .catch(() => null);
    const image = path.join(
      os.tmpdir(),
      `band-r6-failure-${randomBytes(4).toString("hex")}.png`,
    );
    await page?.screenshot({ path: image, fullPage: true }).then(
      () => {
        evidence.failureScreenshot = image;
      },
      () => {},
    );
  } finally {
    await Promise.all([
      context?.close().catch(() => null),
      phoneContext?.close().catch(() => null),
    ]);
    await browser?.close().catch(() => null);
    if (web) await new Promise((resolve) => web.httpServer.close(resolve));
    await stop(backend);
    await fs.rm(directory, { recursive: true, force: true });
  }
  const result = {
    suite: "R6 production release yearly smoke and durable history",
    mode: historyOnly
      ? "development-history-probe-only"
      : "full-yearly-release",
    success,
    durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    pageErrors,
    checks,
    evidence,
    ...(failure ? { failedPhase: phase, error: failure } : {}),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (
    !(
      await runR6ReleaseE2E({
        historyOnly: process.argv.includes("--history-probe"),
      })
    ).success
  )
    process.exitCode = 1;
}
