import { readWritingDraft, listWritingDraftEntries, updateWritingDraft, deleteWritingDraftEntry, userScopeKey } from './db';
import type { Revision } from './protocol';
import { newWritingDraft, validateWritingDraft, type WritingDraft } from './writingModel';
export { newWritingDraft, validateWritingDraft, type WritingDraft, type NewWritingDraft } from './writingModel';
export const writingScope = (userId: string | null) => userId ? userScopeKey(userId) : 'guest';

export async function loadWritingDraft(scope: string, id: string): Promise<WritingDraft | undefined> {
  const draft = await readWritingDraft<WritingDraft>(scope, id); if (draft) validateWritingDraft(draft); return draft;
}
export async function saveWritingDraft(scope: string, draft: WritingDraft): Promise<void> {
  validateWritingDraft(draft);
  try {
    await updateWritingDraft<WritingDraft>(scope, draft.id, old => {
      if (old?.stage === 'submitted' && JSON.stringify(old) !== JSON.stringify(draft)) throw new Error('已提交的原稿只读，请新建修改稿。');
      return draft;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('只读')) throw error;
    throw new Error('草稿未保存。请释放设备存储空间后重试，勿关闭未保存的正文。');
  }
}
export async function listWritingDrafts(scope: string): Promise<WritingDraft[]> {
  const drafts = await listWritingDraftEntries<WritingDraft>(scope); drafts.forEach(validateWritingDraft); return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}
export const deleteWritingDraft = deleteWritingDraftEntry;
export function draftFromRevision(work: Revision): WritingDraft {
  if (work.kind !== 'essay' || work.deleted || work.conflict || !['task1', 'task2'].includes(String(work.payload.taskType))) throw new Error('这份记录不能恢复为写作草稿。');
  const p = work.payload;
  return newWritingDraft({ id: work.id, recordId: work.id, planId: work.planId!, baseRevision: work.revisionId,
    taskType: p.taskType as WritingDraft['taskType'], scope: p.scope === 'paragraph' ? 'paragraph' : 'full',
    stage: p.stage === 'draft' ? 'draft' : 'submitted', ...(p.stage === 'draft' ? {} : { submittedRevisionId: work.revisionId }),
    date: String(p.date), prompt: String(p.prompt ?? ''), text: String(p.text ?? ''),
    timer: { elapsedSeconds: Number(p.elapsedSeconds ?? 0), runningSince: null, limitSeconds: p.taskType === 'task1' ? 1200 : 2400, timed: !!(p.conditions as Record<string, unknown> | undefined)?.timed },
    conditions: { firstAttempt: !!(p.conditions as Record<string, unknown> | undefined)?.firstAttempt, unseen: !!(p.conditions as Record<string, unknown> | undefined)?.unseen },
    ...Object.fromEntries(['day', 'taskId', 'contentId', 'contentVersion', 'sourceRef', 'parentRevisionId', 'correctionId', 'retestOf'].filter(key => p[key] !== undefined && p[key] !== null).map(key => [key, p[key]])) });
}
