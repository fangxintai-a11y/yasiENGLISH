import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importOfficial, parseOfficialAnswerKey, parseOfficialText, transcriptOnlyMaterial } from "./official.mjs";
import { LocalMaterialSchema } from "../../src/study365/localBankSchema.ts";

// Original pdftotext-layout fixtures: these are not actual official questions.
const reading = `Academic Reading sample task – Identifying writer's views

The fictional club opened a small garden. Its report describes the blue signs used there.

Questions 4 – 5
Do the following statements agree with the writer's views?
Write YES, NO or NOT GIVEN.
4      The writer supports opening a garden.
5      The writer expects a second garden next year.

Answers:
4      YES
5      NOT GIVEN
`;
const listening = `Listening sample task – Multiple choice (to be used with IELTS Listening Recording 2)
SECTION 1
Questions 9 and 10
Choose the correct letter A, B or C.
9       Which fictional colour is chosen?
        A       red
        B       green
        C       blue
10      Which fictional shape is chosen?
        A       round
        B       square
        C       oval
Tapescript for IELTS Listening Recording 2
Speaker: We will use blue signs and a round symbol.
Answers:
9       C
10      A
`;
const metadata = { from: "/tmp/synthetic-official-audio.mp3", path: "audio/synthetic-official-recording2.mp3", durationSeconds: 60, sha256: "a".repeat(64), bytes: 100 };
const heading = `Academic Reading sample task – Matching headings
Questions 1 – 2
Choose the correct heading for Sections A and B.
List of Headings
i       A fictional garden
ii      A fictional kitchen
iii     A fictional road
1       Section A
2       Section B
Section A
The fictional garden has blue signs and a round gate.
Section B
The fictional kitchen uses a large table for preparing meals.
Answers:
1       i
2       ii
`;
const opts = (skill, sourceRef = `cambridge-sample:${skill}:synthetic-fixture`) => ({ skill, sourceRef, sourceFile: "self-authored-layout-fixture.pdf" });

