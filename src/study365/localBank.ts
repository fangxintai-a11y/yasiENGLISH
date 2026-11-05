import {
  parsePrivateBankManifest,
  type PrivateAudioTransport,
} from "./privateBankManifest";
import samples from "../../public/curriculum365/v1/samples.json";
import audioProvenance from "../../public/curriculum365/v1/audio/provenance.json";
import { decodeLocalBankArchive } from "./localBankArchive";
import {
  LocalMaterialSchema,
  hashLocalMaterial,
  isLocalAudioPath,
  parseLocalBank,
  type LocalMaterial,
} from "./localBankSchema";

const DB_NAME = "band-galaxy-local-bank",
  DB_VERSION = 1;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
type StoredMaterial = {
  scope: string;
  id: string;
  version: string;
  material: LocalMaterial;
  importedAt?: number;
};
type StoredAudio = {
  scope: string;
  path: string;
  blob?: Blob;
  sha256: string;
  transport?: PrivateAudioTransport;
};
export interface BankImportResult {
  imported: number;
  duplicate: number;
  skipped: number;
  issues: string[];
}
const issuesByScope = new Map<string, string[]>();
const scopeFor = (userId: string | null) =>
  userId === null ? "guest" : `user:${userId}`;
export const localBankIssues = (userId: string | null): readonly string[] =>
  issuesByScope.get(scopeFor(userId)) ?? [];
