import { AsyncUnzipInflate, Unzip, Zip, ZipPassThrough, type UnzipFile } from "fflate";
import { z } from "zod";
import { isIdentifier } from "./protocol";
import type { RecordingMetadata, StoredRecording } from "./db";

export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 1001, MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const audioPath = /^audio\/[a-f0-9]{64}\.(?:webm|wav|mp3|ogg|mp4|bin)$/;
const manifestSchema = z.strictObject({
  format: z.literal("band-galaxy-recordings"), version: z.literal(1), createdAt: z.iso.datetime(),
  recordings: z.array(z.strictObject({
    recordingId: z.string().refine(isIdentifier), date: z.iso.date().nullable(), prompt: z.string().max(8000),
    transcript: z.string().max(20000), durationSeconds: z.number().nonnegative().max(86400).nullable(),
    file: z.string().regex(audioPath), bytes: z.number().int().positive().max(MAX_RECORDING_BYTES),
    mimeType: z.string().max(100).regex(/^(?:audio\/[a-z0-9.+-]+|application\/octet-stream)$/i),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(MAX_FILES - 1),
});

export interface ArchiveRecording { blob: Blob; metadata: RecordingMetadata }
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))].map((n) => n.toString(16).padStart(2, "0")).join("");
const extension = (type: string) => ({ "audio/webm": "webm", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "mp4" })[type] ?? "bin";

/** Audio is already compressed. Store it unchanged and stream one recording at
 * a time instead of retaining a second full map of all decoded input files. */
export async function encodeRecordingArchive(records: ArchiveRecording[]): Promise<Blob> {
  if (!records.length) throw new Error("这台设备暂无可导出的学习录音。");
  if (records.length >= MAX_FILES) throw new Error("录音过多，请分批选择后导出。");
  if (new Set(records.map((item) => item.metadata.recordingId)).size !== records.length) throw new Error("待导出录音ID重复。");
  const total = records.reduce((sum, item) => sum + item.blob.size, 0);
  if (total > MAX_ARCHIVE_BYTES - MAX_MANIFEST_BYTES) throw new Error("录音超过单个备份256 MB上限，请减少选择并分批导出。");
  const chunks: ArrayBuffer[] = [], entries: z.infer<typeof manifestSchema>["recordings"] = [];
  let failure: unknown, complete = false, bytesWritten = 0;
  const archive = new Zip((error, data, final) => {
    if (error) failure = error;
    if (failure) return;
    bytesWritten += data.byteLength;
    if (bytesWritten > MAX_ARCHIVE_BYTES) { failure = new Error("备份超过256 MB，请分批导出。"); return; }
    chunks.push(new Uint8Array(data).buffer);
    complete ||= final;
  });
  const addedFiles = new Set<string>();
  for (const item of records) {
    if (item.blob.size <= 0 || item.blob.size > MAX_RECORDING_BYTES) throw new Error("单段录音必须大于0且不超过50 MB。");
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    const digest = await hash(bytes), mimeType = item.blob.type || "application/octet-stream";
    const file = `audio/${digest}.${extension(mimeType)}`;
    entries.push({ ...item.metadata, file, bytes: bytes.length, mimeType, sha256: digest });
    if (!addedFiles.has(file)) {
      const stream = new ZipPassThrough(file); archive.add(stream); stream.push(bytes, true); addedFiles.add(file);
    }
    if (failure) throw failure;
  }
  const manifest = manifestSchema.parse({ format: "band-galaxy-recordings", version: 1, createdAt: new Date().toISOString(), recordings: entries });
  const data = new TextEncoder().encode(JSON.stringify(manifest));
  if (data.length > MAX_MANIFEST_BYTES) throw new Error("录音清单过大，请分批导出。");
  const stream = new ZipPassThrough("manifest.json"); archive.add(stream); stream.push(data, true); archive.end();
  if (failure) throw failure;
  if (!complete) throw new Error("录音备份未完整生成，请重试。");
  return new Blob(chunks, { type: "application/zip" });
}

interface DirectoryEntry { bytes: number; crc: number }
function directory(data: Uint8Array): Map<string, DirectoryEntry> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === data.length) { end = i; break; }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("备份ZIP不完整或不是单卷ZIP。");
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (!count || count > MAX_FILES || view.getUint16(end + 8, true) !== count || start + size !== end) throw new Error("备份ZIP目录或文件数量无效。");
  const entries = new Map<string, DirectoryEntry>();
  let offset = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("备份ZIP目录损坏。");
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), bytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || compressed > MAX_ARCHIVE_BYTES) throw new Error("备份ZIP包含不支持或无效的文件。");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset + 46, offset + 46 + nameLength));
    if ((name !== "manifest.json" && !audioPath.test(name)) || entries.has(name)) throw new Error("备份ZIP含重复文件或不安全路径。");
    if (bytes <= 0 || bytes > (name === "manifest.json" ? MAX_MANIFEST_BYTES : MAX_RECORDING_BYTES)) throw new Error("备份中单个文件过大或为空。");
    total += bytes;
    if (total > MAX_ARCHIVE_BYTES) throw new Error("备份解压总量超过256 MB。");
    entries.set(name, { bytes, crc: view.getUint32(offset + 16, true) });
    offset = next;
  }
  if (offset !== end || !entries.has("manifest.json")) throw new Error("备份ZIP缺少录音清单。");
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
};

