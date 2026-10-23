// Shared snapshot (Ian's RB8): a read-only, filtered copy of notes for cloud agents with no
// inbound network access. Same filter every other read path uses (excluded folders, private
// notes/vaults); atomic writes; manifest-tracked deletion so foreign files are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { startSetup } from '../src/setup.mjs';
import {
  snapshotSettings, validateSnapshot, chooseSnapshot, suggestSnapshotFolder,
  writeSnapshotOnce, clearSnapshot, startSnapshotWatcher, loadSnapshotStatus, saveSnapshotStatus, manifestPath,
} from '../src/snapshot.mjs';

const tmp = (p) => mkdtemp(path.join(tmpdir(), `bl-snap-${p}-`));
// N2: every write/delete BrainLink does lands inside this dedicated subfolder of the chosen
// destination, never at the destination's own root -- see src/snapshot.mjs's SHARED_SUBDIR.
const shared = (dest) => path.join(dest, 'BrainLink Shared');

async function setupVaults() {
  const vaultDir = await tmp('vault');
  await writeFile(path.join(vaultDir, 'Public.md'), '# Public\nhello');
  await mkdir(path.join(vaultDir, 'Secret'), { recursive: true });
  await writeFile(path.join(vaultDir, 'Secret', 'x.md'), 'hidden by excluded folder');
  await writeFile(path.join(vaultDir, '.brainlinkignore'), 'Secret/\n');
  await writeFile(path.join(vaultDir, 'Private.md'), '---\nprivate: true\n---\nshh');
  const privVaultDir = await tmp('priv-vault');
  await writeFile(path.join(privVaultDir, 'AlsoSecret.md'), 'nope');
  const env = { BRAINLINK_HOME: await tmp('home'), BRAINLINK_SEMANTIC: '0' };
  const cfg = normalize({ vaults: [{ name: 'Brain', path: vaultDir }, { name: 'Diary', path: privVaultDir, private: true }] });
  const ctx = createContext(cfg, { env });
  return { vaultDir, privVaultDir, env, cfg, ctx };
}

test('snapshot: enabling needs an absolute folder', () => {
  assert.throws(() => chooseSnapshot({}, { enabled: true }), /folder/);
  assert.throws(() => chooseSnapshot({}, { enabled: true, folder: 'relative/path' }), /folder/);
  assert.deepEqual(validateSnapshot({ enabled: false, folder: null }), []);
  const next = chooseSnapshot({}, { enabled: true, folder: '/tmp/shared' });
  assert.equal(snapshotSettings(next).enabled, true);
  assert.equal(snapshotSettings(next).folder, '/tmp/shared');
  assert.equal(snapshotSettings({}).enabled, false, 'off by default');
});

test('snapshot: nothing is written while the toggle is off', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-off');
  const withFolderButOff = chooseSnapshot(cfg, { enabled: false, folder: dest });
  const r = await writeSnapshotOnce(ctx, withFolderButOff, env);
  assert.equal(r.skipped, true);
  assert.deepEqual(await readdir(dest), [], 'a configured-but-disabled folder stays untouched');
  assert.ok(!existsSync(manifestPath(dest, env)));
});

test('snapshot: excluded and private notes never appear; foreign files are left untouched', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest');
  await writeFile(path.join(dest, 'my-own-file.txt'), 'keep me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);
  assert.equal(r.noteCount, 1, 'only Public.md qualifies');

  assert.equal(await readFile(path.join(shared(dest), 'Brain', 'Public.md'), 'utf8'), '# Public\nhello');
  assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'Secret')), 'excluded folder never copied');
  assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'Private.md')), 'private note never copied');
  assert.ok(!existsSync(path.join(shared(dest), 'Diary')), 'private vault never copied');
  assert.match(await readFile(path.join(shared(dest), 'README.md'), 'utf8'), /read-only/);
  assert.match(await readFile(path.join(shared(dest), 'index.md'), 'utf8'), /Public/);

  const manifest = JSON.parse(await readFile(manifestPath(dest, env), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['Brain/Public.md', 'README.md', 'index.md']);
  assert.ok(!existsSync(path.join(dest, 'manifest.json')), 'the manifest no longer lives inside the shared folder (P0-3 D: a remote peer with write access to dest can no longer plant/edit it)');

  assert.equal(await readFile(path.join(dest, 'my-own-file.txt'), 'utf8'), 'keep me', 'foreign file untouched');
});

