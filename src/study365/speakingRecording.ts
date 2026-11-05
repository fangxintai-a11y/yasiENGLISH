import { canRecord, openMic, type Mic } from "../lib/recorder";
import { MAX_RECORDING_BYTES } from "./recordings";
export interface SpeakingAudio {
  blob: Blob;
  durationSeconds: number;
  estimated: boolean;
}
export interface SpeakingCapture {
  stop(): Promise<SpeakingAudio>;
  close(): void;
}
export function normalizeSpeakingBlob(blob: Blob): Blob {
  if (!blob.size || blob.size > MAX_RECORDING_BYTES)
    throw new Error(
      "录音未保存：录音为空或超过50 MB，请缩短后重录，也可以只保存转写。",
    );
  const base = blob.type.split(";")[0].trim().toLowerCase();
  return blob.slice(
    0,
    blob.size,
    /^audio\/[a-z0-9.+-]+$/.test(base) ? base : "application/octet-stream",
  );
}
async function decodeDuration(bytes: ArrayBuffer): Promise<number> {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) throw new Error("当前浏览器无法读取音频时长。");
  const context = new Ctx();
  try {
    return (await context.decodeAudioData(bytes)).duration;
  } finally {
    await context.close().catch(() => undefined);
  }
}
export async function measureSpeakingRecording(
  blob: Blob,
  realElapsedSeconds: number,
  decode: (bytes: ArrayBuffer) => Promise<number> = decodeDuration,
): Promise<{ durationSeconds: number; estimated: boolean }> {
  normalizeSpeakingBlob(blob); // size validation must run before arrayBuffer/decode.
  try {
    const duration = await decode(await blob.arrayBuffer());
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
      throw new Error("音频时长无效。");
    return { durationSeconds: duration, estimated: false };
  } catch {
    if (
      !Number.isFinite(realElapsedSeconds) ||
      realElapsedSeconds < 0 ||
      realElapsedSeconds > 86400
    )
      throw new Error("录音未保存：无法确认有效录制时长。");
    return { durationSeconds: realElapsedSeconds, estimated: true };
  }
}
export async function startSpeakingRecording(
  options: {
    openMic?: () => Promise<Mic>;
    now?: () => number;
    decode?: (bytes: ArrayBuffer) => Promise<number>;
  } = {},
): Promise<SpeakingCapture> {
  if (!options.openMic && !canRecord())
    throw new Error("这台设备无法使用麦克风，可以仅计时并保存转写。");
  const mic = await (options.openMic ?? openMic)();
  let closed = false;
  const closeMic = () => {
    if (!closed) {
      closed = true;
      mic.close();
    }
  };
  let take;
  try {
    take = mic.record();
  } catch (error) {
    closeMic();
    throw error;
  }
  const clock = options.now ?? (() => performance.now()),
    started = clock();
  let raw: Promise<Blob | null> | undefined,
    result: Promise<SpeakingAudio> | undefined;
  const stopRaw = () =>
    (raw ??= (async () => {
      try {
        return await take.stop();
      } finally {
        closeMic();
      }
    })());
  return {
    stop: () =>
      (result ??= (async () => {
        const blob = await stopRaw(),
          elapsed = Math.max(0, (clock() - started) / 1000);
        if (!blob)
          throw new Error("录音未保存：没有收到音频，请重试或只保存转写。");
        const normalized = normalizeSpeakingBlob(blob);
        return {
          blob: normalized,
          ...(await measureSpeakingRecording(
            normalized,
            elapsed,
            options.decode,
          )),
        };
      })()),
    close() {
      void stopRaw().catch(() => undefined);
      closeMic();
    },
  };
}
export const recordingDeviceLabel = (id: string) => `设备 ${id.slice(0, 8)}`;
