// Daily local-time schedule helpers for the on-demand Raw-to-Wiki scanner.
export function validateIngestionSchedule(input, current = {}) {
  const enabled = Boolean(input?.enabled);
  const vault = String(input?.vault || '').trim() || null;
  const folder = String(input?.folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || null;
  const time = String(input?.time || '02:00');
  if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new Error('Choose a valid daily scan time in 24-hour format.');
  if (enabled && (!vault || !folder)) throw new Error('Choose a vault and one folder before enabling scheduled scans.');
  return { enabled, vault, folder, time, last_scheduled_date: current.last_scheduled_date || null };
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
  return local.date !== schedule.last_scheduled_date && local.time >= schedule.time;
}
