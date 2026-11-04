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
export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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
          version,
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
export async function main(argv = process.argv.slice(2)) {
  const options = argumentsOf(argv);
  if (options.mode !== "reading")
    throw new Error(
      "用法：node scripts/import-local-bank.mjs reading --from <阅读仓库路径>",
    );
  console.log(JSON.stringify(await importReading(options), null, 2));
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
