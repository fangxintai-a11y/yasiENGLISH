import { dayDate, templateFor, weekdayOf } from "./calendar";
import { overallBand, type Scores } from "./goals";
import { GATE_TARGETS, SECTION_TARGETS, isObject, type LearningPayload, type Revision } from "./protocol";
import { bundledInventory, bundledMaterials, type PlanExternalReference, type PlanMaterial, type PlanRules } from "./planData";
import { taskGuide, taskTitle, type PhaseId } from "./taskGuides";
export type { PhaseId } from "./taskGuides";
export type Skill = keyof typeof SECTION_TARGETS;
export interface DayMaterials { title: string; status: string; materialIds: string[]; materials: PlanMaterial[]; externalReferenceIds: string[]; externalReferences: PlanExternalReference[]; missingRequirements: string[]; note?: string }
export interface DayBlock { id: string; title: string; skill: Skill | "vocabulary" | null; minutes: number; guide: string; material?: DayMaterials; route?: string }
export interface BaselineRouting { phase1EndDay: number; weekdayTemplate: string; reassessmentRequired: boolean; notice: string | null }
export interface DayPlan { day: number; date: string; weekday: string; phaseId: PhaseId; phaseTitle: string; templateId: string; timeZone: string;
  state: "before" | "active" | "after"; daysUntilStart: number; blocks: DayBlock[]; totalMinutes: 120; material: DayMaterials; baselineRouting: BaselineRouting }
