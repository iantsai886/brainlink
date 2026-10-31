// Shared snapshot (Ian's RB8): a read-only, filtered copy of notes for cloud agents with no
// inbound network access. Same filter every other read path uses (excluded folders, private
// notes/vaults); atomic writes; manifest-tracked deletion so foreign files are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

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
async function symlinkOrSkip(t, target, link) {
  const { symlink } = await import('node:fs/promises');
  try { await symlink(target, link, 'dir'); }
  catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32') { t.skip('Windows symlink privilege unavailable'); return false; }
    throw error;
  }
  return true;
}

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
  if (!(await symlinkOrSkip(t, realDest, linkDest))) return;
  t.after(async () => { const { unlink } = await import('node:fs/promises'); await unlink(linkDest).catch(() => {}); });

  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: linkDest });
  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);
  assert.equal(await readFile(path.join(realDest, 'BrainLink Shared', 'Brain', 'Public.md'), 'utf8'), '# Public\nhello', 'write lands in the real target, not a broken path');

  await clearSnapshot(linkDest, env);
  assert.ok(!existsSync(path.join(realDest, 'BrainLink Shared', 'Brain', 'Public.md')), 'clear through the symlink removes the real file');
});

// F3: unlike N3 (dest itself symlinked, handled safely by just following it), a symlink *inside*
// dest -- at outRoot itself, or one level below it -- must be refused, since atomicWrite's
// mkdir+writeFile would otherwise follow it and silently write real note content outside dest.
test('snapshot F3: a symlinked "BrainLink Shared" (outRoot itself) is refused, not written through', async (t) => {
  const { symlink, unlink: rmlink } = await import('node:fs/promises');
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f3-outroot-link');
  const outside = await tmp('outside-f3-outroot');
  if (!(await symlinkOrSkip(t, outside, shared(dest)))) return;
  t.after(() => rmlink(shared(dest)).catch(() => {}));

  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, false, 'refused outright: outRoot itself is a symlink');
  assert.deepEqual(await readdir(outside), [], 'nothing was written through the symlink to the outside folder');
});

test('snapshot F3: a symlinked vault folder inside "BrainLink Shared" is refused, not written through', async (t) => {
  const { symlink, unlink: rmlink } = await import('node:fs/promises');
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f3-vault-link');
  const outside = await tmp('outside-f3-vault');
  await mkdir(shared(dest), { recursive: true });
  if (!(await symlinkOrSkip(t, outside, path.join(shared(dest), 'Brain')))) return;
  t.after(() => rmlink(path.join(shared(dest), 'Brain')).catch(() => {}));

  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, false, 'refused outright: the vault subfolder inside outRoot is a symlink escaping it');
  assert.deepEqual(await readdir(outside), [], 'nothing was written through the symlink to the outside folder');
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

// F1: v1.2.2/v1.2.3 wrote the appHome manifest with keys relative to dest's own root (the
// 'BrainLink Shared' subfolder didn't exist yet). Upgrading must not reinterpret those keys
// relative to the new subfolder (which could delete an unrelated user file that happens to sit
// at that path inside the subfolder), and must prune the orphaned dest-root copies so a note
// made private after the upgrade leaves no stale copy anywhere in dest.
test('snapshot F1: upgrading a v1.2.3 dest-root appHome manifest prunes old copies and never touches the new subfolder', async () => {
  const { vaultDir, ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f1');
  // v1.2.3 copies, written at dest's own root.
  await mkdir(path.join(dest, 'Brain'), { recursive: true });
  await writeFile(path.join(dest, 'Brain', 'Public.md'), '# Public\nhello'); // still current
  await writeFile(path.join(dest, 'README.md'), 'old root readme');
  await writeFile(path.join(dest, 'index.md'), 'old root index');
  // A user file that happens to collide with the same relative path inside the NEW subfolder --
  // must never be deleted just because a v1.2.3 key of the same name exists.
  await mkdir(path.join(shared(dest), 'Brain'), { recursive: true });
  await writeFile(path.join(shared(dest), 'Brain', 'Public.md'), 'NOT OURS: lives in the new subfolder');

  const v123Manifest = { generated_at: 'x', files: {
    'Brain/Public.md': { sha12: sha12('# Public\nhello') },
    'README.md': { sha12: sha12('old root readme') },
    'index.md': { sha12: sha12('old root index') },
  } }; // no "layout" field: this is what a real v1.2.3 appHome manifest looked like
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await mkdir(path.dirname(manifestPath(dest, env)), { recursive: true });
  await writeFile(manifestPath(dest, env), JSON.stringify(v123Manifest));

  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);
  assert.ok(!existsSync(path.join(dest, 'Brain', 'Public.md')), 'stale dest-root copy pruned (still byte-equal to the recorded sha12)');
  assert.ok(!existsSync(path.join(dest, 'README.md')), 'stale dest-root README pruned');
  assert.ok(!existsSync(path.join(dest, 'index.md')), 'stale dest-root index pruned');
  assert.equal(await readFile(path.join(shared(dest), 'Brain', 'Public.md'), 'utf8'), 'NOT OURS: lives in the new subfolder', 'old key never reinterpreted relative to the new subfolder -- the unrelated file there is untouched');

  const manifest = JSON.parse(await readFile(manifestPath(dest, env), 'utf8'));
  assert.equal(manifest.layout, 2, 'a fresh layout-2 manifest is started');

  // Now make Public.md private: no copy of it should survive anywhere in dest.
  await writeFile(path.join(vaultDir, 'Public.md'), '---\nprivate: true\n---\n# Public\nhello');
  await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.ok(!existsSync(path.join(dest, 'Brain', 'Public.md')));
  assert.equal(await readFile(path.join(shared(dest), 'Brain', 'Public.md'), 'utf8'), 'NOT OURS: lives in the new subfolder', 'still untouched -- never claimed as ours');
});

test('snapshot F1: clearSnapshot also resolves an un-migrated (pre-layout-2) manifest against dest, not the subfolder', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f1-clear');
  await writeFile(path.join(dest, 'README.md'), 'old root readme');
  const v123Manifest = { generated_at: 'x', files: { 'README.md': { sha12: sha12('old root readme') } } };
  await mkdir(path.dirname(manifestPath(dest, env)), { recursive: true });
  await writeFile(manifestPath(dest, env), JSON.stringify(v123Manifest));

  await clearSnapshot(dest, env, cfg.vaults);
  assert.ok(!existsSync(path.join(dest, 'README.md')), 'clear removes the dest-root copy named by the un-migrated manifest');
  assert.ok(!existsSync(manifestPath(dest, env)));
});

