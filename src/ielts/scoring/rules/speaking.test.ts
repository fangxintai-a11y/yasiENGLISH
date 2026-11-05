import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreSpeakingRules } from "./speaking";
test("timestamped speech has exact rate pauses filler ratio and mean run length", async () => {
  const result = await scoreSpeakingRules({ part: 1, prompt: "Tell me about work.", transcript: "um I I work", durationSeconds: 10,
    words: [{ w: "um", start: 0, end: .5 }, { w: "I", start: .6, end: 1 }, { w: "I", start: 2.5, end: 3 }, { w: "work", start: 3.1, end: 4 }] });
  const metrics = new Map(Object.values(result.criteria).flatMap((v) => v.evidence).filter((e) => e.metric).map((e) => [e.metric, e.value]));
  assert.equal(metrics.get("wordsPerMinute"), 24); assert.equal(metrics.get("pausesPerMinute"), 6);
  assert.equal(metrics.get("meanRunLength"), 2); assert.equal(metrics.get("fillerRatio"), .25); assert.equal(metrics.get("repetitions"), 1);
  for (const value of Object.values(result.criteria)) { assert.equal(value.band, null); assert.equal(value.confidence, 0); }
});
test("short Part 2 answers warn without fabricating pronunciation or fluency grades", async () => {
  const result = await scoreSpeakingRules({ part: 2, prompt: "Describe a skill.", transcript: "I learned cooking.", durationSeconds: 60, cueCardPoints: ["who helped you"] });
  assert.ok(result.warnings.some((text) => text.includes("100"))); assert.equal(result.overall, null);
  assert.ok(Object.values(result.criteria).every((value) => value.band === null && value.confidence === 0));
});
