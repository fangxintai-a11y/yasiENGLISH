import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_TARGETS, type Revision } from "./protocol";
import { evaluateFinalGoal, evaluateGate, overallBand, sectionGaps } from "./goals";

type Scores = { listening: number | null; reading: number | null; writing: number | null; speaking: number | null };
const target: Scores = { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 };
function gate(id: string, index: number, scores: Scores = target): Revision {
  return { id, kind: "assessment", datasetId: null, planId: "plan", revisionId: crypto.randomUUID(), baseRevision: null,
    seq: index, payloadVersion: 2, contentHash: "0".repeat(64), createdAt: index, conflict: false, deleted: false,
    payload: { planId: "plan", kind: "gate", gateId: "G3", date: `2027-08-${String(index).padStart(2, "0")}`,
      source: "human", materialId: `paper-${id}`, consecutiveIndex: index, targets: GATE_TARGETS.G3, scores,
      scoreSources: { listening: "rules", reading: "rules", writing: "human", speaking: "human" } } };
}
function official(scores: Scores, source = "official") {
  return { planId: "plan", kind: "official", source, date: "2027-11-03", scores };
}

test("official overall 8 with four scores of 8 does not meet the confirmed section targets", () => {
  const result = evaluateFinalGoal(official({ listening: 8, reading: 8, writing: 8, speaking: 8 }));
  assert.equal(result.overall, 8);
  assert.equal(result.met, false);
  assert.deepEqual(result.gaps, { listening: 0.5, reading: 0.5, writing: 0, speaking: 0 });
});
test("official scores meeting all four confirmed targets complete the goal", () => {
  assert.equal(evaluateFinalGoal(official(target)).met, true);
});
for (const source of ["ai", "human", "self", "rules"]) test(`${source} estimates cannot complete the formal goal`, () => {
  assert.equal(evaluateFinalGoal(official(target, source)).met, false);
});
test("unknown sections remain unknown rather than becoming a score from the date or time", () => {
  const unknown = { ...target, writing: null };
  assert.equal(overallBand(unknown), null);
  assert.equal(sectionGaps(unknown).writing, null);
  assert.equal(evaluateFinalGoal({ ...official(unknown), day: 365 }).met, false);
});
test("G3 passes two consecutive distinct dated papers", () => {
  const one = gate("one", 1), two = gate("two", 2);
  assert.equal(evaluateGate([one, two], "plan", "G3").met, true);
});
test("G3 cannot pass with only one paper", () => {
  assert.equal(evaluateGate([gate("one", 1)], "plan", "G3").met, false);
});
test("G3 does not count two revisions of one record", () => {
  const one = gate("one", 1), two = gate("two", 2);
  assert.equal(evaluateGate([one, { ...two, id: one.id }], "plan", "G3").met, false);
});
test("G3 does not count the same paper twice", () => {
  const one = gate("one", 1), two = gate("two", 2);
  assert.equal(evaluateGate([one, { ...two, payload: { ...two.payload, materialId: one.payload.materialId } }], "plan", "G3").met, false);
});
test("G3 cannot skip an intervening failed paper", () => {
  const one = gate("one", 1), two = gate("two", 2), failed = gate("failed", 1, { ...target, writing: 6 });
  failed.seq = 3; failed.payload.date = "2027-08-03";
  assert.equal(evaluateGate([one, two, failed], "plan", "G3").met, false);
});
test("G3 cannot skip an intervening weekly mock", () => {
  const one = gate("one", 1), two = gate("two", 2), failed = gate("weekly", 3, { ...target, writing: 6 });
  two.payload.date = "2027-08-04";
  failed.payload = { planId: "plan", kind: "weekly-mock", date: "2027-08-03", source: "human", scores: failed.payload.scores };
  assert.equal(evaluateGate([one, failed, two], "plan", "G3").met, false);
});
test("G3 cannot accept AI writing scores", () => {
  const one = gate("one", 1);
  const ai = gate("two", 2);
  ai.payload.scoreSources = { listening: "rules", reading: "rules", writing: "ai", speaking: "human" };
  assert.equal(evaluateGate([one, ai], "plan", "G3").met, false);
});
test("G3 requires different assessment dates", () => {
  const one = gate("one", 1), two = gate("two", 2);
  two.payload.date = one.payload.date;
  assert.equal(evaluateGate([one, two], "plan", "G3").met, false);
});
test("G3 requires an identified paper", () => {
  const one = gate("one", 1), two = gate("two", 2);
  delete two.payload.materialId;
  assert.equal(evaluateGate([one, two], "plan", "G3").met, false);
});
function formalGate() {
  const four = gate("four", 1);
  four.payload = { ...four.payload, gateId: "G4", targets: GATE_TARGETS.G4, source: "official",
    scoreSources: { listening: "official", reading: "official", writing: "official", speaking: "official" } };
  return four;
}
test("G4 passes formal scores at every confirmed target", () => {
  assert.equal(evaluateGate([formalGate()], "plan", "G4").met, true);
});
test("G4 excludes conflict copies", () => {
  assert.equal(evaluateGate([{ ...formalGate(), conflict: true }], "plan", "G4").met, false);
});
test("G4 excludes another plan's assessment", () => {
  assert.equal(evaluateGate([formalGate()], "another-plan", "G4").met, false);
});
test("G4 rejects formal scores of 8 in every section", () => {
  const four = formalGate();
  four.payload.scores = { listening: 8, reading: 8, writing: 8, speaking: 8 };
  assert.equal(evaluateGate([four], "plan", "G4").met, false);
});
test("gate gaps compare to that gate's targets", () => {
  const first = gate("first", 1, { listening: 7, reading: 7, writing: 6, speaking: 6 });
  first.payload = { ...first.payload, gateId: "G1", targets: GATE_TARGETS.G1 };
  assert.deepEqual(evaluateGate([first], "plan", "G1").gaps, { listening: 0, reading: 0, writing: 0, speaking: 0 });
});
