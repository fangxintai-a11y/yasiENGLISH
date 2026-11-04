import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ERROR_CAUSES, LEARNING_PROTOCOL, decodeRevision, hashPayload, projectLearningPayload, validatePayload, validateStoredPayload, validateWritingFeedbackReference, type LearningPayload, type Revision, type WriteRequest } from "./protocol";
import { WRITING_CHECKLIST_IDS, WRITING_ERROR_CAUSES, writingChecklistIds } from "./writingChecklist";

interface FixtureRecord { recordId: string; request: WriteRequest; expectedContentHash: string }
interface InvalidCase { recordId: string; label: string; path: (string | number)[]; value: unknown; error: string; remove?: boolean; reference?: boolean }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/r2-records.json", import.meta.url), "utf8")) as { fixtureVersion: number; purpose: string; records: FixtureRecord[]; invalidCases: InvalidCase[] };
const record = (id: string) => { const result = fixture.records.find(item => item.recordId === id); assert.ok(result, id); return result; };
const workFor = (payload: LearningPayload) => { const result = fixture.records.find(item => item.request.revisionId === payload.workRevisionId); assert.ok(result); return result.request.payload; };
const revision = (item: FixtureRecord, index: number): Revision => ({ id: item.recordId, kind: item.request.kind, datasetId: null, planId: "r2-plan", revisionId: item.request.revisionId, baseRevision: item.request.baseRevision, seq: index + 1, payload: item.request.payload, contentHash: item.expectedContentHash, createdAt: index + 1, conflict: false, deleted: false, payloadVersion: 2 });
function invalidPayload(item: InvalidCase): LearningPayload {
  const payload = structuredClone(record(item.recordId).request.payload);
  let target: any = payload;
  for (const key of item.path.slice(0, -1)) target = target[key];
  const key = item.path.at(-1)!;
  if (item.remove) delete target[key]; else target[key] = item.value;
  return payload;
}

for (const [index, item] of fixture.records.entries()) test(`R2 wire ${item.recordId} revision ${index + 1} validates and preserves exact hash/body`, async () => {
  const before = JSON.stringify(item.request);
  validatePayload(item.request.kind, item.request.payload);
  if (item.request.kind === "feedback") validateWritingFeedbackReference(item.request.payload, workFor(item.request.payload));
  assert.equal(await hashPayload(item.request.kind, item.request.payload), item.expectedContentHash);
  assert.deepEqual(decodeRevision(revision(item, index)).payload, item.request.payload);
  assert.equal(JSON.stringify(item.request), before);
});
for (const item of fixture.invalidCases) test(`R2 rejects ${item.label}`, () => {
  const value = invalidPayload(item), kind = record(item.recordId).request.kind;
  if (item.reference) {
    assert.doesNotThrow(() => validatePayload(kind, value), "the wire shape is valid; rejection must use the actual original");
    assert.throws(() => validateWritingFeedbackReference(value, workFor(value)), new RegExp(item.error));
  } else assert.throws(() => validatePayload(kind, value), new RegExp(item.error));
});

const essayBase = { planId: "r2-plan", taskType: "task2", text: "A short synthetic draft." };
const feedbackBase = { planId: "r2-plan", taskType: "task2", workRevisionId: "50000000-0000-4000-8000-000000000001", inputHash: "0".repeat(64), source: "self", text: "A synthetic check." };
const newFields = [["essay", "scope", "paragraph"], ["essay", "stage", "draft"], ["essay", "elapsedSeconds", 1200], ["essay", "conditions", { timed: true, firstAttempt: false, unseen: true }], ["essay", "sourceRef", "Self-authored practice"], ["feedback", "errorCauses", ["grammar"]], ["feedback", "spellingCheck", { status: "unchecked", count: null, items: [] }], ["feedback", "checklist", { "task-response-answer": null }]] as const;
for (const [kind, field, value] of newFields) test(`R2 accepts independent ${kind}.${field}`, () => validatePayload(kind, { ...(kind === "essay" ? essayBase : feedbackBase), [field]: value }));

