import { z } from "zod";
import { canonical, isIdentifier, MATERIAL_SOURCES } from "./protocol";
export const MAX_PROMPT_BANK_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !!value.trim(), "文字不能为空。");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  id: text(160).refine(isIdentifier),
  version: text(120),
  contentHash: hash,
  prompt: text(8000),
  sourceRef: text(300),
  materialSource: z.enum(MATERIAL_SOURCES),
  rights: text(3000),
  pool: z.enum(["practice", "holdout"]).optional(),
  ready: z.boolean().optional(),
  estimatedMinutes: z.number().int().min(1).max(120).optional(),
};
const image = z.strictObject({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  sha256: hash,
});
export const LocalPromptSchema = z
  .discriminatedUnion("skill", [
    z.strictObject({
      ...common,
      skill: z.literal("writing"),
      taskType: z.enum(["task1", "task2"]),
      questionType: text(80),
      stimulusHash: hash.optional(),
      stimulusText: text(8000).optional(),
      stimulusImage: image.optional(),
    }),
    z.strictObject({
      ...common,
      skill: z.literal("speaking"),
      part: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    }),
  ])
  .superRefine((prompt, ctx) => {
    if (prompt.skill !== "writing") return;
    if (
      prompt.taskType === "task2" &&
      (prompt.stimulusHash || prompt.stimulusText || prompt.stimulusImage)
    )
      ctx.addIssue({
        code: "custom",
        path: ["stimulusHash"],
        message: "Task 2不应携带Task 1题图。",
      });
    if (
      prompt.taskType === "task1" &&
      prompt.ready !== false &&
      (!prompt.stimulusHash || (!prompt.stimulusText && !prompt.stimulusImage))
    )
      ctx.addIssue({
        code: "custom",
        path: ["stimulusHash"],
        message: "Task 1缺少原题图或真实数据，须标为未就绪。",
      });
    if (
      prompt.stimulusImage &&
      prompt.stimulusHash !== prompt.stimulusImage.sha256
    )
      ctx.addIssue({
        code: "custom",
        path: ["stimulusHash"],
        message: "题图SHA与刺激材料引用不一致。",
      });
  });
export type LocalPrompt = z.infer<typeof LocalPromptSchema>;
export async function hashLocalPrompt(
  value: Record<string, unknown>,
): Promise<string> {
  const { contentHash: _ignored, ...original } = value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(JSON.parse(JSON.stringify(original)))),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function promptStimulusUrl(prompt: LocalPrompt): string | null {
  return prompt.skill === "writing" && prompt.stimulusImage
    ? `data:${prompt.stimulusImage.mimeType};base64,${prompt.stimulusImage.data}`
    : null;
}
async function verifyPromptImage(prompt: LocalPrompt): Promise<void> {
  if (prompt.skill !== "writing" || !prompt.stimulusImage) return;
  const image = prompt.stimulusImage,
    raw = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
  if (!raw.byteLength || raw.byteLength > MAX_PROMPT_IMAGE_BYTES)
    throw new Error("原题图为空或超过8 MB。");
  const png = raw[0] === 137 && raw[1] === 80 && raw[2] === 78 && raw[3] === 71;
  const jpeg = raw[0] === 255 && raw[1] === 216 && raw[2] === 255;
  const webp =
    String.fromCharCode(...raw.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...raw.slice(8, 12)) === "WEBP";
  if (
    !(image.mimeType === "image/png"
      ? png
      : image.mimeType === "image/jpeg"
        ? jpeg
        : webp)
  )
    throw new Error("原题图类型与字节不一致。");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (sha !== image.sha256) throw new Error("原题图SHA校验失败。");
}
export async function parsePromptBank(
  input: unknown,
): Promise<{ prompts: LocalPrompt[]; issues: string[]; duplicate: number }> {
  const envelope = z
    .strictObject({
      importVersion: z.literal(1),
      prompts: z.array(z.unknown()).max(20000),
    })
    .parse(input);
  const prompts: LocalPrompt[] = [],
    issues: string[] = [],
    seen = new Map<string, string>();
  let duplicate = 0;
  for (const [index, value] of envelope.prompts.entries()) {
    try {
      const prompt = LocalPromptSchema.parse(value);
      if ((await hashLocalPrompt(prompt)) !== prompt.contentHash)
        throw new Error("题目内容hash不一致。");
      await verifyPromptImage(prompt);
      const key = `${prompt.id}@${prompt.version}`,
        previous = seen.get(key);
      if (previous === prompt.contentHash) {
        duplicate++;
        continue;
      }
      if (previous) throw new Error("同ID/版本有不同内容，保留先前题目。");
      seen.set(key, prompt.contentHash);
      prompts.push(prompt);
    } catch (error) {
      issues.push(
        `第${index + 1}份：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { prompts, issues, duplicate };
}
