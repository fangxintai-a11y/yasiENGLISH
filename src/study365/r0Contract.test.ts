import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hashPayload, isIdentifier, isRevisionId, LEARNING_KINDS, validatePayload, type WriteRequest } from "./protocol";

interface FixtureRecord {
  recordId: string;
  request: WriteRequest;
  expectedContentHash: string;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/r0-records.json", import.meta.url), "utf8")) as {
  fixtureVersion: number;
  purpose: string;
  records: FixtureRecord[];
};
const record = (kind: WriteRequest["kind"]): FixtureRecord => {
  const value = fixture.records.find((item) => item.request.kind === kind);
  assert.ok(value, `missing ${kind} fixture`);
  return value;
};

test("R0 shared wire examples cover all seven P1 record kinds without importing user progress", () => {
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.purpose, "synthetic-wire-examples-not-user-learning-records");
  assert.deepEqual(fixture.records.map((item) => item.request.kind).sort(), [...LEARNING_KINDS].sort());
  assert.equal(new Set(fixture.records.map((item) => item.recordId)).size, fixture.records.length);
  assert.equal(new Set(fixture.records.map((item) => item.request.revisionId)).size, fixture.records.length);
  assert.equal(new Set(fixture.records.map((item) => item.request.mutationId)).size, fixture.records.length);
});

for (const item of fixture.records) {
  test(`R0 ${item.request.kind} wire sample passes P1 and matches its shared UTF-8 hash`, async () => {
    assert.ok(isIdentifier(item.recordId));
    assert.equal(item.request.schemaVersion, 1);
    assert.ok(isRevisionId(item.request.revisionId));
    assert.ok(isRevisionId(item.request.mutationId));
    assert.equal(item.request.baseRevision, null);
    assert.equal(item.request.payload.datasetId, "word-atlas-open");
    assert.equal(item.request.payload.planId, record("plan").recordId);
    assert.doesNotThrow(() => validatePayload(item.request.kind, item.request.payload));
    assert.equal(await hashPayload(item.request.kind, item.request.payload), item.expectedContentHash);
  });
}

test("R0 plan fixes the Band 8 project goal while its synthetic task remains independent", () => {
  const plan = record("plan");
  assert.equal(plan.recordId, plan.request.payload.planId);
  assert.equal(plan.request.payload.targetBand, 8);
  assert.equal(plan.request.payload.sectionMinimum, 6.5);
  assert.equal(plan.request.payload.studyBudgetMinutes, 120);
  assert.equal(plan.request.payload.enabled, false);
  assert.equal(record("mission").request.payload.status, "in_progress");
});

test("R0 feedback binds the original essay revision and cannot silently move to a changed draft", async () => {
  const essay = record("essay");
  const feedback = record("feedback");
  assert.equal(feedback.request.payload.workId, essay.recordId);
  assert.equal(feedback.request.payload.workRevisionId, essay.request.revisionId);
  assert.equal(feedback.request.payload.inputHash, essay.expectedContentHash);
  const changed = { ...essay.request.payload, text: `${essay.request.payload.text}\nA revised sentence.` };
  assert.notEqual(await hashPayload("essay", changed), feedback.request.payload.inputHash);
});

test("R0 short reading raw marks and text-only self-checks do not invent IELTS section bands", () => {
  const assessment = record("assessment").request.payload;
  assert.equal(assessment.kind, "foundation-reading-raw");
  assert.equal(assessment.score, 3);
  assert.equal(assessment.total, 3);
  assert.deepEqual(assessment.bands, { listening: null, reading: null, writing: null, speaking: null });
  assert.deepEqual(record("feedback").request.payload.bands, { taskResponse: null, coherence: null, lexical: null, grammar: null });
  const speaking = record("speaking").request.payload;
  assert.equal(speaking.recordingId, null);
  assert.equal(speaking.recordingDevice, null);
  assert.equal(speaking.durationSeconds, 0);
});

test("R0 future metadata stays rejected until a real client/server contract extension", () => {
  for (const [kind, field, value] of [
    ["plan", "sectionTargets", { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 }],
    ["attempt", "questionResults", []],
    ["essay", "taskType", "task2"],
    ["speaking", "sessionId", "future-session"],
    ["feedback", "reviewer", { name: "Example reviewer" }],
    ["assessment", "evidenceRefs", []],
  ] as const) {
    const current = record(kind).request.payload;
    assert.throws(() => validatePayload(kind, { ...current, [field]: value }), /字段/);
  }
  const feedback = record("feedback").request.payload;
  assert.throws(() => validatePayload("feedback", { ...feedback, bands: { taskAchievement: 7 } }), /分数/);
});
