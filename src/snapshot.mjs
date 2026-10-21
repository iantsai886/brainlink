// Read-only shared snapshot (Ian's RB8): a filtered, plain-Markdown copy of non-excluded,
// non-private notes written into a folder the user already has (e.g. Google Drive for desktop),
// so a cloud AI agent can read the brain with no inbound network access. BrainLink itself never
// opens a network connection or listens on anything but 127.0.0.1 -- whatever gets this folder to
// the cloud is the user's own desktop sync client, not us.
import { readFile, writeFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadVault } from './core.mjs';
import { suggestFolders } from './sync/settings.mjs';
import { openSessionStore, importAll } from './sessions/index.mjs';
import { sessionList } from './sessions/mcp.mjs';

export function defaultSnapshot() { return { enabled: false, folder: null, includeSessions: false }; }
export function snapshotSettings(cfg = {}) { return { ...defaultSnapshot(), ...(cfg.snapshot || {}) }; }

export function validateSnapshot(s) {
  const e = [];
  if (s.enabled && (!s.folder || !path.isAbsolute(s.folder))) e.push('Choose a folder using the folder picker.');
  return e;
}

// First-run / settings choice. Returns a new config; caller saves it with saveConfig().
export function chooseSnapshot(cfg, { enabled, folder, includeSessions } = {}) {
  const s = {
    ...snapshotSettings(cfg),
    ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
    ...(folder !== undefined ? { folder: folder || null } : {}),
    ...(includeSessions !== undefined ? { includeSessions: Boolean(includeSessions) } : {}),
  };
  const errors = validateSnapshot(s);
  if (errors.length) throw new Error(errors.join('; '));
  return { ...cfg, snapshot: s };
}

// The Google Drive for desktop folder, if this Mac has one -- a convenience suggestion only;
// BrainLink never talks to Google itself, it only writes to a folder that app already syncs.
export function suggestSnapshotFolder(home) {
  return suggestFolders(home).gdrive[0] || null;
}

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const isPrivateNote = (note) => /^(true|yes|1)$/i.test(String(note.meta?.private ?? ''));
const relFor = (n) => path.posix.join(n.vault, n.rel);
const manifestPath = (dest) => path.join(dest, 'manifest.json');

async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function readManifest(dest) {
  try { return JSON.parse(await readFile(manifestPath(dest), 'utf8')); } catch { return { files: {} }; }
}

// Same filter every other read path uses: a private vault is skipped whole; a note's own
// `private: true` frontmatter excludes just that note. Folders under .brainlinkignore never even
// reach index.notes (core.mjs's walk()), so nothing further is needed for exclusion.
export async function snapshotNotes(ctx) {
  const out = [];
  for (const name of ctx.enabled) {
    if (ctx.byName.get(name).private) continue;
    const index = await loadVault(ctx, name);
    for (const n of index.notes) if (!isPrivateNote(n)) out.push({ vault: name, rel: n.rel, title: n.title, raw: n.raw, mtime: n.mtime });
  }
  return out;
}

async function snapshotSessions(env) {
  const store = await openSessionStore(env);
  await importAll({ store, env });
  return (await sessionList(store, { limit: 20, include_private: false })).sessions;
}

const README = `# Shared notes (read-only)

This folder is a filtered, read-only copy of someone's BrainLink notes, kept here so a cloud AI
agent can read it. BrainLink itself never makes an outbound network call -- whatever syncs this
folder to the cloud (Google Drive, iCloud, etc.) is the owner's own doing.

Start with index.md for the full note list, then open any note file directly.

Nothing here should be changed: edits made in this folder are never read back by BrainLink and
will be overwritten the next time it refreshes. Notes marked private, or kept in an excluded
folder, are never included here.
`;

function renderIndex(notes) {
  const byVault = new Map();
  for (const n of notes) { if (!byVault.has(n.vault)) byVault.set(n.vault, []); byVault.get(n.vault).push(n); }
  const lines = ['# Notes', '', `${notes.length} note${notes.length === 1 ? '' : 's'}, updated ${new Date().toISOString()}.`, ''];
  for (const [vaultName, list] of byVault) {
    lines.push(`## ${vaultName}`, '');
    for (const n of list.slice().sort((a, b) => a.rel.localeCompare(b.rel))) lines.push(`- [${n.title}](${relFor(n)})`);
    lines.push('');
  }
  return lines.join('\n');
}

const SESSIONS_FILE = 'sessions.json';

