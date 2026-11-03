import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceSchema, SpeakingFeedbackSchema, Task1FeedbackSchema, Task2FeedbackSchema } from "./schemas";
const criterion = { band: 7.5, confidence: .6, evidence: [] };
const task2 = { criteria: { taskResponse: criterion, coherence: criterion, lexical: criterion, grammar: criterion }, causes: [], rewrite8: "", summaryZh: "维度反馈。" };
for (const band of [7.3, -1, 9.5]) test(`schema rejects invalid band ${band} at its criterion path`, () => {
  const parsed = Task2FeedbackSchema.safeParse({ ...task2, criteria: { ...task2.criteria, grammar: { ...criterion, band } } });
  assert.equal(parsed.success, false); if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "criteria.grammar.band"));
});
test("Task 1 rejects a Task Response dimension rather than silently discarding it", () => {
  const parsed = Task1FeedbackSchema.safeParse(task2); assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.path.includes("taskAchievement") || issue.code === "unrecognized_keys"));
});
test("unknown error cause strings are rejected", () => {
  const parsed = Task2FeedbackSchema.safeParse({ ...task2, causes: ["随意判断"] });
  assert.equal(parsed.success, false); if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "causes.0"));
});
test("pronunciation confidence cannot exceed the text evidence limit", () => {
  const value = { criteria: { fluency: criterion, lexical: criterion, grammar: criterion, pronunciation: criterion }, causes: [], rewrite8: "", summaryZh: "文字依据有限。" };
  const parsed = SpeakingFeedbackSchema.safeParse(value); assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "criteria.pronunciation.confidence"));
});
test("metric evidence requires the measured value", () => {
  assert.equal(EvidenceSchema.safeParse({ kind: "metric", message: "缺少数值。" }).success, false);
});
test("span evidence requires original text and offsets", () => {
  assert.equal(EvidenceSchema.safeParse({ kind: "span", message: "缺少原文。" }).success, false);
});
