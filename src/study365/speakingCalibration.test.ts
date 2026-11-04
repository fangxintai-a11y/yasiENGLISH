import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHumanSpeakingCalibration, humanSpeakingId, speakingCalibrationForWork, speakingCalibrationRows } from './speakingCalibration';
import { hashPayload, validatePayload, type LearningPayload, type Revision } from './protocol';
import { latestEffectiveBySkill } from './scoresModel';
function record(kind: Revision['kind'], payload: LearningPayload, id = 'record-one'): Revision {
  return { id, kind, payload, planId: 'plan-one', datasetId: null, revisionId: '33333333-3333-4333-8333-333333333333', baseRevision: null, contentHash: 'a'.repeat(64), seq: 1, createdAt: 1, conflict: false, deleted: false };
}
const plan = record('plan', { startDate: '2026-11-09', timeZone: 'Asia/Shanghai' }, 'plan-one');
const bands = { fluency: 7.5, lexical: 8, grammar: 7.5, pronunciation: 7 };
async function work(transcript = 'Original spoken answer.') {
  return { ...record('speaking', { planId: plan.id, date: '2026-11-15', part: 2, transcript, prompt: 'Describe a journey.', durationSeconds: 120 }, 'speaking-one'), contentHash: await hashPayload('speaking', { transcript }) };
}
test('human speaking calibration binds four speaking criteria to the exact transcript and keeps section score unassessed', async () => {
  const saved = await work(), payload = await buildHumanSpeakingCalibration(saved, plan, bands, '2026-11-23');
  assert.equal(payload.source, 'human'); assert.equal(payload.kind, 'weekly-calibration'); assert.equal(payload.weekIndex, 1);
  assert.equal(payload.workRevisionId, saved.revisionId); assert.equal(payload.workId, saved.id); assert.equal(payload.inputHash, saved.contentHash);
  assert.deepEqual(payload.bands, bands); assert.equal(Object.hasOwn(payload, 'taskType'), false); assert.equal(Object.hasOwn(payload, 'scores'), false);
  assert.doesNotThrow(() => validatePayload('assessment', payload));
  assert.equal(latestEffectiveBySkill([record('assessment', payload)], plan.id).speaking, null);
  assert.equal(humanSpeakingId(saved), `speaking-human:${saved.revisionId}`);
});
test('missing, invalid or writing criteria cannot be recorded as human speaking calibration', async () => {
  const saved = await work();
  await assert.rejects(buildHumanSpeakingCalibration(saved, plan, { ...bands, grammar: null }, '2026-11-15'), /四项有效分数/);
  await assert.rejects(buildHumanSpeakingCalibration(saved, plan, { ...bands, fluency: 7.2 }, '2026-11-15'));
  await assert.rejects(buildHumanSpeakingCalibration(saved, plan, { taskResponse: 8, coherence: 8, lexical: 8, grammar: 8 }, '2026-11-15'), /作文评分必须明确任务类型/);
});
test('changed transcript, another plan, and an essay cannot become speaking calibration', async () => {
  const saved = await work();
  await assert.rejects(buildHumanSpeakingCalibration({ ...saved, payload: { ...saved.payload, transcript: 'Changed.' } }, plan, bands, '2026-11-15'), /转写已变化/);
  await assert.rejects(buildHumanSpeakingCalibration(saved, { ...plan, id: 'plan-two' }, bands, '2026-11-15'), /计划不一致/);
  await assert.rejects(buildHumanSpeakingCalibration({ ...saved, kind: 'essay' }, plan, bands, '2026-11-15'), /口语作答/);
});
test('human calibration reader never crosses revision, hash, plan, source or deletion boundaries', async () => {
  const saved = await work(), payload = await buildHumanSpeakingCalibration(saved, plan, bands, '2026-11-15'), good = record('assessment', payload, 'good');
  const bad = [
    { ...good, id: 'old', payload: { ...payload, workRevisionId: '44444444-4444-4444-8444-444444444444' } },
    { ...good, id: 'hash', payload: { ...payload, inputHash: 'b'.repeat(64) } },
    { ...good, id: 'plan', planId: 'plan-two' }, { ...good, id: 'conflict', conflict: true }, { ...good, id: 'deleted', deleted: true },
    { ...good, id: 'ai', payload: { ...payload, source: 'ai' } },
  ];
  assert.deepEqual(speakingCalibrationForWork([good, ...bad], saved).map(item => item.id), ['good']);
});
test('same-version rows keep missing human null and text AI physical criteria unassessed', async () => {
  const saved = await work(), payload: LearningPayload = { planId: plan.id, workId: saved.id, workRevisionId: saved.revisionId, inputHash: saved.contentHash, taskType: 'speaking', bands, text: '回听参考。' };
  const self = record('feedback', { ...payload, source: 'self' }, 'self'), ai = record('feedback', { ...payload, source: 'ai' }, 'ai');
  const rows = speakingCalibrationRows([self, ai], saved);
  assert.equal(rows[0].bands.fluency, 7.5); assert.equal(rows[1].bands.fluency, null); assert.equal(rows[1].bands.pronunciation, null); assert.equal(rows[1].bands.lexical, 8);
  assert.ok(Object.values(rows[2].bands).every(value => value === null));
});
test('empty manual transcript may receive actual human feedback without fabricating text or a section score', async () => {
  const saved = await work(''), payload = await buildHumanSpeakingCalibration(saved, plan, bands, '2026-11-15');
  assert.equal(payload.inputHash, saved.contentHash); assert.equal(Object.hasOwn(payload, 'scores'), false);
});
