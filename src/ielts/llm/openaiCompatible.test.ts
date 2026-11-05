import assert from "node:assert/strict";
import { test } from "node:test";
import { requestCompletion } from "./openaiCompatible";
import { LlmError, type ProviderConfig } from "./types";
const provider: ProviderConfig = { id: "fixture", kind: "openai-compatible", label: "接口", baseURL: "https://endpoint.example/v1", model: "user-selected", jsonMode: "prompt-only", timeoutMs: 100, tasks: ["sentence"] };
async function usingFetch(fetcher: typeof fetch, run: () => Promise<void>) {
  const previous = globalThis.fetch; globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = previous; }
}
const code = (expected: string) => (error: unknown) => error instanceof LlmError && error.code === expected && /[\u4e00-\u9fff]/.test(error.message);
for (const [status, expected] of [[403, "auth"], [429, "quota"], [502, "http"]] as const) test(`HTTP ${status} maps to a safe ${expected} error`, async () => {
  await usingFetch(async () => new Response("private-remote-error", { status }), async () => {
    await assert.rejects(requestCompletion(provider, []), (error: unknown) => {
      assert.equal(JSON.stringify(error).includes("private-remote-error"), false); return code(expected)(error);
    });
  });
});
test("network exceptions are never exposed verbatim", async () => {
  await usingFetch(async () => { throw new TypeError("private-remote-error"); }, async () => {
    await assert.rejects(requestCompletion(provider, []), (error: unknown) => {
      assert.equal(String(error).includes("private-remote-error"), false); return code("network")(error);
    });
  });
});
test("a timed-out fetch cannot later return a successful completion", async () => {
  await usingFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return new Response(JSON.stringify({ choices: [{ message: { content: "late reply" } }] }));
  }, async () => { await assert.rejects(requestCompletion(provider, []), code("timeout")); });
});
test("an already cancelled signal makes no request", async () => {
  const controller = new AbortController(); controller.abort();
  await usingFetch(async () => { assert.fail("cancelled request sent"); }, async () => {
    await assert.rejects(requestCompletion(provider, [], undefined, { signal: controller.signal }), code("cancelled"));
  });
});
test("URLs containing credentials or query parameters never receive a request", async () => {
  await usingFetch(async () => { assert.fail("unsafe endpoint requested"); }, async () => {
    for (const baseURL of ["https://name:private-value@endpoint.example/v1", "https://endpoint.example/v1?key=private-value"]) {
      await assert.rejects(requestCompletion({ ...provider, baseURL }, []), code("http"));
    }
  });
});
test("connection testing uses the same trimmed endpoint and model as saved config", async () => {
  await usingFetch(async (url, init) => {
    assert.equal(String(url), "https://endpoint.example/v1/chat/completions");
    assert.equal(JSON.parse(String(init?.body)).model, "user-selected");
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  }, async () => { await requestCompletion({ ...provider, baseURL: " https://endpoint.example/v1/ ", model: " user-selected " }, []); });
});
