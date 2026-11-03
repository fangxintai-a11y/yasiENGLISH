import { isObject, validatePayload, type Revision } from "./protocol";

export const CALIBRATION_DIMENSION_LABELS: Record<string, string> = {
  taskAchievement: "任务完成", taskResponse: "任务回应", coherence: "连贯与衔接", lexical: "词汇", grammar: "语法", fluency: "流利与连贯", pronunciation: "发音",
};
type TaskType = "task1" | "task2" | "speaking";
type EstimateSource = "self" | "ai" | "rules";
const dimensions: Record<TaskType, readonly string[]> = {
  task1: ["taskAchievement", "coherence", "lexical", "grammar"],
  task2: ["taskResponse", "coherence", "lexical", "grammar"],
  speaking: ["fluency", "lexical", "grammar", "pronunciation"],
};
type Bands = Record<string, number | null>;
interface Candidate { record: Revision; work: Revision; taskType: TaskType; weekIndex: number; bands: Bands }

export interface CalibrationComparison {
  planId: string;
  weekIndex: number;
  workId: string;
  workRevisionId: string;
  taskType: TaskType;
  prompt: string;
  baselineId: string;
  source: EstimateSource;
  differences: { dimension: string; baseline: number; estimate: number; delta: number; needsCalibration: boolean }[];
}

const newer = (a: Revision, b: Revision) => a.createdAt - b.createdAt || a.seq - b.seq || a.revisionId.localeCompare(b.revisionId);

/** Fail closed if a caller accidentally includes history alongside the current heads. */
function currentHeads(records: readonly Revision[]): Revision[] {
  const groups = new Map<string, Revision[]>();
  for (const record of records) {
    const values = groups.get(record.id) ?? [];
    values.push(record); groups.set(record.id, values);
  }
  return [...groups.values()].map((values) => {
    const superseded = new Set(values.map((r) => r.baseRevision).filter(Boolean));
    const tips = values.filter((r) => !superseded.has(r.revisionId));
    return (tips.length ? tips : values).reduce((a, b) => newer(a, b) > 0 ? a : b);
  }).filter((r) => !r.deleted && !r.conflict);
}

function readBands(value: unknown, taskType: TaskType, complete = false): Bands | null {
  const expected = dimensions[taskType];
  if (!isObject(value) || !Object.keys(value).length || Object.keys(value).some((key) => !expected.includes(key))) return null;
  if (complete && (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value)))) return null;
  if (Object.values(value).some((v) => v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 9 || !Number.isInteger(v * 2)))) return null;
  return value as Bands;
}

function readCandidate(record: Revision, works: ReadonlyMap<string, Revision>): Candidate | null {
  const payload = record.payload;
  if (record.kind !== "assessment" || payload.kind !== "weekly-calibration" || !record.planId || (payload.planId !== undefined && payload.planId !== record.planId)) return null;
  try { validatePayload("assessment", { ...payload, planId: record.planId }); } catch { return null; }
  const work = works.get(String(payload.workRevisionId));
  if (!work || work.planId !== record.planId || (payload.workId !== undefined && payload.workId !== work.id)
    || (work.payload.planId !== undefined && work.payload.planId !== work.planId)
    || (payload.inputHash !== undefined && payload.inputHash !== work.contentHash)) return null;
  if (work.kind === "essay" && !["task1", "task2"].includes(String(work.payload.taskType))) return null;
  const taskType = work.kind === "speaking" ? "speaking" : work.payload.taskType;
  if (!["task1", "task2", "speaking"].includes(String(taskType)) || (taskType === "speaking" ? payload.taskType !== undefined : payload.taskType !== taskType)) return null;
  const bands = readBands(payload.bands, taskType as TaskType, true);
  if (!bands) return null;
  return { record, work, taskType: taskType as TaskType, weekIndex: Number(payload.weekIndex), bands };
}

/**
 * Input is the account's current heads, never the revision history. Only a valid
 * human/official calibration of the exact current original can anchor a result.
 * A result contains all known dimension deltas and at least one >= 0.5 warning.
 */
export function compareWeeklyCalibration(heads: readonly Revision[]): CalibrationComparison[] {
  const records = currentHeads(heads);
  const works = new Map(records.filter((r) => r.kind === "essay" || r.kind === "speaking").map((r) => [r.revisionId, r]));
  const groups = new Map<string, Candidate[]>();
  for (const record of records) {
    const candidate = readCandidate(record, works);
    if (!candidate) continue;
    const key = JSON.stringify([record.planId, candidate.weekIndex, candidate.work.revisionId]);
    const values = groups.get(key) ?? [];
    values.push(candidate); groups.set(key, values);
  }
  const result: CalibrationComparison[] = [];
  for (const values of groups.values()) {
    const humans = values.filter((c) => ["human", "official"].includes(String(c.record.payload.source)) && Object.values(c.bands).every((value) => value !== null));
    if (!humans.length) continue;
    const baseline = humans.reduce((a, b) => newer(a.record, b.record) > 0 ? a : b);
    const estimates = new Map<EstimateSource, { record: Revision; bands: Bands }>();
    const put = (source: EstimateSource, value: unknown, candidate: Candidate) => {
      const bands = readBands(value, candidate.taskType);
      if (!bands) return;
      const previous = estimates.get(source);
      if (!previous || newer(candidate.record, previous.record) > 0) estimates.set(source, { record: candidate.record, bands });
    };
    for (const candidate of values) {
      const { payload } = candidate.record;
      if (["self", "ai", "rules"].includes(String(payload.source))) put(payload.source as EstimateSource, candidate.bands, candidate);
      // Sidecars are estimates of this same original, never human evidence.
      if (payload.selfBands !== undefined) put("self", payload.selfBands, candidate);
      if (["ai", "rules"].includes(String(payload.machineSource))) put(payload.machineSource as EstimateSource, payload.machineBands, candidate);
    }
    for (const source of ["self", "ai", "rules"] as const) {
      const estimate = estimates.get(source);
      if (!estimate) continue;
      const differences = dimensions[baseline.taskType].flatMap((dimension) => {
        const value = estimate.bands[dimension], human = baseline.bands[dimension];
        return typeof value === "number" && typeof human === "number" ? [{ dimension, baseline: human, estimate: value, delta: value - human, needsCalibration: Math.abs(value - human) >= .5 }] : [];
      });
      if (!differences.some((d) => d.needsCalibration)) continue;
      result.push({ planId: baseline.record.planId!, weekIndex: baseline.weekIndex, workId: baseline.work.id,
        workRevisionId: baseline.work.revisionId, taskType: baseline.taskType, prompt: String(baseline.work.payload.prompt ?? ""),
        baselineId: baseline.record.id, source, differences });
    }
  }
  return result.sort((a, b) => b.weekIndex - a.weekIndex || a.planId.localeCompare(b.planId) || a.workId.localeCompare(b.workId) || a.source.localeCompare(b.source));
}
