import test from "node:test";
import assert from "node:assert/strict";
import type { Revision } from "./protocol";
import { readingDailyRequirements } from "./ui/reading/ListeningReadingPlan";
const make = (
  id: string,
  scope: string,
  source: string,
  firstAttempt: boolean,
) =>
  ({
    id,
    kind: "attempt",
    datasetId: null,
    planId: "p",
    revisionId: `revision-${id}`,
    baseRevision: null,
    contentHash: "a".repeat(64),
    createdAt: 1,
    seq: 1,
    deleted: false,
    conflict: false,
    payload: {
      planId: "p",
      date: "2026-11-04",
      taskId: "d4-reading",
      skill: "reading",
      scope,
      materialSource: source,
      firstAttempt,
      questionResults: [
        {
          questionId: "q",
          correct: true,
          errorCause: null,
          confidence: "sure",
          reviewCorrect: true,
        },
      ],
    },
  }) as Revision;
test("a completed official drill alone cannot complete the first-14-day reading block", () => {
  assert.deepEqual(
    readingDailyRequirements(
      [make("drill", "type-drill", "official", true)],
      "p",
      "2026-11-04",
      "d4-reading",
    ),
    { official: true, article: false, complete: false },
  );
});
test("a reviewed official drill and a new reviewed article complete the reading content requirement", () => {
  assert.equal(
    readingDailyRequirements(
      [
        make("drill", "type-drill", "official", false),
        make("article", "section", "unofficial", true),
      ],
      "p",
      "2026-11-04",
      "d4-reading",
    ).complete,
    true,
  );
});
test("old articles and a different day or task cannot fill the daily new-article requirement", () => {
  const official = make("drill", "type-drill", "official", true),
    old = make("old", "section", "unofficial", false),
    wrongDay = make("other", "section", "unofficial", true);
  wrongDay.payload.date = "2026-11-03";
  assert.equal(
    readingDailyRequirements(
      [official, old, wrongDay],
      "p",
      "2026-11-04",
      "d4-reading",
    ).complete,
    false,
  );
});

// Saturday still has its existing review budget; do not hide the daily official drill.
test("days 6 and 13 keep the official drill before a new full reading paper", async () => {
  const { practiceSelection, ListeningReadingPlan } =
    await import("./ui/reading/ListeningReadingPlan");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const question = {
    id: "q1",
    type: "sentence-completion" as const,
    prompt: "A ____",
    answer: { accepted: ["record"], maxWords: 1 },
    evidence: { quote: "A record." },
    answerVerified: true,
  };
  const common = {
    version: "1",
    contentHash: "b".repeat(64),
    skill: "reading" as const,
    deliveryMode: "local-import" as const,
    source: {
      materialSource: "official" as const,
      sourceRef: "synthetic:drill",
      rights: "Self-authored test fixture",
      answerVerified: true,
    },
    passage: "A record.",
    paragraphs: [{ id: "p1", text: "A record." }],
  };
  const drill = {
    ...common,
    id: "official-drill",
    title: "Synthetic drill",
    scope: "type-drill" as const,
    questions: [question],
  };
  const full = {
    ...common,
    id: "new-full",
    title: "Synthetic full",
    scope: "full" as const,
    questions: Array.from({ length: 40 }, (_, i) => ({
      ...question,
      id: `q${i}`,
    })),
  };
  for (const day of [6, 13]) {
    assert.equal(
      practiceSelection(
        [drill, full],
        [],
        "p",
        day,
        "2026-11-14",
        "reading",
        true,
      ).preferred?.id,
      drill.id,
    );
    const html = renderToStaticMarkup(
      createElement(ListeningReadingPlan, {
        bank: [drill, full],
        records: [],
        planId: "p",
        day,
        date: "2026-11-14",
        skill: "reading",
        requiresFull: true,
        disabled: false,
        onChoose() {},
      }),
    );
    assert.match(html, /打开官方题型练习/);
  }
});
