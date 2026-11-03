import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreWritingRules } from "./writing";
import { toFeedbackPayload } from "../calibration";
import { hashPayload, validatePayload } from "../../../study365/protocol";
for (const taskType of ["task1", "task2"] as const) test(`local ${taskType} preserves raw hash and unknown scores in valid P1 feedback`, async () => {
  const text = "  First paragraph.\r\n\r\n第二段 🌱\n";
  const result = await scoreWritingRules({ taskType, prompt: "Describe the topic.", text });
  const criterion = taskType === "task1" ? "taskAchievement" : "taskResponse";
  assert.deepEqual(Object.keys(result.criteria).sort(), [criterion, "coherence", "grammar", "lexical"].sort());
  assert.equal(result.inputHash, await hashPayload("essay", { text }));
  assert.ok(result.causes.includes("word-limit"));
  for (const value of Object.values(result.criteria)) { assert.equal(value.band, null); assert.equal(value.confidence, 0); assert.equal(value.gap, null); }
  assert.equal(result.overall, null);
  const payload = await toFeedbackPayload(result, { planId: "plan-one", workId: "essay-one", workRevisionId: "11111111-1111-4111-8111-111111111111", text });
  validatePayload("feedback", payload); assert.equal(payload.inputHash, result.inputHash);
});
test("writing diagnostics include every requested local metric without inventing a band", async () => {
  const result = await scoreWritingRules({ taskType: "task2", prompt: "Should cities invest in transport?", text: "I agree that cities should improve transport because residents need reliable services.\n\nHowever, public services need funding. However, funding is limited. However, funding matters. However, funding requires planning.\n\nIn conclusion, I agree that cities should invest." });
  const ids = Object.values(result.criteria).flatMap((v) => v.evidence.map((e) => e.ruleId));
  for (const ruleId of ["w.wordcount.min250", "w.paragraphs", "w.task2.position", "w.task2.conclusion", "w.connectors.types", "w.sentences.mean", "w.sentences.deviation", "w.sentences.complex-ratio", "w.lexical.repetition", "w.prompt.overlap"]) assert.ok(ids.includes(ruleId), ruleId);
});
