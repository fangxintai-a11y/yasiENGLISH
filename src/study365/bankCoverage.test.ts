import test from "node:test";
import assert from "node:assert/strict";
import type { LocalMaterial, LocalQuestion } from "./localBankSchema";
import type { Revision } from "./protocol";
import {
  bankCoverage,
  completeExamGroups,
  exportBankGaps,
  type SequenceOriginCatalog,
} from "./bankCoverage";
import { buildAnswerReviewPayload } from "./answerReviewModel";
const q = (number: number): LocalQuestion => ({
  id: `q${number}`,
  number,
  type: "sentence-completion",
  prompt: `Synthetic question ${number}`,
  answer: { accepted: ["word"], maxWords: 1 },
  evidence: {},
  answerVerified: false,
});
const section = (
  examId: string,
  part: number,
  holdout = false,
): LocalMaterial => ({
  id: `${examId.toLowerCase()}s${part}`,
  examId,
  section: part,
  skill: "listening",
  title: `${examId} original part ${part}`,
  version: "1",
  contentHash: String(part).repeat(64),
  source: {
    materialSource: "cambridge",
    sourceRef: `${examId}S${part}`,
    rights: "Self-authored test fixture",
    answerVerified: false,
  },
  scope: "section",
  pool: holdout ? "holdout" : "practice",
  deliveryMode: "local-import",
  transcript: `${examId} synthetic original part ${part}.`,
  audio: {
    path: `audio/${examId.toLowerCase()}s${part}.mp3`,
    durationSeconds: 10,
  },
  questions: Array.from({ length: 10 }, (_, index) =>
    q((part - 1) * 10 + index + 1),
  ),
});
let n = 0;
const record = (
  kind: Revision["kind"],
  payload: Record<string, unknown>,
): Revision => ({
  id: `r-${++n}`,
  kind,
  planId: "coverage-plan",
  datasetId: null,
  revisionId: `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`,
  baseRevision: null,
  seq: n,
  createdAt: n,
  contentHash: "f".repeat(64),
  payload,
  conflict: false,
  deleted: false,
});
const seen = (m: LocalMaterial) =>
  record("attempt", {
    planId: "coverage-plan",
    contentId: m.id,
    contentVersion: m.version,
    contentHash: m.contentHash,
    skill: m.skill,
    answers: [],
  });
const full = (parts: LocalMaterial[]): LocalMaterial =>
  ({
    ...parts[0],
    id: `${parts[0].examId!.toLowerCase()}-full`,
    scope: "full",
    transcript: "Original full recording.",
    questions: parts.flatMap((part) => part.questions),
  }) as LocalMaterial;

