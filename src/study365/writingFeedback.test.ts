import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptManual, scoreWriting, type WritingResult } from '../ielts/scoring';
import { hashPayload, validatePayload, type Revision } from './protocol';
import { buildWritingFeedback, writingFeedbackDestinations, writingFeedbackInput } from './writingFeedback';

async function work(text = 'Original submitted draft.'): Promise<Revision> {
  return { id: 'essay-one', kind: 'essay', planId: 'plan-one', datasetId: null, revisionId: '11111111-1111-4111-8111-111111111111', baseRevision: null, seq: 1, createdAt: 1, conflict: false, deleted: false, contentHash: await hashPayload('essay', { text }), payload: { planId: 'plan-one', taskType: 'task2', scope: 'full', stage: 'submitted', prompt: 'Discuss transport.', text, date: '2026-11-15' } };
}
async function result(saved: Revision): Promise<WritingResult> {
  const criterion = { band: 7.5, confidence: 0.6, evidence: [] };
  const input = writingFeedbackInput(saved);
  const accepted = await acceptManual<WritingResult>('essay', JSON.stringify({ criteria: { taskResponse: criterion, coherence: criterion, lexical: criterion, grammar: criterion }, causes: [], summaryZh: '参考反馈。', rewrite8: 'A revision reference.', ...input.feedbackContext }), input);
  if (!accepted.ok) assert.fail(accepted.errors.join('\n'));
  return accepted.value;
}

test('external feedback maps only to the saved exact work revision and remains an estimate', async () => {
  const saved = await work();
  const payload = await buildWritingFeedback(saved, await result(saved), () => saved);
  assert.equal(payload.source, 'ai'); assert.equal(payload.workId, saved.id);
  assert.equal(payload.workRevisionId, saved.revisionId); assert.equal(payload.inputHash, saved.contentHash);
  assert.doesNotThrow(() => validatePayload('feedback', payload));
  assert.equal(saved.payload.text, 'Original submitted draft.');
});

test('late feedback is rejected when the selected work is unsubmitted or a different revision', async () => {
  const saved = await work(), value = await result(saved);
  await assert.rejects(buildWritingFeedback(saved, value, () => null), /原稿已变化/);
  await assert.rejects(buildWritingFeedback(saved, value, () => ({ ...saved, revisionId: '22222222-2222-4222-8222-222222222222' })), /原稿已变化/);
});

test('failed automatic fallback is not saved as external feedback and submitted work is unchanged', async () => {
  const saved = await work();
  const original = structuredClone(saved);
  const local = await scoreWriting(writingFeedbackInput(saved), { mode: 'rules' });
  await assert.rejects(buildWritingFeedback(saved, local, () => saved), /尚未成功/);
  assert.deepEqual(saved, original);
});

test('only configured writing destinations are shown and no credential field is exposed', () => {
  const provider = { id: 'one', kind: 'openai-compatible' as const, label: '自选接口', baseURL: 'https://feedback.example/v1', model: 'chosen-model', tasks: ['essay' as const], jsonMode: 'json_schema' as const, timeoutMs: 3000 };
  assert.deepEqual(writingFeedbackDestinations({ version: 1, providers: [provider, { ...provider, id: 'two', tasks: ['reading'] }, { ...provider, id: 'three', model: '' }] }), [{ id: 'one', label: '自选接口', url: 'https://feedback.example/v1' }]);
});
