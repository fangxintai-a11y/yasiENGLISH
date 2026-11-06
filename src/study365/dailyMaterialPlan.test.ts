import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  automaticCheckpointCycles,
  automaticMaterialForTask,
  buildDailyMaterialPlan,
  promptPoolForDay,
  selectIndependentListeningReading,
  wasListeningReadingAttempted,
} from "./dailyMaterialPlan";
import type { LocalMaterial } from "./localBankSchema";
import type { LocalPrompt } from "./promptBankSchema";
import type { Revision } from "./protocol";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const plan: Revision = {
  id: "auto-plan",
  kind: "plan",
  planId: "auto-plan",
  datasetId: null,
  revisionId: "00000000-0000-4000-8000-000000000001",
  baseRevision: null,
  createdAt: 1,
  seq: 1,
  deleted: false,
  conflict: false,
  contentHash: hash("plan"),
  payload: {
    startDate: "2026-11-09",
    timeZone: "Asia/Shanghai",
    enabled: true,
  },
};
function material(
  skill: "reading" | "listening",
  index: number,
  scope: LocalMaterial["scope"] = "section",
  pool: "practice" | "holdout" = "practice",
): LocalMaterial {
  const id = `${skill}-${scope}-${pool}-${String(index).padStart(3, "0")}`;
  const questions = Array.from(
    { length: scope === "full" ? 40 : 2 },
    (_, at) => ({
      id: `q${at + 1}`,
      type: skill === "reading" ? "true-false-not-given" : "note-completion",
      prompt: `Self-authored item ${at + 1}`,
      answer: { accepted: ["a"], maxWords: 1 },
      evidence: {},
      answerVerified: true,
    }),
  );
  const common = {
    id,
    title: `Self-authored ${id}`,
    version: "1",
    contentHash: hash(id),
    skill,
    scope,
    pool,
    deliveryMode: "local-import",
    questions,
    source: {
      materialSource: "unofficial",
      sourceRef: `synthetic:${id}`,
      rights: "Self-authored QA fixture",
      answerVerified: true,
    },
  };
  return (
    skill === "reading"
      ? {
          ...common,
          passage: `Original reading article ${index} for ${scope} ${pool}.`,
          paragraphs: [{ id: "p1", text: `Original article ${id}.` }],
          passageNumber: ((index % 3) + 1) as 1 | 2 | 3,
        }
      : {
          ...common,
          transcript: `Original listening track ${index} for ${scope} ${pool}.`,
          audio: {
            path: `audio/${id}.mp3`,
            sha256: hash(`audio-${id}`),
            durationSeconds: scope === "full" ? 1500 : 600,
          },
          section: 1,
        }
  ) as LocalMaterial;
}
function prompt(
  skill: "writing" | "speaking",
  index: number,
  target: "task1" | "task2" | 1 | 2 | 3,
  pool: "practice" | "holdout" = "practice",
): LocalPrompt {
  const id = `${skill}-${target}-${pool}-${String(index).padStart(3, "0")}`;
  return {
    id,
    version: "1",
    contentHash: hash(id),
    skill,
    pool,
    prompt: `Self-authored original ${id}.`,
    sourceRef: `synthetic:${id}`,
    materialSource: "unofficial",
    rights: "Self-authored QA fixture",
    ready: true,
    ...(skill === "writing"
      ? {
          taskType: target,
          questionType: index % 2 ? "opinion" : "discussion",
          ...(target === "task1"
            ? {
                stimulusHash: hash(id),
                stimulusText: "A self-authored table: A=1, B=2.",
              }
            : {}),
        }
      : { part: target }),
  } as LocalPrompt;
}
function inventory() {
  const bank = (["reading", "listening"] as const).flatMap((skill) => [
    ...Array.from({ length: 45 }, (_, index) => material(skill, index)),
    ...Array.from({ length: 12 }, (_, index) => material(skill, index, "full")),
    ...Array.from({ length: 8 }, (_, index) =>
      material(skill, index, "full", "holdout"),
    ),
  ]);
  const prompts = [
    ...Array.from({ length: 15 }, (_, index) =>
      prompt("writing", index, "task1"),
    ),
    ...Array.from({ length: 30 }, (_, index) =>
      prompt("writing", index, "task2"),
    ),
    ...([1, 2, 3] as const).flatMap((part) =>
      Array.from({ length: 25 }, (_, index) => prompt("speaking", index, part)),
    ),
  ];
  const officialReading = material("reading", 1000, "type-drill");
  bank.push({
    ...officialReading,
    source: { ...officialReading.source, materialSource: "official" },
  });
  return { bank, prompts };
}
function work(
  item: LocalMaterial,
  date: string,
  day: number,
  taskId = `d${day}-${item.skill}`,
): Revision {
  return {
    ...plan,
    id: `work-${item.id}`,
    revisionId: "00000000-0000-4000-8000-000000000002",
    kind: "attempt",
    createdAt: 2,
    seq: 2,
    payload: {
      planId: plan.id,
      date,
      day,
      taskId,
      skill: item.skill,
      contentId: item.id,
      contentVersion: item.version,
      contentHash: item.contentHash,
      scope: item.scope,
      materialSource: item.source.materialSource,
      answers: item.questions.map(() => "a"),
      total: item.questions.length,
      score: 1,
      firstAttempt: true,
      questionResults: item.questions.map((question) => ({
        questionId: question.id,
        correct: false,
        reviewCorrect: false,
      })),
    },
  };
}

