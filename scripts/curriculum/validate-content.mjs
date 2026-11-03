#!/usr/bin/env node
/** Validate actual R0 artifacts and inventory without downloading models or contacting APIs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContentCatalogSchema } from "../../src/study365/contentSchemas.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contentRoot = path.join(root, "public/curriculum365/v1");
const json = async (relative) => JSON.parse(await readFile(path.join(contentRoot, relative), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const catalog = ContentCatalogSchema.parse(await json("samples.json"));
assert.deepEqual([...new Set(catalog.materials.map((item) => item.skill))].sort(), ["listening", "reading", "speaking", "writing"], "R0 requires all four skill samples");
const inventory = await json("inventory.json");
const rules = await json("plan-rules.json");
const byId = new Map(catalog.materials.map((item) => [item.id, item]));

async function checkRecordReferences() {
  const fixture = JSON.parse(await readFile(path.join(root, "src/study365/fixtures/r0-records.json"), "utf8"));
  for (const { request } of fixture.records) {
    const payload = request.payload;
    if (request.kind === "plan") assert.equal(payload.curriculumVersion, catalog.version);
    if (!["attempt", "essay", "speaking"].includes(request.kind)) continue;
    const material = byId.get(payload.contentId);
    assert.ok(material, `wire fixture references missing material ${payload.contentId}`);
    assert.equal(payload.contentVersion, material.version);
    if (request.kind === "attempt") {
      assert.equal(payload.skill, material.skill);
      assert.equal(payload.answers.length, material.questions.length);
      payload.answers.forEach((value, index) => assert.ok(material.questions[index].answer.accepted.includes(value)));
    }
    if (request.kind === "essay") assert.equal(payload.prompt, material.prompt);
    if (request.kind === "speaking") assert.equal(payload.prompt, material.prompts.join(" "));
  }
}

function checkRules() {
  assert.equal(rules.schemaVersion, 1);
  assert.equal(rules.goal.durationDays, 365);
  assert.equal(rules.goal.targetOverall, 8);
  assert.equal(rules.goal.minimumSection, 6.5);
  assert.equal(rules.goal.completionSource, "official");
  assert.deepEqual(rules.goal.studyBudgetsMinutes, [120, 150, 180]);
  assert.deepEqual(rules.goal.milestoneBands, [7, 7.5]);
  assert.equal(rules.goal.recommendedSectionsAreRequired, false);
  let nextDay = 1;
  for (const phase of rules.phases) {
    assert.equal(phase.startDay, nextDay, `phase gap/overlap: ${phase.id}`);
    assert.ok(Number.isInteger(phase.endDay) && phase.endDay >= phase.startDay);
    nextDay = phase.endDay + 1;
  }
  assert.equal(nextDay, 366);
  assert.equal(new Set(rules.budgetTemplates.map((item) => item.id)).size, rules.budgetTemplates.length);
  for (const template of rules.budgetTemplates) {
    let total = 0, study = 0;
    const blockIds = new Set();
    for (const block of template.blocks) {
      assert.ok(Number.isInteger(block.minutes) && block.minutes > 0, template.id);
      assert.ok(["study", "break", "transition"].includes(block.kind), template.id);
      assert.ok(!blockIds.has(block.id), `duplicate block: ${template.id}/${block.id}`);
      blockIds.add(block.id);
      total += block.minutes;
      if (block.kind === "study") study += block.minutes;
    }
    assert.equal(total, template.budgetMinutes, template.id);
    assert.equal(study, template.studyMinutes, template.id);
    assert.ok([120, 150, 180].includes(total));
    if (template.kind === "full-mock") {
      assert.equal(total, 180);
      assert.equal(template.blocks.find((item) => item.id === "reading")?.minutes, 60);
      assert.equal(template.blocks.find((item) => item.id === "writing-task-1-and-2")?.minutes, 60);
    }
  }
  for (const flag of ["awardScoreFromDate", "awardScoreFromMinutes", "awardScoreFromStreak", "advanceMaterialLevelFromDate"])
    assert.equal(rules.calendarPolicy[flag], false, flag);
  assert.equal(rules.budgetPolicy.plannedMinutesAreActualMinutes, false);
  assert.equal(rules.budgetPolicy.shrinkExamSectionsToFitBudget, false);
  assert.equal(rules.readinessPolicy.aiOrSelfScoreCanCompleteGoal, false);
  assert.equal(rules.readinessPolicy.missingScoreValue, null);
  assert.equal(rules.readinessPolicy.minimumIndependentAssessments, 2);
  for (const example of rules.scoreExamples) {
    const values = ["listening", "reading", "writing", "speaking"].map((key) => example.sections[key]);
    assert.ok(values.every((value) => value === null || typeof value === "number" && value >= 0 && value <= 9 && Number.isInteger(value * 2)));
    const complete = values.every((value) => value !== null);
    const overall = complete ? Math.round(values.reduce((sum, value) => sum + value, 0) / 2) / 2 : null;
    const sectionFloorMet = complete && values.every((value) => value >= rules.goal.minimumSection);
    const numericTargetMet = overall !== null && overall >= rules.goal.targetOverall && sectionFloorMet;
    assert.deepEqual(example.expected, { overall, sectionFloorMet, numericTargetMet,
      finalGoalMet: example.source === "official" && numericTargetMet }, example.id);
  }
}

function checkInventory() {
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.coverageDays, 14);
  assert.deepEqual(inventory.days.map((item) => item.day), Array.from({ length: 14 }, (_, index) => index + 1));
  assert.equal(inventory.sampleAvailability.length, catalog.materials.length);
  const available = new Map();
  for (const entry of inventory.sampleAvailability) {
    const material = byId.get(entry.materialId);
    assert.ok(material, `missing material: ${entry.materialId}`);
    assert.ok(!available.has(entry.materialId), `duplicate availability: ${entry.materialId}`);
    assert.equal(entry.version, material.version);
    assert.equal(entry.reviewStatus, material.source.reviewStatus);
    assert.equal(entry.artifactStatus, "sample_ready");
    available.set(entry.materialId, entry);
  }
  const practice = new Set();
  for (const day of inventory.days) {
    assert.ok(["practice", "checkpoint"].includes(day.pool));
    assert.ok(["sample_ready", "planned"].includes(day.artifactStatus));
    if (day.artifactStatus === "sample_ready") assert.ok(day.materialIds.length > 0);
    if (day.artifactStatus === "planned") assert.equal(day.materialIds.length, 0, "planned items are not existing content");
    if (day.pool === "practice") day.materialIds.forEach((id) => practice.add(id));
    for (const id of day.materialIds) {
      assert.ok(available.has(id), `day ${day.day} references missing material ${id}`);
      assert.equal(byId.get(id).isCheckpoint, day.pool === "checkpoint");
    }
  }
  for (const day of inventory.days.filter((item) => item.pool === "checkpoint"))
    day.materialIds.forEach((id) => assert.ok(!practice.has(id), "checkpoint material already in practice pool"));
  assert.deepEqual(inventory.days.filter((item) => item.pool === "checkpoint").map((item) => item.day), [7, 14]);
}

function wavInfo(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= bytes.length, "truncated WAV chunk");
    if (kind === "fmt ") {
      assert.ok(size >= 16);
      format = { codec: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10),
        rate: bytes.readUInt32LE(offset + 12), byteRate: bytes.readUInt32LE(offset + 16), bits: bytes.readUInt16LE(offset + 22) };
    }
    if (kind === "data") data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  assert.ok(format && data?.length, "missing WAV format or samples");
  assert.deepEqual([format.codec, format.channels, format.rate, format.bits], [1, 1, 24000, 16]);
  assert.equal(format.byteRate, format.rate * format.channels * format.bits / 8);
  assert.ok(data.some((byte) => byte !== 0), "silent placeholder audio");
  return { durationSeconds: data.length / format.byteRate, ...format };
}

async function checkAudio() {
  const provenance = await json("audio/provenance.json");
  const material = catalog.materials.find((item) => item.skill === "listening");
  assert.ok(material);
  const bytes = await readFile(path.join(contentRoot, material.audio.path));
  const info = wavInfo(bytes);
  assert.equal(provenance.sha256, digest(bytes));
  assert.equal(provenance.audioPath, path.basename(material.audio.path));
  assert.ok(Math.abs(info.durationSeconds - material.audio.durationSeconds) < 0.00001);
  assert.ok(Math.abs(info.durationSeconds - provenance.durationSeconds) < 0.00001);
  assert.equal(provenance.transcriptSha256, digest(material.transcript));
  assert.equal(provenance.verification.humanListeningReview, "pending");
  assert.equal(provenance.generatorPath, "scripts/curriculum/generate-r0-audio.py");
  assert.equal(provenance.generatorSha256, digest(await readFile(path.join(root, provenance.generatorPath))));
  assert.equal(provenance.segments.length, material.segments.length);
  let previousEnd = 0;
  provenance.segments.forEach((segment, index) => {
    assert.equal(segment.id, material.segments[index].id);
    assert.equal(segment.text, material.segments[index].text);
    assert.ok(segment.startSeconds >= previousEnd && segment.endSeconds > segment.startSeconds && segment.endSeconds <= info.durationSeconds);
    assert.ok(Math.abs(segment.startSeconds - segment.startFrame / info.rate) < 0.00001);
    assert.ok(Math.abs(segment.endSeconds - segment.endFrame / info.rate) < 0.00001);
    previousEnd = segment.endSeconds;
  });
  for (const question of material.questions) {
    const segment = provenance.segments.find((item) => item.text === question.evidence.quote);
    assert.ok(segment, question.id);
    assert.deepEqual([question.evidence.startSeconds, question.evidence.endSeconds], [segment.startSeconds, segment.endSeconds]);
  }
  return { seconds: info.durationSeconds, bytes: bytes.length };
}

checkRules();
checkInventory();
await checkRecordReferences();
const audio = await checkAudio();
const reviewedMaterials = catalog.materials.filter((item) => item.source.reviewStatus === "reviewed").length;
console.log(JSON.stringify({ success: true, executableSamples: catalog.materials.length, reviewedMaterials,
  inventoryDays: inventory.days.length, sampleDays: inventory.days.filter((item) => item.artifactStatus === "sample_ready").length,
  plannedDays: inventory.days.filter((item) => item.artifactStatus === "planned").length,
  releaseReadiness: "not-certified-by-r0-sample-validator",
  budgetTemplates: rules.budgetTemplates.length, scoreExamples: rules.scoreExamples.length, audio }, null, 2));
