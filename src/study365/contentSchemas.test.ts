import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ContentCatalogSchema, MaterialSchema } from "./contentSchemas";

const load = () => JSON.parse(readFileSync(new URL("../../public/curriculum365/v1/samples.json", import.meta.url), "utf8"));
const indexOf = (data: ReturnType<typeof load>, skill: string) => data.materials.findIndex((item: { skill: string }) => item.skill === skill);
function rejectChange(mutate: (data: ReturnType<typeof load>) => void, expectedPath: (string | number)[], unknownKey?: string) {
  const data = load(); mutate(data);
  const result = ContentCatalogSchema.safeParse(data);
  assert.equal(result.success, false, `must reject ${expectedPath.join(".")}`);
  if (result.success) return;
  assert.ok(result.error.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(expectedPath)
    && (!unknownKey || issue.code === "unrecognized_keys" && issue.keys.includes(unknownKey))), JSON.stringify(result.error.issues));
}

test("R0 has IELTS task samples with honest draft review and C1/AWL metadata", () => {
  const catalog = ContentCatalogSchema.parse(load());
  assert.equal(catalog.materials.length, 7);
  assert.deepEqual([...new Set(catalog.materials.map((item) => item.skill))].sort(), ["listening", "reading", "speaking", "writing"]);
  assert.ok(catalog.materials.every((item) => item.source.reviewStatus === "draft" && !item.isCheckpoint));
  for (const item of catalog.materials) {
    assert.equal(item.materialLevel, "ielts-academic");
    assert.equal((item as unknown as { vocabulary: { cefr: string; awl: boolean } }).vocabulary.cefr, "C1");
  }
});

test("material level is selected from multiple legal baseline levels", () => {
  const data = load(), index = indexOf(data, "reading");
  for (const level of ["foundation", "intermediate", "advanced", "ielts-academic"]) {
    const material = structuredClone(data.materials[index]); material.materialLevel = level;
    assert.equal(MaterialSchema.safeParse(material).success, true, level);
  }
});

test("duplicate question ID alone identifies the second question ID path", () => {
  const data = load(), l = indexOf(data, "listening"), r = indexOf(data, "reading");
  rejectChange((value) => { value.materials[r].questions[0].id = value.materials[l].questions[0].id; }, ["materials", r, "questions", 0, "id"]);
});

test("a changed listening segment alone identifies the segment mismatch path", () => {
  const l = indexOf(load(), "listening");
  rejectChange((data) => { data.materials[l].segments[0].text = "A different recording."; }, ["materials", l, "segments"]);
});

test("an invented band field alone is rejected as an unknown key", () => {
  const w = indexOf(load(), "writing");
  rejectChange((data) => { data.materials[w].band = 8; }, ["materials", w], "band");
});

test("claiming reviewed alone identifies the missing human reviewer", () => {
  const s = indexOf(load(), "speaking");
  rejectChange((data) => { data.materials[s].source.reviewStatus = "reviewed"; }, ["materials", s, "source", "reviewer"]);
});

test("an undersized writing example alone is rejected at example", () => {
  const w = indexOf(load(), "writing");
  rejectChange((data) => { data.materials[w].example = "A short answer."; }, ["materials", w, "example"]);
});

test("invented reading evidence alone identifies the evidence quote", () => {
  const r = indexOf(load(), "reading");
  rejectChange((data) => { data.materials[r].questions[0].evidence.quote = "This invented sentence is absent."; }, ["materials", r, "questions", 0, "evidence", "quote"]);
});

test("a completion answer exceeding its own word limit alone is rejected", () => {
  const l = indexOf(load(), "listening");
  rejectChange((data) => { data.materials[l].questions[0].answer.accepted = ["an answer with far too many words for this gap"]; }, ["materials", l, "questions", 0, "answer", "accepted"]);
});

