export const TASK_LABELS = { essay: "写作", speaking: "口语", sentence: "造句", reading: "阅读", hack: "记忆钩子" } as const;
export type TaskId = keyof typeof TASK_LABELS;
export interface ProviderConfig {
  id: string; kind: "openai-compatible"; label: string; baseURL: string; model: string;
  jsonMode: "json_schema" | "json_object" | "prompt-only";
  timeoutMs: number; tasks: TaskId[];
}
export interface FeedbackConfig { version: 1; providers: ProviderConfig[] }
export type LlmErrorCode = "no-provider" | "auth" | "quota" | "network" | "timeout" | "cancelled" | "bad-json" | "schema" | "http";
export interface FallbackEntry { provider: string; error: LlmErrorCode }
const messages: Record<LlmErrorCode, string> = {
  "no-provider": "接口暂未提供有效结果，可复制提示词继续。", auth: "接口凭据无效或无权访问。", quota: "接口请求受限，请稍后再试。",
  network: "无法连接接口，请检查网络和跨域设置。", timeout: "接口请求超时。", cancelled: "已取消本次请求。",
  "bad-json": "接口没有返回有效JSON。", schema: "结果字段不符合要求。", http: "接口请求未成功。",
};
export class LlmError extends Error {
  readonly fallbackTrail: FallbackEntry[];
  constructor(readonly code: LlmErrorCode, trail: FallbackEntry[] = []) {
    super(messages[code]); this.name = "LlmError"; this.fallbackTrail = trail;
  }
}
export interface Prompt { system: string; user: string }
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export const providerReference = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : "接口";
