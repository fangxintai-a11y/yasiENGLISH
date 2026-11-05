import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptManual, scoreSpeaking, type SpeakingResult } from '../ielts/scoring';
import { hashPayload, validatePayload, type Revision } from './protocol';
import { buildSpeakingFeedback, speakingFeedbackDestinations, speakingFeedbackInput } from './speakingFeedback';

async function work(transcript = 'Original spoken answer.'): Promise<Revision> {
  return { id: 'speaking-one', kind: 'speaking', planId: 'plan-one', datasetId: null, revisionId: '33333333-3333-4333-8333-333333333333', baseRevision: null, seq: 1, createdAt: 1, conflict: false, deleted: false, contentHash: await hashPayload('speaking', { transcript }), payload: { planId: 'plan-one', part: 2, prompt: 'Describe a journey.', transcript, durationSeconds: 120, recordingId: 'local-only', recordingStatus: 'local', prepSeconds: 60, date: '2026-11-15' } };
}
async function result(saved: Revision): Promise<SpeakingResult> {
  const estimate = { band: 7.5, confidence: 0.6, evidence: [] }, unassessed = { band: null, confidence: 0, evidence: [] };
  const input = speakingFeedbackInput(saved);
  const accepted = await acceptManual<SpeakingResult>('speaking', JSON.stringify({ criteria: { fluency: unassessed, lexical: estimate, grammar: estimate, pronunciation: unassessed }, causes: [], summaryZh: '转写参考反馈。', rewrite8: 'A speaking reference.', ...input.feedbackContext }), input);
  if (!accepted.ok) assert.fail(accepted.errors.join('\n'));
  return accepted.value;
}
test('R3 external input contains only Part, prompt, transcript, duration and exact feedback binding', async () => {
  const saved = await work();
  const input = speakingFeedbackInput(saved);
  assert.deepEqual(Object.keys(input).sort(), ['part', 'prompt', 'transcript', 'durationSeconds', 'feedbackContext'].sort());
  assert.equal(JSON.stringify(input).includes('local-only'), false);
  assert.equal(input.feedbackContext?.workRevisionId, saved.revisionId);
  assert.throws(() => speakingFeedbackInput({ ...saved, payload: { ...saved.payload, transcript: '' } }), /先填写.*转写/);
});
test('external speaking feedback saves only exact version AI estimates and never physical bands', async () => {
  const saved = await work(), payload = await buildSpeakingFeedback(saved, await result(saved), () => saved);
  assert.equal(payload.source, 'ai'); assert.equal(payload.taskType, 'speaking');
  assert.equal(payload.workRevisionId, saved.revisionId); assert.equal(payload.inputHash, saved.contentHash);
  assert.deepEqual(payload.bands, { fluency: null, lexical: 7.5, grammar: 7.5, pronunciation: null });
  assert.doesNotThrow(() => validatePayload('feedback', payload));
});
test('stale or unavailable current speaking work and physical scores are rejected', async () => {
  const saved = await work(), value = await result(saved);
  await assert.rejects(buildSpeakingFeedback(saved, value, () => null), /原稿已变化/);
  await assert.rejects(buildSpeakingFeedback(saved, value, () => ({ ...saved, revisionId: '44444444-4444-4444-8444-444444444444' })), /原稿已变化/);
  await assert.rejects(buildSpeakingFeedback(saved, { ...value, criteria: { ...value.criteria, fluency: { ...value.criteria.fluency, band: 8 } } }, () => saved), /文字反馈不能评估/);
});
test('rules fallback cannot masquerade as saved external feedback', async () => {
  const saved = await work(), original = structuredClone(saved);
  await assert.rejects(buildSpeakingFeedback(saved, await scoreSpeaking(speakingFeedbackInput(saved), { mode: 'rules' }), () => saved), /尚未成功/);
  assert.deepEqual(saved, original);
});
test('speaking destination display includes no credential metadata', () => {
  const provider = { id: 'one', kind: 'openai-compatible' as const, label: '自选接口', baseURL: 'https://feedback.example/v1', model: 'chosen-model', tasks: ['speaking' as const], jsonMode: 'json_schema' as const, timeoutMs: 3000 };
  assert.deepEqual(speakingFeedbackDestinations({ version: 1, providers: [provider, { ...provider, id: 'two', tasks: ['essay'] }, { ...provider, id: 'three', model: '' }] }), [{ id: 'one', label: '自选接口', url: 'https://feedback.example/v1' }]);
});
