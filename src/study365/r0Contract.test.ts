import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GATE_TARGETS, SECTION_TARGETS, SCORE_SOURCES, decodeRevision, hashPayload, isIdentifier, isRevisionId, LEARNING_KINDS, validatePayload,
  type LearningKind, type LearningPayload, type Revision, type WriteRequest } from "./protocol";
import { evaluateFinalGoal, evaluateGate } from "./goals";

interface FixtureRecord { recordId: string; request: WriteRequest; expectedContentHash: string }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/r0-records.json", import.meta.url), "utf8")) as {
  fixtureVersion: number; purpose: string; records: FixtureRecord[];
};
const record = (id: string): FixtureRecord => {
  const value = fixture.records.find((item) => item.recordId === id);
  assert.ok(value, `missing fixture ${id}`); return value;
};
const payload = (id: string) => structuredClone(record(id).request.payload);
const without = (value: LearningPayload, field: string) => { delete value[field]; return value; };
const revision = (item: FixtureRecord, index: number): Revision => ({ id: item.recordId, kind: item.request.kind, datasetId: item.request.payload.datasetId as string | null,
  planId: item.request.payload.planId as string, revisionId: item.request.revisionId, baseRevision: item.request.baseRevision, seq: index + 1,
  payload: item.request.payload, contentHash: item.expectedContentHash, createdAt: index + 1, conflict: false, deleted: false, payloadVersion: 2 });

test("R0 schema v2 synthetic examples cover the seven record kinds without importing user progress", () => {
  assert.equal(fixture.fixtureVersion, 2);
  assert.equal(fixture.purpose, "synthetic-wire-examples-not-user-learning-records");
  assert.deepEqual([...new Set(fixture.records.map((item) => item.request.kind))].sort(), [...LEARNING_KINDS].sort());
  for (const key of ["recordId", "revisionId", "mutationId"] as const) {
    const values = fixture.records.map((item) => key === "recordId" ? item.recordId : item.request[key]);
    assert.equal(new Set(values).size, fixture.records.length, `duplicate ${key}`);
  }
});

for (const item of fixture.records) test(`R0 ${item.recordId} is valid v2 wire data with the shared UTF-8 hash`, async () => {
  assert.ok(isIdentifier(item.recordId));
  assert.equal(item.request.schemaVersion, 2);
  assert.ok(isRevisionId(item.request.revisionId)); assert.ok(isRevisionId(item.request.mutationId));
  assert.equal(item.request.baseRevision, null);
  assert.equal(item.request.payload.planId, "r0-plan-band8");
  assert.doesNotThrow(() => validatePayload(item.request.kind, item.request.payload));
  assert.equal(await hashPayload(item.request.kind, item.request.payload), item.expectedContentHash);
  const saved = decodeRevision(revision(item, fixture.records.indexOf(item)));
  assert.deepEqual(saved.payload, item.request.payload);
});

test("R0 plan requires Band 8, each section target and only 120 minutes", () => {
  const value = payload("r0-plan-band8");
  assert.equal(value.targetBand, 8); assert.deepEqual(value.sectionTargets, SECTION_TARGETS);
  assert.equal(value.studyBudgetMinutes, 120); assert.equal("sectionMinimum" in value, false);
  assert.equal(value.enabled, false);
});

test("R0 section targets and taskAchievement are accepted contract fields", () => {
  assert.doesNotThrow(() => validatePayload("plan", payload("r0-plan-band8")));
  const feedback = payload("r0-feedback-task1");
  assert.equal(feedback.taskType, "task1");
  assert.ok(Object.hasOwn(feedback.bands as object, "taskAchievement"));
  assert.doesNotThrow(() => validatePayload("feedback", feedback));
});

test("R0 Task 2 feedback uses taskResponse and keeps its actual task type", () => {
  const feedback = payload("r0-feedback-writing");
  assert.equal(feedback.taskType, "task2");
  assert.ok(Object.hasOwn(feedback.bands as object, "taskResponse"));
  assert.equal(Object.hasOwn(feedback.bands as object, "taskAchievement"), false);
  assert.doesNotThrow(() => validatePayload("feedback", feedback));
});

