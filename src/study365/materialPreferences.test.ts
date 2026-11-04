import test from "node:test";
import assert from "node:assert/strict";
import type { LocalMaterial } from "./localBankSchema";
import type { AcceptedPreferences } from "./weeklyReview";
import { practiceSelection } from "./ui/reading/ListeningReadingPlan";
const make = (
  id: string,
  type: "sentence-completion" | "true-false-not-given",
  pool: "practice" | "holdout" = "practice",
): LocalMaterial => ({
  id,
  version: "1",
  contentHash: "a".repeat(64),
  skill: "reading",
  title: id,
  deliveryMode: "local-import",
  scope: "section",
  pool,
  passageNumber: 2,
  frequency: "high",
  source: {
    materialSource: "unofficial",
    sourceRef: `fixture:${id}`,
    rights: "Self-authored test fixture",
    answerVerified: true,
  },
  passage: `A unique original about ${id}.`,
  paragraphs: [{ id: "p1", text: `A unique original about ${id}.` }],
  questions: [
    {
      id: `${id}-q1`,
      type,
      prompt: "Self-authored question",
      answer: {
        accepted: [type === "true-false-not-given" ? "TRUE" : "original"],
        maxWords: 2,
      },
      evidence: { quote: "original" },
      answerVerified: true,
    },
  ],
});
const base = make("a-default", "sentence-completion"),
  target = make("z-target", "true-false-not-given");
const preferences: AcceptedPreferences = {
  questionTypes: {
    reading: ["true-false-not-given"],
    listening: [],
    writing: [],
    speaking: [],
  },
  errorCauses: { reading: [], listening: [], writing: [], speaking: [] },
  recordIds: ["accepted-last-week"],
};
test("accepted preferences change the outer daily recommendation while the original level/order remains available", () => {
  assert.equal(
    practiceSelection(
      [base, target],
      [],
      "p",
      8,
      "2026-11-16",
      "reading",
      false,
    ).practice?.id,
    base.id,
  );
  assert.equal(
    practiceSelection(
      [base, target],
      [],
      "p",
      8,
      "2026-11-16",
      "reading",
      false,
      preferences,
    ).practice?.id,
    target.id,
  );
  const empty = {
    ...preferences,
    questionTypes: { ...preferences.questionTypes, reading: [] },
    recordIds: [],
  };
  assert.equal(
    practiceSelection(
      [base, target],
      [],
      "p",
      8,
      "2026-11-16",
      "reading",
      false,
      empty,
    ).practice?.id,
    base.id,
  );
});
test("a check-pool alias cannot be promoted and full assessment stays full", () => {
  const alias = { ...target, id: "reserved-copy", pool: "holdout" as const };
  const choice = practiceSelection(
    [base, target, alias],
    [],
    "p",
    8,
    "2026-11-16",
    "reading",
    false,
    preferences,
  );
  assert.equal(choice.practice?.id, base.id);
  assert.match(choice.notice, /还缺新材料/);
  const full = {
    ...base,
    id: "full-paper",
    scope: "full" as const,
    questions: Array.from({ length: 40 }, (_, i) => ({
      ...base.questions[0],
      id: `f${i}`,
      number: i + 1,
    })),
  };
  assert.equal(
    practiceSelection(
      [base, target, full],
      [],
      "p",
      8,
      "2026-11-16",
      "reading",
      true,
      preferences,
    ).practice?.id,
    full.id,
  );
});
test("normal reading with no preference never defaults to a heldout original body or exam alias", () => {
  const bodyReserved = {
    ...base,
    id: "reserved-body",
    pool: "holdout" as const,
  };
  const bodyChoice = practiceSelection(
    [base, target, bodyReserved],
    [],
    "p",
    8,
    "2026-11-16",
    "reading",
    false,
  );
  assert.equal(bodyChoice.practice?.id, target.id);
  assert.equal(bodyChoice.preferred?.id, target.id);
  assert.equal(
    bodyChoice.schedule.days.some((day) => day.reading?.id === base.id),
    false,
  );
  const examBase = { ...base, examId: "RESERVED-EXAM" },
    examReserved = {
      ...make("reserved-exam", "true-false-not-given", "holdout"),
      examId: "RESERVED-EXAM",
    };
  assert.equal(
    practiceSelection(
      [examBase, target, examReserved],
      [],
      "p",
      8,
      "2026-11-16",
      "reading",
      false,
    ).practice?.id,
    target.id,
  );
});
test("normal official drills cannot expose a heldout body alias before daily reading", () => {
  const official = {
      ...base,
      id: "official-drill",
      scope: "type-drill" as const,
      source: { ...base.source, materialSource: "official" as const },
    },
    reserved = {
      ...official,
      id: "reserved-official",
      pool: "holdout" as const,
    };
  const choice = practiceSelection(
    [official, target, reserved],
    [],
    "p",
    8,
    "2026-11-16",
    "reading",
    false,
  );
  assert.equal(choice.official, null);
  assert.equal(choice.preferred?.id, target.id);
  assert.equal(
    choice.schedule.days.some((day) => day.readingOfficial?.id === official.id),
    false,
  );
});
