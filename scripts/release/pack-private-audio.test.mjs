import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { tsImport } from "tsx/esm/api";
import { durationIssue, packPrivateAudio } from "./pack-private-audio.mjs";
const { hashLocalMaterial } = await tsImport(
  "../../src/study365/localBankSchema.ts",
  import.meta.url,
);
const { parsePrivateBankManifest } = await tsImport(
  "../../src/study365/privateBankManifest.ts",
  import.meta.url,
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function wav(frequency) {
  const rate = 22050,
    samples = 11025,
    bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(10000 * Math.sin((2 * Math.PI * frequency * i) / rate)),
      44 + i * 2,
    );
  return bytes;
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-r6-private-")),
    audioRoot = path.join(root, "sources"),
    out = path.join(root, "private"),
    bank = path.join(root, "bank.json");
  await fs.mkdir(path.join(audioRoot, "audio"), { recursive: true });
  const materials = [];
  for (const [exam, count, materialSource] of [
    ["SELF-CAM-ONE", 4, "cambridge"],
    ["SELF-CAM-TWO", 4, "cambridge"],
    ["SELF-CAM-THREE", 4, "cambridge"],
    ["SELF-INCOMPLETE", 3, "cambridge"],
    ["SELF-OTHER", 4, "unofficial"],
  ])
    for (let section = 1; section <= count; section++) {
      const id = `${exam.toLowerCase()}-s${section}`,
        original = wav(400 + materials.length * 20),
        audio = `audio/${id}.wav`;
      await fs.writeFile(path.join(audioRoot, audio), original);
      const material = {
        id,
        version: "1",
        title: "Self-authored synthetic packer fixture",
        skill: "listening",
        deliveryMode: "local-import",
        scope: "section",
        pool: "practice",
        examId: exam,
        section,
        transcript: `Self-authored part ${id}: visitors bring seeds.`,
        source: {
          materialSource,
          sourceRef: `self-authored:${id}`,
          rights: "Self-authored test fixture; not actual Cambridge material",
          answerVerified: true,
        },
        audio: { path: audio, sha256: sha(original), durationSeconds: 0.5 },
        questions: Array.from({ length: 10 }, (_, i) => ({
          id: `${id}-q${i + 1}`,
          number: (section - 1) * 10 + i + 1,
          type: "sentence-completion",
          prompt: "Visitors bring ____.",
          answer: { accepted: ["seeds"], maxWords: 1 },
          evidence: { quote: "visitors bring seeds." },
          answerVerified: true,
        })),
      };
      material.contentHash = await hashLocalMaterial(material);
      materials.push(material);
    }
  const reading = {
    id: "self-reading",
    version: "1",
    title: "Self-authored reading",
    skill: "reading",
    deliveryMode: "local-import",
    scope: "section",
    passageNumber: 1,
    passage: "Visitors bring seeds.",
    paragraphs: [{ id: "p1", text: "Visitors bring seeds." }],
    source: {
      materialSource: "unofficial",
      sourceRef: "self-authored:reading",
      rights: "Self-authored test fixture",
      answerVerified: true,
    },
    questions: [
      {
        id: "rq1",
        type: "sentence-completion",
        prompt: "Visitors bring ____.",
        answer: { accepted: ["seeds"], maxWords: 1 },
        evidence: { quote: "Visitors bring seeds." },
        answerVerified: true,
      },
    ],
  };
  reading.contentHash = await hashLocalMaterial(reading);
  materials.push(reading);
  await fs.writeFile(bank, JSON.stringify({ importVersion: 1, materials }));
  return { root, audioRoot, out, bank, materials };
}
test(
  "three complete self-authored sets encode to validated AAC-LC mono and resume without source mutations",
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const before = await fs.readFile(f.bank),
        result = await packPrivateAudio(f);
      assert.equal(result.completeCambridgeExams, 3);
      assert.equal(result.listeningSections, 12);
      assert.equal(result.readingMaterials, 1);
      assert.equal(result.encoded, 12);
      assert.equal(result.reused, 0);
      const manifest = await parsePrivateBankManifest(
        JSON.parse(
          await fs.readFile(path.join(f.out, "manifest.json"), "utf8"),
        ),
      );
      for (const item of manifest.audioTransports) {
        const bytes = await fs.readFile(
            path.join(f.out, item.path.slice("/private/".length)),
          ),
          source = await fs.readFile(path.join(f.audioRoot, item.originalPath));
        assert.equal(sha(bytes), item.sha256);
        assert.equal(sha(source), item.sourceSha256);
        assert.equal(item.codec, "aac");
        assert.equal(item.profile, "LC");
        assert.equal(item.channels, 1);
        assert.equal(item.targetBitRate, 48000);
        assert.ok(item.bitRate > 0);
        assert.ok(
          Math.abs(item.durationSeconds - item.sourceDurationSeconds) <= 0.1,
        );
      }
      assert.deepEqual(await fs.readFile(f.bank), before);
      for (const material of manifest.materials)
        assert.equal(
          material.contentHash,
          f.materials.find((original) => original.id === material.id)
            .contentHash,
        );
      const again = await packPrivateAudio(f);
      assert.equal(again.encoded, 0);
      assert.equal(again.reused, 12);
      assert.equal(again.manifestHash, result.manifestHash);
      const first = manifest.audioTransports[0];
      await fs.appendFile(
        path.join(f.out, first.path.slice("/private/".length)),
        "corrupt",
      );
      await assert.rejects(packPrivateAudio(f), /failed validation/);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);
test("packer rejects source SHA changes rather than rewriting a bank to fit the changed file", async () => {
  const f = await fixture();
  try {
    await fs.appendFile(
      path.join(f.audioRoot, f.materials[0].audio.path),
      "changed",
    );
    await assert.rejects(packPrivateAudio(f), /Original audio SHA/);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("duration check compares the transcode with the decoded source, not a bitrate-estimated header", () => {
  // Real case c10t1s1: header 454.947s, decoded 455.993s, AAC 455.993s.
  assert.equal(
    durationIssue({ declared: 454.947, sourceProbe: 454.947, sourceDecoded: 455.993, encoded: 455.993 }),
    null,
  );
  assert.equal(
    durationIssue({ declared: 454.947, sourceProbe: 454.947, sourceDecoded: 455.993, encoded: 454.947 }),
    "encoded",
    "a transcode that truncates real audio still fails",
  );
  assert.equal(
    durationIssue({ declared: 400, sourceProbe: 454.947, sourceDecoded: 455.993, encoded: 455.993 }),
    "declared",
    "a bank whose declared length disagrees with the file it hashes still fails",
  );
});