function openBank(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("materials", {
        keyPath: ["scope", "id", "version"],
      }).createIndex("scope", "scope");
      db.createObjectStore("audio", { keyPath: ["scope", "path"] }).createIndex(
        "scope",
        "scope",
      );
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(new Error("本机题库无法打开，原有学习数据没有被清除。"));
    request.onblocked = () =>
      reject(new Error("请关闭其他旧版页面后重试打开题库。"));
  });
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(
        new Error("题库未保存，请检查本机存储空间后重试；原有题库没有被清除。"),
      );
  });
}
async function readStored(
  userId: string | null,
): Promise<{ materials: StoredMaterial[]; audio: StoredAudio[] }> {
  const db = await openBank();
  try {
    const tx = db.transaction(["materials", "audio"], "readonly"),
      done = completed(tx),
      key = IDBKeyRange.only(scopeFor(userId));
    try {
      const [materials, audio] = await Promise.all([
        requestValue(
          tx.objectStore("materials").index("scope").getAll(key),
        ) as Promise<StoredMaterial[]>,
        requestValue(
          tx.objectStore("audio").index("scope").getAll(key),
        ) as Promise<StoredAudio[]>,
      ]);
      await done;
      materials.sort(
        (a, b) =>
          (b.importedAt ?? 0) - (a.importedAt ?? 0) ||
          b.version.localeCompare(a.version),
      );
      return { materials, audio };
    } catch (error) {
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}
async function digest(blob: Blob): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
function audioURL(path: string): string {
  if (!isLocalAudioPath(path))
    throw new Error("音频路径不在本机题库允许范围。");
  return path.startsWith("audio/") ? `/local-bank/${path}` : path;
}
function matchingAudio(
  material: LocalMaterial,
  known: readonly StoredAudio[],
): StoredAudio | undefined {
  if (material.skill !== "listening" || !material.audio) return undefined;
  const metadata = material.audio;
  const original = known.find(
    (item) =>
      !!item.blob &&
      item.path === metadata.path &&
      (!metadata.sha256 || item.sha256 === metadata.sha256),
  );
  if (original) return original;
  const compressed = known.find(
    (item) =>
      !!item.blob &&
      item.transport?.originalPath === metadata.path &&
      item.transport.sourceSha256 === metadata.sha256 &&
      item.sha256 === item.transport.sha256,
  );
  if (compressed) return compressed;
  const descriptor = known.find(
    (item) =>
      item.transport?.originalPath === metadata.path &&
      item.transport.sourceSha256 === metadata.sha256,
  )?.transport;
  return descriptor
    ? known.find(
        (item) =>
          !!item.blob &&
          item.path === descriptor.path &&
          item.sha256 === descriptor.sha256,
      )
    : undefined;
}
async function fetchAudio(
  material: LocalMaterial,
  known: readonly StoredAudio[],
): Promise<StoredAudio | null> {
  if (material.skill !== "listening" || !material.audio) return null;
  const metadata = material.audio,
    existing = matchingAudio(material, known);
  if (existing?.blob) return existing;
  const prepared = known.find(
    (item) =>
      item.transport?.originalPath === metadata.path &&
      item.transport.sourceSha256 === metadata.sha256,
  );
  const transport = prepared?.transport;
  const response = await fetch(transport?.path ?? audioURL(metadata.path), {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error("登录已过期，请重新登录后准备私有音频；已缓存材料保留。");
  if (!response.ok) throw new Error(`${material.title}：本机音频文件未找到。`);
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > MAX_AUDIO_BYTES)
    throw new Error(`${material.title}：音频超过50 MB。`);
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_AUDIO_BYTES)
    throw new Error(`${material.title}：音频为空或超过50 MB。`);
  if (transport && blob.size !== transport.bytes)
    throw new Error(`${material.title}：私有音频大小与目录不一致。`);
  const sha256 = await digest(blob);
  if (
    (transport?.sha256 ?? metadata.sha256) &&
    (transport?.sha256 ?? metadata.sha256) !== sha256
  )
    throw new Error(`${material.title}：音频校验失败。`);
  return {
    scope: "",
    path: transport?.path ?? metadata.path,
    blob,
    sha256,
    ...(transport ? { transport } : {}),
  };
}
async function saveBank(
  userId: string | null,
  materials: readonly LocalMaterial[],
  audio: readonly StoredAudio[],
): Promise<BankImportResult> {
  const existing = await readStored(userId),
    keys = new Map(
      existing.materials.map((item) => [
        `${item.id}@${item.version}`,
        item.material.contentHash,
      ]),
    );
  const issues: string[] = [],
    accepted: LocalMaterial[] = [];
  let duplicate = 0;
  for (const material of materials) {
    const key = `${material.id}@${material.version}`,
      hash = keys.get(key);
    if (hash === material.contentHash) {
      duplicate++;
      continue;
    }
    if (hash) {
      issues.push(`${key}：同一版本内容不同，保留本机原件。`);
      continue;
    }
    keys.set(key, material.contentHash);
    accepted.push(material);
  }
  const db = await openBank();
  try {
    const tx = db.transaction(["materials", "audio"], "readwrite"),
      done = completed(tx),
      scope = scopeFor(userId);
    try {
      const importedAt = existing.materials.reduce(
        (latest, item) => Math.max(latest, (item.importedAt ?? 0) + 1),
        Date.now(),
      );
      for (const [index, material] of accepted.entries())
        tx.objectStore("materials").add({
          scope,
          id: material.id,
          version: material.version,
          material,
          importedAt: importedAt + index,
        } satisfies StoredMaterial);
      for (const item of audio) {
        const previous = existing.audio.find(
          (value) => value.path === item.path,
        );
        const metadataUpdate =
          !!previous?.transport &&
          !previous.blob &&
          !!item.transport &&
          !item.blob &&
          previous.transport.originalPath === item.transport.originalPath &&
          previous.transport.sourceSha256 === item.transport.sourceSha256;
        if (previous && previous.sha256 !== item.sha256 && !metadataUpdate)
          throw new Error(
            "同路径音频内容不同，请使用新的路径和材料版本，原件未被覆盖。",
          );
        if (!previous) tx.objectStore("audio").add({ ...item, scope });
        else if ((!previous.blob && item.blob) || metadataUpdate)
          tx.objectStore("audio").put({ ...previous, ...item, scope });
      }
    } catch (error) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error(
        error instanceof Error && error.message.startsWith("同路径音频")
          ? error.message
          : "题库未保存，请检查本机存储空间后重试；原有题库没有被清除。",
      );
    }
    await done;
  } finally {
    db.close();
  }
  return {
    imported: accepted.length,
    duplicate,
    skipped: issues.length,
    issues,
  };
}
export async function importLocalBank(
  userId: string | null,
  input: unknown,
  options: { cacheAudio?: boolean } = {},
): Promise<BankImportResult> {
  const parsed = await parseLocalBank(input),
    stored = await readStored(userId),
    audio: StoredAudio[] = [],
    issues = [...parsed.issues];
  for (const material of options.cacheAudio ? parsed.materials : []) {
    try {
      const item = await fetchAudio(material, stored.audio);
      if (item) audio.push(item);
    } catch (error) {
      issues.push(
        error instanceof Error
          ? error.message
          : "本机音频未缓存，文字材料仍可保留。",
      );
    }
  }
  const result = await saveBank(userId, parsed.materials, audio);
  const combined = {
    ...result,
    duplicate: result.duplicate + parsed.duplicate,
    skipped: result.skipped + parsed.issues.length,
    issues: [...issues, ...result.issues],
  };
  issuesByScope.set(scopeFor(userId), combined.issues);
  if (result.imported || audio.length)
    window.dispatchEvent(
      new CustomEvent("band-local-bank-changed", { detail: userId }),
    );
  return combined;
}
export async function importLocalBankFile(
  userId: string | null,
  file: File,
): Promise<BankImportResult> {
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (/\.zip$/i.test(file.name) || (header[0] === 0x50 && header[1] === 0x4b)) {
    const decoded = await decodeLocalBankArchive(file);
    const result = await saveBank(
      userId,
      decoded.materials,
      decoded.audio.map((item) => ({ ...item, scope: "" })),
    );
    const combined = {
      ...result,
      duplicate: result.duplicate + decoded.duplicate,
      skipped: result.skipped + decoded.issues.length,
      issues: [...decoded.issues, ...result.issues],
    };
    issuesByScope.set(scopeFor(userId), combined.issues);
    if (result.imported || decoded.audio.length)
      window.dispatchEvent(
        new CustomEvent("band-local-bank-changed", { detail: userId }),
      );
    return combined;
  }
  if (file.size > 64 * 1024 * 1024)
    throw new Error("题库JSON超过64 MB，请分批导入。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("题库文件不是有效的JSON，原有题库未修改。");
  }
  return importLocalBank(userId, parsed);
}
export async function builtinLocalBank(): Promise<LocalMaterial[]> {
  const result: LocalMaterial[] = [];
  for (const item of samples.materials) {
    if (item.skill !== "reading" && item.skill !== "listening") continue;
    const verified = String(item.source.reviewStatus) === "reviewed";
    const common = {
      id: item.id,
      version: item.version,
      title: `${item.title}（内置离线兜底）`,
      skill: item.skill,
      deliveryMode: "local-import",
      scope: "section",
      contentHash: "0".repeat(64),
      estimatedMinutes: item.estimatedMinutes,
      source: {
        materialSource: "unofficial",
        sourceRef: `builtin:${item.id}`,
        rights: "Project-authored offline fallback",
        answerVerified: verified,
      },
      instructions: item.instructions,
      questions: item.questions!.map((question) => ({
        ...question,
        answerVerified: verified,
      })),
    };
    const body =
      item.skill === "reading"
        ? {
            ...common,
            passage: item.passage,
            paragraphs: item.paragraphs,
            passageNumber: item.passageNumber,
          }
        : {
            ...common,
            transcript: item.transcript,
            section: item.section,
            audio: {
              path: `/curriculum365/v1/${item.audio!.path}`,
              durationSeconds: item.audio!.durationSeconds,
              ...(item.audio!.path.endsWith(audioProvenance.audioPath)
                ? { sha256: audioProvenance.sha256 }
                : {}),
            },
          };
    const material = LocalMaterialSchema.parse(body);
    material.contentHash = await hashLocalMaterial(material);
    result.push(material);
  }
  return result;
}
const pendingBankLoads = new Map<string, Promise<LocalMaterial[]>>();
export function loadLocalBank(userId: string | null): Promise<LocalMaterial[]> {
  const scope = scopeFor(userId),
    existing = pendingBankLoads.get(scope);
  if (existing) return existing;
  // StrictMode and simultaneous views must not race to import the same versions.
  const pending = loadLocalBankUnshared(userId).finally(() => {
    if (pendingBankLoads.get(scope) === pending) pendingBankLoads.delete(scope);
  });
  pendingBankLoads.set(scope, pending);
  return pending;
}
async function loadLocalBankUnshared(
  userId: string | null,
): Promise<LocalMaterial[]> {
  const scope = scopeFor(userId),
    issues: string[] = [];
  try {
    const stored = await readStored(userId);
    const materials: LocalMaterial[] = [];
    for (const item of stored.materials) {
      const parsed = LocalMaterialSchema.safeParse(item.material);
      if (
        parsed.success &&
        (await hashLocalMaterial(parsed.data)) === parsed.data.contentHash
      )
        materials.push(parsed.data);
      else issues.push(`${item.id}：本机材料校验失败，已跳过。`);
    }
    const importedMaterials = materials.filter(
      (material) => !material.source.sourceRef.startsWith("builtin:"),
    );
    if (
      importedMaterials.length &&
      (!navigator.onLine || stored.audio.some((item) => item.transport))
    ) {
      issuesByScope.set(scope, issues);
      return importedMaterials;
    }
    try {
      const response = await fetch("/local-bank/manifest.json", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const manifest: unknown = await response.json();
        if (
          !manifest ||
          typeof manifest !== "object" ||
          !Array.isArray((manifest as { materials?: unknown }).materials)
        )
          throw new Error("题库目录格式无效。");
        const raw: unknown[] = [];
        for (const entry of (
          manifest as { materials: unknown[] }
        ).materials.slice(0, 10000)) {
          try {
            if (
              !entry ||
              typeof entry !== "object" ||
              !("path" in entry) ||
              typeof entry.path !== "string" ||
              !/^\/local-bank\/(?:reading|listening)\/[a-zA-Z0-9_-]+\.json$/.test(
                entry.path,
              )
            )
              throw new Error("材料路径无效。");
            const descriptor = entry as Record<string, unknown>;
            const known = materials.find(
              (material) =>
                material.id === descriptor.id &&
                material.version === descriptor.version &&
                material.contentHash === descriptor.contentHash,
            );
            if (known) {
              raw.push(known);
              continue;
            }
            const file = await fetch(entry.path, {
              cache: "no-store",
              signal: AbortSignal.timeout(10000),
            });
            if (!file.ok) throw new Error("文件未找到。");
            raw.push(await file.json());
          } catch (error) {
            issues.push(
              error instanceof Error
                ? error.message
                : "一份材料未能读取，其他材料继续。",
            );
          }
        }
        const result = await importLocalBank(userId, {
          importVersion: 1,
          materials: raw,
        });
        issues.push(...result.issues);
        const imported = await readStored(userId);
        if (imported.materials.length) {
          issuesByScope.set(scope, issues);
          return imported.materials.map((item) => item.material);
        }
      }
    } catch (error) {
      issues.push(
        error instanceof Error ? error.message : "本机题库目录不可用。",
      );
    }
    if (importedMaterials.length) {
      issuesByScope.set(scope, issues);
      return importedMaterials;
    }
    const fallback = await builtinLocalBank();
    issuesByScope.set(scope, issues);
    return fallback;
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "本机题库暂不可用。");
    issuesByScope.set(scope, issues);
    return builtinLocalBank();
  }
}
const pendingAudioLoads = new Map<string, Promise<Blob>>();
export async function resolveLocalAudio(
  userId: string | null,
  material: LocalMaterial,
): Promise<{ url: string; release: () => void }> {
  if (material.skill !== "listening" || !material.audio)
    throw new Error("这份材料没有可用的本机音频。");
  const source = { ...material, audio: { ...material.audio } },
    key = JSON.stringify([
      scopeFor(userId),
      source.audio.path,
      source.audio.sha256 ?? null,
    ]);
  let pending = pendingAudioLoads.get(key);
  if (!pending) {
    const load = loadLocalAudioBlob(userId, source).finally(() => {
      if (pendingAudioLoads.get(key) === load) pendingAudioLoads.delete(key);
    });
    pendingAudioLoads.set(key, load);
    pending = load;
  }
  // Each caller owns its URL so a stale effect cannot revoke another caller's audio.
  const url = URL.createObjectURL(await pending);
  return { url, release: () => URL.revokeObjectURL(url) };
}
async function loadLocalAudioBlob(
  userId: string | null,
  material: LocalMaterial,
): Promise<Blob> {
  const stored = await readStored(userId);
  let item = matchingAudio(material, stored.audio);
  if (!item?.blob && navigator.onLine) {
    const downloaded = await fetchAudio(material, stored.audio);
    if (downloaded) {
      await saveBank(userId, [], [downloaded]);
      item = downloaded;
    }
  }
  if (!item?.blob)
    throw new Error(
      "这台设备没有匹配的音频，请联网准备这一份音频，或导入包含音频的小题库包。",
    );
  return item.blob;
}

