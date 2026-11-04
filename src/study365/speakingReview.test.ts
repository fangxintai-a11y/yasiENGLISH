import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpeakingSelfReview, emptySpeakingReview, restoreSpeakingReview, runSpeakingRules, speakingFeedbackForWork } from './speakingReview';
import { speakingCauseOptions, speakingRubric } from './speakingRubric';
import { SPEAKING_CHECKLIST_IDS, SPEAKING_ERROR_CAUSES } from './speakingChecklist';
import { hashPayload, validatePayload, type LearningPayload, type Revision } from './protocol';

async function work(transcript = 'I like travelling because it helps me understand other places.', durationSeconds = 110): Promise<Revision> {
  return { id: 'speaking-one', kind: 'speaking', planId: 'plan-one', datasetId: null, revisionId: '33333333-3333-4333-8333-333333333333', baseRevision: null, seq: 1, createdAt: 1, deleted: false, conflict: false, contentHash: await hashPayload('speaking', { transcript }), payload: { planId: 'plan-one', date: '2026-11-15', part: 2, prompt: 'Describe a journey.', transcript, durationSeconds, prepSeconds: 60, recordingStatus: 'none', recordingId: null } };
}
function feedback(payload: LearningPayload, id = 'feedback-one'): Revision {
  return { id, kind: 'feedback', planId: 'plan-one', datasetId: null, revisionId: '44444444-4444-4444-8444-444444444444', baseRevision: null, contentHash: 'a'.repeat(64), seq: 1, createdAt: 1, deleted: false, conflict: false, payload };
}

test('speaking rubric uses the one fixed ID source with two or three checks for each dimension', () => {
  const items = speakingRubric();
  assert.deepEqual(items.map(item => item.id), SPEAKING_CHECKLIST_IDS);
  for (const dimension of ['fluency', 'lexical', 'grammar', 'pronunciation']) {
    const group = items.filter(item => item.dimension === dimension);
    assert.ok(group.length >= 2 && group.length <= 3, dimension);
    assert.ok(group.every(item => typeof item.label === 'string' && item.label.length > 5));
  }
  assert.deepEqual(speakingCauseOptions().map(item => item.id), SPEAKING_ERROR_CAUSES);
  assert.equal(speakingCauseOptions().length, 12);
});

test('speaking rules return only unassessed dimensions and evidence without external requests', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('no external request expected'); }) as typeof fetch;
  try {
    const saved = await work(), { result, payload } = await runSpeakingRules(saved);
    for (const value of Object.values(result.criteria)) { assert.equal(value.band, null); assert.equal(value.confidence, 0); }
    assert.equal(result.overall, null); assert.equal(payload.source, 'rules'); assert.equal(payload.taskType, 'speaking');
    assert.deepEqual(payload.bands, { fluency: null, lexical: null, grammar: null, pronunciation: null });
    assert.equal(payload.workRevisionId, saved.revisionId); assert.equal(payload.inputHash, saved.contentHash);
    assert.doesNotThrow(() => validatePayload('feedback', payload)); assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('R3 Part 2 evidence consistently requires 120 seconds rather than the legacy 100-second threshold', async () => {
  const short = await runSpeakingRules(await work(undefined, 110));
  assert.ok(short.result.warnings.some(value => value.includes('不足120秒')));
  assert.doesNotMatch(String(short.payload.text), /100至120|不足100/);
  const full = await runSpeakingRules(await work(undefined, 120));
  assert.equal(full.result.warnings.some(value => value.includes('不足120秒')), false);
});

test('empty manual transcript can keep a self-review but does not run local text analysis', async () => {
  const saved = await work('');
  const payload = await buildSpeakingSelfReview(saved, emptySpeakingReview());
  assert.equal(payload.inputHash, saved.contentHash); assert.equal(payload.source, 'self');
  await assert.rejects(runSpeakingRules(saved), /先填写手动转写/);
});

test('self checklist, optional bands and allowed error causes bind exact transcript revision', async () => {
  const saved = await work(), state = emptySpeakingReview();
  state.checklist[SPEAKING_CHECKLIST_IDS[0]] = true; state.errorCauses = ['fluency-pause', 'fluency-pause', 'pronunciation']; state.bands.fluency = 7;
  const payload = await buildSpeakingSelfReview(saved, state);
  assert.deepEqual(payload.errorCauses, ['fluency-pause', 'pronunciation']); assert.equal(payload.taskType, 'speaking');
  assert.equal(payload.workId, saved.id); assert.equal(payload.workRevisionId, saved.revisionId);
  assert.equal((payload.bands as Record<string, number | null>).fluency, 7);
  assert.equal(Object.hasOwn(payload, 'spellingCheck'), false); assert.equal(Object.hasOwn(payload, 'recordingId'), false);
  const restored = restoreSpeakingReview(feedback(payload)); assert.deepEqual(restored.checklist, state.checklist); assert.equal(restored.bands.fluency, 7);
});

test('invalid speaking causes, missing other explanation and changed transcript bytes are rejected', async () => {
  const saved = await work(), state = emptySpeakingReview();
  await assert.rejects(buildSpeakingSelfReview(saved, { ...state, errorCauses: ['task-response'] }), /允许范围/);
  await assert.rejects(buildSpeakingSelfReview(saved, { ...state, errorCauses: ['other'] }), /说明/);
  await assert.rejects(buildSpeakingSelfReview({ ...saved, payload: { ...saved.payload, transcript: 'changed' } }, state), /原稿已变化/);
});

test('speaking feedback never crosses plan, revision, hash or conflict boundaries', async () => {
  const saved = await work(), payload = await buildSpeakingSelfReview(saved, emptySpeakingReview());
  const good = feedback(payload);
  const bad = [
    { ...good, id: 'plan', planId: 'plan-two' }, { ...good, id: 'rev', payload: { ...payload, workRevisionId: '55555555-5555-4555-8555-555555555555' } },
    { ...good, id: 'hash', payload: { ...payload, inputHash: 'b'.repeat(64) } }, { ...good, id: 'conflict', conflict: true }, { ...good, id: 'deleted', deleted: true },
  ];
  assert.deepEqual(speakingFeedbackForWork([good, ...bad], saved).map(record => record.id), [good.id]);
});


test('R3 local transcript evidence includes word count and a qualified rough duration ratio', async () => {
  const saved = await work('I work here because I enjoy it. However, I also travel.', 30);
  const { result } = await runSpeakingRules(saved);
  const evidence = result.criteria.fluency.evidence;
  assert.equal(evidence.find(item => item.ruleId === 'r3.s.words')?.value, 11);
  assert.equal(evidence.find(item => item.ruleId === 'r3.s.roughRate')?.value, 22);
  assert.match(evidence.find(item => item.ruleId === 'r3.s.roughRate')?.message ?? '', /片段转写不能代表真实语速/);
  assert.equal(evidence.find(item => item.ruleId === 'r3.s.connectors')?.value, 3);
  const zero = await runSpeakingRules(await work('I work here.', 0));
  assert.equal(zero.result.criteria.fluency.evidence.some(item => item.ruleId === 'r3.s.roughRate'), false);
  assert.ok(zero.result.warnings.some(item => item.includes('时长为0')));
});