test("eight checkpoint cycles come from existing whole-exam blocks; baseline writing/speaking remains practice", () => {
  const cycles = automaticCheckpointCycles();
  assert.deepEqual(
    cycles.map((value) => value.listening),
    [1, 90, 209, 300, 304, 349, 356, 363],
  );
  assert.equal(cycles[0].writing, 2);
  assert.equal(cycles[0].speaking, 3);
  assert.equal(promptPoolForDay(2, "writing"), "practice");
  assert.equal(promptPoolForDay(3, "speaking"), "practice");
  assert.equal(promptPoolForDay(91, "writing"), "holdout");
  assert.equal(promptPoolForDay(91, "speaking"), "holdout");
  assert.equal(promptPoolForDay(4, "writing"), "practice");
});
test("baseline is auto-assigned in the original 120-minute rhythm with a required reading warmup and the complete timed exam", () => {
  const inputs = inventory(),
    snapshot = JSON.stringify(inputs);
  const result = buildDailyMaterialPlan({
    plan,
    records: [],
    ...inputs,
    throughDay: 3,
  });
  assert.ok(
    result.days.every(
      (day) =>
        day.blocks.reduce((sum, block) => sum + block.minutes, 0) === 120,
    ),
  );
  const first = result.days[0].blocks.filter(
    (block) => block.skill === "listening" || block.skill === "reading",
  );
  assert.deepEqual(
    first.map((block) => block.materials.length),
    [1, 2],
  );
  for (const block of first) {
    assert.equal(block.status, "assigned");
    const main = block.materials.find((item) => item.role === "assessment")!;
    assert.equal(main.scope, "full");
    assert.equal(main.pool, "holdout");
    const route = new URL(`http://fixture/${main.route}`);
    const query = new URLSearchParams(route.hash.split("?")[1]);
    assert.equal(query.get("task"), block.taskId);
    assert.equal(query.get("date"), block.date);
    assert.equal(query.get("material"), `${main.id}@1@${main.contentHash}`);
  }
  assert.deepEqual(
    result.days[1].blocks
      .find((block) => block.skill === "writing")!
      .materials.map((item) => item.taskType),
    ["task1", "task2"],
  );
  assert.deepEqual(
    result.days[2].blocks
      .find((block) => block.skill === "speaking")!
      .materials.map((item) => item.part),
    [1, 2, 3],
  );
  assert.equal(
    JSON.stringify(inputs),
    snapshot,
    "planning must not create progress or mutate the inventory",
  );
  const baselineReading = first.find((block) => block.skill === "reading")!;
  assert.equal(baselineReading.materials[0].role, "calibration");
  assert.equal(baselineReading.materials[1].scope, "full");
  assert.match(baselineReading.materials[1].route, /minutes=60/);
  assert.equal(baselineReading.route, baselineReading.materials[0].route);
  assert.match(baselineReading.notice, /主练计时不缩短/);
});
test("inventory reordering cannot change a plan and future reservations do not repeat the same original", () => {
  const { bank, prompts } = inventory();
  const a = buildDailyMaterialPlan({
    plan,
    records: [],
    bank,
    prompts,
    throughDay: 30,
  });
  const b = buildDailyMaterialPlan({
    plan,
    records: [],
    bank: [...bank].reverse(),
    prompts: [...prompts].reverse(),
    throughDay: 30,
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const main = a.days
    .flatMap((day) => day.blocks.flatMap((block) => block.materials))
    .filter((item) => item.role !== "calibration");
  assert.equal(
    main.length,
    new Set(
      main.map(
        (item) => `${item.kind}:${item.id}@${item.version}@${item.contentHash}`,
      ),
    ).size,
  );
  assert.equal(
    automaticMaterialForTask(
      { plan, records: [], bank, prompts },
      { day: 1, taskId: "d1-listening" },
    )!.materials[0].id,
    a.days[0].blocks[0].materials[0].id,
  );
});
test("starting on Thursday keeps Day 1 materials and the training rhythm while routes use the actual civil date", () => {
  const inputs = inventory();
  const monday = buildDailyMaterialPlan({
    plan,
    records: [],
    ...inputs,
    throughDay: 3,
  });
  const thursday = buildDailyMaterialPlan({
    plan: { ...plan, payload: { ...plan.payload, startDate: "2026-11-05" } },
    records: [],
    ...inputs,
    throughDay: 3,
  });
  assert.equal(thursday.days[0].date, "2026-11-05");
  assert.deepEqual(
    thursday.days.map((day) =>
      day.blocks.map((block) => block.materials.map((item) => item.id)),
    ),
    monday.days.map((day) =>
      day.blocks.map((block) => block.materials.map((item) => item.id)),
    ),
  );
  assert.ok(thursday.days[0].blocks[0].route?.includes("date=2026-11-05"));
});
test("a saved exact work is pinned and missing its original version never silently assigns a replacement", () => {
  const inputs = inventory();
  const first = buildDailyMaterialPlan({
    plan,
    records: [],
    ...inputs,
    throughDay: 1,
  }).days[0].blocks[0].materials[0];
  const original = inputs.bank.find((item) => item.id === first.id)!;
  const old = work(original, "2026-11-09", 1);
  const next = buildDailyMaterialPlan({
    plan,
    records: [old],
    ...inputs,
    throughDay: 1,
  }).days[0].blocks[0];
  assert.equal(next.materials[0].id, original.id);
  assert.equal(next.materials[0].workId, old.id);
  assert.equal(next.materials[0].completed, true);
  const missing = buildDailyMaterialPlan({
    plan,
    records: [old],
    bank: inputs.bank.filter((item) => item !== original),
    prompts: inputs.prompts,
    throughDay: 1,
  }).days[0].blocks[0];
  assert.equal(missing.status, "missing");
  assert.deepEqual(missing.materials, []);
  assert.match(missing.notice, /不改派/);
  assert.ok(missing.route?.includes("work="));
});
test("reserved body, audio aliases and holdout originals cannot leak into day practice", () => {
  const original = material("listening", 1),
    alias = { ...original, id: "audio-alias", title: "Changed title only" };
  const held = material("reading", 2, "section", "holdout"),
    heldAlias = { ...held, id: "held-alias", pool: "practice" as const };
  const bank = [original, alias, held, heldAlias, material("reading", 0)];
  const result = buildDailyMaterialPlan({
    plan,
    records: [],
    bank,
    prompts: [],
    throughDay: 12,
  });
  const entries = result.days
    .flatMap((day) => day.blocks.flatMap((block) => block.materials))
    .filter((item) => item.role !== "calibration");
  assert.ok(entries.filter((item) => item.skill === "listening").length <= 1);
  assert.ok(
    entries.every((item) => item.id !== held.id && item.id !== heldAlias.id),
  );
});
test("an in-progress local draft stays on its exact material even when a new inventory item would sort first", () => {
  const inputs = inventory(),
    original = inputs.bank.find(
      (item) => item.skill === "listening" && item.pool === "holdout",
    )!;
  const local = {
    skill: "listening" as const,
    date: "2026-11-09",
    taskId: "d1-listening",
    id: original.id,
    version: original.version,
    contentHash: original.contentHash,
    updatedAt: 1,
  };
  const earlier = {
    ...material("listening", 90, "full", "holdout"),
    id: "a-earlier-holdout",
  };
  const result = automaticMaterialForTask(
    {
      plan,
      records: [],
      bank: [earlier, ...inputs.bank],
      prompts: inputs.prompts,
      localMaterials: [local],
    },
    { day: 1, taskId: local.taskId },
  )!;
  assert.equal(result.materials[0].id, original.id);
  assert.equal(result.materials[0].completed, false);
  const hashOnly = {
    skill: local.skill,
    date: local.date,
    taskId: local.taskId,
    contentHash: local.contentHash,
    updatedAt: local.updatedAt,
  };
  const recovered = automaticMaterialForTask(
    {
      plan,
      records: [],
      bank: [earlier, ...inputs.bank],
      prompts: inputs.prompts,
      localMaterials: [hashOnly],
    },
    { day: 1, taskId: local.taskId },
  )!;
  assert.equal(recovered.materials[0].id, original.id);
  const missing = automaticMaterialForTask(
    {
      plan,
      records: [],
      bank: [earlier],
      prompts: inputs.prompts,
      localMaterials: [local],
    },
    { day: 1, taskId: local.taskId },
  )!;
  assert.equal(missing.status, "missing");
  assert.deepEqual(missing.materials, []);
  assert.match(missing.notice, /不改派/);
  const missingHashOnly = automaticMaterialForTask(
    {
      plan,
      records: [],
      bank: [earlier],
      prompts: inputs.prompts,
      localMaterials: [hashOnly],
    },
    { day: 1, taskId: local.taskId },
  )!;
  assert.equal(missingHashOnly.status, "missing");
  assert.deepEqual(missingHashOnly.materials, []);
});
test("insufficient inventory remains an explicit gap over 365 days, never reused filler or a score", () => {
  const inputs = inventory(),
    records: Revision[] = [],
    snapshot = JSON.stringify(records);
  const result = buildDailyMaterialPlan({ plan, records, ...inputs });
  assert.equal(result.days.length, 365);
  assert.ok(result.summary.missingBlocks > 0);
  assert.ok(result.days.every((day) => day.totalMinutes === 120));
  const writingGate = result.days[90].blocks.find(
    (block) => block.skill === "writing",
  )!;
  assert.equal(writingGate.checkpoint, true);
  assert.equal(writingGate.status, "missing");
  assert.deepEqual(writingGate.materials, []);
  assert.ok(
    result.days
      .flatMap((day) => day.blocks)
      .filter((block) => block.status === "missing")
      .every((block) => block.notice.length > 0),
  );
  assert.equal(JSON.stringify(records), snapshot);
  assert.equal("records" in result, false);
  assert.equal("score" in result, false);
});
test("a flexible block keeps its saved skill, time and exact material when current score gaps would choose writing", () => {
  const inputs = inventory(),
    original = material("reading", 900, "full");
  const date = "2027-09-06",
    day = 302,
    taskId = "d302-timed-section";
  const mission: Revision = {
    ...plan,
    kind: "mission",
    id: "saved-flexible-mission",
    createdAt: 3,
    payload: {
      planId: plan.id,
      date,
      taskId,
      skill: "reading",
      plannedMinutes: 55,
    },
  };
  const old = work(original, date, day, taskId);
  const result = automaticMaterialForTask(
    {
      plan,
      records: [mission, old],
      bank: [...inputs.bank, original],
      prompts: inputs.prompts,
    },
    { day, taskId },
  )!;
  assert.equal(result.skill, "reading");
  assert.equal(result.minutes, 55);
  assert.equal(result.materials[0].id, original.id);
  assert.equal(result.materials[0].workId, old.id);
  assert.ok(result.route?.includes("minutes=55"));
  const listening = material("listening", 901, "full");
  const workWins = automaticMaterialForTask(
    {
      plan,
      records: [mission, work(listening, date, day, taskId)],
      bank: [...inputs.bank, listening],
      prompts: inputs.prompts,
    },
    { day, taskId },
  )!;
  assert.equal(
    workWins.skill,
    "listening",
    "the actual answer has priority over a stale mission skill",
  );
  assert.equal(workWins.materials[0].id, listening.id);
});
test("a flexible local hash-only draft infers the original skill or blocks reassignment when the original is unavailable", () => {
  const inputs = inventory(),
    original = material("reading", 902, "full");
  const day = 302,
    taskId = "d302-timed-section";
  const local = {
    date: "2027-09-06",
    taskId,
    contentHash: original.contentHash,
    updatedAt: 3,
  };
  const context = { day, taskId };
  const found = automaticMaterialForTask(
    {
      plan,
      records: [],
      bank: [...inputs.bank, original],
      prompts: inputs.prompts,
      localMaterials: [local],
    },
    context,
  )!;
  assert.equal(found.skill, "reading");
  assert.equal(found.materials[0].id, original.id);
  const missing = automaticMaterialForTask(
    { plan, records: [], ...inputs, localMaterials: [local] },
    context,
  )!;
  assert.equal(missing.status, "missing");
  assert.equal(missing.route, null);
  assert.deepEqual(missing.materials, []);
  assert.match(missing.notice, /无法识别原科目/);
});
test("first-fourteen-day official warmup stays available after a main answer was saved and resumes before new work", () => {
  const inputs = inventory(),
    official = {
      ...material("reading", 300, "type-drill"),
      source: {
        ...material("reading", 300).source,
        materialSource: "official" as const,
      },
    };
  const bank = [...inputs.bank, official];
  const first = buildDailyMaterialPlan({
    plan,
    records: [],
    bank,
    prompts: inputs.prompts,
    throughDay: 4,
  }).days[3].blocks.find((block) => block.skill === "reading")!;
  const main = first.materials.find((item) => item.role === "practice")!;
  assert.ok(first.materials.some((item) => item.role === "calibration"));
  const old = work(
    bank.find((item) => item.id === main.id)!,
    "2026-11-12",
    4,
  );
  const next = buildDailyMaterialPlan({
    plan,
    records: [old],
    bank,
    prompts: inputs.prompts,
    throughDay: 4,
  }).days[3].blocks.find((block) => block.skill === "reading")!;
  assert.equal(
    next.materials.find((item) => item.role === "practice")!.workId,
    old.id,
  );
  assert.equal(
    next.route,
    next.materials.find((item) => item.role === "calibration")!.route,
  );
});
test("a stored short main answer stays pinned and cannot masquerade as completion of a full baseline block", () => {
  const inputs = inventory(),
    original = material("reading", 903);
  const old = work(original, "2026-11-09", 1);
  const result = automaticMaterialForTask(
    {
      plan,
      records: [old],
      bank: [...inputs.bank, original],
      prompts: inputs.prompts,
    },
    { day: 1, taskId: "d1-reading" },
  )!;
  assert.equal(result.materials.length, 2);
  assert.equal(result.materials[1].id, original.id);
  assert.equal(result.status, "partial");
  assert.match(result.notice, /不是本块所需整套/);
});
test("an official warmup local draft locks its exact version without becoming a duplicate main article", () => {
  const inputs = inventory(),
    official = {
      ...material("reading", 904, "type-drill"),
      source: {
        ...material("reading", 904).source,
        materialSource: "official" as const,
      },
    };
  const earlier = {
    ...official,
    id: "a-new-official-first",
    contentHash: hash("new-official"),
    passage: "Entirely different warmup.",
  } as LocalMaterial;
  const local = {
    date: "2026-11-12",
    taskId: "d4-reading",
    contentHash: official.contentHash,
    updatedAt: 2,
  };
  const result = automaticMaterialForTask(
    {
      plan,
      records: [],
      bank: [earlier, ...inputs.bank, official],
      prompts: inputs.prompts,
      localMaterials: [local],
    },
    { day: 4, taskId: local.taskId },
  )!;
  assert.equal(result.materials.length, 2);
  assert.equal(
    result.materials.filter((item) => item.id === official.id).length,
    1,
  );
  assert.equal(result.materials[0].id, official.id);
  assert.equal(result.materials[0].role, "calibration");
  assert.equal(result.materials[1].scope, "section");
  const old = work(official, "2026-11-12", 4);
  const missing = automaticMaterialForTask(
    {
      plan,
      records: [old],
      bank: [earlier, ...inputs.bank],
      prompts: inputs.prompts,
    },
    { day: 4, taskId: local.taskId },
  )!;
  assert.equal(missing.status, "partial");
  assert.ok(missing.route?.includes("work="));
  assert.equal(
    missing.materials.some((item) => item.role === "calibration"),
    false,
  );
  assert.match(missing.notice, /缺少已保存题型练习的原版材料/);
});
test("a twenty-minute early reading lesson still exposes its required warmup and resumes the main article after review", () => {
  const inputs = inventory(),
    day = 4,
    date = "2026-11-12",
    taskId = "d4-reading";
  const mission: Revision = {
    ...plan,
    id: "short-reading-block",
    kind: "mission",
    payload: {
      planId: plan.id,
      date,
      taskId,
      skill: "reading",
      plannedMinutes: 20,
    },
  };
  const first = automaticMaterialForTask(
    { plan, records: [mission], ...inputs },
    { day, taskId },
  )!;
  assert.equal(first.minutes, 20);
  assert.equal(first.materials.length, 2);
  assert.equal(first.materials[0].role, "calibration");
  assert.equal(first.materials[1].scope, "section");
  assert.equal(first.route, first.materials[0].route);
  const official = inputs.bank.find(
    (item) => item.id === first.materials[0].id,
  )!;
  const reviewed = work(official, date, day, taskId);
  const next = automaticMaterialForTask(
    { plan, records: [mission, reviewed], ...inputs },
    { day, taskId },
  )!;
  assert.equal(next.materials.length, 2);
  assert.equal(next.materials[0].workId, reviewed.id);
  assert.equal(next.materials[0].completed, true);
  assert.equal(next.materials[1].scope, "section");
  assert.equal(next.route, next.materials[1].route);
});
test("an early reading lesson with no real official warmup is partial even when a complete main paper is available", () => {
  const inputs = inventory();
  const bank = inputs.bank.filter(
    (item) => item.source.materialSource !== "official",
  );
  const result = buildDailyMaterialPlan({
    plan,
    records: [],
    bank,
    prompts: inputs.prompts,
    throughDay: 4,
  });
  for (const day of [result.days[0], result.days[3]]) {
    const reading = day.blocks.find((block) => block.skill === "reading")!;
    assert.equal(reading.status, "partial");
    assert.equal(reading.materials.length, 1);
    assert.equal(reading.materials[0].role === "calibration", false);
    assert.match(reading.notice, /缺少本课必需的可用官方阅读题型热身/);
  }
  assert.ok(result.days.every((day) => day.totalMinutes === 120));
});
test("independent reading automatically picks a fresh twenty-minute section without requiring a course day or start date", () => {
  const lower = material("reading", 0),
    higher = material("reading", 1),
    full = material("reading", 2, "full");
  const held = material("reading", 3, "section", "holdout"),
    alias = { ...held, id: "a-held-alias", pool: "practice" as const };
  const bank = [full, higher, held, alias, lower],
    snapshot = JSON.stringify(bank);
  const result = selectIndependentListeningReading({
    skill: "reading",
    bank,
    records: [],
    preferredPassageNumber: 2,
  });
  assert.equal(result.status, "assigned");
  assert.equal(result.material?.id, higher.id);
  assert.equal(result.repeat, false);
  assert.match(result.notice, /约20分钟/);
  assert.equal(JSON.stringify(bank), snapshot);
  assert.deepEqual(
    selectIndependentListeningReading({
      skill: "reading",
      bank: [...bank].reverse(),
      records: [],
      preferredPassageNumber: 2,
    }),
    result,
  );
});
test("independent practice checks all account plans and explicitly repeats an available original only after fresh material is exhausted", () => {
  const original = material("reading", 910),
    fresh = material("reading", 911),
    held = material("reading", 912, "section", "holdout");
  const old = {
    ...work(original, "2025-01-01", 1),
    planId: "a-different-plan",
    payload: {
      ...work(original, "2025-01-01", 1).payload,
      planId: "a-different-plan",
    },
  };
  const selected = selectIndependentListeningReading({
    skill: "reading",
    bank: [original, fresh, held],
    records: [old],
  });
  assert.equal(selected.material?.id, fresh.id);
  assert.equal(selected.repeat, false);
  const repeated = selectIndependentListeningReading({
    skill: "reading",
    bank: [original, held],
    records: [old],
  });
  assert.equal(repeated.material, original);
  assert.equal(repeated.repeat, true);
  assert.match(repeated.notice, /重复练习.*不算未见新题或独立测评/);
  const missing = selectIndependentListeningReading({
    skill: "reading",
    bank: [held],
    records: [old],
  });
  assert.equal(missing.material, null);
  assert.equal(missing.status, "missing");
  assert.equal(missing.repeat, false);
  const freshFull = material("reading", 913, "full");
  const full = selectIndependentListeningReading({
    skill: "reading",
    bank: [original, freshFull],
    records: [old],
  });
  assert.equal(
    full.material?.id,
    freshFull.id,
    "fresh real papers take priority over repeated articles",
  );
  assert.equal(full.repeat, false);
  assert.match(full.notice, /整套/);
});
test("independent listening rejects missing audio and all holdout audio aliases while keeping the precise practiced version", () => {
  const original = material("listening", 914),
    held = material("listening", 915, "section", "holdout");
  assert.equal(original.skill, "listening");
  assert.equal(held.skill, "listening");
  if (original.skill !== "listening" || held.skill !== "listening")
    throw new Error("Fixture skill mismatch");
  const alias = {
    ...material("listening", 916),
    audio: { ...held.audio!, sha256: hash("another-alias-hash") },
  } as LocalMaterial;
  const noAudio = {
    ...material("listening", 917),
    audio: undefined,
  } as LocalMaterial;
  const old = work(original, "2025-01-02", 1);
  const result = selectIndependentListeningReading({
    skill: "listening",
    bank: [alias, noAudio, held, original],
    records: [old],
  });
  assert.equal(result.material?.id, original.id);
  assert.equal(result.material?.version, original.version);
  assert.equal(result.material?.contentHash, original.contentHash);
  assert.equal(result.repeat, true);
});
test("save-time repetition detects original aliases across plans, cloned UI materials and partially seen full papers", () => {
  const original = material("reading", 918),
    alias = {
      ...original,
      id: "changed-reading-id",
      contentHash: hash("changed-reading-id"),
    };
  const old = work(original, "2024-01-01", 1);
  const bank = [original, alias];
  assert.equal(wasListeningReadingAttempted(alias, bank, [old]), true);
  assert.equal(
    wasListeningReadingAttempted(
      { ...alias, questions: [...alias.questions].reverse() },
      bank,
      [old],
    ),
    true,
  );
  const fresh = material("reading", 919);
  assert.equal(
    wasListeningReadingAttempted(fresh, [...bank, fresh], [old]),
    false,
  );
  const section = {
    ...material("listening", 920),
    examId: "known-practice-paper",
  };
  const full = {
    ...material("listening", 921, "full"),
    examId: "known-practice-paper",
  };
  assert.equal(
    wasListeningReadingAttempted(
      full,
      [section, full],
      [work(section, "2024-01-01", 1)],
    ),
    true,
  );
  const deleted = {
    ...old,
    deleted: true,
    seq: old.seq + 1,
    createdAt: old.createdAt + 1,
    revisionId: "00000000-0000-4000-8000-000000000010",
  };
  assert.equal(
    wasListeningReadingAttempted(alias, bank, [old, deleted]),
    false,
  );
});
