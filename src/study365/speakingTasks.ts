import { correctionContextBlock } from './correctionContext';
import { materialQualifiedRecords } from './materialSource';
import samples from '../../public/curriculum365/v1/samples.json';
import { MaterialSchema, type Material } from './contentSchemas';
import { bundledInventory, bundledRules } from './planData';
import { buildDayPlan, selectLatestBaseline, todayInTimeZone, type DayBlock } from './planEngine';
import { missionTaskId, selectMission } from './missionRecords';
import { latestAssessment, scoreView } from './scoresModel';
import type { Revision } from './protocol';

export type SpeakingMaterial = Extract<Material, { skill: 'speaking' }>;
export interface SpeakingContext {
  date: string; day: number; taskId: string; correctionId?: string; retestOf?: string; plannedMinutes: number; block: DayBlock | null; defaultPart: 1 | 2 | 3;
}
const materials: SpeakingMaterial[] = samples.materials.filter(item => item.skill === 'speaking').map(item => MaterialSchema.parse(item)).filter((item): item is SpeakingMaterial => item.skill === 'speaking');
export function availableSpeakingMaterials(day: number): SpeakingMaterial[] {
  const ids: readonly string[] = bundledInventory.days.find(item => item.day === day)?.materialIds ?? [];
  return materials.filter(item => ids.includes(item.id));
}
export function resolveSpeakingContext(plan: Revision, records: readonly Revision[], route: { date?: string; day?: number; task?: string; minutes?: number; correctionId?: string; retestOf?: string; work?: string }, now = Date.now()): SpeakingContext {
  const date = route.date ?? todayInTimeZone(now, String(plan.payload.timeZone));
  const scores = scoreView(latestAssessment(records, plan.id)?.payload ?? {}, records).effectiveScores;
  const dayPlan = buildDayPlan(bundledRules, plan.payload, date, selectLatestBaseline(materialQualifiedRecords(records, plan.id), plan.id), { scores });
  if (route.day !== undefined && route.day !== dayPlan.day) throw new Error('口语任务日期与计划日不一致，请从今日任务重新进入。');
  const correctionBlock = correctionContextBlock(plan, records, dayPlan, route, 'speaking');
  const selected = correctionBlock ?? (route.task ? dayPlan.blocks.find(block => missionTaskId(dayPlan.day, block.id) === route.task) : dayPlan.blocks.find(block => block.skill === 'speaking'));
  if (!correctionBlock && route.task && (!selected || selected.skill !== 'speaking' && !['timed-section', 'weak-skill'].includes(selected.id))) throw new Error('这不是当天的口语任务，请从今日任务重新进入。');
  if (!selected) return { date, day: dayPlan.day, taskId: '', plannedMinutes: 0, block: null, defaultPart: 1 };
  const taskId = missionTaskId(dayPlan.day, selected.id);
  const saved = selectMission(records, plan.id, date, taskId);
  const plannedMinutes = Number(saved?.payload.plannedMinutes ?? selected.minutes);
  return { date, day: dayPlan.day, taskId, plannedMinutes, correctionId: route.correctionId, retestOf: route.retestOf, block: correctionBlock ? { ...selected, minutes: plannedMinutes } : { ...selected, skill: 'speaking', minutes: plannedMinutes }, defaultPart: (availableSpeakingMaterials(dayPlan.day)[0]?.part ?? 1) as 1 | 2 | 3 };
}
