import assert from "node:assert/strict";
import test from "node:test";
import {
  availableWritingMaterials,
  defaultWritingMode,
  resolveWritingContext,
} from "./writingTasks";
import type { Revision } from "./protocol";
const plan = {
  id: "plan-a",
  payload: {
    planId: "plan-a",
    startDate: "2026-11-09",
    timeZone: "Asia/Shanghai",
  },
} as unknown as Revision;
test("only the actual inventory day offers the two existing prompts and intact Task1 table", () => {
  const materials = availableWritingMaterials(4);
  assert.deepEqual(
    materials.map((item) => item.id),
    ["writing-sample-01", "writing-task1-sample-01"],
  );
  assert.deepEqual(
    materials.find((item) => item.taskType === "task1")?.taskData?.rows[0],
    ["2005", "50", "40", "10"],
  );
  for (const day of [1, 7, 14, 15, 365])
    assert.deepEqual(availableWritingMaterials(day), []);
});
test("writing block date/day and actual plan budget own the editor context", () => {
  const route = {
    date: "2026-11-12",
    day: 4,
    task: "d4-writing",
    minutes: 999,
  };
  const ctx = resolveWritingContext(plan, [], route);
  assert.equal(ctx.plannedMinutes, 20);
  assert.equal(ctx.defaultMode, "task1");
  assert.equal(ctx.block?.skill, "writing");
  assert.equal(ctx.taskId, "d4-writing");
  assert.throws(
    () => resolveWritingContext(plan, [], { ...route, day: 5 }),
    /不一致/,
  );
  assert.throws(
    () => resolveWritingContext(plan, [], { ...route, task: "d4-reading" }),
    /不是当天的写作/,
  );
  assert.throws(
    () => resolveWritingContext(plan, [], { date: "2026-02-30" }),
    /日期无效/,
  );
});
test("Sunday defaults two essays; ordinary short blocks default Task1 or paragraph", () => {
  const ctx = resolveWritingContext(plan, [], {
    date: "2026-11-15",
    day: 7,
    task: "d7-writing",
  });
  assert.equal(ctx.plannedMinutes, 60);
  assert.equal(ctx.defaultMode, "pair");
  assert.deepEqual([20, 35, 40, 60].map(defaultWritingMode), [
    "task1",
    "paragraph",
    "task2",
    "pair",
  ]);
  assert.equal(
    resolveWritingContext(plan, [], { date: "2026-11-08" }).mode,
    "practice",
  );
});
test("free writing remains available before, during and after the plan with a real current date", () => {
  for (const date of ["2026-11-08", "2026-11-09", "2027-11-10"]) {
    const context = resolveWritingContext(
      plan,
      [],
      { date: "2026-11-12", day: 4, minutes: 999 },
      new Date(`${date}T12:00:00+08:00`).getTime(),
    );
    assert.equal(context.mode, "practice");
    assert.equal(context.date, date);
    assert.equal(context.taskId, `practice-writing-${date}`);
    assert.equal(context.plannedMinutes, 40);
    assert.equal(context.defaultMode, "task2");
    assert.equal(context.block?.skill, "writing");
  }
  assert.equal(
    resolveWritingContext(plan, [], { task: "d4-writing", mode: "practice" })
      .mode,
    "practice",
  );
});
test("reopening a historical writing task keeps its saved budget over recalculated plan and route hints", () => {
  const mission = {
    id: "mission-a",
    kind: "mission",
    planId: plan.id,
    datasetId: null,
    revisionId: "00000000-0000-4000-8000-000000000001",
    baseRevision: null,
    seq: 1,
    createdAt: 1,
    contentHash: "a".repeat(64),
    deleted: false,
    conflict: false,
    payload: {
      planId: plan.id,
      date: "2026-11-12",
      day: 4,
      taskId: "d4-writing",
      skill: "writing",
      status: "partial",
      plannedMinutes: 35,
      actualMinutes: 9,
      timeSource: "timer",
    },
  } as Revision;
  const context = resolveWritingContext(plan, [mission], {
    date: "2026-11-12",
    day: 4,
    task: "d4-writing",
    minutes: 40,
  });
  assert.equal(context.plannedMinutes, 35);
  assert.equal(context.block?.minutes, 35);
  assert.equal(context.defaultMode, "paragraph");
});
