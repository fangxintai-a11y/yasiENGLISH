import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkInventory, checkMaterialCoverage, checkRecordReferences } from "./validate-content.mjs";
import { ContentCatalogSchema } from "../../src/study365/contentSchemas.ts";

const read = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const inventory = await read("../../public/curriculum365/v1/inventory.json");
const catalog = await read("../../public/curriculum365/v1/samples.json");
const fixture = await read("../../src/study365/fixtures/r0-records.json");
const at = (path) => (error) => error.path === path && error.message.startsWith(`${path}:`);

test("inventory distinguishes external baselines, partial samples and planned gaps", () => {
  assert.doesNotThrow(() => checkInventory(structuredClone(inventory), catalog));
});
test("a partially supplied day cannot claim all artifacts are ready", () => {
  const value = structuredClone(inventory);
  value.days[3].artifactStatus = "sample_ready";
  assert.throws(() => checkInventory(value, catalog), at("inventory.days[3].artifactStatus"));
});
test("day-one inventory cannot omit reading from the real baseline", () => {
  const value = structuredClone(inventory);
  value.days[0].plannedSkills = ["listening"];
  assert.throws(() => checkInventory(value, catalog), at("inventory.days[0].plannedSkills"));
});
test("an external baseline reference must exist", () => {
  const value = structuredClone(inventory);
  value.days[0].externalReferenceIds = ["missing-official-source"];
  assert.throws(() => checkInventory(value, catalog), at("inventory.days[0].externalReferenceIds"));
});
test("inventory cannot silently mark a draft as reviewed", () => {
  const value = structuredClone(inventory);
  value.sampleAvailability[0].reviewStatus = "reviewed";
  assert.throws(() => checkInventory(value, catalog), at("inventory.sampleAvailability[0].reviewStatus"));
});
test("another Task 2 material can expand the sample pool", () => {
  const value = structuredClone(catalog);
  value.materials.push({ ...structuredClone(value.materials.find((item) => item.skill === "writing" && item.taskType === "task2")), id: "additional-task2-sample" });
  assert.doesNotThrow(() => ContentCatalogSchema.parse(value));
  assert.doesNotThrow(() => checkMaterialCoverage(value));
});
test("another Part 1 material can expand the sample pool", () => {
  const value = structuredClone(catalog);
  value.materials.push({ ...structuredClone(value.materials.find((item) => item.skill === "speaking" && item.part === 1)), id: "additional-part1-sample" });
  assert.doesNotThrow(() => ContentCatalogSchema.parse(value));
  assert.doesNotThrow(() => checkMaterialCoverage(value));
});
test("a legal B1 supplement is accepted alongside core C1 and AWL coverage", () => {
  const value = structuredClone(catalog);
  const supplement = structuredClone(value.materials.find((item) => item.skill === "writing" && item.taskType === "task2"));
  supplement.id = "b1-supplement"; supplement.materialLevel = "foundation";
  supplement.vocabulary = { cefr: "B1", awl: false, items: [{ headword: "study" }] };
  value.materials.push(supplement);
  assert.doesNotThrow(() => ContentCatalogSchema.parse(value));
  assert.doesNotThrow(() => checkMaterialCoverage(value));
});
const mixedVocabularyPool = () => {
  const value = structuredClone(catalog);
  for (const material of value.materials) material.vocabulary = { cefr: "B1", awl: false, items: [{ headword: "study" }] };
  value.materials[0].vocabulary = { cefr: "C1", awl: true, items: [{ headword: "analysis", awlSublist: 1 }] };
  return value;
};
test("the pool cannot remove its only C1 resource", () => {
  const value = mixedVocabularyPool();
  assert.doesNotThrow(() => ContentCatalogSchema.parse(value));
  assert.doesNotThrow(() => checkMaterialCoverage(value));
  value.materials[0].vocabulary.cefr = "B2";
  assert.throws(() => checkMaterialCoverage(value), at("catalog.materials.vocabulary.cefr"));
});
test("the pool cannot remove its only AWL resource", () => {
  const value = mixedVocabularyPool();
  assert.doesNotThrow(() => ContentCatalogSchema.parse(value));
  assert.doesNotThrow(() => checkMaterialCoverage(value));
  value.materials[0].vocabulary.awl = false;
  assert.throws(() => checkMaterialCoverage(value), at("catalog.materials.vocabulary.awl"));
});
test("a fixture hash mismatch identifies the exact record", async () => {
  const value = structuredClone(fixture);
  value.records[0].expectedContentHash = "0".repeat(64);
  await assert.rejects(checkRecordReferences(value, catalog), at("fixture.records[0].expectedContentHash"));
});
