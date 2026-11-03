import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHackRules } from "./hack";
test("memory splitting follows syllables and preserves every spelling letter", () => {
  const result = buildHackRules({ word: "sustainable", ipa: "", zh: "可持续的", syllables: "sus·tain·a·ble", mnemonic: { affix: "-able：能够" } });
  assert.equal(result.split.split("；")[0].replaceAll("·", ""), "sustainable");
  assert.ok(result.split.includes("-able")); assert.equal(result.homophone, ""); assert.equal(result.scene, "");
});
test("missing or contradictory syllables fall back to spelling letters", () => {
  for (const syllables of [null, "wrong·data"]) {
    const result = buildHackRules({ word: "focus", ipa: "", zh: "关注", syllables, mnemonic: null });
    assert.equal(result.split, "f·o·c·u·s");
  }
});