// F2: a corrupt appHome manifest, with the shared subfolder already non-empty, means ownership
// tracking was lost -- adopting files by content would also adopt a user's own byte-identical
// copy, later deleted the moment the real note changes. Fail closed instead: write nothing,
// delete nothing, keep a .bak, and surface a 'Clear and re-share' action.
test('snapshot F2: a corrupt manifest with existing shared content fails closed, keeps a .bak, and leaves a recovery action', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f2-corrupt');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env); // establish real shared content + a good manifest
  const before = (await readdir(shared(dest), { recursive: true })).sort();

  await writeFile(manifestPath(dest, env), '{not valid json');
  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, false);
  assert.equal(r.action, 'clear_and_reshare');
  assert.equal(await readFile(`${manifestPath(dest, env)}.bak`, 'utf8'), '{not valid json', 'the corrupt manifest is backed up, not lost');

  const after = (await readdir(shared(dest), { recursive: true })).sort();
  assert.deepEqual(after, before, 'nothing was written or deleted while failing closed');
});

// The manifest can go missing (not just corrupt) while BrainLink's own previously-written content
// is still sitting in outRoot -- e.g. appHome got wiped independently of the synced folder. That
// must fail closed too, but a genuine first enable where a foreign file merely collides with a
// wanted path (N2) must still succeed normally: README.md's exact, BrainLink-generated content is
// the signal that tells the two apart (see looksPreviouslyShared in src/snapshot.mjs).
test('snapshot F2: a missing manifest where BrainLink previously shared this folder fails closed', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f2-missing');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env); // establishes real BrainLink-written content, incl. README.md
  await unlink(manifestPath(dest, env)); // simulate appHome manifest loss (not corruption: deletion)

  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, false);
  assert.equal(r.action, 'clear_and_reshare');
  assert.equal(await readFile(path.join(shared(dest), 'Brain', 'Public.md'), 'utf8'), '# Public\nhello', 'untouched');
  assert.ok(!existsSync(manifestPath(dest, env)), 'still no manifest was written');
});

// N2's own collision case must keep succeeding normally even on a genuinely first write: a
// foreign file merely occupying a wanted path (no BrainLink README.md anywhere) is not evidence
// of prior sharing, so there is nothing to fail closed about.
test('snapshot F2: a first-ever write with a pre-existing foreign file in the subfolder is not mistaken for manifest loss', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f2-not-prior');
  await mkdir(path.join(shared(dest), 'Brain'), { recursive: true });
  await writeFile(path.join(shared(dest), 'Brain', 'Public.md'), 'NOT OURS: a pre-existing, unrelated file');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true, 'proceeds normally -- no README.md means no evidence this was ever shared before');
  assert.equal(await readFile(path.join(shared(dest), 'Brain', 'Public.md'), 'utf8'), 'NOT OURS: a pre-existing, unrelated file', 'still never overwritten (N2)');
});

test('snapshot F2: "Clear and re-share" (force clear) resets a stuck folder and a normal write then succeeds', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-f2-recover');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  await writeSnapshotOnce(ctx, withSnapshot, env);
  await writeFile(manifestPath(dest, env), '{not valid json');
  const stuck = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(stuck.ok, false);

  await clearSnapshot(dest, env, cfg.vaults, { force: true });
  assert.ok(!existsSync(shared(dest)), 'the dedicated subfolder is wiped outright by the explicit force-reset');
  assert.ok(!existsSync(`${manifestPath(dest, env)}.bak`), 'the backup is cleaned up too');

  const recovered = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(recovered.ok, true, 're-sharing now succeeds');
  assert.ok(existsSync(path.join(shared(dest), 'Brain', 'Public.md')));
});