test("R0 feedback and calibration inputs bind actual work revision hashes", async () => {
  const works = new Map(fixture.records.filter((item) => ["essay", "speaking"].includes(item.request.kind)).map((item) => [item.request.revisionId, item]));
  for (const item of fixture.records.filter((item) => item.request.payload.workRevisionId)) {
    const value = item.request.payload, work = works.get(String(value.workRevisionId));
    assert.ok(work, `${item.recordId}.workRevisionId`);
    assert.equal(value.workId, work.recordId, `${item.recordId}.workId`);
    assert.equal(value.inputHash, work.expectedContentHash, `${item.recordId}.inputHash`);
    assert.equal(value.inputHash, await hashPayload(work.request.kind, work.request.payload));
    if (work.request.kind === "essay") assert.equal(value.taskType, work.request.payload.taskType, `${item.recordId}.taskType`);
  }
});

test("R0 changed original text cannot reuse the fixture feedback inputHash", async () => {
  const essay = payload("r0-essay-writing"), feedback = payload("r0-feedback-writing");
  assert.notEqual(await hashPayload("essay", { ...essay, text: `${essay.text}\nA revised sentence.` }), feedback.inputHash);
});

test("R0 scored records use enumerated sources and baseline missing scores remain null", () => {
  for (const item of fixture.records.filter((item) => ["feedback", "assessment"].includes(item.request.kind))) {
    assert.ok(SCORE_SOURCES.includes(item.request.payload.source as typeof SCORE_SOURCES[number]), `${item.recordId}.source`);
  }
  assert.equal(payload("r0-assessment-baseline").kind, "baseline");
  assert.deepEqual(payload("r0-assessment-baseline").scores, { listening: null, reading: null, writing: null, speaking: null });
});

for (const gateId of ["G1", "G2", "G3", "G4"] as const) test(`R0 ${gateId} preserves its dated four skill threshold and source evidence`, () => {
  const items = fixture.records.filter((item) => item.request.payload.kind === "gate" && item.request.payload.gateId === gateId);
  assert.equal(items.length, gateId === "G3" ? 2 : 1);
  for (const item of items) {
    assert.deepEqual(item.request.payload.targets, GATE_TARGETS[gateId]);
    assert.equal(typeof item.request.payload.date, "string");
    assert.doesNotThrow(() => validatePayload("assessment", item.request.payload));
  }
});

test("R0 independent G3 examples meet the consecutive rule using two distinct records", () => {
  assert.equal(evaluateGate(fixture.records.map(revision), "r0-plan-band8", "G3").met, true);
});

test("R0 formal example reaches all mandatory targets without declaring synthetic data real evidence", () => {
  assert.equal(evaluateFinalGoal(payload("r0-assessment-official")).met, true);
  assert.equal(fixture.purpose, "synthetic-wire-examples-not-user-learning-records");
});

test("R0 weekly calibration keeps human AI and self results distinct for the same original", () => {
  const items = fixture.records.filter((item) => item.request.payload.kind === "weekly-calibration" && item.request.payload.workId === "r0-essay-writing");
  assert.deepEqual(items.map((item) => item.request.payload.source).sort(), ["ai", "human", "self"]);
  assert.equal(new Set(items.map((item) => item.request.payload.workRevisionId)).size, 1);
  assert.equal(new Set(items.map((item) => item.request.payload.inputHash)).size, 1);
  assert.equal(items.every((item) => item.request.payload.weekIndex === 1), true);
});

test("R0 reading errors and confidence correspond to actual sample answers", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../public/curriculum365/v1/samples.json", import.meta.url), "utf8")) as {
    materials: { id: string; version: string; questions?: { id: string; answer: { accepted: (string | number)[] } }[] }[];
  };
  const value = payload("r0-attempt-reading"), material = catalog.materials.find((item) => item.id === value.contentId);
  assert.ok(material?.questions); assert.equal(value.contentVersion, material.version);
  const answers = value.answers as (string | number)[], results = value.questionResults as { questionId: string; correct: boolean; confidence: string; errorCause: string | null }[];
  assert.equal(results.length, material.questions.length); assert.equal(answers.length, material.questions.length);
  material.questions.forEach((question, index) => {
    const result = results[index]; assert.equal(result.questionId, question.id);
    assert.equal(result.correct, question.answer.accepted.includes(answers[index]));
    assert.ok(["sure", "unsure"].includes(result.confidence));
    assert.equal(result.correct ? result.errorCause === null : typeof result.errorCause === "string", true);
  });
  const correct = results.filter((item) => item.correct).length;
  assert.ok(correct > 0 && correct < results.length, "fixture must include both correct answers and a real error");
  assert.equal(value.correct, correct); assert.equal(value.score, correct); assert.equal(value.total, results.length);
});

