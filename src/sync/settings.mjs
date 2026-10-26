// Sync settings. A provider is only a folder its own desktop client syncs: no APIs, no credentials.
// Default is local-only. Only the store's 'brain' vault is eligible; private vaults/sessions never leave the device.
import { existsSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

// The single BrainStore vault (brainlink-store interface.d.ts VaultInfo.name) sync ever touches.
export const SYNC_VAULT = 'brain';
export const PROVIDERS = ['local', 'gdrive', 'icloud', 'dropbox'];
export const PROVIDER_LABELS = { local: 'Local only', gdrive: 'Drive snapshot', icloud: 'iCloud folder', dropbox: 'Dropbox folder' };
// Same labels, translated. The live Setup UI (ui/index.html) looks these up through its own
// ui/locales/<id>.json catalog under the sync.provider.* keys instead (so a locale switch takes
// effect without a new request); this map is for any other caller that only has a locale code.
export const PROVIDER_LABELS_I18N = {
  en: PROVIDER_LABELS,
  'zh-TW': { local: '僅本機', gdrive: 'Drive 快照', icloud: 'iCloud 資料夾', dropbox: 'Dropbox 資料夾' },
  pt: { local: 'Somente local', gdrive: 'Snapshot do Drive', icloud: 'Pasta do iCloud', dropbox: 'Pasta do Dropbox' },
};
export function providerLabel(provider, locale = 'en') { return (PROVIDER_LABELS_I18N[locale] || PROVIDER_LABELS_I18N.en)[provider] || provider; }

export function defaultSync() { return { provider: 'local', folder: null, vault: null, scheduled: false, intervalHours: 6, device: hostname().split('.')[0] || 'device' }; }

export function syncSettings(cfg = {}) { return { ...defaultSync(), ...(cfg.sync || {}) }; }

export function validateSync(s) {
  const e = [];
  if (!PROVIDERS.includes(s.provider)) e.push(`sync.provider must be ${PROVIDERS.join(' | ')}`);
  if (s.provider !== 'local' && (!s.folder || !path.isAbsolute(s.folder))) e.push('sync.folder must be an absolute path');
  if (!s.device || /[\/\\:()]/.test(s.device)) e.push('sync.device must be set and contain no / \\ : ( )');
  if (s.scheduled !== undefined && typeof s.scheduled !== 'boolean') e.push('sync.scheduled must be a boolean');
  if (s.intervalHours !== undefined && (!Number.isInteger(s.intervalHours) || s.intervalHours < 1 || s.intervalHours > 168)) e.push('sync.intervalHours must be 1–168');
  return e;
}

// Candidate folders for the first-run picker; the user confirms or picks another.
export function suggestFolders(home = homedir()) {
  const cs = path.join(home, 'Library', 'CloudStorage');
  const sub = (re) => { try { return readdirSync(cs).filter((d) => re.test(d)).map((d) => path.join(cs, d)); } catch { return []; } };
  const c = {
    gdrive: [...sub(/^GoogleDrive-/).map((d) => path.join(d, 'My Drive')), path.join(home, 'Google Drive')],
    icloud: [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), path.join(home, 'iCloudDrive')],
    dropbox: [...sub(/^Dropbox/), path.join(home, 'Dropbox')],
  };
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.filter((p) => existsSync(p))]));
}

// First-run / settings choice. Returns a new config; caller saves it with saveConfig().
export function chooseSync(cfg, { provider = 'local', folder = null, vault, scheduled, intervalHours, device } = {}) {
  const s = { ...syncSettings(cfg), provider, folder: provider === 'local' ? null : folder,
    ...(vault !== undefined ? { vault: vault || null } : {}),
    ...(scheduled !== undefined ? { scheduled } : {}),
    ...(intervalHours !== undefined ? { intervalHours } : {}),
    ...(device ? { device } : {}) };
  const errors = validateSync(s);
  if (errors.length) throw new Error(errors.join('; '));
  if (s.vault && !(cfg.vaults || []).some((v) => v.name === s.vault && !v.private)) throw new Error('sync.vault must name an existing public vault');
  return { ...cfg, sync: s };
}

// Private vaults stay local whatever the setting.
export function syncableScopes(cfg = {}) { return [SYNC_VAULT]; }
export function isPrivateNote(note, cfg = {}) {
  const fm = note.frontmatter || {};
  if (fm.private === true || fm.private === 'true') return true;
  return (cfg.vaults || []).some((v) => v.private && note.path?.startsWith(`${v.name}/`));
}
