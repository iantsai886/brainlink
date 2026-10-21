// Sync settings. A provider is only a folder its own desktop client syncs: no APIs, no credentials.
// Default is local-only. Only the store's 'brain' vault is eligible; private vaults/sessions never leave the device.
import { existsSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

// The single BrainStore vault (brainlink-store interface.d.ts VaultInfo.name) sync ever touches.
export const SYNC_VAULT = 'brain';
export const PROVIDERS = ['local', 'gdrive', 'icloud', 'dropbox'];
export const PROVIDER_LABELS = { local: 'Local only', gdrive: 'Drive snapshot', icloud: 'iCloud folder', dropbox: 'Dropbox folder' };

export function defaultSync() { return { provider: 'local', folder: null, device: hostname().split('.')[0] || 'device' }; }

export function syncSettings(cfg = {}) { return { ...defaultSync(), ...(cfg.sync || {}) }; }

export function validateSync(s) {
  const e = [];
  if (!PROVIDERS.includes(s.provider)) e.push(`sync.provider must be ${PROVIDERS.join(' | ')}`);
  if (s.provider !== 'local' && (!s.folder || !path.isAbsolute(s.folder))) e.push('sync.folder must be an absolute path');
  if (!s.device || /[\/\\:()]/.test(s.device)) e.push('sync.device must be set and contain no / \\ : ( )');
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
export function chooseSync(cfg, { provider = 'local', folder = null, device } = {}) {
  const s = { ...syncSettings(cfg), provider, folder: provider === 'local' ? null : folder, ...(device ? { device } : {}) };
  const errors = validateSync(s);
  if (errors.length) throw new Error(errors.join('; '));
  return { ...cfg, sync: s };
}

// Private vaults stay local whatever the setting.
export function syncableScopes(cfg = {}) { return [SYNC_VAULT]; }
export function isPrivateNote(note, cfg = {}) {
  const fm = note.frontmatter || {};
  if (fm.private === true || fm.private === 'true') return true;
  return (cfg.vaults || []).some((v) => v.private && note.path?.startsWith(`${v.name}/`));
}
