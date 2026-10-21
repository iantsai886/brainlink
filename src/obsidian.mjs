// Finds the user's Obsidian vaults from Obsidian's own settings file, and spots folders that
// hold several vaults (so nobody merges separate vaults by picking their parent folder).
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export function obsidianConfigPath({ home, os, env = {} }) {
  if (os === 'darwin') return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  if (os === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obsidian', 'obsidian.json');
}

// Linux installs keep Obsidian's settings in different places: native/AppImage, Flatpak, Snap.
export function obsidianConfigPaths(opts) {
  const { home, os } = opts;
  const out = [obsidianConfigPath(opts)];
  if (os !== 'darwin' && os !== 'win32') {
    out.push(path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'));
    out.push(path.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'));
  }
  return out;
}

const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);

export async function findObsidianVaults(opts) {
  const out = [], seen = new Set();
  for (const file of obsidianConfigPaths(opts)) {
    let json;
    try { json = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    for (const v of Object.values(json.vaults || {})) {
      if (!v?.path || seen.has(v.path) || !(await isDir(v.path))) continue;
      seen.add(v.path);
      out.push({ name: path.basename(v.path), path: v.path, open: Boolean(v.open), ts: v.ts || 0 });
    }
  }
  return out.sort((a, b) => Number(b.open) - Number(a.open) || b.ts - a.ts);
}

// Child folders that are vaults of their own (contain .obsidian), when the folder itself is not one.
export async function nestedVaults(folder) {
  if (await isDir(path.join(folder, '.obsidian'))) return [];
  const out = [];
  for (const f of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (f.isDirectory() && !f.name.startsWith('.') && (await isDir(path.join(folder, f.name, '.obsidian')))) out.push(f.name);
  }
  return out;
}
