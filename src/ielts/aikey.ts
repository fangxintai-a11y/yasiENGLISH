/**
 * The learner's own Claude API key. Kept apart from the AI client so the SDK is only downloaded
 * when an AI feature is actually used. Personal use only: the key never leaves this browser
 * except in requests to api.anthropic.com, and is never put into backups.
 */

const KEY = "band-galaxy:ai-key";

export function getKey() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function setKey(k: string) {
  try {
    if (k.trim()) localStorage.setItem(KEY, k.trim());
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the key just isn't remembered */
  }
}
