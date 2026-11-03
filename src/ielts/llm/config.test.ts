import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoCredentials, getFeedbackConfig, migrateLegacy, saveFeedbackConfig, setCredential, getCredential } from "./config";

class StorageFixture {
  data = new Map<string, string>(); reads: string[] = []; removed: string[] = [];
  getItem(key: string) { this.reads.push(key); return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.removed.push(key); this.data.delete(key); }
}
test("legacy migration removes only its key without reading it and is idempotent", () => {
  const storage = new StorageFixture();
  const old = "band-galaxy:" + "ai-key";
  storage.data.set(old, "private-legacy-value"); storage.data.set("word-atlas:v2:fixture", "keep progress");
  storage.data.set("band-galaxy:sync-user", "keep session"); storage.data.set("band-galaxy:syl-taps", "keep taps");
  migrateLegacy(storage); migrateLegacy(storage);
  assert.equal(storage.data.has(old), false);
  assert.equal(storage.reads.includes(old), false);
  assert.deepEqual(storage.removed, [old]);
  assert.equal(storage.data.get("word-atlas:v2:fixture"), "keep progress");
  assert.equal(storage.data.get("band-galaxy:sync-user"), "keep session");
  assert.equal(storage.data.get("band-galaxy:syl-taps"), "keep taps");
  assert.equal(storage.data.get("band-galaxy:llm-migrated"), "1");
});
test("blocked local storage never breaks startup migration", () => {
  const storage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  assert.doesNotThrow(() => migrateLegacy(storage));
});
test("config JSON excludes credential values and preserves user provider order", () => {
  const storage = new StorageFixture();
  const provider = { id: "fixture", kind: "openai-compatible" as const, label: "测试接口", baseURL: "https://endpoint.example/v1", model: "user-selected", jsonMode: "json_object" as const, timeoutMs: 1000, tasks: ["sentence" as const] };
  saveFeedbackConfig({ version: 1, providers: [provider] }, storage);
  setCredential(provider.id, "private-current-value", storage);
  assert.equal(storage.data.get("band-galaxy:llm")?.includes("private-current-value"), false);
  assert.equal(getCredential(provider.id, storage), "private-current-value");
  assert.deepEqual(getFeedbackConfig(storage).providers, [provider]);
});
test("a known credential cannot be copied into public provider metadata", () => {
  const storage = new StorageFixture();
  const provider = { id: "fixture", kind: "openai-compatible" as const, label: "接口", baseURL: "https://endpoint.example/v1", model: "user-selected", jsonMode: "json_object" as const, timeoutMs: 1000, tasks: ["sentence" as const] };
  saveFeedbackConfig({ version: 1, providers: [provider] }, storage); setCredential(provider.id, "private-current-value", storage);
  const previous = storage.data.get("band-galaxy:llm");
  assert.throws(() => saveFeedbackConfig({ version: 1, providers: [{ ...provider, label: "private-current-value" }] }, storage), (error: unknown) => {
    assert.equal(String(error).includes("private-current-value"), false); return true;
  });
  assert.equal(storage.data.get("band-galaxy:llm"), previous);
});
test("vocabulary backup excludes endpoint config and credentials", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), storage = new StorageFixture();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    saveFeedbackConfig({ version: 1, providers: [{ id: "fixture", kind: "openai-compatible", label: "接口", baseURL: "https://private-endpoint.example/v1", model: "private-selected-model", jsonMode: "prompt-only", timeoutMs: 1000, tasks: ["sentence"] }] });
    setCredential("fixture", "private-current-value");
    const { exportBackup } = await import("../../store/store");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { clearTimeout } });
    const backup = exportBackup();
    for (const value of ["private-current-value", "private-endpoint.example", "private-selected-model", "band-galaxy:llm"]) assert.equal(backup.includes(value), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});

for (const prefix of ["s" + "k-", "s" + "k-proj-", "x" + "ai-", "AI" + "za"]) for (const field of ["id", "label", "model", "baseURL"] as const) test(`public config rejects credential-shaped ${prefix} text in ${field} before saving a credential`, () => {
  const storage = new StorageFixture(), token = prefix + "A".repeat(36);
  const provider = { id: "fixture", kind: "openai-compatible" as const, label: "接口", baseURL: "https://endpoint.example/v1", model: "user-selected", jsonMode: "json_object" as const, timeoutMs: 1000, tasks: ["sentence" as const] };
  const invalid = { ...provider, [field]: field === "baseURL" ? `${provider.baseURL}/${token}` : token };
  assert.throws(() => saveFeedbackConfig({ version: 1, providers: [invalid] }, storage), (error: unknown) => {
    assert.equal(String(error).includes(token), false); return true;
  });
  assert.equal(storage.data.has("band-galaxy:llm"), false);
});
test("a credential cannot move into another provider while its original provider is removed", () => {
  const storage = new StorageFixture(), credential = "private-previous-value";
  const provider = { id: "previous", kind: "openai-compatible" as const, label: "接口", baseURL: "https://endpoint.example/v1", model: "user-selected", jsonMode: "prompt-only" as const, timeoutMs: 1000, tasks: ["sentence" as const] };
  saveFeedbackConfig({ version: 1, providers: [provider] }, storage); setCredential(provider.id, credential, storage);
  assert.throws(() => saveFeedbackConfig({ version: 1, providers: [{ ...provider, id: "new", label: credential }] }, storage));
  assert.equal(storage.data.get("band-galaxy:llm")?.includes(credential), false);
});
test("public config rejects URL-encoded credential text", () => {
  const storage = new StorageFixture(), token = "s" + "k-proj-" + "A".repeat(36);
  const provider = { id: "fixture", kind: "openai-compatible" as const, label: "接口", baseURL: `https://endpoint.example/v1/%73${token.slice(1)}`, model: "user-selected", jsonMode: "prompt-only" as const, timeoutMs: 1000, tasks: ["sentence" as const] };
  assert.throws(() => saveFeedbackConfig({ version: 1, providers: [provider] }, storage));
  assert.equal(storage.data.has("band-galaxy:llm"), false);
});
test("ordinary user model IDs and local or HTTPS endpoints remain configurable", () => {
  const storage = new StorageFixture();
  for (const [model, baseURL] of [["user-selected", "https://endpoint.example/v1"], ["mask-" + "A".repeat(36), "http://localhost:11434/v1"]]) {
    const provider = { id: "fixture", kind: "openai-compatible" as const, label: "接口", baseURL, model, jsonMode: "prompt-only" as const, timeoutMs: 1000, tasks: ["sentence" as const] };
    saveFeedbackConfig({ version: 1, providers: [provider] }, storage);
    assert.equal(getFeedbackConfig(storage).providers[0].model, model);
    assert.equal(getFeedbackConfig(storage).providers[0].baseURL, baseURL);
  }
});
test("outbound guards reject credential metadata without confusing word-ID maps", () => {
  assert.throws(() => assertNoCredentials({ entry: { apiKey: "private-short-value" } }), /密钥/);
  assert.doesNotThrow(() => assertNoCredentials({ cards: { key: { due: 1 }, password: { due: 2 } } }));
});
