import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assignHoldout, importCambridge, importXiaHua, mapYanboExam, parseStructuredQuestions, parseXiaHuaHtml, transcriptSimilarity } from "./cambridge.mjs";
import { LocalMaterialSchema } from "../../src/study365/localBankSchema.ts";

// These are original adapter fixtures, never real Cambridge or XiaHua papers.
const answers = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i + 1), { a: [`word${i + 1}`] }]));
const baseExam = () => ({ schema: "ielts-mock.exam/1", id: "C21-T1", source: { book: 21, test: 1 }, issues: ["Synthetic adapter fixture, not an actual exam."], reading: { answers: { 1: { a: ["TRUE"] }, 2: { a: ["NO"] }, 3: { a: ["i"] }, 4: { a: ["A"] }, 5: { a: ["blue"] }, 6: { a: ["B"] } }, passages: [{ passage: 1, title: "A fictional club", paragraphs: [{ label: "A", text: "The fictional club uses blue signs." }], groups: [
  { id: "g1", type: "tfng", range: [1, 1], questions: [{ n: 1, text: "The club uses blue signs." }] },
  { id: "g2", type: "ynng", range: [2, 2], questions: [{ n: 2, text: "The author recommends red signs." }] },
  { id: "g3", type: "matching", range: [3, 3], optionsTitle: "List of Headings", options: [{ key: "i", text: "Club signs" }, { key: "ii", text: "Club meals" }], questions: [{ n: 3, text: "Paragraph A" }] },
  { id: "g4", type: "matching", range: [4, 4], instructions: ["Which paragraph contains the following information?"], options: [{ key: "A", text: "" }, { key: "B", text: "" }], questions: [{ n: 4, text: "a reference to signs" }] },
  { id: "g5", type: "completion", range: [5, 5], instructions: ["Complete the summary. Write ONE WORD ONLY."], content: [{ t: "p", text: "The signs are {{5}}." }] },
  { id: "g6", type: "choice", range: [6, 6], questions: [{ n: 6, text: "Which colour is used?", options: [{ key: "A", text: "red" }, { key: "B", text: "blue" }] }] },
] }] } });
const audio = section => ({ from: `/tmp/synthetic-${section}.mp3`, path: `audio/synthetic-${section}.mp3`, durationSeconds: 120 });
const listeningExam = () => ({ schema: "ielts-mock.exam/1", id: "C21-T1", source: { book: 21, test: 1 }, listening: { answers, parts: Array.from({ length: 4 }, (_, i) => ({ part: i + 1, range: [i * 10 + 1, i * 10 + 10], transcript: Array.from({ length: 10 }, (_, q) => `The speaker says word${i * 10 + q + 1}.`).join(" "), groups: [{ id: `L${i + 1}-1`, type: "completion", range: [i * 10 + 1, i * 10 + 10], instructions: ["Complete the notes. ONE WORD ONLY."], content: Array.from({ length: 10 }, (_, q) => ({ t: "p", text: `Item {{${i * 10 + q + 1}}}` })) }] })) } });
const xiaData = () => ({ title: "Synthetic local listening fixture", questionIds: Array.from({ length: 10 }, (_, i) => String(i + 1)), audio: "audio.mp3", groups: [{ type: "fill", instruction: "Complete the notes. ONE WORD ONLY.", questions: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), text: `Fictional item ${i + 1}: _____` })) }], answerKey: { text: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`q${i + 1}`, `word${i + 1}`])) }, transcriptLines: Array.from({ length: 10 }, (_, i) => ({ time: `00:00:${String(i * 2).padStart(2, "0")},000 --> 00:00:${String(i * 2 + 1).padStart(2, "0")},000`, html: `The speaker says <mark>word${i + 1}</mark>.` })) });
const xiaHtml = data => `<script type="application/json" id="test-data">${JSON.stringify(data)}</script><script>throw new Error('must never execute');</script>`;

