import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dayDate, weekdayOf, templateFor } from './calendar';
const rules = JSON.parse(readFileSync(new URL('../../public/curriculum365/v1/plan-rules.json', import.meta.url), 'utf8'));
test('day one is the chosen valid civil date, including Thursday', () => { assert.equal(dayDate('2026-11-09', 'Asia/Shanghai', 1), '2026-11-09'); assert.equal(dayDate('2026-11-05', 'Asia/Shanghai', 1), '2026-11-05'); });
test('day seven is the first Sunday', () => { assert.equal(dayDate('2026-11-09', 'Asia/Shanghai', 7), '2026-11-15'); assert.equal(weekdayOf('2026-11-09', 'Asia/Shanghai', 7), 'sunday'); });
test('day fourteen is the second Sunday', () => { assert.equal(dayDate('2026-11-09', 'Asia/Shanghai', 14), '2026-11-22'); });
test('actual weekdays remain separate from the seven-training-day template cycle', () => {
  assert.equal(weekdayOf('2026-11-05', 'Asia/Shanghai', 1), 'thursday');
  assert.equal(weekdayOf('2026-11-05', 'Asia/Shanghai', 6), 'tuesday');
  assert.equal(dayDate('2026-11-05', 'Asia/Shanghai', 365), '2027-11-04');
  assert.equal(templateFor(rules, 6), 'saturday-listening-reading');
});
test('the legacy Monday calendar keeps the identical 365-day training cycle', () => {
  const legacy = { ...rules, calendar: { dayOneWeekday: 'monday', dayIndexing: 'plan-timezone-calendar-days', requireMondayStart: true } };
  for (let day = 1; day <= 365; day++) assert.equal(templateFor(rules, day), templateFor(legacy, day));
});
test('day six uses the Saturday template', () => { assert.equal(templateFor(rules, 6), 'saturday-listening-reading'); });
test('day seven uses Sunday calibration rather than the weekday trial', () => { assert.equal(templateFor(rules, 7), 'sunday-writing-speaking-calibration'); });
test('day thirteen and fourteen preserve the weekend schedule', () => { assert.equal(templateFor(rules, 13), 'saturday-listening-reading'); assert.equal(templateFor(rules, 14), 'sunday-writing-speaking-calibration'); });
test('civil day arithmetic survives daylight saving without shifting the date', () => { assert.equal(dayDate('2026-10-26', 'America/New_York', 8), '2026-11-02'); });
test('invalid dates are rejected', () => { assert.throws(() => dayDate('2026-02-30', 'Asia/Shanghai', 1), /日期/); });
test('invalid timezone is rejected', () => { assert.throws(() => dayDate('2026-11-09', 'wrong-zone', 1), /时区/); });
for (const day of [0, 366, 1.5]) test(`invalid day ${day} is rejected`, () => { assert.throws(() => dayDate('2026-11-09', 'Asia/Shanghai', day), /365/); });
