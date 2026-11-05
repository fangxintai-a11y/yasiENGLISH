import type { DayPlan } from "./planEngine";

export function extensivePracticeContext(
  dayPlan: DayPlan,
  tuesdayActivity: "reading" | "listening" = "reading",
): { skill: "reading" | "listening"; block: DayPlan["blocks"][number] } | null {
  const weekday = new Date(`${dayPlan.date}T00:00:00Z`).getUTCDay();
  const skill =
    weekday === 2 ? tuesdayActivity : weekday === 4 ? "listening" : null;
  if (!skill || dayPlan.state !== "active") return null;
  const block =
    dayPlan.blocks.find((item) => item.skill === skill) ??
    dayPlan.blocks.find((item) => item.id === "review");
  return block && block.minutes >= 10 ? { skill, block } : null;
}
