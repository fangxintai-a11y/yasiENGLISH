import test from "node:test";
import assert from "node:assert/strict";
import {
  attemptPayload,
  countReadingWords,
  gradeMaterial,
  gradeQuestion,
  isFirstMaterialAttempt,
  isLongReading,
  normalizedAnswer,
  orderedReadingQuestions,
  estimatedReadingListeningBand,
} from "./readingModel";
import type { LocalMaterial, LocalQuestion } from "./localBankSchema";
import type { Revision } from "./protocol";
const q = (patch: Partial<LocalQuestion> = {}): LocalQuestion => ({
  id: "q1",
  type: "sentence-completion",
  prompt: "Complete",
  answer: { accepted: ["long-term", "long terms"], maxWords: 2 },
  evidence: { quote: "long-term" },
  answerVerified: true,
  ...patch,
});
const material: Extract<LocalMaterial, { skill: "reading" }> = {
  id: "fixture-reading",
  version: "1",
  contentHash: "a".repeat(64),
  title: "Fixture",
  skill: "reading",
  deliveryMode: "local-import",
  scope: "section",
  source: {
    materialSource: "unofficial",
    sourceRef: "fixture:reading",
    rights: "Self-authored test fixture",
    answerVerified: true,
  },
  passage: "First long-term study. Second result.",
  paragraphs: [
    { id: "p1", text: "First long-term study." },
    { id: "p2", text: "Second result." },
  ],
  questions: [q()],
};
test("T5: grading respects casing, whitespace, hyphens, accepted plurals and word limits", () => {
  assert.equal(normalizedAnswer("  Long—term  "), "long term");
  for (const answer of [" LONG-TERM ", "long term", "long terms"])
    assert.equal(gradeQuestion(q(), answer).correct, true);
  assert.equal(gradeQuestion(q(), "long-term studies").correct, false);
  assert.equal(
    gradeQuestion(
      q({ answer: { accepted: ["very long term"], maxWords: 2 } }),
      "very long term",
    ).errorCause,
    "word-limit",
  );
  assert.equal(gradeQuestion(q(), "longest").correct, false);
});
test("T6: fixed English word algorithm covers 799/800/900/901 and excludes drills", () => {
  assert.equal(countReadingWords("It's a 5-year project; 2.5% of them."), 7);
  for (const n of [799, 800, 900, 901]) {
    const m = { ...material, passage: Array(n).fill("word").join(" ") };
    assert.equal(countReadingWords(m.passage), n);
    assert.equal(isLongReading(m), n >= 800 && n <= 900);
    assert.equal(isLongReading({ ...m, scope: "type-drill" }), false);
    assert.equal(isLongReading({ ...m, scope: "short" }), false);
  }
});
test("T6: judgment groups sort by evidence then number without detaching answers", () => {
  const questions = [
    q({
      id: "q3",
      number: 3,
      type: "true-false-not-given",
      answer: { accepted: ["NOT GIVEN"], maxWords: 2 },
      evidence: { quote: "Second", rationale: "Context only" },
    }),
    q({
      id: "q1",
      number: 1,
      type: "true-false-not-given",
      evidence: { quote: "First" },
    }),
    q({
      id: "q2",
      number: 2,
      type: "yes-no-not-given",
      evidence: { quote: "First" },
    }),
  ];
  const ordered = orderedReadingQuestions({ ...material, questions });
  assert.deepEqual(
    ordered.map((x) => x.id),
    ["q1", "q3", "q2"],
  );
  assert.deepEqual(ordered[1].answer.accepted, ["NOT GIVEN"]);
});
test("T5: repeated material version is not a new first attempt; save payload keeps raw score", () => {
  const context = { planId: "plan-fixture", date: "2026-11-04", day: 1 };
  const payload = attemptPayload(material, ["long-term"], context, [], 60, {
    timed: true,
    replayed: false,
    transcriptViewed: false,
    replays: 0,
  });
  assert.equal(payload.firstAttempt, true);
  assert.equal(payload.score, 1);
  assert.equal(payload.materialSource, "unofficial");
  const record = {
    id: "attempt-fixture",
    kind: "attempt",
    planId: context.planId,
    payload,
    createdAt: 1,
    seq: 1,
    conflict: false,
    deleted: false,
  } as Revision;
  assert.equal(
    isFirstMaterialAttempt([record], context.planId, material),
    false,
  );
  assert.equal(
    isFirstMaterialAttempt([record], context.planId, {
      ...material,
      version: "2",
      contentHash: "b".repeat(64),
    }),
    true,
  );
  assert.equal(estimatedReadingListeningBand(37, 40, "full"), 8.5);
  assert.equal(estimatedReadingListeningBand(10, 10, "section"), null);
});
test("T5: Choose TWO groups accept exchanged order but never double credit a repeated choice", () => {
  const questions = [
    q({
      id: "q1",
      type: "multiple-choice",
      groupId: "g1",
      selectionCount: 2,
      answer: { accepted: ["A"], maxWords: 1 },
    }),
    q({
      id: "q2",
      type: "multiple-choice",
      groupId: "g1",
      selectionCount: 2,
      answer: { accepted: ["D"], maxWords: 1 },
    }),
  ];
  assert.equal(gradeMaterial({ ...material, questions }, ["D", "A"]).score, 2);
  assert.equal(gradeMaterial({ ...material, questions }, ["A", "A"]).score, 1);
  assert.equal(gradeMaterial({ ...material, questions }, ["D", "B"]).score, 1);
});

