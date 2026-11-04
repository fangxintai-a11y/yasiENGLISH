import assert from 'node:assert/strict';
import test from 'node:test';
import { draftFromRevision, newWritingDraft, validateWritingDraft, writingScope } from './writingDrafts';
import { checkpointWriting, elapsedWritingSeconds, essayPayload, rewriteWriting, submitWriting } from './writingWorks';
import { hashPayload, type Revision } from './protocol';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const draft = () => newWritingDraft({ id: 'work-a', planId: 'plan-a', taskType: 'task2', prompt: 'Discuss transport.', date: '2026-11-15', text: 'I believe public transport matters.', outline: 'Position and evidence', timer: { elapsedSeconds: 17, runningSince: 1000, limitSeconds: 2400, timed: true } });
const record = async (value: ReturnType<typeof draft>, revision = 1): Promise<Revision> => ({ id: value.recordId, kind: 'essay', planId: value.planId, datasetId: null, revisionId: uuid(revision), baseRevision: value.baseRevision, seq: revision, createdAt: revision, deleted: false, conflict: false, contentHash: await hashPayload('essay', { text: value.text }), payload: essayPayload(value, 'submitted', 4000) });

test('draft scope matches user learning scope and retains outline and elapsed timer fields', () => {
  assert.equal(writingScope(null), 'guest'); assert.equal(writingScope('user-a'), 'account:user-a');
  assert.notEqual(writingScope('user-a'), writingScope('user-b'));
  const value = draft(); assert.equal(value.outline, 'Position and evidence'); assert.equal(elapsedWritingSeconds(value, 4000), 20);
  assert.equal(essayPayload(value, 'draft', 4000).outline, undefined);
  assert.equal(essayPayload(value, 'draft', 4000).elapsedSeconds, 20);
});
test('checkpoints and submit preserve base revision on the same work, then lock the submitted copy', async () => {
  const saves: { id: string; baseRevision: string | null; payload: Record<string, unknown> }[] = [], locals: unknown[] = [];
  let serial = 0;
  const port = { save: async (input: { id: string; baseRevision: string | null; payload: Record<string, unknown> }) => {
    saves.push(input); return { ...await record(draft(), ++serial), payload: input.payload };
  }, persist: async (_scope: string, value: unknown) => { locals.push(value); } };
  const checkpoint = await checkpointWriting(draft(), { scope: 'guest', now: 4000, port });
  assert.equal(checkpoint.work.payload.stage, 'draft'); assert.equal(checkpoint.draft.baseRevision, uuid(1));
  const submitted = await submitWriting({ ...checkpoint.draft, text: 'Changed text.' }, { scope: 'guest', now: 5000, port });
  assert.equal(saves[0].id, saves[1].id); assert.equal(saves[1].baseRevision, uuid(1)); assert.equal(submitted.work.payload.stage, 'submitted');
  assert.equal(submitted.draft.timer.runningSince, null); assert.equal(submitted.draft.submittedRevisionId, uuid(2));
  await assert.rejects(() => submitWriting(submitted.draft, { scope: 'guest', port }), /只读/);
  assert.equal(locals.length, 4);
});
test('storage failure stops publishing and unresolved versions block submission without losing the draft', async () => {
  let writes = 0;
  const port = { save: async () => { writes++; return record(draft()); }, persist: async () => { throw new Error('草稿未保存：空间不足'); } };
  await assert.rejects(() => checkpointWriting(draft(), { scope: 'guest', port }), /未保存/);
  await assert.rejects(() => submitWriting(draft(), { scope: 'guest', port, hasUnresolvedConflict: true }), /两个版本/);
  assert.equal(writes, 0); assert.equal(draft().text, 'I believe public transport matters.');
});
test('rewrites use a new work and parent revision while old submitted and cloud checkpoints restore honestly', async () => {
  const work = await record(draft());
  const rewrite = rewriteWriting(work);
  assert.notEqual(rewrite.recordId, work.id); assert.equal(rewrite.parentRevisionId, work.revisionId); assert.equal(rewrite.text, work.payload.text);
  assert.equal(rewrite.baseRevision, null); assert.equal(rewrite.timer.elapsedSeconds, 0); assert.equal(rewrite.conditions.firstAttempt, false);
  const old = { ...work, payload: { ...work.payload } }; delete old.payload.stage; delete old.payload.scope;
  assert.equal(draftFromRevision(old).stage, 'submitted'); assert.equal(draftFromRevision(old).outline, '');
  assert.equal(draftFromRevision({ ...work, payload: { ...work.payload, stage: 'draft' } }).stage, 'draft');
});
test('paragraph scope stays explicit and invalid timing or references do not pass local validation', () => {
  assert.equal(essayPayload({ ...draft(), scope: 'paragraph' }, 'submitted', 4000).scope, 'paragraph');
  assert.throws(() => validateWritingDraft({ ...draft(), timer: { ...draft().timer, elapsedSeconds: -1 } }), /未保存/);
  assert.throws(() => validateWritingDraft({ ...draft(), baseRevision: 'invalid' }), /修订/);
});
