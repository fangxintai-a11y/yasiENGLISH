const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
function checkDay(day: number) {
  if (!Number.isInteger(day) || day < 1 || day > 365) throw new Error('计划日必须为1至365的整数。');
}
// Constructing Intl.DateTimeFormat is costly; the year-long planner validates
// the same zone hundreds of times per render. Cache only successful checks.
const validZones = new Set<string>();
function startCivilDate(startDate: string, timeZone: string) {
  if (!validZones.has(timeZone)) {
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new Error('计划时区无效。'); }
    validZones.add(timeZone);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('计划开始日期无效。');
  const date = new Date(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== startDate) throw new Error('计划开始日期无效。');
  return date;
}
/** startDate is a civil date in timeZone, not an instant in the host timezone.
 * UTC fields perform civil arithmetic without introducing DST-hour offsets. */
export function dayDate(startDate: string, timeZone: string, day: number): string {
  checkDay(day);
  const date = startCivilDate(startDate, timeZone);
  date.setUTCDate(date.getUTCDate() + day - 1);
  return date.toISOString().slice(0, 10);
}
export function weekdayOf(startDate: string, timeZone: string, day: number) {
  return weekdays[new Date(`${dayDate(startDate, timeZone, day)}T00:00:00Z`).getUTCDay()];
}
interface Rules {
  calendar?: { dayOneWeekday: string; dayIndexing: string; requireMondayStart: boolean; weeklyCycle?: string };
  baseline: { trialDays: number[]; trialTemplate: string };
  phases: { id: string; startDay: number; endDay: number; weekdayTemplate?: string }[];
  weeklySchedule: { saturdayTemplate: string; sundayTemplate: string; phase4WeekdayOverrides: Record<string, string> };
}
/** Day 1 begins a seven-training-day cycle, independently of the real weekday.
 * Keep the legacy Monday declaration readable; its training sequence is identical. */
export function templateFor(rules: Rules, day: number): string {
  checkDay(day);
  const calendar = rules.calendar;
  const legacyMonday = calendar?.dayOneWeekday === 'monday' && calendar.requireMondayStart === true;
  const flexibleStart = calendar?.dayOneWeekday === 'any' && calendar.requireMondayStart === false && calendar.weeklyCycle === 'seven-plan-days';
  if (calendar?.dayIndexing !== 'plan-timezone-calendar-days' || !(legacyMonday || flexibleStart))
    throw new Error('计划日历须按计划时区计日，并明确七个训练日的周期。');
  if (day === 1) return 'baseline-listening-reading';
  if (day === 2) return 'baseline-writing';
  if (day === 3) return 'baseline-speaking';
  const weekday = weekdays[day % 7];
  if (weekday === 'saturday') return rules.weeklySchedule.saturdayTemplate;
  if (weekday === 'sunday') return rules.weeklySchedule.sundayTemplate;
  if (rules.baseline.trialDays.includes(day)) return rules.baseline.trialTemplate;
  const phase = rules.phases.find((value) => day >= value.startDay && day <= value.endDay);
  if (phase?.id === 'phase4' && rules.weeklySchedule.phase4WeekdayOverrides[weekday]) return rules.weeklySchedule.phase4WeekdayOverrides[weekday];
  if (!phase?.weekdayTemplate) throw new Error('当天没有对应的训练模板。');
  return phase.weekdayTemplate;
}
