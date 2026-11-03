import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, unzipSync, zipSync, Zip, ZipPassThrough } from "fflate";
import { decodeRecordingArchive, encodeRecordingArchive, MAX_RECORDING_BYTES } from "./recordings";

const metadata = { recordingId: "recording-one", date: "2026-11-03", prompt: "Describe a place.", transcript: "My local park.", durationSeconds: 12 };
const audio = new Blob([Uint8Array.from([0, 1, 2, 254, 255])], { type: "audio/webm" });

test("recording ZIP keeps exact original bytes, MIME and recovery metadata", async () => {
  const backup = await encodeRecordingArchive([{ blob: audio, metadata }]);
  const decoded = await decodeRecordingArchive(backup);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].id, metadata.recordingId);
  assert.equal(decoded[0].blob.type, "audio/webm");
  assert.deepEqual(new Uint8Array(await decoded[0].blob.arrayBuffer()), new Uint8Array(await audio.arrayBuffer()));
  assert.deepEqual(decoded[0].metadata, metadata);
});

test("two recording IDs can share identical audio without losing either manifest entry", async () => {
  const decoded = await decodeRecordingArchive(await encodeRecordingArchive([
    { blob: audio, metadata }, { blob: audio, metadata: { ...metadata, recordingId: "recording-two", date: null } },
  ]));
  assert.deepEqual(decoded.map((item) => item.id), ["recording-one", "recording-two"]);
  assert.equal(decoded[1].metadata?.date, null);
});

test("duplicate recording IDs are rejected before export", async () => {
  await assert.rejects(encodeRecordingArchive([{ blob: audio, metadata }, { blob: audio, metadata }]), /ID重复/);
});

test("ZIP paths cannot escape the audio namespace", async () => {
  const bytes = zipSync({ "manifest.json": strToU8("{}"), "../outside.webm": strToU8("audio") }, { level: 0 });
  await assert.rejects(decodeRecordingArchive(new Blob([new Uint8Array(bytes).buffer])), /不安全路径/);
});

test("duplicate ZIP entry names are rejected rather than last-entry-wins", async () => {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => { assert.ifError(error); chunks.push(bytes); });
  for (let i = 0; i < 2; i++) { const entry = new ZipPassThrough("manifest.json"); zip.add(entry); entry.push(strToU8("{}"), true); }
  zip.end();
  await assert.rejects(decodeRecordingArchive(new Blob(chunks.map((bytes) => new Uint8Array(bytes).buffer))), /重复文件/);
});

test("truncated ZIP cannot produce a partial restore", async () => {
  const archive = await encodeRecordingArchive([{ blob: audio, metadata }]);
  await assert.rejects(decodeRecordingArchive(archive.slice(0, archive.size - 12)), /不完整/);
});

test("recording CRC corruption is rejected even when audio SHA in the manifest is unchanged", async () => {
  const bytes = new Uint8Array(await (await encodeRecordingArchive([{ blob: audio, metadata }])).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22, directory = view.getUint32(end + 16, true);
  view.setUint32(directory + 16, 0, true);
  await assert.rejects(decodeRecordingArchive(new Blob([bytes.buffer])), /校验失败/);
});

test("oversized decompression declarations are refused before allocation", async () => {
  const bytes = new Uint8Array(await (await encodeRecordingArchive([{ blob: audio, metadata }])).arrayBuffer());
  const view = new DataView(bytes.buffer), directory = view.getUint32(bytes.length - 22 + 16, true);
  view.setUint32(directory + 24, MAX_RECORDING_BYTES + 1, true);
  await assert.rejects(decodeRecordingArchive(new Blob([bytes.buffer])), /文件过大/);
});

test("a deflated recording backup restores the same original audio bytes", async () => {
  const original = await encodeRecordingArchive([{ blob: audio, metadata }]);
  const files = unzipSync(new Uint8Array(await original.arrayBuffer()));
  const compressed = zipSync(files, { level: 6 });
  const decoded = await decodeRecordingArchive(new Blob([new Uint8Array(compressed).buffer]));
  assert.deepEqual(new Uint8Array(await decoded[0].blob.arrayBuffer()), new Uint8Array(await audio.arrayBuffer()));
});

test("audio SHA mismatch is rejected independently from valid ZIP CRC values", async () => {
  const original = await encodeRecordingArchive([{ blob: audio, metadata }]);
  const files = unzipSync(new Uint8Array(await original.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  manifest.recordings[0].sha256 = "0".repeat(64);
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  const changed = zipSync(files, { level: 0 });
  await assert.rejects(decodeRecordingArchive(new Blob([new Uint8Array(changed).buffer])), /内容校验失败/);
});

test("a backup cannot smuggle unknown metadata fields into recovery storage", async () => {
  const original = await encodeRecordingArchive([{ blob: audio, metadata }]);
  const files = unzipSync(new Uint8Array(await original.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  manifest.recordings[0].unexpected = "not part of the recording contract";
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  const changed = zipSync(files, { level: 0 });
  await assert.rejects(decodeRecordingArchive(new Blob([new Uint8Array(changed).buffer])), /清单格式不正确/);
});
