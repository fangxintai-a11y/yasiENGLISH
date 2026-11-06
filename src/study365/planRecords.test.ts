import assert from "node:assert/strict";
import { test } from "node:test";
import rules from "../../public/curriculum365/v1/plan-rules.json";
import { createPlanPayload, enablePlan, PLAN_RECORD_ID, selectActivePlan, startPlanToday } from "./planRecords";
import { SECTION_TARGETS, validatePayload, type LearningPayload, type Revision } from "./protocol";

function plan(id: string, fields: LearningPayload = {}, createdAt = 1): Revision {
  return { id, kind: "plan", datasetId: null, planId: id, revisionId: `00000000-0000-4000-8000-${String(createdAt).padStart(12, "0")}`,
    baseRevision: null, seq: createdAt, payload: { planId: id, enabled: true, ...fields }, contentHash: "a".repeat(64), createdAt, conflict: false, deleted: false, payloadVersion: 2 };
}
const input = { startDate: "2026-11-09", timeZone: "Asia/Shanghai", rules };

test("new plan uses the rules version and protocol targets with no dataset binding", () => {
  const payload = createPlanPayload(input);
  validatePayload("plan", { ...payload, planId: PLAN_RECORD_ID });
  assert.equal(payload.startDate, input.startDate);
  assert.equal(payload.timeZone, input.timeZone);
  assert.equal(payload.curriculumVersion, rules.version);
  assert.equal(payload.studyBudgetMinutes, rules.goal.dailyMinutes);
  assert.equal(payload.targetBand, 8);
  assert.deepEqual(payload.sectionTargets, SECTION_TARGETS);
  assert.equal(payload.enabled, true);
  assert.equal(payload.datasetId, null);
});

test("new plans can begin on any weekday but reject invalid civil dates or timezones before saving", () => {
  assert.equal(createPlanPayload({ ...input, startDate: "2026-11-05" }).startDate, "2026-11-05");
  for (const fields of [{ startDate: "2026-02-30" }, { timeZone: "Mars/Base" }]) {
    assert.throws(() => createPlanPayload({ ...input, ...fields }), /日期|时区/);
  }
});

test("active selection is deterministic and excludes deleted, conflicted, disabled and non-plan records", () => {
  const older = plan("old", {}, 1), active = plan("active", {}, 2);
  const records = [older, active, { ...plan("deleted", {}, 9), deleted: true }, { ...plan("conflict", {}, 8), conflict: true },
    plan("disabled", { enabled: false }, 7), { ...plan("not-plan", {}, 6), kind: "mission" as const }];
  assert.equal(selectActivePlan(records)?.id, "active");
  assert.equal(selectActivePlan([...records].reverse())?.id, "active");
  assert.equal(selectActivePlan([]), null);
  assert.equal(records.length, 6, "selection must not mutate source records");
});

test("a disabled or deleted current revision never resurrects an old enabled plan", () => {
  const old = plan("same");
  for (const latest of [plan("same", { enabled: false }, 2), { ...plan("same", {}, 2), deleted: true }]) {
    assert.equal(selectActivePlan([old, latest]), null);
  }
});

test("enabling reuses any existing active plan without rewriting its historical payload", async () => {
  const old = plan("legacy", { startDate: "2026-11-03", title: "旧计划" });
  let writes = 0;
  const result = await enablePlan(input, { records: () => [old], save: async () => { writes++; throw new Error("must not write"); } });
  assert.equal(result, old);
  assert.equal(writes, 0);
  assert.equal(old.payload.startDate, "2026-11-03");
});

