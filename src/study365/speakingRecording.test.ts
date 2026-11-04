import assert from "node:assert/strict";
import test from "node:test";
import {
  measureSpeakingRecording,
  normalizeSpeakingBlob,
  startSpeakingRecording,
} from "./speakingRecording";
import {
  decodeRecordingArchive,
  encodeRecordingArchive,
  MAX_RECORDING_BYTES,
} from "./recordings";
test("codec-qualified recording MIME becomes ZIP-compatible without changing any audio bytes", async () => {
  const original = new Blob([new Uint8Array([0, 4, 128, 255])], {
      type: "audio/webm;codecs=opus",
    }),
    normalized = normalizeSpeakingBlob(original);
  assert.equal(normalized.type, "audio/webm");
  assert.deepEqual(
    new Uint8Array(await normalized.arrayBuffer()),
    new Uint8Array(await original.arrayBuffer()),
  );
  const zip = await encodeRecordingArchive([
    {
      blob: normalized,
      metadata: {
        recordingId: "audio-a",
        date: "2026-11-15",
        prompt: "Describe a skill.",
        transcript: "",
        durationSeconds: 1.5,
      },
    },
  ]);
  const restored = await decodeRecordingArchive(zip);
  assert.deepEqual(
    new Uint8Array(await restored[0].blob.arrayBuffer()),
    new Uint8Array(await original.arrayBuffer()),
  );
});
test("50MB guard executes before decoding, not after large allocation or metadata write", async () => {
  let decodes = 0;
  const big = new Blob([new Uint8Array(MAX_RECORDING_BYTES + 1)], {
    type: "audio/webm",
  });
  await assert.rejects(
    () =>
      measureSpeakingRecording(big, 3, async () => {
        decodes++;
        return 99;
      }),
    /50 MB/,
  );
  assert.equal(decodes, 0);
});
test("decoded media duration takes precedence over page time, with explicit real-recording fallback", async () => {
  const blob = new Blob(["audio"], { type: "audio/webm" });
  assert.deepEqual(
    await measureSpeakingRecording(blob, 999, async () => 1.75),
    { durationSeconds: 1.75, estimated: false },
  );
  assert.deepEqual(
    await measureSpeakingRecording(blob, 3.25, async () => {
      throw new Error("codec");
    }),
    { durationSeconds: 3.25, estimated: true },
  );
});
test("capture stop and close release tracks once and cache final bytes for repeated stop", async () => {
  let stopped = 0,
    closed = 0,
    now = 1000;
  const capture = await startSpeakingRecording({
    openMic: async () => ({
      level: () => 0,
      record: () => ({
        stop: async () => {
          stopped++;
          return new Blob(["clip"], { type: "audio/webm;codecs=opus" });
        },
      }),
      close: () => {
        closed++;
      },
    }),
    now: () => now,
    decode: async () => 2.5,
  });
  now = 2000;
  const one = await capture.stop(),
    two = await capture.stop();
  capture.close();
  assert.equal(one, two);
  assert.equal(one.durationSeconds, 2.5);
  assert.equal(one.blob.type, "audio/webm");
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});
