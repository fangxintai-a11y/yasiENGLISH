import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptManual, manualPrompt, saveFeedbackConfig, scoreSpeaking, type SpeakingResult } from './index';
import { hashPayload } from '../../study365/protocol';

const revision = '33333333-3333-4333-8333-333333333333';
const estimate = { band: 7.5, confidence: 0.6, evidence: [] };
const unassessed = { band: null, confidence: 0, evidence: [] };
const body = { criteria: { fluency: unassessed, lexical: estimate, grammar: estimate, pronunciation: unassessed }, causes: [], summaryZh: '只依据这一版转写给出词汇语法反馈。', rewrite8: 'A speaking reference.' };
async function input(transcript = 'Original spoken answer.') {
  return { part: 2 as const, prompt: 'Describe a journey.', transcript, durationSeconds: 120, feedbackContext: { workRevisionId: revision, inputHash: await hashPayload('speaking', { transcript }) } };
}

test('R3 manual rejects unbound old speaking JSON with empty evidence arrays', async () => {
  assert.equal((await acceptManual('speaking', JSON.stringify(body), await input())).ok, false);
});

test('R3 speaking schema binds exact revision and transcript hash', async () => {
  const value = await input(), prompt = manualPrompt('speaking', value).text;
  const schema = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1));
  assert.equal(schema.properties.workRevisionId?.const, revision);
  assert.equal(schema.properties.inputHash?.const, value.feedbackContext.inputHash);
});

test('bound R3 text feedback permits lexical/grammar estimates but never a physical score or overall', async () => {
  const value = await input();
  const accepted = await acceptManual<SpeakingResult>('speaking', JSON.stringify({ ...body, ...value.feedbackContext }), value);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.value.criteria.fluency.band, null);
    assert.equal(accepted.value.criteria.pronunciation.band, null);
    assert.equal(accepted.value.criteria.lexical.band, 7.5);
    assert.equal(accepted.value.overall, null);
    assert.equal(accepted.value.inputHash, value.feedbackContext.inputHash);
  }
});

test('R3 text schema rejects fluency or pronunciation bands even with matching binding', async () => {
  const value = await input();
  for (const key of ['fluency', 'pronunciation'] as const) {
    const wire = { ...body, ...value.feedbackContext, criteria: { ...body.criteria, [key]: { band: 7.5, confidence: 0.2, evidence: [] } } };
    assert.equal((await acceptManual('speaking', JSON.stringify(wire), value)).ok, false);
  }
});

test('speaking actual transcript hash is checked before external requests', async () => {
  const value = await input(), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('no request expected'); }) as typeof fetch;
  try {
    await assert.rejects(scoreSpeaking({ ...value, transcript: value.transcript + ' changed' }, { mode: 'auto' }), /原稿.*变化/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('speaking context cannot be reused for another saved revision with identical text', async () => {
  const old = await input();
  assert.equal((await acceptManual('speaking', JSON.stringify({ ...body, ...old.feedbackContext }), { ...old, feedbackContext: { ...old.feedbackContext, workRevisionId: '44444444-4444-4444-8444-444444444444' } })).ok, false);
});

test('legacy S0 speaking and R2 writing inputs keep their original behavior', async () => {
  const old = { ...body, criteria: { ...body.criteria, fluency: estimate, pronunciation: { band: 7.5, confidence: 0.2, evidence: [] } } };
  assert.equal((await acceptManual('speaking', JSON.stringify(old), { part: 1, prompt: 'Where do you live?', transcript: 'I live nearby.', durationSeconds: 20 })).ok, true);
  const writing = { criteria: { taskResponse: estimate, coherence: estimate, lexical: estimate, grammar: estimate }, causes: [], summaryZh: '写作反馈。', rewrite8: '' };
  assert.equal((await acceptManual('essay', JSON.stringify(writing), { taskType: 'task2', prompt: 'Discuss.', text: 'Original draft.' })).ok, true);
});


test('R3 text-only schema forces both pronunciation and fluency bands to null', async () => {
  const value = await input(), prompt = manualPrompt('speaking', value).text;
  const schema = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1));
  assert.equal(schema.properties.criteria.properties.fluency.properties.band.type, 'null');
  assert.equal(schema.properties.criteria.properties.pronunciation.properties.band.type, 'null');
});

test('R3 speaking rejects recording metadata before any external request', async () => {
  const value = await input(), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('no request expected'); }) as typeof fetch;
  try {
    await assert.rejects(scoreSpeaking({ ...value, recordingId: 'local-recording-only' } as typeof value, { mode: 'auto' }));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('automatic R3 text-only speaking feedback validates literal binding and strips it before the original strict body', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  const original = globalThis.fetch;
  try {
    saveFeedbackConfig({ version: 1, providers: [{ id: 'test-one', kind: 'openai-compatible', label: '测试接口', baseURL: 'https://feedback.example/v1', model: 'chosen-model', jsonMode: 'json_schema', timeoutMs: 3000, tasks: ['speaking'] }] });
    const value = await input(); let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.response_format.json_schema.schema.properties.workRevisionId.const, revision);
      assert.equal(request.response_format.json_schema.schema.properties.inputHash.const, value.feedbackContext.inputHash);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...body, ...value.feedbackContext }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const result = await scoreSpeaking(value, { mode: 'auto' });
    assert.equal(calls, 1); assert.equal(result.source, 'ai'); assert.equal(result.inputHash, value.feedbackContext.inputHash);
    assert.equal(Object.hasOwn(result, 'workRevisionId'), false);
  } finally {
    globalThis.fetch = original;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