async function unzipBounded(data: Uint8Array, expected: Map<string, DirectoryEntry>): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, Uint8Array>(), seen = new Set<string>(), active: UnzipFile[] = [];
    let pending = 0, total = 0, inputDone = false, failed = false;
    let inflating = 0;
    const waiting: UnzipFile[] = [];
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true; active.forEach((file) => file.terminate()); reject(error);
    };
    const finish = () => {
      if (!failed && inputDone && pending === 0) {
        if (result.size !== expected.size) fail(new Error("ZIP文件清单不一致。"));
        else resolve(result);
      }
    };
    const pump = () => {
      while (!failed && inflating < 2 && waiting.length) {
        const file = waiting.shift()!;
        inflating++;
        try { file.start(); } catch (error) { fail(error); }
      }
    };
    const unzip = new Unzip((file) => {
      if (failed) { file.terminate(); return; }
      const description = expected.get(file.name);
      if (!description || seen.has(file.name) || file.originalSize !== undefined && file.originalSize !== description.bytes) {
        file.terminate(); fail(new Error("ZIP包含重复、未声明或大小不符的文件。")); return;
      }
      seen.add(file.name); active.push(file); pending++;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      file.ondata = (error, chunk, final) => {
        if (failed) return;
        if (error) { fail(error); return; }
        bytes += chunk.length; total += chunk.length;
        if (bytes > description.bytes || total > MAX_ARCHIVE_BYTES) { fail(new Error("ZIP解压量超出上限。")); return; }
        chunks.push(chunk);
        if (final) {
          if (bytes !== description.bytes) { fail(new Error("ZIP解压长度不一致。")); return; }
          const joined = new Uint8Array(bytes); let position = 0;
          for (const item of chunks) { joined.set(item, position); position += item.length; }
          if (crc32(joined) !== description.crc) { fail(new Error("ZIP文件校验失败，原数据未修改。")); return; }
          result.set(file.name, joined); pending--; inflating--; pump(); finish();
        }
      };
      waiting.push(file); pump();
    });
    unzip.register(AsyncUnzipInflate);
    try {
      for (let offset = 0; offset < data.length && !failed; offset += 65536)
        unzip.push(data.subarray(offset, Math.min(data.length, offset + 65536)), offset + 65536 >= data.length);
      inputDone = true; finish();
    } catch (error) { fail(error); }
  });
}

/** Parse and validate the entire archive before an IndexedDB transaction writes
 * anything. Declared sizes are checked again against actual streamed output. */
export async function decodeRecordingArchive(file: Blob): Promise<StoredRecording[]> {
  if (!file.size || file.size > MAX_ARCHIVE_BYTES) throw new Error("请选择不超过256 MB的录音ZIP备份。");
  const bytes = new Uint8Array(await file.arrayBuffer()), expected = directory(bytes);
  const entries = await unzipBounded(bytes, expected);
  let manifest: z.infer<typeof manifestSchema>;
  try { manifest = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries.get("manifest.json")))); }
  catch { throw new Error("录音备份清单格式不正确，原数据未修改。"); }
  if (new Set(manifest.recordings.map((item) => item.recordingId)).size !== manifest.recordings.length) throw new Error("录音清单中的ID重复。");
  const referenced = new Set(["manifest.json", ...manifest.recordings.map((item) => item.file)]);
  if (referenced.size !== entries.size || [...entries.keys()].some((name) => !referenced.has(name))) throw new Error("ZIP存在未被清单引用的文件。");
  const records: StoredRecording[] = [];
  for (const item of manifest.recordings) {
    const data = entries.get(item.file);
    if (!data || data.length !== item.bytes || await hash(data) !== item.sha256) throw new Error(`录音 ${item.recordingId} 内容校验失败，原数据未修改。`);
    records.push({ id: item.recordingId, blob: new Blob([new Uint8Array(data).buffer], { type: item.mimeType }),
      metadata: { recordingId: item.recordingId, date: item.date, prompt: item.prompt, transcript: item.transcript, durationSeconds: item.durationSeconds } });
  }
  return records;
}
