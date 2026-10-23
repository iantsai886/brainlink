// Read-only shared snapshot (Ian's RB8): a filtered, plain-Markdown copy of non-excluded,
// non-private notes written into a folder the user already has (e.g. Google Drive for desktop),
// so a cloud AI agent can read the brain with no inbound network access. BrainLink itself never
// opens a network connection or listens on anything but 127.0.0.1 -- whatever gets this folder to
// the cloud is the user's own desktop sync client, not us.
import { readFile, writeFile, rename, mkdir, unlink, stat, lstat, realpath, readdir, rm } from 'node:fs/promises';
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

// N5's authoritative guard is the realpath-based check inside writeSnapshotOnce (vaultRealRoots
// / isWithinRoot): chooseSnapshot deliberately does not reject a vault-nested folder itself,
// since the folder may not exist yet (nothing to realpath) and this setter must stay a pure,
// synchronous config transform -- the write path is where the folder is guaranteed to exist and
// a wrong answer would be actually destructive, so that's where the real check belongs.
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

// v1.2.4 introduced the dedicated 'BrainLink Shared' subfolder (N2); every key in a layout-2
// manifest is relative to that subfolder (outRoot). v1.2.2/v1.2.3 wrote the same appHome manifest
// path, but its keys were relative to dest's own root (the subfolder didn't exist yet) -- F1.
const CURRENT_LAYOUT = 2;

// The current manifest lives only under appHome (manifestPath above). 'missing' (no fallback to
// anything inside `dest`, which a synced peer or just a user's own unrelated manifest.json could
// write to -- that fallback was the R1 regression) and 'corrupt' (unparseable JSON) are
// distinguished so callers can tell "nothing tracked yet" apart from "a real manifest existed
// and failed to parse" (F2 fails closed on the latter instead of treating it the same as empty).
async function readManifest(dest, env) {
  let raw;
  try { raw = await readFile(manifestPath(dest, env), 'utf8'); }
  catch { return { status: 'missing', files: {}, layout: CURRENT_LAYOUT }; }
  try { const parsed = JSON.parse(raw); return { status: 'ok', files: parsed.files || {}, layout: parsed.layout }; }
  catch { return { status: 'corrupt', files: {}, layout: undefined, raw }; }
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
async function migrateLegacyManifestOnce(ctx, dest, outRoot, env, vaultRoots) {
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
    const safe = await safeDeletePath(outRoot, rel, vaultRoots, sourceFull);
    if (!safe) continue;
    let distBytes;
    try { distBytes = await readFile(safe); } catch { continue; }
    if (Buffer.compare(distBytes, sourceBytes) === 0) { try { await unlink(safe); } catch {} }
  }
}

// N4: the vault path and the "shared output" path can be the exact same file on disk -- the
// layout suggestSnapshotFolder itself suggests is a vault at <dest>/<vaultName>, so a legacy (or
// current) manifest key naming that vault's own relative path resolves to a real vault file, not
// a copy. A byte-equal check alone (the migration's original guard) always passes in that case,
// since it's comparing the file to itself. Resolve every configured vault's real path once and
// never let any delete loop (migration, prune, clear) unlink a path whose realpath lands inside
// one of them, or that shares a dev+ino with the specific source file a migration step is
// mirroring (catches the same file reached via a different, non-descendant symlink chain).
async function vaultRealRoots(vaults = []) {
  const roots = [];
  for (const v of vaults) {
    if (!v || !v.path) continue;
    try { roots.push(await realpath(path.resolve(v.path))); } catch { /* vault path gone: nothing to protect */ }
  }
  return roots;
}

function isWithinRoot(root, real) { return real === root || real.startsWith(root + path.sep); }

// F2's "missing manifest" fail-closed check needs to tell apart two scenarios that both look
// like "no manifest, but outRoot isn't empty": a genuine first enable where a foreign/collision
// file already happens to occupy a wanted path (N2 -- this must keep succeeding normally), versus
// BrainLink having actually shared this folder before and the manifest later being lost (the real
// F2 danger). README.md's content is BrainLink's own literal, regenerated-every-run text, so its
// exact presence is a strong, hard-to-coincide signal of "shared by BrainLink before" that a
// merely-colliding or foreign file won't match.
async function looksPreviouslyShared(outRoot) {
  try { return (await readFile(path.join(outRoot, 'README.md'), 'utf8')) === README; } catch { return false; }
}

async function isProtectedVaultFile(vaultRoots, resolved, sourceFull) {
  if (sourceFull) {
    try {
      const [a, b] = await Promise.all([stat(resolved), stat(sourceFull)]);
      if (a.dev === b.dev && a.ino === b.ino) return true;
    } catch { /* one of them doesn't exist: dev+ino can't match */ }
  }
  let real;
  try { real = await realpath(resolved); } catch { return false; }
  return vaultRoots.some((root) => isWithinRoot(root, real));
}

