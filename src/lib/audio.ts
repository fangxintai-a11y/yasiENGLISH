import { duck } from "./sound";

let current: HTMLAudioElement | null = null;
let token = 0;

export function stopAudio() {
  token++;
  current?.pause();
  current = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** Called with how far through the recording playback is (0..1), every frame while it plays. */
export type OnProgress = (fraction: number) => void;

/** Play a recording, falling back to the device voice. Resolves when playback ends. */
export async function play(url: string | null | undefined, text: string, accent: "uk" | "us" = "uk", rate = 1, onProgress?: OnProgress) {
  duck(true);
  try {
    return await speak(url, text, accent, rate, onProgress);
  } finally {
    duck(false);
  }
}

async function speak(url: string | null | undefined, text: string, accent: "uk" | "us", rate: number, onProgress?: OnProgress) {
  stopAudio();
  const mine = ++token;
  if (url) {
    const a = new Audio(url);
    a.playbackRate = rate;
    // Keeps the pitch when slowed down, so a slow word still sounds like the same voice.
    a.preservesPitch = true;
    current = a;
    let frame = 0;
    const tick = () => {
      if (a.duration > 0) onProgress?.(Math.min(1, a.currentTime / a.duration));
      frame = requestAnimationFrame(tick);
    };
    try {
      await a.play();
      if (onProgress) tick();
      await new Promise<void>((r) => {
        a.onended = () => r();
        a.onpause = () => r();
      });
      return "recorded" as const;
    } catch {
      if (mine !== token) return "stopped" as const;
      current = null;
    } finally {
      cancelAnimationFrame(frame);
    }
  }
  if (!("speechSynthesis" in window)) return "unsupported" as const;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = accent === "uk" ? "en-GB" : "en-US";
  u.rate = rate * 0.95;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-") === u.lang);
  const best = voices.find((v) => /premium|enhanced|natural|google/i.test(v.name)) || voices[0];
  if (best) u.voice = best;
  // The device voice reports no progress worth using; spread it over a guessed duration instead.
  const start = performance.now();
  const guess = (300 + text.length * 70) / rate;
  let frame = 0;
  const tick = () => {
    onProgress?.(Math.min(1, (performance.now() - start) / guess));
    frame = requestAnimationFrame(tick);
  };
  if (onProgress) tick();
  await new Promise<void>((r) => {
    u.onend = () => r();
    u.onerror = () => r();
    speechSynthesis.speak(u);
  });
  cancelAnimationFrame(frame);
  return "device" as const;
}
