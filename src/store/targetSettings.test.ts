import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_TARGETS } from "../study365/protocol";
import { defaultSettings, emptyProgress, sanitizeSettings } from "./store";
import { mergeSnapshots } from "./syncMerge";
import { targetIds } from "../ielts/exam";

test("new settings use the single project overall target", () => {
  assert.equal(defaultSettings.targetBand, GATE_TARGETS.G4.overall);
});
test("reading old settings normalises the target and preserves the vocabulary budget", () => {
  const settings = sanitizeSettings({ targetBand: 6.5, dailyMinutes: 45 });
  assert.equal(settings.targetBand, GATE_TARGETS.G4.overall);
  assert.equal(settings.dailyMinutes, 45);
});
test("a legacy target from snapshot merging is normalised on settings read", () => {
  const snapshot = { progress: emptyProgress("test"), settings: { ...defaultSettings, targetBand: 6.5 } };
  const merged = mergeSnapshots(null, snapshot, snapshot);
  assert.equal(sanitizeSettings(merged.settings).targetBand, GATE_TARGETS.G4.overall);
});
test("the default target includes C1 along with listening and academic word lists", () => {
  const words = [{ id: "c1", cefr: 4, order: 0 }, { id: "listening", cefr: 5, order: 1 }, { id: "awl", cefr: 5, order: 2 }];
  const atlas = { words, byId: new Map(words.map((word) => [word.id, word])) };
  const ids = targetIds(atlas, defaultSettings.targetBand, { listening: { listening: "1.1" }, awl: { awl: 1 } });
  assert.deepEqual([...ids], ["c1", "listening", "awl"]);
});
