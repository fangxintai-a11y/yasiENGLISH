import {
  MAX_PROMPT_BANK_BYTES,
  parsePromptBank,
  type LocalPrompt,
} from "./promptBankSchema";
export { promptStimulusUrl } from "./promptBankSchema";
const DB = "band-galaxy-local-prompts";
const scopeFor = (userId: string | null) =>
  userId === null ? "guest" : `user:${userId}`;
interface StoredPrompt {
  scope: string;
  id: string;
  version: string;
  prompt: LocalPrompt;
  importedAt: number;
}
export interface PromptImportResult {
  imported: number;
  duplicate: number;
  skipped: number;
  issues: string[];
}
const issueCache = new Map<string, string[]>();
export const promptBankIssues = (userId: string | null): readonly string[] =>
  issueCache.get(scopeFor(userId)) ?? [];
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () =>
      request.result
        .createObjectStore("prompts", { keyPath: ["scope", "id", "version"] })
        .createIndex("scope", "scope");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(new Error("本机写说题库无法打开，已有学习记录未改动。"));
    request.onblocked = () =>
      reject(new Error("请关闭旧版写说题库页面后重试。"));
  });
}
const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(new Error("写说题库未保存，原题目仍保留。"));
  });
async function stored(userId: string | null): Promise<StoredPrompt[]> {
  const database = await open();
  try {
    const transaction = database.transaction("prompts", "readonly"),
      request = transaction
        .objectStore("prompts")
        .index("scope")
        .getAll(scopeFor(userId));
    const values = await new Promise<StoredPrompt[]>((resolve, reject) => {
      let rows: StoredPrompt[] = [];
      request.onsuccess = () => {
        rows = request.result;
      };
      transaction.oncomplete = () => resolve(rows);
      transaction.onerror = transaction.onabort = () =>
        reject(new Error("本机写说题库读取失败，原题目保留。"));
    });
    return values.sort((a, b) => b.importedAt - a.importedAt);
  } finally {
    database.close();
  }
}
/** Same-version conflicts never replace the user's original, including later manifest loads. */
export function mergePromptBank(
  existing: readonly LocalPrompt[],
  incoming: readonly LocalPrompt[],
) {
  const prompts = [...existing],
    hashes = new Map(
      existing.map((prompt) => [
        `${prompt.id}@${prompt.version}`,
        prompt.contentHash,
      ]),
    );
  const issues: string[] = [];
  let duplicate = 0;
  for (const prompt of incoming) {
    const key = `${prompt.id}@${prompt.version}`,
      previous = hashes.get(key);
    if (previous === prompt.contentHash) {
      duplicate++;
      continue;
    }
    if (previous) {
      issues.push(`${key}：同版本内容不同，保留本机原题。`);
      continue;
    }
    hashes.set(key, prompt.contentHash);
    prompts.push(prompt);
  }
  return { prompts, issues, duplicate };
}
export async function importPromptBank(
  userId: string | null,
  input: unknown,
): Promise<PromptImportResult> {
  const parsed = await parsePromptBank(input),
    previous = await stored(userId),
    merged = mergePromptBank(
      previous.map((row) => row.prompt),
      parsed.prompts,
    );
  const oldKeys = new Set(previous.map((row) => `${row.id}@${row.version}`)),
    additions = merged.prompts.filter(
      (prompt) => !oldKeys.has(`${prompt.id}@${prompt.version}`),
    );
  if (additions.length) {
    const database = await open();
    try {
      const transaction = database.transaction("prompts", "readwrite"),
        completion = done(transaction),
        at = Date.now();
      try {
        for (const [index, prompt] of additions.entries())
          transaction.objectStore("prompts").add({
            scope: scopeFor(userId),
            id: prompt.id,
            version: prompt.version,
            prompt,
            importedAt: at + index,
          } satisfies StoredPrompt);
        await completion;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* Already completed or aborted. */
        }
        await completion.catch(() => {});
        throw error;
      }
    } finally {
      database.close();
    }
  }
  const issues = [...parsed.issues, ...merged.issues];
  issueCache.set(scopeFor(userId), issues);
  return {
    imported: additions.length,
    duplicate: parsed.duplicate + merged.duplicate,
    skipped: issues.length,
    issues,
  };
}
export async function importPromptBankFile(
  userId: string | null,
  file: File,
): Promise<PromptImportResult> {
  if (!file.size || file.size > MAX_PROMPT_BANK_BYTES)
    throw new Error("写说题库JSON须非空且不超过20 MB。");
  let input: unknown;
  try {
    input = JSON.parse(await file.text());
  } catch {
    throw new Error("写说题库不是有效JSON。");
  }
  return importPromptBank(userId, input);
}
async function limitedText(response: Response): Promise<string> {
  if (
    Number(response.headers.get("Content-Length") ?? 0) > MAX_PROMPT_BANK_BYTES
  )
    throw new Error("本机写说题库超过20 MB。");
  if (!response.body) return "";
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PROMPT_BANK_BYTES) {
        await reader.cancel();
        throw new Error("本机写说题库超过20 MB。");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export async function loadPromptBank(
  userId: string | null,
): Promise<LocalPrompt[]> {
  const issues: string[] = [];
  let local: LocalPrompt[] = [];
  try {
    const parsed = await parsePromptBank({
      importVersion: 1,
      prompts: (await stored(userId)).map((row) => row.prompt),
    });
    local = parsed.prompts;
    issues.push(...parsed.issues);
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "本机写说题库未能读取。",
    );
  }
  issueCache.set(scopeFor(userId), [
    ...new Set([...(issueCache.get(scopeFor(userId)) ?? []), ...issues]),
  ]);
  return local;
}
/** Reading a prepared directory is an explicit import, not a side effect of visiting Me. */
export async function importPromptManifest(
  userId: string | null,
): Promise<PromptImportResult> {
  const response = await fetch("/local-bank/prompts.json", {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error("本机还没有已转换的写说目录，请选择题库JSON导入。");
  let input: unknown;
  try {
    input = JSON.parse(await limitedText(response));
  } catch {
    throw new Error("本机写说目录无效或超过20 MB，请检查转换结果。");
  }
  return importPromptBank(userId, input);
}
