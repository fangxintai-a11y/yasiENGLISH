import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Entry } from "./types";

test("text-only IELTS supplements are attributed, complete and do not replace existing IDs", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"));
  const base = read("public/atlas/index.json");
  const supplement = read("public/atlas/supplement.json") as {
    metadata: { commit: string; sourceLicense: string };
    entries: Entry[];
  };
  const source = read("data/sources/qwerty-ielts-supplement.json");
  const ids = new Set<string>(base.words.map((row: string[]) => row[0]));
  const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const covered = new Set(base.words.map((row: string[]) => normal(row[1])));
  assert.match(supplement.metadata.commit, /^[a-f0-9]{40}$/);
  assert.equal(supplement.metadata.sourceLicense, "GPL-3.0");
  assert.equal(supplement.entries.length, 2562);
  for (const entry of supplement.entries) {
    assert.ok(!ids.has(entry.id), entry.id);
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]{0,79}$/);
    assert.ok(
      entry.senses.length > 0 &&
        entry.senses.every((sense) => /[\u4e00-\u9fff]/.test(sense.zh)),
    );
    assert.equal(entry.m, 0, "missing media must not be advertised as present");
    assert.equal(entry.cefr, "未分级", "never invent difficulty labels");
    ids.add(entry.id);
    covered.add(normal(entry.w));
  }
  assert.equal(ids.size, 9860);
  for (const row of source.words)
    assert.ok(covered.has(normal(row.name)), row.name);
  for (const word of ["induce", "manuscript", "b/l", "c/o", "l/c"])
    assert.ok(covered.has(normal(word)), word);
});