const negativeCases: { name: string; kind: LearningKind; id: string; change: (value: LearningPayload) => LearningPayload; error: RegExp }[] = [
  { name: "plan.sectionTargets is required", kind: "plan", id: "r0-plan-band8", change: (v) => without(v, "sectionTargets"), error: /四科目标/ },
  { name: "plan.sectionTargets.writing must remain 7.5", kind: "plan", id: "r0-plan-band8", change: (v) => ({ ...v, sectionTargets: { ...(v.sectionTargets as object), writing: 7 } }), error: /四科目标/ },
  { name: "plan.targetBand cannot become 7.5", kind: "plan", id: "r0-plan-band8", change: (v) => ({ ...v, targetBand: 7.5 }), error: /项目目标固定为雅思总分8\.0/ },
  { name: "plan.studyBudgetMinutes cannot become 150", kind: "plan", id: "r0-plan-band8", change: (v) => ({ ...v, studyBudgetMinutes: 150 }), error: /每日学习时长固定为 120 分钟/ },
  { name: "plan.sectionMinimum stays retired", kind: "plan", id: "r0-plan-band8", change: (v) => ({ ...v, sectionMinimum: 6.5 }), error: /字段/ },
  { name: "Task 1 rejects taskResponse", kind: "feedback", id: "r0-feedback-task1", change: (v) => ({ ...v, bands: { taskResponse: 7 } }), error: /Task 1/ },
  { name: "Task 2 rejects taskAchievement", kind: "feedback", id: "r0-feedback-writing", change: (v) => ({ ...v, bands: { taskAchievement: 7 } }), error: /Task 2/ },
  { name: "feedback.source cannot be teacher", kind: "feedback", id: "r0-feedback-writing", change: (v) => ({ ...v, source: "teacher" }), error: /评分来源/ },
  { name: "gate.date is required", kind: "assessment", id: "r0-gate-g1", change: (v) => without(v, "date"), error: /日期/ },
  { name: "G2 rejects G1 targets", kind: "assessment", id: "r0-gate-g2", change: (v) => ({ ...v, targets: GATE_TARGETS.G1 }), error: /门槛目标/ },
  { name: "gate writing source cannot be AI", kind: "assessment", id: "r0-gate-g1", change: (v) => ({ ...v, scoreSources: { ...(v.scoreSources as object), writing: "ai" } }), error: /真人/ },
  { name: "G3.consecutiveIndex cannot be 3", kind: "assessment", id: "r0-gate-g3-first", change: (v) => ({ ...v, consecutiveIndex: 3 }), error: /连续测评序号/ },
  { name: "calibration.weekIndex cannot be 53", kind: "assessment", id: "r0-calibration-task2-human", change: (v) => ({ ...v, weekIndex: 53 }), error: /周序/ },
  { name: "calibration.workRevisionId is required", kind: "assessment", id: "r0-calibration-task2-human", change: (v) => without(v, "workRevisionId"), error: /原稿修订/ },
  { name: "speaking.sessionId is not an implemented field", kind: "speaking", id: "r0-speaking-response", change: (v) => ({ ...v, sessionId: "future-session" }), error: /字段/ },
  { name: "feedback.reviewer is not an implemented field", kind: "feedback", id: "r0-feedback-writing", change: (v) => ({ ...v, reviewer: {} }), error: /字段/ },
  { name: "assessment.evidenceRefs is not an implemented field", kind: "assessment", id: "r0-assessment-baseline", change: (v) => ({ ...v, evidenceRefs: [] }), error: /字段/ },
];
for (const sample of negativeCases) test(`R0 rejects ${sample.name}`, () => {
  assert.throws(() => validatePayload(sample.kind, sample.change(payload(sample.id))), sample.error);
});