const orderedSkills: Skill[] = ["writing", "speaking", "listening", "reading"];
function civilDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("学习日期无效。");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("学习日期无效。");
  return date;
}
export function todayInTimeZone(now: Date | number, timeZone: string): string {
  const date = new Date(now); if (!Number.isFinite(date.getTime())) throw new Error("当前日期无效。");
  try { const values = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type: string) => values.find((value) => value.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch { throw new Error("计划时区无效。"); }
}
export function nextMonday(date: string, timeZone: string): string {
  const value = civilDate(date); value.setUTCDate(value.getUTCDate() + (8 - value.getUTCDay()) % 7);
  return dayDate(value.toISOString().slice(0, 10), timeZone, 1);
}
function completeBaseline(input?: Revision | LearningPayload): Scores | null {
  if (!input) return null;
  let payload: LearningPayload;
  if ("payload" in input) {
    const revision = input as Revision;
    if (revision.kind !== "assessment" || revision.deleted || revision.conflict) return null;
    payload = revision.payload;
  } else payload = input as LearningPayload;
  if (payload.kind !== "baseline" || !isObject(payload.scores)) return null;
  const scores = {} as Scores;
  for (const skill of orderedSkills) {
    const value = payload.scores[skill];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 9 || !Number.isInteger(value * 2)) return null;
    const source = isObject(payload.scoreSources) ? payload.scoreSources[skill] : payload.source;
    if (["writing", "speaking"].includes(skill) && !["human", "official"].includes(String(source))) return null;
    scores[skill] = value;
  }
  return scores;
}
export function selectLatestBaseline(records: readonly Revision[], planId?: string): Revision | undefined {
  return records.filter((record) => (!planId || record.planId === planId) && completeBaseline(record))
    .sort((a, b) => String(b.payload.date ?? "").localeCompare(String(a.payload.date ?? "")) || b.createdAt - a.createdAt || b.seq - a.seq)[0];
}
export function largestGapSkill(scores: Scores): Skill {
  let selected: Skill = "writing", maximum = -1;
  for (const skill of orderedSkills) {
    const value = scores[skill]; if (value === null || !Number.isFinite(value)) continue;
    const gap = Math.max(0, SECTION_TARGETS[skill] - value);
    if (gap > maximum) { maximum = gap; selected = skill; }
  }
  return selected;
}
function resolveRouting(rules: PlanRules, baseline?: Revision | LearningPayload): BaselineRouting {
  const defaultRoute = rules.baseline.routing.find((route) => route.id === "six");
  if (!defaultRoute) throw new Error("规则缺少默认基线安排。");
  const scores = completeBaseline(baseline), overall = scores ? overallBand(scores) : null;
  const route = overall === null ? defaultRoute : rules.baseline.routing.find((item) => overall >= item.minOverall && overall < item.maxExclusive) ?? defaultRoute;
  const months = route.phase1Months ?? defaultRoute.phase1Months;
  if (!months) throw new Error("规则缺少阶段一的月份安排。");
  return { phase1EndDay: months * 30, weekdayTemplate: route.weekdayTemplate, reassessmentRequired: !!route.foundationMonths,
    notice: route.foundationMonths ? `需重新评估按期 ${GATE_TARGETS.G4.overall.toFixed(1)} 的可行性` : null };
}
function materialsFor(day: number, skill?: string | null): DayMaterials {
  const entry = bundledInventory.days.find((item) => item.day === day);
  const referenceIds: readonly string[] = entry?.externalReferenceIds ?? [];
  const materialIds: readonly string[] = entry?.materialIds ?? [];
  const allReferences = day === 0 ? bundledInventory.externalReferences : bundledInventory.externalReferences.filter((item) => referenceIds.includes(item.id));
  const relevant = (value: string) => !skill || value === skill;
  const materials = bundledMaterials.filter((material) => materialIds.includes(material.id) && relevant(material.skill));
  const references = allReferences.filter((reference) => !skill || reference.skills.some(relevant));
  return { title: entry?.title ?? (day === 0 ? "开始前准备" : "外部材料"), status: entry?.artifactStatus ?? "external", materialIds: materials.map((item) => item.id), materials,
    externalReferenceIds: references.map((item) => item.id), externalReferences: references, missingRequirements: [...(entry?.missingRequirements ?? [])], note: entry?.note };
}
export function buildDayPlan(rules: PlanRules, planPayload: LearningPayload, today: string, latestBaseline?: Revision | LearningPayload, options: { scores?: Scores } = {}): DayPlan {
  const startDate = String(planPayload.startDate ?? ""), timeZone = typeof planPayload.timeZone === "string" ? planPayload.timeZone : rules.calendarPolicy.timeZone;
  const start = dayDate(startDate, timeZone, 1), date = civilDate(today);
  const rawDay = Math.round((date.getTime() - civilDate(start).getTime()) / 86400000) + 1;
  const routing = resolveRouting(rules, latestBaseline);
  const phases = rules.phases.map((phase) => phase.id === "phase1" ? { ...phase, endDay: routing.phase1EndDay, weekdayTemplate: routing.weekdayTemplate } : phase.id === "phase2" ? { ...phase, startDay: routing.phase1EndDay + 1 } : { ...phase });
  const day = rawDay < 1 ? 0 : rawDay > rules.goal.durationDays ? rules.goal.durationDays + 1 : rawDay;
  const phase = phases.find((item) => day >= item.startDay && day <= item.endDay) ?? phases[day === 0 ? 0 : phases.length - 1];
  const common = { day, date: today, weekday: day > 0 && day <= rules.goal.durationDays ? weekdayOf(start, timeZone, day) : new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(date).toLowerCase(),
    phaseId: phase.id as PhaseId, phaseTitle: phase.title, timeZone, daysUntilStart: Math.max(0, 1 - rawDay), totalMinutes: rules.goal.dailyMinutes as 120, material: materialsFor(day), baselineRouting: routing };
  if (day === 0 || day > rules.goal.durationDays) return { ...common, state: day === 0 ? "before" : "after", templateId: day === 0 ? "before-start" : "after-plan", blocks: [] };
  const templateId = templateFor({ ...rules, phases }, day);
  const baselineDay = rules.baseline.days.find((item) => item.day === day);
  const source = baselineDay ? Object.entries(baselineDay.minutes).filter((entry): entry is [string, number] => typeof entry[1] === "number").map(([id, minutes]) => ({ id, minutes })) : rules.budgetTemplates.find((item) => item.id === templateId)?.blocks;
  if (!source) throw new Error("当天缺少规则任务模板。");
  if (source.some((item) => !Number.isFinite(item.minutes) || item.minutes < 0) || source.reduce((sum, item) => sum + item.minutes, 0) !== rules.goal.dailyMinutes) throw new Error("当天任务分钟合计与每日预算不一致。");
  const preferred = largestGapSkill(options.scores ?? completeBaseline(latestBaseline) ?? { listening: null, reading: null, writing: null, speaking: null });
  const blocks = source.map(({ id, minutes }): DayBlock => {
    const skill = id === "vocabulary" ? "vocabulary" : orderedSkills.includes(id as Skill) ? id as Skill : ["timed-section", "weak-skill"].includes(id) ? preferred : null;
    return { id, title: taskTitle(id, skill), skill, minutes, guide: taskGuide(id, common.phaseId), material: materialsFor(day, skill), ...(id === "vocabulary" ? { route: "#/learn" } : {}) };
  });
  return { ...common, state: "active", templateId, blocks };
}
export function vocabMinutesFor(plan: DayPlan): number { return plan.blocks.find((block) => block.id === "vocabulary")?.minutes ?? 0; }
