import { dayDate } from "./calendar";
import { bundledRules } from "./planData";
import { todayInTimeZone } from "./planEngine";
import { GATE_TARGETS, SECTION_TARGETS, validatePayload, type LearningPayload, type Revision } from "./protocol";

/** The repository already isolates this ID by account (or by the guest scope). */
export const PLAN_RECORD_ID = "ielts-365-plan";

interface PlanInput {
  startDate: string;
  timeZone: string;
  rules: { version: string; goal: { dailyMinutes: number } };
}

export function createPlanPayload({ startDate, timeZone, rules }: PlanInput): LearningPayload {
  dayDate(startDate, timeZone, 1);
  return {
    datasetId: null, startDate, timeZone, curriculumVersion: rules.version,
    studyBudgetMinutes: rules.goal.dailyMinutes, targetBand: GATE_TARGETS.G4.overall,
    sectionTargets: { ...SECTION_TARGETS }, enabled: true, title: "365天 8.0 计划",
  };
}

const newestFirst = (a: Revision, b: Revision) => b.createdAt - a.createdAt || b.seq - a.seq || b.revisionId.localeCompare(a.revisionId);

/** Keep one active view without deleting any older plan or rewriting its history. */
export function selectActivePlan(records: readonly Revision[]): Revision | null {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort(newestFirst)) if (!heads.has(record.id)) heads.set(record.id, record);
  return [...heads.values()].find((record) => record.kind === "plan" && !record.deleted && !record.conflict && record.payload.enabled === true) ?? null;
}

export interface PlanPort {
  records(): readonly Revision[];
  save(input: { id: string; kind: "plan"; payload: LearningPayload; baseRevision?: string | null }): Promise<Revision>;
}

export async function enablePlan(input: PlanInput, port: PlanPort): Promise<Revision> {
  const existing = selectActivePlan(port.records());
  if (existing) return existing;
  return port.save({ id: PLAN_RECORD_ID, kind: "plan", payload: createPlanPayload(input) });
}

function independentPractice(record: Revision, planId: string): boolean {
  const payload = record.payload, date = payload.date;
  if (payload.planId !== planId || payload.day !== undefined || payload.retestOf !== undefined || payload.correctionId !== undefined
    || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const civil = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(civil.getTime()) || civil.toISOString().slice(0, 10) !== date) return false;
  const skill = record.kind === "essay" ? "writing" : record.kind === "speaking" ? "speaking"
    : record.kind === "attempt" && ["listening", "reading"].includes(String(payload.skill)) ? payload.skill : null;
  return !!skill && (payload.skill === undefined || payload.skill === skill) && payload.taskId === `practice-${skill}-${date}`;
}
function hasLearningWork(records: readonly Revision[], planId: string): boolean {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort(newestFirst)) if (!heads.has(record.id)) heads.set(record.id, record);
  return [...heads.values()].some(record => {
    if (record.kind === "plan" || record.planId !== planId || record.deleted || record.conflict) return false;
    if (independentPractice(record, planId)) return false;
    return record.kind !== "mission" || record.payload.status !== "not_started" || Number(record.payload.actualMinutes ?? 0) > 0;
  });
}

/** Advance only an untouched future plan, keeping its identity and revision history. */
export async function startPlanToday(port: PlanPort, now = Date.now()): Promise<Revision> {
  const records = port.records(), existing = selectActivePlan(records);
  if (!existing) throw new Error("请先开启365天计划。");
  const timeZone = String(existing.payload.timeZone ?? bundledRules.calendarPolicy.timeZone);
  const today = todayInTimeZone(now, timeZone);
  const startDate = dayDate(String(existing.payload.startDate), timeZone, 1);
  if (startDate === today) return existing;
  if (startDate < today) throw new Error("计划已经开始，保留原开始日期与学习进度。");

  if (hasLearningWork(records, existing.id)) throw new Error("这份计划已有学习记录，不能前移开始日期；原有学习记录已保留。");
  const currentRecords = port.records(), current = selectActivePlan(currentRecords);
  if (current?.id !== existing.id || current.revisionId !== existing.revisionId)
    throw new Error("计划已经变化，请刷新后重试。");
  if (hasLearningWork(currentRecords, existing.id)) throw new Error("这份计划已有学习记录，不能前移开始日期；原有学习记录已保留。");
  const payload = { ...existing.payload, startDate: today, curriculumVersion: bundledRules.version };
  validatePayload("plan", { ...payload, planId: existing.id });
  return port.save({ id: existing.id, kind: "plan", payload, baseRevision: existing.revisionId });
}
