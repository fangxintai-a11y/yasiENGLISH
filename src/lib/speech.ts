/* Browser speech recognition (Chrome, Edge, Safari), used to check a shadowed sentence word by word. */

import { tokens } from "../ielts/shadow";

interface Alternative {
  transcript: string;
}
interface Result {
  isFinal: boolean;
  length: number;
  [i: number]: Alternative;
}
interface RecognitionEvent {
  results: { length: number; [i: number]: Result };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

const ctor = (): RecognitionCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export const canRecognize = () => typeof window !== "undefined" && !!ctor();

export const isAppleMobile = () =>
  typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export interface Hearing {
  /** Stops listening and resolves with what was heard ("" when nothing). */
  stop(): Promise<string>;
  abort(): void;
}

/**
 * Listens until stopped. Of the recogniser's guesses for each phrase, the one sharing the most
 * words with `target` is kept, so an accent is not marked down for a homophone the engine preferred.
 */
export function hear(target: string, lang = "en-US"): Hearing | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  const want = new Set(tokens(target));
  const best = (r: Result) => {
    let pick = r[0]?.transcript ?? "";
    let score = -1;
    for (let i = 0; i < r.length; i++) {
      const s = tokens(r[i].transcript).filter((t) => want.has(t)).length;
      if (s > score) [pick, score] = [r[i].transcript, s];
    }
    return pick;
  };
  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 4;
  let heard = "";
  let ended = false;
  let onEnd: (() => void) | null = null;
  rec.onresult = (e) => {
    const parts: string[] = [];
    for (let i = 0; i < e.results.length; i++) parts.push(best(e.results[i]));
    heard = parts.join(" ").trim();
  };
  rec.onerror = () => undefined;
  rec.onend = () => {
    ended = true;
    onEnd?.();
  };
  try {
    rec.start();
  } catch {
    return null;
  }
  return {
    stop: () =>
      new Promise<string>((resolve) => {
        const done = () => resolve(heard);
        if (ended) return done();
        onEnd = done;
        // The last words arrive with the final result, after stop(); give up waiting after a moment.
        window.setTimeout(done, 1800);
        try {
          rec.stop();
        } catch {
          done();
        }
      }),
    abort: () => {
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}
