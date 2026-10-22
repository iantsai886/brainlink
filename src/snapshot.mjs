// Read-only shared snapshot (Ian's RB8): a filtered, plain-Markdown copy of non-excluded,
// non-private notes written into a folder the user already has (e.g. Google Drive for desktop),
// so a cloud AI agent can read the brain with no inbound network access. BrainLink itself never
// opens a network connection or listens on anything but 127.0.0.1 -- whatever gets this folder to
// the cloud is the user's own desktop sync client, not us.
import { readFile, writeFile, rename, mkdir, unlink, stat, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadVault, safeJoin } from './core.mjs';
import { appHome } from './config.mjs';
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
// note.private is already computed once, at index-build time, by core.mjs's isPrivateMeta —
// reuse it instead of re-deriving it from note.meta.private with a second, independent regex
// (that drift — "on", `Private:`, a trailing `# comment` — is exactly what let private notes
// through here but not through readNote).
const isPrivateNote = (note) => note.private;
const relFor = (n) => path.posix.join(n.vault, n.rel);
// The manifest used to live inside `dest` itself — reachable by whatever remote peer or cloud
// agent has write access to that synced folder, which could plant or edit keys in it and make
// BrainLink delete arbitrary files there on the next write/clear (safeDeletePath only validates
// that a key *resolves inside dest*, not that BrainLink itself ever wrote it). Keeping it under
// appHome instead — out of reach of anything that only syncs `dest` — closes that off: a remote
// edit to manifest.json inside the Drive folder no longer does anything, because this is a
// different file entirely. Keyed by a hash of `dest` so switching folders doesn't collide.
export function manifestPath(dest, env = process.env) {
  return path.join(appHome(env), 'snapshot-manifests', `${sha12(path.resolve(dest))}.json`);
}

async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const LEGACY_MANIFEST = 'manifest.json';

// The current manifest lives only under appHome (manifestPath above). A missing or corrupt file
// here means "nothing tracked yet" -- it must never fall back to anything inside `dest`, which a
// synced peer (or just a user's own unrelated manifest.json, e.g. from a web/extension project)
// can write to. That fallback was the R1 regression: it made a planted or pre-existing
// dest/manifest.json drive the delete loop below on first enable, after a clear, after a folder
// switch, or whenever the appHome file fails to parse.
async function readManifest(dest, env) {
  try { return JSON.parse(await readFile(manifestPath(dest, env), 'utf8')); } catch { return { files: {} }; }
}

function legacyMigrationMarker(dest, env) {
  return `${manifestPath(dest, env)}.legacy-migrated`;
}

// v1.2.0/v1.2.1 kept the manifest inside `dest` itself. That old file is untrusted input (anyone
// with write access to `dest` can edit it or compute its sha12), so unlike the pre-fix code this
// never deletes a key just because the legacy manifest says to. Run at most once per dest (gated
// by a marker under appHome, written before any deletion so a crash can't retry forever), and only
// ever remove a legacy key whose on-disk bytes, in the shared output location, are byte-for-byte
// identical to the real vault file that key names right now. Deleting an exact copy of the user's
// own current note loses nothing; anything that doesn't match (changed, renamed, or the source no
// longer exists) is left in place rather than guessed about. The legacy file itself is never
// deleted -- it may not even be ours.
async function migrateLegacyManifestOnce(ctx, dest, outRoot, env) {
  const marker = legacyMigrationMarker(dest, env);
  if (existsSync(marker)) return;
  await atomicWrite(marker, String(Date.now()));
  let legacy;
  try { legacy = JSON.parse(await readFile(path.join(dest, LEGACY_MANIFEST), 'utf8')); } catch { return; }
  for (const rel of Object.keys(legacy.files || {})) {
    const m = typeof rel === 'string' && rel.match(/^([^/]+)\/(.+)$/);
    if (!m) continue; // only "<vault>/<relpath>" keys are in scope; README/index/sessions are regenerated every run anyway
    const v = ctx.cfg.vaults.find((x) => x.name === m[1]);
    if (!v || !v.path) continue;
    let sourceFull;
    try { sourceFull = safeJoin(path.resolve(v.path), m[2]); } catch { continue; }
    let sourceBytes;
    try { sourceBytes = await readFile(sourceFull); } catch { continue; } // can't verify: leave it alone
    const safe = await safeDeletePath(outRoot, rel);
    if (!safe) continue;
    let distBytes;
    try { distBytes = await readFile(safe); } catch { continue; }
    if (Buffer.compare(distBytes, sourceBytes) === 0) { try { await unlink(safe); } catch {} }
  }
}

// The manifest read back from `dest` is untrusted (it lives in a folder a cloud sync client also
// writes to, and a compromised/odd peer could plant one). Before deleting a key from it, confirm
// the path it names actually resolves inside `dest` -- rejecting absolute paths, "..", and any
// symlink (in the key's own directory chain, or the key itself) that would resolve outside it.
async function safeDeletePath(dest, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const destResolved = path.resolve(dest);
  const resolved = path.resolve(destResolved, rel);
  if (resolved !== destResolved && !resolved.startsWith(destResolved + path.sep)) return null;
  let realDest;
  try { realDest = await realpath(destResolved); } catch { return null; }
  let realDir;
  try { realDir = await realpath(path.dirname(resolved)); } catch { return null; } // containing dir must really exist
  if (realDir !== realDest && !realDir.startsWith(realDest + path.sep)) return null;
  try { if ((await lstat(resolved)).isSymbolicLink()) return null; } catch { /* nothing there yet: fine, unlink is a no-op */ }
  return resolved;
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

  await migrateLegacyManifestOnce(ctx, dest, dest, env);

  const prev = await readManifest(dest, env);
  for (const rel of Object.keys(prev.files || {})) if (!files[rel]) { const safe = await safeDeletePath(dest, rel); if (safe) { try { await unlink(safe); } catch {} } }

  for (const n of notes) {
    const rel = relFor(n);
    if (prev.files?.[rel]?.sha12 === files[rel].sha12) continue;
    await atomicWrite(path.join(dest, rel), n.raw);
  }
  if (prev.files?.['README.md']?.sha12 !== files['README.md'].sha12) await atomicWrite(path.join(dest, 'README.md'), readmeText);
  if (prev.files?.['index.md']?.sha12 !== files['index.md'].sha12) await atomicWrite(path.join(dest, 'index.md'), indexText);
  if (sessionsText !== null) await atomicWrite(path.join(dest, SESSIONS_FILE), sessionsText);

  await atomicWrite(manifestPath(dest, env), JSON.stringify({ generated_at: new Date().toISOString(), files }, null, 1));
  return { ok: true, noteCount: notes.length, syncedAt: new Date().toISOString() };
}

// "Stop sharing" + clear: removes every file this feature ever wrote to `dest` (tracked in its
// own manifest, kept under appHome — see manifestPath above), and nothing else -- a foreign file
// placed in the same folder is untouched.
export async function clearSnapshot(dest, env = process.env) {
  if (!dest) return { ok: true };
  const prev = await readManifest(dest, env);
  for (const rel of Object.keys(prev.files || {})) { const safe = await safeDeletePath(dest, rel); if (safe) { try { await unlink(safe); } catch {} } }
  try { await unlink(manifestPath(dest, env)); } catch {}
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
