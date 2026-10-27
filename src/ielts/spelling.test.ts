import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnose, diffMarks, hasPattern, spelledRight, variants } from "./spelling";

test("British and American spellings are both accepted", () => {
  assert.ok(spelledRight("color", "colour"));
  assert.ok(spelledRight("colour", "color"));
  assert.ok(spelledRight("organize", "organise"));
  assert.ok(spelledRight("analyze", "analyse"));
  assert.ok(spelledRight("center", "centre"));
  assert.ok(spelledRight("traveled", "travelled"));
  assert.ok(spelledRight("program", "programme"));
  assert.ok(spelledRight("defense", "defence"));
});

test("unsafe rewrites are not accepted as variants", () => {
  assert.ok(!variants("four").has("for"));
  assert.ok(!variants("hour").has("hor"));
  assert.ok(!variants("doctor").has("doctour"));
  assert.ok(!variants("advertise").has("advertize"));
  assert.ok(!variants("size").has("sise"));
  assert.ok(!variants("silence").has("silense"));
  assert.ok(!variants("water").has("watre"));
  assert.ok(!spelledRight("acommodation", "accommodation"));
});

test("names the pattern behind common IELTS misspellings", () => {
  assert.deepEqual(diagnose("acommodation", "accommodation"), ["double"]);
  assert.deepEqual(diagnose("goverment", "government"), ["silent"]);
  assert.deepEqual(diagnose("recieve", "receive"), ["ieei"]);
  assert.deepEqual(diagnose("independance", "independence"), ["suffix"]);
  assert.deepEqual(diagnose("seperate", "separate"), ["vowel"]);
  assert.deepEqual(diagnose("Wensday", "Wednesday"), ["silent", "dropped"]);
  assert.deepEqual(diagnose("library", "library"), []);
  assert.deepEqual(diagnose("table", "environment"), ["mishear"]);
  assert.deepEqual(diagnose("bookshelf", "book shelf"), ["space"]);
});

test("marks the wrong letters for the feedback panel", () => {
  const marks = diffMarks("goverment", "government");
  assert.equal(marks.map((m) => m.ch).join(""), "government");
  assert.deepEqual(
    marks.filter((m) => m.bad).map((m) => m.ch),
    ["n"],
  );
});

test("finds drill words for a pattern", () => {
  assert.ok(hasPattern("double", "committee"));
  assert.ok(!hasPattern("double", "table"));
  assert.ok(hasPattern("silent", "knowledge"));
  assert.ok(hasPattern("suffix", "dependence"));
});