// N4: the vault can be the exact same file as the "shared output" location when the vault lives
// at <dest>/<vaultName> -- the layout suggestSnapshotFolder itself suggests. A legacy (or
// current) manifest naming that vault's own relative path must never be able to delete the real
// vault file just because it is byte-identical to itself.
test('snapshot N4: a vault at <dest>/<vaultName> survives a planted legacy manifest naming its own notes', async () => {
  const dest = await tmp('dest-n4');
  const vaultDir = path.join(dest, 'Brain');
  await mkdir(path.join(vaultDir, 'Projects'), { recursive: true });
  await writeFile(path.join(vaultDir, 'Pub.md'), '# Pub\nhello');
  await writeFile(path.join(vaultDir, 'Projects', 'Plan.md'), '# Plan\nhello');
  await writeFile(path.join(vaultDir, 'Other.md'), '# Other\nhello');
  // Planted (or genuinely legacy) manifest naming real vault files relative to dest's own root.
  await writeFile(path.join(dest, 'manifest.json'), JSON.stringify({ files: {
    'Brain/Pub.md': { sha12: 'x' },
    'Brain/Projects/Plan.md': { sha12: 'y' },
  } }));
  const env = { BRAINLINK_HOME: await tmp('n4-home'), BRAINLINK_SEMANTIC: '0' };
  const cfg = normalize({ vaults: [{ name: 'Brain', path: vaultDir }] });
  const ctx = createContext(cfg, { env });
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  const r = await writeSnapshotOnce(ctx, withSnapshot, env);
  assert.equal(r.ok, true);
  assert.ok(existsSync(path.join(vaultDir, 'Pub.md')), 'real vault note survives (not deleted as a stale legacy copy of itself)');
  assert.ok(existsSync(path.join(vaultDir, 'Projects', 'Plan.md')), 'real vault note survives');
  assert.ok(existsSync(path.join(vaultDir, 'Other.md')), 'untouched vault note also survives');

  await clearSnapshot(dest, env, cfg.vaults);
  assert.ok(existsSync(path.join(vaultDir, 'Other.md')), 'vault file still intact after clear');
});

// N5: a dest inside a vault would get walked and copied right back into itself every run,
// growing without end (and the recursive watcher fires on its own writes too). Reject up front.
test('snapshot N5: a destination folder inside a vault is rejected, not written to', async () => {
  const vaultDir = await tmp('n5-vault');
  await writeFile(path.join(vaultDir, 'A.md'), '# A\nhello');
  const dest = path.join(vaultDir, 'share');
  await mkdir(dest, { recursive: true });
  const env = { BRAINLINK_HOME: await tmp('n5-home'), BRAINLINK_SEMANTIC: '0' };
  const cfg = normalize({ vaults: [{ name: 'Brain', path: vaultDir }] });
  const ctx = createContext(cfg, { env });
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });

  for (let i = 0; i < 3; i++) {
    const r = await writeSnapshotOnce(ctx, withSnapshot, env);
    assert.equal(r.ok, false, 'rejected every run, not just the first');
  }
  assert.ok(!existsSync(path.join(dest, 'BrainLink Shared')), 'nothing was ever written inside the vault');
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

test('snapshot: status file tracks last synced time, count, error and recovery action', async () => {
  const file = path.join(await tmp('status'), 'snapshot-state.json');
  assert.deepEqual(await loadSnapshotStatus(file), { lastSyncedAt: null, noteCount: 0, error: null, action: null });
  const ok = await saveSnapshotStatus(file, { ok: true, noteCount: 3, syncedAt: '2026-10-21T00:00:00Z' });
  assert.deepEqual(ok, { lastSyncedAt: '2026-10-21T00:00:00Z', noteCount: 3, error: null, action: null });
  const failed = await saveSnapshotStatus(file, { ok: false, error: 'Shared folder not found' });
  assert.equal(failed.error, 'Shared folder not found');
  assert.equal(failed.lastSyncedAt, '2026-10-21T00:00:00Z', 'keeps the last good sync time on a later error');
  // F2: a 'Clear and re-share' recovery action rides along with the error too.
  const f2 = await saveSnapshotStatus(file, { ok: false, error: 'corrupt', action: 'clear_and_reshare' });
  assert.equal(f2.action, 'clear_and_reshare');
});

test('snapshot: watcher runs once immediately and stop() prevents further runs', async () => {
  const { ctx, cfg, env } = await setupVaults();
  const dest = await tmp('dest-watch');
  const withSnapshot = chooseSnapshot(cfg, { enabled: true, folder: dest });
  const results = [];
  const w = startSnapshotWatcher(ctx, withSnapshot, env, { debounceMs: 10, intervalMs: 60_000, onResult: (r) => results.push(r) });
  const deadline = Date.now() + 3000;
  while (!results.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
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
