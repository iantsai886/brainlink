import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isExcludedPath, safeJoin, vault, vaultRoot } from '../core.mjs';

const SKIP = new Set(['node_modules', '.git', '.obsidian', '.trash']);

// Return only existing, non-hidden, non-excluded directories inside the vault the user chose.
// Directory entries are never followed through symlinks. This is a picker, not a classifier.
export async function listSessionFilingFolders(ctx, vaultName) {
  const v = vault(ctx, vaultName);
  if (v.flat) return [{ path: '', label: 'Vault root' }];
  const root = vaultRoot(ctx, vaultName);
  const folders = [];
  async function visit(dir, rel, depth) {
    if (depth >= 6 || folders.length >= 500) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const segments = child.split('/');
      if ((v.protected || []).filter(Boolean).some((p) => segments.some((s) => s.replace(/\.md$/i, '').toLowerCase().startsWith(String(p).toLowerCase())))) continue;
      if (await isExcludedPath(root, child)) continue;
      const full = safeJoin(root, child);
      folders.push({ path: child, label: child });
      await visit(full, child, depth + 1);
      if (folders.length >= 500) return;
    }
  }
  await visit(root, '', 0);
  return folders.sort((a, b) => a.path.localeCompare(b.path));
}

export async function suggestedSessionFolder(ctx, session, vaultName) {
  const project = String(session?.project || '').trim();
  const saved = project && ctx.cfg.session_filing?.projectFolders?.[project];
  if (!saved || typeof saved !== 'object' || saved.vault !== vaultName || typeof saved.folder !== 'string') return null;
  const available = await listSessionFilingFolders(ctx, vaultName);
  return available.some((item) => item.path === saved.folder) ? saved.folder : null;
}