test("T5: overlapping accepted choices use maximum matching, independent of checkbox order", () => {
  const questions = [
    q({
      id: "q1",
      type: "multiple-choice",
      groupId: "multi",
      selectionCount: 2,
      options: [
        { id: "A", text: "Option A" },
        { id: "B", text: "Option B" },
      ],
      answer: { accepted: ["A", "B"], maxWords: 1 },
    }),
    q({
      id: "q2",
      type: "multiple-choice",
      groupId: "multi",
      selectionCount: 2,
      options: [
        { id: "A", text: "Option A" },
        { id: "B", text: "Option B" },
      ],
      answer: { accepted: ["A"], maxWords: 1 },
    }),
  ];
  for (const answers of [
    ["A", "B"],
    ["B", "A"],
  ])
    assert.equal(gradeMaterial({ ...material, questions }, answers).score, 2);
});

test("T6: 100 fixed-seed shuffled judgment groups retain IDs, answers and evidence order", () => {
  let seed = 7391;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let run = 0; run < 100; run++) {
    const type = run % 2 ? "yes-no-not-given" : "true-false-not-given";
    const labels =
      type === "yes-no-not-given"
        ? ["YES", "NO", "NOT GIVEN"]
        : ["TRUE", "FALSE", "NOT GIVEN"];
    const paragraphs = [
      { id: "p1", text: "Opening Alpha. Middle Beta. Ending Gamma." },
      { id: "p2", text: "Opening Delta. Middle Epsilon. Ending Zeta." },
    ];
    const words = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
    const questions = words.map((word, i) =>
      q({
        id: `q${i + 1}`,
        number: i + 1,
        groupId: "judgment",
        type,
        answer: { accepted: [labels[i % 3]], maxWords: 2 },
        evidence: {
          paragraphId: i < 3 ? "p1" : "p2",
          offset: paragraphs[i < 3 ? 0 : 1].text.indexOf(word),
          quote: word,
          rationale: "Related context for information not stated",
        },
      }),
    );
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
    const ordered = orderedReadingQuestions({
      ...material,
      paragraphs,
      passage: paragraphs.map((p) => p.text).join(" "),
      questions,
    });
    assert.deepEqual(
      ordered.map((item) => item.id),
      ["q1", "q2", "q3", "q4", "q5", "q6"],
    );
    for (let i = 0; i < ordered.length; i++) {
      assert.equal(ordered[i].answer.accepted[0], labels[i % 3]);
      assert.equal(ordered[i].evidence.quote, words[i]);
    }
  }
});