test("R2 keeps wire protocol 2 and fixes only the allowed writing checklist IDs", () => {
  assert.equal(LEARNING_PROTOCOL, 2); assert.equal(fixture.fixtureVersion, 2);
  assert.equal(fixture.purpose, "synthetic-r2-writing-wire-examples-not-user-learning-records");
  assert.equal(WRITING_CHECKLIST_IDS.task1.length, 15); assert.equal(WRITING_CHECKLIST_IDS.task2.length, 12);
  assert.equal(writingChecklistIds("task2").includes("task1-no-opinion"), false);
  assert.ok(WRITING_ERROR_CAUSES.every(cause => ERROR_CAUSES.includes(cause)));
});
test("R2 read migration defaults old essays only in an idempotent business projection", async () => {
  const item = record("r2-essay-legacy"), before = structuredClone(item.request.payload);
  const view = projectLearningPayload("essay", item.request.payload);
  assert.equal(view.scope, "full"); assert.equal(view.stage, "submitted");
  assert.deepEqual(projectLearningPayload("essay", view), view);
  assert.deepEqual(item.request.payload, before);
  assert.equal(Object.hasOwn(decodeRevision(revision(item, 1)).payload, "scope"), false);
  assert.equal(await hashPayload("essay", view), item.expectedContentHash);
});
test("R2 legacy essays without taskType remain raw and are not guessed into Task 2", () => {
  const raw = { planId: "r2-plan", text: "An old short piece." };
  assert.doesNotThrow(() => validateStoredPayload("essay", raw));
  const view = projectLearningPayload("essay", raw);
  assert.equal(view.taskType, undefined); assert.equal(view.scope, "full");
  assert.deepEqual(raw, { planId: "r2-plan", text: "An old short piece." });
});
test("R2 metadata changes do not normalize original UTF-8 text or change essay hash", async () => {
  const payload = record("r2-feedback-checked").request.payload, original = workFor(payload);
  assert.equal(await hashPayload("essay", { ...original, scope: "paragraph", stage: "draft", elapsedSeconds: 1, sourceRef: "Different provenance" }), payload.inputHash);
  assert.notEqual(await hashPayload("essay", { ...original, text: String(original.text).trim() }), payload.inputHash);
});
test("R2 feedback verifies the referenced task type rather than its own claimed checklist", () => {
  const payload = record("r2-feedback-checked").request.payload;
  assert.throws(() => validateWritingFeedbackReference(payload, record("r2-essay-task1").request.payload), /任务类型与原稿/);
});
test("R2 spelling offsets use UTF-16 including a complete emoji", () => {
  const value = { ...feedbackBase, spellingCheck: { status: "checked", count: 1, items: [{ start: 2, end: 4, text: "📝", confirmed: true }] } };
  assert.doesNotThrow(() => validateWritingFeedbackReference(value, { taskType: "task2", text: "A 📝 note." }));
});
test("R2 spelling offsets cannot split a surrogate pair", () => {
  const value = { ...feedbackBase, spellingCheck: { status: "checked", count: 1, items: [{ start: 3, end: 4, text: "📝", confirmed: true }] } };
  assert.throws(() => validateWritingFeedbackReference(value, { taskType: "task2", text: "A 📝 note." }), /拼写片段/);
});
test("R2 unchecked and checked-zero states remain distinct after decoding", () => {
  const unchecked = record("r2-feedback-unchecked"), checked = record("r2-feedback-cancelled");
  assert.deepEqual(decodeRevision(revision(unchecked, 1)).payload.spellingCheck, { status: "unchecked", count: null, items: [] });
  assert.equal((decodeRevision(revision(checked, 2)).payload.spellingCheck as any).count, 0);
});
test("R2 still rejects unapproved future essay fields rather than silently dropping them", () => {
  assert.throws(() => validatePayload("essay", { ...essayBase, outline: "Keep this local" }), /不支持的字段/);
});
