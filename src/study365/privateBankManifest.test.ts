import test from "node:test";
import assert from "node:assert/strict";
import { hashLocalMaterial, type LocalMaterial } from "./localBankSchema";
import {
  parsePrivateBankManifest,
  privateTransportFor,
  type PrivateAudioTransport,
} from "./privateBankManifest";
async function fixture() {
  const material: LocalMaterial = {
    id: "private-fixture-listening",
    version: "1",
    contentHash: "0".repeat(64),
    title: "Self-authored private audio fixture",
    deliveryMode: "local-import",
    skill: "listening",
    scope: "section",
    section: 1,
    source: {
      materialSource: "unofficial",
      sourceRef: "self-authored:private",
      rights: "Self-authored test content",
      answerVerified: true,
    },
    transcript: "Visitors bring seeds.",
    audio: {
      path: "audio/private-fixture.wav",
      durationSeconds: 10,
      sha256: "a".repeat(64),
    },
    questions: [
      {
        id: "pq1",
        number: 1,
        type: "sentence-completion",
        prompt: "Visitors bring ____.",
        answer: { accepted: ["seeds"], maxWords: 1 },
        evidence: { quote: "Visitors bring seeds." },
        answerVerified: true,
      },
    ],
  };
  material.contentHash = await hashLocalMaterial(material);
  const transport: PrivateAudioTransport = {
    originalPath: "audio/private-fixture.wav",
    path: `/private/audio/${"b".repeat(64)}.m4a`,
    sha256: "b".repeat(64),
    sourceSha256: "a".repeat(64),
    durationSeconds: 10.01,
    sourceDurationSeconds: 10,
    bitRate: 47999,
    targetBitRate: 48000,
    codec: "aac",
    profile: "LC",
    channels: 1,
    bytes: 60000,
    sourceBytes: 900000,
  };
  const body = {
    privateBankVersion: 1 as const,
    materials: [material],
    audioTransports: [transport],
  };
  return { ...body, contentHash: await hashLocalMaterial(body) };
}
test("private transport hashes compressed bytes while retaining exact original material identity", async () => {
  const value = await fixture(),
    original = structuredClone(value.materials),
    parsed = await parsePrivateBankManifest(value);
  assert.deepEqual(parsed.materials, original);
  assert.equal(
    await hashLocalMaterial(parsed.materials[0]),
    parsed.materials[0].contentHash,
  );
  assert.equal(
    privateTransportFor(parsed.materials[0], parsed.audioTransports)
      ?.sourceSha256,
    "a".repeat(64),
  );
  assert.equal(
    privateTransportFor(
      {
        ...parsed.materials[0],
        audio: {
          ...(
            parsed.materials[0] as Extract<
              LocalMaterial,
              { skill: "listening" }
            >
          ).audio!,
          sha256: "c".repeat(64),
        },
      } as LocalMaterial,
      parsed.audioTransports,
    ),
    null,
  );
});
test("private manifest rejects path traversal, external paths, mismatched SHA and material substitutions", async () => {
  for (const patch of [
    { path: "https://example.com/audio.m4a" },
    { path: "/private/audio/../audio.m4a" },
    { path: `/private/audio/${"c".repeat(64)}.m4a` },
    { sourceSha256: "c".repeat(64) },
  ]) {
    const value = await fixture();
    Object.assign(value.audioTransports[0], patch);
    value.contentHash = await hashLocalMaterial(value);
    await assert.rejects(parsePrivateBankManifest(value));
  }
  const value = await fixture();
  value.materials[0].title += " changed";
  value.contentHash = await hashLocalMaterial(value);
  await assert.rejects(parsePrivateBankManifest(value), /校验失败|无效/);
});
test("manifest and transport duration integrity fail closed without modifying original objects", async () => {
  const value = await fixture(),
    original = JSON.stringify(value);
  await assert.rejects(
    parsePrivateBankManifest({ ...value, contentHash: "f".repeat(64) }),
    /校验失败/,
  );
  assert.equal(JSON.stringify(value), original);
  value.audioTransports[0].durationSeconds = 10.11;
  value.contentHash = await hashLocalMaterial(value);
  await assert.rejects(parsePrivateBankManifest(value), /0.1秒/);
});
test("missing or duplicate audio bindings cannot silently prepare a partly usable listening bank", async () => {
  const value = await fixture();
  const missing = { ...value, audioTransports: [] };
  missing.contentHash = await hashLocalMaterial(missing);
  await assert.rejects(parsePrivateBankManifest(missing), /缺少/);
  const duplicate = {
    ...value,
    audioTransports: [value.audioTransports[0], value.audioTransports[0]],
  };
  duplicate.contentHash = await hashLocalMaterial(duplicate);
  await assert.rejects(parsePrivateBankManifest(duplicate), /重复/);
});

test("transport source duration is bound to the unchanged canonical material metadata", async () => {
  const value = await fixture();
  value.audioTransports[0].sourceDurationSeconds = 12;
  value.audioTransports[0].durationSeconds = 12;
  value.contentHash = await hashLocalMaterial(value);
  await assert.rejects(parsePrivateBankManifest(value), /原始时长/);
});
