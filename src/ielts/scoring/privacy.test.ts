import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptManual, manualPrompt, scoreWriting, toFeedbackPayload } from "./index";
import { scoreWritingRules } from "./rules/writing";
for (const [label, secret] of [["general", `sk-${"A".repeat(24)}`], ["project", `sk-proj-${"B".repeat(24)}`], ["service", `xai-${"C".repeat(36)}`], ["browser", `AIza${"D".repeat(32)}`]] as const) {
  test(`scoring blocks ${label} credentials before local facade or external prompt creation`, async () => {
    const input = { taskType: "task2" as const, prompt: "Discuss transport.", text: `Original ${secret} remains on this device.` };
    const original = input.text;
    await assert.rejects(scoreWriting(input, { mode: "auto" }), /密钥/);
    assert.throws(() => manualPrompt("essay", input), /密钥/);
    assert.equal(input.text, original);
  });
  test(`P1 mapping blocks ${label} credentials even when given a direct local rule result`, async () => {
    const text = `Private draft ${secret}`;
    const local = await scoreWritingRules({ taskType: "task2", prompt: "Discuss.", text });
    await assert.rejects(toFeedbackPayload(local, { planId: "plan-one", workId: "essay-one", workRevisionId: "11111111-1111-4111-8111-111111111111", text }), /密钥/);
  });
}
test("manual output cannot insert a credential into an otherwise valid result", async () => {
  const secret = `xai-${"E".repeat(36)}`;
  const value = { score: 2, usedCorrectly: true, verdict: "表达清楚。", corrected: "Original sentence.", better: secret, notes: [] };
  const result = await acceptManual("sentence", JSON.stringify(value), { word: "benefit", zh: "益处", sentence: "Original sentence.", entry: null });
  assert.equal(result.ok, false); if (!result.ok) { assert.ok(result.errors.some((message) => message.includes("密钥"))); assert.equal(result.errors.join().includes(secret), false); }
});
