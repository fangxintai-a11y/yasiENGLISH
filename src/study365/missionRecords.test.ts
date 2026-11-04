import assert from "node:assert/strict";
import test from "node:test";
import { dayCompletion, editableDates, missionRecordId, missionStreak, missionTaskId, saveMission, selectMission, totalActualMinutes } from "./missionRecords";
import { bundledRules } from "./planData";
import { buildDayPlan } from "./planEngine";
import { validatePayload, type LearningPayload, type Revision } from "./protocol";

const planId = "test-plan", date = "2026-11-12";
const dayPlan = buildDayPlan(bundledRules, { planId, startDate: "2026-11-09", timeZone: "Asia/Shanghai" }, date);
let serial = 0;
function mission(taskId: string, fields: LearningPayload = {}, at = ++serial): Revision {
  return { id: taskId, kind: "mission", planId, datasetId: null, revisionId: `00000000-0000-4000-8000-${String(at).padStart(12, "0")}`,
    baseRevision: null, seq: at, createdAt: at, contentHash: "a".repeat(64), deleted: false, conflict: false,
    payload: { planId, taskId, day: 4, date, skill: "listening", status: "completed", plannedMinutes: 30, actualMinutes: 20, timeSource: "manual", ...fields } };
}

test("same block operations produce revisions on one stable record, keeping historical planned minutes", async () => {
  const records: Revision[] = [], writes: Revision[] = [];
  const port = { records: () => records, save: async (input: { id: string; kind: "mission"; payload: LearningPayload }) => {
    const old = records.find(record => record.id === input.id);
    const record = { ...mission(input.id, input.payload), baseRevision: old?.revisionId ?? null };
    records.splice(0, records.length, record); writes.push(record); return record;
  } };
  const block = dayPlan.blocks[0];
  for (const [status, actualMinutes] of [["in_progress", undefined], ["completed", 14], ["partial", 10], ["skipped", 10]] as const)
    await saveMission({ planId, day: 4, date, block: { ...block, minutes: writes.length ? block.minutes + 5 : block.minutes }, status, actualMinutes, timeSource: "manual" }, port);
  assert.equal(new Set(writes.map(record => record.id)).size, 1);
  assert.equal(new Set(writes.map(record => record.revisionId)).size, 4);
  assert.ok(writes.every(record => record.payload.plannedMinutes === block.minutes));
  assert.equal(writes[0].payload.actualMinutes, 0, "starting must not manufacture actual minutes from the budget");
  assert.equal(writes[1].payload.actualMinutes, 14);
  assert.equal(writes[3].baseRevision, writes[2].revisionId);
  assert.equal(writes[3].payload.taskId, missionTaskId(4, block.id));
  for (const record of writes) validatePayload("mission", record.payload);
});

test("legacy matching mission IDs are reused, and omitted actual minutes keep the saved value", async () => {
  const block = dayPlan.blocks[1], old = mission(missionTaskId(4, block.id), { actualMinutes: 17, plannedMinutes: 22 });
  const saved = await saveMission({ planId, day: 4, date, block, status: "completed", timeSource: "manual" }, {
    records: () => [old], save: async request => ({ ...old, ...request }),
  });
  assert.equal(saved.id, old.id); assert.equal(saved.payload.actualMinutes, 17); assert.equal(saved.payload.plannedMinutes, 22);
});

test("stable task and mission IDs isolate plans and days even at maximum plan ID length", async () => {
  assert.equal(missionTaskId(12, "timed-section"), "d12-timed-section");
  const id = await missionRecordId("a".repeat(160), 12, "listening");
  assert.ok(id.length <= 160); assert.match(id, /^[A-Za-z0-9_.:-]+$/);
  assert.equal(id, await missionRecordId("a".repeat(160), 12, "listening"));
  assert.notEqual(id, await missionRecordId("b".repeat(160), 12, "listening"));
  assert.notEqual(id, await missionRecordId("a".repeat(160), 13, "listening"));
});

