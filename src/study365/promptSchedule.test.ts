import assert from "node:assert/strict";
import test from "node:test";
import {
  selectScheduledWritingPrompts,
  selectScheduledSpeakingPrompts,
  selectWritingPrompt,
  selectSpeakingPrompt,
  createPromptSelectionContext,
  selectIndependentPracticePrompt,
  promptKey,
  writingPromptReferences,
  type PromptScheduleInput,
} from "./promptWorkSelection";
import { newWritingDraft } from "./writingModel";
import type { LocalPrompt } from "./promptBankSchema";
import type { Revision } from "./protocol";

const writing = (
  id: string,
  patch: Record<string, unknown> = {},
): LocalPrompt =>
  ({
    id,
    version: "v1",
    contentHash: "a".repeat(64),
    skill: "writing",
    taskType: "task2",
    questionType: "opinion",
    prompt: `Should the self-authored fictional town ${id} open a public garden?`,
    sourceRef: `synthetic:${id}`,
    materialSource: "unofficial",
    rights: "Self-authored test fixture",
    ...patch,
  }) as LocalPrompt;
const speaking = (
  id: string,
  part: 1 | 2 | 3,
  patch: Record<string, unknown> = {},
): LocalPrompt =>
  ({
    id,
    version: "v1",
    contentHash: "b".repeat(64),
    skill: "speaking",
    part,
    prompt: `Describe the fictional place ${id}.`,
    sourceRef: `synthetic:${id}`,
    materialSource: "unofficial",
    rights: "Self-authored test fixture",
    ...patch,
  }) as LocalPrompt;
const chart = (id: string, patch: Record<string, unknown> = {}) =>
  writing(id, {
    taskType: "task1",
    questionType: "table",
    stimulusHash: "c".repeat(64),
    stimulusText: "Self-authored real table: A=10, B=20.",
    ...patch,
  });
