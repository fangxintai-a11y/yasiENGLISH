import test from "node:test";
import assert from "node:assert/strict";
import { buildDayPlan } from "./planEngine";
import { bundledRules } from "./planData";
import { dayDate } from "./calendar";
import { GATE_TARGETS, SECTION_TARGETS, type Revision } from "./protocol";
import { reviewBudget } from "./reviewBudget";
const plan = {
  planId: "p",
  startDate: "2026-11-09",
  timeZone: "Asia/Shanghai",
  studyBudgetMinutes: 120,
  targetBand: GATE_TARGETS.G4.overall,
  sectionTargets: SECTION_TARGETS,
};
test("ordinary skill blocks are not silently turned into correction minutes", () => {
  const day = buildDayPlan(
    bundledRules,
    plan,
    dayDate(plan.startDate, plan.timeZone, 8),
  );
  assert.equal(reviewBudget(day, [], "p").canStart, false);
  assert.equal(reviewBudget(day, [], "p").minutes, 0);
  assert.equal(day.totalMinutes, 120);
});
test("an existing exhausted review block defers correction without changing its planned time", () => {
  const day = buildDayPlan(
    bundledRules,
    plan,
    dayDate(plan.startDate, plan.timeZone, 6),
  );
  const record: Revision = {
    id: "review",
    kind: "mission",
    datasetId: null,
    planId: "p",
    revisionId: crypto.randomUUID(),
    baseRevision: null,
    seq: 1,
    createdAt: 1,
    deleted: false,
    conflict: false,
    contentHash: "a".repeat(64),
    payload: {
      planId: "p",
      date: day.date,
      day: 6,
      taskId: "d6-review",
      plannedMinutes: 30,
      actualMinutes: 30,
      status: "partial",
    },
  };
  assert.deepEqual(
    { ...reviewBudget(day, [record], "p"), block: undefined },
    {
      block: undefined,
      taskId: "d6-review",
      minutes: 30,
      used: 30,
      remaining: 0,
      canStart: false,
    },
  );
  assert.equal(day.totalMinutes, 120);
});
