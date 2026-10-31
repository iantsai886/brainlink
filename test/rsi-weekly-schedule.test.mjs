import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WEEKLY_BENCHMARK_SCHEDULE, validateWeeklyBenchmarkSchedule, weeklyBenchmarkScheduleDue, weeklyScheduleWeek } from '../src/rsi-weekly-schedule.mjs';

test('weekly benchmark schedule defaults off and validates only the supported settings', () => {
  assert.equal(DEFAULT_WEEKLY_BENCHMARK_SCHEDULE.enabled, false);
  assert.deepEqual(validateWeeklyBenchmarkSchedule({ enabled: true, weekday: 5, time: '14:30' }), {
    enabled: true, weekday: 5, time: '14:30', last_scheduled_week: null, last_run_at: null, last_run_ok: null,
  });
  assert.throws(() => validateWeeklyBenchmarkSchedule({ enabled: 'yes' }), /enabled/);
  assert.throws(() => validateWeeklyBenchmarkSchedule({ weekday: 7 }), /weekday/);
  assert.throws(() => validateWeeklyBenchmarkSchedule({ time: '24:00' }), /time/);
  assert.throws(() => validateWeeklyBenchmarkSchedule({ unknown: true }), /Unknown weekly benchmark setting/);
});

test('weekly benchmark schedule is local-time, once per ISO week, and respects disablement', () => {
  const schedule = { enabled: true, weekday: 1, time: '09:00', last_scheduled_week: null };
  const mondayBefore = new Date('2026-10-26T00:30:00.000Z'); // 08:30 Monday in Taipei
  const mondayDue = new Date('2026-10-26T01:00:00.000Z'); // 09:00 Monday in Taipei
  assert.equal(weeklyBenchmarkScheduleDue(schedule, mondayBefore, 'Asia/Taipei'), false);
  assert.equal(weeklyBenchmarkScheduleDue(schedule, mondayDue, 'Asia/Taipei'), true);
  const week = weeklyScheduleWeek(mondayDue, 'Asia/Taipei');
  assert.equal(week, '2026-W44');
  assert.equal(weeklyBenchmarkScheduleDue({ ...schedule, last_scheduled_week: week, last_run_ok: true }, mondayDue, 'Asia/Taipei'), false);
  assert.equal(weeklyBenchmarkScheduleDue({ ...schedule, last_scheduled_week: week, last_run_ok: null }, mondayDue, 'Asia/Taipei'), true, 'an interrupted run can retry after restart');
  assert.equal(weeklyBenchmarkScheduleDue({ ...schedule, last_scheduled_week: week, last_run_ok: false }, mondayDue, 'Asia/Taipei'), false, 'a completed failed attempt is not retried continuously');
  assert.equal(weeklyBenchmarkScheduleDue({ ...schedule, enabled: false }, mondayDue, 'Asia/Taipei'), false);
  assert.equal(weeklyBenchmarkScheduleDue(schedule, new Date('2026-10-27T02:00:00.000Z'), 'Asia/Taipei'), false);
});

test('editing a weekly benchmark schedule resets only the scheduled-week marker', () => {
  const previous = { enabled: true, weekday: 1, time: '09:00', last_scheduled_week: '2026-W44', last_run_at: '2026-10-26T01:00:00.000Z', last_run_ok: true };
  assert.equal(validateWeeklyBenchmarkSchedule({ enabled: true, weekday: 1, time: '09:00' }, previous).last_scheduled_week, '2026-W44');
  const changed = validateWeeklyBenchmarkSchedule({ enabled: true, weekday: 2, time: '09:00' }, previous);
  assert.equal(changed.last_scheduled_week, null);
  assert.equal(changed.last_run_at, previous.last_run_at);
  assert.equal(changed.last_run_ok, true);
});
