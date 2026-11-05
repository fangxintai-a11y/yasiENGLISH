import { assertNoCredentials, getFeedbackConfig, toFeedbackPayload, type FeedbackConfig, type WritingInput, type WritingResult } from '../ielts/scoring';
import type { Revision } from './protocol';

export function writingFeedbackInput(work: Revision): WritingInput {
  if (work.kind !== 'essay' || work.deleted || work.conflict || work.payload.stage === 'draft' || !work.planId || !['task1', 'task2'].includes(String(work.payload.taskType))) throw new Error('请先保存并提交这一版原稿。');
  const prompt = String(work.payload.prompt ?? '') + (work.payload.scope === 'paragraph' ? '\n练习范围：仅Task 2段落，不能作为整篇作文评价。' : '');
  return { taskType: work.payload.taskType as 'task1' | 'task2', prompt, text: String(work.payload.text ?? ''), feedbackContext: { workRevisionId: work.revisionId, inputHash: work.contentHash } };
}

export function assertCurrentWriting(work: Revision, current: Revision | null): void {
  if (!current || current.deleted || current.conflict || current.kind !== 'essay' || current.payload.stage === 'draft'
    || current.id !== work.id || current.planId !== work.planId || current.revisionId !== work.revisionId || current.contentHash !== work.contentHash)
    throw new Error('原稿已变化，请对当前版本重新获取反馈。');
}

export async function buildWritingFeedback(work: Revision, result: WritingResult, currentWork: () => Revision | null) {
  writingFeedbackInput(work); assertCurrentWriting(work, currentWork());
  if (result.source !== 'ai') throw new Error('外部反馈尚未成功，请使用复制提示词继续。');
  const payload = await toFeedbackPayload(result, { planId: work.planId!, workId: work.id, workRevisionId: work.revisionId, text: String(work.payload.text ?? '') });
  assertCurrentWriting(work, currentWork()); assertNoCredentials(payload);
  return payload;
}

/** Public destination metadata only; credentials are never read for this display. */
export function writingFeedbackDestinations(config: FeedbackConfig = getFeedbackConfig()) {
  return config.providers.filter(provider => provider.tasks.includes('essay') && provider.baseURL.trim() && provider.model.trim())
    .map(provider => ({ id: provider.id, label: provider.label || '反馈接口', url: provider.baseURL }));
}
