import assert from "node:assert/strict";
import { test } from "node:test";
import { exportBackup, sanitizeProgress, sanitizeSettings, store, type Reading } from "./store";

const card = { due: 1, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, seen: 1 };

test("keeps valid progress and drops malformed records", () => {
  const p = sanitizeProgress(
    {
      version: 2,
      cards: { ok: card, bad: { ...card, d: 99 }, worse: "x" },
      bookmarks: ["ok", 3],
      days: { "2026-10-25": { n: 1, r: 2, c: 1, t: 30 }, nope: { n: 1, r: 1, c: 1, t: 1 } },
      typing: [{ at: 1, mode: "word", items: 10, wpm: 40, accuracy: 98 }, { at: 1, mode: "hack", items: 1, wpm: 1, accuracy: 1 }],
    },
    "word-atlas-open",
  );
  assert.deepEqual(Object.keys(p.cards), ["ok"]);
  assert.deepEqual(p.bookmarks, ["ok"]);
  assert.deepEqual(Object.keys(p.days), ["2026-10-25"]);
  assert.equal(p.typing.length, 1);
});

test("rejects other versions and unknown settings", () => {
  assert.deepEqual(sanitizeProgress({ version: 1, cards: { ok: card } }, "x").cards, {});
  const s = sanitizeSettings({ accent: "fr", dailyNew: 1e9, theme: "dark", retention: 0.5 });
  assert.equal(s.accent, "uk");
  assert.equal(s.dailyNew, 20);
  assert.equal(s.theme, "dark");
  assert.equal(s.retention, 0.9);
});

test("old model settings migrate to local feedback without retaining the obsolete field", () => {
  const settings = sanitizeSettings({ aiModel: "legacy-model-id", theme: "dark" });
  assert.equal(Object.hasOwn(settings, "aiModel"), false);
  assert.equal(settings.feedbackMode, "rules");
  for (const feedbackMode of ["rules", "manual", "auto"] as const) assert.equal(sanitizeSettings({ feedbackMode }).feedbackMode, feedbackMode);
  for (const feedbackMode of [null, "unknown", {}, 1]) assert.equal(sanitizeSettings({ feedbackMode }).feedbackMode, "rules");
});

const oldReading: Reading = { id: "old-reading", at: 8, title: "A stored title", passage: "Original text must survive.", zh: "原译文。", words: ["original"], questions: [{ q: "A statement", a: "TRUE", why: "Original evidence" }], answers: ["TRUE"] };
const oldHack = { homophone: "旧谐音", split: "orig·inal", scene: "旧画面", at: 8 };

test("old readings and memory hooks keep all text and answers without inventing a source", () => {
  const value = { version: 2, readings: [oldReading], hacks: { original: oldHack } };
  const result = sanitizeProgress(value, "word-atlas-open");
  assert.deepEqual(result.readings, [oldReading]); assert.deepEqual(result.hacks.original, oldHack);
});

test("legal reading and hook source metadata survives, and invalid source drops only that field", () => {
  for (const src of ["rules", "ai", "manual", "legacy"]) {
    const result = sanitizeProgress({ version: 2, readings: [{ ...oldReading, src }], hacks: { original: { ...oldHack, src } } }, "word-atlas-open");
    assert.equal(result.readings[0].src, src); assert.equal(result.hacks.original.src, src);
  }
  const result = sanitizeProgress({ version: 2, readings: [{ ...oldReading, src: "unknown" }], hacks: { original: { ...oldHack, src: { illegal: true } } } }, "word-atlas-open");
  assert.deepEqual(result.readings, [oldReading]); assert.deepEqual(result.hacks.original, oldHack);
});

function isolatedOutboundRecord(secret: string, check: () => void) {
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"), storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { clearTimeout() {}, setTimeout() { return 0; } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  try {
    store.useDataset("s0-outbound-fixture");
    store.progress((p) => ({ ...p, readings: [oldReading], hacks: { original: { ...oldHack, homophone: secret } } }));
    check();
    assert.equal(store.get().progress.hacks.original.homophone, secret, "outbound protection must preserve the original text locally");
    assert.deepEqual(store.get().progress.readings, [oldReading]);
  } finally {
    store.useDataset("word-atlas-open");
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else delete (globalThis as { window?: unknown }).window;
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore); else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

for (const [format, secret] of [["generic", "sk-" + "a".repeat(24)], ["project", "sk-proj-" + "b".repeat(24)], ["xai", "xai-" + "c".repeat(24)], ["api", "AIza" + "d".repeat(30)]] as const) {
  test(`outbound ${format} secret blocks both backup and cloud projection without deleting local work`, () => {
    isolatedOutboundRecord(secret, () => {
      const safeError = (error: unknown) => error instanceof Error && /密钥/.test(error.message) && !error.message.includes(secret);
      assert.throws(() => exportBackup(), safeError, "backup must not serialize the secret");
      assert.throws(() => store.cloudSnapshot(), safeError, "sync projection must not expose the secret");
    });
  });
}

test("a known second-provider long credential cannot leave inside learning text", () => {
  const secret = "private-current-second-provider-credential";
  isolatedOutboundRecord(`An original learning sentence contains ${secret} inside its text.`, () => {
    const provider = { kind: "openai-compatible", label: "自定义接口", baseURL: "https://endpoint.example/v1", model: "user-selected", jsonMode: "prompt-only", timeoutMs: 1000, tasks: ["sentence"] };
    localStorage.setItem("band-galaxy:llm", JSON.stringify({ version: 1, providers: [{ ...provider, id: "first" }, { ...provider, id: "second" }] }));
    localStorage.setItem("band-galaxy:llm-secret:first", "other-private-value");
    localStorage.setItem("band-galaxy:llm-secret:second", secret);
    const safeError = (error: unknown) => error instanceof Error && /密钥/.test(error.message) && !error.message.includes(secret);
    assert.throws(() => exportBackup(), safeError);
    assert.throws(() => store.cloudSnapshot(), safeError);
  });
});


for (const [placeholder, sentence] of [
  ["ab", "The laboratory compared several methods before choosing a reliable approach."],
  ["test", "The team will test a new approach and record the evidence."],
  ["ollama", "The learner runs ollama on a local computer while reviewing the article."],
] as const) {
  test(`local placeholder ${placeholder} does not block ordinary backup or sync text`, () => {
    isolatedOutboundRecord(sentence, () => {
      localStorage.setItem("band-galaxy:llm", JSON.stringify({ version: 1, providers: [{ id: "local", kind: "openai-compatible", label: "本机接口", baseURL: "http://localhost:11434/v1", model: "user-selected", jsonMode: "prompt-only", timeoutMs: 1000, tasks: ["sentence"] }] }));
      localStorage.setItem("band-galaxy:llm-secret:local", placeholder);
      const backup = JSON.parse(exportBackup());
      const snapshot = store.cloudSnapshot();
      assert.equal(backup.progress.hacks.original.homophone, sentence);
      assert.equal(snapshot?.progress.hacks.original.homophone, sentence);
      assert.deepEqual(backup.progress.readings, [oldReading]);
    });
  });
}
