import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  importPromptSources,
  staticSpeakingJson,
  practiceWritingSections,
  writingSubtype,
} from "./import-prompt-bank.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const script = fileURLToPath(
  new URL("./import-prompt-bank.mjs", import.meta.url),
);
async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "band-r5-prompt-import-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const from = path.join(directory, "raw");
  await fs.mkdir(from);
  return { directory, from };
}
async function put(root, name, value) {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return target;
}
test("T3: parser only accepts JSON in known source wrappers and never executes source JavaScript", () => {
  assert.deepEqual(
    staticSpeakingJson(
      '/* original source header */\nwindow.SEED_SETS = [{"part":1,"questions":[{"q":"A self-authored question?"}]}];',
      "wendy",
    )[0].part,
    1,
  );
  assert.equal(
    staticSpeakingJson(
      'window.IELTSQuestionMaterialChunks=window.IELTSQuestionMaterialChunks||[];window.IELTSQuestionMaterialChunks.push([{"part":"p3","question":"A self-authored follow-up?"}]);',
      "murph",
    )[0].part,
    "p3",
  );
  assert.throws(() =>
    staticSpeakingJson(
      "window.SEED_SETS = (()=>{globalThis.unexpectedPromptExecution=true;return []})()",
      "wendy",
    ),
  );
  assert.equal(globalThis.unexpectedPromptExecution, undefined);
});
test("T3: Task boundaries preserve original prompt and ignore scripts; source does not imply an essay subtype", () => {
  const html =
    '<div class="entry-content"><p><strong>Task 1:</strong>The bar chart below shows a fictional park.</p><p><img data-src="/images/chart.png" /></p><p>Task 2: A fictional town needs a park. Give your opinion.</p><script>doNotExecute()</script><div class="addtoany">Share</div>';
  const [one, two] = practiceWritingSections(html);
  assert.equal(one.taskType, "task1");
  assert.equal(one.questionType, "bar-chart");
  assert.equal(one.imageRef, "/images/chart.png");
  assert.equal(two.questionType, "unknown");
  assert.match(two.prompt, /fictional town/);
  assert.doesNotMatch(two.prompt, /doNotExecute|Share/);
  assert.throws(() =>
    practiceWritingSections("<p>Task 2: Missing original page boundary.</p>"),
  );
  assert.equal(
    writingSubtype("To what extent do you agree or disagree?"),
    "opinion",
  );
  assert.equal(writingSubtype("None"), "unknown");
});
test("T3: explicit source instructions classify and duplicates collapse; vague or mixed directives stay unknown", async (t) => {
  const { from } = await fixture(t);
  const html =
    '<div class="entry-content"><p>Task 1: The bar chart below shows a fictional park.</p><p>Task 2: Some people support the park. To what extent do you agree or disagree?</p></article>';
  await put(from, "writing/practicepte/w1.html", html);
  await put(from, "writing/practicepte/w2.html", html);
  const result = await importPromptSources(from);
  assert.equal(result.prompts.length, 2);
  assert.equal(result.stats.duplicateQuestions, 2);
  assert.equal(
    result.prompts.find((prompt) => prompt.taskType === "task2").questionType,
    "opinion",
  );
  assert.equal(
    writingSubtype("Discuss both views and give your own opinion."),
    "discussion",
  );
  assert.equal(
    writingSubtype(
      "What are the advantages and disadvantages of this proposal?",
    ),
    "advantages-disadvantages",
  );
  assert.equal(
    writingSubtype("What problems arise? What solutions can you suggest?"),
    "problem-solution",
  );
  assert.equal(writingSubtype("Give your opinion."), "unknown");
  assert.equal(
    writingSubtype("Discuss both views. Do you agree or disagree?"),
    "unknown",
  );
});
test("T3: explicit P1/P2/P3 fields import actual question text only; unlabeled follow-ups are not guessed", async (t) => {
  const { from } = await fixture(t);
  await put(
    from,
    "speaking/SEU-Prime_ielts-speaking/data.json",
    JSON.stringify([
      { id: "p1", part: 1, questions: ["A synthetic warm-up?"] },
      {
        id: "p2",
        part: 2,
        prompt: "Describe a synthetic park.",
        cues: ["Where is it?"],
        questions: ["Do not guess this as Part 3."],
      },
    ]),
  );
  await put(
    from,
    "speaking/WendyCoding31_ielts-speaking-studio/data.js",
    'window.SEED_SETS = [{"id":"w","part":2,"cue":"Describe a synthetic library.","bullets":["Where is it?"],"modelAnswer":"PRIVATE ANSWER","part3":[{"q":"A synthetic social follow-up?","a":"PRIVATE ANSWER"}]}];',
  );
  await put(
    from,
    "speaking/murph232439_ielts-speaking-practice/question-materials-1.js",
    'window.IELTSQuestionMaterialChunks=window.IELTSQuestionMaterialChunks||[];window.IELTSQuestionMaterialChunks.push([{"part":"p3","question":"Another synthetic follow-up?","idea":"PRIVATE ANSWER"}]);',
  );
  const result = await importPromptSources(from);
  assert.equal(result.prompts.length, 5);
  assert.equal(result.prompts.filter((prompt) => prompt.part === 3).length, 2);
  assert.doesNotMatch(
    JSON.stringify(result.prompts),
    /PRIVATE ANSWER|Do not guess/,
  );
});
test("T3: existing Task1 raster bytes survive conversion unchanged, absent images remain an explicit gap", async (t) => {
  const { from } = await fixture(t),
    raw = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const image = await put(from, "writing/practicepte/img/chart.png", raw);
  const html =
    '<div class="entry-content"><p>Task 1: The bar chart below shows a fictional value.</p><img src="/uploads/chart.png"><p>Task 2: A separate synthetic question.</p></article>';
  await put(from, "writing/practicepte/w1.html", html);
  await put(
    from,
    "writing/practicepte/w2.html",
    html
      .replace("chart.png", "missing.png")
      .replace("fictional value", "different fictional value"),
  );
  const result = await importPromptSources(from),
    charts = result.prompts.filter(
      (prompt) => prompt.skill === "writing" && prompt.taskType === "task1",
    );
  assert.equal(charts.length, 2);
  assert.equal(charts.filter((prompt) => prompt.ready).length, 1);
  const ready = charts.find((prompt) => prompt.ready);
  assert.equal(ready.stimulusHash, sha(raw));
  assert.equal(Buffer.from(ready.stimulusImage.data, "base64").compare(raw), 0);
  assert.equal(sha(await fs.readFile(image)), sha(raw));
  assert.ok(result.issues.some((issue) => /原图未就绪/.test(issue)));
});
test("T3: normal node CLI writes a new private bank and refuses to overwrite original raw files", async (t) => {
  const { from, directory } = await fixture(t);
  const raw = await put(
      from,
      "speaking/SEU-Prime_ielts-speaking/data.json",
      JSON.stringify([
        { id: "p1", part: 1, questions: ["A self-authored CLI question?"] },
      ]),
    ),
    before = sha(await fs.readFile(raw));
  const out = path.join(directory, "output/bank.json"),
    log = path.join(directory, "output/log.json");
  const response = JSON.parse(
    execFileSync(
      process.execPath,
      [script, "--from", from, "--out", out, "--log", log],
      { encoding: "utf8" },
    ),
  );
  assert.equal(response.success, true);
  assert.equal(response.stats.speaking, 1);
  assert.equal(JSON.parse(await fs.readFile(out, "utf8")).prompts.length, 1);
  assert.equal(sha(await fs.readFile(raw)), before);
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [script, "--from", from, "--out", raw, "--log", log],
      { stdio: "pipe" },
    ),
  );
  assert.equal(sha(await fs.readFile(raw)), before);
});
