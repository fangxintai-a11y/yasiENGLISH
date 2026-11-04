import {
  AsyncUnzipInflate,
  Unzip,
  Zip,
  ZipPassThrough,
  type UnzipFile,
} from "fflate";
import { z } from "zod";
import { parseLocalBank, type LocalMaterial } from "./localBankSchema";

export const MAX_BANK_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_AUDIO = 50 * 1024 * 1024,
  MAX_JSON = 64 * 1024 * 1024,
  MAX_MANIFEST = 2 * 1024 * 1024,
  MAX_FILES = 1002;
const audioPath = /^audio\/[a-zA-Z0-9/_-]+\.(?:mp3|m4a|wav|ogg|webm)$/;
const safePath = (path: string) =>
  path === "bank.json" ||
  (audioPath.test(path) &&
    !path.split("/").some((part) => part === "." || part === ".."));
const manifestSchema = z.strictObject({
  format: z.literal("band-galaxy-local-bank"),
  version: z.literal(1),
  files: z
    .array(
      z.strictObject({
        path: z.string().max(500).refine(safePath),
        bytes: z.number().int().positive().max(MAX_JSON),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mimeType: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(MAX_FILES - 1),
});
const hash = async (bytes: Uint8Array) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
const mimeFor = (path: string) =>
  path.endsWith(".wav")
    ? "audio/wav"
    : path.endsWith(".mp3")
      ? "audio/mpeg"
      : path.endsWith(".ogg")
        ? "audio/ogg"
        : path.endsWith(".webm")
          ? "audio/webm"
          : "audio/mp4";
export async function encodeLocalBankArchive(
  materials: readonly LocalMaterial[],
  audio: ReadonlyMap<string, Blob>,
): Promise<Blob> {
  const parsed = await parseLocalBank({ importVersion: 1, materials });
  if (parsed.issues.length || parsed.duplicate || !parsed.materials.length)
    throw new Error("题库材料未通过校验，不能导出。");
  const required = new Map(
    parsed.materials.flatMap((material) =>
      material.skill === "listening" && material.audio
        ? [[material.audio.path, material.audio.sha256] as const]
        : [],
    ),
  );
  if (
    required.size !== audio.size ||
    [...required.keys()].some(
      (path) => !audio.has(path) || !audioPath.test(path),
    )
  )
    throw new Error(
      "小题库包缺少音频，或含未引用/非相对路径的音频。请按选择的材料分包。",
    );
  const bank = new TextEncoder().encode(
    JSON.stringify({ importVersion: 1, materials: parsed.materials }),
  );
  if (bank.length > MAX_JSON)
    throw new Error("题库正文超过64 MB，请分批导出。");
  const total = [...audio.values()].reduce(
    (sum, blob) => sum + blob.size,
    bank.length,
  );
  if (total > MAX_BANK_ZIP_BYTES - MAX_MANIFEST || audio.size + 2 > MAX_FILES)
    throw new Error("题库超过单包256 MB上限，请按书号或材料ID分包。");
  const entries: z.infer<typeof manifestSchema>["files"] = [],
    chunks: ArrayBuffer[] = [];
  let failure: unknown,
    finished = false,
    written = 0;
  const archive = new Zip((error, bytes, final) => {
    if (error) failure = error;
    written += bytes.length;
    if (written > MAX_BANK_ZIP_BYTES)
      failure = new Error("题库ZIP超过256 MB，请减少选择。");
    if (!failure) chunks.push(new Uint8Array(bytes).buffer);
    finished ||= final;
  });
  const add = async (path: string, bytes: Uint8Array, mimeType: string) => {
    entries.push({
      path,
      bytes: bytes.length,
      sha256: await hash(bytes),
      mimeType,
    });
    const file = new ZipPassThrough(path);
    archive.add(file);
    file.push(bytes, true);
    if (failure) throw failure;
  };
  await add("bank.json", bank, "application/json");
  for (const [path, blob] of audio) {
    if (!blob.size || blob.size > MAX_AUDIO)
      throw new Error("单个音频必须大于0且不超过50 MB。");
    const bytes = new Uint8Array(await blob.arrayBuffer()),
      expected = required.get(path);
    if (expected && (await hash(bytes)) !== expected)
      throw new Error(`${path}音频校验失败。`);
    await add(path, bytes, mimeFor(path));
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify(
      manifestSchema.parse({
        format: "band-galaxy-local-bank",
        version: 1,
        files: entries,
      }),
    ),
  );
  if (manifest.length > MAX_MANIFEST) throw new Error("题库清单过大，请分包。");
  const file = new ZipPassThrough("manifest.json");
  archive.add(file);
  file.push(manifest, true);
  archive.end();
  if (failure) throw failure;
  if (!finished) throw new Error("题库ZIP未完整生成。");
  return new Blob(chunks, { type: "application/zip" });
}

interface DirectoryEntry {
  bytes: number;
  crc: number;
}
function directory(data: Uint8Array): Map<string, DirectoryEntry> {
  if (data.length < 22) throw new Error("题库ZIP不完整。");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--)
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === data.length
    ) {
      end = at;
      break;
    }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error("题库ZIP不完整或不是单卷ZIP。");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (
    !count ||
    count > MAX_FILES ||
    view.getUint16(end + 8, true) !== count ||
    start + size !== end
  )
    throw new Error("题库ZIP目录无效。");
  const entries = new Map<string, DirectoryEntry>();
  let offset = start,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("题库ZIP目录损坏。");
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true),
      bytes = view.getUint32(offset + 24, true);
    const length = view.getUint16(offset + 28, true),
      next =
        offset +
        46 +
        length +
        view.getUint16(offset + 30, true) +
        view.getUint16(offset + 32, true);
    if (next > end || flags & 1 || ![0, 8].includes(method))
      throw new Error("题库ZIP包含不支持的文件。");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      data.subarray(offset + 46, offset + 46 + length),
    );
    if (name !== "manifest.json" && !safePath(name))
      throw new Error("题库ZIP含不安全路径。");
    if (entries.has(name)) throw new Error("题库ZIP含重复文件。");
    const limit =
      name === "manifest.json"
        ? MAX_MANIFEST
        : name === "bank.json"
          ? MAX_JSON
          : MAX_AUDIO;
    total += bytes;
    if (!bytes || bytes > limit || total > MAX_BANK_ZIP_BYTES)
      throw new Error("题库ZIP声明的解压体积超过上限。");
    entries.set(name, { bytes, crc: view.getUint32(offset + 16, true) });
    offset = next;
  }
  if (
    offset !== end ||
    !entries.has("manifest.json") ||
    !entries.has("bank.json")
  )
    throw new Error("题库ZIP缺少正文或清单。");
  return entries;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let n = 0; n < 8; n++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
