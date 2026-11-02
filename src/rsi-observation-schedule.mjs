// Optional recurring RSI observation. It stores only the aggregate report produced from
// BrainLink's content-free local activity log; it never stores raw events or note content.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzeActivitySignals, attachRetrievalObservationSignals, compareVaultHealth, sanitizeVaultHealthSnapshot } from './rsi-observations.mjs';

export const DEFAULT_OBSERVATION_SETTINGS = Object.freeze({ enabled: false, interval_hours: 168, vault_health_enabled: false, vault_health_vault: '' });

export function validateObservationSettings(input, previous = DEFAULT_OBSERVATION_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Observation settings must be an object.');
  const next = { ...previous };
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false.');
    next.enabled = input.enabled;
  }
  if ('interval_hours' in input) {
    if (![24, 168, 336, 720].includes(input.interval_hours)) throw new Error('interval_hours must be 24, 168, 336 or 720.');
    next.interval_hours = input.interval_hours;
  }
  if ('vault_health_enabled' in input) {
    if (typeof input.vault_health_enabled !== 'boolean') throw new Error('vault_health_enabled must be true or false.');
    next.vault_health_enabled = input.vault_health_enabled;
  }
  if ('vault_health_vault' in input) {
    if (typeof input.vault_health_vault !== 'string' || input.vault_health_vault.length > 100 || /[\r\n]/.test(input.vault_health_vault)) throw new Error('vault_health_vault must name one selected vault.');
    next.vault_health_vault = input.vault_health_vault.trim();
  }
  if (next.vault_health_enabled && !next.vault_health_vault) throw new Error('Choose one vault before enabling link-health observation.');
  for (const key of Object.keys(input)) if (!['enabled', 'interval_hours', 'vault_health_enabled', 'vault_health_vault'].includes(key)) throw new Error(`Unknown observation setting: ${key}.`);
  return next;
}

export function createRsiObservationSchedule({ home, readEntries, readRetrievalObservations, readVaultHealth, ledger, now = () => new Date() }) {
  const file = path.join(home, 'rsi', 'observations.json');
  let running = null;
  let writes = Promise.resolve();

  async function load() {
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') raw = {};
      else throw new Error('RSI observation record is unreadable; fix or remove the local observations.json file.');
    }
    const settings = validateObservationSettings(raw.settings || {});
    const report = raw.report && raw.report.schema === 1 && Array.isArray(raw.report.categories) && Array.isArray(raw.report.findings) ? raw.report : null;
    const lastRun = raw.last_run && typeof raw.last_run === 'object' && typeof raw.last_run.at === 'string'
      ? { at: raw.last_run.at, trigger: ['manual', 'schedule'].includes(raw.last_run.trigger) ? raw.last_run.trigger : 'manual', ok: raw.last_run.ok === true }
      : null;
    return { settings, report, last_run: lastRun };
  }

  function save(mutator) {
    const next = writes.then(async () => {
      const updated = await mutator(await load());
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temp, file);
      } catch (error) { await unlink(temp).catch(() => {}); throw error; }
      return updated;
    });
    writes = next.catch(() => {});
    return next;
  }

  async function status() {
    const state = await load();
    const last = Date.parse(state.last_run?.at || '');
    const current = now();
    const next_run_at = !state.settings.enabled ? null : Number.isFinite(last)
      ? new Date(last + state.settings.interval_hours * 3600e3).toISOString()
      : current.toISOString();
    return { ...state, running: Boolean(running), next_run_at };
  }

  async function configure(input) {
    const updated = await save((state) => ({ ...state, settings: validateObservationSettings(input, state.settings) }));
    return status().then((result) => ({ ...result, settings: updated.settings }));
  }

  async function run(trigger = 'manual') {
    if (!['manual', 'schedule'].includes(trigger)) throw new Error('Unknown observation trigger.');
    if (running) return running;
    running = (async () => {
      const started = now();
      try {
        const entries = await readEntries();
        const report = analyzeActivitySignals(entries, { now: started });
        if (typeof readRetrievalObservations === 'function') {
          const since = new Date(started.getTime() - 60 * 86400000).toISOString();
          attachRetrievalObservationSignals(report, await readRetrievalObservations({ since }), { now: started });
        }
        const stateBeforeSave = await load();
        if (stateBeforeSave.settings.vault_health_enabled) {
          if (typeof readVaultHealth !== 'function') throw new Error('Selected-vault health observation is unavailable.');
          const snapshot = sanitizeVaultHealthSnapshot(await readVaultHealth(stateBeforeSave.settings.vault_health_vault), stateBeforeSave.settings.vault_health_vault);
          snapshot.observed_at = started.toISOString();
          const previous = stateBeforeSave.report?.vault_health;
          const comparison = compareVaultHealth(snapshot, previous);
          report.vault_health = { ...snapshot, comparison };
          report.privacy.vault_health_content_read_locally = true;
          report.privacy.vault_health_content_persisted = false;
          report.limitations.push('Vault health is a structural link and metadata signal for one explicitly selected vault; it does not measure correct filing, note quality, or whether suggested links are useful. Only aggregate counts are saved, and no proposal or vault content is changed.');
        }
        if (trigger === 'schedule' && ledger && report.findings.length) {
          const proposals = await ledger.appendObservationSignals(report.findings);
          report.proposal_intake = { created_count: proposals.created.length, duplicate_count: proposals.duplicates.length };
        }
        report.privacy.report_saved = true;
        await save((state) => ({ ...state, report, last_run: { at: started.toISOString(), trigger, ok: true } }));
        return { ok: true, report, last_run: { at: started.toISOString(), trigger, ok: true } };
      } catch {
        const last_run = { at: started.toISOString(), trigger, ok: false };
        await save((state) => ({ ...state, last_run })).catch(() => {});
        return { ok: false, last_run, error: 'The local observation could not be saved. Check the RSI observation record in BrainLink data.' };
      }
    })();
    try { return await running; } finally { running = null; }
  }

  return {
    file,
    status,
    configure,
    run,
    due: async () => {
      const state = await load();
      if (!state.settings.enabled || running) return false;
      const last = Date.parse(state.last_run?.at || '');
      return !Number.isFinite(last) || now().getTime() - last >= state.settings.interval_hours * 3600e3;
    },
  };
}
