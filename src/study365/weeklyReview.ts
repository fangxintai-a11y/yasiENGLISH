import {
  ADJUSTMENT_RULES,
  CALIBRATION_CORRECTION_CAUSES,
  calibrationNeedsReview,
  causeNeedsFocus,
  questionTypeNeedsFocus,
} from "./adjustmentRules";
import {
  compareWeeklyCalibration,
  type CalibrationComparison,
} from "./calibration";
import {
  civilDayDistance,
  correctionOriginal,
  type CorrectionItem,
  type CorrectionPayload,
} from "./correctionModel";
import { correctionAction } from "./correctionRules";
import type { Scores } from "./goals";
import type { LocalMaterial } from "./localBankSchema";
import { officialTypeCalibration } from "./listeningReadingSchedule";
import { largestGapSkill } from "./planEngine";
import {
  ERROR_CAUSES,
  SECTION_TARGETS,
  isObject,
  validatePayload,
  type AdjustmentAction,
  type LearningPayload,
  type Revision,
} from "./protocol";
import { recentReadingStatistics } from "./readingReview";
import {
  SKILLS,
  SKILL_LABELS,
  latestEffectiveBySkill,
  type Skill,
} from "./scoresModel";
import { calibrationWeekIndex } from "./writingCalibration";

export interface AdjustmentSuggestion {
  id: string;
  skill: Skill;
  questionType?: string;
  dimension?: string;
  reason: string;
  evidence: {
    recordIds: string[];
    metric: string;
    value: number;
    threshold: number;
  };
  action: AdjustmentAction;
}
export interface WeeklyReviewInput {
  plan: Revision;
  records: readonly Revision[];
  bank: readonly LocalMaterial[];
  date: string;
  /** Answer-review overlays are for practice statistics, never score qualification. */
  statisticsRecords?: readonly Revision[];
  officialCalibration?: ReturnType<typeof officialTypeCalibration>;
}
export interface WeeklySkillStatistics {
  skill: Skill;
  since: string;
  types: {
    type: string;
    correct: number;
    total: number;
    accuracy: number;
    recordIds: string[];
  }[];
  causes: { errorCause: string; count: number; recordIds: string[] }[];
}
export interface AcceptedPreferences {
  questionTypes: Record<Skill, string[]>;
  errorCauses: Record<Skill, string[]>;
  recordIds: string[];
}
const emptyPreferences = (): AcceptedPreferences => ({
  questionTypes: { listening: [], reading: [], writing: [], speaking: [] },
  errorCauses: { listening: [], reading: [], writing: [], speaking: [] },
  recordIds: [],
});
const validDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const newer = (a: Revision, b: Revision) =>
  a.seq - b.seq ||
  a.createdAt - b.createdAt ||
  a.revisionId.localeCompare(b.revisionId);
function heads(records: readonly Revision[], planId: string): Revision[] {
  const groups = new Map<string, Revision[]>();
  for (const record of records) {
    if (
      record.planId !== planId ||
      (record.payload.planId !== undefined &&
        record.payload.planId !== planId) ||
      record.conflict
    )
      continue;
    groups.set(record.id, [...(groups.get(record.id) ?? []), record]);
  }
  return [...groups.values()]
    .map((values) => {
      const superseded = new Set(
          values.map((value) => value.baseRevision).filter(Boolean),
        ),
        tips = values.filter((value) => !superseded.has(value.revisionId));
      return (tips.length ? tips : values).reduce((a, b) =>
        newer(a, b) > 0 ? a : b,
      );
    })
    .filter((record) => !record.deleted);
}
const items = (record: Revision): CorrectionItem[] =>
  record.kind === "correction" && Array.isArray(record.payload.items)
    ? (record.payload.items.filter(isObject) as unknown as CorrectionItem[])
    : [];
function validCorrection(record: Revision) {
  try {
    validatePayload("correction", record.payload);
    return record.kind === "correction";
  } catch {
    return false;
  }
}
const exactMaterial = (record: Revision, bank: readonly LocalMaterial[]) =>
  bank.find(
    (material) =>
      material.id === record.payload.contentId &&
      material.version === record.payload.contentVersion &&
      material.contentHash === record.payload.contentHash &&
      material.skill === record.payload.skill,
  );
