import { materialQualifiedRecords } from './materialSource';
import { dayDate } from './calendar';
import { evaluateFinalGoal, evaluateGate, sectionGaps, type GateId, type Scores } from './goals';
import { missionProgress } from './missionRecords';
import { largestGapSkill } from './planEngine';
import { bundledRules, type PlanRules } from './planData';
import { GATE_TARGETS, type Revision } from './protocol';
import { SKILLS, currentAssessments, latestEffectiveBySkill, scoreView } from './scoresModel';

export function buildProgress(plan: Revision, records: readonly Revision[], today: string, rules: PlanRules = bundledRules) {
  const date = new Date(`${today}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== today) throw new Error('进度日期无效。');
  const assessments = currentAssessments(records, plan.id);
  const latest = assessments.find(record => Object.values(scoreView(record.payload, records).effectiveScores).every(score => score !== null)) ?? null;
  const current = scoreView(latest?.payload ?? {}, records);
  const bySkill = latestEffectiveBySkill(records, plan.id);
  const sectionScores = Object.fromEntries(SKILLS.map(skill => [skill, bySkill[skill]?.score ?? null])) as Scores;
  const gaps = sectionGaps(sectionScores);
  const completed = assessments.some(record => evaluateFinalGoal(record.payload).met);
  const qualifiedRecords = materialQualifiedRecords(records, plan.id);
  const gates = rules.gates.map(rule => {
    const id = rule.id as GateId;
    const day = typeof rule.atMonth === 'number' ? rule.atMonth * 30 : null;
    const dueDate = day === null ? null : dayDate(String(plan.payload.startDate), String(plan.payload.timeZone), day);
    const result = evaluateGate(qualifiedRecords, plan.id, id);
    return { id, day, dueDate, target: GATE_TARGETS[id], met: result.met, required: result.required, recordIds: result.recordIds,
      gaps: sectionGaps(sectionScores, GATE_TARGETS[id]), overallGap: current.effectiveOverall === null ? null : Math.max(0, GATE_TARGETS[id].overall - current.effectiveOverall) };
  });
  const recentDates = Array.from({ length: 28 }, (_, index) => {
    const value = new Date(date); value.setUTCDate(value.getUTCDate() - (27 - index));
    return value.toISOString().slice(0, 10);
  });
  const { actualMinutes, recentDays } = missionProgress(records, plan.id, recentDates);
  return { latest, current, bySkill, sectionScores, gaps, completed, gates, nextGate: completed ? null : gates.find(gate => !gate.met) ?? null,
    overallGap: current.effectiveOverall === null ? null : Math.max(0, rules.goal.targetOverall - current.effectiveOverall),
    recommendedSkill: largestGapSkill(sectionScores), hasScores: Object.values(sectionScores).some(value => value !== null),
    actualMinutes, capacityMinutes: rules.goal.dailyMinutes * rules.goal.durationDays, recentDays };
}