// N2: BrainLink only ever creates/writes one thing directly inside the chosen destination -- the
// dedicated 'BrainLink Shared' subfolder itself. Nothing is ever written to, or deleted from, the
// destination's own root, so a user's existing top-level files (a root README, an unrelated
// project) can never collide with anything BrainLink names.
test('snapshot N2: everything is confined to a dedicated "BrainLink Shared" subfolder', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-n2-confine');
  await writeFile(path.join(dest, 'README.md'), 'this is the user\'s own root README, not ours');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);

  assert.deepEqual(await readdir(dest), ['BrainLink Shared', 'README.md'], 'nothing new appears at the destination root');
  assert.equal(await readFile(path.join(dest, 'README.md'), 'utf8'), 'this is the user\'s own root README, not ours', 'the user\'s own root-level file is untouched, not overwritten by ours');
  assert.match(await readFile(path.join(shared(dest), 'README.md'), 'utf8'), /read-only/, 'BrainLink\'s own README lives one level down, inside the subfolder');
  assert.ok(existsSync(path.join(shared(dest), 'Brain', 'Public.md')));

  await clearSnapshot(dest, env);
  assert.equal(await readFile(path.join(dest, 'README.md'), 'utf8'), 'this is the user\'s own root README, not ours', 'clear never touches the destination root either');
});

// N2, second layer: even inside the dedicated subfolder, a file BrainLink didn't create itself is
// never overwritten or later deleted, e.g. a sync conflict copy or a coincidental name collision
// from a previous, differently-configured vault.
test('snapshot N2: a foreign file already occupying a wanted path inside the subfolder is left untouched', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-n2-collide');
  await mkdir(path.join(shared(dest), 'Brain'), { recursive: true });
  await writeFile(path.join(shared(dest), 'Brain', 'Public.md'), 'NOT OURS: a pre-existing file at the exact path we want');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);
  assert.equal(await readFile(path.join(shared(dest), 'Brain', 'Public.md'), 'utf8'), 'NOT OURS: a pre-existing file at the exact path we want', 'never overwritten since we did not create it');

  const manifest = JSON.parse(await readFile(manifestPath(dest, env), 'utf8'));
  assert.ok(!manifest.files['Brain/Public.md'], 'not claimed as ours in the manifest, so a later run cannot delete it either');

  const r2 = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r2.ok, true);
  assert.equal(await readFile(path.join(shared(dest), 'Brain', 'Public.md'), 'utf8'), 'NOT OURS: a pre-existing file at the exact path we want', 'still untouched on a later run, since it was never claimed');
});

// N3: a destination that is itself a symlink (e.g. a user picks a shortcut to their Drive folder)
// is safely handled -- writes land in the real target (normal fs symlink-following), and a later
// clear only ever deletes paths that resolve, via realpath, inside that real target (safeDeletePath
// already enforces this for every deletion, symlinked destination or not).
test('snapshot N3: a symlinked destination is followed safely for both write and clear', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const { ctx, cfg, env } = await setupVaults();
  const realDest = await tmp('dest-n3-real');
  const linkDest = path.join(tmpdir(), `bl-snap-n3-link-${process.pid}-${Date.now()}`);
  await symlink(realDest, linkDest, 'dir');
  t.after(async () => { const { unlink } = await import('node:fs/promises'); await unlink(linkDest).catch(() => {}); });

  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: linkDest });
  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);
  assert.equal(await readFile(path.join(realDest, 'BrainLink Shared', 'Brain', 'Public.md'), 'utf8'), '# Public\nhello', 'write lands in the real target, not a broken path');

  await clearSnapshot(linkDest, env);
  assert.ok(!existsSync(path.join(realDest, 'BrainLink Shared', 'Brain', 'Public.md')), 'clear through the symlink removes the real file');
});

