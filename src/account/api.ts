import { CloudError } from "../store/cloudSyncEngine";

/** Same-origin account and progress requests always bypass browser HTTP caches. */
export async function accountRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!(response.headers.get("content-type") ?? "").includes("application/json"))
      throw new CloudError("当前网站尚未连接账号服务，本机学习和导出备份仍可使用。", 503);
    const data = await response.json();
    if (!response.ok) throw new CloudError(typeof data.error === "string" ? data.error : "请求未完成，请稍后重试。", response.status);
    return data as T;
  } finally { window.clearTimeout(timeout); }
}
