import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReadingRules } from "./reading";
import { createControlledReport, renderControlledReading, selectControlledQuestions, type TopicId } from "./controlledReadings";
import { readingCoverage } from "./readingCoverage";
import { acceptManual, buildReading as buildReadingFacade, type ReadingResult } from "../index";
import { ReadingSchema } from "../schemas";
import { exampleEntry } from "../testFixtures";
import { sanitizeProgress } from "../../../store/store";
const targets = ["transport", "route", "passenger", "timetable", "fare", "benefit", "policy", "evidence"];
const input = (seed: number) => ({ words: targets.map((word, index) => ({ id: `word-${seed}-${index}`, word, zh: "词义", entry: { ...exampleEntry(word, index),
  ex: [{ en: `This disconnected dictionary example contains ${word}.`, zh: "孤立词典例句。" }, { en: `A separate dictionary example concerns ${word}.`, zh: "另一孤立例句。" }] } })) });
const reports = () => Array.from({ length: 72 }, (_, seed) => buildReadingRules(input(seed)));
const labels = (report: ReturnType<typeof buildReadingRules>) => report.questions.map((q) => q.a).join("|");

test("local reading is an authored connected article instead of concatenated dictionary examples", () => {
  const result = buildReadingRules(input(1));
  assert.equal(result.passage.includes("disconnected dictionary example"), false);
  assert.equal(result.passage.includes("separate dictionary example"), false);
  assert.ok(result.passage.split("\n\n").length >= 4);
  assert.ok(result.passage.split(/\s+/).length >= 220);
  ReadingSchema.parse(result);
});
test("every TRUE statement paraphrases rather than copies a source sentence", () => {
  for (const result of reports().slice(0, 12)) for (const q of result.questions.filter((q) => q.a === "TRUE")) assert.equal(result.passage.includes(q.q), false, q.q);
});
test("at least two identical statements change between TRUE FALSE and NOT GIVEN with the facts", () => {
  const observed = new Map<string, Set<string>>();
  for (const result of reports()) for (const q of result.questions) { const values = observed.get(q.q) ?? new Set<string>(); values.add(q.a); observed.set(q.q, values); }
  const variable = [...observed].filter(([, values]) => values.size === 3);
  assert.ok(variable.length >= 2, `only ${variable.length} same-statement fact-sensitive questions`);
});
test("neutral sentence prefixes are reused across all three labels", () => {
  const observed = new Map<string, Set<string>>();
  for (const result of reports()) for (const q of result.questions) { const prefix = q.q.toLowerCase().split(/\s+/).slice(0, 3).join(" "); const values = observed.get(prefix) ?? new Set<string>(); values.add(q.a); observed.set(prefix, values); }
  assert.ok([...observed.values()].some((values) => values.size === 3));
  assert.equal([...observed.values()].every((values) => values.size >= 2), true);
});
test("negation is used with TRUE FALSE and NOT GIVEN instead of signalling an answer", () => {
  const observed = new Set<string>();
  for (const result of reports()) for (const q of result.questions) if (/\bnot\b/i.test(q.q)) observed.add(q.a);
  assert.deepEqual([...observed].sort(), ["FALSE", "NOT GIVEN", "TRUE"]);
});
test("question order changes with the seed while each seed is deterministic", () => {
  assert.deepEqual(buildReadingRules(input(4)), buildReadingRules(input(4)));
  const values = reports();
  assert.ok(new Set(values.map(labels)).size > 3);
  for (const result of values) {
    assert.ok(result.questions.length >= 5 && result.questions.length <= 8);
    assert.deepEqual([...new Set(result.questions.map((q) => q.a))].sort(), ["FALSE", "NOT GIVEN", "TRUE"]);
  }
});
test("every explanation quotes actual article evidence and identifies missing attributes", () => {
  for (const result of reports().slice(0, 12)) for (const q of result.questions) {
    const quote = /原文：“([^”]+)”/.exec(q.why)?.[1];
    assert.ok(quote, q.why); assert.ok(result.passage.includes(quote), quote);
    if (q.a === "NOT GIVEN") { assert.ok(q.why.includes("未提供")); assert.equal(q.why.includes("编者"), false); }
  }
});
test("controlled articles remain compatible with existing reading progress", () => {
  const result = buildReadingRules(input(1));
  const value = { ...result, id: "local-test", at: 1, words: [], answers: result.questions.map(() => null), src: "rules" };
  assert.equal(sanitizeProgress({ version: 2, datasetId: "fixture", readings: [value] }, "fixture").readings.length, 1);
});


for (const topic of ["transport", "learning", "cooling"] as TopicId[]) test(`${topic} uses six independent facts without paired opposites in one paper`, () => {
  const statements = new Map<string, Set<string>>();
  for (const variant of [0, 1, 2] as const) for (let seed = 1; seed <= 32; seed++) {
    const report = createControlledReport(topic, variant, seed), selected = selectControlledQuestions(report, seed);
    assert.equal(selected.length, 6); assert.equal(new Set(selected.map((question) => question.fact)).size, 6);
    const result = renderControlledReading(report, seed);
    assert.deepEqual([...new Set(result.questions.map((q) => q.a))].sort(), ["FALSE", "NOT GIVEN", "TRUE"]);
    assert.equal(result.questions.length, 6);
    for (const q of result.questions) { const values = statements.get(q.q) ?? new Set<string>(); values.add(q.a); statements.set(q.q, values); }
    ReadingSchema.parse(result);
  }
  assert.ok([...statements.values()].filter((labels) => labels.size === 3).length >= 2);
});
test("zero word coverage is returned honestly without inserting unrelated candidate words", async () => {
  const words = ["galaxy", "telescope", "orchid", "molecule", "nebula"].map((word, index) => ({ id: `uncovered-${index}`, word, zh: "词义", entry: exampleEntry(word, index) }));
  const result = await buildReadingFacade({ words }, { mode: "rules", now: 1 });
  assert.deepEqual(result.words, []); assert.deepEqual(result.coverage.coveredWordIds, []);
  assert.deepEqual(result.coverage.uncoveredWordIds, words.map((word) => word.id));
  assert.deepEqual(result.coverage.requestedWordIds, words.map((word) => word.id));
  assert.equal(result.title.includes("错词"), false);
});
test("coverage uses whole words and regular inflections rather than substrings or unrelated family entries", () => {
  const words = ["cat", "an apple", "bus", "galaxy", "study"].map((word, index) => ({ id: `coverage-${index}`, word, zh: "词义", entry: { ...exampleEntry(word, index), fam: ["education"] } }));
  const result = readingCoverage({ words }, "Education can support studies. The buses can carry apples.");
  assert.deepEqual(result.coveredWordIds, ["coverage-2", "coverage-4"]);
  assert.deepEqual(result.uncoveredWordIds, ["coverage-0", "coverage-1", "coverage-3"]);
});
test("manual reading persistence also keeps only the candidate words actually present", async () => {
  const words = ["transport", "telescope", "orchid", "molecule", "nebula"].map((word, index) => ({ id: `manual-${index}`, word, zh: "词义", entry: exampleEntry(word, index) }));
  const local = await buildReadingFacade({ words }, { mode: "rules", now: 1 });
  const { title, passage, zh, questions } = local;
  const result = await acceptManual<ReadingResult>("reading", JSON.stringify({ title, passage, zh, questions }), { words });
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.deepEqual(result.value.words, ["manual-0"]);
  assert.deepEqual(result.value.coverage.uncoveredWordIds, ["manual-1", "manual-2", "manual-3", "manual-4"]);
});