test('snapshot: an exclusion at the vault root also hides nested descendants (e.g. "sub/Secret/x.md")', async () => {
  const { vaultDir, ctx, cfg, env } = await setupVaults();
  await mkdir(path.join(vaultDir, 'sub', 'Secret'), { recursive: true });
  await writeFile(path.join(vaultDir, 'sub', 'Secret', 'x.md'), 'nested but still excluded');
  await writeFile(path.join(vaultDir, 'sub', 'Public2.md'), '# Public2\nhello again');
  const dest = await tmp('dest-nested-excl');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.noteCount, 2, 'Public.md and sub/Public2.md only');
  assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'sub', 'Secret')), 'nested excluded folder never copied into the snapshot');
  assert.ok(existsSync(path.join(shared(dest), 'Brain', 'sub', 'Public2.md')));
});

// P0-3: a manifest planted *inside* the snapshot folder itself used to be untrusted input (anyone
// with write access to that folder — a cloud peer, a sync conflict — could plant or edit one, and
// BrainLink would read it back on the next write/clear). Now that the manifest lives under
// appHome (manifestPath above), a fake dest/manifest.json is simply never read at all, which is
// the primary fix. safeDeletePath's own path-containment check is kept and tested here too, as a
// second layer, directly against the real (appHome) manifest.
test('snapshot: a manifest planted inside the shared folder itself is never read (moved out of reach)', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-malicious');
  const outside = await tmp('outside-victim');
  const victim = path.join(outside, 'victim.txt');
  await writeFile(victim, 'do not delete me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env); // establish the real manifest (under appHome) first

  const maliciousManifest = { generated_at: 'x', files: {
    '../outside-escape/victim.txt': { sha12: 'x', updated_at: 'x' },
    [path.join(outside, 'victim.txt')]: { sha12: 'x', updated_at: 'x' }, // absolute path
    '..': { sha12: 'x', updated_at: 'x' },
  } };
  await writeFile(path.join(dest, 'manifest.json'), JSON.stringify(maliciousManifest)); // old attack location

  const r2 = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r2.ok, true);
  assert.equal(await readFile(victim, 'utf8'), 'do not delete me', 'write path never touched a file outside the snapshot folder');
  assert.ok(existsSync(path.join(shared(dest), 'Brain', 'Public.md')), 'a fake dest/manifest.json has no effect at all: still not read from there');
  assert.ok(existsSync(dest), 'the snapshot folder itself survives');

  await writeFile(path.join(dest, 'manifest.json'), JSON.stringify(maliciousManifest));
  await clearSnapshot(dest, env);
  assert.equal(await readFile(victim, 'utf8'), 'do not delete me', 'clearSnapshot never touched a file outside the snapshot folder');
});

// Second layer: even if the real (appHome) manifest were somehow tampered with, safeDeletePath's
// own containment check still rejects a key that doesn't resolve inside dest.
test('snapshot: safeDeletePath still contains a traversal attempt in the real (appHome) manifest', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-malicious-real');
  const outside = await tmp('outside-victim-real');
  const victim = path.join(outside, 'victim.txt');
  await writeFile(victim, 'do not delete me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);

  const maliciousManifest = { generated_at: 'x', files: {
    '../outside-escape/victim.txt': { sha12: 'x', updated_at: 'x' },
    [path.join(outside, 'victim.txt')]: { sha12: 'x', updated_at: 'x' },
    '..': { sha12: 'x', updated_at: 'x' },
  } };
  await writeFile(manifestPath(dest, env), JSON.stringify(maliciousManifest));

  const r2 = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r2.ok, true);
  assert.equal(await readFile(victim, 'utf8'), 'do not delete me');

  await writeFile(manifestPath(dest, env), JSON.stringify(maliciousManifest));
  await clearSnapshot(dest, env);
  assert.equal(await readFile(victim, 'utf8'), 'do not delete me');
});

