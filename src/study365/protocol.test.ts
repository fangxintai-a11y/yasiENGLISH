import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decodeRevision, hashPayload, projectLearningPayload, validatePayload, type LearningKind, type LearningPayload, type Revision } from "./protocol";

const plan = { datasetId: "word-atlas-open", planId: "plan-one", startDate: "2026-11-03", studyBudgetMinutes: 120, targetBand: 8, sectionTargets: { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 } };
const revision: Revision = { id: "essay-one", kind: "essay", datasetId: "word-atlas-open", planId: "plan-one", revisionId: "11111111-1111-4111-8111-111111111111", baseRevision: null, seq: 1, payload: { datasetId: "word-atlas-open", planId: "plan-one", text: "Original draft" }, contentHash: "a".repeat(64), createdAt: 1, conflict: false, deleted: false };

test("remote metadata cannot conceal a contradictory payload owner or plan", () => {
  assert.throws(() => decodeRevision({ ...revision, payload: { ...revision.payload, datasetId: "other-atlas" } }), /归属/);
  assert.throws(() => decodeRevision({ ...revision, payload: { ...revision.payload, planId: "other-plan" } }), /归属/);
  const decoded = decodeRevision({ ...revision, payload: { text: "Original draft" } });
  assert.deepEqual(decoded.payload, { text: "Original draft" });
  assert.equal(decoded.planId, "plan-one");
  assert.equal(decoded.datasetId, "word-atlas-open");
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
  assert.throws(() => validatePayload("plan", { ...plan, studyBudgetMinutes: "150" }), /120/);
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

const fixedTargets = { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 };
const fixedPlan = { datasetId: "word-atlas-open", planId: "plan-one", startDate: "2026-11-03", studyBudgetMinutes: 120, targetBand: 8, sectionTargets: fixedTargets };
const gate = { datasetId: "word-atlas-open", planId: "plan-one", kind: "gate", source: "human", date: "2027-09-03", gateId: "G3", consecutiveIndex: 1,
  targets: { overall: 7.5, listening: 8, reading: 8, writing: 7, speaking: 7 },
  scores: { listening: 8, reading: 8, writing: 7, speaking: 7 },
  scoreSources: { listening: "rules", reading: "rules", writing: "human", speaking: "human" } };
const task1Feedback = { datasetId: "word-atlas-open", planId: "plan-one", workRevisionId: revision.revisionId, inputHash: "a".repeat(64), source: "human", text: "Comments", taskType: "task1",
  bands: { taskAchievement: 7, coherence: 7, lexical: 7, grammar: 7 } };
const attempt = { datasetId: "word-atlas-open", planId: "plan-one", contentId: "read-one", skill: "reading", answers: ["a"],
  questionResults: [{ questionId: "q1", correct: false, confidence: "sure", errorCause: "synonym-miss" }] };
const weekly = { datasetId: "word-atlas-open", planId: "plan-one", kind: "weekly-calibration", source: "human", weekIndex: 1, workRevisionId: revision.revisionId,
  taskType: "task2", bands: { taskResponse: 7, coherence: 7, lexical: 7, grammar: 7 } };
const unknownGate = { ...gate, consecutiveIndex: 2, scores: { ...gate.scores, writing: null }, scoreSources: { ...gate.scoreSources, writing: null } };
const officialGate = { ...gate, gateId: "G4", consecutiveIndex: 1, source: "official", date: "2027-11-03", targets: { overall: 8, ...fixedTargets }, scores: { ...fixedTargets },
  scoreSources: { listening: "official", reading: "official", writing: "official", speaking: "official" } };
function without(payload: LearningPayload, key: string): LearningPayload {
  const copy = { ...payload }; delete copy[key]; return copy;
}

// Each row becomes an independent test. Every negative input changes one
// contract condition, with its own expected error rather than a generic throw.
const rejected: { name: string; kind: LearningKind; payload: LearningPayload; error: RegExp }[] = [
  { name: "plan rejects missing sectionTargets", kind: "plan", payload: without(fixedPlan, "sectionTargets"), error: /四科目标/ },
  { name: "plan rejects a targetBand below 8", kind: "plan", payload: { ...fixedPlan, targetBand: 7.5 }, error: /项目目标固定为雅思总分8\.0/ },
  { name: "plan rejects a 150 minute budget", kind: "plan", payload: { ...fixedPlan, studyBudgetMinutes: 150 }, error: /每日学习时长固定为 120 分钟/ },
  { name: "plan rejects a 180 minute budget", kind: "plan", payload: { ...fixedPlan, studyBudgetMinutes: 180 }, error: /每日学习时长固定为 120 分钟/ },
  { name: "new plan rejects the retired sectionMinimum field", kind: "plan", payload: { ...fixedPlan, sectionMinimum: 6.5 }, error: /字段/ },
  { name: "gate rejects a missing date", kind: "assessment", payload: without(gate, "date"), error: /日期/ },
  { name: "G2 rejects the G3 target values", kind: "assessment", payload: { ...gate, gateId: "G2" }, error: /门槛目标/ },
  { name: "gate rejects AI writing scores", kind: "assessment", payload: { ...gate, scoreSources: { ...gate.scoreSources, writing: "ai" } }, error: /真人/ },
  { name: "Task 1 feedback rejects taskResponse", kind: "feedback", payload: { ...task1Feedback, bands: { taskResponse: 7 } }, error: /Task 1/ },
  { name: "Task 2 feedback rejects taskAchievement", kind: "feedback", payload: { ...task1Feedback, taskType: "task2" }, error: /Task 2/ },
  { name: "attempt rejects free text error causes", kind: "attempt", payload: { ...attempt, questionResults: [{ ...attempt.questionResults[0], errorCause: "听错了" }] }, error: /错因/ },
  { name: "other error cause requires a note", kind: "attempt", payload: { ...attempt, questionResults: [{ ...attempt.questionResults[0], errorCause: "other" }] }, error: /说明/ },
  { name: "feedback rejects an unrecognised teacher source", kind: "feedback", payload: { ...task1Feedback, source: "teacher" }, error: /来源/ },
  { name: "weekly calibration rejects week 53", kind: "assessment", payload: { ...weekly, weekIndex: 53 }, error: /周/ },
  { name: "unknown gate score rejects an invented human source", kind: "assessment", payload: { ...unknownGate, scoreSources: { ...unknownGate.scoreSources, writing: "human" } }, error: /分数与来源/ },
  { name: "known gate score rejects a null source", kind: "assessment", payload: { ...unknownGate, scores: { ...unknownGate.scores, writing: 7 } }, error: /分数与来源/ },
  { name: "G4 rejects an overall human source", kind: "assessment", payload: { ...officialGate, source: "human" }, error: /G4.*正式/ },
  { name: "G4 rejects a rules based listening score", kind: "assessment", payload: { ...officialGate, scoreSources: { ...officialGate.scoreSources, listening: "rules" } }, error: /G4.*正式/ },
];
for (const sample of rejected) test(sample.name, () => {
  assert.throws(() => validatePayload(sample.kind, sample.payload), sample.error);
});

const accepted: { name: string; kind: LearningKind; payload: LearningPayload }[] = [
  { name: "plan accepts Band 8 with four section targets and 120 minutes", kind: "plan", payload: fixedPlan },
  { name: "G3 accepts dated four skill targets and source evidence", kind: "assessment", payload: gate },
  { name: "essay accepts an explicit Task 1 type", kind: "essay", payload: { datasetId: "word-atlas-open", planId: "plan-one", text: "An original essay.", taskType: "task1" } },
  { name: "Task 1 feedback accepts taskAchievement", kind: "feedback", payload: task1Feedback },
  { name: "attempt accepts enumerated synonym miss cause", kind: "attempt", payload: attempt },
  { name: "weekly calibration accepts a separate AI result", kind: "assessment", payload: { ...weekly, source: "ai" } },
  { name: "weekly calibration accepts a separate human result", kind: "assessment", payload: weekly },
  { name: "gate keeps a missing score and its source null", kind: "assessment", payload: unknownGate },
  { name: "G4 accepts all official section sources", kind: "assessment", payload: officialGate },
  { name: "G4 can store an unknown section without inventing a score", kind: "assessment", payload: { ...officialGate, scores: { ...officialGate.scores, writing: null }, scoreSources: { ...officialGate.scoreSources, writing: null } } },
];
for (const sample of accepted) test(sample.name, () => {
  assert.doesNotThrow(() => validatePayload(sample.kind, sample.payload));
});

test("legacy plan projection upgrades business goals without rewriting raw revision hashes", async () => {
  const oldPayload = { datasetId: "word-atlas-open", planId: "plan-one", startDate: "2026-11-03", studyBudgetMinutes: 150, targetBand: 7, sectionMinimum: 6.5 };
  const originalHash = await hashPayload("plan", oldPayload);
  const old = decodeRevision({ ...revision, id: "plan-one", kind: "plan", payload: oldPayload, contentHash: originalHash });
  assert.deepEqual(old.payload, oldPayload);
  assert.equal(old.contentHash, originalHash);
  const view = projectLearningPayload("plan", old.payload);
  assert.equal(view.targetBand, 8);
  assert.equal(view.studyBudgetMinutes, 120);
  assert.deepEqual(view.sectionTargets, fixedTargets);
  assert.equal("sectionMinimum" in view, false);
  assert.equal(await hashPayload("plan", old.payload), originalHash);
});
