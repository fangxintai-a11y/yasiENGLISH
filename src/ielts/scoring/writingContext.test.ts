import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptManual, manualPrompt, saveFeedbackConfig, scoreWriting, type WritingResult } from './index';
import { hashPayload } from '../../study365/protocol';

const revision = '11111111-1111-4111-8111-111111111111';
const criterion = { band: 7.5, confidence: 0.6, evidence: [] };
const body = { criteria: { taskResponse: criterion, coherence: criterion, lexical: criterion, grammar: criterion }, causes: [], summaryZh: '本版写作的参考反馈。', rewrite8: 'An improved reference.' };
async function input(text = 'Original submitted draft.') {
  return { taskType: 'task2' as const, prompt: 'Discuss transport.', text, feedbackContext: { workRevisionId: revision, inputHash: await hashPayload('essay', { text }) } };
}

test('R2 manual feedback rejects unbound old JSON even when evidence arrays are empty', async () => {
  const accepted = await acceptManual('essay', JSON.stringify(body), await input());
  assert.equal(accepted.ok, false);
});

test('R2 prompt schema requires exact saved revision and input hash literals', async () => {
  const value = await input();
  const prompt = manualPrompt('essay', value).text;
  const schema = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1));
  assert.equal(schema.properties.workRevisionId?.const, revision);
  assert.equal(schema.properties.inputHash?.const, value.feedbackContext.inputHash);
  assert.ok(schema.required.includes('workRevisionId'));
  assert.ok(schema.required.includes('inputHash'));
});

test('R2 correctly bound JSON becomes an ordinary strict WritingResult', async () => {
  const value = await input();
  const accepted = await acceptManual<WritingResult>('essay', JSON.stringify({ ...body, ...value.feedbackContext }), value);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.value.inputHash, value.feedbackContext.inputHash);
    assert.equal(accepted.value.source, 'ai');
    if (accepted.value.taskType !== 'task2') assert.fail('Expected Task 2 feedback.');
    assert.equal(accepted.value.criteria.taskResponse.band, 7.5);
    assert.equal(Object.hasOwn(accepted.value, 'workRevisionId'), false);
    assert.equal(Object.hasOwn(accepted.value, 'feedbackContext'), false);
  }
});

test('a previous revision context is rejected on a new draft even when the text is unchanged', async () => {
  const previous = await input();
  const current = { ...previous, feedbackContext: { ...previous.feedbackContext, workRevisionId: '22222222-2222-4222-8222-222222222222' } };
  assert.equal((await acceptManual('essay', JSON.stringify({ ...body, ...previous.feedbackContext }), current)).ok, false);
});

test('declared context hash must match actual UTF-8 text before external scoring', async () => {
  const previous = await input();
  const changed = { ...previous, text: previous.text + ' changed' };
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (() => { requests++; throw new Error('no external request expected'); }) as typeof fetch;
  try {
    await assert.rejects(scoreWriting(changed, { mode: 'auto' }), /原稿.*变化/);
    assert.equal(requests, 0);
    assert.equal((await acceptManual('essay', JSON.stringify({ ...body, ...previous.feedbackContext }), changed)).ok, false);
  } finally { globalThis.fetch = original; }
});

test('S0 manual callers without feedback context keep their original JSON shape', async () => {
  const accepted = await acceptManual<WritingResult>('essay', JSON.stringify(body), { taskType: 'task2', prompt: 'Discuss transport.', text: 'Original submitted draft.' });
  assert.equal(accepted.ok, true);
});

test('automatic R2 feedback validates literal binding and strips it before the original strict body', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  const original = globalThis.fetch;
  try {
    saveFeedbackConfig({ version: 1, providers: [{ id: 'test-one', kind: 'openai-compatible', label: '测试接口', baseURL: 'https://feedback.example/v1', model: 'chosen-model', jsonMode: 'json_schema', timeoutMs: 3000, tasks: ['essay'] }] });
    const value = await input(); let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.response_format.json_schema.schema.properties.workRevisionId.const, revision);
      assert.equal(request.response_format.json_schema.schema.properties.inputHash.const, value.feedbackContext.inputHash);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...body, ...value.feedbackContext }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const result = await scoreWriting(value, { mode: 'auto' });
    assert.equal(calls, 1); assert.equal(result.source, 'ai'); assert.equal(result.inputHash, value.feedbackContext.inputHash);
    assert.equal(Object.hasOwn(result, 'workRevisionId'), false);
  } finally {
    globalThis.fetch = original;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
