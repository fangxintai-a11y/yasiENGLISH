import { assertNoCredentials, getFeedbackConfig, toFeedbackPayload, type FeedbackConfig, type SpeakingInput, type SpeakingResult } from '../ielts/scoring';
import { validatePayload, validateSpeakingFeedbackReference, type LearningPayload, type Revision } from './protocol';
import { assertCurrentSpeaking, speakingOriginal } from './speakingReview';

export function speakingFeedbackInput(work: Revision): SpeakingInput {
  const input = speakingOriginal(work);
  if (!input.transcript.trim()) throw new Error('请先填写并保存手动转写，再获取外部文字反馈。');
  return { ...input, feedbackContext: { workRevisionId: work.revisionId, inputHash: work.contentHash } };
}
export async function buildSpeakingFeedback(work: Revision, result: SpeakingResult, currentWork: () => Revision | null): Promise<LearningPayload> {
  const input = speakingFeedbackInput(work); assertCurrentSpeaking(work, currentWork());
  if (result.source !== 'ai') throw new Error('外部反馈尚未成功，请使用复制提示词继续。');
  if (result.criteria.fluency.band !== null || result.criteria.pronunciation.band !== null || result.criteria.fluency.confidence !== 0 || result.criteria.pronunciation.confidence !== 0) throw new Error('文字反馈不能评估实际流利与发音。');
  const payload = { ...await toFeedbackPayload(result, { planId: work.planId!, workId: work.id, workRevisionId: work.revisionId, text: input.transcript }), taskType: 'speaking' };
  assertCurrentSpeaking(work, currentWork()); assertNoCredentials(payload);
  validatePayload('feedback', payload); validateSpeakingFeedbackReference(payload, work);
  return payload;
}
/** Public destination metadata only; audio and credentials are never read. */
export function speakingFeedbackDestinations(config: FeedbackConfig = getFeedbackConfig()) {
  return config.providers.filter(provider => provider.tasks.includes('speaking') && provider.baseURL.trim() && provider.model.trim())
    .map(provider => ({ id: provider.id, label: provider.label || '反馈接口', url: provider.baseURL }));
}
