import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ERROR_CAUSES, LEARNING_PROTOCOL, decodeRevision, hashPayload, projectLearningPayload, validatePayload, validateSpeakingFeedbackReference, type LearningPayload, type Revision, type WriteRequest } from "./protocol";
import { SPEAKING_CHECKLIST_IDS, SPEAKING_ERROR_CAUSES } from "./speakingChecklist";

interface FixtureRecord { recordId: string; request: WriteRequest; expectedContentHash: string }
interface InvalidCase { recordId: string; label: string; path?: (string | number)[]; value?: unknown; error: string; remove?: boolean; referenceTarget?: string; omitBands?: boolean }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/r3-records.json", import.meta.url), "utf8")) as { fixtureVersion: number; purpose: string; records: FixtureRecord[]; invalidCases: InvalidCase[] };
const record = (id: string) => { const value = fixture.records.find(item => item.recordId === id); assert.ok(value, id); return value; };
const workFor = (payload: LearningPayload) => { const value = fixture.records.find(item => item.request.revisionId === payload.workRevisionId); assert.ok(value); return value; };
const revision = (item: FixtureRecord, index: number): Revision => ({ id: item.recordId, kind: item.request.kind, datasetId: null, planId: "r3-plan", revisionId: item.request.revisionId, baseRevision: item.request.baseRevision, seq: index + 1, payload: item.request.payload, contentHash: item.expectedContentHash, createdAt: index + 1, conflict: false, deleted: false, payloadVersion: 2 });
function invalidPayload(item: InvalidCase): LearningPayload {
  const value = structuredClone(record(item.recordId).request.payload);
  if (item.referenceTarget) {
    const work = record(item.referenceTarget);
    if (item.omitBands) delete value.bands;
    return { ...value, workId: work.recordId, workRevisionId: work.request.revisionId, inputHash: work.expectedContentHash };
  }
  let target: any = value;
  for (const key of item.path!.slice(0, -1)) target = target[key];
  const key = item.path!.at(-1)!;
  if (item.remove) delete target[key]; else target[key] = item.value;
  return value;
}
for (const [index, item] of fixture.records.entries()) test(`R3 wire ${item.recordId} revision ${index + 1} validates without changing its hash or raw body`, async () => {
  const before = JSON.stringify(item.request);
  validatePayload(item.request.kind, item.request.payload);
  if (item.request.kind === "feedback" && item.request.payload.taskType === "speaking") {
    const work = workFor(item.request.payload);
    validateSpeakingFeedbackReference(item.request.payload, { kind: work.request.kind, payload: work.request.payload });
  }
  assert.equal(await hashPayload(item.request.kind, item.request.payload), item.expectedContentHash);
  assert.deepEqual(decodeRevision(revision(item, index)).payload, item.request.payload);
  assert.equal(JSON.stringify(item.request), before);
});
for (const item of fixture.invalidCases) test(`R3 rejects ${item.label}`, () => {
  const value = invalidPayload(item), kind = record(item.recordId).request.kind;
  if (item.referenceTarget) {
    const work = record(item.referenceTarget);
    assert.doesNotThrow(() => validatePayload(kind, value), "only the actual work kind is wrong; wire references/hash are accurate");
    assert.throws(() => validateSpeakingFeedbackReference(value, { kind: work.request.kind, payload: work.request.payload }), new RegExp(item.error));
  } else assert.throws(() => validatePayload(kind, value), new RegExp(item.error));
});

const speaking = { planId: "r3-plan", transcript: "A synthetic spoken answer." };
const feedback = { planId: "r3-plan", taskType: "speaking", workRevisionId: "71000000-0000-4000-8000-000000000001", inputHash: "0".repeat(64), source: "self", text: "A synthetic review." };
for (const [field, value] of [["part", 1], ["prepSeconds", 0], ["conditions", { timed: true, firstAttempt: true, unseen: false }], ["sourceRef", "Self-authored practice"], ["recordingStatus", "none"]] as const) test(`R3 independent speaking.${field} is accepted`, () => validatePayload("speaking", { ...speaking, [field]: value }));
for (const [field, value] of [["taskType", "speaking"], ["errorCauses", ["fluency-pause"]], ["checklist", { "speaking-fluency-continuity": true }]] as const) test(`R3 independent speaking feedback.${field} is accepted`, () => validatePayload("feedback", { ...feedback, [field]: value }));
for (const cause of SPEAKING_ERROR_CAUSES) test(`R3 speaking permits the task-book code ${cause}`, () => validatePayload("feedback", { ...feedback, errorCauses: [cause] }));

