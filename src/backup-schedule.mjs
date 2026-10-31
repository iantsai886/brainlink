import { localDateAndTime } from './ingestion-schedule.mjs';

const validTime = (time) => /^\d{2}:\d{2}$/.test(time) && Number(time.slice(0, 2)) <= 23 && Number(time.slice(3)) <= 59;

export function normalizeBackupSchedule(input = {}, current = {}) {
  const scheduleMode = String(input.scheduleMode ?? current.scheduleMode ?? 'interval');
  const intervalHours = Number(input.intervalHours ?? current.intervalHours ?? 24);
  const time = String(input.time ?? current.time ?? '02:00');
  if (!['interval', 'daily'].includes(scheduleMode)) throw new Error('Choose an interval or daily backup schedule.');
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) throw new Error('Backup interval must be from 1 to 168 hours.');
  if (!validTime(time)) throw new Error('Choose a valid daily backup time in 24-hour format.');
  const last_scheduled_date = input.last_scheduled_date ?? current.last_scheduled_date ?? null;
  if (last_scheduled_date !== null) {
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(last_scheduled_date) ? new Date(`${last_scheduled_date}T00:00:00.000Z`) : null;
    if (!parsedDate || !Number.isFinite(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== last_scheduled_date) throw new Error('The last scheduled backup date is invalid.');
  }
  return { scheduleMode, intervalHours, time, last_scheduled_date };
}

export function backupScheduleDue(schedule, now = new Date(), timezone) {
  if (!schedule?.enabled || schedule.scheduleMode !== 'daily') return false;
  if (!validTime(String(schedule.time || ''))) return false;
  const local = localDateAndTime(now, timezone);
  return local.date !== schedule.last_scheduled_date && local.time >= schedule.time;
}
