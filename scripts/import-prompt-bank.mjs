#!/usr/bin/env node
/** Parse existing private sources only. Never fetch, execute source JS, or copy answers. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
const {
  hashLocalPrompt,
  parsePromptBank,
  MAX_PROMPT_BANK_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
} = await tsImport("../src/study365/promptBankSchema.ts", import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalized = (text) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const rights = "本机个人学习导入；来源许可未自动核验。";
export const PROMPT_MAPPER_VERSION = "r5-local-prompts-v1";
const {
  explicitWritingSubtype: writingSubtype,
  explicitTaskOneSubtype: taskOneSubtype,
} = await tsImport("../src/study365/promptClassification.ts", import.meta.url);
export { writingSubtype };
function entities(text) {
  const named = {
    amp: "&",
    quot: '"',
    apos: "'",
    nbsp: " ",
    lt: "<",
    gt: ">",
    ndash: "–",
    mdash: "—",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, value) => {
    if (value[0] !== "#") return named[value.toLowerCase()] ?? full;
    const code =
      value[1].toLowerCase() === "x"
        ? parseInt(value.slice(2), 16)
        : Number(value.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
  });
}
export function htmlQuestionText(html) {
  return entities(
    html
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
      .replace(/<(?:br|\/?p|\/?div|\/?h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
/** Only these exact wrappers are accepted; executable expressions fail JSON.parse. */
export function staticSpeakingJson(source, format) {
  const pattern =
    format === "wendy"
      ? /^\s*(?:\/\*[\s\S]*?\*\/\s*)?window\.SEED_SETS\s*=\s*([\s\S]+?)\s*;?\s*$/
      : /^\s*window\.IELTSQuestionMaterialChunks\s*=\s*window\.IELTSQuestionMaterialChunks\s*\|\|\s*\[\]\s*;\s*window\.IELTSQuestionMaterialChunks\.push\(([\s\S]+)\)\s*;?\s*$/;
  const match = source.match(pattern);
  if (!match) throw new Error("口语源JS包装不在允许格式内，未执行。");
  const data = JSON.parse(match[1]);
  if (!Array.isArray(data)) throw new Error("口语源不是题目数组。");
  return data;
}
export function practiceWritingSections(html) {
  const start = html.search(
    /<div\b[^>]*class=["'][^"']*\bentry-content\b[^"']*["'][^>]*>/i,
  );
  if (start < 0) throw new Error("写作源缺少entry-content，未猜正文。");
  const entry = html
    .slice(start)
    .split(/<div\b[^>]*class=["'][^"']*\baddtoany/i)[0]
    .split(/<\/article\s*>/i)[0];
  const markers = [...entry.matchAll(/Task\s*([12])\s*:/gi)];
  if (markers.length !== 2 || markers[0][1] !== "1" || markers[1][1] !== "2")
    throw new Error("未找到唯一Task1/2边界，整份跳过。");
  return markers.map((marker, index) => {
    const original = entry.slice(
      marker.index + marker[0].length,
      markers[index + 1]?.index ?? entry.length,
    );
    const prompt = htmlQuestionText(original),
      taskType = `task${marker[1]}`;
    const images = [...original.matchAll(/<img\b[^>]*>/gi)]
      .map((match) => {
        const attrs = match[0],
          lazy = attrs.match(/\bdata-src=["']([^"']+)["']/i),
          src = attrs.match(/\bsrc=["']([^"']+)["']/i);
        return entities(lazy?.[1] ?? src?.[1] ?? "");
      })
      .filter((src) => src && !src.startsWith("data:"));
    return {
      taskType,
      questionType:
        taskType === "task1" ? taskOneSubtype(prompt) : writingSubtype(prompt),
      prompt,
      imageRef: images[0],
    };
  });
}
export async function importPromptSources(from, options = {}) {
  const prompts = new Map(),
    issues = [];
  const stats = {
    sourceFiles: 0,
    sourceRows: 0,
    duplicateQuestions: 0,
    skippedRows: 0,
    imported: 0,
    writing: 0,
    speaking: 0,
    unready: 0,
    originalImages: 0,
    uniqueQuestions: 0,
    unselectedQuestions: 0,
  };
  const add = (input, reference) => {
    stats.sourceRows++;
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
      stats.skippedRows++;
      issues.push(`${reference}：缺少题目正文。`);
      return;
    }
    const identity = `${input.skill}:${input.taskType ?? input.part}:${normalized(input.prompt)}:${input.stimulusHash ?? ""}`;
    const id = `prompt-${input.skill}-${sha(identity).slice(0, 24)}`;
    const value = {
      id,
      version: PROMPT_MAPPER_VERSION,
      materialSource: "unofficial",
      rights,
      sourceRef: reference,
      pool: "practice",
      ...input,
    };
    if (value.skill === "writing")
      value.ready =
        value.questionType !== "unknown" &&
        (value.taskType !== "task1" ||
          !!value.stimulusImage ||
          !!value.stimulusText);
    if (prompts.has(identity)) {
      stats.duplicateQuestions++;
      return;
    }
    prompts.set(identity, value);
  };
  const files = async (directory) => {
    try {
      return (await fs.readdir(directory)).sort();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
  };
  const practice = path.join(from, "writing/practicepte");
  for (const name of (await files(practice)).filter((name) =>
    /^w\d+\.html$/.test(name),
  )) {
    stats.sourceFiles++;
    try {
      const html = await fs.readFile(path.join(practice, name), "utf8");
      for (const item of practiceWritingSections(html)) {
        const { imageRef, ...value } = item;
        if (item.taskType === "task1" && imageRef) {
          try {
            const file = path.join(
              practice,
              "img",
              path.basename(
                new URL(imageRef, "https://practicepteonline.com").pathname,
              ),
            );
            const stat = await fs.stat(file);
            if (stat.size > MAX_PROMPT_IMAGE_BYTES || stat.size < 1)
              throw new Error("原图为空或超过8 MB。");
            const raw = await fs.readFile(file),
              ext = path.extname(file).toLowerCase(),
              mimeType =
                ext === ".png"
                  ? "image/png"
                  : [".jpg", ".jpeg"].includes(ext)
                    ? "image/jpeg"
                    : ext === ".webp"
                      ? "image/webp"
                      : null;
            if (!mimeType) throw new Error("原图不是允许的raster格式。");
            value.stimulusHash = sha(raw);
            value.stimulusImage = {
              mimeType,
              sha256: value.stimulusHash,
              data: raw.toString("base64"),
            };
          } catch (error) {
            issues.push(`${name}:task1：原图未就绪：${error.message}`);
          }
        }
        add(
          { skill: "writing", ...value },
          `practicepte:${name}:${item.taskType}`,
        );
      }
    } catch (error) {
      stats.skippedRows++;
      issues.push(`${name}：${error.message}`);
    }
  }
  const plain = path.join(from, "speaking/SEU-Prime_ielts-speaking/data.json");
  try {
    const rows = JSON.parse(await fs.readFile(plain, "utf8"));
    stats.sourceFiles++;
    if (!Array.isArray(rows)) throw new Error("口语源不是数组。");
    for (const [index, row] of rows.entries()) {
      const ref = `SEU-Prime:${row.id ?? index}`;
      if (row.part === 1 && Array.isArray(row.questions))
        row.questions.forEach((question) =>
          add({ skill: "speaking", part: 1, prompt: question }, ref),
        );
      else if (
        row.part === 2 &&
        typeof row.prompt === "string" &&
        Array.isArray(row.cues)
      )
        add(
          {
            skill: "speaking",
            part: 2,
            prompt: [row.prompt, ...row.cues].join("\n"),
          },
          ref,
        );
      else {
        stats.skippedRows++;
        issues.push(`${ref}：Part或题目格式不明确，未猜测。`);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") issues.push(`SEU-Prime：${error.message}`);
  }
  const wendy = path.join(
    from,
    "speaking/WendyCoding31_ielts-speaking-studio/data.js",
  );
  try {
    const rows = staticSpeakingJson(await fs.readFile(wendy, "utf8"), "wendy");
    stats.sourceFiles++;
    for (const [index, row] of rows.entries()) {
      const ref = `WendyCoding31:${row.id ?? index}`;
      if (row.part === 1 && Array.isArray(row.questions))
        row.questions.forEach((question) =>
          add({ skill: "speaking", part: 1, prompt: question?.q }, ref),
        );
      else if (
        row.part === 2 &&
        typeof row.cue === "string" &&
        Array.isArray(row.bullets)
      ) {
        add(
          {
            skill: "speaking",
            part: 2,
            prompt: [row.cue, ...row.bullets].join("\n"),
          },
          ref,
        );
        if (Array.isArray(row.part3))
          row.part3.forEach((question) =>
            add(
              { skill: "speaking", part: 3, prompt: question?.q },
              `${ref}:part3`,
            ),
          );
      } else {
        stats.skippedRows++;
        issues.push(`${ref}：Part或题目格式不明确。`);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") issues.push(`WendyCoding31：${error.message}`);
  }
  const chunks = path.join(
    from,
    "speaking/murph232439_ielts-speaking-practice",
  );
  for (const name of (await files(chunks)).filter((name) =>
    /^question-materials-\d+\.js$/.test(name),
  )) {
    stats.sourceFiles++;
    try {
      for (const [index, row] of staticSpeakingJson(
        await fs.readFile(path.join(chunks, name), "utf8"),
        "murph",
      ).entries()) {
        const part = /^p[123]$/.test(row.part)
          ? Number(row.part.slice(1))
          : null;
        if (!part) {
          stats.skippedRows++;
          continue;
        }
        add(
          {
            skill: "speaking",
            part,
            prompt:
              part === 2 && Array.isArray(row.points)
                ? [row.question, ...row.points].join("\n")
                : row.question,
          },
          `murph232439:${name}:${index + 1}`,
        );
      }
    } catch (error) {
      issues.push(`${name}：${error.message}`);
    }
  }
  const eligible = [...prompts.values()].filter(
    (prompt) => !options.skill || prompt.skill === options.skill,
  );
  const values = eligible.slice(0, options.limit ?? Infinity);
  stats.uniqueQuestions = eligible.length;
  stats.unselectedQuestions = eligible.length - values.length;
  for (const value of values) value.contentHash = await hashLocalPrompt(value);
  const checked = await parsePromptBank({ importVersion: 1, prompts: values });
  issues.push(...checked.issues);
  stats.imported = checked.prompts.length;
  stats.writing = checked.prompts.filter(
    (prompt) => prompt.skill === "writing",
  ).length;
  stats.speaking = checked.prompts.filter(
    (prompt) => prompt.skill === "speaking",
  ).length;
  stats.unready = checked.prompts.filter(
    (prompt) => prompt.ready === false,
  ).length;
  stats.originalImages = checked.prompts.filter(
    (prompt) => prompt.skill === "writing" && prompt.stimulusImage,
  ).length;
  return { prompts: checked.prompts, stats, issues };
}
async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !/^--(?:from|out|log|skill|limit|manifest)$/.test(argv[i]) ||
      !argv[i + 1]
    )
      throw new Error(
        "参数仅支持--from/--out/--log/--skill/--limit/--manifest。",
      );
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (options.skill && !["writing", "speaking"].includes(options.skill))
    throw new Error("--skill只能是writing或speaking。");
  if (
    options.limit &&
    (!/^\d+$/.test(options.limit) ||
      Number(options.limit) < 1 ||
      Number(options.limit) > 20000)
  )
    throw new Error("--limit须为1至20000的整数。");
  const from = path.resolve(
      options.from ?? path.join(root, "local-content/ielts-data"),
    ),
    out = path.resolve(
      options.out ?? path.join(root, "local-content/r5-prompt-bank.json"),
    ),
    log = path.resolve(
      options.log ?? path.join(root, "local-content/r5-prompt-import-log.json"),
    );
  for (const target of [
    out,
    log,
    options.manifest ? path.resolve(options.manifest) : null,
  ].filter(Boolean))
    if (target === from || target.startsWith(`${from}${path.sep}`))
      throw new Error("输出不能写入只读原始资料目录。");
  const result = await importPromptSources(from, {
    skill: options.skill,
    ...(options.limit ? { limit: Number(options.limit) } : {}),
  });
  const text = JSON.stringify({ importVersion: 1, prompts: result.prompts });
  if (Buffer.byteLength(text) > MAX_PROMPT_BANK_BYTES)
    throw new Error(
      "题包超过20 MB，请用--skill或--limit分批导出。原文件未改。",
    );
  for (const target of [
    out,
    options.manifest ? path.resolve(options.manifest) : null,
  ].filter(Boolean)) {
    if (target === from || !target.endsWith(".json"))
      throw new Error("输出必须是新的JSON文件。");
    try {
      const previous = await fs.readFile(target, "utf8");
      if (previous !== text)
        throw new Error(`输出已存在且内容不同，未覆盖：${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, { flag: "wx" });
    }
  }
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(
    log,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mapperVersion: PROMPT_MAPPER_VERSION,
        stats: result.stats,
        issues: result.issues,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        success: true,
        out,
        stats: result.stats,
        issueCount: result.issues.length,
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