const MAX_PRIVATE_MANIFEST_BYTES = 64 * 1024 * 1024;
async function privateJSON(
  url: "/private/manifest.json" | "/private/prompts.json",
  maximum: number,
): Promise<unknown> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error("登录已过期，请重新登录；本机题库与待同步作答保留。");
  if (!response.ok)
    throw new Error("服务器私有题库尚未就绪，请稍后重试或导入本机题库包。");
  if (Number(response.headers.get("Content-Length") ?? 0) > maximum)
    throw new Error("私有题库目录超过大小限制。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("私有题库目录为空。");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error("私有题库目录超过大小限制。");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("私有题库目录不是有效JSON。");
  }
}
/** Explicit authenticated preparation only; no audio is downloaded until a listening part is selected. */
export async function importPrivateBankManifest(
  userId: string | null,
): Promise<BankImportResult> {
  if (!userId) throw new Error("请先登录，再准备服务器私有题库。");
  const { getLearningState } = await import("./repository");
  if (getLearningState().userId !== userId)
    throw new Error("账号已切换，请重新打开题库。");
  const manifest = await parsePrivateBankManifest(
    await privateJSON("/private/manifest.json", MAX_PRIVATE_MANIFEST_BYTES),
  );
  if (getLearningState().userId !== userId)
    throw new Error("账号已切换，题库未导入。");
  const result = await saveBank(
    userId,
    manifest.materials,
    manifest.audioTransports.map((transport) => ({
      scope: "",
      path: `private-meta:${transport.originalPath}@${transport.sourceSha256}`,
      sha256: transport.sha256,
      transport,
    })),
  );
  issuesByScope.set(scopeFor(userId), result.issues);
  if (result.imported || manifest.audioTransports.length)
    window.dispatchEvent(
      new CustomEvent("band-local-bank-changed", { detail: userId }),
    );
  return result;
}
export async function importPrivatePromptManifest(userId: string | null) {
  if (!userId) throw new Error("请先登录，再准备服务器写说题库。");
  const { getLearningState } = await import("./repository");
  const { importPromptBank } = await import("./promptBank");
  const { MAX_PROMPT_BANK_BYTES } = await import("./promptBankSchema");
  const input = await privateJSON(
    "/private/prompts.json",
    MAX_PROMPT_BANK_BYTES,
  );
  if (getLearningState().userId !== userId)
    throw new Error("账号已切换，写说题库未导入。");
  return importPromptBank(userId, input);
}
