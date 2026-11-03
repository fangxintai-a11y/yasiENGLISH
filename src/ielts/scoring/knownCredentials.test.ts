import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptManual, manualPrompt, saveFeedbackConfig, scoreWriting, setCredential, toFeedbackPayload } from "./index";
import { scoreWritingRules } from "./rules/writing";
const secret = "private-second-provider-credential";
async function withConfiguredCredential(run: () => Promise<void>) {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), originalFetch = globalThis.fetch;
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    saveFeedbackConfig({ version: 1, providers: ["primary", "secondary"].map((id) => ({ id, kind: "openai-compatible" as const, label: id, baseURL: `https://${id}.example/v1`, model: "user-model", jsonMode: "json_schema" as const, timeoutMs: 1000, tasks: ["essay" as const] })) });
    setCredential("primary", "first-pass"); setCredential("secondary", secret);
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
}
test("a second provider long credential pasted in a task is blocked before any fetch", async () => {
  await withConfiguredCredential(async () => {
    let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error("不应发送"); }) as typeof fetch;
    await assert.rejects(scoreWriting({ taskType: "task2", prompt: "Discuss transport.", text: `Draft contains ${secret}.` }, { mode: "auto" }), /密钥/);
    assert.equal(calls, 0);
  });
});
test("manual prompt creation refuses an arbitrary configured credential", async () => {
  await withConfiguredCredential(async () => {
    assert.throws(() => manualPrompt("essay", { taskType: "task2", prompt: "Discuss.", text: secret }), /密钥/);
  });
});
test("manual results refuse a configured credential outside known token formats", async () => {
  await withConfiguredCredential(async () => {
    const result = await acceptManual("sentence", JSON.stringify({ score: 2, usedCorrectly: true, verdict: "表达清楚。", corrected: "Original.", better: secret, notes: [] }), { word: "benefit", zh: "益处", sentence: "Original.", entry: null });
    assert.equal(result.ok, false); if (!result.ok) { assert.ok(result.errors.some((message) => message.includes("密钥"))); assert.equal(result.errors.join().includes(secret), false); }
  });
});
test("P1 facade mapping refuses a configured credential while keeping the original intact", async () => {
  await withConfiguredCredential(async () => {
    const text = `Original ${secret}`;
    const local = await scoreWritingRules({ taskType: "task2", prompt: "Discuss.", text });
    await assert.rejects(toFeedbackPayload(local, { planId: "plan-one", workId: "essay-one", workRevisionId: "11111111-1111-4111-8111-111111111111", text }), /密钥/);
    assert.equal(text, `Original ${secret}`);
  });
});
