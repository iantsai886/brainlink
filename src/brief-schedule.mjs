import { localDateAndTime } from './ingestion-schedule.mjs';

export function validateBriefSchedule(input, current = {}) {
  const enabled = Boolean(input?.enabled);
  const vault = String(input?.vault || '').trim() || null;
  const time = String(input?.time || '08:00');
  if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new Error('Choose a valid daily brief time in 24-hour format.');
  if (enabled && !vault) throw new Error('Choose one public vault before enabling scheduled briefs.');
  return { enabled, vault, time, last_scheduled_date: current.last_scheduled_date || null };
}

export function briefScheduleDue(schedule, now = new Date(), timezone) {
  if (!schedule?.enabled || !schedule.vault) return false;
  const local = localDateAndTime(now, timezone);
  return local.date !== schedule.last_scheduled_date && local.time >= schedule.time;
}
