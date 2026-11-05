import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  encodeLocalBankArchive,
  decodeLocalBankArchive,
} from "./localBankArchive";
import { hashLocalMaterial, LocalMaterialSchema } from "./localBankSchema";
async function fixture() {
  const bytes = new Uint8Array(204),
    view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVEfmt "],
    [36, "data"],
  ] as const)
    for (let i = 0; i < text.length; i++)
      bytes[offset + i] = text.charCodeAt(i);
  view.setUint32(4, 196, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 160, true);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const material = LocalMaterialSchema.parse({
    id: "synthetic-zip-listen",
    version: "1",
    skill: "listening",
    title: "Self-authored ZIP fixture",
    scope: "section",
    deliveryMode: "local-import",
    contentHash: "0".repeat(64),
    source: {
      materialSource: "unofficial",
      sourceRef: "self-authored-zip-fixture",
      rights: "Project-authored test data",
      answerVerified: false,
    },
    transcript: "The colour is blue.",
    audio: { path: "audio/fixture.wav", durationSeconds: 0.01, sha256: hash },
    questions: [
      {
        id: "zip-q1",
        type: "form-completion",
        prompt: "Colour ____",
        answer: { accepted: ["blue"], maxWords: 1 },
        evidence: {},
        answerVerified: false,
      },
    ],
  });
  material.contentHash = await hashLocalMaterial(material);
  return {
    bytes,
    material,
    audio: new Map([
      ["audio/fixture.wav", new Blob([bytes], { type: "audio/wav" })],
    ]),
  };
}
test("small bank ZIP restores the original audio bytes and matching material hashes", async () => {
  const { bytes, material, audio } = await fixture(),
    file = await encodeLocalBankArchive([material], audio),
    restored = await decodeLocalBankArchive(file);
  assert.equal(restored.materials.length, 1);
  assert.equal(restored.materials[0].contentHash, material.contentHash);
  assert.deepEqual(
    new Uint8Array(await restored.audio[0].blob.arrayBuffer()),
    bytes,
  );
});
test("ZIP corruption fails SHA before any import result is returned", async () => {
  const { material, audio } = await fixture(),
    file = await encodeLocalBankArchive([material], audio),
    parts = unzipSync(new Uint8Array(await file.arrayBuffer()));
  parts["audio/fixture.wav"][100] ^= 1;
  await assert.rejects(
    decodeLocalBankArchive(new Blob([new Uint8Array(zipSync(parts)).buffer])),
    /校验/,
  );
});
test("ZIP unsafe path and duplicate manifest entries are independent rejections", async () => {
  const { material, audio } = await fixture(),
    file = await encodeLocalBankArchive([material], audio),
    parts = unzipSync(new Uint8Array(await file.arrayBuffer()));
  await assert.rejects(
    decodeLocalBankArchive(
      new Blob([
        new Uint8Array(
          zipSync({ ...parts, "../escape.wav": new Uint8Array([1]) }),
        ).buffer,
      ]),
    ),
    /路径|不安全/,
  );
  const manifest = JSON.parse(strFromU8(parts["manifest.json"]));
  manifest.files.push(manifest.files[0]);
  parts["manifest.json"] = strToU8(JSON.stringify(manifest));
  await assert.rejects(
    decodeLocalBankArchive(new Blob([new Uint8Array(zipSync(parts)).buffer])),
    /重复|清单/,
  );
});
