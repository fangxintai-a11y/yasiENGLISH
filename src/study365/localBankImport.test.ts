import assert from "node:assert/strict";
import test from "node:test";
import { mapNativeReading, checkLocalAnswers } from "./localBankImport";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const text = (value: string) => ({ type: "text", text: value });
const element = (tag: string, children: unknown[], attrs = {}) => ({
  type: "element",
  tag,
  attrs,
  children,
});
function fixture() {
  const groups = [
    {
      groupId: "g1",
      kind: "true_false_not_given",
      questionIds: ["q1"],
      allowOptionReuse: false,
      contentNodes: [
        element("p", [
          text("1 The garden collects rainwater."),
          {
            type: "choiceInput",
            questionId: "q1",
            questionIds: ["q1"],
            value: "TRUE",
            inputType: "radio",
          },
        ]),
      ],
    },
    {
      groupId: "g2",
      kind: "yes_no_not_given",
      questionIds: ["q2"],
      allowOptionReuse: false,
      contentNodes: [
        element("p", [
          text("2 The writer supports sharing seeds."),
          {
            type: "choiceInput",
            questionId: "q2",
            questionIds: ["q2"],
            value: "YES",
            inputType: "radio",
          },
        ]),
      ],
    },
    {
      groupId: "g3",
      kind: "matching",
      questionIds: ["q3"],
      allowOptionReuse: false,
      contentNodes: [
        element("p", [text("Choose the correct heading for paragraph A.")]),
        {
          type: "optionChip",
          poolId: "head",
          value: "i",
          label: "Collecting water",
        },
        {
          type: "optionChip",
          poolId: "head",
          value: "ii",
          label: "Planting trees",
        },
      ],
    },
    {
      groupId: "g4",
      kind: "matching",
      questionIds: ["q4"],
      allowOptionReuse: true,
      contentNodes: [
        element("p", [
          text("Which paragraph contains information about seed sharing?"),
          { type: "dropzone", questionId: "q4", appearance: "match" },
        ]),
        { type: "optionChip", poolId: "paragraphs", value: "A", label: "A" },
        { type: "optionChip", poolId: "paragraphs", value: "B", label: "B" },
      ],
    },
    {
      groupId: "g5",
      kind: "sentence_completion",
      questionIds: ["q5"],
      allowOptionReuse: false,
      contentNodes: [
        element("p", [
          text("Write ONE WORD. The garden collects "),
          { type: "textInput", questionId: "q5" },
          text("."),
        ]),
      ],
    },
    {
      groupId: "g6",
      kind: "single_choice",
      questionIds: ["q6"],
      allowOptionReuse: false,
      contentNodes: [
        element(
          "div",
          [
            element("p", [text("Why is the garden useful?")]),
            element("label", [
              {
                type: "choiceInput",
                questionId: "q6",
                questionIds: ["q6"],
                value: "A",
                inputType: "radio",
              },
              text("It saves water"),
            ]),
            element("label", [
              {
                type: "choiceInput",
                questionId: "q6",
                questionIds: ["q6"],
                value: "B",
                inputType: "radio",
              },
              text("It builds roads"),
            ]),
          ],
          { class: "question-item" },
        ),
      ],
    },
  ];
  return {
    schemaVersion: "ReadingExamDocumentV1",
    examId: "synthetic-native",
    meta: {
      title: "Synthetic importer fixture",
      category: "P1",
      frequency: "high",
    },
    passageBlocks: [
      {
        nodes: [
          element(
            "div",
            [
              {
                type: "dropzone",
                questionId: "q3",
                paragraph: "A",
                appearance: "paragraph",
              },
              element("p", [text("The garden collects rainwater.")]),
            ],
            { class: "paragraph-wrapper", id: "pa" },
          ),
          element(
            "div",
            [element("p", [text("Neighbours share seeds in the garden.")])],
            { class: "paragraph-wrapper", id: "pb" },
          ),
        ],
      },
    ],
    paragraphAnchors: { A: "pa", B: "pb" },
    questionGroups: groups,
    questionItems: groups.flatMap((group) =>
      group.questionIds.map((questionId) => ({
        questionId,
        displayNumber: questionId.slice(1),
      })),
    ),
    questionOrder: ["q1", "q2", "q3", "q4", "q5", "q6"],
    answerKey: {
      q1: "TRUE",
      q2: "YES",
      q3: "i",
      q4: "B",
      q5: "rainwater",
      q6: "A",
    },
  };
}
test("native reading maps original AST into six required types, stable IDs, source frequency and unverified answers", async () => {
  const result = await mapNativeReading(fixture(), "source-commit");
  assert.equal(result.questions.length, 6);
  assert.equal(result.passageNumber, 1);
  assert.equal(result.frequency, "high");
  assert.deepEqual(
    result.questions.map((question) => question.type),
    [
      "true-false-not-given",
      "yes-no-not-given",
      "matching-headings",
      "matching-information",
      "sentence-completion",
      "multiple-choice",
    ],
  );
  assert.equal(result.source.materialSource, "unofficial");
  assert.equal(result.source.answerVerified, false);
  assert.equal(result.paragraphs[0].label, "A");
  assert.ok(result.questions[4].prompt.includes("____"));
  assert.ok(result.questions.every((question) => !question.answerVerified));
});
test("missing answer, unsupported type, broken paragraph and required image independently reject a native article", async () => {
  const missing = fixture();
  delete (missing.answerKey as Record<string, string>).q1;
  await assert.rejects(mapNativeReading(missing, "v1"), /答案/);
  const unknown = fixture();
  unknown.questionGroups[0].kind = "unknown_task";
  await assert.rejects(mapNativeReading(unknown, "v1"), /题型/);
  const paragraph = fixture();
  paragraph.paragraphAnchors.A = "missing";
  await assert.rejects(mapNativeReading(paragraph, "v1"), /段落/);
  const image = fixture();
  image.passageBlocks[0].nodes.push(
    element("img", [], {
      src: "diagram.png",
    }) as (typeof image.passageBlocks)[number]["nodes"][number],
  );
  await assert.rejects(mapNativeReading(image, "v1"), /图/);
});
test("answer check locates words and genuine paragraph references, marks missing answers pending without changing originals", async () => {
  const material = await mapNativeReading(fixture(), "v1"),
    original = JSON.stringify(material.questions[4].answer);
  const good = checkLocalAnswers(material);
  assert.equal(
    good.find((value) => value.questionId.endsWith("q5"))?.located,
    true,
  );
  const altered = structuredClone(material);
  altered.questions[4].answer.accepted = ["invented"];
  assert.equal(
    checkLocalAnswers(altered).find((value) => value.questionId.endsWith("q5"))
      ?.located,
    false,
  );
  assert.equal(JSON.stringify(material.questions[4].answer), original);
});
test("ordinary node CLI skips a bad article, logs its cause, and continues producing the valid bank", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "band-native-cli-"));
  await writeFile(path.join(folder, "good.json"), JSON.stringify(fixture()));
  const bad = fixture();
  bad.examId = "bad-native";
  bad.questionGroups[0].kind = "unknown_task";
  await writeFile(path.join(folder, "bad.json"), JSON.stringify(bad));
  const bank = path.join(folder, "bank.json"),
    log = path.join(folder, "log.json");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/import-local-bank.mjs",
      "reading",
      "--from",
      folder,
      "--out",
      path.join(folder, "public"),
      "--bank",
      bank,
      "--log",
      log,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(await readFile(bank, "utf8")),
    report = JSON.parse(await readFile(log, "utf8"));
  assert.equal(output.importVersion, 1);
  assert.equal(output.materials.length, 1);
  assert.ok(
    report.issues.some(
      (issue: { sourceRef: string; reason: string }) =>
        issue.sourceRef.includes("bad.json") && issue.reason.includes("题型"),
    ),
  );
});
test("source instructions present only in leadNodes control the exact word limit and remain visible", async () => {
  const source = fixture();
  const groups = source.questionGroups.map((group) =>
    group.groupId === "g5"
      ? {
          ...group,
          kind: "short_answer",
          leadNodes: [
            element("p", [
              text("Write NO MORE THAN TWO WORDS for each answer."),
            ]),
          ],
          contentNodes: [
            element("p", [
              text("What does the garden collect? "),
              { type: "textInput", questionId: "q5" },
            ]),
          ],
        }
      : group,
  );
  const material = await mapNativeReading(
    { ...source, questionGroups: groups },
    "lead-fixture-v1",
  );
  assert.equal(
    material.questions.find((question) => question.id.endsWith("q5"))?.answer
      .maxWords,
    2,
  );
  assert.ok(
    material.instructions?.some((value) =>
      value.includes("NO MORE THAN TWO WORDS"),
    ),
  );
});
test("explicit words AND/OR A NUMBER keeps a separate numeric allowance without raising maxWords", async () => {
  const source = fixture();
  source.answerKey.q5 = "12 million years";
  const groups = source.questionGroups.map((group) =>
    group.groupId === "g5"
      ? {
          ...group,
          contentNodes: [
            element("p", [
              text(
                "Write NO MORE THAN TWO WORDS AND/OR A NUMBER. Time elapsed: ",
              ),
              { type: "textInput", questionId: "q5" },
            ]),
          ],
        }
      : group,
  );
  const material = await mapNativeReading(
    { ...source, questionGroups: groups },
    "number-fixture-v1",
  );
  const answer = material.questions.find((question) =>
    question.id.endsWith("q5"),
  )!.answer;
  assert.equal(answer.maxWords, 2);
  assert.equal(
    (answer as typeof answer & { allowNumber?: boolean }).allowNumber,
    true,
  );
  assert.deepEqual(answer.accepted, ["12 million years"]);
});
test("a source explicitly marking one optional parenthesized word expands both accepted forms", async () => {
  const source = fixture();
  source.answerKey.q5 = "(vigorous) exercise";
  const groups = source.questionGroups.map((group) =>
    group.groupId === "g5"
      ? {
          ...group,
          contentNodes: [
            element("p", [
              text("Write NO MORE THAN TWO WORDS. Activity: "),
              { type: "textInput", questionId: "q5" },
            ]),
          ],
        }
      : group,
  );
  const material = await mapNativeReading(
    { ...source, questionGroups: groups },
    "optional-fixture-v1",
  );
  assert.deepEqual(
    material.questions.find((question) => question.id.endsWith("q5"))!.answer
      .accepted,
    ["vigorous exercise", "exercise"],
  );
});
test("free completion with no accepted answer inside its actual source word limit rejects the article", async () => {
  const source = fixture();
  source.answerKey.q5 = "two words";
  await assert.rejects(
    mapNativeReading(source, "invalid-limit-v1"),
    /词数|字数/,
  );
});
