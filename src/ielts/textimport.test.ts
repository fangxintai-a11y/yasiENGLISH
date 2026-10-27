import assert from "node:assert/strict";
import { test } from "node:test";
import { review, Rating } from "../store/srs";
import { analyzeText, baseForms, lookupIndex } from "./textimport";

const words = ["study", "abandon", "teach", "environment", "run", "happy", "analyse"].map((w, i) => ({ id: w, word: w, cefr: i % 6 }));
const index = lookupIndex(words);

test("finds the base form of inflected tokens", () => {
  assert.ok(baseForms("studies").includes("study"));
  assert.ok(baseForms("abandoned").includes("abandon"));
  assert.ok(baseForms("taught").includes("teach"));
  assert.ok(baseForms("running").includes("run"));
  assert.ok(baseForms("happier").includes("happy"));
});

test("reports new, weak and known words and the coverage", () => {
  const now = Date.UTC(2026, 9, 27);
  const cards = { teach: review(undefined, Rating.Good, now - 60000) };
  const r = analyzeText("Teachers taught the studies. The village was abandoned; the environment changed. Smith ran.", index, cards, now);
  const byId = Object.fromEntries(r.found.map((f) => [f.word.id, f]));
  assert.equal(byId.teach.status, "known");
  assert.equal(byId.teach.count, 1);
  assert.equal(byId.study.status, "new");
  assert.equal(byId.abandon.status, "new");
  assert.equal(byId.run.count, 1);
  assert.ok(r.outside.includes("smith"));
  assert.ok(r.coverage > 0 && r.coverage < 1);
});
