import assert from "node:assert/strict";
import { test } from "node:test";
import { compareWeeklyCalibration } from "./calibration";
import { validatePayload, type LearningPayload, type Revision } from "./protocol";

let serial = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
const task1 = { taskAchievement: 6, coherence: 6, lexical: 6, grammar: 6 };
const task2 = { taskResponse: 6, coherence: 6, lexical: 6, grammar: 6 };
const speaking = { fluency: 6, lexical: 6, grammar: 6, pronunciation: 6 };
function revision(id: string, kind: Revision["kind"], payload: LearningPayload): Revision {
  return { id, kind, datasetId: null, planId: "plan-a", revisionId: uuid(), baseRevision: null, seq: serial,
    payload: { planId: "plan-a", ...payload }, contentHash: "a".repeat(64), createdAt: serial, deleted: false, conflict: false, payloadVersion: 2 };
}
function fixture(type: "task1" | "task2" | "speaking" = "task2") {
  const work = revision("work-a", type === "speaking" ? "speaking" : "essay", type === "speaking" ? { prompt: "Describe a place.", transcript: "My draft" } : { prompt: "Discuss the question.", text: "My draft", taskType: type });
  const baseBands = type === "task1" ? task1 : type === "task2" ? task2 : speaking;
  const assessment = (source = "human", fields: LearningPayload = {}) => revision(`assessment-${serial + 1}`, "assessment", {
    kind: "weekly-calibration", date: "2026-11-03", weekIndex: 3, workId: work.id, workRevisionId: work.revisionId,
    inputHash: work.contentHash, ...(type !== "speaking" ? { taskType: type } : {}), source, bands: { ...baseBands }, ...fields,
  });
  return { work, assessment, baseBands };
}

test("same-draft embedded estimates report signed four-dimension differences including the 0.5 boundary", () => {
  const { work, assessment } = fixture();
  const human = assessment("human", { selfBands: { taskResponse: 6.5, coherence: 5, lexical: 6, grammar: 6 },
    machineBands: { taskResponse: 6, coherence: 6, lexical: 7, grammar: 5.5 }, machineSource: "ai" });
  validatePayload("assessment", human.payload);
  const result = compareWeeklyCalibration([work, human]);
  assert.equal(result.length, 2, "the missing comparison must not silently claim calibration is complete");
  const self = result.find((r) => r.source === "self")!;
  assert.equal(self.planId, "plan-a"); assert.equal(self.weekIndex, 3); assert.equal(self.workRevisionId, work.revisionId);
  assert.deepEqual(self.differences.map((d) => [d.dimension, d.delta, d.needsCalibration]), [["taskResponse", .5, true], ["coherence", -1, true], ["lexical", 0, false], ["grammar", 0, false]]);
  assert.deepEqual(result.find((r) => r.source === "ai")!.differences.filter((d) => d.needsCalibration).map((d) => [d.dimension, d.delta]), [["lexical", 1], ["grammar", -.5]]);
});

test("separate self and rule estimates bind to the same official calibration, week and draft", () => {
  const { work, assessment } = fixture("speaking");
  const baseline = assessment("official"), self = assessment("self", { bands: { ...speaking, fluency: 7 } });
  const rules = assessment("rules", { bands: { ...speaking, pronunciation: 5.5 } });
  const result = compareWeeklyCalibration([rules, work, self, baseline]);
  assert.deepEqual(result.map((r) => r.source).sort(), ["rules", "self"]);
  assert.ok(result.every((r) => r.taskType === "speaking" && r.baselineId === baseline.id));
  assert.equal(result.find((r) => r.source === "rules")!.differences.find((d) => d.dimension === "pronunciation")!.delta, -.5);
});

test("a different week, plan, work ID or missing current original cannot contribute an estimate", () => {
  const { work, assessment } = fixture();
  const human = assessment();
  const estimates = [assessment("self", { weekIndex: 4 }), assessment("ai", { planId: "plan-b" }),
    assessment("rules", { workId: "work-b" }), assessment("self", { workRevisionId: uuid() })];
  estimates.push({ ...assessment("self", { planId: "plan-b", bands: { ...task2, grammar: 7 } }), planId: "plan-b" });
  assert.deepEqual(compareWeeklyCalibration([work, human, ...estimates]), []);
  assert.deepEqual(compareWeeklyCalibration([human, assessment("self")]), []);
});

test("editing an original makes its old revision calibration ineligible", () => {
  const { work, assessment } = fixture();
  const human = assessment("human", { selfBands: { ...task2, grammar: 7 } });
  const newer = { ...work, revisionId: uuid(), baseRevision: work.revisionId, seq: work.seq + 100, createdAt: work.createdAt + 100, payload: { ...work.payload, text: "Revised draft" } };
  assert.deepEqual(compareWeeklyCalibration([newer, human]), []);
  assert.deepEqual(compareWeeklyCalibration([work, newer, human]), [], "historical input may not resurrect a superseded draft");
});