// One pass: write the filtered snapshot, delete anything we wrote before that no longer belongs
// (removed note, newly excluded, newly private, sessions turned off), and never touch a file in
// the destination folder we did not write ourselves (tracked in manifest.json).
export async function writeSnapshotOnce(ctx, cfg, env = process.env) {
  const settings = snapshotSettings(cfg);
  if (!settings.enabled) return { ok: true, skipped: true, noteCount: 0 };
  if (!settings.folder) return { ok: false, error: 'No shared folder chosen yet.' };
  const dest = settings.folder;
  if (!(await stat(dest).then((s) => s.isDirectory(), () => false))) return { ok: false, error: `Shared folder not found: ${dest}` };

  const notes = await snapshotNotes(ctx);
  const sessions = settings.includeSessions ? await snapshotSessions(env).catch(() => []) : null;
  const readmeText = README;
  const indexText = renderIndex(notes);

  const files = {};
  for (const n of notes) files[relFor(n)] = { sha12: sha12(n.raw), updated_at: new Date(n.mtime).toISOString() };
  files['README.md'] = { sha12: sha12(readmeText), updated_at: new Date().toISOString() };
  files['index.md'] = { sha12: sha12(indexText), updated_at: new Date().toISOString() };
  const sessionsText = sessions ? JSON.stringify({ generated_at: new Date().toISOString(), sessions }, null, 1) : null;
  if (sessionsText !== null) files[SESSIONS_FILE] = { sha12: sha12(sessionsText), updated_at: new Date().toISOString() };

  const prev = await readManifest(dest);
  for (const rel of Object.keys(prev.files || {})) if (!files[rel]) { try { await unlink(path.join(dest, rel)); } catch {} }

  for (const n of notes) {
    const rel = relFor(n);
    if (prev.files?.[rel]?.sha12 === files[rel].sha12) continue;
    await atomicWrite(path.join(dest, rel), n.raw);
  }
  if (prev.files?.['README.md']?.sha12 !== files['README.md'].sha12) await atomicWrite(path.join(dest, 'README.md'), readmeText);
  if (prev.files?.['index.md']?.sha12 !== files['index.md'].sha12) await atomicWrite(path.join(dest, 'index.md'), indexText);
  if (sessionsText !== null) await atomicWrite(path.join(dest, SESSIONS_FILE), sessionsText);

  await atomicWrite(manifestPath(dest), JSON.stringify({ generated_at: new Date().toISOString(), files }, null, 1));
  return { ok: true, noteCount: notes.length, syncedAt: new Date().toISOString() };
}

// "Stop sharing" + clear: removes every file this feature ever wrote to `dest` (tracked in its
// own manifest.json), and nothing else -- a foreign file placed in the same folder is untouched.
export async function clearSnapshot(dest) {
  if (!dest) return { ok: true };
  const prev = await readManifest(dest);
  for (const rel of Object.keys(prev.files || {})) { try { await unlink(path.join(dest, rel)); } catch {} }
  try { await unlink(manifestPath(dest)); } catch {}
  return { ok: true };
}

// Refreshes on change (debounced) plus every intervalMs, for as long as this process runs.
// Non-private vault roots only; a vault not watchable (e.g. recursive fs.watch unsupported on
// this OS) simply falls back to the interval alone. `ready` resolves with the one, shared result
// of the first write, so a caller that also wants an immediate answer (e.g. the Settings toggle)
// never triggers a second, racing write of its own.
export function startSnapshotWatcher(ctx, cfg, env = process.env, opts = {}) {
  const settings = snapshotSettings(cfg);
  if (!settings.enabled) return { stop() {}, ready: Promise.resolve({ ok: true, skipped: true, noteCount: 0 }) };
  const debounceMs = opts.debounceMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 15 * 60 * 1000;
  const onResult = opts.onResult || (() => {});
  let debounceTimer = null;
  const runOnce = () => writeSnapshotOnce(ctx, cfg, env).catch((e) => ({ ok: false, error: e.message || String(e) }));
  const runAndReport = async () => onResult(await runOnce());
  const ready = runOnce().then(async (r) => { await onResult(r); return r; });
  const intervalId = setInterval(runAndReport, intervalMs);
  intervalId.unref?.();
  const watchers = [];
  for (const name of ctx.enabled) {
    const v = ctx.byName.get(name);
    if (v.private) continue;
    try {
      const w = watch(v.path, { recursive: true }, () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(runAndReport, debounceMs); });
      w.on('error', () => {});
      watchers.push(w);
    } catch {}
  }
  return {
    ready,
    stop() {
      clearTimeout(debounceTimer);
      clearInterval(intervalId);
      for (const w of watchers) { try { w.close(); } catch {} }
    },
  };
}

// Status (last synced / count / error), persisted separately from config.json so Settings can
// show it without re-scanning. file: caller-chosen path (see src/setup.mjs, appHome-based).
export async function loadSnapshotStatus(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { lastSyncedAt: null, noteCount: 0, error: null }; }
}
export async function saveSnapshotStatus(file, result) {
  const status = result.skipped ? { lastSyncedAt: null, noteCount: 0, error: null }
    : result.ok ? { lastSyncedAt: result.syncedAt, noteCount: result.noteCount, error: null }
    : { ...(await loadSnapshotStatus(file)), error: result.error };
  await atomicWrite(file, JSON.stringify(status));
  return status;
}
