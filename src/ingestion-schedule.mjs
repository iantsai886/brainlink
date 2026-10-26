// Daily local-time schedule helpers for the on-demand Raw-to-Wiki scanner.
export const INGESTION_MAX_ATTEMPTS = 3;
export const INGESTION_RETRY_DELAY_MS = 15 * 60 * 1000;

export function validateIngestionSchedule(input, current = {}) {
  const enabled = Boolean(input?.enabled);
  const vault = String(input?.vault || '').trim() || null;
  const folder = String(input?.folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || null;
  const time = String(input?.time || '02:00');
  if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new Error('Choose a valid daily scan time in 24-hour format.');
  if (enabled && (!vault || !folder)) throw new Error('Choose a vault and one folder before enabling scheduled scans.');
  const unchanged = enabled === Boolean(current.enabled) && vault === (current.vault || null)
    && folder === (current.folder || null) && time === (current.time || '02:00');
  return {
    enabled, vault, folder, time,
    last_scheduled_date: unchanged ? current.last_scheduled_date || null : null,
    retry_count: unchanged ? Number(current.retry_count) || 0 : 0,
    retry_date: unchanged ? current.retry_date || null : null,
    retry_after: unchanged ? current.retry_after || null : null,
  };
}

export function localDateAndTime(date = new Date(), timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

export function ingestionScheduleDue(schedule, now = new Date(), timezone) {
  if (!schedule?.enabled || !schedule.vault || !schedule.folder) return false;
  const local = localDateAndTime(now, timezone);
  if (schedule.retry_date === local.date && schedule.retry_after) {
    const retryAfter = Date.parse(schedule.retry_after);
    return Number.isFinite(retryAfter) && now.getTime() >= retryAfter;
  }
  return local.date !== schedule.last_scheduled_date && local.time >= schedule.time;
}
