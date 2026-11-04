#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tsImport } from "tsx/esm/api";
const schema = await tsImport(
  "../src/study365/localBankSchema.ts",
  import.meta.url,
);
const mapper = await tsImport(
  "../src/study365/localBankImport.ts",
  import.meta.url,
);
const archive = await tsImport(
  "../src/study365/localBankArchive.ts",
  import.meta.url,
);
export const BANK_MAPPER_VERSION = "bank-r4-v1";
export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const READING_MAPPER_VERSION = "native-reader-v2";
export const titleKey = (title) =>
  String(title)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
export function argumentsOf(argv) {
  const options = { mode: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith("--") || !argv[i + 1])
      throw new Error(`参数无效：${argv[i]}`);
    options[argv[i].slice(2)] = argv[++i];
  }
  return options;
}
export function issueText(error) {
  return Array.isArray(error?.issues)
    ? error.issues
        .map((item) => `${item.path.join(".")} ${item.message}`)
        .join("；")
    : error instanceof Error
      ? error.message
      : String(error);
}
async function existingBank(bankPath) {
  try {
    return await schema.parseLocalBank(
      JSON.parse(await fs.readFile(bankPath, "utf8")),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return { materials: [], issues: [], duplicate: 0 };
    throw new Error(`已有题库无法读取，未覆盖：${issueText(error)}`);
  }
}
export async function writeBankOutputs({
  materials,
  issues = [],
  options,
  stats = {},
}) {
  const out = path.resolve(
      options.out ?? path.join(projectRoot, "public/local-bank"),
    ),
    bankPath = path.resolve(
      options.bank ?? path.join(projectRoot, "local-content/bank.json"),
    );
  const logPath = path.resolve(
    options.log ?? path.join(projectRoot, "local-content/import-log.json"),
  );
  const previous = await existingBank(bankPath),
    merged = new Map(
      previous.materials.map((material) => [
        `${material.id}@${material.version}`,
        material,
      ]),
    );
  let duplicateVersions = 0;
  for (const material of materials) {
    const key = `${material.id}@${material.version}`,
      saved = merged.get(key);
    if (saved) {
      if (saved.contentHash === material.contentHash) duplicateVersions++;
      else
        issues.push({
          sourceRef: key,
          reason: "已有同版本内容不同，原件保留。",
        });
      continue;
    }
    merged.set(key, material);
  }
  const output = [...merged.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version),
  );
  const entries = [];
  for (const material of output) {
    const filename = `${material.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${material.contentHash.slice(0, 12)}.json`;
    const directory = path.join(out, material.skill);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, filename),
      JSON.stringify(material, null, 2),
    );
    entries.push({
      id: material.id,
      version: material.version,
      skill: material.skill,
      path: `/local-bank/${material.skill}/${filename}`,
      contentHash: material.contentHash,
      sourceRef: material.source.sourceRef,
    });
  }
  await fs.mkdir(out, { recursive: true });
  await fs.mkdir(path.dirname(bankPath), { recursive: true });
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(
      {
        importVersion: 1,
        generatedAt: new Date().toISOString(),
        materials: entries,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    bankPath,
    JSON.stringify({ importVersion: 1, materials: output }, null, 2),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    stats: {
      ...stats,
      bankMaterials: output.length,
      duplicateVersions,
      answersPending: output.reduce(
        (sum, material) =>
          sum +
          material.questions.filter((question) => !question.answerVerified)
            .length,
        0,
      ),
    },
    issues: [
      ...previous.issues.map((reason) => ({ sourceRef: bankPath, reason })),
      ...issues,
    ],
  };
  await fs.writeFile(logPath, JSON.stringify(report, null, 2));
  return report;
}
export async function importReading(options) {
  if (!options.from) throw new Error("请指定 --from 本机阅读源路径。");
  const from = path.resolve(options.from),
    nested = path.join(from, "src/generated/reading-native/exams");
  const directory = await fs
    .stat(nested)
    .then((stat) => (stat.isDirectory() ? nested : from))
    .catch(() => from);
  let revision = options.version;
  if (!revision)
    try {
      revision = execFileSync("git", ["-C", from, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      /* Standalone JSON versions use source bytes below. */
    }
  const files = (await fs.readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort(),
    materials = [],
    issues = [],
    titles = new Map();
  let duplicateTitles = 0;
  for (const filename of files) {
    try {
      const bytes = await fs.readFile(path.join(directory, filename)),
        version =
          revision ??
          createHash("sha256").update(bytes).digest("hex").slice(0, 24);
      const material = await mapper.mapNativeReading(
          JSON.parse(bytes.toString("utf8")),
          `${version}-${READING_MAPPER_VERSION}`,
        ),
        title = titleKey(material.title);
      if (titles.has(title) && titles.get(title) !== material.id) {
        duplicateTitles++;
        issues.push({
          sourceRef: filename,
          reason: `与${titles.get(title)}标题归一后相同，作为同篇别名跳过，不增加独立篇数。`,
        });
        continue;
      }
      titles.set(title, material.id);
      materials.push(material);
    } catch (error) {
      issues.push({ sourceRef: filename, reason: issueText(error) });
    }
  }
  return writeBankOutputs({
    materials,
    issues,
    options,
    stats: {
      sourceFiles: files.length,
      imported: materials.length,
      skipped: files.length - materials.length,
      duplicateTitles,
    },
  });
}
async function fileHash(filename) {
  const stat = await fs.stat(filename);
  if (stat.size > 50 * 1024 * 1024)
    throw new Error("单份音频超过50MB，请分节处理。");
  return createHash("sha256")
    .update(await fs.readFile(filename))
    .digest("hex");
}
async function copyAudio(plans, materials, options, issues) {
  const needed = new Set(
    materials.flatMap((m) =>
      m.skill === "listening" && m.audio ? [m.audio.path] : [],
    ),
  );
  const available = new Set();
  let copied = 0;
  const root = await fs.realpath(path.resolve(options.from));
  const destination = path.resolve(
    options.out ?? path.join(projectRoot, "public/local-bank"),
  );
  for (const item of plans) {
    if (!needed.has(item.path) || available.has(item.path)) continue;
    try {
      if (
        !/^audio\/[a-zA-Z0-9/_-]+\.(mp3|m4a|ogg|wav|webm)$/.test(item.path) ||
        item.path.split("/").includes("..")
      )
        throw new Error("音频输出路径不安全。");
      const output = path.join(destination, item.path);
      try {
        if ((await fileHash(output)) === item.sha256) {
          available.add(item.path);
          continue;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const original = await fs.realpath(item.from),
        relative = path.relative(root, original);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("音频原件不在指定源目录内。");
      if ((await fileHash(original)) !== item.sha256)
        throw new Error("音频原件SHA256不符。");
      await fs.mkdir(path.dirname(output), { recursive: true });
      try {
        await fs.link(original, output);
      } catch (error) {
        if (error.code === "EXDEV") await fs.copyFile(original, output, 1);
        else if (error.code !== "EEXIST") throw error;
      }
      if ((await fileHash(output)) !== item.sha256)
        throw new Error("已有音频同路径内容不同，未覆盖。");
      available.add(item.path);
      copied++;
    } catch (error) {
      issues.push({ sourceRef: item.path, reason: issueText(error) });
    }
  }
  return { available, copied };
}
function completeCatalog(materials) {
  const catalog = new Map();
  for (const m of materials) {
    if (!m.examId) continue;
    const key = `${m.skill}:${m.examId}`,
      row = catalog.get(key) ?? {
        skill: m.skill,
        examId: m.examId,
        sections: new Set(),
        questions: new Set(),
        fullPlayable: false,
      };
    if (m.scope === "full" && m.questions.length === 40) {
      row.fullPlayable = m.skill === "reading" || !!m.audio;
      for (let n = 1; n <= 40; n++) row.questions.add(n);
    }
    if (m.scope === "section" || m.scope === "passage") {
      row.sections.add(m.skill === "reading" ? m.passageNumber : m.section);
      for (const q of m.questions) if (q.number) row.questions.add(q.number);
    }
    catalog.set(key, row);
  }
  return [...catalog.values()].map((row) => ({
    skill: row.skill,
    examId: row.examId,
    sections: [...row.sections].sort(),
    questions: row.questions.size,
    complete:
      row.questions.size === 40 &&
      (row.fullPlayable ||
        row.sections.size === (row.skill === "reading" ? 3 : 4)),
    fullPlayable: row.fullPlayable,
  }));
}
export async function importSource(options) {
  if (!options.from) throw new Error("请指定 --from 本机源目录。");
  const cambridge = await import("./local-bank/cambridge.mjs");
  const prior = await existingBank(
    path.resolve(
      options.bank ?? path.join(projectRoot, "local-content/bank.json"),
    ),
  );
  let mapped;
  if (options.mode === "official")
    mapped = await (
      await import("./local-bank/official.mjs")
    ).importOfficial({ from: path.resolve(options.from) });
  else if (options.mode === "xiahua")
    mapped = await cambridge.importXiaHua({
      from: path.resolve(options.from),
      cambridgeMaterials: prior.materials,
    });
  else
    mapped = await cambridge.importCambridge({
      from: path.resolve(options.from),
      seed: options.seed ?? "band-r4-v1",
    });
  const issues = [...mapped.issues],
    valid = [];
  for (const raw of mapped.materials) {
    try {
      const m = schema.LocalMaterialSchema.parse({
        ...raw,
        version: `${raw.version}-${BANK_MAPPER_VERSION}`,
      });
      m.contentHash = await schema.hashLocalMaterial(m);
      valid.push(m);
    } catch (error) {
      issues.push({ sourceRef: raw.id ?? raw.title, reason: issueText(error) });
    }
  }
  const audio = await copyAudio(
    mapped.audioCopies ?? [],
    valid,
    options,
    issues,
  );
  let ready = valid.filter(
    (m) =>
      m.skill !== "listening" || !m.audio || audio.available.has(m.audio.path),
  );
  for (const m of valid)
    if (!ready.includes(m))
      issues.push({
        sourceRef: m.id,
        reason: "音频未安全复制/验证，本次不加入可作答库。",
      });
  let holdoutManifest;
  const assignmentPath = path.resolve(
    options.assignment ??
      path.join(
        path.dirname(
          options.bank ?? path.join(projectRoot, "local-content/bank.json"),
        ),
        "holdout-assignments.json",
      ),
  );
  if (options.mode === "cambridge" || options.mode === "listening") {
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(assignmentPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const selected = cambridge.assignHoldout(ready, {
      seed: options.seed ?? "band-r4-v1",
      existing,
    });
    ready = selected.materials;
    holdoutManifest = selected.holdoutManifest;
    issues.push(...selected.issues);
    for (const m of ready) m.contentHash = await schema.hashLocalMaterial(m);
  }
  const report = await writeBankOutputs({
    materials: ready,
    issues,
    options,
    stats: {
      mapped: mapped.materials.length,
      imported: ready.length,
      copiedAudio: audio.copied,
      duplicates: mapped.duplicates ?? 0,
      examCatalog: completeCatalog(ready),
      holdoutManifest,
    },
  });
  if (holdoutManifest) {
    await fs.mkdir(path.dirname(assignmentPath), { recursive: true });
    await fs.writeFile(
      `${assignmentPath}.tmp`,
      JSON.stringify(holdoutManifest, null, 2),
    );
    await fs.rename(`${assignmentPath}.tmp`, assignmentPath);
  }
  if (mapped.review)
    await fs.writeFile(
      path.join(path.resolve(options.from), "review.md"),
      mapped.review,
    );
  return report;
}
export async function packLocalBank(options) {
  if (!options.from) throw new Error("请指定 --from 题库JSON。");
  if (!options.ids && !options.book && !options.limit)
    throw new Error("请选择 --ids、--book 或 --limit；不会默认打包整库。");
  const bank = await existingBank(path.resolve(options.from));
  let materials = bank.materials;
  if (options.ids) {
    const ids = new Set(
      options.ids.split(",").map((s) => s.trim().toLowerCase()),
    );
    materials = materials.filter(
      (m) =>
        ids.has(m.id.toLowerCase()) ||
        ids.has(m.source.sourceRef.toLowerCase()),
    );
  }
  if (options.book) {
    const book = String(options.book).toUpperCase().replace(/^C/, "");
    materials = materials.filter((m) =>
      m.examId?.toUpperCase().startsWith(`C${book}T`),
    );
  }
  if (options.limit) {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("--limit 必须为1到1000。");
    materials = materials.slice(0, limit);
  }
  if (!materials.length) throw new Error("没有符合选择的材料。");
  const audioRoot = path.resolve(
      options["audio-root"] ?? path.join(projectRoot, "public/local-bank"),
    ),
    audio = new Map();
  let bytes = Buffer.byteLength(
    JSON.stringify({ importVersion: 1, materials }),
  );
  const files = new Map();
  for (const m of materials)
    if (m.skill === "listening" && m.audio) {
      if (
        !/^audio\/[a-zA-Z0-9/_-]+\.(mp3|m4a|ogg|wav|webm)$/.test(
          m.audio.path,
        ) ||
        m.audio.path.includes("..")
      )
        throw new Error("音频路径无效。");
      files.set(m.audio.path, path.join(audioRoot, m.audio.path));
    }
  for (const file of files.values()) {
    const stat = await fs.stat(file);
    if (stat.size > 50 * 1024 * 1024) throw new Error("单份音频超过50MB。");
    bytes += stat.size;
  }
  if (bytes > archive.MAX_BANK_ZIP_BYTES - 2 * 1024 * 1024)
    throw new Error("小包超过256MB，请减少 --ids/--limit。");
  for (const [relative, file] of files)
    audio.set(relative, new Blob([await fs.readFile(file)]));
  const blob = await archive.encodeLocalBankArchive(materials, audio),
    output = path.resolve(
      options.out ??
        path.join(projectRoot, "local-content/packs/selected-bank.zip"),
    );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, new Uint8Array(await blob.arrayBuffer()));
  return {
    materials: materials.length,
    audio: audio.size,
    bytes: blob.size,
    output,
  };
}
export async function main(argv = process.argv.slice(2)) {
  const options = argumentsOf(argv);
  const result =
    options.mode === "reading"
      ? await importReading(options)
      : options.mode === "pack"
        ? await packLocalBank(options)
        : ["official", "cambridge", "listening", "xiahua"].includes(
              options.mode,
            )
          ? await importSource(options)
          : null;
  if (!result)
    throw new Error(
      "用法：node scripts/import-local-bank.mjs reading|official|cambridge|listening|xiahua|pack --from <本机路径>",
    );
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`题库未导入：${issueText(error)}`);
    process.exitCode = 1;
  });
}
