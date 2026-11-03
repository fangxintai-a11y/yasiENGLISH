import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkRules, evaluateRuleScore } from "./validate-content.mjs";
import { evaluateFinalGoal } from "../../src/study365/goals.ts";

const standard = JSON.parse(await readFile(new URL("../../public/curriculum365/v1/plan-rules.json", import.meta.url), "utf8"));

function rejectedAt(change, expectedPath) {
  const rules = structuredClone(standard);
  change(rules);
  assert.throws(() => checkRules(rules), (error) => error.path === expectedPath && error.message.startsWith(`${expectedPath}:`));
}

test("standard Band 8 rules use 120 minutes and all four required section targets", () => {
  assert.doesNotThrow(() => checkRules(structuredClone(standard)));
});
test("adding the obsolete minimumSection is rejected at goal.minimumSection", () => {
  rejectedAt((rules) => { rules.goal.minimumSection = 6.5; }, "goal.minimumSection");
});
test("150 minutes is rejected specifically at goal.dailyMinutes", () => {
  rejectedAt((rules) => { rules.goal.dailyMinutes = 150; }, "goal.dailyMinutes");
});
test("missing writing target is rejected specifically at goal.sectionTargets.writing", () => {
  rejectedAt((rules) => { delete rules.goal.sectionTargets.writing; }, "goal.sectionTargets.writing");
});
test("G3 requires two consecutive assessments", () => {
  rejectedAt((rules) => { rules.gates[2].consecutive = 1; }, "gates[2].consecutive");
});
test("weekly human calibration cannot be removed", () => {
  rejectedAt((rules) => { delete rules.weeklyCalibration; }, "weeklyCalibration");
});
test("baseline days 1 through 3 cannot omit speaking", () => {
  rejectedAt((rules) => { rules.baseline.days[2].skills = []; }, "baseline.days[2].skills");
});
test("baseline day one preserves the full reading limit", () => {
  rejectedAt((rules) => { rules.baseline.days[0].minutes.reading = 59; }, "baseline.days[0].minutes.reading");
});
test("baseline day two preserves the full writing limit", () => {
  rejectedAt((rules) => { rules.baseline.days[1].minutes.writing = 59; }, "baseline.days[1].minutes.writing");
});
test("phase one cannot give writing zero minutes", () => {
  rejectedAt((rules) => { rules.budgetTemplates[0].blocks[3].minutes = 0; }, "budgetTemplates[0].blocks[3].minutes");
});
test("IELTS writing starts in phase one", () => {
  rejectedAt((rules) => { rules.phases[1].ieltsSkills = ["listening", "reading", "speaking"]; }, "phases[1].ieltsSkills");
});
test("a continuous full mock cannot be claimed for split sections", () => {
  rejectedAt((rules) => { rules.phase4MockCycles[0].consecutiveFullExam = true; }, "phase4MockCycles[0].consecutiveFullExam");
});
test("baseline 5.5 vocabulary adjustment still has an exact 120 minute allocation", () => {
  rejectedAt((rules) => { rules.budgetTemplates[4].blocks[0].minutes = 45; }, "budgetTemplates[4].blocks[0].minutes");
});
test("four eights cannot be marked complete by the rule examples", () => {
  rejectedAt((rules) => { rules.scoreExamples[1].expected.finalGoalMet = true; }, "scoreExamples[1].expected.finalGoalMet");
});

for (const [name, value] of [["out-of-range", 10], ["non-finite", Infinity], ["quarter-point", 8.25], ["string", "8.5"], ["missing", undefined]]) test(`exported scoring rejects a ${name} section at its own path`, () => {
  const scores = { listening: value, reading: 8.5, writing: 7.5, speaking: 7.5 };
  assert.throws(() => evaluateRuleScore(standard.goal, "official", scores), (error) => error.path === "score.sections.listening");
});
test("exported scoring rejects an unknown score source", () => {
  assert.throws(() => evaluateRuleScore(standard.goal, "teacher", standard.scoreExamples[2].sections), (error) => error.path === "score.source");
});

for (const example of standard.scoreExamples) test(`rule score example agrees with P1 evaluateFinalGoal: ${example.id}`, () => {
  const result = evaluateRuleScore(standard.goal, example.source, example.sections);
  const p1 = evaluateFinalGoal({ kind: "official", planId: "rules-example", date: "2026-11-03", source: example.source, scores: example.sections });
  assert.equal(result.overall, p1.overall);
  assert.deepEqual(result.gaps, p1.gaps);
  assert.equal(result.finalGoalMet, p1.met);
});
