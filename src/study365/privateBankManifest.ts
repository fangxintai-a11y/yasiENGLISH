import { z } from "zod";
import {
  hashLocalMaterial,
  isLocalAudioPath,
  parseLocalBank,
  type LocalMaterial,
} from "./localBankSchema";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const PrivateAudioTransportSchema = z
  .strictObject({
    originalPath: z.string().refine(isLocalAudioPath),
    path: z.string().regex(/^\/private\/audio\/[a-f0-9]{64}\.m4a$/),
    sha256: sha,
    sourceSha256: sha,
    durationSeconds: z.number().finite().positive().max(7200),
    sourceDurationSeconds: z.number().finite().positive().max(7200),
    /** Decoded sample length of the original; container metadata can be a bitrate estimate. */
    sourceDecodedSeconds: z.number().finite().positive().max(7200).optional(),
    bitRate: z.number().int().positive(),
    targetBitRate: z.literal(48000),
    codec: z.literal("aac"),
    profile: z.literal("LC"),
    channels: z.literal(1),
    bytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    sourceBytes: z.number().int().positive(),
  })
  .superRefine((item, ctx) => {
    if (item.path !== `/private/audio/${item.sha256}.m4a`)
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "私有音频路径与压缩SHA不一致。",
      });
    if (
      Math.abs(
        item.durationSeconds -
          (item.sourceDecodedSeconds ?? item.sourceDurationSeconds),
      ) > 0.100001
    )
      ctx.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: "转码前后时长误差超过0.1秒。",
      });
  });
export type PrivateAudioTransport = z.infer<typeof PrivateAudioTransportSchema>;
export interface PrivateBankManifest {
  privateBankVersion: 1;
  contentHash: string;
  materials: LocalMaterial[];
  audioTransports: PrivateAudioTransport[];
}
export async function parsePrivateBankManifest(
  input: unknown,
): Promise<PrivateBankManifest> {
  const value = z
    .strictObject({
      privateBankVersion: z.literal(1),
      contentHash: sha,
      materials: z.array(z.unknown()).max(10000),
      audioTransports: z.array(PrivateAudioTransportSchema).max(10000),
    })
    .parse(input);
  if ((await hashLocalMaterial(value)) !== value.contentHash)
    throw new Error("私有题库目录校验失败，原有本机题库保留。");
  const parsed = await parseLocalBank({
    importVersion: 1,
    materials: value.materials,
  });
  if (parsed.issues.length || parsed.duplicate)
    throw new Error(`私有题库包含无效或重复原件：${parsed.issues.join("；")}`);
  const keys = new Set<string>();
  for (const transport of value.audioTransports) {
    const key = JSON.stringify([
      transport.originalPath,
      transport.sourceSha256,
    ]);
    if (keys.has(key)) throw new Error("私有题库音频传输描述重复。");
    keys.add(key);
    if (
      !parsed.materials.some(
        (material) =>
          material.skill === "listening" &&
          material.audio?.path === transport.originalPath &&
          material.audio.sha256 === transport.sourceSha256,
      )
    )
      throw new Error("私有音频没有匹配的原始材料SHA。");
  }
  for (const transport of value.audioTransports) {
    const related = parsed.materials.filter(
      (material) =>
        material.skill === "listening" &&
        material.audio?.path === transport.originalPath &&
        material.audio.sha256 === transport.sourceSha256,
    );
    if (
      related.some(
        (material) =>
          material.skill === "listening" &&
          Math.abs(
            material.audio!.durationSeconds - transport.sourceDurationSeconds,
          ) > 0.100001,
      )
    )
      throw new Error("私有音频原始时长与对应材料不一致。");
  }
  for (const material of parsed.materials)
    if (
      material.skill === "listening" &&
      material.audio &&
      !keys.has(JSON.stringify([material.audio.path, material.audio.sha256]))
    )
      throw new Error(`${material.title}缺少压缩音频传输描述。`);
  return { ...value, materials: parsed.materials };
}
/** A transport is not a new question version: original exact-work and review tuples stay immutable. */
export function privateTransportFor(
  material: LocalMaterial,
  transports: readonly PrivateAudioTransport[],
) {
  return material.skill === "listening" && material.audio
    ? (transports.find(
        (item) =>
          item.originalPath === material.audio!.path &&
          item.sourceSha256 === material.audio!.sha256,
      ) ?? null)
    : null;
}
