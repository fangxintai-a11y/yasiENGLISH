#!/usr/bin/env node
/** R5 production UI acceptance. Disposable API/SQLite/accounts, self-authored materials.
 * Learning/bank/progress writes use visible UI only. IDB/API access below is read-only.
 * Media runs in real wall time; clock advancement is only for civil days and final checks.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const root = path.resolve(process.env.BAND_R5_E2E_ROOT || scriptRoot);
const require = createRequire(path.join(root, "package.json"));
const { chromium } = require("playwright");
const { preview } = await import(pathToFileURL(require.resolve("vite")).href);
const { zipSync, strToU8 } = require("fflate");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dateAt = (day) =>
  new Date(`2026-11-${String(day).padStart(2, "0")}T04:00:00Z`);
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : (JSON.stringify(value) ?? "null");
const materialKey = (material) =>
  `${material.id}@${material.version}@${material.contentHash}`;
const courseRoute = (skill, day, material) =>
  `${skill}?${new URLSearchParams({
    date: new Date(Date.UTC(2026, 10, day + 8)).toISOString().slice(0, 10),
    day: String(day),
    task: `d${day}-${skill}`,
    ...(material ? { material: materialKey(material) } : {}),
  })}`;
async function revealMaterialPicker(area) {
  const details = area.locator("details.r4-material-options");
  if (!(await details.evaluate((element) => element.open)))
    await click(area.getByText("查看或更换材料（可选）", { exact: true }));
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
async function eventually(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await delay(150);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => null);
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function click(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
}
async function localScope(page) {
  return page.evaluate(
    async () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("band-learning-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("scopes", "readonly"),
            rows = [],
            cursor = tx.objectStore("scopes").openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            if (String(item.key).startsWith("account:"))
              rows.push({ key: item.key, ...item.value });
            item.continue();
          };
          tx.oncomplete = () => {
            db.close();
            resolve(rows[0] ?? null);
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}
async function heads(page, kind) {
  return Object.values((await localScope(page))?.heads ?? {}).filter(
    (item) => (!kind || item.kind === kind) && !item.deleted && !item.conflict,
  );
}
async function headFor(page, contentId) {
  return (await heads(page, "attempt"))
    .filter((item) => item.payload.contentId === contentId)
    .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)[0];
}
async function byId(page, id) {
  return (await localScope(page))?.heads[id];
}
async function serverRecords(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/learning/v2/records", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`records ${response.status}`);
    return (await response.json()).items;
  });
}
async function navigate(page, target) {
  await page.evaluate((target) => {
    location.hash = `#/${target}`;
  }, target);
}
async function noOverflow(page) {
  let stable = 0;
  await eventually(
    async () => {
      const value = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        offset: visualViewport?.offsetLeft ?? 0,
      }));
      stable =
        value.scroll <= value.width && value.offset === 0 ? stable + 1 : 0;
      return stable >= 2;
    },
    "mobile page overflowed",
    5000,
  );
  const value = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    offset: visualViewport?.offsetLeft ?? 0,
  }));
  assert.ok(
    value.scroll <= value.width,
    `mobile page overflowed: ${value.scroll}px > ${value.width}px`,
  );
  assert.equal(value.offset, 0);
  return value;
}
const bench = (page, skill) =>
  page.getByRole("region", {
    name: `${skill === "reading" ? "阅读" : "听力"}练习`,
    exact: true,
  });
const review = (page) =>
  page.getByRole("region", { name: "听读 A-B 复盘", exact: true });
const corrections = (page) =>
  page.getByRole("region", { name: "订正任务", exact: true });
const correctionArticle = (page, id) =>
  corrections(page).locator(`[data-correction-id="${id}"]`);
const retestArticle = (page, id) =>
  page
    .getByRole("region", { name: "跨天新题复测", exact: true })
    .locator(`[data-retest-correction-id="${id}"]`);
async function fillAnswers(area, values) {
  for (const [number, value] of values.entries()) {
    const control = area.getByLabel(`第${number + 1}题`, { exact: true });
    if (await control.evaluate((element) => element.tagName === "SELECT"))
      await control.selectOption(value);
    else await control.fill(value);
  }
}
async function completeAB(page, answers, wrongNumbers = [], disputeNumber) {
  const area = review(page);
  await area
    .getByRole("heading", { name: "A轮：先自己改答案", exact: true })
    .waitFor();
  assert.equal(await area.getByText(/接受答案：/).count(), 0);
  await fillAnswers(area, answers);
  await click(
    area.getByRole("button", { name: "保存A轮，查看答案", exact: true }),
  );
  for (const number of wrongNumbers)
    await area
      .getByLabel(`第${number}题错因`, { exact: true })
      .selectOption("synonym-miss");
  if (disputeNumber) {
    await area
      .getByLabel(`第${disputeNumber}题答案存疑`, { exact: true })
      .check();
    await area
      .getByLabel(`第${disputeNumber}题说明`, { exact: true })
      .fill(
        "Self-authored fixture statement contradicts its supplied key; independently inspect the evidence.",
      );
  }
  await click(area.getByRole("button", { name: "完成B轮复盘", exact: true }));
  await area.getByRole("status").filter({ hasText: "复盘已保存" }).waitFor();
}
async function prepareWavs(page) {
  const generated = await page.evaluate(async () => {
    const bytes = await (
        await fetch("/curriculum365/v1/audio/listening-sample-01.mp3")
      ).arrayBuffer(),
      audio = new AudioContext();
    try {
      const decoded = await audio.decodeAudioData(bytes),
        results = [],
        frames = Math.floor(decoded.sampleRate),
        samples = decoded.getChannelData(0);
      if (decoded.length < frames * 4)
        throw new Error("Project audio is shorter than four seconds.");
      for (let part = 0; part < 4; part++) {
        const buffer = new ArrayBuffer(44 + frames * 2),
          view = new DataView(buffer);
        const ascii = (offset, value) =>
          [...value].forEach((char, index) =>
            view.setUint8(offset + index, char.charCodeAt(0)),
          );
        ascii(0, "RIFF");
        view.setUint32(4, 36 + frames * 2, true);
        ascii(8, "WAVE");
        ascii(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, decoded.sampleRate, true);
        view.setUint32(28, decoded.sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        ascii(36, "data");
        view.setUint32(40, frames * 2, true);
        for (let index = 0; index < frames; index++) {
          const value = Math.max(
            -1,
            Math.min(1, samples[part * frames + index]),
          );
          view.setInt16(
            44 + index * 2,
            value < 0 ? Math.round(value * 32768) : Math.round(value * 32767),
            true,
          );
        }
        const raw = new Uint8Array(buffer);
        let binary = "";
        for (let offset = 0; offset < raw.length; offset += 32768)
          binary += String.fromCharCode(
            ...raw.subarray(offset, offset + 32768),
          );
        results.push({
          base64: btoa(binary),
          duration: (await audio.decodeAudioData(buffer.slice(0))).duration,
          sampleRate: decoded.sampleRate,
        });
      }
      return results;
    } finally {
      await audio.close();
    }
  });
  const values = generated.map((item, index) => {
    const bytes = Buffer.from(item.base64, "base64");
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
    assert.equal(item.duration, 1);
    return {
      path: `audio/r5-s${index + 1}.wav`,
      bytes,
      duration: item.duration,
      sha256: sha(bytes),
      sampleRate: item.sampleRate,
    };
  });
  assert.equal(
    new Set(values.map((value) => value.sha256)).size,
    4,
    "four source excerpts must have distinct actual audio bytes",
  );
  return values;
}
function bankZip(materials, wavs) {
  const bank = strToU8(JSON.stringify({ importVersion: 1, materials })),
    content = { "bank.json": bank };
  for (const wav of wavs) content[wav.path] = new Uint8Array(wav.bytes);
  const files = Object.entries(content).map(([name, bytes]) => ({
    path: name,
    bytes: bytes.length,
    sha256: sha(bytes),
  }));
  return Buffer.from(
    zipSync(
      {
        "manifest.json": strToU8(
          JSON.stringify({
            format: "band-galaxy-local-bank",
            version: 1,
            files,
          }),
        ),
        ...content,
      },
      { level: 6 },
    ),
  );
}
async function completeLRItem(page, correctionId, questionId) {
  const item = correctionArticle(page, correctionId).getByRole("region", {
    name: `订正项 ${questionId}`,
    exact: true,
  });
  await click(
    item.getByRole("button", { name: "开始本项订正计时", exact: true }),
  );
  await item
    .getByLabel(`订正说明 question:${questionId}`, { exact: true })
    .fill(
      "I compared the statement with the original evidence and wrote the equivalent wording. This is correction, not evidence of mastery.",
    );
  await page.clock.fastForward(1100);
  await click(item.getByRole("button", { name: "完成本项订正", exact: true }));
  await eventually(
    async () =>
      (await byId(page, correctionId)).payload.items.find(
        (value) => value.questionId === questionId,
      )?.status === "corrected",
    "LR item correction did not persist",
  );
}
async function selfReview(page, causes) {
  const area = page.getByRole("region", {
    name: "写作体检与自查",
    exact: true,
  });
  await area.waitFor();
  await eventually(
    async () => (await area.innerText()).includes("标注错因"),
    "writing rules/self-check not ready",
  );
  for (const checkbox of await area.getByRole("checkbox").all())
    await checkbox.uncheck();
  if (causes.includes("grammar"))
    await area.getByLabel("语法", { exact: true }).check();
  await click(area.getByRole("button", { name: "拼写已检查", exact: true }));
  await area.getByLabel("自评语法", { exact: true }).selectOption("8");
  await click(area.getByRole("button", { name: "保存自查", exact: true }));
  await area
    .getByRole("status")
    .filter({ hasText: "自查已保存在本机" })
    .waitFor();
}
const originalParagraph =
  "I agree that libraries should extend their evening hours because working people need a quiet place after their shifts. A late service gives them access to books and shared desks without another monthly fee. However, the council should first ask residents which nights they can attend. For example, a short trial could compare visits on two evenings before the library adds more staff. This approach supports adult learners while allowing the public budget to follow clear evidence.";
const correctedParagraph =
  "I agree that libraries should extend their evening hours because adults who work during the day need a quiet place to study after their shifts. Evening access would let them use books and shared desks without paying another monthly fee. Before changing the timetable, the council should ask residents which nights they would actually attend. A trial on two evenings could then measure demand and staffing costs. This approach would support adult learners while linking the public budget to clear evidence.";
const retestParagraph =
  "I agree that councils should offer free sports lessons because the cost of joining a club can prevent adults from exercising regularly. A short course would give beginners a safe place to learn basic movements and build a weekly routine. Councils should begin with existing community facilities and compare attendance across a few trial sessions. They could then keep the classes that residents use most often. This would improve access while giving officials evidence for each spending decision.";
export async function runR5CorrectionCalibrationE2E() {
  const runStarted = process.hrtime.bigint();
  const dist = path.resolve(
    process.env.BAND_R5_E2E_DIST || path.join(root, "dist"),
  );
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  assert.ok(apiPort > 1024 && webPort > 1024 && webPort !== apiPort);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "band-r5-e2e-"));
  const origin = `http://127.0.0.1:${webPort}`,
    apiOrigin = `http://127.0.0.1:${apiPort}`,
    dbPath = path.join(directory, "learning.sqlite3");
  const username = `r5_${randomBytes(6).toString("hex")}`,
    password = randomBytes(24).toString("base64url"),
    setupToken = randomBytes(24).toString("base64url");
  const checks = [],
    evidence = {},
    errors = [],
    external = [],
    learningRequests = [],
    privateReplies = [],
    fixtureGets = [];
  let backend,
    previewServer,
    browser,
    desktopContext,
    phoneContext,
    desktop,
    phone,
    wavs = [],
    materials = [],
    prompts = [],
    success = false,
    failure,
    phase = "prerequisites";
  const observe = (context, label) => {
    context.on("page", (page) =>
      page.on("pageerror", (error) =>
        errors.push(`${label}: ${error.message}`),
      ),
    );
    context.on("request", (request) => {
      if (!/^https?:/.test(request.url())) return;
      const url = new URL(request.url());
      if (url.origin !== origin) external.push(url.origin);
      if (url.pathname.startsWith("/api/learning/") && request.postDataBuffer())
        learningRequests.push({
          type: request.headers()["content-type"] ?? "",
          body: request.postDataBuffer(),
        });
    });
    context.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/learning/"))
        privateReplies.push({
          status: response.status(),
          cache: response.headers()["cache-control"] ?? "",
          worker: response.fromServiceWorker(),
        });
    });
  };
  const login = async (page, create) => {
    await page.goto(`${origin}/#/me`, { waitUntil: "networkidle" });
    const panel = page.getByRole("region", {
      name: "学习进度同步",
      exact: true,
    });
    await panel.waitFor();
    if (create)
      await click(panel.getByRole("button", { name: "首次设置", exact: true }));
    await panel.locator('input[name="username"]').fill(username);
    await panel.locator('input[name="password"]').fill(password);
    if (create)
      await panel.locator('input[name="setup-token"]').fill(setupToken);
    await click(
      panel.getByRole("button", {
        name: create ? "创建账号并同步" : "登录并同步",
        exact: true,
      }),
    );
    await eventually(
      async () => (await panel.innerText()).includes(`已登录 ${username}`),
      "UI login did not finish",
    );
    await eventually(
      async () => !!(await localScope(page)),
      "account scope not ready",
    );
  };
  const importFixtures = async (page) => {
    await navigate(page, "me");
    const bank = page.getByRole("region", { name: "本机题库", exact: true });
    await bank
      .getByLabel("选择题库文件", { exact: true })
      .setInputFiles(path.join(directory, "bank.zip"));
    await eventually(
      async () => /已导入8份/.test(await bank.innerText()),
      "Me ZIP import did not report eight materials",
    );
    const panel = page.getByRole("region", {
      name: "本机写说题库",
      exact: true,
    });
    await panel
      .getByLabel("选择写说题库JSON", { exact: true })
      .setInputFiles(path.join(directory, "prompts.json"));
    await eventually(
      async () => /已导入2份写说题目/.test(await panel.innerText()),
      "Me prompt import did not report two writing prompts",
    );
  };
  const warm = async (page) => {
    await page.evaluate(async () => {
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
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      await page.evaluate(() => !!navigator.serviceWorker.controller),
      true,
    );
  };
  const choose = async (page, day, skill, id) => {
    const original = materials.find((item) => item.id === id);
    await navigate(page, courseRoute(skill, day, original));
    const area = bench(page, skill);
    await area.waitFor();
    await revealMaterialPicker(area);
    await area
      .getByLabel("练习材料", { exact: true })
      .selectOption(materialKey(materials.find((item) => item.id === id)));
    return area;
  };
  const newDay = async (page, day) => {
    await page.clock.setSystemTime(dateAt(day));
    await page.reload({ waitUntil: "networkidle" });
    await navigate(page, "today");
    await eventually(
      async () =>
        (await page
          .getByLabel("查看学习日期", { exact: true })
          .inputValue()) === `2026-11-${String(day).padStart(2, "0")}`,
      "new civil date did not update the active plan",
    );
  };
  const goReview = async (page, tab = "") => {
    await navigate(page, `review${tab ? `?tab=${tab}` : ""}`);
    await page
      .getByRole("heading", { name: "订正与校准", exact: true })
      .waitFor();
  };
  const progressSnapshot = async (page) => {
    await navigate(page, "progress");
    const gap = page.getByRole("region", { name: "最终目标差距", exact: true }),
      gate = page.getByRole("region", { name: "下一个门槛", exact: true }),
      book = page.getByRole("region", { name: "成绩本", exact: true });
    await gap.waitFor();
    return {
      gap: await gap.innerText(),
      gate: await gate.innerText(),
      book: await book.innerText(),
      assessments: (await heads(page, "assessment")).map(
        ({ id, kind, revisionId, contentHash, payload }) => ({
          id,
          kind,
          revisionId,
          contentHash,
          payload,
        }),
      ),
    };
  };
  try {
    await fs.access(path.join(dist, "index.html"));
    backend = spawn(
      process.env.BAND_LEARNING_E2E_PYTHON || "python3",
      [
        "server/app.py",
        "--host",
        "127.0.0.1",
        "--port",
        String(apiPort),
        "--db",
        dbPath,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BAND_DB_PATH: dbPath,
          BAND_PUBLIC_ORIGIN: origin,
          BAND_COOKIE_SECURE: "0",
          BAND_TRUST_PROXY: "0",
          BAND_ALLOW_REGISTER: "1",
          BAND_MAX_ACCOUNTS: "2",
          BAND_SETUP_TOKEN: setupToken,
          BAND_SETUP_TOKEN_HASH: "",
          BAND_LEARNING_WRITES_ENABLED: "1",
        },
        stdio: "ignore",
      },
    );
    await eventually(
      async () => (await fetch(`${apiOrigin}/api/health`)).ok,
      "temporary API did not start",
      15000,
    );
    previewServer = await preview({
      root,
      configFile: false,
      base: "/",
      build: { outDir: dist },
      plugins: [
        {
          name: "r5-e2e-isolate-local-materials",
          configurePreviewServer(server) {
            server.middlewares.use((request, response, next) => {
              const pathname = new URL(request.url, origin).pathname;
              if (!pathname.startsWith("/local-bank/")) return next();
              fixtureGets.push(pathname);
              if (pathname === "/local-bank/manifest.json") {
                response
                  .writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                  })
                  .end(JSON.stringify({ materials: [] }));
                return;
              }
              // The unified planner also requests writing/speaking inventory;
              // only the prompt file imported through Me may supply real fixtures.
              if (pathname === "/local-bank/prompts.json") {
                response
                  .writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                  })
                  .end(JSON.stringify({ importVersion: 1, prompts: [] }));
                return;
              }
              const wav = wavs.find(
                (item) => pathname === `/local-bank/${item.path}`,
              );
              if (wav) {
                response.writeHead(200, {
                  "Content-Type": "audio/wav",
                  "Content-Length": wav.bytes.length,
                  "Cache-Control": "no-store",
                });
                response.end(request.method === "HEAD" ? undefined : wav.bytes);
                return;
              }
              response
                .writeHead(404, {
                  "Content-Type": "text/plain",
                  "Cache-Control": "no-store",
                })
                .end("Only self-authored R5 fixtures are available.");
            });
          },
        },
      ],
      preview: {
        host: "127.0.0.1",
        port: webPort,
        strictPort: true,
        proxy: { "/api": apiOrigin },
      },
    });
    browser = await chromium.launch(
      process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH, headless: true }
        : { channel: "chrome", headless: true },
    );
    desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: "allow",
    });
    phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "allow",
    });
    for (const [context, label] of [
      [desktopContext, "desktop"],
      [phoneContext, "phone"],
    ]) {
      observe(context, label);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      await context.addInitScript(
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
                dailyNew: 0,
                feedbackMode: "rules",
              }),
            );
          // Observe real browser media events; never dispatch media events or alter playback position.
          window.__r5MediaEvents = [];
          for (const name of ["play", "ended"])
            document.addEventListener(
              name,
              (event) => {
                const audio = event.target;
                if (
                  audio instanceof HTMLAudioElement &&
                  audio.dataset.testid === "listening-sequence-audio"
                )
                  window.__r5MediaEvents.push({
                    event: name,
                    label: audio.getAttribute("aria-label"),
                    time: audio.currentTime,
                    duration: audio.duration,
                    trusted: event.isTrusted,
                  });
              },
              true,
            );
        },
        { origin },
      );
    }
    desktop = await desktopContext.newPage();
    await desktop.clock.install({ time: dateAt(13) });
    phone = await phoneContext.newPage();
    await phone.clock.install({ time: dateAt(16) });
    phase = "real account, fixed Friday plan and nonempty score evidence";
    await login(desktop, true);
    await navigate(desktop, "today");
    const setup = desktop.getByRole("region", {
      name: "开启 8.0 计划",
      exact: true,
    });
    await setup.getByLabel("开始日期", { exact: true }).fill("2026-11-09");
    await click(
      setup.getByRole("button", { name: "开启 8.0 计划", exact: true }),
    );
    await desktop.locator('[data-task-id="d5-reading"]').waitFor();
    if (process.env.BAND_R5_E2E_PROOF === "entry") {
      phase = "old production R5 entry";
      await goReview(desktop);
      await corrections(desktop).waitFor({ timeout: 6000 });
      throw new Error(
        "Entry proof expected the pre-R5 production build to lack the correction workbench.",
      );
    }
    await navigate(desktop, "progress");
    const assessmentForm = desktop.getByRole("form", {
      name: "登记成绩",
      exact: true,
    });
    await assessmentForm
      .getByLabel("测评类型", { exact: true })
      .selectOption("official");
    for (const label of ["听力", "阅读", "写作", "口语"])
      await assessmentForm
        .getByLabel(`${label}分数`, { exact: true })
        .fill("6");
    await assessmentForm
      .getByLabel("成绩材料标识", { exact: true })
      .fill("r5-isolated-qa-baseline");
    await assessmentForm
      .getByLabel("成绩备注", { exact: true })
      .fill(
        "Synthetic score in a disposable QA account; does not claim a learner took an exam.",
      );
    await click(
      assessmentForm.getByRole("button", { name: "保存成绩", exact: true }),
    );
    await assessmentForm
      .getByRole("status")
      .filter({ hasText: "成绩已保存在本机" })
      .waitFor();
    const scoreBefore = await progressSnapshot(desktop);
    assert.equal(scoreBefore.assessments.length, 1);
    assert.match(scoreBefore.gap, /当前总分：6\.0/);
    assert.match(scoreBefore.gap, /差距：2\.0/);
    evidence.baselineAssessmentRevision = scoreBefore.assessments[0].revisionId;
    phase = "real fixture imports";
    wavs = await prepareWavs(desktop);
    const recipe = JSON.parse(
      await fs.readFile(
        process.env.BAND_R5_E2E_FIXTURE ||
          path.join(root, "scripts/fixtures/r5-e2e-materials.json"),
        "utf8",
      ),
    );
    assert.equal(recipe.fixtureVersion, 1);
    materials = recipe.materials.map((item) => {
      const material = structuredClone(item);
      if (material.skill === "listening") {
        const wav = wavs.find((value) => value.path === material.audio.path);
        material.audio = {
          ...material.audio,
          durationSeconds: wav.duration,
          sha256: wav.sha256,
        };
      }
      material.contentHash = sha(canonical(material));
      return material;
    });
    const promptRecipe = JSON.parse(
      await fs.readFile(
        process.env.BAND_R5_E2E_PROMPTS ||
          path.join(root, "scripts/fixtures/r5-e2e-prompts.json"),
        "utf8",
      ),
    );
    assert.equal(promptRecipe.fixtureVersion, 1);
    prompts = promptRecipe.prompts.map((item) => ({
      ...item,
      contentHash: sha(canonical(item)),
    }));
    await fs.writeFile(
      path.join(directory, "bank.zip"),
      bankZip(materials, wavs),
    );
    await fs.writeFile(
      path.join(directory, "prompts.json"),
      JSON.stringify({ importVersion: 1, prompts }),
    );
    await importFixtures(desktop);
    evidence.audio = wavs.map(({ bytes, ...item }) => ({
      ...item,
      bytes: bytes.length,
    }));
    checks.push(
      "真实UI首次设置、计划、非空正式成绩、8份听读ZIP及2份写作题导入",
    );
    phase = "Friday original writing paragraph and exact self-feedback";
    await navigate(desktop, courseRoute("writing", 5));
    const writing = desktop.getByRole("region", {
      name: "写作工作台",
      exact: true,
    });
    await writing
      .getByLabel("练习类型", { exact: true })
      .selectOption("paragraph");
    await click(writing.getByText("查看/更换写作材料", { exact: true }));
    await writing
      .getByLabel("本机写作题库", { exact: true })
      .selectOption(materialKey(prompts[0]));
    await click(writing.getByRole("button", { name: "开始计时", exact: true }));
    await writing
      .getByLabel("作文正文", { exact: true })
      .fill(originalParagraph);
    await desktop.clock.fastForward(10000);
    await click(writing.getByRole("button", { name: "提交首稿", exact: true }));
    await selfReview(desktop, ["grammar"]);
    const originalWriting = (await heads(desktop, "essay")).find(
      (item) =>
        item.payload.contentId === prompts[0].id &&
        !item.payload.parentRevisionId,
    );
    assert.ok(originalWriting);
    assert.equal(originalWriting.payload.scope, "paragraph");
    const originalFeedback = (await heads(desktop, "feedback")).find(
      (item) =>
        item.payload.source === "self" &&
        item.payload.workRevisionId === originalWriting.revisionId,
    );
    assert.ok(originalFeedback);
    assert.equal(
      originalFeedback.payload.inputHash,
      originalWriting.contentHash,
    );
    assert.deepEqual(originalFeedback.payload.errorCauses, ["grammar"]);
    phase =
      "Friday original reading offline, five wrong and one original-correct dispute";
    const originalMaterial = materials.find(
      (item) => item.id === "r5-ui-b-original-reading",
    );
    await choose(desktop, 5, "reading", originalMaterial.id);
    await warm(desktop);
    await revealMaterialPicker(bench(desktop, "reading"));
    await bench(desktop, "reading")
      .getByLabel("练习材料", { exact: true })
      .selectOption(materialKey(originalMaterial));
    assert.equal(
      await bench(desktop, "reading")
        .getByLabel("练习材料", { exact: true })
        .inputValue(),
      materialKey(originalMaterial),
    );
    await desktopContext.setOffline(true);
    assert.equal(await desktop.evaluate(() => navigator.onLine), false);
    assert.equal(
      await desktop.evaluate(() =>
        fetch("/api/health", { cache: "no-store" }).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
    const originalReadingPanel = bench(desktop, "reading");
    await click(
      originalReadingPanel.getByRole("button", {
        name: "开始限时首答",
        exact: true,
      }),
    );
    await fillAnswers(
      originalReadingPanel.getByRole("region", {
        name: "作答题目",
        exact: true,
      }),
      [
        "FALSE",
        "FALSE",
        "FALSE",
        "FALSE",
        "FALSE",
        "TRUE",
        "TRUE",
        "TRUE",
        "TRUE",
        "TRUE",
      ],
    );
    await desktop.clock.fastForward(10000);
    await click(
      originalReadingPanel.getByRole("button", {
        name: "提交首答",
        exact: true,
      }),
    );
    await review(desktop)
      .getByRole("heading", { name: "A轮：先自己改答案", exact: true })
      .waitFor();
    const firstReading = await headFor(desktop, originalMaterial.id);
    assert.equal(firstReading.payload.score, 5);
    assert.equal(firstReading.payload.total, 10);
    await completeAB(desktop, Array(10).fill("TRUE"), [1, 2, 3, 4, 5], 6);
    const reviewedReading = await headFor(desktop, originalMaterial.id);
    assert.equal(reviewedReading.payload.questionResults[5].correct, true);
    assert.equal(
      reviewedReading.payload.questionResults[5].answerDisputed,
      true,
    );
    assert.equal(
      reviewedReading.payload.questionResults.filter(
        (item) => item.errorCause === "synonym-miss",
      ).length,
      5,
    );
    assert.deepEqual(
      reviewedReading.payload.answers,
      firstReading.payload.answers,
    );
    const offlineResponse = await desktop.reload({
      waitUntil: "domcontentloaded",
    });
    assert.equal(offlineResponse.fromServiceWorker(), true);
    await goReview(desktop);
    await click(
      corrections(desktop).getByRole("button", { name: /生成待订正任务/ }),
    );
    await eventually(
      async () =>
        (await heads(desktop, "correction")).some(
          (item) =>
            item.payload.sourceRevisionId === reviewedReading.revisionId,
        ),
      "reading correction not generated offline",
    );
    const readingCorrection = (await heads(desktop, "correction")).find(
      (item) => item.payload.sourceRevisionId === reviewedReading.revisionId,
    );
    const writingCorrection = (await heads(desktop, "correction")).find(
      (item) => item.payload.sourceRevisionId === originalFeedback.revisionId,
    );
    assert.ok(
      writingCorrection,
      "self-feedback exact revision must create its own correction",
    );
    assert.equal(readingCorrection.payload.items.length, 5);
    assert.deepEqual(
      writingCorrection.payload.items.map((item) => item.dimension),
      ["grammar"],
    );
    assert.equal(writingCorrection.payload.sourceKind, "feedback");
    assert.equal(writingCorrection.payload.sourceId, originalFeedback.id);
    assert.equal(
      readingCorrection.payload.items.some(
        (item) => item.questionId === originalMaterial.questions[5].id,
      ),
      false,
    );
    assert.equal((await localScope(desktop)).outbox.length > 0, true);
    checks.push(
      "真实SW离线首答与A-B、5错同因及1原正确存疑；订正精确绑定原作答/反馈修订",
    );
    phase = "Saturday fixed review budget, original revision preserved";
    await desktopContext.setOffline(false);
    await eventually(
      async () => (await localScope(desktop)).outbox.length === 0,
      "Friday offline records did not auto-sync",
    );
    await newDay(desktop, 14);
    await goReview(desktop);
    for (const question of originalMaterial.questions.slice(0, 5))
      await completeLRItem(desktop, readingCorrection.id, question.id);
    const writingItem = correctionArticle(
      desktop,
      writingCorrection.id,
    ).getByRole("region", { name: "订正项 grammar", exact: true });
    await click(
      writingItem.getByRole("link", {
        name: "打开原稿并新建订正稿",
        exact: true,
      }),
    );
    await writing.waitFor();
    await click(writing.getByRole("button", { name: "写修改稿", exact: true }));
    await eventually(
      async () => writing.getByLabel("作文正文", { exact: true }).isEditable(),
      "rewrite editor did not become editable",
    );
    await writing
      .getByLabel("作文正文", { exact: true })
      .fill(correctedParagraph);
    await click(writing.getByRole("button", { name: "开始计时", exact: true }));
    await desktop.clock.fastForward(10000);
    await click(
      writing.getByRole("button", { name: "提交修改稿", exact: true }),
    );
    await eventually(
      async () =>
        (await heads(desktop, "essay")).some(
          (item) =>
            item.payload.correctionId === writingCorrection.id &&
            !item.payload.retestOf &&
            item.payload.stage === "submitted",
        ),
      "submitted rewrite not persisted",
    );
    const rewritten = (await heads(desktop, "essay")).find(
      (item) =>
        item.payload.correctionId === writingCorrection.id &&
        !item.payload.retestOf,
    );
    assert.ok(rewritten);
    assert.equal(
      rewritten.payload.parentRevisionId,
      originalWriting.revisionId,
    );
    assert.notEqual(rewritten.payload.text, originalWriting.payload.text);
    await goReview(desktop);
    await click(
      correctionArticle(desktop, writingCorrection.id).getByRole("button", {
        name: "确认已保存订正稿",
        exact: true,
      }),
    );
    await eventually(
      async () =>
        (await byId(desktop, writingCorrection.id)).payload.items.every(
          (item) => item.status === "corrected",
        ),
      "writing correction did not become corrected",
    );
    assert.equal(
      (await byId(desktop, readingCorrection.id)).payload.date,
      "2026-11-14",
    );
    await retestArticle(desktop, readingCorrection.id)
      .getByText("至少隔一个自然日，再用没做过的新题复测。", { exact: true })
      .waitFor();
    assert.equal(
      await retestArticle(desktop, readingCorrection.id)
        .getByRole("link", { name: "开始这份新题复测", exact: true })
        .count(),
      0,
      "same civil day must not offer retest",
    );
    const beforeAdjudication = await localScope(desktop);
    assert.deepEqual(
      beforeAdjudication.revisions[firstReading.revisionId].payload,
      firstReading.payload,
    );
    assert.deepEqual(
      beforeAdjudication.revisions[originalWriting.revisionId].payload,
      originalWriting.payload,
    );
    const saturdayReviewMission = (await heads(desktop, "mission")).find(
      (item) => item.payload.taskId === "d6-review",
    );
    assert.ok(saturdayReviewMission);
    assert.equal(saturdayReviewMission.payload.plannedMinutes, 30);
    assert.ok(
      saturdayReviewMission.payload.actualMinutes > 0 &&
        saturdayReviewMission.payload.actualMinutes <= 30,
    );
    checks.push(
      "周六只用已有复盘预算，真实修改稿保留父修订；同日禁止复测且原稿原分不变",
    );
    phase =
      "Sunday no reading block defers retest and nine-question statistics do not trigger type advice";
    await newDay(desktop, 15);
    await goReview(desktop);
    const readingRound = retestArticle(desktop, readingCorrection.id);
    await readingRound
      .getByText(
        "当天对应科目预算不足，留到能容纳的同科任务；不挪其他科目分钟。",
        { exact: true },
      )
      .waitFor();
    const blockedRetest = readingRound
      .locator("a")
      .filter({ hasText: "开始这份新题复测" });
    assert.equal(await blockedRetest.getAttribute("aria-disabled"), "true");
    assert.equal(await blockedRetest.getAttribute("href"), null);
    await goReview(desktop, "weekly");
    const weekly = desktop.getByRole("region", {
      name: "本周校准",
      exact: true,
    });
    await weekly.waitFor();
    await click(
      weekly.getByText("近28天题型、错因与订正复测", { exact: true }),
    );
    const nineQuestionText = await weekly
      .getByRole("region", { name: "阅读周统计", exact: true })
      .innerText();
    assert.match(nineQuestionText, /4\s*\/\s*9/);
    assert.equal(
      await weekly
        .locator("[data-suggestion-id]")
        .filter({
          has: desktop.getByRole("heading", {
            name: "阅读 · 下周优先该题型的新材料",
            exact: true,
          }),
        })
        .count(),
      0,
      "nine included questions cannot meet the ten-question advice threshold",
    );
    evidence.beforeAdjudication = {
      rawScore: firstReading.payload.score,
      weeklyReading: nineQuestionText,
      weakTypeSuggestions: 0,
    };
    phase =
      "Sunday key-wrong adjudication, explicit cause and sixth correction";
    await goReview(desktop, "answers");
    const answerQueue = desktop.getByRole("region", {
      name: "答案审校",
      exact: true,
    });
    await answerQueue
      .getByLabel("查找审校题目", { exact: true })
      .fill(originalMaterial.source.sourceRef);
    const auditSelect = answerQueue.getByLabel("审校题目", { exact: true });
    await eventually(
      async () =>
        (await auditSelect.locator("option").allTextContents()).some((text) =>
          text.includes("第6题"),
        ),
      "disputed question missing from real answer-review queue",
    );
    const auditOption = await auditSelect
      .locator("option")
      .evaluateAll((options) =>
        options
          .filter((option) => option.textContent.includes("第6题"))
          .map((option) => option.value),
      );
    assert.equal(auditOption.length, 1);
    await auditSelect.selectOption(auditOption[0]);
    const auditForm = answerQueue.getByRole("article", {
      name: "当前审校题目",
      exact: true,
    });
    await auditForm
      .getByLabel("审校结论", { exact: true })
      .selectOption("key-wrong");
    await auditForm.getByLabel("更正答案", { exact: true }).fill("FALSE");
    await auditForm
      .getByLabel("审校说明", { exact: true })
      .fill(
        "The passage says the project closed on Sundays, so this synthetic key must be FALSE.",
      );
    await click(
      auditForm.getByRole("button", { name: "保存审校结论", exact: true }),
    );
    await answerQueue
      .getByRole("status")
      .filter({ hasText: "审校结论已保存" })
      .waitFor();
    await auditForm.getByText(/原始首答5\/10；校正后4\/10/).waitFor();
    await auditForm
      .getByLabel("第6题补选错因", { exact: true })
      .selectOption("synonym-miss");
    await click(
      auditForm.getByRole("button", { name: "补错因并生成订正", exact: true }),
    );
    await answerQueue
      .getByRole("status")
      .filter({ hasText: "错因已保存到订正任务" })
      .waitFor();
    const answerReviewRecord = (await heads(desktop, "answerReview")).find(
      (item) => item.payload.materialId === originalMaterial.id,
    );
    assert.ok(answerReviewRecord);
    assert.equal(answerReviewRecord.payload.verdict, "key-wrong");
    const [auditDownload] = await Promise.all([
      desktop.waitForEvent("download"),
      click(
        answerQueue.getByRole("button", {
          name: "导出审校结果JSON",
          exact: true,
        }),
      ),
    ]);
    const auditFile = path.join(directory, "answer-reviews.json");
    await auditDownload.saveAs(auditFile);
    const exportedReviews = JSON.parse(await fs.readFile(auditFile, "utf8"));
    assert.equal(exportedReviews.exportVersion, 1);
    assert.equal(exportedReviews.answerReviews.length, 1);
    assert.equal(
      exportedReviews.answerReviews[0].materialId,
      originalMaterial.id,
    );
    assert.equal(
      exportedReviews.answerReviews[0].contentHash,
      originalMaterial.contentHash,
    );
    assert.equal(
      exportedReviews.answerReviews[0].questionId,
      originalMaterial.questions[5].id,
    );
    assert.deepEqual(exportedReviews.answerReviews[0].correctedAnswers, [
      "FALSE",
    ]);
    assert.equal(
      answerReviewRecord.payload.contentHash,
      originalMaterial.contentHash,
    );
    assert.equal(
      (await headFor(desktop, originalMaterial.id)).payload.score,
      5,
    );
    await goReview(desktop);
    const appended = await byId(desktop, readingCorrection.id);
    assert.equal(
      appended.payload.items.length,
      6,
      "newly adjudicated error must append to the same correction, retaining five completed items",
    );
    assert.equal(
      appended.payload.items.filter((item) => item.status === "corrected")
        .length,
      5,
    );
    await completeLRItem(
      desktop,
      readingCorrection.id,
      originalMaterial.questions[5].id,
    );
    assert.equal(
      (await byId(desktop, readingCorrection.id)).payload.date,
      "2026-11-15",
    );
    const sundayReviewMission = (await heads(desktop, "mission")).find(
      (item) => item.payload.taskId === "d7-review",
    );
    assert.ok(sundayReviewMission);
    assert.equal(sundayReviewMission.payload.plannedMinutes, 30);
    assert.ok(
      sundayReviewMission.payload.actualMinutes > 0 &&
        sundayReviewMission.payload.actualMinutes <= 30,
    );
    checks.push(
      "周日无阅读预算明确延期；答案审校校正5/10→4/10，补因追加第6项且原始5/10不改",
    );
    phase =
      "Sunday writing same-scope new prompt retest with exact self-feedback and estimate boundary";
    await goReview(desktop);
    const writingRound = retestArticle(desktop, writingCorrection.id);
    await click(
      writingRound.getByRole("link", { name: "开始这份新题复测", exact: true }),
    );
    await writing.waitFor();
    assert.equal(
      await writing.getByLabel("练习类型", { exact: true }).inputValue(),
      "paragraph",
    );
    assert.equal(
      await writing.getByLabel("题目", { exact: true }).inputValue(),
      prompts[1].prompt,
    );
    await click(writing.getByRole("button", { name: "开始计时", exact: true }));
    await writing.getByLabel("作文正文", { exact: true }).fill(retestParagraph);
    await desktop.clock.fastForward(10000);
    await click(writing.getByRole("button", { name: "提交首稿", exact: true }));
    await writing
      .getByRole("region", { name: "写作体检与自查", exact: true })
      .waitFor();
    const writingRetest = (await heads(desktop, "essay")).find(
      (item) => item.payload.retestOf === originalWriting.revisionId,
    );
    assert.ok(writingRetest);
    assert.equal(writingRetest.payload.correctionId, writingCorrection.id);
    assert.equal(writingRetest.payload.scope, "paragraph");
    assert.equal(writingRetest.payload.contentId, prompts[1].id);
    assert.equal(
      (await heads(desktop, "feedback")).some(
        (item) =>
          item.payload.source === "self" &&
          item.payload.workRevisionId === writingRetest.revisionId,
      ),
      false,
    );
    await navigate(desktop, `writing?work=${writingRetest.id}&date=2026-11-15`);
    await selfReview(desktop, []);
    await goReview(desktop);
    await click(
      retestArticle(desktop, writingCorrection.id)
        .locator(`[data-retest-work-id="${writingRetest.id}"]`)
        .getByRole("button", { name: "记录本次复测结果", exact: true }),
    );
    await retestArticle(desktop, writingCorrection.id)
      .getByRole("status")
      .filter({ hasText: "本轮复测通过（自评／机器反馈，估分）" })
      .waitFor();
    assert.equal(
      (await byId(desktop, writingCorrection.id)).payload.items[0].status,
      "retested-pass",
    );
    phase =
      "Sunday actual weekly evidence, accept type preference and reject cause preference";
    await goReview(desktop, "weekly");
    const weakType = weekly.locator("[data-suggestion-id]").filter({
      has: desktop.getByRole("heading", {
        name: "阅读 · 下周优先该题型的新材料",
        exact: true,
      }),
    });
    const causeAdvice = weekly.locator("[data-suggestion-id]").filter({
      has: desktop.getByRole("heading", {
        name: "阅读 · 下周优先该错因的订正",
        exact: true,
      }),
    });
    await weakType.waitFor();
    await causeAdvice.waitFor();
    assert.match(await weakType.innerText(), /40/);
    await click(weakType.getByRole("button", { name: "采纳", exact: true }));
    await weakType.getByRole("status").filter({ hasText: "已采纳" }).waitFor();
    await click(
      causeAdvice.getByRole("button", { name: "不采纳", exact: true }),
    );
    await causeAdvice
      .getByRole("status")
      .filter({ hasText: "未采纳" })
      .waitFor();
    const decisions = await heads(desktop, "adjustment");
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions.map((item) => item.payload.decision).sort(), [
      "accepted",
      "rejected",
    ]);
    const accepted = decisions.find(
      (item) => item.payload.decision === "accepted",
    );
    const rejected = decisions.find(
      (item) => item.payload.decision === "rejected",
    );
    assert.equal(
      accepted.payload.suggestions[0].action,
      "prefer-question-type",
    );
    assert.equal(
      rejected.payload.suggestions[0].action,
      "prioritize-error-cause",
    );
    checks.push(
      "写作同型新题同段落范围、精确同稿自查通过保留估分；周汇总按10题/40%证据分别采纳与拒绝",
    );
    phase = "Monday ordinary reading preference changes selection only";
    await newDay(desktop, 16);
    await navigate(desktop, courseRoute("reading", 8));
    const normalReading = bench(desktop, "reading");
    await normalReading.waitFor();
    await revealMaterialPicker(normalReading);
    await eventually(async () => {
      const value = await normalReading
        .getByLabel("练习材料", { exact: true })
        .inputValue();
      return materials.some(
        (item) => item.skill === "reading" && materialKey(item) === value,
      );
    }, "ordinary reading material selection not ready");
    const ordinaryChoice = await normalReading
      .getByLabel("练习材料", { exact: true })
      .inputValue();
    const ordinaryMaterial = materials.find(
      (item) => materialKey(item) === ordinaryChoice,
    );
    assert.ok(ordinaryMaterial);
    assert.equal(
      ordinaryMaterial.questions[0].type,
      "true-false-not-given",
      "accepted weak-type advice must outrank unused default other-type candidate",
    );
    assert.notEqual(ordinaryMaterial.id, originalMaterial.id);
    const otherMaterial = materials.find(
      (item) => item.id === "r5-ui-a-other-reading",
    );
    assert.equal(
      (await heads(desktop, "attempt")).some(
        (item) => item.payload.contentId === ordinaryMaterial.id,
      ),
      false,
      "opening a suggested material is not an attempt",
    );
    assert.equal(
      (await heads(desktop, "attempt")).some(
        (item) => item.payload.contentId === otherMaterial.id,
      ),
      false,
    );
    evidence.normalReadingPreference = {
      selected: ordinaryMaterial.id,
      unusedDefaultOtherType: otherMaterial.id,
    };
    phase = "Monday same-type fresh reading retest, A-B required before pass";
    await goReview(desktop);
    const freshReadingRound = retestArticle(desktop, readingCorrection.id);
    await click(
      freshReadingRound.getByRole("link", {
        name: "开始这份新题复测",
        exact: true,
      }),
    );
    const readingRetestPanel = bench(desktop, "reading");
    await click(
      readingRetestPanel.getByRole("button", {
        name: "开始限时首答",
        exact: true,
      }),
    );
    await fillAnswers(
      readingRetestPanel.getByRole("region", { name: "作答题目", exact: true }),
      Array(10).fill("TRUE"),
    );
    await desktop.clock.fastForward(10000);
    await click(
      readingRetestPanel.getByRole("button", { name: "提交首答", exact: true }),
    );
    await review(desktop)
      .getByRole("heading", { name: "A轮：先自己改答案", exact: true })
      .waitFor();
    const readingRetest = (await heads(desktop, "attempt")).find(
      (item) =>
        item.payload.correctionId === readingCorrection.id &&
        item.payload.retestOf,
    );
    assert.ok(readingRetest);
    assert.equal(readingRetest.payload.retestOf, reviewedReading.revisionId);
    assert.notEqual(readingRetest.payload.contentId, originalMaterial.id);
    assert.equal(readingRetest.payload.score, 10);
    await goReview(desktop);
    await retestArticle(desktop, readingCorrection.id)
      .locator(`[data-retest-work-id="${readingRetest.id}"]`)
      .getByText("请先完成新材料首答与复盘，不能把熟题或未复盘作答判为通过。", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await retestArticle(desktop, readingCorrection.id)
        .locator(`[data-retest-work-id="${readingRetest.id}"]`)
        .getByRole("button", { name: "记录本次复测结果", exact: true })
        .count(),
      0,
      "first-answer-only must not pass LR retest",
    );
    await navigate(desktop, `reading?work=${readingRetest.id}&date=2026-11-16`);
    await completeAB(desktop, Array(10).fill("TRUE"));
    await goReview(desktop);
    await click(
      retestArticle(desktop, readingCorrection.id)
        .locator(`[data-retest-work-id="${readingRetest.id}"]`)
        .getByRole("button", { name: "记录本次复测结果", exact: true }),
    );
    await eventually(
      async () =>
        (await byId(desktop, readingCorrection.id)).payload.items.every(
          (item) => item.status === "retested-pass",
        ),
      "reading retest outcomes not saved",
    );
    checks.push("周一只调整选材顺序；隔自然日新题复测要求真实A-B，6项最终通过");
    phase =
      "four-section real-media sequence and one full forty-question attempt";
    await navigate(desktop, courseRoute("listening", 8));
    const listening = bench(desktop, "listening");
    await listening.waitFor();
    await revealMaterialPicker(listening);
    const sequenceSelect = listening.getByLabel("练习材料", { exact: true });
    await eventually(
      async () =>
        (await sequenceSelect.locator("option").allTextContents()).some(
          (text) => text.includes("四节顺序听力"),
        ),
      "four imported sections did not expose a derived sequence",
    );
    const sequenceOptions = await sequenceSelect
      .locator("option")
      .evaluateAll((options) =>
        options
          .filter((option) => option.textContent.includes("四节顺序听力"))
          .map((option) => ({ value: option.value, text: option.textContent })),
      );
    assert.equal(sequenceOptions.length, 1);
    await sequenceSelect.selectOption(sequenceOptions[0].value);
    await click(
      listening.getByRole("button", { name: "开始限时首答", exact: true }),
    );
    const sequence = desktop.getByRole("region", {
      name: "四节听力连播",
      exact: true,
    });
    await sequence.waitFor();
    await fillAnswers(
      listening.getByRole("region", { name: "作答题目", exact: true }),
      Array(40).fill("sample"),
    );
    assert.equal(
      await listening
        .getByRole("button", { name: "提交首答", exact: true })
        .isDisabled(),
      true,
    );
    const firstAudio = desktop.getByTestId("listening-sequence-audio");
    await eventually(
      async () => firstAudio.evaluate((audio) => audio.readyState >= 1),
      "sequence audio metadata unavailable",
    );
    assert.equal(await firstAudio.evaluate((audio) => audio.controls), false);
    const playbackStart = Date.now();
    await click(
      sequence.getByRole("button", { name: "开始四节连续播放", exact: true }),
    );
    await eventually(
      async () =>
        desktop.evaluate(
          () =>
            window.__r5MediaEvents.filter((item) => item.event === "ended")
              .length === 4,
        ),
      "four real audio excerpts did not naturally end",
      30000,
    );
    const mediaEvents = await desktop.evaluate(() => window.__r5MediaEvents);
    assert.deepEqual(
      mediaEvents
        .filter((item) => item.event === "play")
        .map((item) => item.label),
      ["第1节听力音频", "第2节听力音频", "第3节听力音频", "第4节听力音频"],
    );
    assert.equal(
      mediaEvents.filter((item) => item.event === "ended").length,
      4,
    );
    assert.ok(mediaEvents.every((item) => item.trusted));
    assert.ok(
      mediaEvents
        .filter((item) => item.event === "ended")
        .every((item) => item.time >= item.duration - 0.1),
    );
    evidence.realSequencePlaybackWallSeconds =
      (Date.now() - playbackStart) / 1000;
    assert.ok(evidence.realSequencePlaybackWallSeconds >= 3.2);
    assert.equal(
      await listening
        .getByRole("button", { name: "提交首答", exact: true })
        .isDisabled(),
      true,
    );
    const finalCheck = sequence.getByRole("timer", {
      name: "整套听力检查倒计时",
      exact: true,
    });
    await finalCheck.waitFor();
    await eventually(
      async () => {
        const seconds = Number(
          (await finalCheck.innerText()).match(/剩余\s*(\d+)\s*秒/)?.[1],
        );
        return seconds >= 115 && seconds <= 120;
      },
      "final check UI did not settle to its real 120-second window",
      3000,
    );
    const firstCheckText = await finalCheck.innerText();
    const initialCheckSeconds = Number(
      firstCheckText.match(/剩余\s*(\d+)\s*秒/)?.[1],
    );
    assert.ok(initialCheckSeconds >= 115 && initialCheckSeconds <= 120);
    evidence.finalCheckInitialSeconds = initialCheckSeconds;
    await desktop.clock.fastForward(110000);
    assert.equal(
      await listening
        .getByRole("button", { name: "提交首答", exact: true })
        .isDisabled(),
      true,
      "sequence check cannot end at 110 seconds",
    );
    await desktop.clock.fastForward(11000);
    await eventually(
      async () =>
        listening
          .getByRole("button", { name: "提交首答", exact: true })
          .isEnabled(),
      "120-second final check did not enable full submission",
    );
    await click(
      listening.getByRole("button", { name: "提交首答", exact: true }),
    );
    await review(desktop).waitFor();
    const fullListening = (await heads(desktop, "attempt")).find(
      (item) =>
        item.payload.skill === "listening" && item.payload.scope === "full",
    );
    assert.ok(fullListening);
    assert.equal(fullListening.payload.total, 40);
    assert.equal(fullListening.payload.score, 40);
    assert.equal(fullListening.payload.conditions.sequential, true);
    assert.equal(fullListening.payload.conditions.replays, 0);
    assert.equal(fullListening.payload.conditions.transcriptViewed, false);
    assert.equal(fullListening.payload.firstAttempt, true);
    assert.equal(
      (await heads(desktop, "attempt")).filter(
        (item) => item.payload.skill === "listening",
      ).length,
      1,
      "sequence must save one full attempt, not four misleading completed parts",
    );
    await completeAB(desktop, Array(40).fill("sample"));
    checks.push(
      "四节不同真实WAV自然播放，结束后完整120秒检查，一次40题scope=full与sequential条件",
    );
    phase =
      "completeness matrix, explicit gaps and immutable raw/source evidence";
    await goReview(desktop, "coverage");
    const coverage = desktop.getByRole("region", {
      name: "题库完整性",
      exact: true,
    });
    await coverage.waitFor();
    await eventually(
      async () =>
        /独立题目80题/.test(
          await coverage.getByTestId("bank-audit-counts").innerText(),
        ),
      "completeness panel has not loaded the eighty self-authored questions",
    );
    const rowValues = async (type) =>
      coverage.locator(`[data-coverage-type="${type}"] td`).allTextContents();
    assert.deepEqual(
      (await rowValues("reading:true-false-not-given")).map((text) =>
        parseInt(text, 10),
      ),
      [30, 0, 0, 20, 10, 1],
    );
    assert.deepEqual(
      (await rowValues("reading:sentence-completion")).map((text) =>
        parseInt(text, 10),
      ),
      [10, 0, 0, 0, 10, 1],
    );
    assert.deepEqual(
      (await rowValues("listening:sentence-completion")).map((text) =>
        parseInt(text, 10),
      ),
      [0, 40, 0, 40, 0, 0],
    );
    assert.match(
      await coverage.locator('[data-coverage-exams="reading"]').innerText(),
      /完整整套0套/,
    );
    assert.match(
      await coverage.locator('[data-coverage-exams="listening"]').innerText(),
      /完整整套1套/,
    );
    assert.match(
      await coverage.locator('[data-coverage-exams="listening"]').innerText(),
      /四节可连播1套/,
    );
    assert.match(
      await coverage.locator('[data-coverage-exams="listening"]').innerText(),
      /检查池0\/8套/,
    );
    assert.match(
      await coverage.getByTestId("bank-audit-counts").innerText(),
      /独立题目80题；待审校79题，已审1题，其中答案有误1题/,
    );
    const [gapDownload] = await Promise.all([
      desktop.waitForEvent("download"),
      click(
        coverage.getByRole("button", { name: "导出缺口清单JSON", exact: true }),
      ),
    ]);
    const gapFile = path.join(directory, "gaps.json");
    await gapDownload.saveAs(gapFile);
    const exportedGaps = JSON.parse(await fs.readFile(gapFile, "utf8"));
    assert.ok(JSON.stringify(exportedGaps).includes("holdout"));
    assert.ok(JSON.stringify(exportedGaps).includes("annual"));
    const currentOriginal = await headFor(desktop, originalMaterial.id);
    assert.equal(currentOriginal.payload.score, 5);
    assert.deepEqual(
      currentOriginal.payload.answers,
      firstReading.payload.answers,
    );
    assert.equal(
      currentOriginal.payload.contentHash,
      originalMaterial.contentHash,
    );
    assert.deepEqual(
      (await localScope(desktop)).revisions[firstReading.revisionId].payload,
      firstReading.payload,
    );
    assert.deepEqual(
      (await localScope(desktop)).revisions[originalWriting.revisionId].payload,
      originalWriting.payload,
    );
    const scoreAfter = await progressSnapshot(desktop);
    assert.deepEqual(scoreAfter.assessments, scoreBefore.assessments);
    assert.equal(scoreAfter.gap, scoreBefore.gap);
    assert.equal(scoreAfter.gate, scoreBefore.gate);
    assert.equal(scoreAfter.book, scoreBefore.book);
    evidence.immutableScore = {
      originalReading: "5/10",
      adjudicatedReading: "4/10",
      formalOverall: 6,
      gap: 2,
      unchangedAssessmentRevision: scoreAfter.assessments[0].revisionId,
    };
    checks.push(
      "完整性矩阵80题/原件去重/缺口导出；原始首答、作品、非空正式成绩与门槛差距完全不变",
    );
    phase = "automatic sync and second real mobile context";
    await eventually(
      async () => (await localScope(desktop)).outbox.length === 0,
      "all R5 records did not auto-sync",
    );
    const server = await serverRecords(desktop);
    assert.equal(
      server.filter((item) => item.kind === "answerReview").length,
      1,
    );
    assert.equal(server.filter((item) => item.kind === "adjustment").length, 2);
    assert.ok(
      server.some(
        (item) =>
          item.kind === "correction" &&
          item.id === readingCorrection.id &&
          item.payload.items.every((value) => value.status === "retested-pass"),
      ),
    );
    await login(phone, false);
    await eventually(
      async () =>
        (await heads(phone, "adjustment")).length === 2 &&
        (await heads(phone, "answerReview")).length === 1 &&
        (await byId(phone, readingCorrection.id))?.payload.items.every(
          (item) => item.status === "retested-pass",
        ),
      "phone did not read all three new record kinds",
    );
    await importFixtures(phone);
    await goReview(phone);
    const phoneReadingCorrection = await byId(phone, readingCorrection.id),
      desktopReadingCorrection = await byId(desktop, readingCorrection.id);
    assert.deepEqual(
      phoneReadingCorrection.payload,
      desktopReadingCorrection.payload,
    );
    assert.deepEqual(
      (await heads(phone, "answerReview")).map((item) => item.payload),
      (await heads(desktop, "answerReview")).map((item) => item.payload),
    );
    assert.deepEqual(
      (await heads(phone, "adjustment"))
        .map((item) => item.payload)
        .sort((a, b) => a.decision.localeCompare(b.decision)),
      (await heads(desktop, "adjustment"))
        .map((item) => item.payload)
        .sort((a, b) => a.decision.localeCompare(b.decision)),
    );
    await correctionArticle(phone, readingCorrection.id).waitFor();
    evidence.mobileCorrection = await noOverflow(phone);
    await goReview(phone, "answers");
    await phone
      .getByRole("region", { name: "答案审校", exact: true })
      .getByLabel("显示已审校题目", { exact: true })
      .check();
    const phoneAudit = phone.getByRole("region", {
      name: "答案审校",
      exact: true,
    });
    await phoneAudit
      .getByLabel("查找审校题目", { exact: true })
      .fill(originalMaterial.source.sourceRef);
    const phoneAuditSelect = phoneAudit.getByLabel("审校题目", { exact: true });
    const phoneOption = await phoneAuditSelect
      .locator("option")
      .evaluateAll((options) =>
        options
          .filter((option) => option.textContent.includes("第6题"))
          .map((option) => option.value),
      );
    assert.equal(phoneOption.length, 1);
    await phoneAuditSelect.selectOption(phoneOption[0]);
    assert.match(
      await phoneAudit
        .getByRole("article", { name: "当前审校题目", exact: true })
        .innerText(),
      /原始首答5\/10；校正后4\/10/,
    );
    await noOverflow(phone);
    await goReview(phone, "weekly");
    await phone
      .getByRole("region", { name: "本周校准", exact: true })
      .waitFor();
    await noOverflow(phone);
    await goReview(phone, "coverage");
    await phone
      .getByRole("region", { name: "题库完整性", exact: true })
      .waitFor();
    await noOverflow(phone);
    await warm(phone);
    await phoneContext.setOffline(true);
    const mobileOfflineResponse = await phone.reload({
      waitUntil: "domcontentloaded",
    });
    assert.equal(mobileOfflineResponse.fromServiceWorker(), true);
    await goReview(phone);
    await correctionArticle(phone, readingCorrection.id).waitFor();
    await noOverflow(phone);
    assert.equal(
      (await byId(phone, readingCorrection.id)).payload.items.every(
        (item) => item.status === "retested-pass",
      ),
      true,
    );
    checks.push(
      "同账号第二个390px移动上下文回读correction/answer-review/adjustment及复盘投影，真实SW离线刷新无横溢",
    );
    phase =
      "extra isolated holdout alias cannot enter normal reading through picker or URL";
    const extraRecipe = JSON.parse(
      await fs.readFile(
        process.env.BAND_R5_E2E_HOLDOUT ||
          path.join(root, "scripts/fixtures/r5-e2e-holdout.json"),
        "utf8",
      ),
    );
    assert.equal(extraRecipe.fixtureVersion, 1);
    const extraMaterials = extraRecipe.materials.map((item) => ({
      ...item,
      contentHash: sha(canonical(item)),
    }));
    assert.equal(extraMaterials.length, 2);
    assert.equal(extraMaterials[0].passage, extraMaterials[1].passage);
    const extraZip = path.join(directory, "extra-holdout-boundary.zip");
    await fs.writeFile(extraZip, bankZip(extraMaterials, []));
    await navigate(desktop, "me");
    const extraBankPanel = desktop.getByRole("region", {
      name: "本机题库",
      exact: true,
    });
    await extraBankPanel
      .getByLabel("选择题库文件", { exact: true })
      .setInputFiles(extraZip);
    await eventually(
      async () => /已导入2份/.test(await extraBankPanel.innerText()),
      "extra holdout fixture did not import through Me",
    );
    const attemptsBeforeGuard = (await heads(desktop, "attempt"))
      .map((item) => ({
        id: item.id,
        revisionId: item.revisionId,
        payload: item.payload,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    await navigate(desktop, "reading?date=2026-11-16&day=8&task=d8-reading");
    const normalAfterExtra = bench(desktop, "reading");
    await revealMaterialPicker(normalAfterExtra);
    const normalExtraSelect = normalAfterExtra.getByLabel("练习材料", {
      exact: true,
    });
    await eventually(
      async () =>
        (
          await normalExtraSelect
            .locator("option")
            .evaluateAll((options) => options.map((option) => option.value))
        ).includes(materialKey(originalMaterial)),
      "normal reading has not loaded its real fixture options",
    );
    const normalOptions = await normalExtraSelect
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value));
    for (const extra of extraMaterials)
      assert.equal(
        normalOptions.includes(materialKey(extra)),
        false,
        "normal picker must hide the reserved original and renamed practice alias",
      );
    const normalExtraValue = await normalExtraSelect.inputValue();
    assert.ok(
      !extraMaterials.some((extra) => materialKey(extra) === normalExtraValue),
      "automatic normal recommendation cannot choose a holdout alias",
    );
    for (const extra of extraMaterials) {
      await navigate(
        desktop,
        `reading?${new URLSearchParams({ date: "2026-11-16", day: "8", task: "d8-reading", material: materialKey(extra) })}`,
      );
      // A real document reload prevents an old React workbench from satisfying
      // negative assertions while the hash navigation is still being applied.
      await desktop.reload({ waitUntil: "networkidle" });
      const guarded = bench(desktop, "reading");
      await guarded.waitFor();
      await revealMaterialPicker(guarded);
      await eventually(
        async () =>
          (
            await guarded
              .getByLabel("练习材料", { exact: true })
              .locator("option")
              .evaluateAll((options) => options.map((option) => option.value))
          ).includes(materialKey(originalMaterial)),
        "manual-URL guard ran before material loading completed",
      );
      const start = guarded.getByRole("button", {
        name: "开始限时首答",
        exact: true,
      });
      if ((await start.count()) && (await start.isEnabled())) {
        await click(start);
        await guarded
          .getByRole("alert")
          .filter({ hasText: /检查池|独立检查|保留材料|原件/ })
          .waitFor();
      }
      assert.equal(
        await guarded
          .getByRole("region", { name: "作答题目", exact: true })
          .count(),
        0,
        "hand-edited holdout URL must not start answer controls",
      );
      assert.equal(
        await guarded
          .getByRole("button", { name: "提交首答", exact: true })
          .count(),
        0,
        "hand-edited holdout URL must not offer submission",
      );
    }
    assert.deepEqual(
      (await heads(desktop, "attempt"))
        .map((item) => ({
          id: item.id,
          revisionId: item.revisionId,
          payload: item.payload,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      attemptsBeforeGuard,
      "guarded URLs cannot save or rewrite an attempt",
    );
    evidence.extraHoldoutBoundary = {
      importedAfterMainMatrix: true,
      originals: extraMaterials.map((item) => item.id),
      normalHidden: true,
      attemptsUnchanged: true,
    };
    checks.push(
      "80题及手机断言后另行Me导入检查池/改号同文别名；正常推荐/下拉及手改URL均不能开始或提交，作答记录不变",
    );
    phase = "network/privacy and production isolation boundaries";
    assert.equal(
      external.length,
      0,
      "R5 E2E must not depend on external services",
    );
    assert.ok(
      fixtureGets.every(
        (value) =>
          value === "/local-bank/manifest.json" ||
          value === "/local-bank/prompts.json" ||
          wavs.some((wav) => value === `/local-bank/${wav.path}`),
      ),
      `unexpected local material access ${JSON.stringify(fixtureGets)}`,
    );
    assert.ok(
      privateReplies.every(
        (item) => item.cache.includes("no-store") && !item.worker,
      ),
      "learning responses must bypass the production service worker",
    );
    assert.ok(learningRequests.length > 0);
    for (const item of learningRequests) {
      assert.match(item.type, /application\/json/);
      for (const wav of wavs) {
        assert.equal(item.body.includes(wav.bytes), false);
        assert.equal(
          item.body.includes(
            Buffer.from(wav.bytes.toString("base64").slice(0, 200)),
          ),
          false,
        );
      }
      assert.doesNotMatch(
        item.body.toString("utf8"),
        /data:(?:audio|image)\/|"stimulusImage"|"audioBlob"|"recordingBlob"|"mimeType":"(?:audio|image)\//,
      );
    }
    assert.deepEqual(errors, []);
    evidence.productionWorkerControlled = true;
    evidence.privateReplies = privateReplies.length;
    evidence.learningJSONRequests = learningRequests.length;
    evidence.fixturePaths = [...new Set(fixtureGets)];
    evidence.syncedKinds = ["correction", "answerReview", "adjustment"];
    success = true;
  } catch (error) {
    failure = String(error.message ?? error)
      .replaceAll(password, "[redacted]")
      .replaceAll(setupToken, "[redacted]");
    const failedPage =
      phase.includes("mobile") && phone && !phone.isClosed() ? phone : desktop;
    evidence.failureStack = String(error.stack ?? error)
      .replaceAll(password, "[redacted]")
      .replaceAll(setupToken, "[redacted]");
    evidence.failureURL = failedPage?.url();
    evidence.failureText = await failedPage
      ?.locator("main")
      .innerText({ timeout: 2000 })
      .catch(() =>
        failedPage
          .locator("body")
          .innerText({ timeout: 2000 })
          .catch(() => "unavailable"),
      );
    evidence.failureLayout = await failedPage
      ?.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return {
          width,
          scroll: document.documentElement.scrollWidth,
          offset: visualViewport?.offsetLeft ?? 0,
          outside: [...document.querySelectorAll("body *")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.width > 0 && (rect.right > width + 1 || rect.left < -1)
              );
            })
            .slice(0, 20)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName,
                label: element.getAttribute("aria-label"),
                x: rect.x,
                width: rect.width,
                right: rect.right,
              };
            }),
        };
      })
      .catch(() => null);
    const file = path.join(
      os.tmpdir(),
      `band-r5-e2e-failure-${randomBytes(4).toString("hex")}.png`,
    );
    await failedPage?.screenshot({ path: file, fullPage: true }).then(
      () => {
        evidence.failureScreenshot = file;
      },
      () => {},
    );
  } finally {
    await Promise.all([
      desktopContext?.close().catch(() => null),
      phoneContext?.close().catch(() => null),
    ]);
    await browser?.close().catch(() => null);
    if (previewServer)
      await new Promise((resolve) => previewServer.httpServer.close(resolve));
    await stop(backend);
    await fs.rm(directory, { recursive: true, force: true });
  }
  const result = {
    suite:
      "R5 production correction, retest, weekly calibration and local completeness",
    success,
    durationSeconds: Number(
      (Number(process.hrtime.bigint() - runStarted) / 1e9).toFixed(3),
    ),
    pageErrors: errors,
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
  if (!(await runR5CorrectionCalibrationE2E()).success) process.exitCode = 1;
}