test("completion counts only completed saved budgets; partial, minimum and actual time stay distinct", () => {
  const records = [mission("a", { plannedMinutes: 60, actualMinutes: 45 }), mission("b", { status: "partial", plannedMinutes: 30, actualMinutes: 10 }),
    mission("c", { status: "skipped", plannedMinutes: 15, actualMinutes: 0 }), mission("d", { status: "minimum", plannedMinutes: 15, actualMinutes: 4 })];
  assert.deepEqual(dayCompletion(records, planId, date), { completedMinutes: 60, actualMinutes: 59, totalMinutes: bundledRules.goal.dailyMinutes, ratio: .5, status: "partial" });
  assert.equal(totalActualMinutes(records, planId), 59);
  assert.equal(dayCompletion([], planId, date).status, "not_started");
  assert.equal(dayCompletion([mission("all", { plannedMinutes: 120, actualMinutes: 0 })], planId, date).status, "completed");
});

test("summary selects current task heads and ignores another plan, deleted and conflict records", () => {
  const old = mission("a", { plannedMinutes: 120 }, 1), current = { ...mission("a", { status: "partial", actualMinutes: 7 }, 2), id: old.id };
  const records = [old, current, { ...mission("b", {}, 3), planId: "other" }, { ...mission("c", {}, 4), deleted: true }, { ...mission("d", {}, 5), conflict: true }];
  assert.equal(selectMission(records, planId, date, "a")?.revisionId, current.revisionId);
  assert.equal(dayCompletion(records, planId, date).completedMinutes, 0);
  assert.equal(totalActualMinutes(records, planId), 7);
  assert.equal(dayCompletion([old, { ...current, deleted: true }], planId, date).actualMinutes, 0, "deleted head cannot resurrect history");
});

test("streak uses the separate 80 percent threshold and stops at missing or partial dates", () => {
  const records = [mission("d1", { date: "2026-11-10", plannedMinutes: 100 }), mission("d2", { date: "2026-11-11", plannedMinutes: 100 }),
    mission("d3", { date, plannedMinutes: 95 }), mission("d0", { date: "2026-11-09", status: "partial", plannedMinutes: 120 })];
  assert.equal(missionStreak(records, planId, date), 2);
  assert.equal(missionStreak([...records, mission("extra", { plannedMinutes: 5 })], planId, date), 3);
  assert.equal(dayCompletion(records, planId, "2026-11-11").status, "partial", "80 percent does not relabel an incomplete day as completed");
});

test("backfill choices contain today and at most the previous seven dates, never before plan start", () => {
  assert.deepEqual(editableDates("2026-11-12", "2026-11-09"), ["2026-11-12", "2026-11-11", "2026-11-10", "2026-11-09"]);
  const dates = editableDates("2026-11-20", "2026-11-09");
  assert.equal(dates.length, 8); assert.equal(dates.at(-1), "2026-11-13");
});

test("invalid actual time fails before writing and no attempt or score is rewritten", async () => {
  let writes = 0;
  for (const actualMinutes of [-1, Infinity, 1441]) await assert.rejects(() => saveMission({ planId, day: 4, date, block: dayPlan.blocks[0], status: "completed", actualMinutes, timeSource: "manual" }, {
    records: () => [], save: async () => { writes++; throw new Error("unexpected"); },
  }), /分钟/);
  assert.equal(writes, 0);
});

test("review and human handoff missions omit an unassigned skill rather than writing null", async () => {
  for (const id of ["review", "human-calibration-handoff"]) {
    const saved = await saveMission({ planId, day: 4, date, block: { id, title: "复盘", skill: null, minutes: 15, guide: "登记实际用时" }, status: "completed", timeSource: "manual" }, {
      records: () => [], save: async input => ({ ...mission(input.id), id: input.id, payload: input.payload }),
    });
    assert.equal(Object.hasOwn(saved.payload, "skill"), false);
    validatePayload("mission", saved.payload);
  }
});