// 5b: v1.2.0/v1.2.1 tracked the manifest inside `dest` itself (see the P0-3 tests above); a bug of
// that era could have copied a private note or one under an excluded folder (e.g. 00 Home) into
// `dest` before it was fixed. Moving the manifest under appHome means a fresh install sees no
// history for that dest. The one-time, marker-gated migration (readManifest no longer falls back
// to the legacy file at all — see R1/N1 below) re-reads that old manifest exactly once and deletes
// a legacy key only when the bytes it names in `dest` are byte-for-byte identical to the real
// vault file at that path right now — simulating a leaked *exact* copy, which is what the old bug
// actually produced (it copied raw file bytes verbatim).
test('snapshot: upgrading from 1.2.1 purges a stale private-note/00-Home copy left in the shared folder', async () => {
  const { vaultDir, ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-upgrade');
  const privateRaw = await readFile(path.join(vaultDir, 'Private.md'), 'utf8'); // '---\nprivate: true\n---\nshh'
  await writeFile(path.join(vaultDir, '.brainlinkignore'), 'Secret/\n00 Home/\n');
  await mkdir(path.join(vaultDir, '00 Home'), { recursive: true });
  await writeFile(path.join(vaultDir, '00 Home', 'Diary.md'), 'very personal notes'); // excluded, but still a real vault file
  await mkdir(path.join(dest, 'Brain', '00 Home'), { recursive: true });
  await writeFile(path.join(dest, 'Brain', 'Private.md'), privateRaw); // leaked by the pre-fix bug: byte-identical to the vault file
  await writeFile(path.join(dest, 'Brain', '00 Home', 'Diary.md'), 'very personal notes'); // also byte-identical
  const legacyManifest = { generated_at: 'x', files: {
    'Brain/Public.md': { sha12: 'x', updated_at: 'x' },
    'Brain/Private.md': { sha12: 'x', updated_at: 'x' },
    'Brain/00 Home/Diary.md': { sha12: 'x', updated_at: 'x' },
  } };
  await writeFile(path.join(dest, 'manifest.json'), JSON.stringify(legacyManifest)); // old (pre-1.2.2) location
  assert.ok(!existsSync(manifestPath(dest, env)), 'no manifest at the new location yet: a genuine fresh upgrade');

  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);

  assert.ok(!existsSync(path.join(dest, 'Brain', 'Private.md')), 'stale leaked private note is purged on the first post-upgrade write');
  assert.ok(!existsSync(path.join(dest, 'Brain', '00 Home', 'Diary.md')), 'stale leaked 00 Home copy is purged on the first post-upgrade write');
  assert.ok(existsSync(path.join(shared(dest), 'Brain', 'Public.md')), 'still-current note is untouched');
  assert.ok(existsSync(path.join(dest, 'manifest.json')), 'the old in-folder manifest is never deleted by BrainLink -- it may not even be ours (N1)');
});

