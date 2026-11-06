import assert from "node:assert/strict";
import test from "node:test";
import {
  availableSpeakingMaterials,
  resolveSpeakingContext,
} from "./speakingTasks";
import type { Revision } from "./protocol";
const plan = {
  id: "plan-a",
  payload: {
    planId: "plan-a",
    startDate: "2026-11-09",
    timeZone: "Asia/Shanghai",
  },
} as unknown as Revision;
test("day4 offers existing Part1/2/3 with untouched group timing and 60/120 Part2 contract", () => {
  const samples = availableSpeakingMaterials(4);
  assert.deepEqual(
    samples.map((x) => x.part),
    [1, 2, 3],
  );
  assert.equal(samples[0].suggestedSeconds, 240);
  assert.equal(samples[1].preparationSeconds, 60);
  assert.equal(samples[1].suggestedSeconds, 120);
  for (const day of [1, 7, 14, 15, 365])
    assert.deepEqual(availableSpeakingMaterials(day), []);
});
test("speaking context follows the exact task/date and actual plan budget over URL minutes", () => {
  const route = {
    date: "2026-11-12",
    day: 4,
    task: "d4-speaking",
    minutes: 999,
  };
  const context = resolveSpeakingContext(plan, [], route);
  assert.equal(context.taskId, "d4-speaking");
  assert.equal(context.plannedMinutes, 15);
  assert.equal(context.block?.skill, "speaking");
  assert.throws(
    () => resolveSpeakingContext(plan, [], { ...route, day: 5 }),
    /不一致/,
  );
  assert.throws(
    () => resolveSpeakingContext(plan, [], { ...route, task: "d4-reading" }),
    /不是当天的口语/,
  );
  assert.throws(
    () => resolveSpeakingContext(plan, [], { date: "2026-02-30" }),
    /日期无效/,
  );
  assert.equal(
    resolveSpeakingContext(plan, [], { date: "2026-11-08" }).mode,
    "practice",
  );
});
test("free speaking is always available and uses the real current date without a scheduled block", () => {
  for (const date of ["2026-11-08", "2026-11-09", "2027-11-10"]) {
    const context = resolveSpeakingContext(
      plan,
      [],
      { date: "2026-11-12", day: 4 },
      new Date(`${date}T12:00:00+08:00`).getTime(),
    );
    assert.equal(context.mode, "practice");
    assert.equal(context.date, date);
    assert.equal(context.taskId, `practice-speaking-${date}`);
    assert.equal(context.plannedMinutes, 20);
    assert.equal(context.defaultPart, 1);
    assert.equal(context.block?.skill, "speaking");
  }
});
test("saved mission budget survives historical reopening", () => {
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
      taskId: "d4-speaking",
      skill: "speaking",
      status: "partial",
      plannedMinutes: 25,
      actualMinutes: 4,
      timeSource: "timer",
    },
  } as Revision;
  assert.equal(
    resolveSpeakingContext(plan, [mission], {
      date: "2026-11-12",
      task: "d4-speaking",
      minutes: 15,
    }).plannedMinutes,
    25,
  );
});