const input = (
  prompts: LocalPrompt[],
  patch: Partial<PromptScheduleInput> = {},
): PromptScheduleInput => ({
  prompts,
  records: [],
  planId: "p",
  date: "2026-11-05",
  taskId: "d1-writing",
  day: 1,
  plannedMinutes: 40,
  ...patch,
});
let serial = 0;
const work = (
  prompt: LocalPrompt,
  patch: Record<string, unknown> = {},
): Revision => {
  const seq = ++serial;
  return {
    id: `work-${seq}`,
    kind: prompt.skill === "writing" ? "essay" : "speaking",
    planId: "p",
    datasetId: null,
    revisionId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    baseRevision: null,
    seq,
    createdAt: seq,
    deleted: false,
    conflict: false,
    contentHash: "d".repeat(64),
    payload: {
      planId: "p",
      date: "2026-11-04",
      taskId: "earlier-task",
      contentId: prompt.id,
      contentVersion: prompt.version,
      prompt: prompt.prompt,
      ...(prompt.skill === "writing"
        ? { taskType: prompt.taskType }
        : { part: prompt.part }),
      ...patch,
    },
  };
};
test("automatic writing scope follows the actual lesson budget and is independent of import order", () => {
  const prompts = [writing("z"), chart("b"), writing("a"), chart("a")];
  assert.deepEqual(
    selectScheduledWritingPrompts(input(prompts, { plannedMinutes: 0 })),
    [],
  );
  assert.deepEqual(
    selectScheduledWritingPrompts(input(prompts, { day: 0 })),
    [],
  );
  assert.deepEqual(
    selectScheduledWritingPrompts(input(prompts, { day: 366 })),
    [],
  );
  for (const [minutes, types] of [
    [20, ["task1"]],
    [35, ["task2"]],
    [40, ["task2"]],
    [60, ["task1", "task2"]],
  ] as const) {
    const result = selectScheduledWritingPrompts(
      input(prompts, { plannedMinutes: minutes }),
    );
    assert.deepEqual(
      result.map((value) => value.taskType),
      types,
    );
    assert.ok(result.every((value) => value.status === "assigned"));
    assert.deepEqual(
      result.map((value) => promptKey(value.prompt!)),
      selectScheduledWritingPrompts(
        input([...prompts].reverse(), { plannedMinutes: minutes }),
      ).map((value) => promptKey(value.prompt!)),
    );
  }
});
test("writing families rotate with plan day without relabelling unknown source types", () => {
  const prompts = [
    writing("opinion"),
    writing("discussion", { questionType: "discussion" }),
  ];
  assert.notEqual(
    selectWritingPrompt(input(prompts), "task2").prompt?.id,
    selectWritingPrompt(input(prompts, { day: 2 }), "task2").prompt?.id,
  );
});
test("practice excludes holdout aliases, unready charts and already answered originals", () => {
  const held = writing("reserved", { pool: "holdout" }),
    alias = {
      ...held,
      id: "alias",
      pool: "practice",
      prompt: held.prompt.toUpperCase(),
    } as LocalPrompt;
  const done = writing("done"),
    renamed = { ...done, id: "renamed" },
    fresh = writing("fresh");
  const selected = selectWritingPrompt(
    input(
      [held, alias, done, renamed, fresh, writing("unready", { ready: false })],
      { records: [work(done)] },
    ),
    "task2",
  );
  assert.equal(selected.prompt?.id, fresh.id);
  assert.equal(
    selectWritingPrompt(
      input([
        chart("no-data", { stimulusHash: undefined, stimulusText: undefined }),
      ]),
      "task1",
    ).status,
    "missing",
  );
});
test("same sitting resumes its exact source and a missing old version never silently receives a new question", () => {
  const old = writing("old"),
    newer = { ...old, version: "v2", prompt: "A changed original." },
    fresh = writing("fresh");
  const saved = work(old, { date: "2026-11-05", taskId: "d1-writing" });
  assert.equal(
    selectWritingPrompt(input([fresh, old], { records: [saved] }), "task2")
      .prompt,
    old,
  );
  const missing = selectWritingPrompt(
    input([fresh, newer], { records: [saved] }),
    "task2",
  );
  assert.equal(missing.status, "missing");
  assert.equal(missing.prompt, null);
  assert.match(missing.notice, /原版材料/);
  assert.equal(
    selectWritingPrompt(
      input([fresh, old], { records: [saved], continueCurrent: false }),
      "task2",
    ).prompt,
    fresh,
  );
});
test("local drafts lock the same source and reserve other days without becoming fabricated score records", () => {
  const first = writing("first"),
    second = writing("second");
  const draft = newWritingDraft({
    planId: "p",
    date: "2026-11-05",
    taskId: "d1-writing",
    taskType: "task2",
    prompt: second.prompt,
    contentId: second.id,
    contentVersion: second.version,
  });
  const localWorks = writingPromptReferences([draft]);
  assert.equal(
    selectWritingPrompt(input([first, second], { localWorks }), "task2").prompt,
    second,
  );
  assert.equal(
    selectWritingPrompt(
      input([first, second], {
        localWorks,
        date: "2026-11-06",
        day: 2,
        taskId: "d2-writing",
      }),
      "task2",
    ).prompt,
    first,
  );
  assert.equal(writingPromptReferences([{ ...draft, prompt: "" }]).length, 0);
});
test("future reservations exclude normalized aliases and react to changed reservation arrays", () => {
  const first = writing("a"),
    alias = { ...first, id: "alias", prompt: first.prompt.toUpperCase() },
    second = writing("z");
  const reservedPrompts: LocalPrompt[] = [];
  const context = input([first, alias, second], { reservedPrompts });
  assert.equal(selectWritingPrompt(context, "task2").prompt, first);
  reservedPrompts.push(first);
  assert.equal(selectWritingPrompt(context, "task2").prompt, second);
  assert.equal(
    selectWritingPrompt(input([first, alias], { reservedPrompts }), "task2")
      .status,
    "missing",
  );
});
test("an explicit projection context preserves selectors and incrementally reserves originals", () => {
  const first = writing("a"),
    alias = { ...first, id: "alias", prompt: first.prompt.toUpperCase() },
    second = writing("b"),
    third = writing("c"),
    held = writing("holdout", { pool: "holdout" });
  const context = input([third, held, alias, second, first], {
    records: [work(third)],
  });
  const prepared = createPromptSelectionContext(context);
  assert.equal(
    selectWritingPrompt({ ...context, prepared }, "task2").prompt,
    selectWritingPrompt(context, "task2").prompt,
  );
  prepared.reserve(first);
  assert.equal(
    selectWritingPrompt({ ...context, prepared }, "task2").prompt,
    second,
  );
  assert.equal(
    selectWritingPrompt({ ...context, prepared, pool: "holdout" }, "task2")
      .prompt,
    held,
  );
  prepared.reserve(second);
  assert.equal(
    selectWritingPrompt({ ...context, prepared }, "task2").status,
    "missing",
  );
  assert.equal(context.records.length, 1);
});
test("independent practice chooses unseen originals then clearly marked prior work, never holdouts", () => {
  const prior = writing("a"),
    fresh = writing("z"),
    holdout = writing("holdout", { pool: "holdout" });
  const target = { skill: "writing" as const, taskType: "task2" as const };
  const context = input([prior, fresh, holdout], {
    day: 0,
    records: [work(prior)],
  });
  const first = selectIndependentPracticePrompt(context, target);
  assert.equal(first.prompt, fresh);
  assert.equal(first.repeat, false);
  const repeated = selectIndependentPracticePrompt(
    { ...context, records: [work(prior), work(fresh)] },
    target,
  );
  assert.equal(repeated.prompt, prior);
  assert.equal(repeated.repeat, true);
  assert.match(repeated.notice, /复习/);
  const missing = selectIndependentPracticePrompt(
    input([holdout], { day: 366 }),
    target,
  );
  assert.equal(missing.prompt, null);
  assert.equal(missing.repeat, false);
  const otherPlan = input([prior], {
    planId: "another-plan",
    records: [work(prior)],
  });
  assert.equal(selectIndependentPracticePrompt(otherPlan, target).repeat, true);
  assert.equal(selectWritingPrompt(otherPlan, "task2").prompt, prior);
});
test("independent assessment only receives real holdout originals, never practice substitutes", () => {
  const practice = writing("practice"),
    held = writing("holdout", { pool: "holdout" });
  assert.equal(
    selectWritingPrompt(input([practice, held], { pool: "holdout" }), "task2")
      .prompt,
    held,
  );
  assert.equal(
    selectWritingPrompt(input([practice], { pool: "holdout" }), "task2").status,
    "missing",
  );
  assert.equal(
    selectWritingPrompt(
      input([practice], {
        pool: "holdout",
        records: [work(practice, { date: "2026-11-05", taskId: "d1-writing" })],
      }),
      "task2",
    ).status,
    "missing",
  );
});
test("speaking lessons automatically arrange all three Parts with independent missing slots", () => {
  const prompts = [speaking("p3", 3), speaking("p1", 1), speaking("p2", 2)];
  const assigned = selectScheduledSpeakingPrompts(
    input(prompts, { taskId: "d1-speaking", plannedMinutes: 20 }),
  );
  assert.deepEqual(
    assigned.map((value) => [value.part, value.prompt?.id]),
    [
      [1, "p1"],
      [2, "p2"],
      [3, "p3"],
    ],
  );
  assert.equal(
    selectSpeakingPrompt(
      input(prompts.filter((prompt) => prompt.id !== "p2")),
      2,
    ).status,
    "missing",
  );
});
test("new revisions and tombstones do not resurrect obsolete prompt choices", () => {
  const first = writing("a"),
    second = writing("b"),
    old = work(first, { date: "2026-11-05", taskId: "d1-writing" });
  const deleted = {
    ...old,
    deleted: true,
    createdAt: old.createdAt + 1,
    seq: old.seq + 1,
  };
  assert.equal(
    selectWritingPrompt(
      input([first, second], { records: [old, deleted] }),
      "task2",
    ).prompt,
    first,
  );
  const replacement = {
    ...old,
    createdAt: old.createdAt + 1,
    seq: old.seq + 1,
    payload: {
      ...old.payload,
      contentId: second.id,
      contentVersion: second.version,
      prompt: second.prompt,
    },
  };
  assert.equal(
    selectWritingPrompt(
      input([first, second], { records: [replacement, old] }),
      "task2",
    ).prompt,
    second,
  );
});
test("normalization reuse cannot stale an edited original or change Task1 chart identity", () => {
  const held = writing("held", { pool: "holdout" }),
    candidate = writing("candidate");
  const context = input([held, candidate]);
  assert.equal(selectWritingPrompt(context, "task2").prompt, candidate);
  candidate.prompt = held.prompt.toUpperCase();
  assert.equal(selectWritingPrompt(context, "task2").status, "missing");
  const one = chart("one"),
    two = chart("two", { prompt: one.prompt, stimulusHash: "e".repeat(64) });
  assert.equal(
    selectWritingPrompt(input([one, two], { records: [work(one)] }), "task1")
      .prompt,
    two,
  );
  if (one.skill === "writing" && two.skill === "writing")
    two.stimulusHash = one.stimulusHash;
  assert.equal(
    selectWritingPrompt(input([one, two], { records: [work(one)] }), "task1")
      .status,
    "missing",
  );
});
