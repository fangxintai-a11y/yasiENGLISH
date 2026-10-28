/* The microphone for 跟读: one stream per round, a level meter for feedback, and short takes. */

export interface Take {
  stop(): Promise<Blob | null>;
}

export interface Mic {
  /** Loudness right now, 0..1, for the pulsing ring. */
  level(): number;
  record(): Take;
  close(): void;
}

export const canRecord = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

// Safari records mp4/aac, Chrome and Firefox webm/opus.
const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

export async function openMic(): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let buf = new Float32Array(0);
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    buf = new Float32Array(analyser.fftSize);
  } catch {
    /* no meter, recording still works */
  }
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
  return {
    level() {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      return Math.min(1, Math.sqrt(sum / buf.length) * 5);
    },
    record() {
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.start();
      const blob = () => (chunks.length ? new Blob(chunks, { type: rec.mimeType || type || "audio/webm" }) : null);
      return {
        stop: () =>
          new Promise<Blob | null>((resolve) => {
            if (rec.state === "inactive") return resolve(blob());
            rec.onstop = () => resolve(blob());
            rec.stop();
          }),
      };
    },
    close() {
      stream.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
    },
  };
}
