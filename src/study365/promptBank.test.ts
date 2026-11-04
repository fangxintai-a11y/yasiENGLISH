import test from "node:test";
import assert from "node:assert/strict";
import {
  hashLocalPrompt,
  parsePromptBank,
  promptStimulusUrl,
  type LocalPrompt,
} from "./promptBankSchema";
import { mergePromptBank } from "./promptBank";
import type { RetestPrompt } from "./retestSelection";
const seed = (patch: Record<string, unknown> = {}) => ({
  id: "self-authored-opinion",
  version: "1",
  skill: "writing",
  taskType: "task2",
  questionType: "opinion",
  prompt: "Should a fictional town build a second park? Give your own opinion.",
  sourceRef: "synthetic:opinion",
  materialSource: "unofficial",
  rights: "Self-authored test fixture",
  ...patch,
});
async function prompt(
  patch: Record<string, unknown> = {},
): Promise<LocalPrompt> {
  const input = seed(patch);
  return { ...input, contentHash: await hashLocalPrompt(input) } as LocalPrompt;
}
test("T3: strict local prompt banks accept explicit writing classification and speaking Part", async () => {
  const writing = await prompt(),
    speaking = await prompt({
      id: "self-authored-speaking",
      skill: "speaking",
      part: 2,
      taskType: undefined,
      questionType: undefined,
    });
  const parsed = await parsePromptBank({
    importVersion: 1,
    prompts: [writing, JSON.parse(JSON.stringify(speaking))],
  });
  assert.equal(parsed.prompts.length, 2);
  const compatible: RetestPrompt[] = parsed.prompts;
  assert.equal(compatible.length, 2);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.prompts[0].prompt, writing.prompt);
});
test("T3: changed content/hash, unsupported fields and wrong scope are skipped without losing valid prompts", async () => {
  const valid = await prompt(),
    tampered = { ...valid, prompt: "A different question." },
    unknown = await prompt({
      id: "unsupported",
      generatedAnswer: "An answer must not become a new question.",
    });
  const parsed = await parsePromptBank({
    importVersion: 1,
    prompts: [valid, tampered, unknown],
  });
  assert.equal(parsed.prompts.length, 1);
  assert.equal(parsed.issues.length, 2);
  await assert.rejects(parsePromptBank({ importVersion: 1, materials: [] }));
});
test("T3: same ID/version duplicates do not grow the bank and conflicting originals stay intact", async () => {
  const valid = await prompt(),
    changed = await prompt({ prompt: "A changed synthetic opinion question." });
  const parsed = await parsePromptBank({
    importVersion: 1,
    prompts: [valid, valid, changed],
  });
  assert.equal(parsed.prompts.length, 1);
  assert.equal(parsed.duplicate, 1);
  assert.equal(parsed.issues.length, 1);
  const merged = mergePromptBank([valid], [valid, changed]);
  assert.equal(merged.prompts[0], valid);
  assert.equal(merged.duplicate, 1);
  assert.equal(merged.issues.length, 1);
});
test("T3: Task1 without original stimulus stays unready and cannot claim usable material", async () => {
  const missing = await prompt({
    id: "missing-chart",
    taskType: "task1",
    questionType: "bar-chart",
    ready: false,
  });
  const falseReady = await prompt({
    id: "false-ready",
    taskType: "task1",
    questionType: "bar-chart",
    ready: true,
  });
  const parsed = await parsePromptBank({
    importVersion: 1,
    prompts: [missing, falseReady],
  });
  assert.equal(parsed.prompts.length, 1);
  assert.equal(parsed.prompts[0].ready, false);
  assert.equal(parsed.issues.length, 1);
  assert.equal(promptStimulusUrl(missing), null);
});
test("T3: local original raster bytes are SHA checked and remain outside work payloads", async () => {
  // Minimal self-authored PNG byte fixture; no real exam image is committed.
  const raw = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const data = Buffer.from(raw).toString("base64");
  const chart = await prompt({
    id: "synthetic-chart",
    taskType: "task1",
    questionType: "bar-chart",
    stimulusHash: sha256,
    stimulusImage: { mimeType: "image/png", sha256, data },
  });
  const bad = await prompt({
    id: "corrupt-chart",
    taskType: "task1",
    questionType: "bar-chart",
    stimulusHash: "f".repeat(64),
    stimulusImage: { mimeType: "image/png", sha256: "f".repeat(64), data },
  });
  const parsed = await parsePromptBank({
    importVersion: 1,
    prompts: [chart, bad],
  });
  assert.equal(parsed.prompts.length, 1);
  assert.equal(parsed.issues.length, 1);
  assert.equal(promptStimulusUrl(chart), `data:image/png;base64,${data}`);
});
test("T3: latest source versions can coexist without overwriting a historical prompt", async () => {
  const first = await prompt(),
    second = await prompt({ version: "2", prompt: "A new source version." });
  const result = mergePromptBank([first], [second]);
  assert.equal(result.prompts.length, 2);
  assert.equal(result.prompts[0], first);
  assert.equal(result.prompts[1], second);
});
