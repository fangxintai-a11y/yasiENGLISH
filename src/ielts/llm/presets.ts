import type { ProviderConfig } from "./types";
export const PROVIDER_PRESETS: { id: string; label: string; baseURL: string }[] = [
  { id: "custom", label: "自定义兼容接口", baseURL: "" },
  { id: "local", label: "本机接口", baseURL: "http://localhost:11434/v1" },
];
export function createProvider(preset = "custom"): ProviderConfig {
  const template = PROVIDER_PRESETS.find((item) => item.id === preset) ?? PROVIDER_PRESETS[0];
  return { id: crypto.randomUUID(), kind: "openai-compatible", label: template.label, baseURL: template.baseURL, model: "", jsonMode: "json_schema", timeoutMs: 30000, tasks: ["essay", "speaking", "sentence", "reading", "hack"] };
}
