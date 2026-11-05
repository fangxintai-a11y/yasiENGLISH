#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
const { parseLocalBank, hashLocalMaterial } = await tsImport(
  "../src/study365/localBankSchema.ts",
  import.meta.url,
);
const { checkLocalAnswers } = await tsImport(
  "../src/study365/localBankImport.ts",
  import.meta.url,
);
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || !process.argv[i + 1])
    throw new Error("请按--from/--out/--checked指定路径。");
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
try {
  const from = path.resolve(options.from ?? "local-content/bank.json"),
    out = path.resolve(options.out ?? "local-content/answer-check-report.json"),
    checked = path.resolve(
      options.checked ?? "local-content/bank.checked.json",
    );
  const parsed = await parseLocalBank(
      JSON.parse(await fs.readFile(from, "utf8")),
    ),
    materials = [],
    report = [];
  for (const original of parsed.materials) {
    const results = checkLocalAnswers(original),
      byId = new Map(results.map((item) => [item.questionId, item])),
      material = structuredClone(original);
    material.questions.forEach((question) => {
      if (!byId.get(question.id).located) question.answerVerified = false;
    });
    if (material.questions.some((question) => !question.answerVerified))
      material.source.answerVerified = false;
    material.contentHash = await hashLocalMaterial(material);
    materials.push(material);
    report.push({
      materialId: material.id,
      version: material.version,
      checks: results,
    });
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(path.dirname(checked), { recursive: true });
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        warning: "仅机械定位检查，不代替答案语义审校；原始答案未改写。",
        issues: parsed.issues,
        materials: report,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    checked,
    JSON.stringify({ importVersion: 1, materials }, null, 2),
  );
  console.log(
    JSON.stringify({
      materials: materials.length,
      questions: report.reduce((sum, item) => sum + item.checks.length, 0),
      pendingLocation: report.reduce(
        (sum, item) =>
          sum + item.checks.filter((check) => !check.located).length,
        0,
      ),
      report: out,
      checked,
    }),
  );
} catch (error) {
  console.error(
    `答案检查未完成：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
