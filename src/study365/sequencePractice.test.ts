import test from "node:test";
import assert from "node:assert/strict";
import type { LocalMaterial } from "./localBankSchema";
import type { Revision } from "./protocol";
import type { AcceptedPreferences } from "./weeklyReview";
import {
  withListeningSequences,
  isListeningSequenceMaterial,
} from "./listeningSequence";
import { unseenListeningReading } from "./retestSelection";
import { preferPracticeMaterial } from "./materialPreferences";
import { practiceSelection } from "./ui/reading/ListeningReadingPlan";
function part(section: 1 | 2 | 3 | 4): LocalMaterial {
  const multiple = section === 2,
    transcript = `Self-authored original part ${section}: volunteers report activity${section} at a fictional centre.`;
  return {
    id: `qa-part-${section}`,
    version: "1",
    contentHash: String(section).repeat(64),
    title: `QA original part ${["one", "two", "three", "four"][section - 1]}`,
    examId: "QA-EXAM-1",
    skill: "listening",
    section,
    scope: "section",
    pool: "practice",
    deliveryMode: "local-import",
    source: {
      materialSource: "unofficial",
      sourceRef: `synthetic:QA-EXAM-1-${section}`,
      rights: "Self-authored synthetic fixture, not actual exam material.",
      answerVerified: true,
    },
    transcript,
    audio: {
      path: `audio/qa-part-${section}.wav`,
      durationSeconds: 1,
      sha256: String(section).repeat(64),
    },
    questions: Array.from({ length: 10 }, (_, i) => ({
      id: `qa-q${(section - 1) * 10 + i + 1}`,
      number: (section - 1) * 10 + i + 1,
      type: multiple ? "multiple-choice" : "sentence-completion",
      prompt: "A self-authored synthetic question.",
      answer: {
        accepted: [multiple ? "A" : `activity${section}`],
        maxWords: 1,
      },
      ...(multiple
        ? {
            options: [
              { id: "A", text: "A local activity" },
              { id: "B", text: "A distant activity" },
            ],
          }
        : {}),
      evidence: { quote: `activity${section}` },
      answerVerified: true,
    })),
  };
}
async function bank() {
  return withListeningSequences(([1, 2, 3, 4] as const).map(part));
}
const preferences: AcceptedPreferences = {
  questionTypes: {
    listening: ["multiple-choice"],
    reading: [],
    writing: [],
    speaking: [],
  },
  errorCauses: { listening: [], reading: [], writing: [], speaking: [] },
  recordIds: ["accepted-last-week"],
};
function attempt(
  material: LocalMaterial,
  index = 1,
  score = material.questions.length,
  partial = false,
): Revision {
  return {
    id: `qa-work-${index}`,
    kind: "attempt",
    planId: "p",
    datasetId: null,
    revisionId: `a7000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    baseRevision: null,
    seq: index,
    createdAt: index,
    conflict: false,
    deleted: false,
    contentHash: "a".repeat(64),
    payload: {
      planId: "p",
      date: "2026-11-10",
      contentId: material.id,
      contentVersion: material.version,
      contentHash: material.contentHash,
      skill: material.skill,
      materialSource: material.source.materialSource,
      sourceRef: material.source.sourceRef,
      scope: material.scope,
      firstAttempt: true,
      answers: material.questions.map((q, i) =>
        i < score ? q.answer.accepted[0] : "wrong",
      ),
      ...(!partial
        ? { reviewAnswers: material.questions.map((q) => q.answer.accepted[0]) }
        : {}),
      score,
      correct: score,
      total: material.questions.length,
      conditions: { sequential: isListeningSequenceMaterial(material) },
      questionResults: material.questions.flatMap<Record<string, unknown>>(
        (q, i) =>
          partial
            ? i < score
              ? [
                  {
                    questionId: q.id,
                    correct: true,
                    confidence: "unsure",
                    errorCause: null,
                  },
                ]
              : []
            : [
                {
                  questionId: q.id,
                  correct: i < score,
                  reviewCorrect: true,
                  confidence: "sure",
                  errorCause: i < score ? null : "vocab-unknown",
                },
              ],
      ),
    },
  };
}
test("deriving a virtual full keeps all four original sections in the normal daily schedule", async () => {
  const all = await bank(),
    before = JSON.stringify(all),
    choice = practiceSelection(
      all,
      [],
      "p",
      1,
      "2026-11-09",
      "listening",
      false,
    );
  assert.equal(choice.schedule.days.filter((day) => !!day.listening).length, 4);
  assert.equal(choice.practice?.id, "qa-part-1");
  assert.equal(JSON.stringify(all), before);
});
test("a full assessment prefers the valid four-part sequence even when an ordinary full recording occurs first", async () => {
  const all = await bank(),
    sequence = all.find(isListeningSequenceMaterial)!;
  const single = {
    ...sequence,
    id: "ordinary-full",
    version: "1",
    examId: "OTHER-EXAM",
    audio: {
      path: "audio/ordinary-full.wav",
      durationSeconds: 4,
      sha256: "9".repeat(64),
    },
  } as LocalMaterial;
  const choice = practiceSelection(
    [single, ...all],
    [],
    "p",
    6,
    "2026-11-14",
    "listening",
    true,
  );
  assert.equal(choice.practice?.id, sequence.id);
  assert.equal(
    choice.practice && isListeningSequenceMaterial(choice.practice),
    true,
  );
});
test("accepted normal preferences may select a real leaf without reserving it merely because a virtual full exists", async () => {
  const all = await bank(),
    base = all.find((m) => m.id === "qa-part-1")!,
    choice = preferPracticeMaterial(
      base,
      all,
      [],
      "p",
      "listening",
      preferences,
    );
  assert.equal(choice.material?.id, "qa-part-2");
  assert.deepEqual(choice.missingTypes, []);
});
test("a completed full sequence makes all exact source leaves already seen rather than fresh daily/retest material", async () => {
  const all = await bank(),
    sequence = all.find(isListeningSequenceMaterial)!,
    work = attempt(sequence);
  for (const leaf of all.filter((m) => m.scope === "section"))
    assert.equal(unseenListeningReading(leaf, [work], all, "p"), false);
  assert.equal(
    practiceSelection(all, [work], "p", 1, "2026-11-09", "listening", false)
      .practice,
    null,
  );
  assert.equal(
    preferPracticeMaterial(null, all, [work], "p", "listening", preferences)
      .material,
    null,
  );
});
test("a section already practised cannot silently become an unseen full-sequence assessment", async () => {
  const all = await bank(),
    leaf = all.find((m) => m.id === "qa-part-1")!,
    work = attempt(leaf);
  assert.equal(
    practiceSelection(all, [work], "p", 6, "2026-11-14", "listening", true)
      .practice,
    null,
  );
});
function reading(id: string, level: 1 | 2): LocalMaterial {
  const passage = `A distinct self-authored original about ${id}.`;
  return {
    id,
    version: "1",
    contentHash: id.charCodeAt(0).toString(16).padStart(64, "0"),
    title: id,
    skill: "reading",
    scope: "section",
    pool: "practice",
    passageNumber: level,
    deliveryMode: "local-import",
    source: {
      materialSource: "unofficial",
      sourceRef: `synthetic:${id}`,
      rights: "Self-authored synthetic fixture.",
      answerVerified: true,
    },
    passage,
    paragraphs: [{ id: "p1", text: passage }],
    questions: Array.from({ length: 10 }, (_, i) => ({
      id: `${id}-q${i}`,
      number: i + 1,
      type: "sentence-completion",
      prompt: "A synthetic question.",
      answer: { accepted: ["original"], maxWords: 1 },
      evidence: { quote: "original" },
      answerVerified: true,
    })),
  };
}
test("three correct-only 50-percent first snapshots retain the original reading level instead of advancing on their true rows", () => {
  const originals = [
      reading("old-alpha", 1),
      reading("old-beta", 1),
      reading("old-gamma", 1),
    ],
    next = reading("new-level-one", 1),
    harder = reading("new-level-two", 2),
    records = originals.map((m, i) => attempt(m, i + 1, 5, true)),
    before = JSON.stringify(records);
  const choice = practiceSelection(
    [...originals, next, harder],
    records,
    "p",
    4,
    "2026-11-12",
    "reading",
    false,
  );
  assert.equal(choice.practice?.id, next.id);
  assert.match(choice.notice, /50%/);
  assert.equal(JSON.stringify(records), before);
});
test("completed B results still allow the original three-strong-attempt reading advance", () => {
  const originals = [
      reading("old-alpha", 1),
      reading("old-beta", 1),
      reading("old-gamma", 1),
    ],
    next = reading("new-level-one", 1),
    harder = reading("new-level-two", 2),
    records = originals.map((m, i) => attempt(m, i + 1, 9));
  assert.equal(
    practiceSelection(
      [...originals, next, harder],
      records,
      "p",
      4,
      "2026-11-12",
      "reading",
      false,
    ).practice?.id,
    harder.id,
  );
});
test("two virtual full sequences with different exams and no single audio never share an undefined audio identity", async () => {
  const a = ([1, 2, 3, 4] as const).map(part),
    b = ([1, 2, 3, 4] as const).map((section) => {
      const original = part(section);
      return {
        ...original,
        id: `other-part-${section}`,
        examId: "QA-EXAM-2",
        contentHash: String(section + 4).repeat(64),
        transcript: `A separate original exam account for other part ${section} mentions activity${section}.`,
        audio: {
          path: `audio/other-part-${section}.wav`,
          durationSeconds: 1,
          sha256: String(section + 4).repeat(64),
        },
      } as LocalMaterial;
    }),
    all = await withListeningSequences([...a, ...b]),
    first = all.find(
      (m) => isListeningSequenceMaterial(m) && m.examId === "QA-EXAM-1",
    )!,
    next = all.find(
      (m) => isListeningSequenceMaterial(m) && m.examId === "QA-EXAM-2",
    )!,
    work = attempt(first);
  assert.equal(unseenListeningReading(next, [work], all, "p"), true);
  assert.equal(
    practiceSelection(all, [work], "p", 6, "2026-11-14", "listening", true)
      .practice?.id,
    next.id,
  );
});
