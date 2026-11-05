import assert from "node:assert/strict";
import test from "node:test";
import { ensurePracticePlanToday, type PracticePlanPort, type PracticePlanState } from "./usePracticePlan";
import { PLAN_RECORD_ID, createPlanPayload } from "./planRecords";
import { bundledRules } from "./planData";
import { SECTION_TARGETS, type Revision } from "./protocol";

const now = Date.parse("2026-11-05T12:00:00+08:00");
function record(startDate = "2026-11-05", seq = 1): Revision {
  return { id: PLAN_RECORD_ID, kind: "plan", planId: PLAN_RECORD_ID, datasetId: null, seq, createdAt: seq,
    revisionId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, baseRevision: null,
    payloadVersion: 2, deleted: false, conflict: false, contentHash: "a".repeat(64),
    payload: { ...createPlanPayload({ startDate, timeZone: "Asia/Shanghai", rules: bundledRules }), planId: PLAN_RECORD_ID } };
}
function state(userId: string | null = null, epoch = 1): PracticePlanState { return { ready: true, userId, epoch, records: [] }; }

test("StrictMode and four practice entries share one missing-plan creation", async () => {
  let current = state(), writes = 0, complete!: (value: Revision) => void;
  let received: Parameters<PracticePlanPort["save"]>[0] | undefined;
  const port: PracticePlanPort = { read: () => current, save: (input, expected) => {
    assert.equal(expected, null); received = input; writes++;
    return new Promise(resolve => { complete = value => { current = { ...current, records: [value] }; resolve(value); }; });
  } };
  const pending = Array.from({ length: 4 }, () => ensurePracticePlanToday(null, port, now));
  assert.ok(pending.every(value => value === pending[0]));
  await Promise.resolve(); assert.equal(writes, 1);
  assert.equal(received?.id, PLAN_RECORD_ID); assert.equal(received?.baseRevision, null);
  assert.equal(received?.payload.startDate, "2026-11-05");
  assert.equal(received?.payload.studyBudgetMinutes, 120); assert.equal(received?.payload.targetBand, 8);
  assert.deepEqual(received?.payload.sectionTargets, SECTION_TARGETS);
  const created = record(); complete(created);
  assert.deepEqual(await Promise.all(pending), [created, created, created, created]);
  assert.strictEqual(await ensurePracticePlanToday(null, port, now), created);
  assert.equal(writes, 1);
});

test("existing future, active and expired plans are returned without changing history", async () => {
  for (const startDate of ["2026-11-09", "2026-11-05", "2020-01-01"]) {
    const existing = record(startDate), before = JSON.stringify(existing);
    let writes = 0;
    const port: PracticePlanPort = { read: () => ({ ...state("learner"), records: [existing] }), save: async () => { writes++; throw new Error("must not write"); } };
    assert.strictEqual(await ensurePracticePlanToday("learner", port, now), existing);
    assert.equal(writes, 0); assert.equal(JSON.stringify(existing), before);
  }
});

test("an account switch before the queued creation never saves the old request into the new scope", async () => {
  let current = state("a"), writes = 0;
  const port: PracticePlanPort = { read: () => current, save: async (_input, expected) => {
    assert.equal(expected, current.userId); writes++; const created = record(); current = { ...current, records: [created] }; return created;
  } };
  const old = ensurePracticePlanToday("a", port, now);
  current = state("b", 2);
  const next = ensurePracticePlanToday("b", port, now);
  await assert.rejects(() => old, /账号已经切换/);
  assert.equal((await next).id, PLAN_RECORD_ID); assert.equal(writes, 1);
});

test("guest and a new login epoch do not reuse an abandoned account task", async () => {
  let current = state(), writes = 0;
  const port: PracticePlanPort = { read: () => current, save: async (_input, expected) => {
    assert.equal(expected, current.userId); writes++; const created = record(); current = { ...current, records: [created] }; return created;
  } };
  const guest = ensurePracticePlanToday(null, port, now);
  current = state("a", 2);
  const firstLogin = ensurePracticePlanToday("a", port, now);
  current = state("a", 4);
  const returnedLogin = ensurePracticePlanToday("a", port, now);
  assert.notStrictEqual(firstLogin, returnedLogin);
  await assert.rejects(() => guest, /账号已经切换/);
  await assert.rejects(() => firstLogin, /账号已经切换/);
  await returnedLogin; assert.equal(writes, 1);
});

test("a failed save clears the flight and permits a later explicit reopening", async () => {
  let current = state(), writes = 0;
  const port: PracticePlanPort = { read: () => current, save: async () => {
    if (++writes === 1) throw new Error("storage full");
    const created = record(); current = { ...current, records: [created] }; return created;
  } };
  await assert.rejects(() => ensurePracticePlanToday(null, port, now), /storage full/);
  assert.equal((await ensurePracticePlanToday(null, port, now)).id, PLAN_RECORD_ID);
  assert.equal(writes, 2);
});

test("unready and mismatched scopes never create a plan", async () => {
  let current = { ...state(), ready: false }, writes = 0;
  const port: PracticePlanPort = { read: () => current, save: async () => { writes++; return record(); } };
  await assert.rejects(() => ensurePracticePlanToday(null, port, now), /账号已经切换/);
  current = { ...state("b"), ready: true };
  await assert.rejects(() => ensurePracticePlanToday("a", port, now), /账号已经切换/);
  assert.equal(writes, 0);
});
