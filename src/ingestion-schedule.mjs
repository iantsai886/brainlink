// Daily local-time schedule helpers for the on-demand Raw-to-Wiki scanner.
export const INGESTION_MAX_ATTEMPTS = 3;
export const INGESTION_RETRY_DELAY_MS = 15 * 60 * 1000;

export function normalizeIngestionTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) throw new Error('Scan folders must be a list.');
  if (rawTargets.length > 20) throw new Error('Choose no more than 20 scan folders.');
  const targets = rawTargets.map((target) => ({
    vault: String(target?.vault || '').trim(),
    folder: String(target?.folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  }));
  if (targets.some((target) => !target.vault || !target.folder || target.folder.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')))) {
    throw new Error('Each scan folder needs a vault and a safe folder path.');
  }
  const keys = targets.map((target) => `${target.vault.toLowerCase()}\0${target.folder.toLowerCase()}`);
  if (new Set(keys).size !== keys.length) throw new Error('A scan folder can only be added once.');
  return targets;
}

export function validateIngestionSchedule(input, current = {}) {
  const enabled = Boolean(input?.enabled);
  const legacyTarget = input?.vault && input?.folder ? [{ vault: input.vault, folder: input.folder }] : [];
  const targets = normalizeIngestionTargets(input?.targets !== undefined ? input.targets : legacyTarget);
  const vault = targets[0]?.vault || null;
  const folder = targets[0]?.folder || null;
  const time = String(input?.time || '02:00');
  if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new Error('Choose a valid daily scan time in 24-hour format.');
  if (enabled && !targets.length) throw new Error('Add at least one vault folder before enabling scheduled scans.');
  const priorTargets = Array.isArray(current.targets) ? current.targets : current.vault && current.folder ? [{ vault: current.vault, folder: current.folder }] : [];
  const unchanged = enabled === Boolean(current.enabled) && JSON.stringify(targets) === JSON.stringify(priorTargets)
    && time === (current.time || '02:00');
  return {
    enabled, vault, folder, targets, time,
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
  const hasTargets = Array.isArray(schedule?.targets) ? schedule.targets.length > 0 : Boolean(schedule?.vault && schedule?.folder);
  if (!schedule?.enabled || !hasTargets) return false;
  const local = localDateAndTime(now, timezone);
  if (schedule.retry_date === local.date && schedule.retry_after) {
    const retryAfter = Date.parse(schedule.retry_after);
    return Number.isFinite(retryAfter) && now.getTime() >= retryAfter;
  }
  return local.date !== schedule.last_scheduled_date && local.time >= schedule.time;
}
