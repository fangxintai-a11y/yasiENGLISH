/** Block credential-shaped values before an operation can publish or persist them. */
const credential = /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{20,}|\bxai-[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{30,}|\b(?:ghp_|gho_)[A-Za-z0-9_-]{20,}/;
export class ScoringPrivacyError extends Error {}
export function assertNoSecrets(value: unknown): void {
  const seen = new WeakSet<object>();
  const walk = (item: unknown, depth: number) => {
    if (depth > 20) throw new Error("输入结构过深，请缩短后重试。");
    if (typeof item === "string" && credential.test(item)) throw new ScoringPrivacyError("内容疑似包含密钥，已阻止发送或保存；请先从本次内容中移除，原稿仍保留。");
    if (item && typeof item === "object") {
      if (seen.has(item)) throw new Error("输入不能包含循环引用。");
      seen.add(item);
      for (const value of Object.values(item)) walk(value, depth + 1);
      seen.delete(item);
    }
  };
  walk(value, 0);
}