// R1/N1: the fix. readManifest no longer falls back to dest/manifest.json at all (that fallback is
// what let a planted or pre-existing manifest.json drive deletion on first enable, after a clear,
// after a folder switch, or on a corrupt appHome manifest), and neither write nor clear ever
// unlinks dest/manifest.json unconditionally (that file might not be BrainLink's).
test('snapshot R1/N1: a planted dest/manifest.json never deletes real user files, on first enable, after clear, after a folder switch, or with a corrupt appHome manifest', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const plant = async (dest) => {
    await mkdir(path.join(dest, 'user'), { recursive: true });
    await mkdir(path.join(dest, 'Brain'), { recursive: true });
    await writeFile(path.join(dest, 'user', 'mine.txt'), 'my own file');
    await writeFile(path.join(dest, 'Brain', 'user-written.md'), 'not written by BrainLink');
    await writeFile(path.join(dest, 'manifest.json'), JSON.stringify({ generated_at: 'x', files: {
      'user/mine.txt': { sha12: 'x', updated_at: 'x' },
      'Brain/user-written.md': { sha12: 'x', updated_at: 'x' },
    } }));
  };
  const survives = async (dest) => {
    assert.equal(await readFile(path.join(dest, 'user', 'mine.txt'), 'utf8'), 'my own file');
    assert.equal(await readFile(path.join(dest, 'Brain', 'user-written.md'), 'utf8'), 'not written by BrainLink');
  };

  // First enable.
  const destFirst = await tmp('dest-r1-first');
  await plant(destFirst);
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: destFirst }), env);
  await survives(destFirst);

  // After a clear + re-plant + re-enable.
  const destClear = await tmp('dest-r1-clear');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: destClear }), env);
  await clearSnapshot(destClear, env);
  await plant(destClear);
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: destClear }), env);
  await survives(destClear);

  // Folder switch: a fresh dest, never seen before, with a planted legacy manifest.
  const destSwitch = await tmp('dest-r1-switch');
  await plant(destSwitch);
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: destSwitch }), env);
  await survives(destSwitch);

  // Corrupt appHome manifest: must never fall back to the in-folder one.
  const destCorrupt = await tmp('dest-r1-corrupt');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: destCorrupt }), env); // seed a real appHome manifest + migration marker
  await writeFile(manifestPath(destCorrupt, env), '{not valid json');
  await plant(destCorrupt);
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: destCorrupt }), env);
  await survives(destCorrupt);
});

// A user's own manifest.json sitting in the shared folder (e.g. a web or extension project also
// synced there) must never be modified or deleted by BrainLink, on write or on clear.
test('snapshot R1/N1: a user\'s own dest/manifest.json survives write and clear untouched', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-r1-ownmanifest');
  const ownManifest = JSON.stringify({ not: 'ours', version: 3 });
  await writeFile(path.join(dest, 'manifest.json'), ownManifest);
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(await readFile(path.join(dest, 'manifest.json'), 'utf8'), ownManifest, 'untouched after write');
  await clearSnapshot(dest, env);
  assert.equal(await readFile(path.join(dest, 'manifest.json'), 'utf8'), ownManifest, 'untouched after clear');
});

test('snapshot: removing or excluding a note propagates, without touching foreign files', async () => {
  const { vaultDir, ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-removal');
  await writeFile(path.join(dest, 'my-own-file.txt'), 'keep me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.ok(existsSync(path.join(shared(dest), 'Brain', 'Public.md')));

  await writeFile(path.join(vaultDir, '.brainlinkignore'), 'Secret/\nPublic.md\n');
  const r2 = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r2.noteCount, 0);
  assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'Public.md')), 'newly excluded note is deleted from the snapshot');
  const manifest = JSON.parse(await readFile(manifestPath(dest, env), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['README.md', 'index.md']);
  assert.equal(await readFile(path.join(dest, 'my-own-file.txt'), 'utf8'), 'keep me');
});

test('snapshot: marking a previously-shared note private removes it too', async () => {
  const { vaultDir, ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-private');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.ok(existsSync(path.join(shared(dest), 'Brain', 'Public.md')));
  await writeFile(path.join(vaultDir, 'Public.md'), '---\nprivate: true\n---\n# Public\nhello');
  const r2 = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r2.noteCount, 0);
  assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'Public.md')));
});

