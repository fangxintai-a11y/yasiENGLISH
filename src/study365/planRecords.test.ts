import assert from "node:assert/strict";
import { test } from "node:test";
import rules from "../../public/curriculum365/v1/plan-rules.json";
import { createPlanPayload, enablePlan, PLAN_RECORD_ID, selectActivePlan } from "./planRecords";
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

test("new plans reject a non-Monday, invalid civil date or timezone before saving", () => {
  for (const fields of [{ startDate: "2026-11-10" }, { startDate: "2026-02-30" }, { timeZone: "Mars/Base" }]) {
    assert.throws(() => createPlanPayload({ ...input, ...fields }), /日期|周一|时区/);
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