test("yanbo's six structured reading types preserve question numbers and accepted answers", () => {
  const result = mapYanboExam(baseExam());
  assert.deepEqual(result.materials[0].questions.map(q => q.type), ["true-false-not-given", "yes-no-not-given", "matching-headings", "matching-information", "summary-completion", "multiple-choice"]);
  assert.deepEqual(result.materials[0].questions.map(q => q.number), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.materials[0].questions[4].answer.accepted[0], "blue");
  assert.equal(LocalMaterialSchema.safeParse(result.materials[0]).success, true);
});
test("missing source answers are reported rather than invented", () => {
  const source = baseExam(); delete source.reading.answers[5];
  const result = mapYanboExam(source);
  assert.ok(result.issues.some(issue => /5/.test(issue.reason)));
  assert.equal(result.materials[0].questions.some(q => q.number === 5), false);
});
test("evidence in a later paragraph uses that paragraph's own offset", () => {
  const source = baseExam(); source.reading.passages[0].paragraphs.unshift({ label: "Z", text: "An unrelated original introduction." });
  assert.equal(LocalMaterialSchema.safeParse(mapYanboExam(source).materials[0]).success, true);
});
test("source judgement-label casing is canonicalized without changing the answer", () => {
  const source = baseExam(); source.reading.answers[1].a = ["True"];
  assert.deepEqual(mapYanboExam(source).materials[0].questions[0].answer.accepted, ["TRUE"]);
});
test("stray letter lists cannot turn a judgement question into an options question", () => {
  const source = baseExam(); source.reading.passages[0].groups[0].options = [{ key: "A", text: "a later list" }, { key: "B", text: "another later list" }];
  assert.equal(mapYanboExam(source).materials[0].questions[0].options, undefined);
});
test("an explicit number allowance preserves the source word cap and its additional number", () => {
  const source = baseExam(); source.reading.passages[0].groups[4].instructions = ["Choose ONE WORD AND/OR A NUMBER from the passage."]; source.reading.answers[5].a = ["4 sides"];
  const answer = mapYanboExam(source).materials[0].questions.find(q => q.number === 5).answer;
  assert.deepEqual({ maxWords: answer.maxWords, allowNumber: answer.allowNumber }, { maxWords: 1, allowNumber: true });
});
test("a required source image is not silently replaced by an unanswerable text question", () => {
  const source = baseExam(); source.reading.passages[0].groups[5].image = "images/required-map.png";
  const result = mapYanboExam(source);
  assert.equal(result.materials[0].questions.some(q => q.number === 6), false);
  assert.ok(result.issues.some(issue => /图/.test(issue.reason)));
});
test("unsupported groups are skipped independently with an issue", () => {
  const source = baseExam(); source.reading.passages[0].groups[0].type = "unknown-shape";
  const result = mapYanboExam(source);
  assert.equal(result.materials[0].questions.length, 5);
  assert.ok(result.issues.some(issue => /unknown-shape/.test(issue.reason)));
});
test("all four ten-question listening sections retain their matching local audio", () => {
  const result = mapYanboExam(listeningExam(), { audioBySection: Object.fromEntries([1, 2, 3, 4].map(s => [s, audio(s)])) });
  assert.equal(result.materials.length, 4);
  assert.equal(result.materials[2].source.sourceRef, "C21T1S3");
  assert.equal(result.materials[2].audio.path, "audio/synthetic-3.mp3");
  assert.ok(result.materials.every(m => LocalMaterialSchema.safeParse(m).success));
});
test("a choose-two group keeps two numbered slots with the complete answer set", () => {
  const source = baseExam(); source.reading.answers = { 1: { a: ["A"] }, 2: { a: ["C"] } };
  source.reading.passages[0].groups = [{ id: "multi", type: "multi", n: [1, 2], range: [1, 2], select: 2, text: "Which TWO activities?", options: [{ key: "A", text: "walk" }, { key: "B", text: "run" }, { key: "C", text: "swim" }] }];
  const result = mapYanboExam(source);
  assert.deepEqual(result.materials[0].questions.map(q => q.selectionCount), [2, 2]);
  assert.equal(result.materials[0].questions[0].groupId, result.materials[0].questions[1].groupId);
});
test("structured completion text maps numbered gaps without using answer text as the prompt", () => {
  const parsed = parseStructuredQuestions("Questions 1–2\nComplete the notes. ONE WORD ONLY.\nColour: (1) ____\nShape: (2) ____", { 1: "blue", 2: "round" }, { skill: "listening", sourceRef: "C21T1S1" });
  assert.equal(parsed.questions.length, 2);
  assert.match(parsed.questions[0].prompt, /Colour/);
  assert.doesNotMatch(parsed.questions[0].prompt, /blue/);
});
test("structured multiple choice preserves the source options", () => {
  const parsed = parseStructuredQuestions("Questions 11–12\nChoose the correct letter A, B or C.\n11. Which route?\nA The north route\nB The east route\nC The west route\n12. Which day?\nA Monday\nB Tuesday\nC Friday", { 11: "B", 12: "C" }, { skill: "listening", sourceRef: "C21T1S2" });
  assert.equal(parsed.questions[0].options[1].text, "The east route");
  assert.equal(parsed.questions[1].answer.accepted[0], "C");
});
test("an unparseable structured group is logged instead of guessing its type", () => {
  const parsed = parseStructuredQuestions("Questions 1–2\nAn unknown graphical task\n1. A label\n2. Another label", { 1: "A", 2: "B" }, { skill: "reading", sourceRef: "C21T1R1" });
  assert.equal(parsed.questions.length, 0);
  assert.ok(parsed.issues.length > 0);
});
test("XiaHua test-data JSON is read without executing adjacent scripts", () => {
  const result = parseXiaHuaHtml(xiaHtml(xiaData()), { sourceRef: "xiahua:p1-high-fixture", section: 1, audio: audio(1) });
  assert.equal(result.materials[0].questions.length, 10);
  assert.equal(result.materials[0].source.materialSource, "unofficial");
  assert.equal(result.materials[0].questions[0].evidence.startSeconds, 0);
  assert.equal(LocalMaterialSchema.safeParse(result.materials[0]).success, true);
});
test("XiaHua transcript markup is stripped while the actual English is retained", () => {
  const result = parseXiaHuaHtml(xiaHtml(xiaData()), { sourceRef: "xiahua:p1-high-fixture", section: 1, audio: audio(1) });
  assert.match(result.materials[0].transcript, /speaker says word1/);
  assert.doesNotMatch(result.materials[0].transcript, /<mark>/);
});
test("a short answer occurring only inside another word cannot invent an evidence timestamp", () => {
  const source = xiaData(); source.answerKey.text.q1 = "art"; source.transcriptLines[0].html = "The speaker says part.";
  const mapped = parseXiaHuaHtml(xiaHtml(source), { sourceRef: "xiahua:word-boundary", section: 1, audio: audio(1) });
  assert.equal(mapped.materials[0].questions[0].evidence.startSeconds, undefined);
});
test("duplicate detection ignores punctuation and case in the source transcript", () => {
  const text = "This fictional transcript contains enough distinct words to compare the conversation about arranging a local walking trip and buying equipment for a group of students next week at the community centre.";
  assert.equal(transcriptSimilarity(text, text.toUpperCase().replaceAll(" ", ", ")), 1);
});
test("unrelated transcripts are not labeled as duplicates", () => {
  assert.ok(transcriptSimilarity("A red bicycle follows a quiet path beside the river.", "Laboratory researchers examined microscopic mineral samples using advanced equipment.") < 0.5);
});
test("holdout assignments select complete exams and preserve an existing seeded choice", () => {
  const materials = Array.from({ length: 10 }, (_, i) => mapYanboExam({ ...listeningExam(), id: `C${i + 4}-T1`, source: { book: i + 4, test: 1 } }, { audioBySection: Object.fromEntries([1, 2, 3, 4].map(s => [s, audio(s)])) }).materials).flat();
  const first = assignHoldout(materials, { seed: "fixture-seed" });
  assert.equal(first.holdoutManifest.listening.length, 8);
  const again = assignHoldout([...materials].reverse(), { seed: "fixture-seed", existing: first.holdoutManifest });
  assert.deepEqual(again.holdoutManifest.listening, first.holdoutManifest.listening);
});
test("a missing listening section cannot enter the eight-exam holdout pool", () => {
  const materials = mapYanboExam(listeningExam(), { audioBySection: { 1: audio(1), 2: audio(2), 3: audio(3) } }).materials;
  assert.equal(assignHoldout(materials, { seed: "fixture-seed" }).holdoutManifest.listening.length, 0);
});
test("the generic import rejects a pack with a missing part rather than claiming a complete set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cambridge-fixture-"));
  try {
    const folder = path.join(root, "listening", "C21", "T1"); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "answers.json"), JSON.stringify({ ...listeningExam().listening, book: 21, test: 1 }));
    await fs.writeFile(path.join(folder, "transcript.md"), "Synthetic transcript only, not an actual Cambridge paper.");
    for (const s of [1, 2, 3]) await fs.writeFile(path.join(folder, `C21T1S${s}.mp3`), "synthetic bytes supplied to the injected probe");
    const result = await importCambridge({ from: root, probeAudio: async () => ({ durationSeconds: 120 }) });
    assert.ok(result.issues.some(issue => /音频|mp3/i.test(issue.reason)));
    assert.equal(result.holdoutManifest.listening.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("XiaHua imports skip a Cambridge transcript duplicate and record duplicateOf", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-xiahua-fixture-"));
  try {
    const folder = path.join(root, "P1", "高频", "fixture"); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "fixture.html"), xiaHtml(xiaData())); await fs.writeFile(path.join(folder, "audio.mp3"), "synthetic audio bytes");
    const transcript = xiaData().transcriptLines.map(line => line.html.replace(/<[^>]*>/g, "")).join(" ");
    const result = await importXiaHua({ from: root, cambridgeMaterials: [{ skill: "listening", transcript, source: { sourceRef: "C21T1S1" } }], probeAudio: async () => ({ durationSeconds: 120 }) });
    assert.equal(result.materials.length, 0);
    assert.equal(result.duplicates[0].duplicateOf, "C21T1S1");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function genericPack(root, { full = false, shortPart = false } = {}) {
  const folder = path.join(root, "listening", "C21", "T1"); await fs.mkdir(folder, { recursive: true });
  const data = listeningExam().listening;
  if (shortPart) data.parts[1].groups[0].content.pop();
  if (full) { data.scope = "full"; data.audio = "C21T1-full.mp3"; data.transcript = data.parts.map(part => part.transcript).join("\n"); await fs.writeFile(path.join(folder, data.audio), "synthetic original full-audio fixture"); }
  else for (let s = 1; s <= 4; s++) await fs.writeFile(path.join(folder, `C21T1S${s}.mp3`), "synthetic section bytes");
  await fs.writeFile(path.join(folder, "answers.json"), JSON.stringify(data));
  return { folder, data };
}
const probeFixture = async () => ({ durationSeconds: 120 });
test("four complete sections form an exam catalog without pretending part one is a full recording", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cam-complete-"));
  try {
    await genericPack(root); const output = await importCambridge({ from: root, probeAudio: probeFixture });
    assert.equal(output.materials.filter(m => m.skill === "listening").length, 4);
    assert.ok(output.materials.every(m => m.scope === "section"));
    assert.equal(output.examCatalog[0].complete, true); assert.equal(output.examCatalog[0].fullPlayable, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("a generic section with nine parsed questions rejects the complete pack", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cam-short-part-"));
  try {
    await genericPack(root, { shortPart: true }); const output = await importCambridge({ from: root, probeAudio: probeFixture });
    assert.equal(output.materials.length, 0); assert.ok(output.issues.some(x => /缺题/.test(x.reason)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("a malformed answers.json is reported without publishing an exam", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cam-bad-answers-"));
  try {
    const folder = path.join(root, "listening", "C21", "T1"); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, "answers.json"), "[]");
    const output = await importCambridge({ from: root, probeAudio: probeFixture });
    assert.equal(output.materials.length, 0); assert.ok(output.issues.some(x => /answers.json/.test(x.reason)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("an explicitly supplied original full recording can map forty actual questions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cam-real-full-"));
  try {
    await genericPack(root, { full: true }); const output = await importCambridge({ from: root, probeAudio: probeFixture });
    const full = output.materials.find(m => m.scope === "full");
    assert.equal(full.questions.length, 40); assert.equal(full.source.sourceRef, "C21T1"); assert.equal(full.id, "c21t1-listening-full");
    assert.equal(LocalMaterialSchema.safeParse(full).success, true); assert.equal(output.examCatalog[0].fullPlayable, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("a missing full original cannot be substituted with an existing first-part file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cam-no-full-"));
  try {
    const { folder } = await genericPack(root, { full: true }); await fs.unlink(path.join(folder, "C21T1-full.mp3")); await fs.writeFile(path.join(folder, "C21T1S1.mp3"), "synthetic first section");
    const output = await importCambridge({ from: root, probeAudio: probeFixture }); assert.equal(output.materials.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("forty unique question numbers outside 1–40 do not qualify an exam for holdout", () => {
  const full = { skill: "listening", scope: "full", source: { materialSource: "cambridge" }, examId: "C21T1", transcript: "synthetic", audio: audio(1), questions: Array.from({ length: 40 }, (_, i) => ({ number: 41 + i, answer: { accepted: ["x"] } })) };
  assert.deepEqual(assignHoldout([full]).holdoutManifest.listening, []);
});
test("taro takes priority over lincoh for book nineteen and preserves the discrepancy report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cam-taro-"));
  try {
    const audioRoot = path.join(root, "listening/maslow-cam1-20/ielts_listening/book_19"); await fs.mkdir(audioRoot, { recursive: true });
    let script = "# TEST 1\n"; let questions = "";
    for (let s = 1; s <= 4; s++) { await fs.writeFile(path.join(audioRoot, `test_1_part_${s}.mp3`), "synthetic section"); script += `## PART ${s}\nSynthetic words for this section.\n`; questions += `\nPART ${s}\nQuestions ${(s - 1) * 10 + 1}–${s * 10}\nComplete the notes. ONE WORD ONLY.\n` + Array.from({ length: 10 }, (_, q) => `Item (${(s - 1) * 10 + q + 1}) ____`).join("\n"); }
    await fs.writeFile(path.join(audioRoot, "audioscripts.md"), script);
    const doc = { id: "C19-T1-L", book: 19, test: 1, skill: "listening", text: questions, answers: { ...answers, 1: "red" } };
    for (const name of ["cam-lincoh", "cam-taro"]) { await fs.mkdir(path.join(root, "structured", name), { recursive: true }); await fs.writeFile(path.join(root, "structured", name, "C19-T1-L.json"), JSON.stringify(name === "cam-taro" ? { ...doc, questionsText: questions, answers: { ...doc.answers, 1: "blue" } } : doc)); }
    const output = await importCambridge({ from: root, probeAudio: probeFixture });
    assert.equal(output.materials.find(m => m.source.sourceRef === "C19T1S1").questions[0].answer.accepted[0], "blue");
    assert.ok(output.issues.some(x => /交叉核对存在差异/.test(x.reason)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("known mismapped book-three questions remain transcript-only and outside holdout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-cam-mismapped-"));
  try {
    const audioRoot = path.join(root, "listening/maslow-cam1-20/ielts_listening/book_03"); await fs.mkdir(audioRoot, { recursive: true });
    await fs.writeFile(path.join(audioRoot, "test_1_part_1.mp3"), "synthetic section"); await fs.writeFile(path.join(audioRoot, "audioscripts.md"), "# TEST 1\n## SECTION 1\nSynthetic book-three transcript.\n");
    await fs.mkdir(path.join(root, "structured/cam-lincoh"), { recursive: true }); await fs.writeFile(path.join(root, "structured/cam-lincoh/C3-T1-L.MISMAPPED.json"), JSON.stringify({ id: "C3-T1-L.MISMAPPED", book: 3, test: 1, skill: "listening", answers }));
    const output = await importCambridge({ from: root, probeAudio: probeFixture });
    assert.equal(output.materials.length, 1); assert.equal(output.materials[0].scope, "short"); assert.equal(output.materials[0].questions.length, 0);
    assert.deepEqual(output.holdoutManifest.listening, []); assert.ok(output.issues.some(x => /MISMAPPED/.test(x.reason)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
