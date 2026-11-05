import { words } from '../ielts/scoring/rules/text';
import { assertNoCredentials } from '../ielts/scoring';
import { validatePayload, type LearningPayload, type Revision } from './protocol';
import { newWritingDraft, saveWritingDraft, validateWritingDraft, writingScope, type WritingDraft } from './writingDrafts';

export { elapsedWritingSeconds } from './writingModel';
import { elapsedWritingSeconds } from './writingModel';
export function essayPayload(draft: WritingDraft, stage: 'draft' | 'submitted', now = Date.now()): LearningPayload {
  validateWritingDraft(draft);
  const payload: LearningPayload = { planId: draft.planId, taskType: draft.taskType, scope: draft.scope, stage,
    date: draft.date, prompt: draft.tableDescription?.trim() ? `${draft.prompt}\n\n题图文字说明：${draft.tableDescription.trim()}` : draft.prompt, text: draft.text, wordCount: words(draft.text).length, elapsedSeconds: elapsedWritingSeconds(draft, now),
    conditions: { timed: draft.timer.timed, ...draft.conditions } };
  for (const key of ['day', 'taskId', 'contentId', 'contentVersion', 'sourceRef', 'parentRevisionId', 'correctionId', 'retestOf'] as const)
    if (draft[key] !== undefined && draft[key] !== '') payload[key] = draft[key];
  assertNoCredentials(payload); validatePayload('essay', payload); return payload;
}
interface WorkPort {
  save(input: { id: string; kind: 'essay'; payload: LearningPayload; baseRevision: string | null }): Promise<Revision>;
  persist(scope: string, draft: WritingDraft): Promise<void>;
}
export interface WritingSaveOptions { scope: string; expectedUserId?: string | null; hasUnresolvedConflict?: boolean; now?: number; port?: WorkPort }
async function save(draft: WritingDraft, stage: 'draft' | 'submitted', options: WritingSaveOptions) {
  if (draft.stage === 'submitted') throw new Error('已提交的原稿只读，请新建修改稿。');
  if (options.hasUnresolvedConflict) throw new Error('有两个版本，请先选择一份再提交。');
  const now = options.now ?? Date.now(), payload = essayPayload(draft, stage, now);
  if (!draft.prompt.trim() || !draft.text.trim()) throw new Error('请先填写题目和正文。');
  const port = options.port ?? await (async (): Promise<WorkPort> => {
    const repository = await import('./repository');
    const check = () => { const state = repository.getLearningState();
      if (!state.ready || writingScope(state.userId) !== options.scope || options.expectedUserId !== undefined && state.userId !== options.expectedUserId) throw new Error('账号已经切换，请在原账号继续写作。'); };
    return { save: request => { check(); return repository.saveRecord(request); }, persist: (scope, value) => { check(); return saveWritingDraft(scope, value); } };
  })();
  await port.persist(options.scope, draft);
  const work = await port.save({ id: draft.recordId, kind: 'essay', payload, baseRevision: draft.baseRevision });
  const next: WritingDraft = { ...draft, baseRevision: work.revisionId, stage, updatedAt: now,
    timer: { ...draft.timer, elapsedSeconds: Number(payload.elapsedSeconds), runningSince: stage === 'submitted' || draft.timer.runningSince === null ? null : now },
    ...(stage === 'submitted' ? { submittedRevisionId: work.revisionId } : {}) };
  await port.persist(options.scope, next);
  return { draft: next, work };
}
export const checkpointWriting = (draft: WritingDraft, options: WritingSaveOptions) => save(draft, 'draft', options);
export const submitWriting = (draft: WritingDraft, options: WritingSaveOptions) => save(draft, 'submitted', options);
export function rewriteWriting(work: Revision): WritingDraft {
  if (work.kind !== 'essay' || work.deleted || work.conflict || work.payload.stage === 'draft' || !['task1', 'task2'].includes(String(work.payload.taskType))) throw new Error('请从已提交的作品创建修改稿。');
  const payload = work.payload;
  return newWritingDraft({ planId: work.planId!, taskType: payload.taskType as 'task1' | 'task2', scope: payload.scope === 'paragraph' ? 'paragraph' : 'full',
    date: String(payload.date), prompt: String(payload.prompt), text: String(payload.text), parentRevisionId: work.revisionId,
    conditions: { firstAttempt: false, unseen: false },
    ...Object.fromEntries(['day', 'taskId', 'contentId', 'contentVersion', 'sourceRef'].filter(key => payload[key] !== undefined).map(key => [key, payload[key]])) });
}
