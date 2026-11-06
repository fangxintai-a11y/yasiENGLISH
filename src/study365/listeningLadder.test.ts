import test from "node:test";
import assert from "node:assert/strict";
import type { LocalMaterial } from "./localBankSchema";
import {
  LISTENING_METHOD_CARDS,
  ladderNotice,
  listeningSectionForDay,
  methodCardFor,
  preferSection,
} from "./listeningLadder";
import { buildListeningReadingSchedule } from "./listeningReadingSchedule";

function section(index: number, sectionNumber?: 1 | 2 | 3 | 4): LocalMaterial {
  return {
    id: `listening-s${sectionNumber ?? 0}-${index}`,
    version: "1",
    title: `Synthetic listening ${"xabcd"[sectionNumber ?? 0]} ${String.fromCharCode(97 + index)}`,
    skill: "listening",
    scope: "section",
    deliveryMode: "local-import",
    contentHash: "a".repeat(64),
    pool: "practice",
    source: {
      materialSource: "cambridge",
      sourceRef: `synthetic:${sectionNumber}:${index}`,
      rights: "Self-authored fixture",
      answerVerified: true,
    },
    questions: [
      {
        id: "q1",
        type: "note-completion",
        prompt: "Synthetic.",
        answer: { accepted: ["a"], maxWords: 2 },
        evidence: {},
        answerVerified: true,
      },
    ],
    transcript: "Synthetic transcript.",
    ...(sectionNumber ? { section: sectionNumber } : {}),
    audio: { path: `audio/s${sectionNumber}-${index}.mp3`, durationSeconds: 300 },
  } as LocalMaterial;
}

test("days 1-20 climb Section 1 to 4 in five-day stages, then a weekly mix weighted to S3/S4", () => {
  assert.deepEqual(
    Array.from({ length: 20 }, (_, i) => listeningSectionForDay(i + 1)),
    [...Array(5).fill(1), ...Array(5).fill(2), ...Array(5).fill(3), ...Array(5).fill(4)],
  );
  const week = Array.from({ length: 7 }, (_, i) => listeningSectionForDay(21 + i));
  assert.deepEqual([...week].sort(), [1, 2, 3, 3, 4, 4, 4]);
  assert.equal(listeningSectionForDay(0), 1);
  assert.equal(listeningSectionForDay(365), listeningSectionForDay(365 - 7));
});

test("exact Section wins; when exhausted, the nearest easier Section is used before a harder one", () => {
  const pool = [section(1, 1), section(2, 4), section(3, 2)];
  assert.equal(preferSection(pool, 2).items[0].id, pool[2].id);
  const fallback = preferSection([section(1, 1), section(2, 4)], 3);
  assert.equal(fallback.section, 4, "S4 (+1) beats S1 (-2)");
  assert.equal(preferSection([section(1, 2), section(2, 4)], 3).section, 2, "easier wins a tie in distance");
  assert.equal(preferSection([section(1), section(2, 4)], 1).section, 4, "untagged material is last");
  assert.equal(preferSection([], 1).items.length, 0);
});

test("ladder notice explains the stage and any fallback", () => {
  assert.match(ladderNotice(3, 1), /Section 1/);
  assert.doesNotMatch(ladderNotice(3, 1), /临时改用/);
  assert.match(ladderNotice(12, 2), /Section 3 新材料已用完，临时改用最接近的 Section 2/);
});

test("method card follows the material's own Section, else the day's stage", () => {
  assert.equal(methodCardFor(section(1, 3), 1).section, 3);
  assert.equal(methodCardFor(section(1), 17).section, 4);
  assert.equal(methodCardFor(null, 7).section, 2);
  for (const card of Object.values(LISTENING_METHOD_CARDS)) {
    assert.ok(card.focus.length && card.before.length && card.traps.length && card.review.length);
  }
});

test("14-day schedule follows the Section ladder instead of plain inventory order", () => {
  const pool = [
    ...Array.from({ length: 4 }, (_, i) => section(i, 4)),
    ...Array.from({ length: 5 }, (_, i) => section(i, 3)),
    ...Array.from({ length: 5 }, (_, i) => section(i, 2)),
    ...Array.from({ length: 5 }, (_, i) => section(i, 1)),
  ];
  const days = buildListeningReadingSchedule(pool).days;
  const got = days.map((day) => pool.find((item) => item.id === day.listening?.id)?.skill === "listening"
    ? (pool.find((item) => item.id === day.listening?.id) as { section?: number }).section
    : undefined);
  assert.deepEqual(got, [...Array(5).fill(1), ...Array(5).fill(2), ...Array(4).fill(3)]);
  assert.equal(new Set(days.map((day) => day.listening?.id)).size, 14);
});
