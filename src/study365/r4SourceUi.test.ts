import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Revision } from "./protocol";
import { ScoreBook } from "./ui/ScoreBook";
import { TaskRegistration } from "./ui/TaskRegistration";
import { buildDayPlan } from "./planEngine";
import { bundledRules } from "./planData";
import { dayDate } from "./calendar";
import { extensivePracticeContext } from "./extensivePracticeModel";

const record = (
  kind: Revision["kind"],
  payload: Record<string, unknown>,
  id: string,
): Revision => ({
  kind,
  payload,
  id,
  planId: "plan-a",
  datasetId: null,
  revisionId: crypto.randomUUID(),
  baseRevision: null,
  seq: 1,
  createdAt: 1,
  contentHash: "a".repeat(64),
  deleted: false,
  conflict: false,
  payloadVersion: 2,
});
const assessment = record(
  "assessment",
  {
    planId: "plan-a",
    date: "2026-11-09",
    kind: "weekly-mock",
    source: "self",
    materialId: "external-paper",
    scores: { listening: null, reading: 7.5, writing: null, speaking: null },
    scoreSources: {
      listening: null,
      reading: "self",
      writing: null,
      speaking: null,
    },
  },
  "scores",
);
const attempt = (source: string | undefined) =>
  record(
    "attempt",
    {
      planId: "plan-a",
      date: "2026-11-09",
      skill: "reading",
      contentId: "external-paper",
      sourceRef: "External paper",
      ...(source ? { materialSource: source } : {}),
      scope: "full",
      score: 37,
      correct: 37,
      total: 40,
      answers: [],
    },
    "attempt",
  );
test("ScoreBook uses same-sitting external Cambridge evidence without inventing hashes or question answers", () => {
  const html = renderToStaticMarkup(
    createElement(ScoreBook, {
      planId: "plan-a",
      records: [assessment, attempt("cambridge")],
    }),
  );
  assert.match(html, /<li>阅读[^<]*7\.5[^<]*差距 1\.0/);
  assert.match(html, /剑桥/);
  assert.doesNotMatch(html, /阅读仅作参考/);
});
test("ScoreBook keeps unofficial and unclassified listening/reading visibly reference-only", () => {
  for (const source of ["unofficial", "publisher", undefined]) {
    const html = renderToStaticMarkup(
      createElement(ScoreBook, {
        planId: "plan-a",
        records: [assessment, attempt(source)],
      }),
    );
    assert.match(html, /阅读仅作参考/);
    assert.match(html, /差距 未评估/);
  }
});
test("external task registration asks for explicit material source and scope with an honest unofficial default", () => {
  const plan = record(
    "plan",
    { planId: "plan-a", startDate: "2026-11-09", timeZone: "Asia/Shanghai" },
    "plan-a",
  );
  const dayPlan = buildDayPlan(bundledRules, plan.payload, "2026-11-10");
  const block = dayPlan.blocks[0];
  const html = renderToStaticMarkup(
    createElement(TaskRegistration, {
      plan,
      dayPlan,
      block,
      selectedSkill: "reading",
    }),
  );
  assert.match(html, /aria-label="登记材料来源"/);
  assert.match(html, /value="unofficial" selected/);
  assert.match(html, /aria-label="登记材料范围"/);
});
for (const day of [2, 305])
  test(`day ${day} extensive practice uses the existing review budget without stealing another subject`, () => {
    const plan = record(
      "plan",
      { planId: "plan-a", startDate: "2026-11-09", timeZone: "Asia/Shanghai" },
      "plan-a",
    );
    const dayPlan = buildDayPlan(
      bundledRules,
      plan.payload,
      dayDate("2026-11-09", "Asia/Shanghai", day),
    );
    const original = JSON.stringify(dayPlan),
      context = extensivePracticeContext(dayPlan);
    assert.equal(context?.block.id, "review");
    assert.equal(context.block.skill, null);
    assert.equal(
      dayPlan.blocks.reduce((sum, b) => sum + b.minutes, 0),
      120,
    );
    assert.equal(JSON.stringify(dayPlan), original);
  });

test("Tuesday BBC uses listening or review while the default article still uses reading", () => {
  const plan = record(
    "plan",
    { planId: "plan-a", startDate: "2026-11-09", timeZone: "Asia/Shanghai" },
    "plan-a",
  );
  for (const day of [2, 9]) {
    const dayPlan = buildDayPlan(
        bundledRules,
        plan.payload,
        dayDate("2026-11-09", "Asia/Shanghai", day),
      ),
      before = JSON.stringify(dayPlan);
    const article = extensivePracticeContext(dayPlan),
      bbc = extensivePracticeContext(dayPlan, "listening");
    assert.equal(article?.skill, "reading");
    assert.equal(bbc?.skill, "listening");
    assert.equal(bbc?.block.id, day === 2 ? "review" : "listening");
    assert.equal(bbc?.block.skill, day === 2 ? null : "listening");
    assert.equal(
      dayPlan.blocks.reduce((sum, block) => sum + block.minutes, 0),
      120,
    );
    assert.equal(JSON.stringify(dayPlan), before);
  }
});
