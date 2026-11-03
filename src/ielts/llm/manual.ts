import { z, type ZodType } from "zod";
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}
export function validationErrors(issues: { path: PropertyKey[]; code: string }[]): string[] {
  return issues.slice(0, 8).map((issue) => {
    const field = issue.path.map((part) => typeof part === "number" ? String(part) : /^[a-z][a-z0-9]{0,39}$/i.test(String(part)) ? String(part) : "字段").join(".") || "结果";
    return `${field}：${issue.code === "unrecognized_keys" ? "含有不支持的字段" : issue.code === "too_big" ? "数值或长度超过允许范围" : issue.code === "too_small" ? "数值或长度不足" : "类型、取值或字段格式不符合要求"}。`;
  });
}
export function createManualPrompt<T>(system: string, user: string, schema: ZodType<T>): { text: string; schemaName: string } {
  return { schemaName: "feedback", text: `${system}\n\n${user}\n\n请只返回符合以下JSON Schema的JSON对象，不添加解释：\n${JSON.stringify(z.toJSONSchema(schema), null, 2)}` };
}
export const buildManualPrompt = createManualPrompt;
export function validateManualResult<T>(pasted: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false; errors: string[] } {
  if (pasted.length > 1000000) return { ok: false, errors: ["粘贴内容过长，请缩短后重试。"] };
  let value: unknown;
  try { value = JSON.parse(extractJson(pasted)); } catch { return { ok: false, errors: ["无法读取JSON，请粘贴完整的JSON对象。"] }; }
  const result = schema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: validationErrors(result.error.issues) };
}
export const parseManual = validateManualResult;
