import { assertNoCredentials, scoreSpeaking, toFeedbackPayload, type SpeakingInput, type SpeakingResult } from '../ielts/scoring';
import { hashPayload, isObject, isRevisionId, validatePayload, validateSpeakingFeedbackReference, type LearningPayload, type Revision } from './protocol';
import { SPEAKING_CHECKLIST_IDS, SPEAKING_ERROR_CAUSES } from './speakingChecklist';
import { metric, words } from '../ielts/scoring/rules/text';
import { SPEAKING_DIMENSION_LABELS } from './speakingRubric';

export interface SpeakingSelfReview { checklist: Record<string, boolean | null>; errorCauses: string[]; otherExplanation: string; bands: Record<string, number | null> }
export function speakingOriginal(work: Revision): SpeakingInput {
  if (work.kind !== 'speaking' || work.deleted || work.conflict || !work.planId || !isRevisionId(work.revisionId) || typeof work.payload.transcript !== 'string') throw new Error('请先保存并选定这一版口语作答。');
  if (![1, 2, 3].includes(Number(work.payload.part))) throw new Error('这条旧作答尚未记录Part，请补充后保存新版本。');
  return { part: Number(work.payload.part) as 1 | 2 | 3, prompt: String(work.payload.prompt ?? ''), transcript: work.payload.transcript, durationSeconds: Number(work.payload.durationSeconds ?? 0) };
}
export function assertCurrentSpeaking(work: Revision, current: Revision | null) {
  if (!current || current.kind !== 'speaking' || current.deleted || current.conflict || current.id !== work.id || current.planId !== work.planId || current.revisionId !== work.revisionId || current.contentHash !== work.contentHash) throw new Error('原稿已变化，请对当前转写版本重新反馈。');
}
export function emptySpeakingReview(): SpeakingSelfReview {
  return { checklist: Object.fromEntries(SPEAKING_CHECKLIST_IDS.map(id => [id, null])), errorCauses: [], otherExplanation: '', bands: Object.fromEntries(Object.keys(SPEAKING_DIMENSION_LABELS).map(key => [key, null])) };
}
export async function buildSpeakingSelfReview(work: Revision, state: SpeakingSelfReview, now = Date.now()): Promise<LearningPayload> {
  const input = speakingOriginal(work), hash = await hashPayload('speaking', { transcript: input.transcript });
  if (hash !== work.contentHash) throw new Error('原稿已变化，请重新读取保存的转写。');
  const errorCauses = [...new Set(state.errorCauses)];
  if (errorCauses.some(cause => !SPEAKING_ERROR_CAUSES.includes(cause as typeof SPEAKING_ERROR_CAUSES[number]))) throw new Error('口语错因不在允许范围内。');
  if (errorCauses.includes('other') && !state.otherExplanation.trim()) throw new Error('选择其他错因时请填写说明。');
  if (Object.keys(state.bands).sort().join() !== Object.keys(SPEAKING_DIMENSION_LABELS).sort().join()) throw new Error('自评只接受口语四项，未评估请留空。');
  const payload: LearningPayload = { planId: work.planId, workId: work.id, workRevisionId: work.revisionId, inputHash: hash, taskType: 'speaking', rubricVersion: 'bg-speaking-self-r3-2026.11', source: 'self', sourceText: '学习者回听与手动转写自查', assessedAt: now,
    text: `口语回听自查。${state.otherExplanation.trim() ? `\n其他错因说明：${state.otherExplanation.trim()}` : ''}`, checklist: { ...state.checklist }, errorCauses, bands: { ...state.bands } };
  assertNoCredentials(payload); validatePayload('feedback', payload); validateSpeakingFeedbackReference(payload, work); return payload;
}
export async function runSpeakingRules(work: Revision): Promise<{ result: SpeakingResult; payload: LearningPayload }> {
  const input = speakingOriginal(work);
  if (!input.transcript.trim()) throw new Error('请先填写手动转写，再查看本地文字体检。');
  let result = await scoreSpeaking(input, { mode: 'rules' });
  const count = words(input.transcript).length;
  const connectors = (input.transcript.match(/\b(and|but|because|however|although|therefore|for example|on the other hand|also)\b/gi) ?? []).length;
  const extra = [metric('r3.s.words', 'transcriptWords', count, '手动转写中的词数；关键片段未必包含整段回答。'), metric('r3.s.connectors', 'linkingExpressions', connectors, '常见连接表达的词面次数，是否自然需结合上下文回听。')];
  if (input.durationSeconds > 0) extra.push(metric('r3.s.roughRate', 'roughWordsPerMinute', count * 60 / input.durationSeconds, '粗略词数时长比：转写词数除以实际时长；片段转写不能代表真实语速。'));
  result = { ...result, criteria: { ...result.criteria, fluency: { ...result.criteria.fluency, evidence: [...extra, ...result.criteria.fluency.evidence] } }, warnings: input.durationSeconds > 0 ? result.warnings : [...result.warnings, '实际时长为0，粗略词数时长比未评估。'] };

  if (input.part === 2) {
    const evidence = result.criteria.fluency.evidence.map(item => item.ruleId === 's.part2.duration' ? { ...item, message: 'Part 2本项目练习目标为120秒，按实际记录时长回听核对。' } : item);
    const warnings = result.warnings.filter(message => !message.startsWith('Part 2不足100秒'));
    if (input.durationSeconds < 120) warnings.push('Part 2记录时长不足120秒，请回听核对并补充细节后重录。');
    result = { ...result, criteria: { ...result.criteria, fluency: { ...result.criteria.fluency, evidence } }, warnings };
  }
  const payload = { ...await toFeedbackPayload(result, { planId: work.planId!, workId: work.id, workRevisionId: work.revisionId, text: input.transcript }), taskType: 'speaking' };
  validatePayload('feedback', payload); validateSpeakingFeedbackReference(payload, work); return { result, payload };
}
export function speakingFeedbackForWork(records: readonly Revision[], work: Revision): Revision[] {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)) if (!heads.has(record.id)) heads.set(record.id, record);
  return [...heads.values()].filter(record => record.kind === 'feedback' && !record.deleted && !record.conflict && record.planId === work.planId && record.payload.planId === work.planId && record.payload.workId === work.id && record.payload.workRevisionId === work.revisionId && record.payload.inputHash === work.contentHash && (record.payload.taskType === undefined || record.payload.taskType === 'speaking'));
}
export function restoreSpeakingReview(feedback?: Revision): SpeakingSelfReview {
  const state = emptySpeakingReview();
  if (!feedback) return state;
  const payload = feedback.payload;
  return { ...state, checklist: { ...state.checklist, ...(isObject(payload.checklist) ? payload.checklist as Record<string, boolean | null> : {}) }, bands: { ...state.bands, ...(isObject(payload.bands) ? payload.bands as Record<string, number | null> : {}) }, errorCauses: Array.isArray(payload.errorCauses) ? payload.errorCauses as string[] : [], otherExplanation: String(payload.text ?? '').split('\n其他错因说明：')[1] ?? '' };
}
