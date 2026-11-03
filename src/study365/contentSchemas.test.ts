import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ContentCatalogSchema } from "./contentSchemas";

const load = () => JSON.parse(readFileSync(new URL("../../public/curriculum365/v1/samples.json", import.meta.url), "utf8"));

test("R0 catalog contains four executable foundation samples without pretending to be examiner-reviewed", () => {
  const catalog = ContentCatalogSchema.parse(load());
  assert.deepEqual(catalog.materials.map((item) => item.skill).sort(), ["listening", "reading", "speaking", "writing"]);
  assert.ok(catalog.materials.every((item) => item.source.reviewStatus === "draft" && !item.isCheckpoint));
});

test("R0 rejects invented evidence and answers that violate the material's word limit", () => {
  const data = load();
  data.materials[1].questions[0].evidence.quote = "This invented sentence is absent.";
  data.materials[1].questions[1].answer.accepted = ["on a Saturday morning"];
  const result = ContentCatalogSchema.safeParse(data);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.length >= 2);
});

test("R0 rejects duplicate question IDs and a listening transcript that disagrees with its segments", () => {
  const data = load();
  data.materials[1].questions[0].id = data.materials[0].questions[0].id;
  data.materials[0].segments[0].text = "A different recording.";
  assert.equal(ContentCatalogSchema.safeParse(data).success, false);
});

test("R0 rejects missing audio, escaping resource paths and out-of-range evidence times", () => {
  for (const change of [
    (data: ReturnType<typeof load>) => { data.materials[0].audio.durationSeconds = null; },
    (data: ReturnType<typeof load>) => { data.materials[0].audio.path = "../../private.wav"; },
    (data: ReturnType<typeof load>) => { data.materials[0].questions[0].evidence.endSeconds = 10000; },
  ]) {
    const data = load(); change(data);
    assert.equal(ContentCatalogSchema.safeParse(data).success, false);
  }
});

test("R0 cannot add a band score or claim completed review without its evidence fields", () => {
  const data = load();
  data.materials[2].band = 8;
  data.materials[3].source.reviewStatus = "reviewed";
  assert.equal(ContentCatalogSchema.safeParse(data).success, false);
});