test('snapshot: clearing removes only files BrainLink wrote', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-clear');
  await writeFile(path.join(dest, 'my-own-file.txt'), 'keep me');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.ok(existsSync(manifestPath(dest, env)));

  await clearSnapshot(snapshotSettings(withSnapshot).folder, env);
  assert.ok(!existsSync(manifestPath(dest, env)));
  assert.ok(!existsSync(path.join(shared(dest), 'README.md')));
  assert.ok(!existsSync(path.join(shared(dest), 'index.md')));
  assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'Public.md')));
  assert.equal(await readFile(path.join(dest, 'my-own-file.txt'), 'utf8'), 'keep me');
});

test('snapshot: includeSessions opts in non-private session summaries only', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const store = await openSessionStore(env);
  await store.putSession({ client: 'codex', source_id: 'pub', project: 'x', title: 'Public chat', summary: 'public summary', started_at: '2026-10-10T00:00:00Z', messages: [] });
  await store.putSession({ client: 'codex', source_id: 'priv', project: 'x', title: 'Private chat', summary: 'private summary', started_at: '2026-10-10T00:00:00Z', messages: [], private: true });

  const dest1 = await tmp('dest-no-sessions');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: dest1 }), env);
  assert.ok(!existsSync(path.join(shared(dest1), 'sessions.json')), 'left out by default');

  const dest2 = await tmp('dest-with-sessions');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: dest2, includeSessions: true }), env);
  const sessions = JSON.parse(await readFile(path.join(shared(dest2), 'sessions.json'), 'utf8')).sessions;
  assert.deepEqual(sessions.map((s) => s.summary), ['public summary']);
});

test('snapshot: atomic write leaves no temp files behind', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-atomic');
  await writeSnapshotOnce(ctx, chooseSnapshot(cfg, { enabled: true, folder: dest }), env);
  const names = await readdir(path.join(shared(dest), 'Brain'));
  assert.ok(!names.some((n) => n.includes('.tmp-')));
});

test('snapshot: suggestSnapshotFolder finds a Google Drive for desktop folder', async () => {
  const home = await tmp('home-gdrive');
  assert.equal(suggestSnapshotFolder(home), null);
  const drive = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive');
  await mkdir(drive, { recursive: true });
  assert.equal(suggestSnapshotFolder(home), drive);
});

test('snapshot: status file tracks last synced time, count and error', async () => {
  const file = path.join(await tmp('status'), 'snapshot-state.json');
  assert.deepEqual(await loadSnapshotStatus(file), { lastSyncedAt: null, noteCount: 0, error: null });
  const ok = await saveSnapshotStatus(file, { ok: true, noteCount: 3, syncedAt: '2026-10-21T00:00:00Z' });
  assert.deepEqual(ok, { lastSyncedAt: '2026-10-21T00:00:00Z', noteCount: 3, error: null });
  const failed = await saveSnapshotStatus(file, { ok: false, error: 'Shared folder not found' });
  assert.equal(failed.error, 'Shared folder not found');
  assert.equal(failed.lastSyncedAt, '2026-10-21T00:00:00Z', 'keeps the last good sync time on a later error');
});

test('snapshot: watcher runs once immediately and stop() prevents further runs', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-watch');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  const results = [];
  const w = startSnapshotWatcher(ctx, withSnapshot, env, { debounceMs: 10, intervalMs: 60_000, onResult: (r) => results.push(r) });
  await new Promise((r) => setTimeout(r, 150));
  w.stop();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].noteCount, 1);
});

test('snapshot: watcher is a no-op when the toggle is off', () => {
  const w = startSnapshotWatcher({ enabled: [] }, normalize({}), {});
  assert.doesNotThrow(() => w.stop());
});

// ---- setup.mjs: the Settings toggle, folder picker and clear routes ----