test("listening section accepts all four sections but rejects a section outside 1–4", () => {
  const data = load(), l = indexOf(data, "listening");
  for (const section of [1, 2, 3, 4]) {
    const material = structuredClone(data.materials[l]); material.section = section;
    assert.equal(MaterialSchema.safeParse(material).success, true, `Section ${section}`);
  }
  rejectChange((value) => { value.materials[l].section = 5; }, ["materials", l, "section"]);
});

test("reading permits all three passage slots but rejects invalid question types", () => {
  const data = load(), r = indexOf(data, "reading");
  for (const passageNumber of [1, 2, 3]) {
    const material = structuredClone(data.materials[r]); material.passageNumber = passageNumber;
    assert.equal(MaterialSchema.safeParse(material).success, true);
  }
  rejectChange((value) => { value.materials[r].questions[0].type = "made-up-question"; }, ["materials", r, "questions", 0, "type"]);
});

test("writing Task 1 and 2 require their actual minimum lengths and time allocations", () => {
  const data = load();
  for (const [taskType, minWords, minutes] of [["task1", 150, 20], ["task2", 250, 40]] as const) {
    const index = data.materials.findIndex((item: { skill: string; taskType?: string }) => item.skill === "writing" && item.taskType === taskType);
    assert.ok(index >= 0, taskType);
    assert.equal(data.materials[index].minWords, minWords); assert.equal(data.materials[index].estimatedMinutes, minutes);
    rejectChange((value) => { value.materials[index].minWords = minWords - 1; }, ["materials", index, "minWords"]);
    rejectChange((value) => { value.materials[index].estimatedMinutes = minutes - 1; }, ["materials", index, "estimatedMinutes"]);
  }
});

test("academic reading is 700–900 words and listening has a full ten-question section", () => {
  const data = load(), l = indexOf(data, "listening"), r = indexOf(data, "reading");
  assert.ok(data.materials[r].passage.split(/\s+/).length >= 700);
  assert.ok(data.materials[r].passage.split(/\s+/).length <= 900);
  assert.equal(data.materials[l].questions.length, 10);
  rejectChange((value) => { value.materials[r].passage = "A tiny passage."; }, ["materials", r, "passage"]);
  rejectChange((value) => { value.materials[l].questions.pop(); }, ["materials", l, "questions"]);
});

test("independent audio faults have specific paths", () => {
  const l = indexOf(load(), "listening");
  rejectChange((data) => { data.materials[l].audio.path = "../../private.wav"; }, ["materials", l, "audio", "path"]);
  rejectChange((data) => { data.materials[l].audio.durationSeconds = null; }, ["materials", l, "audio", "durationSeconds"]);
  rejectChange((data) => { data.materials[l].questions[0].evidence.endSeconds = 10000; }, ["materials", l, "questions", 0, "evidence"]);
});

test("Part 2 preparation and response duration faults identify only the changed field", () => {
  const index = load().materials.findIndex((item: { skill: string; part?: number }) => item.skill === "speaking" && item.part === 2);
  for (const [field, value] of [["preparationSeconds", 55], ["suggestedSeconds", 119]] as const) {
    const data = load(); data.materials[index][field] = value;
    const result = ContentCatalogSchema.safeParse(data);
    assert.equal(result.success, false);
    if (!result.success) assert.deepEqual(result.error.issues.map((issue) => issue.path), [["materials", index, field]]);
  }
});

test("heading evidence must belong to its referenced paragraph when only paragraphId changes", () => {
  const data = load(), r = indexOf(data, "reading");
  const q = data.materials[r].questions.findIndex((item: { id: string }) => item.id === "reading-sample-01-q6");
  assert.equal(data.materials[r].questions[q].paragraphId, "pc");
  data.materials[r].questions[q].paragraphId = "pa";
  const result = ContentCatalogSchema.safeParse(data);
  assert.equal(result.success, false, "a heading for paragraph C must not silently reference paragraph A");
  if (!result.success) assert.deepEqual(result.error.issues.map((issue) => issue.path), [["materials", r, "questions", q, "paragraphId"]]);
});
