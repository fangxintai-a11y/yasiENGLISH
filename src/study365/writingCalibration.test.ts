import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHumanWritingCalibration, buildWritingHandoff, calibrationForWork, calibrationWeekIndex, pendingWritingHandoffs, writingExportText, writingHandoffId } from './writingCalibration';
import { hashPayload, validatePayload, type LearningPayload, type Revision } from './protocol';

function record(kind: Revision['kind'], payload: LearningPayload, id = 'record-one'): Revision {
  return { id, kind, payload, planId: 'plan-one', datasetId: null, revisionId: '11111111-1111-4111-8111-111111111111', baseRevision: null, contentHash: 'a'.repeat(64), seq: 1, createdAt: 1, conflict: false, deleted: false };
}
const plan = record('plan', { planId: 'plan-one', startDate: '2026-11-09', timeZone: 'Asia/Shanghai' }, 'plan-one');
const bands = { taskResponse: 7.5, coherence: 7, lexical: 7.5, grammar: 7 };
async function work(taskType: 'task1' | 'task2' = 'task2') {
  const text = 'Original submitted draft.';
  return { ...record('essay', { planId: plan.id, date: '2026-11-15', taskType, scope: 'full', stage: 'submitted', text, prompt: 'Discuss transport.', sourceRef: '自备练习题' }, 'essay-one'), contentHash: await hashPayload('essay', { text }) };
}

test('human handoff is a stable zero-minute pending mission bound to one revision', async () => {
  const saved = await work(), payload = buildWritingHandoff(saved, '2026-11-15');
  assert.equal(payload.taskId, writingHandoffId(saved));
  assert.equal(payload.plannedMinutes, 0); assert.equal(payload.actualMinutes, 0); assert.equal(payload.status, 'in_progress');
  assert.doesNotThrow(() => validatePayload('mission', payload));
  const marker = record('mission', payload, writingHandoffId(saved));
  assert.equal(pendingWritingHandoffs([saved, marker], plan.id).length, 1);
  assert.equal(Object.hasOwn(payload, 'workRevisionId'), false);
});

test('received human bands bind the exported revision and never create a section score', async () => {
  const saved = await work();
  const payload = await buildHumanWritingCalibration(saved, plan, bands, '2026-11-23', '2026-11-15');
  assert.equal(payload.source, 'human'); assert.equal(payload.kind, 'weekly-calibration'); assert.equal(payload.weekIndex, 1);
  assert.equal(payload.workId, saved.id); assert.equal(payload.workRevisionId, saved.revisionId); assert.equal(payload.inputHash, saved.contentHash);
  assert.deepEqual(payload.bands, bands); assert.equal(Object.hasOwn(payload, 'scores'), false);
  assert.doesNotThrow(() => validatePayload('assessment', payload));
  const marker = record('mission', buildWritingHandoff(saved, '2026-11-15'), writingHandoffId(saved));
  const human = record('assessment', payload, 'human-one');
  assert.equal(pendingWritingHandoffs([saved, marker, human], plan.id).length, 0);
});

test('Task 1 human assessment uses Task Achievement and rejects Task Response', async () => {
  const saved = await work('task1');
  const payload = await buildHumanWritingCalibration(saved, plan, { taskAchievement: 7.5, coherence: 7, lexical: 7, grammar: 7.5 }, '2026-11-15');
  assert.deepEqual(Object.keys(payload.bands as object).sort(), ['taskAchievement', 'coherence', 'lexical', 'grammar'].sort());
  await assert.rejects(buildHumanWritingCalibration(saved, plan, bands, '2026-11-15'), /Task 1/);
});

test('human registration rejects missing bands, a different plan and changed original bytes', async () => {
  const saved = await work();
  await assert.rejects(buildHumanWritingCalibration(saved, plan, { ...bands, grammar: null }, '2026-11-15'), /四项有效分数/);
  await assert.rejects(buildHumanWritingCalibration(saved, { ...plan, id: 'plan-two' }, bands, '2026-11-15'), /计划不一致/);
  await assert.rejects(buildHumanWritingCalibration({ ...saved, payload: { ...saved.payload, text: 'Changed.' } }, plan, bands, '2026-11-15'), /原稿已变化/);
});

test('paragraph work cannot become a complete human calibration or handoff', async () => {
  const saved = await work(), paragraph = { ...saved, payload: { ...saved.payload, scope: 'paragraph' } };
  assert.throws(() => buildWritingHandoff(paragraph, '2026-11-15'), /完整/);
  await assert.rejects(buildHumanWritingCalibration(paragraph, plan, bands, '2026-11-15'), /完整/);
});

test('human display never crosses revision, hash, plan or conflict boundaries', async () => {
  const saved = await work(), payload = await buildHumanWritingCalibration(saved, plan, bands, '2026-11-15');
  const good = record('assessment', payload, 'good');
  const bad = [
    { ...good, id: 'old', payload: { ...payload, workRevisionId: '22222222-2222-4222-8222-222222222222' } },
    { ...good, id: 'hash', payload: { ...payload, inputHash: 'b'.repeat(64) } },
    { ...good, id: 'other', planId: 'plan-two' }, { ...good, id: 'conflict', conflict: true }, { ...good, id: 'deleted', deleted: true },
  ];
  assert.deepEqual(calibrationForWork([good, ...bad], saved).map(value => value.id), ['good']);
});

test('weekly indexing keeps Sunday in its own batch and the final extra day in week 52', () => {
  assert.equal(calibrationWeekIndex(plan, '2026-11-15'), 1);
  assert.equal(calibrationWeekIndex(plan, '2026-11-16'), 2);
  assert.equal(calibrationWeekIndex(plan, '2027-11-08'), 52);
});

test('export contains the original prompt, source, counted words and exact body', async () => {
  const saved = await work();
  const text = writingExportText(saved);
  assert.match(text, /题目：Discuss transport\./); assert.match(text, /出处：自备练习题/); assert.match(text, /字数：3/);
  assert.ok(text.endsWith(String(saved.payload.text)));
});
