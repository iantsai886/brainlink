// Optional weekly schedule for the fixed, fictional retrieval benchmark.
import { isoWeek } from './rsi-weekly.mjs';
import { localDateAndTime } from './ingestion-schedule.mjs';

export const DEFAULT_WEEKLY_BENCHMARK_SCHEDULE = Object.freeze({
  enabled: false,
  weekday: 1,
  time: '09:00',
  last_scheduled_week: null,
  last_run_at: null,
  last_run_ok: null,
});

const isClock = (value) => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)
  && Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59;

export function validateWeeklyBenchmarkSchedule(input, previous = DEFAULT_WEEKLY_BENCHMARK_SCHEDULE) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Weekly benchmark schedule must be an object.');
  const enabled = input.enabled ?? previous.enabled;
  const weekday = input.weekday ?? previous.weekday;
  const time = input.time ?? previous.time;
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('weekday must be a number from 0 (Sunday) to 6 (Saturday).');
  if (!isClock(time)) throw new Error('Choose a valid weekly benchmark time in 24-hour format.');
  for (const key of Object.keys(input)) if (!['enabled', 'weekday', 'time'].includes(key)) throw new Error(`Unknown weekly benchmark setting: ${key}.`);
  const changed = enabled !== previous.enabled || weekday !== previous.weekday || time !== previous.time;
  return {
    enabled, weekday, time,
    last_scheduled_week: changed ? null : previous.last_scheduled_week ?? null,
    last_run_at: previous.last_run_at ?? null,
    last_run_ok: typeof previous.last_run_ok === 'boolean' ? previous.last_run_ok : null,
  };
}

export function weeklyBenchmarkScheduleDue(schedule, now = new Date(), timezone) {
  if (!schedule?.enabled) return false;
  const local = localDateAndTime(now, timezone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, weekday: 'short' }).format(now);
  const weekdayNumber = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[weekday];
  if (weekdayNumber !== schedule.weekday || local.time < schedule.time) return false;
  const week = weeklyScheduleWeek(now, timezone);
  return schedule.last_scheduled_week !== week || schedule.last_run_ok == null;
}

export function weeklyScheduleWeek(now = new Date(), timezone) {
  const local = localDateAndTime(now, timezone);
  return isoWeek(new Date(`${local.date}T12:00:00.000Z`));
}