test("T6: identical evidence positions use numeric question order", () => {
  const questions = [
    q({
      id: "q10",
      number: 10,
      type: "true-false-not-given",
      answer: { accepted: ["FALSE"], maxWords: 2 },
      evidence: { paragraphId: "p1", quote: "First", offset: 0 },
    }),
    q({
      id: "q2",
      number: 2,
      type: "true-false-not-given",
      answer: { accepted: ["TRUE"], maxWords: 2 },
      evidence: { paragraphId: "p1", quote: "First", offset: 0 },
    }),
  ];
  assert.deepEqual(
    orderedReadingQuestions({ ...material, questions }).map((item) => [
      item.id,
      item.answer.accepted[0],
    ]),
    [
      ["q2", "TRUE"],
      ["q10", "FALSE"],
    ],
  );
});

test("T5: full-set indicative conversion follows the cited IDP listening/Academic reading boundaries", () => {
  for (const [score, band] of [
    [11, 4],
    [13, 4.5],
    [16, 5],
    [18, 5.5],
    [23, 6],
    [26, 6.5],
    [30, 7],
    [32, 7.5],
    [35, 8],
    [37, 8.5],
    [39, 9],
  ])
    assert.equal(estimatedReadingListeningBand(score, 40, "full"), band);
  assert.equal(estimatedReadingListeningBand(10, 40, "full"), null);
});

test("T5: an explicit word-and-number allowance is separate from a multiword option ID", () => {
  const number = q({
    answer: { accepted: ["12 million years"], maxWords: 2, allowNumber: true },
  });
  assert.equal(gradeQuestion(number, "12 million years").correct, true);
  assert.equal(
    gradeQuestion(number, "12 13 million years").errorCause,
    "word-limit",
  );
  const option = q({
    type: "summary-completion",
    options: [
      { id: "creative thought", text: "creative thought" },
      { id: "native fish", text: "native fish" },
    ],
    answer: { accepted: ["creative thought"], maxWords: 1 },
  });
  assert.equal(gradeQuestion(option, "creative thought").correct, true);
});

test("T6: English ordinal and unit tokens are not split into invented extra words", () => {
  assert.equal(countReadingWords("April 18th 12cm 1.25 5-year o'clock"), 6);
});

test("T5: published number-alternative forms respect the explicit word-and-number instruction", () => {
  const forms = [
    q({
      answer: {
        accepted: ["4 sides", "four sides"],
        maxWords: 1,
        allowNumber: true,
      },
    }),
    q({
      answer: {
        accepted: ["10 times", "ten times"],
        maxWords: 1,
        allowNumber: true,
      },
    }),
    q({
      answer: {
        accepted: ["April 18th", "April the 18th"],
        maxWords: 2,
        allowNumber: true,
      },
    }),
  ];
  for (const question of forms)
    for (const value of question.answer.accepted)
      assert.equal(gradeQuestion(question, value).correct, true);
});

test("T6: an explicit paragraph anchor takes precedence over a repeated quote elsewhere", () => {
  const paragraphs = [
    { id: "p1", text: "Demand rose. Later fact." },
    { id: "p2", text: "Demand rose." },
  ];
  const questions = [
    q({
      id: "q2",
      number: 2,
      type: "true-false-not-given",
      answer: { accepted: ["TRUE"], maxWords: 2 },
      evidence: { paragraphId: "p2", quote: "Demand rose.", offset: 0 },
    }),
    q({
      id: "q1",
      number: 1,
      type: "true-false-not-given",
      answer: { accepted: ["FALSE"], maxWords: 2 },
      evidence: { paragraphId: "p1", quote: "Later fact.", offset: 13 },
    }),
  ];
  assert.deepEqual(
    orderedReadingQuestions({
      ...material,
      paragraphs,
      passage: paragraphs.map((p) => p.text).join(" "),
      questions,
    }).map((item) => item.id),
    ["q1", "q2"],
  );
});
