import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings } from "../store/store";
import { dayDate } from "./calendar";
import { bundledRules } from "./planData";
import { buildDayPlan } from "./planEngine";
import { vocabularySettings } from "./vocabularyBudget";
const plan = { startDate: "2026-11-09", timeZone: "Asia/Shanghai" };
test("all planned vocabulary budgets use a settings copy and leave saved minutes untouched", () => {
  const settings = Object.freeze({ ...defaultSettings, dailyMinutes: 45 });
  for (let day = 1; day <= bundledRules.goal.durationDays; day++) {
    const value = buildDayPlan(bundledRules, plan, dayDate(plan.startDate, plan.timeZone, day));
    const effective = vocabularySettings(settings, value);
    assert.equal(effective.dailyMinutes, value.blocks.find((block) => block.id === "vocabulary")?.minutes ?? 0);
    assert.equal(settings.dailyMinutes, 45);
    assert.notEqual(effective, settings);
  }
});
test("without an enabled plan the old vocabulary settings are used", () => {
  const settings = { ...defaultSettings, dailyMinutes: 45 };
  assert.equal(vocabularySettings(settings, null), settings);
});
