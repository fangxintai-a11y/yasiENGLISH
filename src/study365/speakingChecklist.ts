/** Stable R3 speaking self-check IDs; descriptions live in the speaking rubric. */
export const SPEAKING_CHECKLIST_IDS = Object.freeze([
  "speaking-fluency-development", "speaking-fluency-continuity", "speaking-fluency-linking",
  "speaking-lexical-precision", "speaking-lexical-paraphrase",
  "speaking-grammar-range", "speaking-grammar-accuracy",
  "speaking-pronunciation-intelligibility", "speaking-pronunciation-stress", "speaking-pronunciation-intonation",
] as const);
export const SPEAKING_ERROR_CAUSES = Object.freeze([
  "synonym-miss", "locating-error", "time-pressure", "vocab-unknown", "misread-question", "tfng-inference",
  "grammar", "lexical-misuse", "coherence", "fluency-pause", "pronunciation", "other",
] as const);
