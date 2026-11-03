import { z } from "zod";
import type { FeedbackConfig, ProviderConfig } from "./types";

const KEY = "band-galaxy:llm", SECRET = "band-galaxy:llm-secret:", MARKER = "band-galaxy:llm-migrated";
export type LocalStoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const listeners = new Set<() => void>();
const identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const credentialPattern = /\b(?:sk-(?:ant-|proj-)[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}|gh[po]_[A-Za-z0-9_-]{10,})/;
function textForms(value: string): string[] {
  const values = [value];
  for (let round = 0; round < 3; round++) {
    try { const decoded = decodeURIComponent(values.at(-1)!); if (decoded === values.at(-1)) break; values.push(decoded); }
    catch { break; }
  }
  return values;
}
const publicText = (maximum: number) => z.string().trim().max(maximum).refine((value) => !textForms(value).some((form) => credentialPattern.test(form)));
export class CredentialPrivacyError extends Error {
  constructor() { super("内容疑似包含密钥，已阻止发送或保存；请检查本次内容，原稿仍保留。"); this.name = "CredentialPrivacyError"; }
}
function knownCredentials(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object" || !("providers" in value) || !Array.isArray(value.providers)) return [];
    return value.providers.flatMap((provider: unknown) => {
      if (!provider || typeof provider !== "object" || !("id" in provider) || typeof provider.id !== "string" || !identifier.test(provider.id)) return [];
      const secret = localStorage.getItem(SECRET + provider.id); return secret ? [secret] : [];
    });
  } catch { return []; }
}
/** Read-only guard; callers receive no credential material. Authorization headers
 * are deliberately outside this input: only content and public metadata belong here. */
export function assertNoCredentials(value: unknown): void {
  const secrets = knownCredentials(), visited = new WeakSet<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 40) throw new Error("内容结构过深，无法安全处理。");
    if (typeof item === "string") {
      if (textForms(item).some((text) => credentialPattern.test(text) || secrets.some((secret) => text.includes(secret)))) throw new CredentialPrivacyError();
    } else if (item && typeof item === "object") {
      if (visited.has(item)) throw new Error("内容不能包含循环引用。");
      visited.add(item);
      for (const [key, child] of Object.entries(item)) {
        visit(key, depth + 1);
        if (/^(?:apikey|authorization|accesstoken|refreshtoken|credential|password)$/.test(key.toLowerCase().replace(/[^a-z]/g, "")) && typeof child === "string" && child.trim()) throw new CredentialPrivacyError();
        visit(child, depth + 1);
      }
      visited.delete(item);
    }
  };
  visit(value, 0);
}
export function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}
const providerSchema = z.strictObject({
  id: publicText(64).regex(identifier), kind: z.literal("openai-compatible"), label: publicText(100),
  baseURL: publicText(2000).refine((url) => !url || validEndpoint(url)), model: publicText(200),
  jsonMode: z.enum(["json_schema", "json_object", "prompt-only"]), timeoutMs: z.number().int().min(100).max(120000),
  tasks: z.array(z.enum(["essay", "speaking", "sentence", "reading", "hack"])).max(5),
});
const configSchema = z.strictObject({ version: z.literal(1), providers: z.array(providerSchema).max(20) }).refine((value) => new Set(value.providers.map((p) => p.id)).size === value.providers.length);
const notify = () => listeners.forEach((listener) => listener());
export function subscribeFeedbackConfig(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function migrateLegacy(storage?: LocalStoragePort) {
  try {
    const port = storage ?? localStorage;
    if (port.getItem(MARKER) === "1") return;
    port.removeItem("band-galaxy:ai-key");
    port.setItem(MARKER, "1");
  } catch { /* Restricted storage must not block startup. */ }
}
export function getFeedbackConfig(storage?: LocalStoragePort): FeedbackConfig {
  try {
    const parsed = configSchema.safeParse(JSON.parse((storage ?? localStorage).getItem(KEY) ?? "null"));
    if (parsed.success) return parsed.data;
  } catch { /* Invalid local configuration is never promoted into shared settings. */ }
  return { version: 1, providers: [] };
}
export function saveFeedbackConfig(value: FeedbackConfig, storage?: LocalStoragePort) {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error("接口设置无效。请检查地址、模型、任务和超时；地址不得含账号、查询参数或片段。");
  try {
    const port = storage ?? localStorage, serialized = JSON.stringify(parsed.data);
    let previousIds: string[] = [];
    try {
      const previous: unknown = JSON.parse(port.getItem(KEY) ?? "null");
      if (previous && typeof previous === "object" && "providers" in previous && Array.isArray(previous.providers))
        previousIds = previous.providers.flatMap((provider: unknown) => provider && typeof provider === "object" && "id" in provider && typeof provider.id === "string" && identifier.test(provider.id) ? [provider.id] : []);
    } catch { /* An invalid old public config does not prevent replacing it. */ }
    const publicForms = parsed.data.providers.flatMap((provider) => [provider.id, provider.label, provider.model, provider.baseURL].flatMap(textForms));
    for (const id of new Set([...previousIds, ...parsed.data.providers.map((provider) => provider.id)])) {
      const credential = port.getItem(SECRET + id);
      if (credential && (serialized.includes(credential) || publicForms.some((text) => text.includes(credential)))) throw new Error("private");
    }
    port.setItem(KEY, serialized);
  } catch { throw new Error("接口设置未保存，请检查浏览器存储权限，勿把密钥填入其他字段。"); }
  notify();
}
export function getCredential(id: string, storage?: LocalStoragePort): string {
  if (!identifier.test(id)) return "";
  try { return (storage ?? localStorage).getItem(SECRET + id) ?? ""; } catch { return ""; }
}
export function setCredential(id: string, value: string, storage?: LocalStoragePort) {
  if (!identifier.test(id)) throw new Error("接口标识无效。");
  try {
    const port = storage ?? localStorage;
    if (value.trim()) port.setItem(SECRET + id, value.trim()); else port.removeItem(SECRET + id);
  } catch { throw new Error("密钥未保存，请检查浏览器存储权限。"); }
  notify();
}
export function removeProvider(id: string) {
  const config = getFeedbackConfig();
  saveFeedbackConfig({ ...config, providers: config.providers.filter((provider) => provider.id !== id) });
  setCredential(id, "");
}
export function normalizeProvider(value: ProviderConfig): ProviderConfig | null {
  const parsed = providerSchema.safeParse(value); return parsed.success ? parsed.data : null;
}