test("the reading layout preserves original question numbers, answers and official type-drill source", () => {
  const mapped = parseOfficialText(reading, opts("reading"));
  assert.equal(mapped.materials.length, 1);
  assert.equal(mapped.materials[0].scope, "type-drill");
  assert.equal(mapped.materials[0].source.materialSource, "official");
  assert.deepEqual(mapped.materials[0].questions.map(q => q.number), [4, 5]);
  assert.deepEqual(mapped.materials[0].questions.map(q => q.answer.accepted), [["YES"], ["NOT GIVEN"]]);
  assert.equal(LocalMaterialSchema.safeParse(mapped.materials[0]).success, true);
});
test("listening binds the declared recording and retains full source options", () => {
  const mapped = parseOfficialText(listening, { ...opts("listening"), audio: metadata });
  assert.equal(mapped.materials[0].audio.path, metadata.path);
  assert.equal(mapped.materials[0].questions[0].options[2].text, "blue");
  assert.deepEqual(mapped.materials[0].questions.map(q => q.answer.accepted), [["C"], ["A"]]);
  assert.equal(LocalMaterialSchema.safeParse(mapped.materials[0]).success, true);
});
test("a listening paper without its explicitly associated audio is skipped", () => {
  const mapped = parseOfficialText(listening, opts("listening"));
  assert.equal(mapped.materials.length, 0); assert.match(mapped.issues[0].reason, /音频/);
});
test("a missing numbered key is not replaced by a guessed answer", () => {
  const mapped = parseOfficialText(reading.replace("5      NOT GIVEN", ""), opts("reading"));
  assert.equal(mapped.materials.length, 0); assert.ok(mapped.issues.some(x => /答案/.test(x.reason)));
});
test("a diagram-dependent task is skipped rather than losing its required figure", () => {
  const mapped = parseOfficialText(reading.replace("Identifying writer's views", "Diagram label completion"), opts("reading"));
  assert.equal(mapped.materials.length, 0); assert.ok(mapped.issues.some(x => /图/.test(x.reason)));
});
test("heading questions before the passage still bind actual Sections A and B", () => {
  const mapped = parseOfficialText(heading, opts("reading"));
  assert.equal(mapped.materials.length, 1);
  const material = mapped.materials[0];
  assert.deepEqual(material.questions.map(q => q.type), ["matching-headings", "matching-headings"]);
  assert.ok(material.questions.every(q => material.paragraphs.some(p => p.id === q.paragraphId)));
  assert.equal(LocalMaterialSchema.safeParse(material).success, true);
});
test("word-level spelling alternatives preserve their shared prefix", () => {
  assert.deepEqual(parseOfficialAnswerKey("3 South Island tunneling/tunnelling").answers[3], ["South Island tunneling", "South Island tunnelling"]);
});
test("printed optional prefixes expand only the source's stated variants", () => {
  assert.deepEqual(parseOfficialAnswerKey("3 (the) garden").answers[3], ["garden", "the garden"]);
});
test("unsupported free-answer either-order pairs are identified without false independent marks", () => {
  assert.equal(parseOfficialAnswerKey("6 & 7 in either order\n books\n toys").unsupportedPairs, true);
});
test("transcript and key without a question body remain an unscored short reference", () => {
  const material = transcriptOnlyMaterial("An original fictional transcript.", { sourceRef: "ielts.org:listening:synthetic-fixture", sourceFile: "self-authored-transcript-fixture.pdf" });
  assert.equal(material.scope, "short"); assert.deepEqual(material.questions, []);
  assert.match(material.notes.join(" "), /缺少题目/);
  assert.equal(LocalMaterialSchema.safeParse(material).success, true);
});
test("one failed local PDF conversion is logged while another layout still imports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-official-fixture-"));
  try {
    const folder = path.join(root, "cambridge-sample/ielts-sample-papers/Academic Reading"); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "good.pdf"), "synthetic test input"); await fs.writeFile(path.join(folder, "bad.pdf"), "synthetic test input");
    const mapped = await importOfficial({ from: root, extractPdf: async file => { if (path.basename(file) === "bad.pdf") throw new Error("synthetic conversion failure"); return reading; } });
    assert.equal(mapped.materials.length, 1); assert.ok(mapped.issues.some(x => /conversion failure/.test(x.reason)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("the audio probe object shape binds an existing local recording", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-official-audio-fixture-"));
  try {
    const base = path.join(root, "cambridge-sample/ielts-sample-papers");
    await fs.mkdir(path.join(base, "Listening"), { recursive: true });
    await fs.mkdir(path.join(base, "Tasks Auido"), { recursive: true });
    await fs.writeFile(path.join(base, "Listening/sample.pdf"), "synthetic test input");
    await fs.writeFile(path.join(base, "Tasks Auido/113203_Sample_Task_Type_2_Recording.mp3"), "synthetic audio bytes");
    const output = await importOfficial({ from: root, extractPdf: async () => listening, probeAudio: async () => ({ durationSeconds: 60 }) });
    assert.equal(output.materials.length, 1);
    assert.equal(output.audioCopies.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("appropriate-letter wording retains separate complete options for each question", () => {
  const text = listening.replace("Choose the correct letter A, B or C.", "Choose the appropriate letters A, B or C.");
  const output = parseOfficialText(text, { ...opts("listening"), audio: metadata });
  assert.equal(output.materials.length, 1);
  assert.deepEqual(output.materials[0].questions.map(q => q.options.map(o => o.id)), [["A", "B", "C"], ["A", "B", "C"]]);
});
test("a repeated question-range reference in instructions does not split the original group", () => {
  const text = heading.replace("Choose the correct heading for Sections A and B.", "Choose the correct heading for Sections A and B (Questions 1-2).");
  const output = parseOfficialText(text, opts("reading"));
  assert.equal(output.materials.length, 1);
  assert.equal(output.materials[0].questions.length, 2);
});
test("a heading example is retained in the rubric without being appended to the last option", () => {
  const text = heading.replace("2       Section B", "Example Section C iii\n2       Section B");
  const output = parseOfficialText(text, opts("reading"));
  assert.equal(output.materials.length, 1);
  assert.equal(output.materials[0].questions[0].options[2].text, "A fictional road");
  assert.match(output.materials[0].questions[0].prompt, /Example Section C iii/);
});