const dated = (record: Revision, since: string, until: string) =>
  validDate(record.payload.date) &&
  record.payload.date >= since &&
  record.payload.date <= until;
const unique = (values: string[]) => [...new Set(values)];
function retestFor(
  correction: Revision,
  original: Revision | null,
  records: readonly Revision[],
  until: string,
) {
  if (!original) return null;
  return (
    records
      .filter(
        (record) =>
          !record.deleted &&
          !record.conflict &&
          record.planId === correction.planId &&
          record.payload.planId === correction.planId &&
          record.kind === original.kind &&
          record.payload.correctionId === correction.id &&
          record.payload.retestOf === original.revisionId &&
          validDate(record.payload.date) &&
          record.payload.date <= until,
      )
      .sort(
        (a, b) =>
          String(b.payload.date).localeCompare(String(a.payload.date)) ||
          newer(b, a),
      )[0] ?? null
  );
}
function lineage(
  original: Revision,
  records: readonly Revision[],
): string | null {
  let current = original;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current.revisionId)) return null;
    visited.add(current.revisionId);
    if (current.payload.retestOf === undefined) return current.revisionId;
    const parent = records.find(
      (record) =>
        record.revisionId === current.payload.retestOf &&
        record.planId === original.planId &&
        !record.deleted &&
        !record.conflict &&
        record.kind === original.kind,
    );
    if (
      !parent ||
      (original.kind === "attempt" &&
        parent.payload.skill !== original.payload.skill)
    )
      return null;
    const parentCorrection = records.find(
      (record) =>
        record.id === current.payload.correctionId &&
        record.kind === "correction" &&
        record.planId === original.planId &&
        !record.deleted &&
        !record.conflict,
    );
    if (
      !parentCorrection ||
      correctionOriginal(parentCorrection, records)?.revisionId !==
        parent.revisionId
    )
      return null;
    current = parent;
  }
}
function retestEvents(
  corrections: readonly Revision[],
  records: readonly Revision[],
  bank: readonly LocalMaterial[],
  until: string,
) {
  const available = heads(records, String(corrections[0]?.planId ?? ""));
  const groups = new Map<
    string,
    {
      skill: Skill;
      questionType?: string;
      dimension?: string;
      errorCause: string;
      events: {
        correctionId: string;
        retestId: string;
        date: string;
        status: "retested-pass" | "retested-fail";
        seq: number;
      }[];
    }
  >();
  for (const correction of corrections) {
    const original = correctionOriginal(correction, records),
      root = original ? lineage(original, records) : null,
      retest = retestFor(correction, original, available, until);
    if (!original || !root || !retest) continue;
    const material =
      original.kind === "attempt" ? exactMaterial(original, bank) : null;
    const perRound = new Map<
      string,
      {
        questionType?: string;
        dimension?: string;
        errorCause: string;
        failed: boolean;
      }
    >();
    for (const item of items(correction)) {
      if (item.status !== "retested-pass" && item.status !== "retested-fail")
        continue;
      const questionType = item.questionId
        ? material?.questions.find(
            (question) => question.id === item.questionId,
          )?.type
        : undefined;
      if (item.questionId && !questionType) continue;
      const key = JSON.stringify([
        questionType ?? item.dimension,
        item.errorCause,
      ]);
      const previous = perRound.get(key);
      perRound.set(key, {
        ...(questionType ? { questionType } : { dimension: item.dimension }),
        errorCause: item.errorCause,
        failed: previous?.failed === true || item.status === "retested-fail",
      });
    }
    for (const [target, round] of perRound) {
      const key = JSON.stringify([root, correction.payload.skill, target]),
        group = groups.get(key) ?? {
          skill: correction.payload.skill as Skill,
          questionType: round.questionType,
          dimension: round.dimension,
          errorCause: round.errorCause,
          events: [],
        };
      group.events.push({
        correctionId: correction.id,
        retestId: retest.id,
        date: String(retest.payload.date),
        status: round.failed ? "retested-fail" : "retested-pass",
        seq: retest.seq,
      });
      groups.set(key, group);
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    events: group.events.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.seq - b.seq ||
        a.correctionId.localeCompare(b.correctionId),
    ),
  }));
}
export function buildWeeklyReview(input: WeeklyReviewInput) {
  const { plan, records, bank, date } = input;
  if (!validDate(date) || plan.kind !== "plan" || plan.deleted || plan.conflict)
    throw new Error("周复盘需要有效计划与日期。");
  const weekIndex = calibrationWeekIndex(plan, date),
    since = new Date(new Date(`${date}T00:00:00Z`).getTime() - 27 * 86400000)
      .toISOString()
      .slice(0, 10);
  const current = heads(records, plan.id),
    practice = heads(input.statisticsRecords ?? records, plan.id),
    byId = new Map(current.map((record) => [record.id, record]));
  const summaries: WeeklySkillStatistics[] = (
    ["listening", "reading"] as const
  ).map((skill) => {
    const skillRecords = practice.filter(
      (record) =>
        record.kind === "attempt" &&
        record.payload.skill === skill &&
        dated(record, since, date),
    );
    const summary = recentReadingStatistics(skillRecords, plan.id, bank, date);
    const evidence = (questionType?: string, cause?: string) =>
      unique(
        skillRecords
          .filter((record) =>
            (Array.isArray(record.payload.questionResults)
              ? record.payload.questionResults
              : []
            )
              .filter(isObject)
              .some((row) => {
                if (row.answerDisputed || typeof row.correct !== "boolean")
                  return false;
                const material = exactMaterial(record, bank),
                  type =
                    material?.questions.find(
                      (question) => question.id === row.questionId,
                    )?.type ?? "unknown";
                return questionType !== undefined
                  ? type === questionType
                  : row.correct === false && row.errorCause === cause;
              }),
          )
          .map((record) => record.id),
      );
    return {
      skill,
      since,
      types: summary.types.map((row) => ({
        ...row,
        recordIds: evidence(row.type),
      })),
      causes: summary.causes
        .filter((row) =>
          ERROR_CAUSES.includes(
            row.errorCause as (typeof ERROR_CAUSES)[number],
          ),
        )
        .map((row) => ({
          ...row,
          recordIds: evidence(undefined, row.errorCause),
        })),
    };
  });
  for (const skill of ["writing", "speaking"] as const) {
    const chosen = new Map<string, { feedback: Revision; work: Revision }>();
    for (const feedback of current.filter(
      (record) =>
        record.kind === "feedback" && Array.isArray(record.payload.errorCauses),
    )) {
      const work = current.find(
        (record) =>
          record.revisionId === feedback.payload.workRevisionId &&
          record.id === feedback.payload.workId &&
          record.kind === (skill === "writing" ? "essay" : "speaking") &&
          record.contentHash === feedback.payload.inputHash &&
          dated(record, since, date),
      );
      if (!work) continue;
      const before = chosen.get(work.revisionId),
        trust = (record: Revision) =>
          ["human", "official"].includes(String(record.payload.source)) ? 1 : 0;
      if (
        !before ||
        trust(feedback) > trust(before.feedback) ||
        (trust(feedback) === trust(before.feedback) &&
          newer(feedback, before.feedback) > 0)
      )
        chosen.set(work.revisionId, { feedback, work });
    }
    const causes = new Map<string, { count: number; recordIds: string[] }>();
    for (const { feedback, work } of chosen.values())
      for (const cause of new Set(feedback.payload.errorCauses as unknown[])) {
        if (!ERROR_CAUSES.includes(cause as (typeof ERROR_CAUSES)[number]))
          continue;
        const value = causes.get(String(cause)) ?? { count: 0, recordIds: [] };
        value.count++;
        value.recordIds.push(feedback.id, work.id);
        causes.set(String(cause), value);
      }
    summaries.push({
      skill,
      since,
      types: [],
      causes: [...causes].map(([errorCause, value]) => ({
        errorCause,
        count: value.count,
        recordIds: unique(value.recordIds),
      })),
    });
  }
  const corrections = current.filter(validCorrection),
    events = retestEvents(corrections, records, bank, date);
  const correctionStatistics = SKILLS.map((skill) => {
    const rounds = corrections.filter(
        (record) =>
          record.payload.skill === skill && dated(record, since, date),
      ),
      rows = rounds.flatMap(items).filter((item) => item.status !== "dropped");
    const retestRows = corrections
      .filter(
        (record) =>
          record.payload.skill === skill &&
          dated(
            retestFor(
              record,
              correctionOriginal(record, records),
              current,
              date,
            ) ?? record,
            since,
            date,
          ),
      )
      .flatMap((record) =>
        retestFor(record, correctionOriginal(record, records), current, date)
          ? items(record)
          : [],
      )
      .filter(
        (item) =>
          item.status === "retested-pass" || item.status === "retested-fail",
      );
    const completed = rows.filter((item) => item.status !== "open").length,
      passed = retestRows.filter(
        (item) => item.status === "retested-pass",
      ).length;
    return {
      skill,
      total: rows.length,
      completed,
      completionRate: rows.length ? completed / rows.length : null,
      retested: retestRows.length,
      passed,
      retestPassRate: retestRows.length ? passed / retestRows.length : null,
      recordIds: rounds.map((record) => record.id),
    };
  });
  const calibrationRecords = current.filter(
    (record) => !validDate(record.payload.date) || record.payload.date <= date,
  );
  const calibrationEvidence = (comparison: CalibrationComparison) =>
    unique([
      comparison.baselineId,
      comparison.workId,
      ...calibrationRecords
        .filter(
          (record) =>
            record.kind === "assessment" &&
            record.payload.kind === "weekly-calibration" &&
            record.payload.weekIndex === comparison.weekIndex &&
            record.payload.workRevisionId === comparison.workRevisionId,
        )
        .map((record) => record.id),
    ]);
  const comparisons = compareWeeklyCalibration(calibrationRecords).filter(
    (comparison) =>
      comparison.planId === plan.id &&
      comparison.weekIndex >= Math.max(1, weekIndex - 3) &&
      comparison.weekIndex <= weekIndex &&
      (!validDate(byId.get(comparison.baselineId)?.payload.date) ||
        String(byId.get(comparison.baselineId)?.payload.date) <= date),
  );
  const biasGroups = new Map<
    string,
    {
      taskType: CalibrationComparison["taskType"];
      source: CalibrationComparison["source"];
      dimension: string;
      weeks: Map<number, { delta: number; recordIds: string[] }[]>;
    }
  >();
  for (const comparison of comparisons)
    for (const difference of comparison.differences) {
      const key = JSON.stringify([
          comparison.taskType,
          comparison.source,
          difference.dimension,
        ]),
        group = biasGroups.get(key) ?? {
          taskType: comparison.taskType,
          source: comparison.source,
          dimension: difference.dimension,
          weeks: new Map(),
        };
      group.weeks.set(comparison.weekIndex, [
        ...(group.weeks.get(comparison.weekIndex) ?? []),
        { delta: difference.delta, recordIds: calibrationEvidence(comparison) },
      ]);
      biasGroups.set(key, group);
    }
  const systematicBias = [...biasGroups.values()].flatMap((group) =>
    [...group.weeks].flatMap(([week, later]) => {
      const earlier = group.weeks.get(week - 1);
      if (!earlier) return [];
      const all = [...earlier, ...later],
        direction = all[0].delta > 0 ? "high" : "low";
      return all.every(
        (row) =>
          calibrationNeedsReview(row.delta) &&
          (row.delta > 0 ? "high" : "low") === direction,
      )
        ? [
            {
              taskType: group.taskType,
              source: group.source,
              dimension: group.dimension,
              weeks: [week - 1, week] as [number, number],
              direction,
              recordIds: unique(all.flatMap((row) => row.recordIds)),
            },
          ]
        : [];
    }),
  );
  // Score qualification always reads immutable raw records, never answer-review projections.
  const scores = latestEffectiveBySkill(
    current.filter(
      (record) =>
        record.kind !== "assessment" ||
        !validDate(record.payload.date) ||
        record.payload.date <= date,
    ),
    plan.id,
  );
  const values = Object.fromEntries(
    SKILLS.map((skill) => [skill, scores[skill]?.score ?? null]),
  ) as Scores;
  const recommendedSkill = Object.values(values).some((value) => value !== null)
    ? largestGapSkill(values)
    : null;
  const suggestions: AdjustmentSuggestion[] = [];
  const push = (suggestion: AdjustmentSuggestion) => {
    suggestion.evidence.recordIds = unique(suggestion.evidence.recordIds);
    if (!suggestion.evidence.recordIds.length) return;
    validatePayload("adjustment", {
      planId: plan.id,
      weekIndex,
      date,
      suggestions: [suggestion],
      decision: "pending",
    });
    suggestions.push(suggestion);
  };
  for (const summary of summaries) {
    for (const row of summary.types)
      if (
        row.type !== "unknown" &&
        questionTypeNeedsFocus(row.accuracy, row.total)
      ) {
        push({
          id: `type:${summary.skill}:${row.type}`,
          skill: summary.skill,
          questionType: row.type,
          reason: `近28天${SKILL_LABELS[summary.skill]}该题型正确率${(row.accuracy * 100).toFixed(1)}%，样本${row.total}题；下周优先同题型的新材料。`,
          evidence: {
            recordIds: row.recordIds,
            metric: "type-accuracy-percent",
            value: row.accuracy * 100,
            threshold: ADJUSTMENT_RULES.questionType.accuracyBelow * 100,
          },
          action: ADJUSTMENT_RULES.questionType.action,
        });
      }
    for (const row of summary.causes)
      if (causeNeedsFocus(row.count))
        push({
          id: `cause:${summary.skill}:${row.errorCause}`,
          skill: summary.skill,
          dimension: row.errorCause,
          reason: `近28天${SKILL_LABELS[summary.skill]}同一错因出现${row.count}次；下周只调整订正顺序。`,
          evidence: {
            recordIds: row.recordIds,
            metric: "error-cause-count",
            value: row.count,
            threshold: ADJUSTMENT_RULES.errorCause.minimumCount,
          },
          action: ADJUSTMENT_RULES.errorCause.action,
        });
  }
  const persistentProblems = events.filter((group) => {
    const last = group.events.slice(
      -ADJUSTMENT_RULES.repeatedRetest.minimumConsecutiveFails,
    );
    return (
      last.length === ADJUSTMENT_RULES.repeatedRetest.minimumConsecutiveFails &&
      last.every((event) => event.status === "retested-fail") &&
      last.at(-1)!.date >= since
    );
  });
  for (const group of persistentProblems) {
    const recent = group.events.slice(
      -ADJUSTMENT_RULES.repeatedRetest.minimumConsecutiveFails,
    );
    push({
      id: `persistent:${group.skill}:${group.questionType ?? group.dimension}:${recent
        .at(-1)!
        .correctionId.replace(/[^A-Za-z0-9_.:-]/g, "")
        .slice(-45)}`,
      skill: group.skill,
      ...(group.questionType
        ? { questionType: group.questionType }
        : { dimension: group.dimension }),
      reason:
        "同一问题的连续两轮新题复测失败，标为顽固问题；建议携原作答与订正记录寻求真人校准。",
      evidence: {
        recordIds: unique(
          recent.flatMap((event) => [event.correctionId, event.retestId]),
        ),
        metric: "consecutive-retest-fails",
        value: recent.length,
        threshold: ADJUSTMENT_RULES.repeatedRetest.minimumConsecutiveFails,
      },
      action: ADJUSTMENT_RULES.repeatedRetest.action,
    });
  }
  const calibrationIssues: {
    suggestionId: string;
    comparison: CalibrationComparison;
    dimension: string;
  }[] = [];
  for (const comparison of comparisons.filter(
    (row) => row.weekIndex === weekIndex,
  ))
    for (const difference of comparison.differences.filter(
      (row) => row.needsCalibration,
    )) {
      const skill = comparison.taskType === "speaking" ? "speaking" : "writing",
        id = `calibration:${comparison.workRevisionId}:${comparison.source}:${difference.dimension}`;
      push({
        id,
        skill,
        dimension: difference.dimension,
        reason: `同一原稿的${comparison.source === "self" ? "自评" : "估分"}比真人${difference.delta > 0 ? "高" : "低"}${Math.abs(difference.delta).toFixed(1)}分；本周复核原稿，不改原分。`,
        evidence: {
          recordIds: calibrationEvidence(comparison),
          metric: "calibration-delta",
          value: difference.delta,
          threshold: ADJUSTMENT_RULES.calibration.minimumAbsoluteDelta,
        },
        action: ADJUSTMENT_RULES.calibration.action,
      });
      calibrationIssues.push({
        suggestionId: id,
        comparison,
        dimension: difference.dimension,
      });
    }
  const priority = (skill: Skill) => (skill === recommendedSkill ? 0 : 1);
  suggestions.sort(
    (a, b) =>
      priority(a.skill) - priority(b.skill) ||
      a.skill.localeCompare(b.skill) ||
      a.action.localeCompare(b.action) ||
      a.id.localeCompare(b.id),
  );
  return {
    planId: plan.id,
    date,
    weekIndex,
    since,
    summaries,
    officialCalibration:
      input.officialCalibration ??
      officialTypeCalibration(
        current.filter(
          (record) =>
            !validDate(record.payload.date) || record.payload.date <= date,
        ),
        bank,
        plan.id,
      ),
    correctionStatistics,
    comparisons,
    systematicBias,
    persistentProblems,
    scores,
    gaps: Object.fromEntries(
      SKILLS.map((skill) => [
        skill,
        scores[skill]
          ? Math.max(0, SECTION_TARGETS[skill] - scores[skill]!.score)
          : null,
      ]),
    ) as Record<Skill, number | null>,
    recommendedSkill,
    suggestions,
    calibrationIssues,
  };
}
export function buildAdjustmentPayload(
  planId: string,
  weekIndex: number,
  date: string,
  suggestion: AdjustmentSuggestion,
  decision: "accepted" | "rejected" | "pending",
  decidedAt?: number,
): LearningPayload {
  const payload = {
    planId,
    weekIndex,
    date,
    suggestions: [structuredClone(suggestion)],
    decision,
    ...(decision === "pending" ? {} : { decidedAt }),
  };
  validatePayload("adjustment", payload);
  return payload;
}
function stableToken(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
export const adjustmentRecordId = (
  planId: string,
  weekIndex: number,
  suggestionId: string,
) => `adjustment:${stableToken(planId)}:w${weekIndex}:${suggestionId}`;
/** Current valid decision heads only, including when a caller also supplies history. */
export function adjustmentRecordsForWeek(
  records: readonly Revision[],
  planId: string,
  weekIndex: number,
): Revision[] {
  return heads(records, planId)
    .filter((record) => {
      if (
        record.kind !== "adjustment" ||
        record.payload.weekIndex !== weekIndex
      )
        return false;
      try {
        validatePayload("adjustment", record.payload);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => newer(b, a));
}
export function adjustmentForSuggestion(
  records: readonly Revision[],
  planId: string,
  weekIndex: number,
  suggestionId: string,
): Revision | null {
  return (
    adjustmentRecordsForWeek(records, planId, weekIndex).find((record) =>
      (record.payload.suggestions as unknown[]).some(
        (item) => isObject(item) && item.id === suggestionId,
      ),
    ) ?? null
  );
}
/** Only the immediately following plan week can apply a deliberately accepted action. */
export function acceptedMaterialPreferences(
  records: readonly Revision[],
  planId: string,
  weekIndex: number,
): AcceptedPreferences {
  const result = emptyPreferences();
  if (!Number.isInteger(weekIndex) || weekIndex < 2 || weekIndex > 52)
    return result;
  const current = heads(records, planId),
    ids = new Set(current.map((record) => record.id));
  for (const record of current) {
    if (
      record.kind !== "adjustment" ||
      record.payload.weekIndex !== weekIndex - 1 ||
      record.payload.decision !== "accepted"
    )
      continue;
    try {
      validatePayload("adjustment", record.payload);
    } catch {
      continue;
    }
    for (const raw of record.payload.suggestions as unknown[]) {
      const item = raw as unknown as AdjustmentSuggestion;
      if (!item.evidence.recordIds.every((id) => ids.has(id))) continue;
      if (item.action === "prefer-question-type" && item.questionType)
        result.questionTypes[item.skill].push(item.questionType);
      else if (item.action === "prioritize-error-cause" && item.dimension)
        result.errorCauses[item.skill].push(item.dimension);
      else continue;
      result.recordIds.push(record.id);
    }
  }
  for (const skill of SKILLS) {
    result.questionTypes[skill] = unique(result.questionTypes[skill]);
    result.errorCauses[skill] = unique(result.errorCauses[skill]);
  }
  result.recordIds = unique(result.recordIds);
  return result;
}
/** Call on eligible new candidates; holdouts are never promoted into daily practice. */
export function prioritizeMaterials(
  materials: readonly LocalMaterial[],
  preferences: AcceptedPreferences,
  skill: Skill,
): LocalMaterial[] {
  return materials
    .filter((material) => material.pool !== "holdout")
    .map((material, index) => ({
      material,
      index,
      priority:
        material.skill === skill &&
        material.questions.some((question) =>
          preferences.questionTypes[skill].includes(question.type),
        )
          ? 1
          : 0,
    }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((item) => item.material);
}
export function prioritizeCorrections(
  corrections: readonly Revision[],
  preferences: AcceptedPreferences,
): Revision[] {
  return corrections
    .map((record, index) => ({
      record,
      index,
      priority:
        SKILLS.includes(record.payload.skill as Skill) &&
        items(record).some((item) =>
          preferences.errorCauses[record.payload.skill as Skill].includes(
            item.errorCause,
          ),
        )
          ? 1
          : 0,
    }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((item) => item.record);
}
/** A deliberately accepted calibration action becomes a traceable original-work correction. */
export function originalReviewCorrection(
  issue: ReturnType<typeof buildWeeklyReview>["calibrationIssues"][number],
  adjustment: Revision,
  context: { plan: Revision; records: readonly Revision[]; date: string },
) {
  const { plan, records, date } = context;
  if (
    adjustment.kind !== "adjustment" ||
    adjustment.planId !== plan.id ||
    adjustment.payload.decision !== "accepted" ||
    !Array.isArray(adjustment.payload.suggestions) ||
    !adjustment.payload.suggestions.some(
      (item) =>
        isObject(item) &&
        item.id === issue.suggestionId &&
        item.action === "review-original",
    )
  )
    throw new Error("请先逐条采纳这份原稿的复核建议。");
  const work = records.find(
    (record) =>
      record.revisionId === issue.comparison.workRevisionId &&
      record.id === issue.comparison.workId &&
      record.planId === plan.id &&
      !record.deleted &&
      !record.conflict,
  );
  const cause =
    CALIBRATION_CORRECTION_CAUSES[
      issue.dimension as keyof typeof CALIBRATION_CORRECTION_CAUSES
    ];
  const day = civilDayDistance(date, String(plan.payload.startDate)) + 1;
  if (
    !work ||
    (work.kind !== "essay" && work.kind !== "speaking") ||
    !cause ||
    day < 1 ||
    day > 365
  )
    throw new Error("原稿未同步或当前不在365天计划内。");
  const id = `correction:${work.revisionId}`,
    existing = heads(records, plan.id).find((record) => record.id === id);
  if (
    existing &&
    (existing.kind !== "correction" ||
      existing.payload.sourceRevisionId !== work.revisionId ||
      existing.payload.sourceKind !== work.kind ||
      existing.payload.sourceId !== work.id)
  )
    throw new Error("原稿复核记录不匹配，原记录未改。");
  const skill = work.kind === "essay" ? "writing" : "speaking";
  const previous = existing ? items(existing) : [];
  if (
    previous.some(
      (item) => item.dimension === issue.dimension && item.errorCause === cause,
    )
  )
    return null;
  const item: CorrectionItem = {
    dimension: issue.dimension,
    errorCause: cause,
    action: correctionAction(cause, skill),
    status: "open",
  };
  const payload: CorrectionPayload = existing
    ? { ...(existing.payload as CorrectionPayload), items: [...previous, item] }
    : {
        planId: plan.id,
        date,
        day,
        skill,
        sourceKind: work.kind,
        sourceId: work.id,
        sourceRevisionId: work.revisionId,
        items: [item],
      };
  validatePayload("correction", payload);
  return {
    id,
    kind: "correction" as const,
    payload,
    baseRevision: existing?.revisionId ?? null,
  };
}
