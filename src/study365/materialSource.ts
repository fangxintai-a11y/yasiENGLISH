import { hasAmbiguousAnswerReview } from "./answerReviewModel";
import { isObject, readAttemptMaterialSource, validatePayload, type LearningPayload, type MaterialSource, type Revision } from './protocol';
export type ListeningReadingSkill = 'listening' | 'reading';
/** A verified formal result is exam evidence; it does not require retaining the exam paper. */
export function isFormalResult(payload: LearningPayload): boolean {
  if (payload.source !== 'official' || !(payload.kind === 'official' || payload.kind === 'gate' && payload.gateId === 'G4')) return false;
  try { validatePayload('assessment', payload); return true; } catch { return false; }
}
export function currentAttemptHeads(records: readonly Revision[], planId: string): Revision[] {
  const heads = new Map<string, Revision>();
  for (const item of records.filter(item => item.kind === 'attempt' && item.planId === planId && !item.conflict).sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)) {
    if (heads.has(item.id)) continue;
    heads.set(item.id, item);
  }
  return [...heads.values()].filter(item => !item.deleted && item.payload.planId === planId);
}
/** Full external aggregates have no per-question text; never fabricate answers or hashes. */
function completeFullAttempt(payload: LearningPayload): boolean {
  if (payload.scope !== 'full' || payload.total !== 40 || !Array.isArray(payload.answers) || payload.answers.length !== 0 && payload.answers.length !== 40) return false;
  const counts = [payload.score, payload.correct].filter(value => value !== undefined);
  return counts.length > 0 && counts.every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 40 && value === counts[0]);
}
/** Exact same-sitting association only. Never infer a source from an ID prefix or a reviewer label. */
export function assessmentMaterialEligibility(payload: LearningPayload, records: readonly Revision[] = []) {
  const formal = isFormalResult(payload);
  const result = {} as Record<ListeningReadingSkill, { eligible: boolean; materialSource: MaterialSource | null }>;
  for (const skill of ['listening', 'reading'] as const) {
    if (formal) { result[skill] = { eligible: true, materialSource: 'official' }; continue; }
    const attempt = typeof payload.planId === 'string' && typeof payload.materialId === 'string' && typeof payload.date === 'string'
      ? currentAttemptHeads(records, payload.planId).find(item => item.payload.date === payload.date && (item.payload.contentId === payload.materialId || item.payload.sourceRef === payload.materialId) && item.payload.skill === skill) : undefined;
    const source = attempt ? readAttemptMaterialSource(attempt.payload) : null;
    let valid = false;
    if (attempt) { try { validatePayload('attempt', attempt.payload); valid = true; } catch { /* An invalid imported record cannot provide qualification. */ } }
    result[skill] = { eligible: valid && !!attempt && completeFullAttempt(attempt.payload) && !hasAmbiguousAnswerReview(attempt.payload, records) && (source === 'official' || source === 'cambridge'), materialSource: source };
  }
  return result;
}
/** Derived records only: retain every sitting (including ineligible ones) in the G3 sequence. */
export function materialQualifiedRecords(records: readonly Revision[], planId: string): Revision[] {
  return records.map(record => {
    if (record.kind !== 'assessment' || record.planId !== planId || isFormalResult(record.payload) || !isObject(record.payload.scores)) return record;
    const eligible = assessmentMaterialEligibility(record.payload, records);
    const scores = { ...record.payload.scores }, scoreSources = isObject(record.payload.scoreSources) ? { ...record.payload.scoreSources } : undefined;
    for (const skill of ['listening', 'reading'] as const) if (!eligible[skill].eligible) { scores[skill] = null; if (scoreSources) scoreSources[skill] = null; }
    return { ...record, payload: { ...record.payload, scores, ...(scoreSources ? { scoreSources } : {}) } };
  });
}