test('setup UI: /api/snapshot turns sharing on, writes once, and state() reports it', async () => {
  const home = await tmp('setup-home');
  const vaultDir = await tmp('setup-vault');
  await writeFile(path.join(vaultDir, 'A.md'), '# A\nhello');
  const dest = await tmp('setup-dest');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, pickSnapshotFolder: async () => dest });
  const api = (method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    await (await api('POST', '/api/vault', { path: vaultDir, name: 'Brain', scaffold: false })).json();
    const st0 = await (await api('GET', '/api/state')).json();
    assert.equal(st0.snapshot.enabled, false);
    assert.equal(st0.snapshot.lastSyncedAt, null);

    const picked = await (await api('POST', '/api/snapshot/pick-folder')).json();
    assert.equal(picked.path, dest);

    const r = await (await api('POST', '/api/snapshot', { enabled: true, folder: dest })).json();
    assert.equal(r.ok, true);
    assert.equal(r.snapshot.noteCount, 2, 'A.md plus the auto-created BrainLink/Home.md map');
    assert.ok(r.snapshot.lastSyncedAt);
    assert.ok(existsSync(manifestPath(dest, env)), 'writes immediately on enabling, not just on the next interval');
    assert.ok(!existsSync(path.join(dest, 'manifest.json')), 'the manifest is kept under appHome, not inside the shared folder');
    assert.ok(existsSync(path.join(shared(dest), 'Brain', 'A.md')));

    const st1 = await (await api('GET', '/api/state')).json();
    assert.equal(st1.snapshot.enabled, true);
    assert.equal(st1.snapshot.noteCount, 2);

    const bad = await api('POST', '/api/snapshot', { enabled: true, folder: 'relative/path' });
    assert.equal(bad.status, 400);

    await (await api('POST', '/api/snapshot/clear')).json();
    assert.ok(!existsSync(manifestPath(dest, env)));
  } finally { s.server.close(); }
});

// S5: refreshSnapshotWatcher ran only at startup and from /api/snapshot — marking a vault private
// or removing it did not restart the watcher, so it kept syncing a vault that should have stopped
// right away (until the app was next restarted). Both routes now call refreshSnapshotWatcher,
// which re-reads the vault's up-to-date private flag and immediately re-syncs.
test('setup UI: /api/vault/private and /api/vault/remove restart the snapshot watcher immediately (S5)', async () => {
  const home = await tmp('setup-home-s5');
  const vaultDir = await tmp('setup-vault-s5');
  await writeFile(path.join(vaultDir, 'A.md'), '# A\nhello');
  const dest = await tmp('setup-dest-s5');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, pickSnapshotFolder: async () => dest });
  const api = (method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    await (await api('POST', '/api/vault', { path: vaultDir, name: 'Brain', scaffold: false })).json();
    await (await api('POST', '/api/snapshot', { enabled: true, folder: dest })).json();
    assert.ok(existsSync(path.join(shared(dest), 'Brain', 'A.md')), 'shared while the vault is public');

    await (await api('POST', '/api/vault/private', { name: 'Brain', private: true })).json();
    const st1 = await (await api('GET', '/api/state')).json();
    assert.equal(st1.snapshot.noteCount, 0, 'marking the vault private re-synced immediately, not just on next restart');
    assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'A.md')), "the now-private vault's note is gone from the shared folder right away");

    await (await api('POST', '/api/vault/private', { name: 'Brain', private: false })).json();
    await (await api('POST', '/api/snapshot', { enabled: true, folder: dest })).json(); // back to public: re-share
    assert.ok(existsSync(path.join(shared(dest), 'Brain', 'A.md')));

    await (await api('POST', '/api/vault/remove', { name: 'Brain' })).json();
    const st2 = await (await api('GET', '/api/state')).json();
    // Item 5: removing the last vault must not leave its notes sitting in the shared folder
    // (e.g. synced to the cloud via Google Drive) forever just because nothing is left enabled
    // to ever clean them up on a later write.
    assert.ok(!existsSync(path.join(shared(dest), 'Brain', 'A.md')), "removing the last vault clears its notes from the shared snapshot folder right away");
    assert.equal(st2.snapshot.noteCount, 0, 'removing the last vault refreshed the watcher immediately, which now reports nothing to share');
  } finally { s.server.close(); }
});
