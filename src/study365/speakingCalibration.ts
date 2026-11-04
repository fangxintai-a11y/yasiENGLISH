import { assertNoCredentials } from '../ielts/scoring';
import { hashPayload, isObject, validatePayload, type LearningPayload, type Revision } from './protocol';
import { speakingFeedbackForWork, speakingOriginal } from './speakingReview';
import { SPEAKING_DIMENSION_LABELS, type SpeakingDimension } from './speakingRubric';
import { calibrationWeekIndex } from './writingCalibration';

export function humanSpeakingId(work: Revision): string { speakingOriginal(work); return `speaking-human:${work.revisionId}`; }
export async function buildHumanSpeakingCalibration(work: Revision, plan: Revision, bands: Record<string, number | null>, date: string): Promise<LearningPayload> {
  const input = speakingOriginal(work);
  if (plan.kind !== 'plan' || plan.deleted || plan.conflict || plan.id !== work.planId) throw new Error('真人评阅与学习计划不一致。');
  const hash = await hashPayload('speaking', { transcript: input.transcript });
  if (hash !== work.contentHash) throw new Error('转写已变化，请重新读取保存的版本。');
  const payload: LearningPayload = { planId: work.planId, kind: 'weekly-calibration', source: 'human', date, weekIndex: calibrationWeekIndex(plan, String(work.payload.date)), workId: work.id, workRevisionId: work.revisionId, inputHash: hash, bands: { ...bands } };
  assertNoCredentials(payload); validatePayload('assessment', payload); return payload;
}
export function speakingCalibrationForWork(records: readonly Revision[], work: Revision): Revision[] {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)) if (!heads.has(record.id)) heads.set(record.id, record);
  return [...heads.values()].filter(record => {
    if (record.kind !== 'assessment' || record.deleted || record.conflict || record.planId !== work.planId || record.payload.planId !== work.planId || record.payload.kind !== 'weekly-calibration' || !['human', 'official'].includes(String(record.payload.source)) || record.payload.taskType !== undefined
      || record.payload.workId !== work.id || record.payload.workRevisionId !== work.revisionId || record.payload.inputHash !== work.contentHash) return false;
    try { validatePayload('assessment', record.payload); return true; } catch { return false; }
  });
}
export function speakingCalibrationRows(records: readonly Revision[], work: Revision) {
  const feedbacks = speakingFeedbackForWork(records, work);
  const raw = [feedbacks.find(record => record.payload.source === 'self')?.payload.bands, feedbacks.find(record => record.payload.source === 'ai')?.payload.bands, speakingCalibrationForWork(records, work)[0]?.payload.bands];
  return (['自评', '估分', '真人'] as const).map((label, index) => ({ label, bands: Object.fromEntries(Object.keys(SPEAKING_DIMENSION_LABELS).map(key => {
    const value = isObject(raw[index]) ? raw[index][key] : null;
    return [key, index === 1 && (key === 'fluency' || key === 'pronunciation') ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9 && Number.isInteger(value * 2) ? value : null];
  })) as Record<SpeakingDimension, number | null> }));
}
