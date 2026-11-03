import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { requestStructured, extractJson } from "./structured";
import { saveFeedbackConfig, setCredential } from "./config";
import { LlmError, type ProviderConfig } from "./types";
import { requestCompletion } from "./openaiCompatible";
const schema = z.strictObject({ band: z.number().min(0).max(9).refine((n) => Number.isInteger(n * 2)) });
const provider = (id: string): ProviderConfig => ({ id, kind: "openai-compatible", label: "接口", baseURL: `https://${id}.example/v1`, model: "user-selected", jsonMode: "json_schema", timeoutMs: 1000, tasks: ["essay"] });
async function fixture(run: (requests: { url: string; init?: RequestInit }[]) => Promise<void>, replies: (request: number, init?: RequestInit) => Promise<Response>) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousFetch = globalThis.fetch;
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) } });
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return replies(requests.length, init); };
  saveFeedbackConfig({ version: 1, providers: [provider("first"), provider("second")] });
  try { await run(requests); } finally { globalThis.fetch = previousFetch; if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else delete (globalThis as { localStorage?: unknown }).localStorage; }
}
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
test("401 falls back in order and fenced JSON is validated", async () => {
  await fixture(async (requests) => {
    const result = await requestStructured("essay", schema, { system: "评分", user: "作品" });
    assert.equal(result.provider, "second"); assert.deepEqual(result.value, { band: 7.5 });
    assert.deepEqual(result.fallbackTrail, [{ provider: "first", error: "auth" }]);
    assert.ok(requests.every((request) => request.init?.redirect === "error"));
  }, async (n) => n === 1 ? new Response("private response", { status: 401 }) : reply('```json\n{"band":7.5}\n```'));
});
test("invalid half band receives exactly one repair before moving on", async () => {
  await fixture(async (requests) => {
    const result = await requestStructured("essay", schema, { system: "评分", user: "作品" });
    assert.equal(requests.length, 3); assert.equal(result.provider, "second");
    assert.deepEqual(result.fallbackTrail, [{ provider: "first", error: "schema" }]);
  }, async (n) => reply(n <= 2 ? '{"band":7.3}' : '{"band":7.5}'));
});
test("all failed providers return no-provider without response-body or credential leakage", async () => {
  await fixture(async () => {
    setCredential("first", "private-current-value");
    await assert.rejects(requestStructured("essay", schema, { system: "评分", user: "作品" }), (error: unknown) => {
      assert.ok(error instanceof LlmError); assert.equal(error.code, "no-provider");
      assert.equal(JSON.stringify(error).includes("private-current-value"), false); return true;
    });
  }, async () => new Response("private-current-value", { status: 429 }));
});
test("caller cancellation never contacts the next provider", async () => {
  const controller = new AbortController();
  await fixture(async (requests) => {
    await assert.rejects(requestStructured("essay", schema, { system: "评分", user: "作品" }, { signal: controller.signal }), (error: unknown) => error instanceof LlmError && error.code === "cancelled");
    assert.equal(requests.length, 1);
  }, async (_n, init) => { controller.abort(); throw new DOMException(String(init?.signal?.reason ?? "cancel"), "AbortError"); });
});
test("a credential that coincides with provider metadata is blocked without exposing a failure trail", async () => {
  await fixture(async (requests) => {
    setCredential("first", "first");
    await assert.rejects(requestStructured("essay", schema, { system: "评分", user: "作品" }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /密钥/);
      assert.equal(JSON.stringify(error).includes('"first"'), false); return true;
    });
    assert.equal(requests.length, 0);
  }, async () => new Response("rejected", { status: 401 }));
});
test("repair prompts never echo another configured credential", async () => {
  await fixture(async (requests) => {
    saveFeedbackConfig({ version: 1, providers: [provider("first"), { ...provider("second"), tasks: ["reading"] }] });
    setCredential("second", "private-second-value");
    await requestStructured("essay", schema, { system: "评分", user: "作品" });
    assert.ok(requests.every((request) => !String(request.init?.body).includes("private-second-value")));
  }, async (n) => reply(n === 1 ? '{"band":7.5,"extra":"private-second-value"}' : '{"band":7.5}'));
});
test("an initial prompt containing another task provider's short credential is blocked before any fallback request", async () => {
  await fixture(async (requests) => {
    saveFeedbackConfig({ version: 1, providers: [provider("first"), { ...provider("second"), tasks: ["reading"] }] });
    setCredential("second", "private-short-key");
    await assert.rejects(requestStructured("essay", schema, { system: "评分", user: "My draft includes private-short-key." }), /密钥/);
    assert.equal(requests.length, 0);
  }, async () => reply('{"band":7.5}'));
});
test("direct completion also blocks another configured credential in messages", async () => {
  await fixture(async (requests) => {
    setCredential("second", "private-short-key");
    await assert.rejects(requestCompletion(provider("first"), [{ role: "user", content: "private-short-key" }]), /密钥/);
    assert.equal(requests.length, 0);
  }, async () => reply('{"band":7.5}'));
});
for (const prefix of ["s" + "k-", "s" + "k-proj-", "x" + "ai-", "AI" + "za"]) test(`an unconfigured credential-shaped ${prefix} prompt is blocked before fetch`, async () => {
  await fixture(async (requests) => {
    await assert.rejects(requestStructured("essay", schema, { system: "评分", user: prefix + "A".repeat(36) }), /密钥/);
    assert.equal(requests.length, 0);
  }, async () => reply('{"band":7.5}'));
});
test("normal Authorization credentials still reach only their selected endpoint", async () => {
  await fixture(async (requests) => {
    const credential = "s" + "k-proj-" + "A".repeat(36); setCredential("first", credential);
    const result = await requestStructured("essay", schema, { system: "评分", user: "Original draft." });
    assert.equal(result.provider, "first"); assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://first.example/v1/chat/completions");
    assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, `Bearer ${credential}`);
    assert.equal(String(requests[0].init?.body).includes(credential), false);
  }, async () => reply('{"band":7.5}'));
});
test("Unicode-escaped credentials are blocked after parsing without repair or returning decoded values", async () => {
  const secret = "private-second-value";
  const encoded = [...secret].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  await fixture(async (requests) => {
    setCredential("second", secret);
    await assert.rejects(requestStructured("essay", z.strictObject({ note: z.string() }), { system: "评分", user: "Original draft." }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /密钥/);
      assert.equal(String(error).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false); return true;
    });
    assert.equal(requests.length, 1);
    assert.ok(requests.every((request) => !String(request.init?.body).includes(secret)));
  }, async () => reply(`{"note":"${encoded}"}`));
});
test("JSON extraction strips only a surrounding code fence", () => { assert.equal(extractJson('```json\n{"band":7.5}\n```'), '{"band":7.5}'); });