test("one account-scoped stable plan ID is used for the first save", async () => {
  const writes: { id: string; kind: "plan"; payload: LearningPayload }[] = [];
  const result = await enablePlan(input, { records: () => [], save: async (request) => {
    writes.push(request); return plan(request.id, request.payload);
  } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, PLAN_RECORD_ID);
  assert.equal(result.id, PLAN_RECORD_ID);
});

const today = Date.parse("2026-11-05T12:00:00+08:00");
test("starting an untouched future plan today writes one revision on the same identity", async () => {
  const old = plan("future", { ...createPlanPayload(input), title: "我的训练", syllabusUnit: 1 });
  const before = JSON.stringify(old), records = [old];
  const writes: { id: string; kind: "plan"; payload: LearningPayload; baseRevision?: string | null }[] = [];
  const port = { records: () => records, save: async (request: typeof writes[number]) => {
    writes.push(request); const saved = plan(request.id, request.payload, 2); records.push(saved); return saved;
  } };
  const saved = await startPlanToday(port, today);
  assert.equal(saved.id, old.id); assert.equal(saved.payload.startDate, "2026-11-05");
  assert.equal(saved.payload.curriculumVersion, rules.version);
  assert.equal(saved.payload.title, "我的训练"); assert.equal(saved.payload.studyBudgetMinutes, 120);
  assert.deepEqual(saved.payload.sectionTargets, SECTION_TARGETS); assert.equal(saved.payload.syllabusUnit, 1);
  assert.equal(writes[0].baseRevision, old.revisionId); assert.equal(JSON.stringify(old), before);
  assert.equal(records.length, 2, "the original revision stays in history");
  assert.equal(await startPlanToday(port, today), saved); assert.equal(writes.length, 1);
});
test("today is computed in the plan timezone, independently of the host day", async () => {
  for (const [timeZone, expected] of [["Asia/Shanghai", "2026-11-06"], ["America/New_York", "2026-11-05"]]) {
    const old = plan("future", createPlanPayload({ ...input, timeZone }));
    let written: LearningPayload | undefined;
    await startPlanToday({ records: () => [old], save: async request => { written = request.payload; return plan(old.id, request.payload, 2); } }, Date.parse("2026-11-05T17:00:00Z"));
    assert.equal(written?.startDate, expected);
  }
});
test("existing learning work prevents moving the calendar and leaves every record unchanged", async () => {
  const future = plan("future", createPlanPayload(input));
  for (const kind of ["attempt", "essay", "speaking", "assessment", "correction", "mission"] as const) {
    const work: Revision = { ...future, id: `work-${kind}`, kind, planId: future.id, payload: { planId: future.id, status: "in_progress", actualMinutes: 0 } };
    const records = [future, work], before = JSON.stringify(records);
    let writes = 0;
    await assert.rejects(() => startPlanToday({ records: () => records, save: async () => { writes++; throw new Error("unexpected write"); } }, today), /已有学习记录/);
    assert.equal(writes, 0); assert.equal(JSON.stringify(records), before);
  }
});
test("another plan, tombstones and untouched mission placeholders do not block an unstarted plan", async () => {
  const future = plan("future", createPlanPayload(input));
  const work: Revision = { ...future, id: "work", kind: "attempt", payload: { planId: future.id } };
  const deleted = { ...work, seq: 2, createdAt: 2, deleted: true };
  const placeholder: Revision = { ...work, id: "placeholder", kind: "mission", payload: { planId: future.id, status: "not_started", actualMinutes: 0 } };
  let writes = 0;
  await startPlanToday({ records: () => [future, work, deleted, placeholder, { ...work, id: "other-work", planId: "other" }], save: async request => { writes++; return plan(request.id, request.payload, 3); } }, today);
  assert.equal(writes, 1);
});
test("already begun, changed or missing plans never write a new start revision", async () => {
  const future = plan("future", createPlanPayload(input));
  let writes = 0;
  const save = async () => { writes++; throw new Error("unexpected write"); };
  await assert.rejects(() => startPlanToday({ records: () => [], save }, today), /先开启/);
  await assert.rejects(() => startPlanToday({ records: () => [{ ...future, payload: { ...future.payload, startDate: "2026-11-04" } }], save }, today), /已经开始/);
  let reads = 0;
  await assert.rejects(() => startPlanToday({ records: () => ++reads === 1 ? [future] : [{ ...future, revisionId: "00000000-0000-4000-8000-000000000009" }], save }, today), /已经变化/);
  assert.equal(writes, 0);
});
test("work arriving during the final plan check also prevents moving the start date", async () => {
  const future = plan("future", createPlanPayload(input));
  const work: Revision = { ...future, id: "new-work", kind: "essay", planId: future.id, payload: { planId: future.id, text: "A newly saved draft." } };
  let reads = 0, writes = 0;
  await assert.rejects(() => startPlanToday({
    records: () => ++reads === 1 ? [future] : [future, work],
    save: async () => { writes++; throw new Error("unexpected write"); },
  }, today), /已有学习记录/);
  assert.equal(writes, 0);
});
test("explicit date-stamped independent four-skill work stays intact when a future course starts today", async () => {
  const future = plan("future", createPlanPayload(input));
  const works = ([['attempt', 'listening'], ['attempt', 'reading'], ['essay', 'writing'], ['speaking', 'speaking']] as const).map(([kind, skill], index) => ({
    ...future, id: `independent-${skill}`, kind, seq: index + 2, createdAt: index + 2,
    payload: { planId: future.id, date: "2026-11-05", taskId: `practice-${skill}-2026-11-05`, skill },
  }));
  const records = [future, ...works], before = JSON.stringify(records);
  let writes = 0;
  const saved = await startPlanToday({ records: () => records, save: async request => {
    writes++; return plan(request.id, request.payload, 7);
  } }, today);
  assert.equal(writes, 1); assert.equal(saved.payload.startDate, "2026-11-05");
  assert.equal(JSON.stringify(records), before, "independent answers, dates and source hashes are never migrated");
});
test("unknown, mismatched, course-bound and assessment practice labels still block rescheduling", async () => {
  const future = plan("future", createPlanPayload(input));
  const candidate: Revision = { ...future, id: "practice", kind: "attempt", payload: {
    planId: future.id, date: "2026-11-05", taskId: "practice-listening-2026-11-05", skill: "listening",
  } };
  const variants: Revision[] = [
    { ...candidate, payload: { ...candidate.payload, day: 1 } },
    { ...candidate, payload: { ...candidate.payload, taskId: "practice-listening-2026-11-04" } },
    { ...candidate, payload: { ...candidate.payload, skill: "reading" } },
    { ...candidate, payload: { ...candidate.payload, date: "2026-02-30", taskId: "practice-listening-2026-02-30" } },
    { ...candidate, payload: { ...candidate.payload, correctionId: "correction-1" } },
    { ...candidate, payload: { ...candidate.payload, retestOf: candidate.revisionId } },
    { ...candidate, kind: "assessment" }, { ...candidate, kind: "feedback" },
  ];
  for (const work of variants) {
    let writes = 0;
    await assert.rejects(() => startPlanToday({ records: () => [future, work], save: async () => {
      writes++; throw new Error("unexpected write");
    } }, today), /已有学习记录/);
    assert.equal(writes, 0);
  }
});