test("deleted or conflicted current work, baseline and estimates never generate a warning", () => {
  for (const flag of ["deleted", "conflict"] as const) {
    const { work, assessment } = fixture();
    const human = assessment(), estimate = assessment("self", { bands: { ...task2, grammar: 7 } });
    for (const bad of [work, human, estimate]) {
      const records = [work, human, estimate].map((r) => r === bad ? { ...r, [flag]: true } : r);
      assert.deepEqual(compareWeeklyCalibration(records), [], `${flag} ${bad.kind}`);
    }
    const deletedHead = { ...estimate, revisionId: uuid(), baseRevision: estimate.revisionId, createdAt: estimate.createdAt + 1, seq: estimate.seq + 1, [flag]: true };
    assert.deepEqual(compareWeeklyCalibration([work, human, estimate, deletedHead]), [], "filtering invalid heads first would restore an obsolete estimate");
  }
});

test("unknown scores and incompatible writing or speaking dimensions are ignored", () => {
  for (const type of ["task1", "task2", "speaking"] as const) {
    const { work, assessment, baseBands } = fixture(type);
    const foreign = type === "task1" ? { taskResponse: 7 } : type === "task2" ? { taskAchievement: 7 } : { coherence: 7 };
    const human = assessment();
    assert.deepEqual(compareWeeklyCalibration([work, human, assessment("self", { bands: { ...baseBands, ...foreign } })]), []);
    assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { selfBands: foreign })]), []);
    assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { bands: { ...baseBands, lexical: null }, selfBands: { lexical: 7 } })]), []);
  }
  const { work, assessment } = fixture();
  for (const invalid of [NaN, Infinity, 9.5, -.5, 6.25, "7"]) {
    assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { selfBands: { grammar: invalid } })]), []);
  }
  assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { selfBands: { grammar: null } })]), []);
});

test("Task 1 comparisons use taskAchievement while Task 2 uses taskResponse", () => {
  for (const type of ["task1", "task2"] as const) {
    const { work, assessment, baseBands } = fixture(type);
    const criterion = type === "task1" ? "taskAchievement" : "taskResponse";
    const result = compareWeeklyCalibration([work, assessment("human", { selfBands: { ...baseBands, [criterion]: 7 } })]);
    assert.equal(result[0]?.taskType, type);
    assert.equal(result[0]?.differences[0].dimension, criterion);
    const otherType = type === "task1" ? "task2" : "task1";
    assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { taskType: otherType, bands: otherType === "task1" ? task1 : task2, selfBands: { grammar: 7 } })]), []);
  }
});

test("newest current source and human records win without averaging unrelated judgments", () => {
  const { work, assessment } = fixture();
  const oldHuman = assessment(), oldSelf = assessment("self", { bands: { ...task2, grammar: 8 } });
  const human = assessment("human", { bands: { ...task2, grammar: 7 } }), self = assessment("self", { bands: { ...task2, grammar: 7.5 } });
  const result = compareWeeklyCalibration([self, oldHuman, oldSelf, work, human]);
  assert.equal(result.length, 1); assert.equal(result[0].baselineId, human.id);
  assert.equal(result[0].differences.find((d) => d.dimension === "grammar")!.delta, .5);
});

test("a mismatched original hash, absent human calibration, or identical estimates produce no alert", () => {
  const { work, assessment } = fixture();
  assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { inputHash: "b".repeat(64), selfBands: { grammar: 7 } })]), []);
  assert.deepEqual(compareWeeklyCalibration([work, assessment("self", { selfBands: { grammar: 7 } })]), []);
  assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { selfBands: task2 })]), []);
});

test("legacy essays cannot be inferred as speaking and only exact protocol sources can anchor a calibration", () => {
  const { work, assessment } = fixture("speaking");
  const inferredEssay = { ...work, kind: "essay" as const, payload: { ...work.payload, taskType: "speaking", text: "Legacy draft" } };
  const human = assessment("human", { selfBands: { ...speaking, fluency: 7 } });
  assert.deepEqual(compareWeeklyCalibration([inferredEssay, human]), []);
  assert.deepEqual(compareWeeklyCalibration([work, assessment("teacher", { selfBands: { ...speaking, fluency: 7 } })]), []);
  assert.deepEqual(compareWeeklyCalibration([work, assessment("human", { machineBands: { pronunciation: 7 }, machineSource: "speech-recognition" })]), []);
});

test("comparison is pure and does not rewrite stored raw assessments", () => {
  const { work, assessment } = fixture();
  const records = [work, assessment("human", { selfBands: { grammar: 7 } })];
  const before = JSON.stringify(records);
  const first = compareWeeklyCalibration(records), second = compareWeeklyCalibration([...records].reverse());
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(first, second);
});
