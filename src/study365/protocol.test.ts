import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decodeRevision, hashPayload, validatePayload, type Revision } from "./protocol";

const plan = { datasetId: "word-atlas-open", planId: "plan-one", startDate: "2026-11-03", studyBudgetMinutes: 150 };
const revision: Revision = { id: "essay-one", kind: "essay", datasetId: "word-atlas-open", planId: "plan-one", revisionId: "11111111-1111-4111-8111-111111111111", baseRevision: null, seq: 1, payload: { datasetId: "word-atlas-open", planId: "plan-one", text: "Original draft" }, contentHash: "a".repeat(64), createdAt: 1, conflict: false, deleted: false };

test("remote metadata cannot conceal a contradictory payload owner or plan", () => {
  assert.throws(() => decodeRevision({ ...revision, payload: { ...revision.payload, datasetId: "other-atlas" } }), /归属/);
  assert.throws(() => decodeRevision({ ...revision, payload: { ...revision.payload, planId: "other-plan" } }), /归属/);
  const decoded = decodeRevision({ ...revision, payload: { text: "Original draft" } });
  assert.equal(decoded.payload.planId, "plan-one");
  assert.equal(decoded.payload.datasetId, "word-atlas-open");
});

test("offline work hashes use the unchanged original UTF-8 text", async () => {
  const text = "First draft\r\n第二段 🌱\n";
  assert.equal(await hashPayload("essay", { text }), createHash("sha256").update(text, "utf8").digest("hex"));
  assert.equal(await hashPayload("speaking", { transcript: text }), createHash("sha256").update(text, "utf8").digest("hex"));
  assert.notEqual(await hashPayload("essay", { text }), await hashPayload("essay", { text: text.trim() }));
});

test("credentials and unrecognized fields cannot become learning backups", () => {
  assert.throws(() => validatePayload("plan", { ...plan, apiKey: "not-a-real-key" }), /字段/);
  assert.throws(() => validatePayload("essay", { datasetId: plan.datasetId, planId: plan.planId, text: "sk-proj-THIS_IS_ONLY_A_SYNTHETIC_TEST_VALUE" }), /凭据/);
});

test("invalid dates, impossible attempt scores and oversized prompts fail before queuing", () => {
  assert.throws(() => validatePayload("plan", { ...plan, startDate: "2026-02-30" }), /日期/);
  assert.throws(() => validatePayload("plan", { ...plan, studyBudgetMinutes: "150" }), /预算/);
  assert.throws(() => validatePayload("plan", { ...plan, pauseIntervals: [{ start: "2026-02-30", end: "2026-03-10" }] }), /日期/);
  assert.throws(() => validatePayload("attempt", { datasetId: plan.datasetId, planId: plan.planId, contentId: "read-one", skill: "reading", answers: [0], correct: 2, total: 1 }), /正确数/);
  assert.throws(() => validatePayload("essay", { datasetId: plan.datasetId, planId: plan.planId, text: "draft", prompt: "x".repeat(8001) }), /长度/);
});

test("feedback remains literal text and can only reference a concrete revision hash", () => {
  const payload = { datasetId: plan.datasetId, planId: plan.planId, workRevisionId: revision.revisionId, inputHash: "a".repeat(64), source: "self", text: '<img src=x onerror="alert(1)">', rubricVersion: "v1" };
  assert.doesNotThrow(() => validatePayload("feedback", payload));
  assert.equal(payload.text, '<img src=x onerror="alert(1)">');
  assert.throws(() => validatePayload("feedback", { ...payload, inputHash: "not-a-hash" }), /校验/);
});
