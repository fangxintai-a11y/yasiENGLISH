import assert from "node:assert/strict";
import { chromium } from "playwright";
// Run against a local Vite app. Every context and source question is disposable.
const origin = process.env.BAND_AUTO_WS_E2E_ORIGIN || "http://localhost:5188";
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname),
  "Use a local test app",
);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || chromium.executablePath(),
  headless: true,
  args: ["--mute-audio"],
});
const evidence = [];
let activePage;
const wait = async (fn, why) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(why);
};
async function syntheticPrompts(page, course = false) {
  return page.evaluate(async (course) => {
    const { hashLocalPrompt } =
      await import("/src/study365/promptBankSchema.ts");
    const originals = course
      ? [
          ...Array.from({ length: 40 }, (_, index) => ({
            id: `course-t1-${String(index).padStart(3, "0")}`,
            version: "1",
            skill: "writing",
            taskType: "task1",
            questionType: "table",
            prompt: `Summarise self-authored fictional table ${index}.`,
            stimulusText: `Fictional table ${index}: Year A=${index + 10}; Year B=${index + 20}.`,
            stimulusHash: index.toString(16).padStart(64, "0"),
          })),
          ...Array.from({ length: 40 }, (_, index) => ({
            id: `course-t2-${String(index).padStart(3, "0")}`,
            version: "1",
            skill: "writing",
            taskType: "task2",
            questionType: "opinion",
            prompt: `Should fictional district ${index} add a public garden?`,
          })),
          ...[1, 2, 3].flatMap((part) =>
            Array.from({ length: 50 }, (_, index) => ({
              id: `course-p${part}-${String(index).padStart(3, "0")}`,
              version: "1",
              skill: "speaking",
              part,
              prompt: `Describe self-authored fictional district ${index} for Part ${part}.`,
            })),
          ),
        ]
      : [
          {
            id: "free-repeat-writing",
            version: "1",
            skill: "writing",
            taskType: "task2",
            questionType: "opinion",
            prompt: "Should the fictional city add a garden?",
          },
          ...[1, 2, 3].map((part) => ({
            id: `free-repeat-speaking-${part}`,
            version: "1",
            skill: "speaking",
            part,
            prompt: `Describe the fictional place for Part ${part}.`,
          })),
        ];
    return Promise.all(
      originals.map(async (prompt) => {
        const value = {
          ...prompt,
          sourceRef: "synthetic:repeat-test",
          materialSource: "unofficial",
          rights: "Self-authored isolated fixture",
        };
        return { ...value, contentHash: await hashLocalPrompt(value) };
      }),
    );
  }, course);
}
try {
  for (const startDate of [null, "2026-11-09", "2025-11-01"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = [];
    activePage = page;
    console.log(`Checking free practice with ${startDate ?? "no plan"}`);
    let fixtures = [];
    await context.route("**/local-bank/prompts.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ importVersion: 1, prompts: fixtures }),
      }),
    );
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.setFixedTime(new Date("2026-11-05T12:00:00+08:00"));
    await context.addInitScript(() =>
      localStorage.setItem(
        "word-atlas:settings",
        JSON.stringify({
          onboarded: true,
          splash: false,
          autoplay: false,
          sfx: false,
          ambience: "off",
          dailyNew: 0,
        }),
      ),
    );
    await page.goto(`${origin}/#/about`, { waitUntil: "networkidle" });
    fixtures = await syntheticPrompts(page);
    if (startDate)
      await page.evaluate(async (startDate) => {
        const { saveRecord } = await import("/src/study365/repository.ts");
        const { createPlanPayload } =
          await import("/src/study365/planRecords.ts");
        const { bundledRules } = await import("/src/study365/planData.ts");
        await saveRecord({
          id: "ielts-365-plan",
          kind: "plan",
          payload: createPlanPayload({
            startDate,
            timeZone: "Asia/Shanghai",
            rules: bundledRules,
          }),
        });
      }, startDate);
    await page.goto(`${origin}/#/writing`, { waitUntil: "networkidle" });
    const question = page.getByRole("textbox", { name: "题目", exact: true });
    await wait(
      async () =>
        (await question.count()) === 1 &&
        !!(await question.inputValue()).trim(),
      "free writing automatic prompt",
    );
    assert.equal(
      await page.getByLabel("练习类型", { exact: true }).inputValue(),
      "task2",
    );
    assert.ok((await page.locator("body").innerText()).includes("自主练习"));
    const original = await question.inputValue(),
      body = page.getByRole("textbox", { name: "作文正文", exact: true });
    const answer =
      "Self-authored isolated free-writing answer, with no real learner progress or exam response involved.";
    await body.fill(answer);
    await wait(
      async () =>
        /草稿已保存在本机/.test(
          await page.getByTestId("writing-local-status").innerText(),
        ),
      "free writing local save",
    );
    await page.reload({ waitUntil: "networkidle" });
    await wait(
      async () =>
        (await body.isVisible()) && (await body.inputValue()) === answer,
      "free draft restoration",
    );
    assert.equal(await question.inputValue(), original);
    await page
      .getByRole("button", { name: "保存本机检查点", exact: true })
      .click();
    await wait(
      () =>
        page.evaluate(async () => {
          const { readScope } = await import("/src/study365/db.ts");
          return Object.values((await readScope("guest")).heads).some(
            (r) => !r.deleted && r.kind === "essay",
          );
        }),
      "free checkpoint",
    );
    await page.goto(`${origin}/#/speaking`, { waitUntil: "networkidle" });
    const sq = page.getByRole("textbox", { name: "口语题目", exact: true });
    await wait(
      async () => (await sq.isVisible()) && !!(await sq.inputValue()).trim(),
      "free speaking automatic prompt",
    );
    const editor = page.locator('[aria-label="当前口语作答"]');
    await editor
      .getByRole("textbox", { name: "手动转写", exact: true })
      .fill(
        "Self-authored isolated free speaking transcript. No recording was used.",
      );
    await editor.getByRole("button", { name: "保存作答", exact: true }).click();
    await editor
      .getByRole("button", { name: "保存转写", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "结束本次自主练习", exact: true })
        .isEnabled(),
      true,
    );
    await page
      .getByRole("button", { name: "结束本次自主练习", exact: true })
      .click();
    const result = await page.evaluate(async () => {
      const { readScope } = await import("/src/study365/db.ts");
      const records = Object.values((await readScope("guest")).heads).filter(
        (r) => !r.deleted,
      );
      return {
        startDate: records.find((r) => r.kind === "plan").payload.startDate,
        works: records
          .filter((r) => r.kind === "essay" || r.kind === "speaking")
          .map((r) => ({
            kind: r.kind,
            date: r.payload.date,
            day: r.payload.day,
            task: r.payload.taskId,
          })),
        missions: records.filter((r) => r.kind === "mission").length,
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      };
    });
    assert.equal(result.startDate, startDate ?? "2026-11-05");
    assert.equal(result.missions, 0);
    assert.equal(result.works.length, 2);
    assert.ok(
      result.works.every(
        (w) => w.date === "2026-11-05" && w.task.startsWith("practice-"),
      ),
    );
    if (startDate) assert.ok(result.works.every((w) => w.day === undefined));
    assert.equal(result.width, result.scroll);
    assert.deepEqual(errors, []);
    evidence.push({ initialPlan: startDate ?? "none", ...result });
    await context.close();
  }
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = [];
    activePage = page;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date("2026-12-13T12:00:00+08:00"));
    await context.addInitScript(() =>
      localStorage.setItem(
        "word-atlas:settings",
        JSON.stringify({
          onboarded: true,
          splash: false,
          autoplay: false,
          sfx: false,
          ambience: "off",
          dailyNew: 0,
        }),
      ),
    );
    let fixtures = [];
    await context.route("**/local-bank/prompts.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ importVersion: 1, prompts: fixtures }),
      }),
    );
    await page.goto(`${origin}/#/about`, { waitUntil: "networkidle" });
    fixtures = await syntheticPrompts(page, true);
    const blocks = await page.evaluate(async () => {
      const { saveRecord } = await import("/src/study365/repository.ts");
      const { createPlanPayload } =
        await import("/src/study365/planRecords.ts");
      const { bundledRules } = await import("/src/study365/planData.ts");
      const plan = await saveRecord({
        id: "ielts-365-plan",
        kind: "plan",
        payload: createPlanPayload({
          startDate: "2026-11-09",
          timeZone: "Asia/Shanghai",
          rules: bundledRules,
        }),
      });
      const { loadPromptBank } = await import("/src/study365/promptBank.ts");
      const prompts = await loadPromptBank(null);
      const { buildDailyMaterialPlan } =
        await import("/src/study365/dailyMaterialPlan.ts");
      const day = buildDailyMaterialPlan({
        plan,
        records: [],
        bank: [],
        prompts,
        throughDay: 35,
      }).days.at(-1);
      window.courseExpected = day.blocks
        .filter(
          (block) => block.skill === "writing" || block.skill === "speaking",
        )
        .map((block) => ({
          ...block,
          expected: block.materials.map((ref) => ({
            ...ref,
            prompt: prompts.find(
              (prompt) =>
                prompt.id === ref.id &&
                prompt.version === ref.version &&
                prompt.contentHash === ref.contentHash,
            ).prompt,
          })),
        }));
      return window.courseExpected.map((block) => ({
        skill: block.skill,
        taskId: block.taskId,
        route: block.route,
        count: block.materials.length,
      }));
    });
    for (const block of blocks) {
      assert.ok(block.route);
      await page.goto(`${origin}/${block.route}`, { waitUntil: "networkidle" });
      if (block.skill === "writing") {
        const fields = page.getByRole("textbox", { name: "题目", exact: true });
        await wait(
          async () => (await fields.count()) === 2,
          "course auto pair",
        );
        const values = await Promise.all(
          (await fields.all()).map((field) => field.inputValue()),
        );
        assert.equal(
          await page.evaluate(
            ({ task, values }) =>
              window.courseExpected
                .find((block) => block.taskId === task)
                .expected.every((ref) => values.includes(ref.prompt)),
            { task: block.taskId, values },
          ),
          true,
        );
        assert.equal(
          await page
            .getByRole("region", { name: "Task 1原题材料", exact: true })
            .count(),
          1,
        );
      } else {
        const field = page.getByRole("textbox", {
          name: "口语题目",
          exact: true,
        });
        await field.waitFor();
        for (const part of [1, 2, 3]) {
          assert.equal(
            await page.getByLabel("口语部分", { exact: true }).inputValue(),
            String(part),
          );
          const value = await field.inputValue();
          assert.equal(
            await page.evaluate(
              ({ task, part, value }) =>
                window.courseExpected
                  .find((block) => block.taskId === task)
                  .expected.find((ref) => ref.part === part).prompt === value,
              { task: block.taskId, part, value },
            ),
            true,
          );
          const editor = page.locator('[aria-label="当前口语作答"]');
          await editor
            .getByRole("textbox", { name: "手动转写", exact: true })
            .fill(`Self-authored isolated course Part ${part} transcript.`);
          await editor
            .getByRole("button", { name: "保存作答", exact: true })
            .click();
          await editor
            .getByRole("button", { name: "保存转写", exact: true })
            .waitFor();
          if (part < 3)
            await page
              .getByRole("button", {
                name: `继续平台安排：Part ${part + 1}`,
                exact: true,
              })
              .click();
        }
        await page
          .getByRole("button", { name: "完成本次口语", exact: true })
          .click();
        await wait(
          () =>
            page.evaluate(async () => {
              const { readScope } = await import("/src/study365/db.ts");
              return Object.values((await readScope("guest")).heads).some(
                (work) =>
                  work.kind === "mission" &&
                  work.payload.taskId === "d35-speaking" &&
                  work.payload.status === "completed",
              );
            }),
          "course mission still completes",
        );
      }
      const width = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.equal(width.width, width.scroll);
      assert.deepEqual(errors, []);
    }
    evidence.push({
      courseDay: 35,
      skippedEarlierTasks: true,
      pairAndAllSpeakingPartsMatchProjection: true,
      courseMissionStillWorks: true,
    });
    await context.close();
  }
  {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      }),
      page = await context.newPage();
    let fixtures = [];
    await page.clock.setFixedTime(new Date("2026-11-05T12:00:00+08:00"));
    await context.addInitScript(() =>
      localStorage.setItem(
        "word-atlas:settings",
        JSON.stringify({
          onboarded: true,
          splash: false,
          autoplay: false,
          sfx: false,
          ambience: "off",
          dailyNew: 0,
        }),
      ),
    );
    await context.route("**/local-bank/prompts.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ importVersion: 1, prompts: fixtures }),
      }),
    );
    await page.goto(`${origin}/#/about`, { waitUntil: "networkidle" });
    fixtures = await syntheticPrompts(page);
    await page.evaluate(async (fixtures) => {
      const { saveRecord } = await import("/src/study365/repository.ts");
      const { createPlanPayload } =
        await import("/src/study365/planRecords.ts");
      const { bundledRules } = await import("/src/study365/planData.ts");
      const plan = await saveRecord({
        id: "ielts-365-plan",
        kind: "plan",
        payload: createPlanPayload({
          startDate: "2026-11-01",
          timeZone: "Asia/Shanghai",
          rules: bundledRules,
        }),
      });
      for (const p of fixtures)
        await saveRecord({
          id: `old-${p.id}`,
          kind: p.skill === "writing" ? "essay" : "speaking",
          payload: {
            planId: plan.id,
            date: "2026-11-04",
            taskId: `practice-${p.skill}-2026-11-04`,
            contentId: p.id,
            contentVersion: p.version,
            prompt: p.prompt,
            conditions: { timed: false, firstAttempt: true, unseen: true },
            ...(p.skill === "writing"
              ? {
                  taskType: "task2",
                  scope: "full",
                  stage: "submitted",
                  text: "Self-authored prior answer.",
                }
              : {
                  part: p.part,
                  transcript: "Self-authored prior transcript.",
                }),
          },
        });
    }, fixtures);
    await page.goto(`${origin}/#/writing`, { waitUntil: "networkidle" });
    const body = page.getByRole("textbox", { name: "作文正文", exact: true });
    await body.waitFor();
    assert.equal(
      await page.getByLabel("这是未做过的题目", { exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByLabel("这是未做过的题目", { exact: true }).isChecked(),
      false,
    );
    assert.ok(
      (await page.locator("body").innerText()).includes("复习已做原题"),
    );
    await body.fill("Self-authored repeat answer.");
    await page
      .getByRole("button", { name: "保存本机检查点", exact: true })
      .click();
    await wait(
      () =>
        page.evaluate(async () => {
          const { readScope } = await import("/src/study365/db.ts");
          return Object.values((await readScope("guest")).heads).some(
            (r) => r.kind === "essay" && r.payload.date === "2026-11-05",
          );
        }),
      "repeat writing saved",
    );
    await page.goto(`${origin}/#/speaking`, { waitUntil: "networkidle" });
    const editor = page.locator('[aria-label="当前口语作答"]');
    await editor.waitFor();
    assert.equal(
      await page.getByLabel("这是未做过的题目", { exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByLabel("这是未做过的题目", { exact: true }).isChecked(),
      false,
    );
    assert.ok(
      (await page.locator("body").innerText()).includes("复习已做原题"),
    );
    await editor
      .getByRole("textbox", { name: "手动转写", exact: true })
      .fill("Self-authored repeat transcript.");
    await editor.getByRole("button", { name: "保存作答", exact: true }).click();
    await editor
      .getByRole("button", { name: "保存转写", exact: true })
      .waitFor();
    const result = await page.evaluate(async () => {
      const { readScope } = await import("/src/study365/db.ts");
      const records = Object.values((await readScope("guest")).heads).filter(
        (r) => !r.deleted,
      );
      return {
        repeatWorks: records
          .filter(
            (r) =>
              ["essay", "speaking"].includes(r.kind) &&
              r.payload.date === "2026-11-05",
          )
          .map((r) => ({ kind: r.kind, conditions: r.payload.conditions })),
        missions: records.filter((r) => r.kind === "mission").length,
      };
    });
    assert.equal(result.repeatWorks.length, 2);
    assert.ok(
      result.repeatWorks.every(
        (w) =>
          w.conditions.firstAttempt === false && w.conditions.unseen === false,
      ),
    );
    assert.equal(result.missions, 0);
    evidence.push({ repeatFallback: true, ...result });
    const history = await page.evaluate(async () => {
      const { readScope } = await import("/src/study365/db.ts");
      const records = Object.values((await readScope("guest")).heads);
      const oldEssay = records.find(
        (work) => work.id === "old-free-repeat-writing",
      );
      const { saveRecord } = await import("/src/study365/repository.ts");
      const courseWork = await saveRecord({
        id: "old-course-writing",
        kind: "essay",
        payload: { ...oldEssay.payload, day: 4, taskId: "d4-writing" },
      });
      return {
        essay: courseWork.id,
        speaking: records.find(
          (work) => work.id === "old-free-repeat-speaking-1",
        ).id,
      };
    });
    await page.goto(
      `${origin}/#/writing?work=${history.essay}&date=2026-11-04&day=4&task=d4-writing`,
      { waitUntil: "networkidle" },
    );
    await page.getByRole("button", { name: "新写一篇", exact: true }).click();
    await wait(
      async () =>
        (await page.locator("body").innerText()).includes(
          "自主练习 · 2026-11-05",
        ),
      "historical course new writing uses today practice",
    );
    await page.goto(
      `${origin}/#/speaking?work=${history.speaking}&date=2026-11-04&task=practice-speaking-2026-11-04`,
      { waitUntil: "networkidle" },
    );
    await page.getByRole("button", { name: "重录这题", exact: true }).click();
    const nextEditor = page.locator('[aria-label="当前口语作答"]');
    await nextEditor
      .getByRole("textbox", { name: "手动转写", exact: true })
      .fill("Self-authored new practice after opening a historical answer.");
    await nextEditor
      .getByRole("button", { name: "保存作答", exact: true })
      .click();
    await nextEditor
      .getByRole("button", { name: "保存转写", exact: true })
      .waitFor();
    const resumed = await page.evaluate(async () => {
      const { readScope } = await import("/src/study365/db.ts");
      const records = Object.values((await readScope("guest")).heads);
      const old = records.find(
        (work) => work.id === "old-free-repeat-speaking-1",
      );
      const next = records.find(
        (work) =>
          work.kind === "speaking" &&
          work.payload.parentRevisionId === old.revisionId,
      );
      return {
        oldDate: old.payload.date,
        newDate: next?.payload.date,
        newDay: next?.payload.day,
        newTask: next?.payload.taskId,
        missions: records.filter((work) => work.kind === "mission").length,
      };
    });
    assert.equal(resumed.oldDate, "2026-11-04");
    assert.equal(resumed.newDate, "2026-11-05");
    assert.equal(resumed.newDay, 5);
    assert.equal(resumed.newTask, "practice-speaking-2026-11-05");
    assert.equal(resumed.missions, 0);
    evidence.push({ historicalWorkStartsNewPracticeToday: true, ...resumed });
    await context.close();
  }
  console.log(JSON.stringify({ success: true, evidence }, null, 2));
} catch (error) {
  console.error(String(error));
  console.error(
    await activePage
      ?.locator("body")
      .innerText()
      .catch(() => "No page"),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
