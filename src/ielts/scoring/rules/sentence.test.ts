import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreSentenceRules } from "./sentence";
import { exampleEntry } from "../testFixtures";
const entry = exampleEntry();
const input = (sentence: string) => ({ word: "benefit", zh: "益处", sentence, entry });
for (const [expected, sentence] of [
  [0, "Regular exercise helps people maintain their physical and mental health."], [0, "This is an unrelated statement about a quiet library."],
  [1, "A real benefit."], [1, "People benefit."],
  [2, "This programme offers a benefit to local residents every week."], [2, "I recognise a benefit in this proposal for our community."],
  [3, "The benefit of this reliable service becomes clear when residents compare their daily journeys."],
  [3, "People can benefit from this course because it provides useful practice for unfamiliar tasks."],
] as const) test(`local sentence score ${expected}: ${sentence}`, () => {
  assert.equal(scoreSentenceRules(input(sentence)).score, expected);
});
test("local sentence recognises ordinary inflections and entry families", () => {
  for (const word of ["benefits", "benefited", "benefiting"]) assert.notEqual(scoreSentenceRules(input(`Residents ${word} from a reliable service in their local area.`)).score, 0);
  assert.notEqual(scoreSentenceRules({ ...input("Sustainability is important because resources are limited in every community."), word: "sustain", entry: { ...entry, fam: ["sustainability"] } }).score, 0);
});
test("copying a dictionary example is scored 1 with overlap evidence", () => {
  const result = scoreSentenceRules(input(entry.ex[0].en));
  assert.equal(result.score, 1);
  assert.ok(result.evidence.some((e) => e.ruleId === "s.copy.4gram" && Number(e.value) >= .6));
});
test("sentence rules are deterministic and never call the network", () => {
  const original = globalThis.fetch; globalThis.fetch = (() => { throw new Error("不应联网"); }) as typeof fetch;
  try { const value = input("Residents benefit from reliable transport because it gives them access to more suitable jobs.");
    assert.deepEqual(scoreSentenceRules(value), scoreSentenceRules(value));
  } finally { globalThis.fetch = original; }
});