// The manifest read back from `dest` is untrusted (it lives in a folder a cloud sync client also
// writes to, and a compromised/odd peer could plant one). Before deleting a key from it, confirm
// the path it names actually resolves inside `dest` -- rejecting absolute paths, "..", and any
// symlink (in the key's own directory chain, or the key itself) that would resolve outside it --
// and, per N4 above, never a path that is actually a real vault file.
async function safeDeletePath(dest, rel, vaultRoots = [], sourceFull = null) {
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
  if (await isProtectedVaultFile(vaultRoots, resolved, sourceFull)) return null;
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

// N2: every write/delete this feature ever does happens inside this dedicated subfolder of the
// chosen destination, never in `dest` itself. That alone keeps BrainLink's hand off anything a
// user already has sitting at the top level of a synced folder (a root README.md, an unrelated
// project, etc.) -- there is no longer a name BrainLink writes that could collide with one.
const SHARED_SUBDIR = 'BrainLink Shared';
function sharedRoot(dest) { return path.join(dest, SHARED_SUBDIR); }

// N2, second layer: even inside the dedicated subfolder, never overwrite a file that already
// exists there but isn't one this feature wrote before (tracked by the previous manifest). A
// brand-new key with nothing in its way writes normally; a key that collides with something
// already present and unowned is left alone and simply never claimed, so a later run doesn't
// delete it either (it's not considered "ours" to remove).
async function writeOwned(file, rel, data, prevFiles) {
  if (!prevFiles[rel] && await stat(file).then(() => true, () => false)) return false;
  await atomicWrite(file, data);
  return true;
}

// One pass: write the filtered snapshot, delete anything we wrote before that no longer belongs
// (removed note, newly excluded, newly private, sessions turned off), and never touch a file we
// did not create ourselves, inside or outside the shared subfolder (tracked in manifest.json).
export async function writeSnapshotOnce(ctx, cfg, env = process.env) {
  const settings = snapshotSettings(cfg);
  if (!settings.enabled) return { ok: true, skipped: true, noteCount: 0 };
  if (!settings.folder) return { ok: false, error: 'No shared folder chosen yet.' };
  const dest = settings.folder;
  if (!(await stat(dest).then((s) => s.isDirectory(), () => false))) return { ok: false, error: `Shared folder not found: ${dest}` };
  const outRoot = sharedRoot(dest);

  // N5: a dest inside a vault gets walked and copied right back into itself on the very next
  // run (the recursive watcher fires on its own writes too), growing without end. Reject before
  // writing anything, rather than detect it after the fact.
  const vaultRoots = await vaultRealRoots(ctx.cfg.vaults);
  let realDest;
  try { realDest = await realpath(dest); } catch { realDest = path.resolve(dest); }
  if (vaultRoots.some((root) => isWithinRoot(root, realDest))) {
    return { ok: false, error: 'Shared folder is inside a vault. Choose a folder outside your vault(s).' };
  }

  // F2: a corrupt manifest, or a missing one when the shared subfolder already has content, means
  // ownership tracking for this folder was lost. Adopting files by content (byte-equal to a
  // current note) was considered and rejected -- it would also adopt the user's own unrelated
  // copy, which then gets deleted the moment that note is later removed or made private. Fail
  // closed instead, before any mutation (including the legacy-manifest migration below): write
  // nothing, delete nothing, keep a .bak of a corrupt manifest for inspection, and surface a
  // 'Clear and re-share' action so the user can explicitly reset this folder's tracking.
  const prev = await readManifest(dest, env);
  if (prev.status === 'corrupt') {
    try { await writeFile(`${manifestPath(dest, env)}.bak`, prev.raw); } catch {}
    return { ok: false, error: 'The sharing record for this folder is corrupt and can no longer be trusted.', action: 'clear_and_reshare' };
  }
  if (prev.status === 'missing' && await looksPreviouslyShared(outRoot)) {
    return { ok: false, error: 'The sharing record for this folder is missing, but the folder was shared before.', action: 'clear_and_reshare' };
  }

  const notes = await snapshotNotes(ctx);
  const sessions = settings.includeSessions ? await snapshotSessions(env).catch(() => []) : null;
  const readmeText = README;
  const indexText = renderIndex(notes);

  const wanted = {};
  for (const n of notes) wanted[relFor(n)] = { sha12: sha12(n.raw), data: n.raw };
  wanted['README.md'] = { sha12: sha12(readmeText), data: readmeText };
  wanted['index.md'] = { sha12: sha12(indexText), data: indexText };
  const sessionsText = sessions ? JSON.stringify({ generated_at: new Date().toISOString(), sessions }, null, 1) : null;
  if (sessionsText !== null) wanted[SESSIONS_FILE] = { sha12: sha12(sessionsText), data: sessionsText };

  // The pre-1.2.2 legacy manifest, if any, named paths at `dest`'s own root (the shared subfolder
  // didn't exist yet when it was written) -- migrate against `dest`, not the new subfolder.
  await migrateLegacyManifestOnce(ctx, dest, dest, env, vaultRoots);

  let prevFiles = prev.status === 'ok' ? prev.files : {};

  // F1: a v1.2.2/v1.2.3 appHome manifest (trusted, since it never lived inside `dest`) named
  // paths at dest's own root, before the 'BrainLink Shared' subfolder existed. Prune those
  // dest-root copies once, deleting only ones whose on-disk bytes still match the sha12 this
  // manifest already recorded (an edited or already-removed copy is left alone), then start a
  // fresh layout-2 manifest -- the old keys are never interpreted relative to outRoot.
  if (prev.status === 'ok' && prev.layout !== CURRENT_LAYOUT) {
    for (const [rel, meta] of Object.entries(prevFiles)) {
      const safe = await safeDeletePath(dest, rel, vaultRoots);
      if (!safe) continue;
      let text;
      try { text = await readFile(safe, 'utf8'); } catch { continue; }
      if (meta && sha12(text) === meta.sha12) { try { await unlink(safe); } catch {} }
    }
    prevFiles = {};
  }

  for (const rel of Object.keys(prevFiles)) if (!wanted[rel]) { const safe = await safeDeletePath(outRoot, rel, vaultRoots); if (safe) { try { await unlink(safe); } catch {} } }

  const files = {};
  const now = new Date().toISOString();
  for (const [rel, w] of Object.entries(wanted)) {
    const full = path.join(outRoot, rel);
    if (prevFiles[rel]?.sha12 === w.sha12 && existsSync(full)) { files[rel] = prevFiles[rel]; continue; }
    if (await writeOwned(full, rel, w.data, prevFiles)) files[rel] = { sha12: w.sha12, updated_at: now };
    // else: something we didn't create already occupies this path in the shared subfolder --
    // leave it untouched and don't claim it in the manifest.
  }

  await atomicWrite(manifestPath(dest, env), JSON.stringify({ generated_at: now, layout: CURRENT_LAYOUT, files }, null, 1));
  return { ok: true, noteCount: notes.length, syncedAt: now };
}

// "Stop sharing" + clear: removes every file this feature ever wrote (tracked in its own
// manifest, kept under appHome — see manifestPath above) from inside the shared subfolder, and
// nothing else -- a foreign file there, or anywhere else in `dest`, is untouched.
export async function clearSnapshot(dest, env = process.env, vaults = [], { force = false } = {}) {
  if (!dest) return { ok: true };
  const outRoot = sharedRoot(dest);
  const vaultRoots = await vaultRealRoots(vaults);
  const prev = await readManifest(dest, env);
  // F1: a manifest without the layout-2 marker names paths at dest's own root, not outRoot --
  // never apply those old keys to outRoot either (same bug as the prune loop above).
  const root = prev.status === 'ok' && prev.layout === CURRENT_LAYOUT ? outRoot : dest;
  if (prev.status === 'ok') for (const rel of Object.keys(prev.files)) { const safe = await safeDeletePath(root, rel, vaultRoots); if (safe) { try { await unlink(safe); } catch {} } }
  // F2 recovery ("Clear and re-share"): when ownership tracking was lost (missing/corrupt
  // manifest), there is no tracked list left to reconcile against, so the normal loop above does
  // nothing. A caller that explicitly opts into a full reset gets the dedicated subfolder wiped
  // outright instead -- nothing else is ever meant to write inside it (N2), so this is safe for
  // an explicit, user-initiated reset even though it isn't safe to do automatically.
  if (force && prev.status !== 'ok') { try { await rm(outRoot, { recursive: true, force: true }); } catch {} }
  try { await unlink(manifestPath(dest, env)); } catch {}
  try { await unlink(`${manifestPath(dest, env)}.bak`); } catch {}
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
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { lastSyncedAt: null, noteCount: 0, error: null, action: null }; }
}
export async function saveSnapshotStatus(file, result) {
  // F2: result.action (e.g. 'clear_and_reshare') rides along with the error so a UI reading this
  // status file can offer the right recovery action, not just a dead-end error string.
  const status = result.skipped ? { lastSyncedAt: null, noteCount: 0, error: null, action: null }
    : result.ok ? { lastSyncedAt: result.syncedAt, noteCount: result.noteCount, error: null, action: null }
    : { ...(await loadSnapshotStatus(file)), error: result.error, action: result.action || null };
  await atomicWrite(file, JSON.stringify(status));
  return status;
}
