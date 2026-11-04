import { dayDate } from "./calendar";
import { GATE_TARGETS, SECTION_TARGETS, type LearningPayload, type Revision } from "./protocol";

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

interface PlanPort {
  records(): readonly Revision[];
  save(input: { id: string; kind: "plan"; payload: LearningPayload }): Promise<Revision>;
}

export async function enablePlan(input: PlanInput, port: PlanPort): Promise<Revision> {
  const existing = selectActivePlan(port.records());
  if (existing) return existing;
  return port.save({ id: PLAN_RECORD_ID, kind: "plan", payload: createPlanPayload(input) });
}
