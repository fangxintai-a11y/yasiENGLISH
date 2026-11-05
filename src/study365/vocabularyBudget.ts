import type { Settings } from "../store/store";
import { vocabMinutesFor, type DayPlan } from "./planEngine";

/** A call-time view for the vocabulary engine; the saved settings stay intact. */
export function vocabularySettings(settings: Settings, dayPlan: DayPlan | null): Settings {
  if (!dayPlan) return settings;
  const minutes = vocabMinutesFor(dayPlan);
  return { ...settings, dailyMinutes: minutes, ...(minutes === 0 ? { dailyNew: 0 } : {}) };
}