test("R3 fixed speaking IDs and causes are exactly the additive contract subset", () => {
  assert.equal(LEARNING_PROTOCOL, 2); assert.equal(fixture.fixtureVersion, 2);
  assert.equal(fixture.purpose, "synthetic-r3-speaking-wire-examples-not-user-learning-records");
  assert.equal(SPEAKING_CHECKLIST_IDS.length, 10); assert.equal(new Set(SPEAKING_CHECKLIST_IDS).size, 10);
  assert.ok(SPEAKING_CHECKLIST_IDS.every(id => id.startsWith("speaking-")));
  assert.deepEqual([...SPEAKING_ERROR_CAUSES].sort(), ERROR_CAUSES.filter(cause => !["task-response", "task-achievement", "spelling", "word-limit"].includes(cause)).sort());
});
test("R3 old speaking reads as unknown Part only in an idempotent business view", async () => {
  const item = record("r3-speaking-legacy"), before = structuredClone(item.request.payload);
  const view = projectLearningPayload("speaking", item.request.payload);
  assert.equal(view.part, null); assert.equal(view.recordingStatus, undefined);
  assert.deepEqual(projectLearningPayload("speaking", view), view);
  assert.deepEqual(item.request.payload, before);
  assert.equal(Object.hasOwn(decodeRevision(revision(item, 1)).payload, "part"), false);
  assert.equal(await hashPayload("speaking", view), item.expectedContentHash);
});
test("R3 speaking hash is exact transcript UTF-8, independent of audio metadata and timing", async () => {
  const original = record("r3-speaking-part1").request.payload;
  const expected = record("r3-speaking-part1").expectedContentHash;
  assert.equal(await hashPayload("speaking", { ...original, part: 3, prepSeconds: 0, durationSeconds: 0, recordingStatus: "none", recordingId: null, sourceRef: "Another source", conditions: { timed: false } }), expected);
  assert.notEqual(await hashPayload("speaking", { ...original, transcript: String(original.transcript).trim() }), expected);
});
test("R3 empty transcript is still a valid saved response with the exact empty hash", async () => {
  const item = record("r3-speaking-empty"); validatePayload("speaking", item.request.payload);
  assert.equal(await hashPayload("speaking", item.request.payload), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
test("R3 revised transcript preserves the earlier review's exact immutable binding", () => {
  const originals = fixture.records.filter(item => item.recordId === "r3-speaking-part1");
  assert.equal(originals.length, 2); assert.equal(originals[1].request.baseRevision, originals[0].request.revisionId);
  assert.equal(record("r3-feedback-self").request.payload.inputHash, originals[0].expectedContentHash);
  assert.notEqual(originals[0].expectedContentHash, originals[1].expectedContentHash);
  assert.equal(record("r3-feedback-new-transcript").request.payload.workRevisionId, originals[1].request.revisionId);
});
test("R3 legacy speaking feedback without a discriminator remains readable", () => {
  const item = record("r3-feedback-legacy");
  assert.doesNotThrow(() => validatePayload("feedback", item.request.payload));
  assert.equal(Object.hasOwn(decodeRevision(revision(item, 1)).payload, "taskType"), false);
});
test("R3 weekly speaking calibration preserves the existing discriminator-free four dimensions", () => {
  const value = record("r3-weekly-human").request.payload;
  assert.equal(value.taskType, undefined); assert.deepEqual(Object.keys(value.bands as object).sort(), ["fluency", "grammar", "lexical", "pronunciation"]);
  assert.doesNotThrow(() => validatePayload("assessment", value));
});
test("R3 speaking discriminator does not expand essay task types", () => {
  assert.throws(() => validatePayload("essay", { planId: "r3-plan", taskType: "speaking", text: "A synthetic draft." }), /task1/);
});
test("R3 speaking discriminator does not change weekly-calibration task types", () => {
  assert.throws(() => validatePayload("assessment", { ...record("r3-weekly-human").request.payload, taskType: "speaking" }), /任务类型/);
});
for (const field of ["audio", "audioBase64", "blob", "audioUrl"]) test(`R3 speaking wire rejects undeclared ${field}`, () => {
  assert.throws(() => validatePayload("speaking", { ...speaking, [field]: "not-a-real-recording" }), /不支持的字段/);
});