test("strict four-part originals are one complete and sequential exam, not four full exams", () => {
  const parts = [1, 2, 3, 4].map((part) => section("C1T1", part));
  const result = bankCoverage(parts, [], "coverage-plan");
  const listen = result.exams.find((item) => item.skill === "listening")!;
  assert.equal(listen.complete, 1);
  assert.equal(listen.sequential, 1);
  assert.equal(listen.fullPlayable, 0);
  assert.equal(listen.annualMissing, 68);
  assert.equal(
    result.rows.find(
      (item) =>
        item.skill === "listening" &&
        item.questionType === "sentence-completion",
    )!.cambridge,
    40,
  );
});
test("full plus its existing sections cannot double-count questions, fresh retest units or annual section stock", () => {
  const parts = [1, 2, 3, 4].map((part) => section("C1T1", part)),
    duplicateFull = full(parts);
  const result = bankCoverage([...parts, duplicateFull], [], "coverage-plan");
  assert.equal(result.audits.independentQuestions, 40);
  assert.equal(result.audits.rawQuestionEntries, 80);
  assert.equal(result.audits.pending, 40);
  const row = result.rows.find(
    (item) =>
      item.skill === "listening" && item.questionType === "sentence-completion",
  )!;
  assert.equal(row.available, 40);
  assert.equal(row.retestAvailable, 4);
  assert.equal(
    result.exams.find((item) => item.skill === "listening")!.complete,
    1,
  );
  assert.equal(
    result.sections.find((item) => item.skill === "listening")!.available,
    4,
  );
});
test("partial audio sets or duplicate question numbers never become complete through a catalog flag", () => {
  const missing = [1, 2, 3].map((part) => section("C1T1", part));
  assert.equal(
    bankCoverage(missing, [], "coverage-plan", [
      {
        skill: "listening",
        examId: "C1T1",
        complete: true,
        fullPlayable: true,
      },
    ]).exams[0].complete,
    0,
  );
  const bad = [1, 2, 3, 4].map((part) => section("C2T1", part));
  bad[3].questions[0].number = 1;
  assert.equal(completeExamGroups(bad)[0].sequential, false);
  const noAudio = [1, 2, 3, 4].map((part) => section("C3T1", part));
  if (noAudio[3].skill === "listening") delete noAudio[3].audio;
  assert.equal(completeExamGroups(noAudio)[0].complete, false);
});
test("holdout is counted once in its own stock and excluded from practice, retests and remaining days", () => {
  const practice = [1, 2, 3, 4].map((part) => section("C1T1", part)),
    holdout = [1, 2, 3, 4].map((part) => section("C2T1", part, true));
  const result = bankCoverage(
    [...practice, ...holdout],
    [seen(practice[0])],
    "coverage-plan",
  );
  const row = result.rows.find(
    (item) =>
      item.skill === "listening" && item.questionType === "sentence-completion",
  )!;
  assert.equal(row.available, 40);
  assert.equal(row.done, 10);
  assert.equal(row.unseen, 30);
  assert.equal(row.retestAvailable, 3);
  const exams = result.exams.find((item) => item.skill === "listening")!;
  assert.equal(exams.complete, 2);
  assert.equal(exams.holdout, 1);
  assert.equal(exams.holdoutMissing, 7);
  assert.equal(exams.unseenPractice, 0);
  assert.equal(
    result.sections.find((item) => item.skill === "listening")!.daysRemaining,
    3,
  );
});
test("all official type rows exist and absent official sources remain explicit even with Cambridge stock", () => {
  const result = bankCoverage([section("C1T1", 1)], [], "coverage-plan");
  assert.equal(result.rows.length, 24);
  const row = result.rows.find(
    (item) =>
      item.skill === "listening" && item.questionType === "sentence-completion",
  )!;
  assert.equal(row.official, 0);
  assert.equal(row.cambridge, 10);
  assert.equal(row.officialMissing, 1);
  assert.equal(row.missing, 0);
  const exported = exportBankGaps(result);
  assert.equal(exported.exportVersion, 1);
  assert.ok(
    exported.gaps.some(
      (item) =>
        item.skill === "listening" &&
        item.questionType === "sentence-completion" &&
        item.purpose === "official-type" &&
        item.missing === 1,
    ),
  );
  assert.ok(
    exported.gaps.every(
      (item) => item.missing > 0 && item.required > item.available,
    ),
  );
});
test("a review changes audit progress only for its exact original version and hash", () => {
  const m = section("C1T1", 1),
    decision = record(
      "answerReview",
      buildAnswerReviewPayload("coverage-plan", m, "q1", {
        verdict: "key-wrong",
        correctedAnswers: ["other"],
        note: "Checked self-authored text.",
        reviewer: "human",
      }),
    );
  const before = JSON.stringify(m),
    result = bankCoverage([m], [decision], "coverage-plan");
  assert.equal(result.audits.pending, 9);
  assert.equal(result.audits.reviewed, 1);
  assert.equal(result.audits.keyWrong, 1);
  const changed = { ...m, contentHash: "b".repeat(64) };
  assert.equal(
    bankCoverage([changed], [decision], "coverage-plan").audits.pending,
    10,
  );
  assert.equal(JSON.stringify(m), before);
});
test("built-in fallbacks and repeated versions do not inflate source stock", () => {
  const m = section("C1T1", 1),
    old = { ...m, version: "0" },
    fallback = {
      ...m,
      id: "builtin",
      source: { ...m.source, sourceRef: "builtin:listening-sample-01" },
    };
  const result = bankCoverage([m, old, fallback], [], "coverage-plan");
  assert.equal(result.materialRecords, 1);
  assert.equal(result.audits.independentQuestions, 10);
});

