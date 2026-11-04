import { isIdentifier, isRevisionId } from './protocol';

export interface WritingDraft {
  version: 1; id: string; recordId: string; planId: string; baseRevision: string | null; parentRevisionId?: string; correctionId?: string;
  taskType: 'task1' | 'task2'; scope: 'full' | 'paragraph'; date: string; day?: number; taskId?: string;
  contentId?: string; contentVersion?: string; sourceRef?: string;
  prompt: string; text: string; outline: string;
  tableDescription?: string; materialSelfCheck?: string[];
  timer: { elapsedSeconds: number; runningSince: number | null; limitSeconds: number; timed: boolean };
  conditions: { firstAttempt: boolean; unseen: boolean };
  stage: 'draft' | 'submitted'; submittedRevisionId?: string; updatedAt: number;
}
export type NewWritingDraft = Pick<WritingDraft, 'planId' | 'taskType' | 'prompt' | 'date'> & Partial<Omit<WritingDraft, 'version'>>;
export function newWritingDraft(input: NewWritingDraft): WritingDraft {
  const id = input.id ?? crypto.randomUUID();
  const { planId, taskType, prompt, date, ...overrides } = input;
  const draft: WritingDraft = { version: 1, id, recordId: input.recordId ?? id, planId, taskType,
    prompt, date, baseRevision: null, scope: 'full', text: '', outline: '', stage: 'draft',
    timer: { elapsedSeconds: 0, runningSince: null, limitSeconds: input.taskType === 'task1' ? 1200 : 2400, timed: false },
    conditions: { firstAttempt: true, unseen: false }, updatedAt: Date.now(), ...overrides };
  validateWritingDraft(draft); return draft;
}
export function validateWritingDraft(value: WritingDraft): void {
  if (value.version !== 1 || ![value.id, value.recordId, value.planId].every(isIdentifier) || !['task1', 'task2'].includes(value.taskType)
    || !['full', 'paragraph'].includes(value.scope) || !['draft', 'submitted'].includes(value.stage)) throw new Error('写作草稿格式无效，未保存。');
  if (value.baseRevision !== null && !isRevisionId(value.baseRevision) || value.parentRevisionId !== undefined && !isRevisionId(value.parentRevisionId)
    || value.submittedRevisionId !== undefined && !isRevisionId(value.submittedRevisionId)) throw new Error('写作草稿修订引用无效，未保存。');
  if (value.correctionId !== undefined && !isIdentifier(value.correctionId)) throw new Error('订正引用无效，未保存。');
  if (typeof value.text !== 'string' || value.text.length > 20000 || typeof value.prompt !== 'string' || value.prompt.length > 8000 || typeof value.outline !== 'string' || value.outline.length > 8000) throw new Error('写作内容过长或格式无效，未保存。');
  const date = new Date(`${value.date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.date) throw new Error('写作日期无效，未保存。');
  if (value.tableDescription !== undefined && (typeof value.tableDescription !== 'string' || value.tableDescription.length > 2000)
    || value.materialSelfCheck !== undefined && (!Array.isArray(value.materialSelfCheck) || value.materialSelfCheck.length > 30 || value.materialSelfCheck.some(item => typeof item !== 'string' || item.length > 500))) throw new Error('写作材料说明无效，未保存。');
  if (!value.timer || !Number.isFinite(value.timer.elapsedSeconds) || value.timer.elapsedSeconds < 0 || value.timer.elapsedSeconds > 86400
    || !Number.isFinite(value.timer.limitSeconds) || value.timer.limitSeconds < 0 || value.timer.limitSeconds > 86400
    || value.timer.runningSince !== null && !Number.isFinite(value.timer.runningSince) || typeof value.timer.timed !== 'boolean') throw new Error('写作计时无效，未保存。');
  if (!value.conditions || typeof value.conditions.firstAttempt !== 'boolean' || typeof value.conditions.unseen !== 'boolean' || !Number.isFinite(value.updatedAt)) throw new Error('写作条件无效，未保存。');
}
export function elapsedWritingSeconds(draft: WritingDraft, now = Date.now()): number {
  return Math.min(86400, Math.max(0, Math.floor(draft.timer.elapsedSeconds + (draft.timer.runningSince === null ? 0 : Math.max(0, now - draft.timer.runningSince) / 1000))));
}
