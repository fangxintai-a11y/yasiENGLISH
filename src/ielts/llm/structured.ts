import { z, type ZodType } from "zod";
import { chain } from "./chain";
import { assertNoCredentials, CredentialPrivacyError, getCredential } from "./config";
import { extractJson, validationErrors } from "./manual";
import { requestCompletion } from "./openaiCompatible";
import { LlmError, providerReference, type ChatMessage, type FallbackEntry, type Prompt, type TaskId } from "./types";
export { extractJson } from "./manual";
export async function requestStructured<T>(task: TaskId, schema: ZodType<T>, prompt: Prompt, options: { signal?: AbortSignal } = {}): Promise<{ value: T; provider: string; fallbackTrail: FallbackEntry[] }> {
  if (options.signal?.aborted) throw new LlmError("cancelled");
  assertNoCredentials(prompt);
  const trail: FallbackEntry[] = [];
  const jsonSchema = z.toJSONSchema(schema);
  const providers = chain(task), credentials = providers.map((provider) => getCredential(provider.id)).filter(Boolean);
  const reference = (id: string) => credentials.some((credential) => id.includes(credential)) ? "接口" : providerReference(id);
  for (const provider of providers) {
    const messages: ChatMessage[] = [{ role: "system", content: prompt.system }, { role: "user", content: `${prompt.user}\n只返回JSON。\nJSON Schema：${JSON.stringify(jsonSchema)}` }];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.signal?.aborted) throw new LlmError("cancelled", trail);
      try {
        const content = await requestCompletion(provider, messages, jsonSchema, options);
        if (options.signal?.aborted) throw new LlmError("cancelled", trail);
        try { assertNoCredentials(content); } catch (error) { if (error instanceof CredentialPrivacyError) throw new LlmError("bad-json"); throw error; }
        if (credentials.some((credential) => content.includes(credential))) throw new LlmError("bad-json");
        let parsed: unknown;
        try { parsed = JSON.parse(extractJson(content)); } catch { throw new LlmError("bad-json"); }
        assertNoCredentials(parsed);
        const result = schema.safeParse(parsed);
        if (result.success) return { value: result.data, provider: reference(provider.id), fallbackTrail: trail };
        if (attempt === 0) { messages.push({ role: "assistant", content }, { role: "user", content: `请修复以下字段，仅返回JSON：\n${validationErrors(result.error.issues).join("\n")}` }); continue; }
        throw new LlmError("schema");
      } catch (error) {
        if (error instanceof CredentialPrivacyError) throw error;
        const safe = error instanceof LlmError ? error : new LlmError("schema");
        if (options.signal?.aborted || safe.code === "cancelled") throw new LlmError("cancelled", trail);
        if (attempt === 0 && (safe.code === "bad-json" || safe.code === "schema")) { messages.push({ role: "user", content: "返回内容无法校验，请按JSON Schema修复，只返回JSON对象。" }); continue; }
        trail.push({ provider: reference(provider.id), error: safe.code }); break;
      }
    }
  }
  if (options.signal?.aborted) throw new LlmError("cancelled", trail);
  throw new LlmError("no-provider", trail);
}
export const structured = requestStructured;
