import assert from "node:assert/strict";
import test from "node:test";
import { dayDate } from "./calendar";
import { resolvePracticeContext } from "./listeningReadingTasks";
import { materialQualifiedRecords } from "./materialSource";
import { buildDayPlan, selectLatestBaseline } from "./planEngine";
import { bundledRules } from "./planData";
import { GATE_TARGETS, SECTION_TARGETS, validatePayload, type LearningPayload, type Revision } from "./protocol";
import { latestAssessment, scoreView } from "./scoresModel";

const plan: Revision = {
  id: "task-plan", kind: "plan", planId: "task-plan", datasetId: null,
  revisionId: "12345678-1234-4234-8234-123456789012", baseRevision: null,
  seq: 1, createdAt: 1, contentHash: "a".repeat(64), deleted: false, conflict: false,
  payload: { planId: "task-plan", startDate: "2026-11-09", timeZone: "Asia/Shanghai", studyBudgetMinutes: bundledRules.goal.dailyMinutes, targetBand: GATE_TARGETS.G4.overall, sectionTargets: SECTION_TARGETS },
};
function record(id: string, kind: "attempt" | "assessment", payload: LearningPayload): Revision {
  validatePayload(kind, payload);
  return { ...plan, id, kind, payload, revisionId: crypto.randomUUID(), createdAt: 2 };
}
function today(records: Revision[], date: string) {
  return buildDayPlan(bundledRules, plan.payload, date,
    selectLatestBaseline(materialQualifiedRecords(records, plan.id), plan.id),
    { scores: scoreView(latestAssessment(records, plan.id)?.payload ?? {}, records).effectiveScores });
}
function externalAttempt(source: "official" | "cambridge" | "unofficial", skill: "listening" | "reading", date: string) {
  return record(`${source}-${skill}`, "attempt", { planId: plan.id, date, skill,
    contentId: `${source}-${skill}-paper`, sourceRef: "same-sitting-paper", materialSource: source, scope: "full",
    score: 30, correct: 30, total: 40, answers: [] });
}
for (const source of ["official", "cambridge"] as const) {
  test(`${source} same-sitting evidence keeps the listening route aligned with today's phase-four weak-skill block`, () => {
    const date = dayDate(String(plan.payload.startDate), String(plan.payload.timeZone), 302);
    const assessment = record("qualified-scores", "assessment", {
      planId: plan.id, date, kind: "weekly-mock", source: "human", materialId: "same-sitting-paper",
      scores: { listening: 5.5, reading: 8.5, writing: 7.5, speaking: 7.5 },
    });
    const records = [assessment, externalAttempt(source, "listening", date), externalAttempt(source, "reading", date)];
    const dayPlan = today(records, date), block = dayPlan.blocks.find(block => block.skill === "listening");
    assert.ok(block);
    const context = resolvePracticeContext(plan, records, { date, day: 302 }, "listening");
    assert.equal(context.block?.id, block.id);
    assert.equal(context.plannedMinutes, block.minutes);
  });
}
test("an unofficial baseline cannot give the reading route a different phase or minute budget from today", () => {
  const baselineDate = String(plan.payload.startDate), date = dayDate(baselineDate, String(plan.payload.timeZone), 92);
  const baseline = record("reference-baseline", "assessment", {
    planId: plan.id, date: baselineDate, kind: "baseline", source: "human", materialId: "same-sitting-paper",
    scores: { listening: 5.5, reading: 5.5, writing: 5.5, speaking: 5.5 },
  });
  const records = [baseline, externalAttempt("unofficial", "listening", baselineDate), externalAttempt("unofficial", "reading", baselineDate)];
  const dayPlan = today(records, date), block = dayPlan.blocks.find(block => block.skill === "reading");
  assert.ok(block);
  const context = resolvePracticeContext(plan, records, { date, day: 92, task: `d92-${block.id}` }, "reading");
  assert.equal(context.plannedMinutes, block.minutes);
});