function unpack(
  data: Uint8Array,
  expected: Map<string, DirectoryEntry>,
): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, Uint8Array>(),
      seen = new Set<string>(),
      active: UnzipFile[] = [],
      waiting: UnzipFile[] = [];
    let pending = 0,
      inflating = 0,
      total = 0,
      inputDone = false,
      failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      active.forEach((file) => file.terminate());
      reject(error);
    };
    const finish = () => {
      if (!failed && inputDone && !pending)
        result.size === expected.size
          ? resolve(result)
          : fail(new Error("题库ZIP文件数与清单不一致。"));
    };
    const pump = () => {
      while (!failed && inflating < 2 && waiting.length) {
        const file = waiting.shift()!;
        inflating++;
        try {
          file.start();
        } catch (error) {
          fail(error);
        }
      }
    };
    const unzip = new Unzip((file) => {
      const description = expected.get(file.name);
      if (
        failed ||
        !description ||
        seen.has(file.name) ||
        (file.originalSize !== undefined &&
          file.originalSize !== description.bytes)
      ) {
        file.terminate();
        fail(new Error("题库ZIP包含重复或未声明文件。"));
        return;
      }
      seen.add(file.name);
      active.push(file);
      pending++;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      file.ondata = (error, chunk, final) => {
        if (failed) return;
        if (error) {
          fail(error);
          return;
        }
        bytes += chunk.length;
        total += chunk.length;
        if (bytes > description.bytes || total > MAX_BANK_ZIP_BYTES) {
          fail(new Error("题库ZIP实际解压体积超过上限。"));
          return;
        }
        chunks.push(chunk);
        if (final) {
          if (bytes !== description.bytes) {
            fail(new Error("题库ZIP长度校验失败。"));
            return;
          }
          const joined = new Uint8Array(bytes);
          let position = 0;
          for (const chunk of chunks) {
            joined.set(chunk, position);
            position += chunk.length;
          }
          if (crc32(joined) !== description.crc) {
            fail(new Error("题库ZIP文件校验失败。"));
            return;
          }
          result.set(file.name, joined);
          pending--;
          inflating--;
          pump();
          finish();
        }
      };
      waiting.push(file);
      pump();
    });
    unzip.register(AsyncUnzipInflate);
    try {
      for (let at = 0; at < data.length && !failed; at += 65536)
        unzip.push(
          data.subarray(at, Math.min(data.length, at + 65536)),
          at + 65536 >= data.length,
        );
      inputDone = true;
      finish();
    } catch (error) {
      fail(error);
    }
  });
}
export async function decodeLocalBankArchive(
  file: Blob,
): Promise<{
  materials: LocalMaterial[];
  audio: { path: string; blob: Blob; sha256: string }[];
  issues: string[];
  duplicate: number;
}> {
  if (!file.size || file.size > MAX_BANK_ZIP_BYTES)
    throw new Error("请选择不超过256 MB的小题库ZIP。");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    entries = await unpack(bytes, directory(bytes));
  const manifest = manifestSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        entries.get("manifest.json"),
      ),
    ),
  );
  if (
    new Set(manifest.files.map((entry) => entry.path)).size !==
    manifest.files.length
  )
    throw new Error("题库清单含重复文件。");
  if (
    manifest.files.length + 1 !== entries.size ||
    !manifest.files.some((entry) => entry.path === "bank.json")
  )
    throw new Error("题库ZIP存在未列入清单的文件。");
  for (const entry of manifest.files) {
    const data = entries.get(entry.path);
    if (
      !data ||
      data.length !== entry.bytes ||
      (await hash(data)) !== entry.sha256
    )
      throw new Error(`${entry.path}校验失败，原题库未修改。`);
  }
  const parsed = await parseLocalBank(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        entries.get("bank.json"),
      ),
    ),
  );
  const audio: { path: string; blob: Blob; sha256: string }[] = [];
  const required = new Map(
    parsed.materials.flatMap((material) =>
      material.skill === "listening" && material.audio
        ? [[material.audio.path, material.audio.sha256] as const]
        : [],
    ),
  );
  for (const [path, sha256] of required) {
    const entry = manifest.files.find((entry) => entry.path === path),
      data = entries.get(path);
    if (
      !entry ||
      !data ||
      !audioPath.test(path) ||
      (sha256 && sha256 !== entry.sha256)
    )
      throw new Error("题库音频与材料引用不一致，原数据未修改。");
    audio.push({
      path,
      blob: new Blob([new Uint8Array(data).buffer], { type: mimeFor(path) }),
      sha256: entry.sha256,
    });
  }
  return { ...parsed, audio };
}