const sequenceOrigin = (
  parts: ReturnType<typeof section>[],
): SequenceOriginCatalog => {
  if (parts.some((part) => part.skill !== "listening"))
    throw new Error("Listening parts required.");
  const listeningParts = parts as Extract<
    LocalMaterial,
    { skill: "listening" }
  >[];
  const material = {
    ...full(parts),
    id: "sequence-cambridge-c1t1",
    version: "sequence-v1-self-authored",
    contentHash: "e".repeat(64),
  } as Extract<LocalMaterial, { skill: "listening" }>;
  delete material.audio;
  return {
    material,
    parts: [
      listeningParts[0],
      listeningParts[1],
      listeningParts[2],
      listeningParts[3],
    ],
  };
};
const sequenceAttempt = (
  sequence: SequenceOriginCatalog,
  changes: Record<string, unknown> = {},
) =>
  record("attempt", {
    planId: "coverage-plan",
    contentId: sequence.material.id,
    contentVersion: sequence.material.version,
    contentHash: sequence.material.contentHash,
    skill: "listening",
    scope: "full",
    total: 40,
    answers: Array(40).fill("word"),
    conditions: { sequential: true },
    ...changes,
  });

test("an exact completed virtual sequence marks its four originals used without adding material or audio", () => {
  const parts = [1, 2, 3, 4].map((part) => section("C1T1", part)),
    origin = sequenceOrigin(parts),
    attempt = sequenceAttempt(origin),
    bank = [...parts, origin.material],
    before = JSON.stringify({ bank, attempt, origin });
  const result = bankCoverage(bank, [attempt], "coverage-plan", [], [origin]);
  const row = result.rows.find(
    (item) =>
      item.skill === "listening" && item.questionType === "sentence-completion",
  )!;
  assert.equal(row.available, 40);
  assert.equal(row.done, 40);
  assert.equal(row.unseen, 0);
  assert.equal(row.retestAvailable, 0);
  const sections = result.sections.find((item) => item.skill === "listening")!;
  assert.equal(sections.available, 4);
  assert.equal(sections.done, 4);
  assert.equal(sections.remaining, 0);
  const exams = result.exams.find((item) => item.skill === "listening")!;
  assert.equal(exams.complete, 1);
  assert.equal(exams.sequential, 1);
  assert.equal(exams.fullPlayable, 0);
  assert.equal(exams.unseenPractice, 0);
  assert.equal(result.materialRecords, 4);
  assert.equal(result.audits.independentQuestions, 40);
  assert.equal(result.audits.rawQuestionEntries, 40);
  assert.equal(JSON.stringify({ bank, attempt, origin }), before);
});

test("a changed virtual tuple or stale original manifest cannot mark current sequence originals used", () => {
  const parts = [1, 2, 3, 4].map((part) => section("C1T1", part)),
    origin = sequenceOrigin(parts);
  const cases = [
    {
      bank: parts,
      attempt: sequenceAttempt(origin, { contentHash: "a".repeat(64) }),
    },
    {
      bank: parts,
      attempt: sequenceAttempt(origin, { contentVersion: "sequence-v1-other" }),
    },
    {
      bank: [{ ...parts[0], contentHash: "a".repeat(64) }, ...parts.slice(1)],
      attempt: sequenceAttempt(origin),
    },
    {
      bank: [
        ...parts,
        { ...parts[0], version: "2", contentHash: "b".repeat(64) },
      ],
      attempt: sequenceAttempt(origin),
    },
  ];
  for (const { bank, attempt } of cases) {
    const result = bankCoverage(bank, [attempt], "coverage-plan", [], [origin]);
    const row = result.rows.find(
      (item) =>
        item.skill === "listening" &&
        item.questionType === "sentence-completion",
    )!;
    assert.equal(row.done, 0);
    assert.equal(row.unseen, 40);
    assert.equal(
      result.sections.find((item) => item.skill === "listening")!.remaining,
      4,
    );
    assert.equal(
      result.exams.find((item) => item.skill === "listening")!.unseenPractice,
      1,
    );
  }
});

test("a matching sequence identifier without full forty-question sequential completion is not four completed parts", () => {
  const parts = [1, 2, 3, 4].map((part) => section("C1T1", part)),
    origin = sequenceOrigin(parts);
  for (const changes of [
    { conditions: { sequential: false } },
    { scope: "section" },
    { total: 39 },
    { skill: "reading" },
  ]) {
    const result = bankCoverage(
      parts,
      [sequenceAttempt(origin, changes)],
      "coverage-plan",
      [],
      [origin],
    );
    assert.equal(
      result.sections.find((item) => item.skill === "listening")!.done,
      0,
    );
    assert.equal(
      result.rows.find(
        (item) =>
          item.skill === "listening" &&
          item.questionType === "sentence-completion",
      )!.done,
      0,
    );
  }
});
