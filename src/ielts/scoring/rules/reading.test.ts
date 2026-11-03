import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReadingRules } from "./reading";
import { ReadingSchema } from "../schemas";
import { exampleEntry } from "../testFixtures";
import { sanitizeProgress } from "../../../store/store";
const words = ["benefit", "analysis", "approach", "evidence", "policy", "resource", "method", "context"].map((word, i) => ({ id: `word-${i}`, word, zh: "词义", entry: exampleEntry(word, i) }));
test("eight words produce deterministic reading questions with all three answer types", () => {
  const result = buildReadingRules({ words });
  assert.ok(result.questions.length >= 5 && result.questions.length <= 8);
  assert.deepEqual([...new Set(result.questions.map((q) => q.a))].sort(), ["FALSE", "NOT GIVEN", "TRUE"]);
  assert.equal(result.passage.split("\n\n").length >= 4, true);
  assert.deepEqual(result, buildReadingRules({ words }));
  ReadingSchema.parse(result);
});
test("every reading explanation cites an included original and not-given adds an absent claim", () => {
  const result = buildReadingRules({ words });
  for (const q of result.questions) {
    assert.ok(words.some((word) => word.entry.ex.some((ex) => result.passage.includes(ex.en) && q.why.includes(ex.en))));
    if (q.a === "NOT GIVEN") assert.equal(result.passage.includes(q.q), false);
  }
});
test("local reading remains compatible with existing progress sanitisation", () => {
  const result = buildReadingRules({ words });
  const value = { ...result, id: "local-test", at: 1, words: words.map((w) => w.id), answers: result.questions.map(() => null), src: "rules" };
  assert.equal(sanitizeProgress({ version: 2, datasetId: "fixture", readings: [value] }, "fixture").readings.length, 1);
});

test("ambiguous dictionary synonyms are offered for review rather than asserted equivalent", () => {
  const input = structuredClone(words); input[0].entry.syn = ["a financial institution"];
  const result = buildReadingRules({ words: input });
  for (const q of result.questions.filter((q) => q.a === "TRUE")) assert.ok(result.passage.includes(q.q));
  for (const q of result.questions.filter((q) => q.a === "FALSE")) assert.ok(q.q.startsWith("It is not true that "));
});
test("an alternative example already used by another entry is not treated as absent", () => {
  const input = structuredClone(words);
  // Put another entry's first sentence into an alternative-example slot.
  const shared = { en: "The evidence about analysis was recorded at the local laboratory.", zh: "当地实验室记录了该分析的证据。" };
  input[1].entry.ex[1] = shared; input[3].entry.ex[0] = shared;
  const result = buildReadingRules({ words: input });
  for (const q of result.questions.filter((q) => q.a === "NOT GIVEN")) {
    const alternative = /“(.*)”/.exec(q.q)?.[1];
    assert.ok(alternative);
    assert.equal(result.passage.includes(alternative), false);
  }
});


test("questions and requests in dictionary examples are not labelled TRUE facts", () => {
  const input = structuredClone(words);
  input[0].entry.ex = [{ en: "Can you explain the benefit?", zh: "你能解释益处吗？" }, { en: "Please explain the benefit.", zh: "请解释益处。" }];
  const result = buildReadingRules({ words: input });
  assert.equal(result.passage.includes("Can you explain"), false);
  assert.equal(result.questions.some((q) => q.a === "TRUE" && q.q.includes("?")), false);
});
test("not-given asks about undisclosed selection rather than a year the text can refute", () => {
  const input = structuredClone(words);
  input[1].entry.ex = [{ en: "No research about this analysis was published before 2000.", zh: "2000年前没有相关研究。" }, { en: "The analysis was used in several projects.", zh: "该分析用于多个项目。" }];
  const result = buildReadingRules({ words: input });
  const q = result.questions.find((item) => item.a === "NOT GIVEN" && item.why.includes("No research"));
  assert.ok(q); assert.ok(q.q.startsWith("The compiler preferred this alternative example"));
  assert.ok(q.why.includes("The compiler gives no information about the choice or ranking of alternative examples."));
  assert.equal(q.q.includes("1998"), false);
});
test("a confirmed benefit noun context has a controlled synonym paraphrase", () => {
  const result = buildReadingRules({ words });
  assert.ok(result.questions.some((q) => q.a === "TRUE" && q.q.includes("advantage of")));
});
