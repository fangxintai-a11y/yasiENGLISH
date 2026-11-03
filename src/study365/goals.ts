import { GATE_TARGETS, SECTION_TARGETS, isObject, validatePayload, type LearningPayload, type Revision } from "./protocol";

type Skill = keyof typeof SECTION_TARGETS;
export type Scores = Record<Skill, number | null>;
export type GateId = keyof typeof GATE_TARGETS;
const skills = Object.keys(SECTION_TARGETS) as Skill[];

function readScores(value: unknown): Scores {
  const result = {} as Scores;
  for (const skill of skills) {
    const score = isObject(value) ? value[skill] : null;
    result[skill] = typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 9 && Number.isInteger(score * 2) ? score : null;
  }
  return result;
}

export function overallBand(scores: Scores): number | null {
  const values = skills.map((skill) => scores[skill]);
  if (values.some((value) => value === null)) return null;
  if (values.some((value) => !Number.isFinite(value) || Number(value) < 0 || Number(value) > 9 || !Number.isInteger(Number(value) * 2)))
    throw new Error("单项分数必须为0至9的半分档。");
  return Math.round(values.reduce<number>((sum, value) => sum + Number(value), 0) / 2) / 2;
}

export function sectionGaps(scores: Scores, targets: Record<Skill, number> = SECTION_TARGETS): Scores {
  return Object.fromEntries(skills.map((skill) => [skill, scores[skill] === null ? null : Math.max(0, targets[skill] - Number(scores[skill]))])) as Scores;
}

/** Score/source comparison only; does not verify an exam certificate or store a derived flag. */
export function evaluateFinalGoal(payload: LearningPayload) {
  const scores = readScores(payload.scores);
  const overall = overallBand(scores);
  let eligible = payload.kind === "official" || payload.kind === "gate" && payload.gateId === "G4";
  try { validatePayload("assessment", payload); } catch { eligible = false; }
  return { overall, gaps: sectionGaps(scores), met: eligible && payload.source === "official" && overall !== null && overall >= 8
    && skills.every((skill) => scores[skill] !== null && Number(scores[skill]) >= SECTION_TARGETS[skill]) };
}

function passedGate(record: Revision, gateId: GateId): boolean {
  try { validatePayload("assessment", record.payload); } catch { return false; }
  if (gateId === "G4") return evaluateFinalGoal(record.payload).met;
  const scores = readScores(record.payload.scores);
  const overall = overallBand(scores);
  const target = GATE_TARGETS[gateId];
  return overall !== null && overall >= target.overall && skills.every((skill) => scores[skill] !== null && Number(scores[skill]) >= target[skill]);
}

/** Evaluates latest current records, never conflict copies, historical revisions or best-score mixtures. */
export function evaluateGate(records: Revision[], planId: string, gateId: GateId) {
  const heads = new Map<string, Revision>();
  for (const record of records) {
    if (record.kind !== "assessment" || record.conflict || record.planId !== planId) continue;
    const previous = heads.get(record.id);
    if (!previous || record.seq > previous.seq) heads.set(record.id, record);
  }
  // A weekly mock is part of the actual exam sequence: it cannot be hidden
  // between two selected successes. To count for G3 it needs a dated gate record
  // carrying the required per-skill evidence, not just an overall estimate.
  const matching = [...heads.values()].filter((record) => !record.deleted && ((record.payload.kind === "gate" && record.payload.gateId === gateId)
      || (gateId === "G3" && record.payload.kind === "weekly-mock")))
    .sort((a, b) => String(a.payload.date ?? "").localeCompare(String(b.payload.date ?? "")) || a.seq - b.seq);
  const required = gateId === "G3" ? 2 : 1;
  const selected = matching.slice(-required);
  let met = selected.length === required && selected.every((record) => record.payload.kind === "gate" && record.payload.gateId === gateId && passedGate(record, gateId));
  if (gateId === "G3" && selected.length === 2) {
    met = met && selected[0].payload.consecutiveIndex === 1 && selected[1].payload.consecutiveIndex === 2
      && selected[0].payload.date !== selected[1].payload.date
      && typeof selected[0].payload.materialId === "string" && typeof selected[1].payload.materialId === "string"
      && selected[0].payload.materialId !== selected[1].payload.materialId;
  }
  const latest = selected.at(-1);
  const scores = readScores(latest?.payload.scores);
  return { gateId, met, required, recordIds: selected.map((record) => record.id), overall: overallBand(scores), gaps: sectionGaps(scores, GATE_TARGETS[gateId]) };
}
