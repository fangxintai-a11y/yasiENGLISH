import { useMemo } from "react";
import { useStore } from "../store/store";
import { useActivePlan } from "./useActivePlan";
import { vocabularySettings } from "./vocabularyBudget";

export function useVocabularyBudget() {
  const stored = useStore((state) => state.settings);
  const { learning, plan, dayPlan } = useActivePlan();
  const settings = useMemo(() => vocabularySettings(stored, dayPlan), [stored, dayPlan]);
  return { settings, minutes: settings.dailyMinutes, managed: !!plan && !!dayPlan, ready: learning.ready,
    state: dayPlan?.state ?? null, startDate: plan?.payload.startDate ?? null };
}
