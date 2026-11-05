import assert from "node:assert/strict";
import test from "node:test";
import { dayDate, templateFor, weekdayOf } from "./calendar";
import { GATE_TARGETS, SECTION_TARGETS, type LearningPayload, type Revision } from "./protocol";
import { bundledRules as rules, bundledInventory, type PlanRules } from "./planData";
import { buildDayPlan, largestGapSkill, nextMonday, selectLatestBaseline, todayInTimeZone, vocabMinutesFor } from "./planEngine";
const plan = { planId: "engine-plan", startDate: "2026-11-09", timeZone: "Asia/Shanghai", studyBudgetMinutes: rules.goal.dailyMinutes, targetBand: GATE_TARGETS.G4.overall, sectionTargets: SECTION_TARGETS };
const baseline = (band: number): LearningPayload => ({ planId: plan.planId, kind: "baseline", source: "human", date: plan.startDate, scores: { listening: band, reading: band, writing: band, speaking: band } });
const onDay = (day: number, scores?: LearningPayload) => buildDayPlan(rules, plan, dayDate(plan.startDate, plan.timeZone, day), scores);

test("all 365 default days use JSON minutes and the existing calendar templates", () => {
  for (let day = 1; day <= rules.goal.durationDays; day++) {
    const value = onDay(day);
    assert.equal(value.day, day); assert.equal(value.state, "active");
    assert.equal(value.weekday, weekdayOf(plan.startDate, plan.timeZone, day));
    assert.equal(value.templateId, templateFor(rules, day));
    assert.equal(value.blocks.reduce((sum, block) => sum + block.minutes, 0), rules.goal.dailyMinutes);
    assert.equal(value.totalMinutes, rules.goal.dailyMinutes);
    if (!["saturday", "sunday"].includes(value.weekday) && ["phase1", "phase2", "phase3"].includes(value.phaseId))
      for (const skill of Object.keys(SECTION_TARGETS)) assert.ok(value.blocks.some((block) => block.skill === skill && block.minutes > 0), `${day}/${skill}`);
  }
});
for (const [band, end] of [[6.5, 60], [6, 90], [5.5, 120], [5, 90]] as const) test(`baseline ${band} derives phase one ending at ${end} without changing later boundaries`, () => {
  const value = onDay(end, baseline(band));
  assert.equal(value.phaseId, "phase1"); assert.equal(value.baselineRouting.phase1EndDay, end);
  assert.equal(onDay(end + 1, baseline(band)).phaseId, "phase2");
  assert.equal(onDay(210, baseline(band)).phaseId, "phase2"); assert.equal(onDay(211, baseline(band)).phaseId, "phase3");
  assert.equal(rules.gates[0].atMonth, 3); assert.equal(rules.phases.find((phase) => phase.id === "phase2")?.endDay, 210);
});
test("the lower baseline route uses its JSON weekday template and requests reassessment", () => {
  const value = onDay(8, baseline(5));
  assert.equal(value.templateId, "baseline55-weekday");
  assert.deepEqual(value.blocks.map((block) => block.minutes), rules.budgetTemplates.find((item) => item.id === "baseline55-weekday")?.blocks.map((block) => block.minutes));
  assert.equal(value.baselineRouting.reassessmentRequired, true); assert.match(value.baselineRouting.notice ?? "", /重新评估/);
});
test("missing and incomplete baselines use the default rule route", () => {
  assert.equal(onDay(8).baselineRouting.phase1EndDay, 90);
  assert.equal(onDay(8, { ...baseline(8), scores: { listening: 8, reading: 8, writing: null, speaking: 8 } }).baselineRouting.phase1EndDay, 90);
});
test("phase four keeps Wednesday Thursday and weekend overrides", () => {
  for (let day = 301; day <= rules.goal.durationDays; day++) {
    const value = onDay(day);
    assert.equal(value.templateId, templateFor(rules, day));
    assert.equal(value.blocks.reduce((sum, block) => sum + block.minutes, 0), rules.goal.dailyMinutes);
  }
});
test("vocabulary minutes follow actual blocks including baseline and weekend zeros", () => {
  for (let day = 1; day <= rules.goal.durationDays; day++) {
    const value = onDay(day);
    assert.equal(vocabMinutesFor(value), value.blocks.find((block) => block.id === "vocabulary")?.minutes ?? 0);
  }
  assert.equal(vocabMinutesFor(onDay(1)), 0); assert.equal(vocabMinutesFor(onDay(6)), 0); assert.equal(vocabMinutesFor(onDay(7)), 0);
  assert.equal(vocabMinutesFor(onDay(8, baseline(5.5))), rules.budgetTemplates.find((item) => item.id === "baseline55-weekday")?.blocks[0].minutes);
});
test("the engine rejects an inconsistent JSON total rather than filling missing minutes", () => {
  const broken: PlanRules = structuredClone(rules); broken.budgetTemplates[0].blocks[0].minutes--;
  assert.throws(() => buildDayPlan(broken, plan, dayDate(plan.startDate, plan.timeZone, 8)), /合计/);
});
test("before and after dates are civil-day boundary states with no generated tasks", () => {
  const before = buildDayPlan(rules, plan, "2026-11-08"), after = buildDayPlan(rules, plan, "2027-11-09");
  assert.equal(before.day, 0); assert.equal(before.state, "before"); assert.equal(before.daysUntilStart, 1); assert.deepEqual(before.blocks, []);
  assert.equal(after.day, 366); assert.equal(after.state, "after"); assert.deepEqual(after.blocks, []);
});
test("date helpers respect the plan timezone and require Monday starts", () => {
  assert.equal(todayInTimeZone(new Date("2026-11-08T17:00:00Z"), "Asia/Shanghai"), "2026-11-09");
  assert.equal(todayInTimeZone(new Date("2026-11-08T17:00:00Z"), "America/New_York"), "2026-11-08");
  assert.equal(nextMonday("2026-11-09", plan.timeZone), "2026-11-09"); assert.equal(nextMonday("2026-11-03", plan.timeZone), "2026-11-09");
  assert.throws(() => buildDayPlan(rules, { ...plan, startDate: "2026-11-03" }, "2026-11-09"), /周一/);
});
test("first fourteen days expose real inventory references and missing requirements", () => {
  const first = onDay(1);
  assert.deepEqual(first.material.externalReferenceIds, bundledInventory.days[0].externalReferenceIds);
  assert.ok(first.blocks.find((block) => block.skill === "listening")?.material?.externalReferences.every((item) => item.skills.includes("listening")));
  assert.ok(first.material.externalReferences.every((item) => item.url.startsWith("https:") && item.formatPracticeUrl));
  assert.deepEqual(onDay(4).material.materialIds, bundledInventory.days[3].materialIds);
  assert.deepEqual(onDay(4).material.missingRequirements, bundledInventory.days[3].missingRequirements);
  assert.equal(onDay(15).material.title, "外部材料"); assert.deepEqual(onDay(15).material.materialIds, []);
});
test("gap ties prefer writing then speaking then listening then reading", () => {
  const tied = { listening: SECTION_TARGETS.listening - 1, reading: SECTION_TARGETS.reading - 1, writing: SECTION_TARGETS.writing - 1, speaking: SECTION_TARGETS.speaking - 1 };
  assert.equal(largestGapSkill(tied), "writing"); assert.equal(largestGapSkill({ ...tied, writing: SECTION_TARGETS.writing }), "speaking");
  assert.equal(largestGapSkill({ ...tied, writing: SECTION_TARGETS.writing, speaking: SECTION_TARGETS.speaking }), "listening");
  const value = buildDayPlan(rules, plan, dayDate(plan.startDate, plan.timeZone, 302), undefined, { scores: { ...tied, listening: 0 } });
  assert.ok(value.blocks.filter((block) => ["timed-section", "weak-skill"].includes(block.id)).every((block) => block.skill === "listening"));
});
test("baseline selection ignores partial conflicts and another plan", () => {
  const record = (id: string, payload: LearningPayload, at: number): Revision => ({ id, kind: "assessment", datasetId: null, planId: plan.planId, revisionId: `${at}0000000-0000-4000-8000-000000000001`, baseRevision: null, seq: at, payload, contentHash: "a".repeat(64), createdAt: at, conflict: false, deleted: false });
  const good = record("complete", baseline(6.5), 1), partial = record("partial", { ...baseline(8), scores: { listening: 8, reading: 8, writing: null, speaking: 8 } }, 2);
  assert.equal(selectLatestBaseline([partial, { ...good, conflict: true, createdAt: 3 }, { ...good, planId: "another", createdAt: 4 }, good], plan.planId)?.id, good.id);
});
