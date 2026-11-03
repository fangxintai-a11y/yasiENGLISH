import { isObject } from "./protocol";

export class LearningApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly body?: unknown) { super(message); }
}

/** The expected account is a precondition, never an alternative to the session Cookie. */
export async function learningRequest(userId: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json", ...(path.startsWith("/api/learning/") ? { "X-Learning-User": userId } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new LearningApiError(response.status || 503, "学习记录服务暂不可用，本机内容仍已保留。", "unavailable");
    const data: unknown = await response.json();
    if (!response.ok) throw new LearningApiError(response.status, isObject(data) && typeof data.error === "string" ? data.error : "学习记录暂未同步。", isObject(data) && typeof data.code === "string" ? data.code : undefined, data);
    return data;
  } finally { window.clearTimeout(timer); }
}
