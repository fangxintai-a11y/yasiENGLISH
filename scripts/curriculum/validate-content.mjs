#!/usr/bin/env node
/** Validate actual R0 artifacts and inventory without downloading models or contacting APIs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ContentCatalogSchema } from "../../src/study365/contentSchemas.ts";
import { SECTION_TARGETS, GATE_TARGETS, LEARNING_KINDS, LEARNING_PROTOCOL, SCORE_SOURCES, hashPayload, isIdentifier, isRevisionId, validatePayload } from "../../src/study365/protocol.ts";

// Resolve P1's extensionless TypeScript imports with tsx; use npm run check:curriculum.
const { overallBand, sectionGaps } = await tsImport("../../src/study365/goals.ts", import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contentRoot = path.join(root, "public/curriculum365/v1");
const json = async (relative) => JSON.parse(await readFile(path.join(contentRoot, relative), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export class RuleValidationError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = "RuleValidationError"; this.path = path; }
}
const fail = (at, message) => { throw new RuleValidationError(at, message); };
const equal = (actual, expected, at) => {
  try { assert.deepEqual(actual, expected); } catch { fail(at, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`); }
};
const object = (value, at) => { if (!value || typeof value !== "object" || Array.isArray(value)) fail(at, "object is required"); return value; };
const nonempty = (value, at) => { if (typeof value !== "string" || !value.trim()) fail(at, "nonempty text is required"); };
const skillNames = ["listening", "reading", "writing", "speaking"];
const allocations = [
  ["phase1-weekday", "weekday", ["vocabulary", "listening", "reading", "writing", "speaking"], [35, 25, 25, 20, 15]],
  ["phase2-weekday", "weekday", ["vocabulary", "listening", "reading", "writing", "speaking"], [20, 20, 20, 35, 25]],
  ["phase3-weekday", "weekday", ["vocabulary", "listening", "reading", "writing", "speaking"], [15, 20, 20, 40, 25]],
  ["phase4-weekday", "weekday", ["vocabulary", "timed-section", "review", "weak-skill"], [10, 60, 30, 20]],
  ["baseline55-weekday", "baseline-adjustment", ["vocabulary", "listening", "reading", "writing", "speaking"], [40, 20, 25, 20, 15]],
  ["saturday-listening-reading", "saturday", ["listening", "reading", "review"], [30, 60, 30]],
  ["sunday-writing-speaking-calibration", "sunday", ["writing", "speaking", "review", "human-calibration-handoff"], [60, 15, 30, 15]],
  ["phase4-thursday-mock-completion", "split-mock-completion", ["writing", "speaking", "review", "correction-log"], [60, 15, 30, 15]],
];

export function checkGoal(rules) {
  const goal = object(rules.goal, "goal");
  for (const field of ["minimumSection", "studyBudgetsMinutes", "milestoneBands", "recommendedSections", "recommendedSectionsAreRequired"])
    if (Object.hasOwn(goal, field)) fail(`goal.${field}`, "obsolete goal field is forbidden");
  const fields = new Set(["statement", "durationDays", "examType", "targetOverall", "sectionTargets", "dailyMinutes", "completionSource", "completionRequiresAllSectionTargets"]);
  for (const field of Object.keys(goal)) if (!fields.has(field)) fail(`goal.${field}`, "unsupported goal field");
  equal(goal.durationDays, 365, "goal.durationDays");
  equal(goal.targetOverall, 8, "goal.targetOverall");
  equal(goal.dailyMinutes, 120, "goal.dailyMinutes");
  equal(goal.examType, "academic", "goal.examType");
  equal(goal.completionSource, "official", "goal.completionSource");
  equal(goal.completionRequiresAllSectionTargets, true, "goal.completionRequiresAllSectionTargets");
  object(goal.sectionTargets, "goal.sectionTargets");
  for (const skill of skillNames) equal(goal.sectionTargets[skill], SECTION_TARGETS[skill], `goal.sectionTargets.${skill}`);
  equal(Object.keys(goal.sectionTargets).sort(), [...skillNames].sort(), "goal.sectionTargets");
}

export function checkGates(rules) {
  if (!Array.isArray(rules.gates)) fail("gates", "four dated gates are required");
  equal(rules.gates.length, 4, "gates.length");
  const months = [3, 7, 10, "exam"];
  rules.gates.forEach((gate, index) => {
    const at = `gates[${index}]`, id = `G${index + 1}`;
    object(gate, at); equal(gate.id, id, `${at}.id`); equal(gate.atMonth, months[index], `${at}.atMonth`);
    equal(gate.consecutive, id === "G3" ? 2 : 1, `${at}.consecutive`);
    object(gate.targets, `${at}.targets`);
    for (const key of ["overall", ...skillNames]) equal(gate.targets[key], GATE_TARGETS[id][key], `${at}.targets.${key}`);
    equal(Object.keys(gate.targets).sort(), ["overall", ...skillNames].sort(), `${at}.targets`);
    equal(gate.writingSpeakingSources, id === "G4" ? ["official"] : ["human", "official"], `${at}.writingSpeakingSources`);
    nonempty(gate.onMiss, `${at}.onMiss`);
  });
  const weekly = object(rules.weeklyCalibration, "weeklyCalibration");
  for (const [key, value] of Object.entries({ weeks: 52, day: "sunday", items: ["task2-essay", "speaking-recording"], source: "human", deviationAlert: 0.5,
    comparison: "same-work-revision-and-rubric", compareSources: ["self", "ai", "rules"], backupRecordingsAfterCalibration: true }))
    equal(weekly[key], value, `weeklyCalibration.${key}`);
  nonempty(weekly.onDeviation, "weeklyCalibration.onDeviation");
  if (Object.hasOwn(rules, "readinessPolicy")) fail("readinessPolicy", "dated gates and weekly human calibration replace the old readiness window");
}

export function checkBaseline(rules) {
  const baseline = object(rules.baseline, "baseline");
  if (!Array.isArray(baseline.days)) fail("baseline.days", "D1-D3 assessments are required");
  equal(baseline.days.length, 3, "baseline.days.length");
  const daySkills = [["listening", "reading"], ["writing"], ["speaking"]];
  const dayMinutes = [{ listening: 30, reading: 60, review: 30 }, { writing: 60, review: 60 }, { speaking: 15, "app-setup": 15, review: 90 }];
  baseline.days.forEach((day, index) => {
    const at = `baseline.days[${index}]`;
    equal(day.day, index + 1, `${at}.day`); equal(day.skills, daySkills[index], `${at}.skills`);
    equal(day.source, "official-external-practice", `${at}.source`);
    const minutes = object(day.minutes, `${at}.minutes`);
    for (const [key, value] of Object.entries(dayMinutes[index])) equal(minutes[key], value, `${at}.minutes.${key}`);
    equal(Object.keys(minutes).sort(), Object.keys(dayMinutes[index]).sort(), `${at}.minutes`);
    equal(Object.values(minutes).reduce((a, b) => a + b, 0), 120, `${at}.minutes`);
  });
  equal(baseline.trialDays, [4, 5], "baseline.trialDays");
  equal(baseline.trialTemplate, "phase1-weekday", "baseline.trialTemplate");
  equal(baseline.requiredSkills, skillNames, "baseline.requiredSkills");
  equal(baseline.writingSpeakingScoreSources, ["human", "official"], "baseline.writingSpeakingScoreSources");
  equal(baseline.unassessedScore, null, "baseline.unassessedScore");
  equal(baseline.materialLevelPolicy, "baseline-evidence", "baseline.materialLevelPolicy");
  equal(baseline.materialLevels, ["foundation", "intermediate", "advanced", "ielts-academic"], "baseline.materialLevels");
  equal(baseline.testPapersStoredInRepository, false, "baseline.testPapersStoredInRepository");
  const routes = [
    { id: "at-least-6-5", minOverall: 6.5, maxExclusive: 9.5, phase1Months: 2, weekdayTemplate: "phase1-weekday" },
    { id: "six", minOverall: 6, maxExclusive: 6.5, phase1Months: 3, weekdayTemplate: "phase1-weekday" },
    { id: "five-5", minOverall: 5.5, maxExclusive: 6, phase1Months: 4, weekdayTemplate: "baseline55-weekday" },
    { id: "five-or-below", minOverall: 0, maxExclusive: 5.5, foundationMonths: [2, 3], weekdayTemplate: "baseline55-weekday" },
  ];
  if (!Array.isArray(baseline.routing)) fail("baseline.routing", "baseline routing required");
  equal(baseline.routing.length, routes.length, "baseline.routing.length");
  routes.forEach((expected, index) => {
    object(baseline.routing[index], `baseline.routing[${index}]`);
    for (const [key, value] of Object.entries(expected)) equal(baseline.routing[index][key], value, `baseline.routing[${index}].${key}`);
  });
  const adaptation = object(baseline.adaptation, "baseline.adaptation");
  equal(adaptation.durationDays, 365, "baseline.adaptation.durationDays");
  equal(adaptation.gateDatesStayFixed, true, "baseline.adaptation.gateDatesStayFixed");
  equal(adaptation.calendarAloneCannotSetMaterialLevel, true, "baseline.adaptation.calendarAloneCannotSetMaterialLevel");
  nonempty(adaptation.onDelay, "baseline.adaptation.onDelay");
  const vocabulary = object(rules.vocabularyPolicy, "vocabularyPolicy");
  for (const [key, value] of Object.entries({ startMonth: 1, cefr: "C1", awl: true, ieltsTasksStartMonth: 1, foundationSupportDoesNotPostponeIeltsTasks: true }))
    equal(vocabulary[key], value, `vocabularyPolicy.${key}`);
}

export function checkBudgetTemplates(rules) {
  if (!Array.isArray(rules.budgetTemplates)) fail("budgetTemplates", "120-minute templates are required");
  equal(rules.budgetTemplates.length, allocations.length, "budgetTemplates.length");
  allocations.forEach(([id, kind, names, minutes], index) => {
    const template = object(rules.budgetTemplates[index], `budgetTemplates[${index}]`), at = `budgetTemplates[${index}]`;
    equal(template.id, id, `${at}.id`); equal(template.kind, kind, `${at}.kind`); equal(template.budgetMinutes, 120, `${at}.budgetMinutes`);
    if (!Array.isArray(template.blocks)) fail(`${at}.blocks`, "named time blocks required");
    equal(template.blocks.length, names.length, `${at}.blocks.length`);
    template.blocks.forEach((block, blockIndex) => {
      equal(block.id, names[blockIndex], `${at}.blocks[${blockIndex}].id`);
      equal(block.minutes, minutes[blockIndex], `${at}.blocks[${blockIndex}].minutes`);
    });
    equal(template.blocks.reduce((sum, block) => sum + block.minutes, 0), 120, `${at}.budgetMinutes`);
  });
  const schedule = object(rules.weeklySchedule, "weeklySchedule");
  equal(schedule.weekdayDays, ["monday", "tuesday", "wednesday", "thursday", "friday"], "weeklySchedule.weekdayDays");
  equal(schedule.saturdayTemplate, "saturday-listening-reading", "weeklySchedule.saturdayTemplate");
  equal(schedule.sundayTemplate, "sunday-writing-speaking-calibration", "weeklySchedule.sundayTemplate");
  equal(schedule.phase4WeekdayOverrides, { wednesday: "saturday-listening-reading", thursday: "phase4-thursday-mock-completion" }, "weeklySchedule.phase4WeekdayOverrides");
  const policy = object(rules.budgetPolicy, "budgetPolicy");
  for (const field of ["fullMockMinimumBudgetMinutes", "smallerBudgetMockMode", "listeningReadingWritingConsecutive", "ordinaryExtension"])
    if (Object.hasOwn(policy, field)) fail(`budgetPolicy.${field}`, "obsolete multi-budget or consecutive-mock policy");
  for (const [key, value] of Object.entries({ dailyMinutes: 120, plannedMinutesAreActualMinutes: false, shrinkExamSectionsToFitBudget: false,
    mockMode: "cross-day-section-assessments", claimConsecutiveFullMock: false, teacherMarkingTimeOutsideLearnerBudget: true, weeklyCalibrationHandoffMinutes: 15 }))
    equal(policy[key], value, `budgetPolicy.${key}`);
  if (!Array.isArray(rules.phase4MockCycles)) fail("phase4MockCycles", "two explicitly split cycles required");
  equal(rules.phase4MockCycles.length, 2, "phase4MockCycles.length");
  const cycles = [{ id: "midweek", startDay: "wednesday", completionDay: "thursday", startTemplate: "saturday-listening-reading", completionTemplate: "phase4-thursday-mock-completion" },
    { id: "weekend", startDay: "saturday", completionDay: "sunday", startTemplate: "saturday-listening-reading", completionTemplate: "sunday-writing-speaking-calibration" }];
  cycles.forEach((cycle, index) => {
    const at = `phase4MockCycles[${index}]`, current = object(rules.phase4MockCycles[index], at);
    for (const [key, value] of Object.entries({ ...cycle, mode: "split-across-days", consecutiveFullExam: false })) equal(current[key], value, `${at}.${key}`);
  });
}

export function evaluateRuleScore(goal, source, sections) {
  checkGoal({ goal });
  if (!SCORE_SOURCES.includes(source)) fail("score.source", "known score source required");
  object(sections, "score.sections");
  for (const skill of skillNames) {
    const score = sections[skill];
    if (score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 9 || !Number.isInteger(score * 2)))
      fail(`score.sections.${skill}`, "score must be null or a finite band from 0 to 9 in half-point increments");
  }
  for (const key of Object.keys(sections)) if (!skillNames.includes(key)) fail(`score.sections.${key}`, "unknown section");
  const overall = overallBand(sections);
  const gaps = sectionGaps(sections, goal.sectionTargets);
  const numericTargetMet = overall !== null && overall >= goal.targetOverall && Object.values(gaps).every((gap) => gap === 0);
  return { overall, gaps, numericTargetMet, finalGoalMet: source === "official" && numericTargetMet };
}

export function checkRules(rules) {
  object(rules, "rules"); equal(rules.schemaVersion, 1, "schemaVersion");
  object(rules.calendar, "calendar");
  equal(rules.calendar, { dayOneWeekday: "any", dayIndexing: "plan-timezone-calendar-days", requireMondayStart: false, weeklyCycle: "seven-plan-days" }, "calendar");
  checkGoal(rules); checkGates(rules); checkBaseline(rules); checkBudgetTemplates(rules);
  const boundaries = [["baseline", 1, 7], ["phase1", 8, 90], ["phase2", 91, 210], ["phase3", 211, 300], ["phase4", 301, 365]];
  if (!Array.isArray(rules.phases)) fail("phases", "365-day phases required");
  equal(rules.phases.length, boundaries.length, "phases.length");
  boundaries.forEach(([id, startDay, endDay], index) => {
    const at = `phases[${index}]`, phase = object(rules.phases[index], at);
    for (const [key, value] of Object.entries({ id, startDay, endDay })) equal(phase[key], value, `${at}.${key}`);
    if (index > 0) { equal(phase.weekdayTemplate, `${id}-weekday`, `${at}.weekdayTemplate`); equal(phase.ieltsSkills, skillNames, `${at}.ieltsSkills`); }
  });
  const calendar = object(rules.calendarPolicy, "calendarPolicy");
  for (const key of ["awardScoreFromDate", "awardScoreFromMinutes", "awardScoreFromStreak", "advanceMaterialLevelFromDate"]) equal(calendar[key], false, `calendarPolicy.${key}`);
  equal(calendar.timeZone, "Asia/Shanghai", "calendarPolicy.timeZone");
  equal(calendar.calendarDayIsSeparateFromUnitAndMaterialLevel, true, "calendarPolicy.calendarDayIsSeparateFromUnitAndMaterialLevel");
  if (!Array.isArray(rules.scoreExamples) || !rules.scoreExamples.length) fail("scoreExamples", "score boundary examples required");
  rules.scoreExamples.forEach((example, index) => {
    const at = `scoreExamples[${index}]`; object(example.sections, `${at}.sections`);
    for (const skill of skillNames) {
      const score = example.sections[skill];
      if (score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 9 || !Number.isInteger(score * 2))) fail(`${at}.sections.${skill}`, "score must be null or a band in half-point increments");
    }
    if (!["self", "rules", "ai", "human", "official"].includes(example.source)) fail(`${at}.source`, "known score source required");
    const expected = evaluateRuleScore(rules.goal, example.source, example.sections);
    object(example.expected, `${at}.expected`);
    for (const [key, value] of Object.entries(expected)) equal(example.expected[key], value, `${at}.expected.${key}`);
  });
  return true;
}


export async function checkRecordReferences(fixture, catalog) {
  const byId = new Map(catalog.materials.map((material) => [material.id, material]));
  equal(fixture.fixtureVersion, 2, "fixture.fixtureVersion");
  equal(fixture.purpose, "synthetic-wire-examples-not-user-learning-records", "fixture.purpose");
  const legacyKinds = ["plan", "mission", "attempt", "essay", "speaking", "feedback", "assessment"];
  equal([...new Set(fixture.records.map((item) => item.request.kind))].sort(), [...legacyKinds].sort(), "fixture.records.kinds");
  if (legacyKinds.some(kind => !LEARNING_KINDS.includes(kind))) fail("fixture.records.kinds", "all R0 kinds must remain supported");
  const seen = { recordId: new Set(), revisionId: new Set(), mutationId: new Set() };
  for (const [index, item] of fixture.records.entries()) {
    const at = `fixture.records[${index}]`, { request } = item, payload = request.payload;
    if (!isIdentifier(item.recordId)) fail(`${at}.recordId`, "valid record identifier required");
    equal(request.schemaVersion, LEARNING_PROTOCOL, `${at}.request.schemaVersion`);
    for (const key of ["revisionId", "mutationId"]) if (!isRevisionId(request[key])) fail(`${at}.request.${key}`, "valid revision identifier required");
    for (const key of Object.keys(seen)) {
      const value = key === "recordId" ? item.recordId : request[key];
      if (seen[key].has(value)) fail(`${at}.${key}`, "duplicate fixture identifier");
      seen[key].add(value);
    }
    try { validatePayload(request.kind, payload, !!request.deleted); }
    catch (error) { fail(`${at}.request.payload`, error.message); }
    equal(await hashPayload(request.kind, payload), item.expectedContentHash, `${at}.expectedContentHash`);
    if (request.kind === "plan") equal(payload.curriculumVersion, catalog.version, `${at}.request.payload.curriculumVersion`);
    if (!["attempt", "essay", "speaking"].includes(request.kind)) continue;
    const material = byId.get(payload.contentId);
    if (!material) fail(`${at}.request.payload.contentId`, `missing catalog material ${payload.contentId}`);
    equal(payload.contentVersion, material.version, `${at}.request.payload.contentVersion`);
    if (request.kind === "attempt") {
      equal(payload.skill, material.skill, `${at}.request.payload.skill`);
      equal(payload.answers.length, material.questions.length, `${at}.request.payload.answers.length`);
      if (!Array.isArray(payload.questionResults)) fail(`${at}.request.payload.questionResults`, "per-question correctness and error causes required");
      equal(payload.questionResults.length, material.questions.length, `${at}.request.payload.questionResults.length`);
      let correct = 0;
      material.questions.forEach((question, qIndex) => {
        const answer = payload.answers[qIndex];
        const accepted = question.answer.accepted.some((value) => answer !== null && value.trim().toLowerCase() === String(answer).trim().toLowerCase());
        const resultIndex = payload.questionResults.findIndex((value) => value.questionId === question.id);
        if (resultIndex < 0) fail(`${at}.request.payload.questionResults`, `missing result for ${question.id}`);
        equal(payload.questionResults[resultIndex].correct, accepted, `${at}.request.payload.questionResults[${resultIndex}].correct`);
        if (accepted) correct++;
      });
      equal(payload.correct, correct, `${at}.request.payload.correct`);
      equal(payload.score, correct, `${at}.request.payload.score`);
      equal(payload.total, material.questions.length, `${at}.request.payload.total`);
    }
    if (request.kind === "essay") {
      equal(payload.prompt, material.prompt, `${at}.request.payload.prompt`);
      equal(payload.taskType, material.taskType, `${at}.request.payload.taskType`);
    }
    if (request.kind === "speaking") equal(payload.prompt, material.prompts.join(" "), `${at}.request.payload.prompt`);
  }
  const works = new Map(fixture.records.filter((item) => ["essay", "speaking"].includes(item.request.kind)).map((item) => [item.request.revisionId, item]));
  fixture.records.forEach((item, index) => {
    const payload = item.request.payload;
    if (!payload.workRevisionId) return;
    const at = `fixture.records[${index}].request.payload`, work = works.get(payload.workRevisionId);
    if (!work) fail(`${at}.workRevisionId`, "missing original work revision");
    equal(payload.workId, work.recordId, `${at}.workId`);
    equal(payload.inputHash, work.expectedContentHash, `${at}.inputHash`);
    if (work.request.kind === "essay") equal(payload.taskType, work.request.payload.taskType, `${at}.taskType`);
  });
  return true;
}

export function checkInventory(inventory, catalog) {
  equal(inventory.schemaVersion, 1, "inventory.schemaVersion");
  equal(inventory.coverageDays, 14, "inventory.coverageDays");
  equal(inventory.days.map((item) => item.day), Array.from({ length: 14 }, (_, index) => index + 1), "inventory.days");
  const byId = new Map(catalog.materials.map((material) => [material.id, material]));
  equal(inventory.sampleAvailability.length, catalog.materials.length, "inventory.sampleAvailability.length");
  const available = new Map();
  inventory.sampleAvailability.forEach((entry, index) => {
    const at = `inventory.sampleAvailability[${index}]`, material = byId.get(entry.materialId);
    if (!material || available.has(entry.materialId)) fail(`${at}.materialId`, "missing or duplicate catalog material");
    equal(entry.version, material.version, `${at}.version`);
    equal(entry.reviewStatus, material.source.reviewStatus, `${at}.reviewStatus`);
    equal(entry.artifactStatus, "sample_ready", `${at}.artifactStatus`);
    available.set(entry.materialId, entry);
  });
  if (!Array.isArray(inventory.externalReferences)) fail("inventory.externalReferences", "external baseline references required");
  const references = new Map();
  inventory.externalReferences.forEach((reference, index) => {
    const at = `inventory.externalReferences[${index}]`;
    nonempty(reference.id, `${at}.id`);
    if (references.has(reference.id)) fail(`${at}.id`, "duplicate external reference");
    let url;
    try { url = new URL(reference.url); } catch { fail(`${at}.url`, "valid external URL required"); }
    if (url.protocol !== "https:" || !["shop.cambridge.org", "takeielts.britishcouncil.org", "ielts.org", "www.ielts.org"].includes(url.hostname)) fail(`${at}.url`, "official HTTPS practice or lawful-access source required");
    equal(reference.rights, "external-link-only", `${at}.rights`);
    equal(reference.availability, "external_required", `${at}.availability`);
    equal(reference.selectionStatus, "pending-lawful-access-and-unseen-check", `${at}.selectionStatus`);
    equal(reference.completionStatus, "not-started", `${at}.completionStatus`);
    for (const field of ["provider", "resourceTitle", "resourceLocator", "accessRequirement", "verifiedOn"]) nonempty(reference[field], `${at}.${field}`);
    if (!Array.isArray(reference.skills) || !reference.skills.length || reference.skills.some((skill) => !skillNames.includes(skill))) fail(`${at}.skills`, "baseline skills required");
    references.set(reference.id, reference);
  });
  const practice = new Set();
  inventory.days.forEach((day, index) => {
    const at = `inventory.days[${index}]`;
    if (!["baseline", "practice", "checkpoint"].includes(day.pool)) fail(`${at}.pool`, "known material pool required");
    if (!["sample_ready", "partial_ready", "external_required", "planned"].includes(day.artifactStatus)) fail(`${at}.artifactStatus`, "honest material availability required");
    if (!Array.isArray(day.materialIds)) fail(`${at}.materialIds`, "material IDs required");
    if (!Array.isArray(day.externalReferenceIds)) fail(`${at}.externalReferenceIds`, "external reference IDs required");
    if (["partial_ready", "external_required", "planned"].includes(day.artifactStatus)
      && (!Array.isArray(day.missingRequirements) || !day.missingRequirements.length)) fail(`${at}.missingRequirements`, "unfinished requirements must be explicit");
    if (day.artifactStatus === "sample_ready" && day.missingRequirements?.length) fail(`${at}.artifactStatus`, "a day with missing requirements is only partially ready");
    if (["sample_ready", "partial_ready"].includes(day.artifactStatus) && !day.materialIds.length) fail(`${at}.materialIds`, "ready artifacts must exist");
    if (["planned", "external_required"].includes(day.artifactStatus)) equal(day.materialIds.length, 0, `${at}.materialIds.length`);
    if (day.artifactStatus === "planned") equal(day.externalReferenceIds.length, 0, `${at}.externalReferenceIds.length`);
    if (day.artifactStatus === "external_required" && !day.externalReferenceIds.length) fail(`${at}.externalReferenceIds`, "external material is still required");
    for (const id of day.materialIds) {
      if (!available.has(id)) fail(`${at}.materialIds`, `missing catalog material ${id}`);
      equal(byId.get(id).isCheckpoint, day.pool === "checkpoint", `${at}.materialIds`);
      if (day.pool === "practice") practice.add(id);
    }
    for (const id of day.externalReferenceIds) if (!references.has(id)) fail(`${at}.externalReferenceIds`, `missing external reference ${id}`);
    if (index < 3) {
      equal(day.pool, "baseline", `${at}.pool`);
      equal(day.artifactStatus, "external_required", `${at}.artifactStatus`);
      const expected = [["listening", "reading"], ["writing"], ["speaking"]][index];
      equal(day.plannedSkills, expected, `${at}.plannedSkills`);
      equal([...new Set(day.externalReferenceIds.flatMap((id) => references.get(id).skills))].sort(), [...expected].sort(), `${at}.externalReferenceIds`);
    } else {
      const weekday = day.day % 7;
      equal(day.plannedSkills, weekday === 6 ? ["listening", "reading"] : weekday === 0 ? ["writing", "speaking"] : skillNames, `${at}.plannedSkills`);
      if (day.pool === "checkpoint" && weekday !== 0) fail(`${at}.pool`, "checkpoint must be on Sunday");
    }
  });
  for (const [index, day] of inventory.days.entries()) if (day.pool === "checkpoint")
    for (const id of day.materialIds) if (practice.has(id)) fail(`inventory.days[${index}].materialIds`, "checkpoint material cannot be reused from practice");
  equal(inventory.days.filter((day) => day.pool === "checkpoint").map((day) => day.day), [7, 14], "inventory.checkpointDays");
  equal(inventory.releaseMinimum, { listeningIncludingTwoReserves: 16, readingIncludingTwoReserves: 16, sentenceGroups: 14, outputThemes: 14 }, "inventory.releaseMinimum");
  if (!Array.isArray(inventory.reserves)) fail("inventory.reserves", "two unfilled reserve slots required");
  equal(inventory.reserves.length, 2, "inventory.reserves.length");
  inventory.reserves.forEach((reserve, index) => {
    equal(reserve.artifactStatus, "planned", `inventory.reserves[${index}].artifactStatus`);
    equal(reserve.plannedSkills, ["listening", "reading"], `inventory.reserves[${index}].plannedSkills`);
  });
  return true;
}

export function checkMaterialCoverage(catalog) {
  equal([...new Set(catalog.materials.map((item) => item.skill))].sort(), [...skillNames].sort(), "catalog.materials.skills");
  catalog.materials.forEach((material, index) => {
    const at = `catalog.materials[${index}]`;
    if (!material.type.startsWith("ielts-")) fail(`${at}.type`, "IELTS task type required from the first month");
  });
  if (!catalog.materials.some((material) => material.vocabulary.cefr === "C1")) fail("catalog.materials.vocabulary.cefr", "first-month pool must include C1 resources");
  if (!catalog.materials.some((material) => material.vocabulary.awl)) fail("catalog.materials.vocabulary.awl", "first-month pool must include AWL resources");
  equal([...new Set(catalog.materials.filter((material) => material.skill === "writing").map((material) => material.taskType))].sort(), ["task1", "task2"], "catalog.materials.writingTasks");
  equal([...new Set(catalog.materials.filter((material) => material.skill === "speaking").map((material) => material.part))].sort(), [1, 2, 3], "catalog.materials.speakingParts");
  return true;
}

export function mp3Info(bytes, sourceDuration) {
  assert.ok(bytes.length > 0 && bytes.length <= 3 * 1024 * 1024, "MP3必须小于等于3 MB。");
  let offset = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    assert.ok(bytes.length >= 10, 'ID3头不完整。');
    const sizeBytes = [...bytes.subarray(6, 10)];
    assert.ok(sizeBytes.every((value) => value < 128), 'ID3大小无效。');
    offset = 10 + sizeBytes.reduce((n, value) => n * 128 + value, 0) + (bytes[5] & 16 ? 10 : 0);
    assert.ok(offset < bytes.length, 'ID3超出文件。');
  }
  let frames = 0, metadataFrames = 0, signalFrames = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset === 128 && bytes.toString('ascii', offset, offset + 3) === 'TAG') { offset += 128; break; }
    assert.ok(offset + 4 <= bytes.length, 'MP3帧头不完整。');
    const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2], d = bytes[offset + 3];
    assert.ok(a === 255 && (b & 224) === 224 && ((b >> 3) & 3) === 2 && ((b >> 1) & 3) === 1, '必须为MPEG-2 Layer III帧。');
    assert.equal((c >> 2) & 3, 1, 'MP3必须为24 kHz。');
    assert.equal(d >> 6, 3, 'MP3必须为单声道。');
    const side = offset + 4 + (b & 1 ? 0 : 2);
    const bitrate = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][(c >> 4) & 15];
    const metadataFrame = frames + metadataFrames === 0 && ['Info', 'Xing'].includes(bytes.toString('ascii', side + 9, side + 13));
    // The seek metadata needs a larger first frame; speech frames remain 48k CBR.
    assert.ok(bitrate && (metadataFrame || bitrate === 48), 'MP3必须为48 kbps CBR。');
    const length = Math.floor(72 * bitrate * 1000 / 24000) + ((c >> 1) & 1);
    assert.ok(offset + length <= bytes.length, 'MP3帧不完整。');
    // MPEG-2 mono side-info: 8 reservoir bits, 1 private bit, then
    // 12 part2_3_length bits. Zero allocation throughout is a silent placeholder.
    const allocated = ((bytes[side + 1] & 127) << 5) | (bytes[side + 2] >> 3);
    if (!metadataFrame && allocated > 0) signalFrames++;
    if (metadataFrame) metadataFrames++; else frames++;
    offset += length;
  }
  assert.ok(frames > 0 && signalFrames > 0, 'MP3不能是静音占位。');
  const durationSeconds = frames * 576 / 24000;
  if (sourceDuration !== undefined) assert.ok(Number.isFinite(sourceDuration) && Math.abs(durationSeconds - sourceDuration) < 0.1, 'MP3与源时长相差必须小于0.1秒。');
  return { durationSeconds, rate: 24000, channels: 1, bitrateKbps: 48, frames, metadataFrames, signalFrames };
}

export async function checkAudio(catalog) {
  const provenance = await json("audio/provenance.json");
  const material = catalog.materials.find((item) => item.skill === "listening");
  assert.ok(material);
  const bytes = await readFile(path.join(contentRoot, material.audio.path));
  const info = mp3Info(bytes, provenance.durationSeconds);
  assert.equal(provenance.sha256, digest(bytes));
  assert.equal(provenance.audioPath, path.basename(material.audio.path));
  assert.equal(material.audio.durationSeconds, provenance.durationSeconds);
  assert.equal(provenance.sourceWav.durationSeconds, provenance.durationSeconds);
  equal(provenance.encoding.bitrateKbps, 48, 'audio.encoding.bitrateKbps');
  equal(provenance.encoding.channels, 1, 'audio.encoding.channels');
  equal(provenance.encoding.sampleRate, 24000, 'audio.encoding.sampleRate');
  assert.equal(provenance.transcriptSha256, digest(material.transcript));
  assert.equal(provenance.verification.humanListeningReview, "pending");
  assert.equal(provenance.generatorPath, "scripts/curriculum/generate-r0-audio.py");
  assert.equal(provenance.generatorSha256, digest(await readFile(path.join(root, provenance.generatorPath))));
  assert.equal(provenance.segments.length, material.segments.length);
  let previousEnd = 0;
  provenance.segments.forEach((segment, index) => {
    assert.equal(segment.id, material.segments[index].id);
    assert.equal(segment.text, material.segments[index].text);
    assert.ok(segment.startSeconds >= previousEnd && segment.endSeconds > segment.startSeconds && segment.endSeconds <= provenance.durationSeconds);
    assert.ok(Math.abs(segment.startSeconds - segment.startFrame / info.rate) < 0.00001);
    assert.ok(Math.abs(segment.endSeconds - segment.endFrame / info.rate) < 0.00001);
    previousEnd = segment.endSeconds;
  });
  for (const question of material.questions) {
    const segment = provenance.segments.find((item) => item.text === question.evidence.quote);
    assert.ok(segment, question.id);
    assert.deepEqual([question.evidence.startSeconds, question.evidence.endSeconds], [segment.startSeconds, segment.endSeconds]);
  }
  return { seconds: info.durationSeconds, bytes: bytes.length };
}

export async function validateContent() {
  const catalog = ContentCatalogSchema.parse(await json("samples.json"));
  checkMaterialCoverage(catalog);
  const inventory = await json("inventory.json");
  const rules = await json("plan-rules.json");






  checkRules(rules);
  checkInventory(inventory, catalog);
  await checkRecordReferences(JSON.parse(await readFile(path.join(root, "src/study365/fixtures/r0-records.json"), "utf8")), catalog);
  const audio = await checkAudio(catalog);
  const reviewedMaterials = catalog.materials.filter((item) => item.source.reviewStatus === "reviewed").length;
  const warnings = [];
  if (reviewedMaterials < catalog.materials.length) warnings.push("Independent teacher review is incomplete; sample format validation is not examiner calibration.");
  if (inventory.days.some((item) => item.artifactStatus !== "sample_ready")) warnings.push("The 14-day inventory is not complete: external lawful access, missing daily materials and reviews remain.");
  warnings.push("Human listening review remains pending; synthetic speech is not evidence of real-exam accents or interaction.");
  const summary = { success: true, executableSamples: catalog.materials.length, reviewedMaterials,
    readySamplesBySkill: Object.fromEntries(skillNames.map((skill) => [skill, catalog.materials.filter((material) => material.skill === skill).length])),
    inventoryDays: inventory.days.length, sampleDays: inventory.days.filter((item) => item.artifactStatus === "sample_ready").length,
    partialReadyDays: inventory.days.filter((item) => item.artifactStatus === "partial_ready").length,
    externalRequiredDays: inventory.days.filter((item) => item.artifactStatus === "external_required").length,
    plannedDays: inventory.days.filter((item) => item.artifactStatus === "planned").length,
    unfilledReserveSlots: inventory.reserves.filter((item) => item.artifactStatus === "planned").length,
    inventoryComplete: inventory.days.every((item) => item.artifactStatus === "sample_ready"), warnings,
    releaseReadiness: "not-certified-by-r0-sample-validator",
    budgetTemplates: rules.budgetTemplates.length, scoreExamples: rules.scoreExamples.length, audio };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await validateContent();
