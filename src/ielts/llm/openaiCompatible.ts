import { assertNoCredentials, credentialMatchesContent, CredentialPrivacyError, getCredential, normalizeProvider, validEndpoint } from "./config";
import { LlmError, type ChatMessage, type ProviderConfig } from "./types";
export async function requestCompletion(provider: ProviderConfig, messages: ChatMessage[], jsonSchema?: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<string> {
  if (options.signal?.aborted) throw new LlmError("cancelled");
  const normalized = normalizeProvider(provider);
  if (!normalized || !validEndpoint(normalized.baseURL) || !normalized.model) throw new LlmError("http");
  provider = normalized;
  const credential = getCredential(provider.id);
  const outbound = { messages, jsonSchema, id: provider.id, label: provider.label, model: provider.model, baseURL: provider.baseURL };
  assertNoCredentials(outbound, credential);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, provider.timeoutMs);
  try {
    const responseFormat = provider.jsonMode === "json_schema" && jsonSchema
      ? { type: "json_schema", json_schema: { name: "feedback", strict: true, schema: jsonSchema } }
      : provider.jsonMode === "json_object" ? { type: "json_object" } : undefined;
    const response = await fetch(`${provider.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify({ model: provider.model, messages, ...(responseFormat ? { response_format: responseFormat } : {}) }),
    });
    if (options.signal?.aborted) throw new LlmError("cancelled");
    if (timedOut) throw new LlmError("timeout");
    if (response.status === 401 || response.status === 403) throw new LlmError("auth");
    if (response.status === 429) throw new LlmError("quota");
    if (!response.ok) throw new LlmError("http");
    let body: unknown;
    try { body = await response.json(); } catch { throw new LlmError("bad-json"); }
    if (options.signal?.aborted) throw new LlmError("cancelled");
    if (timedOut) throw new LlmError("timeout");
    const candidate = body && typeof body === "object" && "choices" in body ? (body as { choices?: unknown }).choices : null;
    const first = Array.isArray(candidate) ? candidate[0] as { message?: { content?: unknown } } | undefined : undefined;
    const content = first?.message?.content;
    if (typeof content !== "string" || !content.trim() || content.length > 1000000 || credentialMatchesContent(content, credential)) throw new LlmError("bad-json");
    return content;
  } catch (error) {
    if (options.signal?.aborted) throw new LlmError("cancelled");
    if (timedOut || controller.signal.aborted) throw new LlmError("timeout");
    if (error instanceof LlmError) throw error;
    throw new LlmError("network");
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel); }
}
export async function testProvider(provider: ProviderConfig, options?: { signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; code: import("./types").LlmErrorCode; message: string }> {
  try { await requestCompletion(provider, [{ role: "user", content: "请只回复OK。" }], undefined, options); return { ok: true }; }
  catch (error) {
    if (error instanceof CredentialPrivacyError) return { ok: false, code: "schema", message: error.message };
    const safe = error instanceof LlmError ? error : new LlmError("network"); return { ok: false, code: safe.code, message: safe.message };
  }
}
