import path from 'node:path';
import { loadVault } from './core.mjs';

// Counts only owner-visible public-vault note paths recorded on successful search/context calls.
// It never reads query text and never treats a private or excluded note as a zero-use result.
export async function retrievalUseReport(ctx, activity, { days = 60, vault: selectedVault = '' } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be from 1 to 365.');
  if (selectedVault && (!ctx.enabled.includes(selectedVault) || ctx.byName.get(selectedVault)?.private)) throw new Error('Choose an enabled shared vault.');
  const cutoff = Date.now() - days * 86400_000;
  const counts = new Map();
  for (const entry of activity || []) {
    if (!['vault_search', 'context_packet'].includes(entry.tool) || !entry.ok || Date.parse(entry.at) < cutoff || !Array.isArray(entry.retrieved_notes)) continue;
    for (const full of entry.retrieved_notes) {
      const slash = String(full).indexOf('/');
      if (slash < 1) continue;
      const vault = full.slice(0, slash), rel = full.slice(slash + 1);
      if ((!selectedVault || selectedVault === vault) && ctx.enabled.includes(vault) && !ctx.byName.get(vault)?.private && rel && !rel.split('/').includes('..')) {
        const key = `${vault}/${rel}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  const folders = new Map();
  let visibleNotes = 0, retrievedNotes = 0;
  for (const vault of ctx.enabled.filter(name => !selectedVault || name === selectedVault)) {
    if (ctx.byName.get(vault)?.private) continue;
    const index = await loadVault(ctx, vault);
    for (const note of index.notes) {
      const key = `${vault}/${note.rel}`, uses = counts.get(key) || 0;
      const dir = path.posix.dirname(note.rel);
      const folder = dir === '.' ? '(root)' : dir;
      const row = folders.get(folder) || { folder, visible_notes: 0, retrieved_notes: 0, never_retrieved: 0, examples: [] };
      row.visible_notes++; visibleNotes++;
      if (uses) { row.retrieved_notes++; retrievedNotes++; }
      else { row.never_retrieved++; if (row.examples.length < 3) row.examples.push(`${vault}/${note.rel}`); }
      folders.set(folder, row);
    }
  }
  const rows = [...folders.values()].sort((a, b) => b.never_retrieved - a.never_retrieved || a.folder.localeCompare(b.folder));
  const totalFolders = rows.length;
  return { window_days: days, visible_notes: visibleNotes, retrieved_notes: retrievedNotes, never_retrieved: visibleNotes - retrievedNotes,
    folders: rows.slice(0, 30), folders_omitted: Math.max(0, totalFolders - 30), activity_log_may_rotate: true,
    caveat: 'Counts are based on retained successful vault_search and context_packet activity only. They are operational signals, not evidence that an unread note is unimportant.' };
}
