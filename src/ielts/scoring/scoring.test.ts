import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptManual, buildHack, buildReading, manualPrompt, needsManualFallback, scoreSentence, scoreSpeaking, scoreWriting, toCalibrationSidecar, toFeedbackPayload,
  type ReadingResult, type SentenceResult, type WritingResult } from "./index";
import { hashPayload, validatePayload } from "../../study365/protocol";
import { exampleEntry } from "./testFixtures";
const criterion = { band: 7.5, confidence: .6, evidence: [] };
const task2 = { criteria: { taskResponse: criterion, coherence: criterion, lexical: criterion, grammar: criterion }, causes: [], rewrite8: "An example revision.", summaryZh: "维度反馈参考。" };
const words = ["benefit", "analysis", "approach", "evidence", "policy", "resource", "method", "context"].map((word, index) => ({ id: `word-${index}`, word, zh: "词义", entry: exampleEntry(word, index) }));
test("all five local facade calls are network free and preserve their strict result shapes", async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (() => { requests++; throw new Error("不应联网"); }) as typeof fetch;
  try {
    const context = { mode: "rules" as const, now: 42 };
    assert.equal((await scoreSentence({ word: "benefit", zh: "益处", sentence: "Residents benefit from transport because reliable services connect them with more suitable jobs.", entry: exampleEntry() }, context)).source, "rules");
    const reading = await buildReading({ words }, context); assert.equal(reading.at, 42); assert.equal(reading.answers.length, reading.questions.length);
    assert.equal((await buildHack({ word: "focus", ipa: "", zh: "关注", syllables: null, mnemonic: null }, context)).at, 42);
    assert.equal((await scoreWriting({ taskType: "task2", prompt: "Discuss transport.", text: "Original draft." }, context)).assessedAt, 42);
    assert.equal((await scoreSpeaking({ part: 1, prompt: "Work?", transcript: "I work nearby.", durationSeconds: 5 }, context)).source, "rules");
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});
test("manual mode first returns the same local sentence result", async () => {
  const input = { word: "benefit", zh: "益处", sentence: "Residents benefit from a reliable service in the local area.", entry: exampleEntry() };
  assert.deepEqual(await scoreSentence(input, { mode: "rules", now: 1 }), await scoreSentence(input, { mode: "manual", now: 1 }));
});
test("manual prompts contain JSON Schema with the correct Task 1 dimension", () => {
  const value = manualPrompt("essay", { taskType: "task1", prompt: "Describe the table.", text: "Original." });
  assert.ok(value.text.includes('"$schema"')); assert.ok(value.text.includes('"taskAchievement"'));
  assert.equal(value.schemaName, "task1");
});
test("manual Task 2 result maps exact original UTF-8 bytes into valid P1 feedback and sidecar", async () => {
  const text = "  Original draft.\r\n第二段 🌱\n";
  const accepted = await acceptManual<WritingResult>("essay", JSON.stringify(task2), { taskType: "task2", prompt: "Discuss.", text });
  assert.equal(accepted.ok, true); if (!accepted.ok) return;
  assert.equal(accepted.value.source, "ai"); assert.equal(accepted.value.provider, "manual");
  assert.equal(accepted.value.inputHash, await hashPayload("essay", { text }));
  assert.equal(accepted.value.criteria.grammar.gap, 0);
  const work = { planId: "plan-one", workId: "essay-one", workRevisionId: "11111111-1111-4111-8111-111111111111", text };
  validatePayload("feedback", await toFeedbackPayload(accepted.value, work));
  const sidecar = toCalibrationSidecar(accepted.value); assert.equal(sidecar.machineSource, "ai");
  validatePayload("assessment", { planId: work.planId, kind: "weekly-calibration", weekIndex: 1, source: "human", workRevisionId: work.workRevisionId, inputHash: accepted.value.inputHash, taskType: "task2", bands: sidecar.machineBands, ...sidecar });
});
test("P1 mapping rejects an edited original instead of normalising away whitespace", async () => {
  const result = await scoreWriting({ taskType: "task2", prompt: "Discuss.", text: "  Draft.\r\n" }, { mode: "rules", now: 0 });
  await assert.rejects(toFeedbackPayload(result, { planId: "plan-one", workId: "essay-one", workRevisionId: "11111111-1111-4111-8111-111111111111", text: "Draft." }), /原稿已经变化/);
});
test("manual writing rejects spans that do not match exact original offsets", async () => {
  const body = structuredClone(task2);
  const value = { ...body, criteria: { ...body.criteria, grammar: { ...criterion, evidence: [{ kind: "span", text: "Draft.", start: 0, end: 6, message: "核对原稿。" }] } } };
  const accepted = await acceptManual("essay", JSON.stringify(value), { taskType: "task2", prompt: "Discuss.", text: "  Draft.\r\n" });
  assert.equal(accepted.ok, false); if (!accepted.ok) assert.ok(accepted.errors.some((message) => message.includes("criteria.grammar")));
});
test("manual reading returns the complete persistable reading envelope", async () => {
  const reading = await buildReading({ words }, { mode: "rules", now: 1 });
  const { title, passage, zh, questions } = reading;
  const accepted = await acceptManual<ReadingResult>("reading", JSON.stringify({ title, passage, zh, questions }), { words });
  assert.equal(accepted.ok, true); if (!accepted.ok) return;
  assert.equal(accepted.value.src, "manual"); assert.equal(accepted.value.words.length, words.length);
  assert.equal(accepted.value.answers.length, questions.length); assert.equal(typeof accepted.value.id, "string");
});
test("automatic mode with no provider preserves local work and requests manual follow-up", async () => {
  const result = await scoreSentence({ word: "benefit", zh: "益处", sentence: "Residents benefit from a reliable service in their own community.", entry: exampleEntry() }, { mode: "auto", now: 1 });
  assert.equal(result.source, "rules"); assert.equal(needsManualFallback(result), true); assert.ok(result.fallbackTrail.length);
});
test("a successful provider fallback does not request manual replacement", () => {
  const success = { needsManual: false, fallbackTrail: [{ provider: "first", error: "auth" as const }] };
  assert.equal(needsManualFallback(success), false);
});
test("pre-cancelled scoring does not send or return a replacement result", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scoreSentence({ word: "benefit", zh: "益处", sentence: "Original.", entry: null }, { mode: "auto", signal: controller.signal }), /取消/);
});
test("manual sentence is strictly validated before source and provider are attached", async () => {
  const input = { word: "benefit", zh: "益处", sentence: "Original sentence.", entry: null };
  const accepted = await acceptManual<SentenceResult>("sentence", JSON.stringify({ score: 2, usedCorrectly: true, verdict: "表达基本清楚。", corrected: "Original sentence.", better: "A reference sentence.", notes: [] }), input);
  assert.equal(accepted.ok, true); if (accepted.ok) { assert.equal(accepted.value.source, "ai"); assert.equal(accepted.value.provider, "manual"); }
  assert.equal((await acceptManual("sentence", '{"score":7.3}', input)).ok, false);
});
