import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isExcludedPath, loadVault, safeJoin, vault, vaultRoot } from '../core.mjs';
import { suggestLinks } from '../links.mjs';

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
  const available = await listSessionFilingFolders(ctx, vaultName);
  if (saved && typeof saved === 'object' && saved.vault === vaultName && typeof saved.folder === 'string'
    && available.some((item) => item.path === saved.folder)) {
    return { folder: saved.folder, source: 'saved', reason: 'Matches your saved choice for this exact project.' };
  }

  // Conservative content-based fallback: only infer a folder from public, index-eligible notes
  // in this same selected vault. Exact note-title mentions outrank similarity; ambiguous folders
  // produce no recommendation. Nothing is moved or written until the user reviews the draft.
  if (!String(session?.summary || '').trim()) return null;
  const links = await suggestLinks(ctx, vaultName, `${session.title || ''}\n${String(session.summary || '').slice(0, 6000)}`, { limit: 5 });
  const index = await loadVault(ctx, vaultName);
  const eligibleFolders = new Set(available.map((item) => item.path));
  const candidates = links.map((link) => {
    const titled = index.byTitle.get(link.title) || [];
    const rel = titled.length === 1 ? index.notes[titled[0]].rel
      : index.byRel.has(`${link.target}.md`) ? `${link.target}.md` : null;
    if (!rel) return null;
    const folder = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    return eligibleFolders.has(folder) ? { folder, why: link.why } : null;
  }).filter(Boolean);
  if (!candidates.length) return null;
  const mentioned = [...new Set(candidates.filter((item) => item.why === 'mentioned').map((item) => item.folder))];
  if (mentioned.length === 1) return { folder: mentioned[0], source: 'related_note', reason: 'Matches an existing note mentioned in this session summary.' };
  if (mentioned.length > 1) return null;
  const counts = new Map();
  for (const item of candidates) counts.set(item.folder, (counts.get(item.folder) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [folder, votes] = ranked[0];
  if (votes < 2 || votes / candidates.length < 0.67) return null;
  return { folder, source: 'related_notes', reason: 'Most matching existing notes in this vault are in this folder.' };
}
