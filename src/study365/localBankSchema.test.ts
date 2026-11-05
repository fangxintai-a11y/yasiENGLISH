import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalMaterialSchema,
  hashLocalMaterial,
  parseLocalBank,
} from "./localBankSchema";
const material = () => ({
  id: "fixture-reading",
  version: "1",
  skill: "reading",
  title: "Synthetic importer fixture",
  deliveryMode: "local-import",
  scope: "section",
  contentHash: "a".repeat(64),
  source: {
    materialSource: "unofficial",
    sourceRef: "self-authored-fixture",
    rights: "Project-authored test data",
    answerVerified: false,
  },
  passage: "A garden uses rainwater.",
  paragraphs: [{ id: "pa", text: "A garden uses rainwater." }],
  passageNumber: 1,
  questions: [
    {
      id: "q1",
      type: "sentence-completion",
      prompt: "The garden uses ____.",
      answer: { accepted: ["rainwater"], maxWords: 1 },
      evidence: { paragraphId: "pa", quote: "A garden uses rainwater." },
      answerVerified: false,
    },
  ],
});
test("local reading keeps source/scope/unknown verification without the built-in word and question-count limits", () => {
  const parsed = LocalMaterialSchema.parse(material());
  assert.equal(parsed.source.materialSource, "unofficial");
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.source.answerVerified, false);
});
test("local schema rejects bad references, unknown fields and remote or traversal audio independently", () => {
  const badReference = material();
  badReference.questions[0].evidence.paragraphId = "missing";
  assert.equal(LocalMaterialSchema.safeParse(badReference).success, false);
  assert.equal(
    LocalMaterialSchema.safeParse({ ...material(), injected: true }).success,
    false,
  );
  const {
    passage,
    paragraphs: _paragraphs,
    passageNumber: _passage,
    ...common
  } = material();
  const listening = {
    ...common,
    skill: "listening",
    transcript: passage,
    questions: common.questions.map((question) => ({
      ...question,
      evidence: { quote: passage },
    })),
    audio: { path: "audio/fixture.mp3", durationSeconds: 10 },
  };
  assert.equal(LocalMaterialSchema.safeParse(listening).success, true);
  for (const path of [
    "https://example.com/voice.mp3",
    "audio/../voice.mp3",
    "audio/%2e%2e/voice.mp3",
  ]) {
    const parsed = LocalMaterialSchema.safeParse({
      ...listening,
      audio: { ...listening.audio, path },
    });
    assert.equal(parsed.success, false);
    if (!parsed.success)
      assert.ok(
        parsed.error.issues.some(
          (issue) => issue.path.join(".") === "audio.path",
        ),
      );
  }
});
test("only short text practice can omit questions, and multi-selection needs consistent complete slots/options", () => {
  assert.equal(
    LocalMaterialSchema.safeParse({ ...material(), questions: [] }).success,
    false,
  );
  assert.equal(
    LocalMaterialSchema.safeParse({
      ...material(),
      scope: "short",
      questions: [],
    }).success,
    true,
  );
  const value = material();
  value.questions[0] = {
    ...value.questions[0],
    groupId: "g1",
    selectionCount: 2,
  } as (typeof value.questions)[number];
  assert.equal(LocalMaterialSchema.safeParse(value).success, false);
});
test("content hashing is stable across key order and excludes only its own hash", async () => {
  const value = material();
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(
    await hashLocalMaterial(value),
    await hashLocalMaterial(reversed),
  );
  assert.notEqual(
    await hashLocalMaterial(value),
    await hashLocalMaterial({ ...value, passage: "Changed" }),
  );
});
test("bank parsing isolates bad items and duplicate id/version instead of losing the good material", async () => {
  const value = material();
  value.contentHash = await hashLocalMaterial(value);
  const result = await parseLocalBank({
    importVersion: 1,
    materials: [value, { ...value, id: "bad", questions: [] }, value],
  });
  assert.equal(result.materials.length, 1);
  assert.equal(result.duplicate, 1);
  assert.equal(result.issues.length, 1);
});
test("an explicit evidence offset must point to the exact quote in its actual paragraph", () => {
  for (const offset of [1, 9999]) {
    const value = material();
    value.questions[0].evidence = {
      ...value.questions[0].evidence,
      offset,
    } as (typeof value.questions)[number]["evidence"];
    const parsed = LocalMaterialSchema.safeParse(value);
    assert.equal(parsed.success, false);
    if (!parsed.success)
      assert.ok(
        parsed.error.issues.some(
          (issue) => issue.path.join(".") === "questions.0.evidence.offset",
        ),
      );
  }
});
