import { assertNoCredentials } from '../ielts/scoring';
import { words } from '../ielts/scoring/rules/text';
import { hashPayload, isRevisionId, validatePayload, type LearningPayload, type Revision } from './protocol';

const HANDOFF_PREFIX = 'writing-handoff:';
function submittedFull(work: Revision) {
  if (!isRevisionId(work.revisionId) || work.kind !== 'essay' || work.deleted || work.conflict || !work.planId || work.payload.stage === 'draft' || work.payload.scope === 'paragraph' || !['task1', 'task2'].includes(String(work.payload.taskType))) throw new Error('请使用已提交的完整Task 1或Task 2作品登记真人评阅。');
}
function currentHeads(records: readonly Revision[]) {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)) if (!heads.has(record.id)) heads.set(record.id, record);
  return [...heads.values()].filter(record => !record.deleted && !record.conflict);
}
export function writingHandoffId(work: Revision) { submittedFull(work); return `${HANDOFF_PREFIX}${work.revisionId}`; }
export function humanWritingId(work: Revision) { submittedFull(work); return `writing-human:${work.revisionId}`; }
export function buildWritingHandoff(work: Revision, date: string): LearningPayload {
  const payload: LearningPayload = { planId: work.planId, taskId: writingHandoffId(work), date, skill: 'writing', status: 'in_progress', plannedMinutes: 0, actualMinutes: 0, timeSource: 'manual' };
  validatePayload('mission', payload); return payload;
}
export function calibrationForWork(records: readonly Revision[], work: Revision): Revision[] {
  return currentHeads(records).filter(record => {
    if (record.kind !== 'assessment' || record.planId !== work.planId || record.payload.planId !== work.planId || record.payload.kind !== 'weekly-calibration' || !['human', 'official'].includes(String(record.payload.source))
      || record.payload.workId !== work.id || record.payload.workRevisionId !== work.revisionId || record.payload.inputHash !== work.contentHash || record.payload.taskType !== work.payload.taskType) return false;
    try { validatePayload('assessment', record.payload); return true; } catch { return false; }
  });
}
export function pendingWritingHandoffs(records: readonly Revision[], planId: string): Revision[] {
  const heads = currentHeads(records).filter(record => record.planId === planId);
  return heads.filter(record => {
    if (record.payload.planId !== planId || record.kind !== 'mission' || record.payload.status !== 'in_progress' || typeof record.payload.taskId !== 'string' || !record.payload.taskId.startsWith(HANDOFF_PREFIX)) return false;
    const revisionId = record.payload.taskId.slice(HANDOFF_PREFIX.length);
    if (!isRevisionId(revisionId)) return false;
    const work = heads.find(candidate => candidate.kind === 'essay' && candidate.revisionId === revisionId);
    return !!work && work.payload.scope !== 'paragraph' && work.payload.stage !== 'draft' && calibrationForWork(heads, work).length === 0;
  });
}
export function calibrationWeekIndex(plan: Revision, date: string): number {
  const civil = (value: string) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('评阅日期无效。');
    return parsed.getTime();
  };
  const days = (civil(date) - civil(String(plan.payload.startDate))) / 86400000;
  if (days < 0) throw new Error('评阅作品日期早于计划开始日。');
  return Math.min(52, Math.floor(days / 7) + 1);
}
export async function buildHumanWritingCalibration(work: Revision, plan: Revision, bands: Record<string, number | null>, date: string, handoffDate?: string): Promise<LearningPayload> {
  submittedFull(work);
  if (plan.kind !== 'plan' || plan.id !== work.planId) throw new Error('真人评阅与学习计划不一致。');
  const hash = await hashPayload('essay', { text: String(work.payload.text ?? '') });
  if (hash !== work.contentHash) throw new Error('原稿已变化，请重新读取提交版本。');
  const payload: LearningPayload = { planId: work.planId, kind: 'weekly-calibration', source: 'human', date, weekIndex: calibrationWeekIndex(plan, handoffDate ?? String(work.payload.date)), workId: work.id, workRevisionId: work.revisionId, inputHash: hash, taskType: work.payload.taskType, bands: { ...bands } };
  assertNoCredentials(payload); validatePayload('assessment', payload); return payload;
}
export function writingExportText(work: Revision): string {
  submittedFull(work);
  const value = `Task ${work.payload.taskType === 'task1' ? '1' : '2'}\n题目：${String(work.payload.prompt ?? '')}\n出处：${String(work.payload.sourceRef ?? work.payload.contentId ?? '自定义题目')}\n字数：${words(String(work.payload.text ?? '')).length}\n\n${String(work.payload.text ?? '')}`;
  assertNoCredentials(value); return value;
}
