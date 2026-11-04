import { materialQualifiedRecords } from './materialSource';
import { dayDate } from './calendar';
import { evaluateFinalGoal, evaluateGate, sectionGaps, type GateId, type Scores } from './goals';
import { dayCompletion, totalActualMinutes } from './missionRecords';
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
  const completed = currentAssessments(records, plan.id).some(record => evaluateFinalGoal(record.payload).met);
  const gates = rules.gates.map(rule => {
    const id = rule.id as GateId;
    const day = typeof rule.atMonth === 'number' ? rule.atMonth * 30 : null;
    const dueDate = day === null ? null : dayDate(String(plan.payload.startDate), String(plan.payload.timeZone), day);
    const result = evaluateGate(materialQualifiedRecords(records, plan.id), plan.id, id);
    return { id, day, dueDate, target: GATE_TARGETS[id], met: result.met, required: result.required, recordIds: result.recordIds,
      gaps: sectionGaps(sectionScores, GATE_TARGETS[id]), overallGap: current.effectiveOverall === null ? null : Math.max(0, GATE_TARGETS[id].overall - current.effectiveOverall) };
  });
  const recentDays = Array.from({ length: 28 }, (_, index) => {
    const value = new Date(date); value.setUTCDate(value.getUTCDate() - (27 - index));
    const civilDate = value.toISOString().slice(0, 10);
    return { date: civilDate, ...dayCompletion(records, plan.id, civilDate) };
  });
  return { latest, current, bySkill, sectionScores, gaps, completed, gates, nextGate: completed ? null : gates.find(gate => !gate.met) ?? null,
    overallGap: current.effectiveOverall === null ? null : Math.max(0, rules.goal.targetOverall - current.effectiveOverall),
    recommendedSkill: largestGapSkill(sectionScores), hasScores: Object.values(sectionScores).some(value => value !== null),
    actualMinutes: totalActualMinutes(records, plan.id), capacityMinutes: rules.goal.dailyMinutes * rules.goal.durationDays, recentDays };
}
