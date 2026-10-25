// User-reviewed GitHub shared-note preview, selected commit/push, and add-only import operations.
// Repository changes and vault writes remain separate, explicit actions with privacy checks.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findSecrets, loadVault, vaultRoot, parseFrontmatter, isPrivateMeta, fmSaysPrivate } from '../core.mjs';

const run = promisify(execFile);
const NOTES_ROOT = 'BrainLink/notes';
const MAX_SELECTED_NOTES = 100;
const MAX_REMOTE_NOTE_BYTES = 1024 * 1024;
const within = (root, child) => child === root || child.startsWith(root + path.sep);

async function git(repo, args) {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
    return stdout.trim();
  } catch {
    // Git stderr may contain a credential-bearing remote URL. Never relay it to Setup or logs.
    throw new Error('Could not inspect this local Git repository. Confirm Git is installed and the repository is readable.');
  }
}

async function gitRaw(repo, args, env = process.env, timeout = 15000) {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], { windowsHide: true, timeout, maxBuffer: 1024 * 1024, env });
    return stdout;
  } catch {
    throw new Error('Git could not complete the requested local operation. Check the repository and Git identity, then retry.');
  }
}

function isGitHubRemote(remote) {
  if (!remote || /[\r\n]/.test(remote)) return false;
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (scp) return true;
  try {
    const u = new URL(remote);
    if (u.hostname.toLowerCase() !== 'github.com' || u.username || u.password || u.search || u.hash || (u.port && u.port !== '443')) return false;
    if (!['https:', 'ssh:'].includes(u.protocol)) return false;
    if (u.protocol === 'ssh:' && u.username !== 'git') return false;
    return /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(u.pathname);
  } catch { return false; }
}

async function fetchTrackedOrigin(root) {
  if (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('The local repository has changes. Commit or safely set them aside before checking GitHub.');
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const match = /^origin\/(.+)$/.exec(upstream);
  if (!match) throw new Error('Configure this branch to track its matching origin branch before using GitHub sharing.');
  const branch = match[1];
  if (branch.startsWith('-') || branch.includes('..') || branch.endsWith('/') || branch.includes('//') || /[\s~^:?*\[\\]/.test(branch)) throw new Error('The tracked origin branch name is not safe.');
  await gitRaw(root, ['fetch', '--no-tags', 'origin', branch], process.env, 120000);
  return { branch, ref: `refs/remotes/origin/${branch}` };
}

async function readSafeRemoteNotes(root, ref) {
  const tree = await gitRaw(root, ['ls-tree', '-rlz', '--full-tree', ref, '--', NOTES_ROOT]);
  const entries = tree.split('\0').filter(Boolean);
  if (entries.length > 2000) throw new Error('The shared notes repository is too large to inspect safely in one request.');
  const result = [];
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const header = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)(?: +(\d+))?$/.exec(entry.slice(0, tab));
    if (!header) continue;
    const [, mode, type, oid, sizeText] = header;
    const relative = entry.slice(tab + 1);
    if (type !== 'blob' || mode !== '100644' || !relative.startsWith(`${NOTES_ROOT}/`)) continue;
    const notePath = relative.slice(NOTES_ROOT.length + 1);
    if (!safeNotePath(notePath) || !notePath.toLowerCase().endsWith('.md')) continue;
    const bytes = Number(sizeText);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_REMOTE_NOTE_BYTES) continue;
    const raw = await gitRaw(root, ['show', `${oid}`]);
    if (Buffer.byteLength(raw, 'utf8') !== bytes) continue;
    const { meta, frontmatter } = parseFrontmatter(raw);
    if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || meta.generated_by === 'brainlink' || /^BrainLink\/Commands\//i.test(notePath) || findSecrets(raw).length) continue;
    result.push({ path: notePath, title: String(meta.title || path.posix.basename(notePath, '.md')).slice(0, 160), raw });
  }
  return result;
}

async function repositoryRoot(repoPath) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('Choose an absolute path to an existing local GitHub repository clone.');
  let chosen;
  try { chosen = await realpath(repoPath); } catch { throw new Error('The selected repository folder is unavailable.'); }
  const rootText = await git(chosen, ['rev-parse', '--show-toplevel']);
  let root;
  try { root = await realpath(rootText); } catch { throw new Error('The selected folder is not a readable Git repository.'); }
  if (path.resolve(chosen) !== path.resolve(root)) throw new Error('Choose the repository root folder, not a subfolder.');
  const remote = await git(root, ['config', '--local', '--get', 'remote.origin.url']);
  if (!isGitHubRemote(remote)) throw new Error('The repository origin must be a GitHub URL without embedded credentials.');
  return root;
}

function remoteRepositoryIdentity(remote) {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote || '');
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(remote);
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null;
  } catch { return null; }
}

export async function inspectGitHubRepositoryPath(repoPath) {
  const root = await repositoryRoot(repoPath);
  const remote = await git(root, ['config', '--local', '--get', 'remote.origin.url']);
  const identity = remoteRepositoryIdentity(remote);
  if (!identity) throw new Error('Could not identify this GitHub repository safely.');
  return { path: root, identity };
}

async function assertProfileRepositoryUnique(cfg, profileId, candidate) {
  for (const profile of cfg.twin_profiles || []) {
    if (profile.id === profileId || !profile.github_repository) continue;
    let existing;
    try { existing = await inspectGitHubRepositoryPath(profile.github_repository); }
    catch { throw new Error(`The GitHub repository assignment for profile "${profile.id}" cannot be verified. Repair or clear it before continuing.`); }
    if (path.resolve(existing.path).toLowerCase() === path.resolve(candidate.path).toLowerCase() || existing.identity === candidate.identity) {
      throw new Error(`The GitHub repository is already assigned to profile "${profile.id}". Each profile needs its own repository.`);
    }
  }
}

export async function assignGitHubRepositoryToProfile(cfg, profileId, repoPath) {
  const profile = (cfg.twin_profiles || []).find((item) => item.id === profileId);
  if (!profile) throw new Error('Choose a configured Twin profile before assigning a GitHub repository.');
  const repository = await inspectGitHubRepositoryPath(repoPath);
  await assertProfileRepositoryUnique(cfg, profileId, repository);
  profile.github_repository = repository.path;
  return { profile_id: profile.id, repository_path: repository.path, repository: repository.identity };
}

export async function resolveGitHubProfileRepository(cfg, { profileId, vaultName, legacyRepoPath }) {
  const profiles = Array.isArray(cfg.twin_profiles) ? cfg.twin_profiles : [];
  if (!profiles.length) return { profile_id: null, repository_path: legacyRepoPath };
  if (typeof profileId !== 'string' || !profileId) throw new Error('Choose the Twin profile for this GitHub operation.');
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error('The selected Twin profile is not configured.');
  if (!profile.vaults?.some((item) => item.name === vaultName)) throw new Error(`Vault "${vaultName}" is outside the selected Twin profile.`);
  if (!profile.github_repository) throw new Error('Assign a separate GitHub repository to this Twin profile in Setup first.');
  const repository = await inspectGitHubRepositoryPath(profile.github_repository);
  await assertProfileRepositoryUnique(cfg, profile.id, repository);
  return { profile_id: profile.id, repository_path: repository.path, repository: repository.identity };
}

function safeNotePath(value) {
  if (typeof value !== 'string' || value.length > 500 || !value.endsWith('.md') || /[\\:\x00-\x1f]/.test(value)) return false;
  const parts = value.split('/');
  return parts.length > 0 && parts.every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.'));
}

async function rejectSymlinkPath(root, rel) {
  let cursor = root;
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('The repository contains a symbolic link in the selected notes area.');
    if (cursor !== path.join(root, ...rel.split('/')) && !info.isDirectory()) throw new Error('The repository notes path is not a directory.');
  }
}

async function ensureSafeParentDirectories(root, rel) {
  const parts = rel.split('/').slice(0, -1);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try { await mkdir(cursor); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('A selected vault folder is not a safe directory.');
    const resolved = await realpath(cursor);
    if (!within(root, resolved)) throw new Error('A selected vault folder resolves outside the vault.');
  }
}

export async function listGitHubShareCandidates(ctx, vaultName) {
  const vault = ctx.byName.get(vaultName);
  if (!vault || !ctx.enabled.includes(vaultName)) throw new Error('Choose an enabled vault.');
  if (vault.private) throw new Error('Private vaults are not eligible for GitHub sharing.');
  const index = await loadVault(ctx, vaultName);
  return index.notes
    .filter((note) => !note.private && !note.generated && !findSecrets(note.raw).length)
    .map(({ rel, title }) => ({ path: rel, title }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function previewGitHubRepository({ ctx, repoPath, vaultName, paths }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SELECTED_NOTES || paths.some((p) => !safeNotePath(p)) || new Set(paths).size !== paths.length) {
    throw new Error(`Select 1–${MAX_SELECTED_NOTES} distinct Markdown paths from the visible notes list.`);
  }
  const vault = ctx.byName.get(vaultName);
  if (!vault || !ctx.enabled.includes(vaultName)) throw new Error('Choose an enabled vault.');
  if (vault.private) throw new Error('Private vaults are not eligible for GitHub sharing.');
  const index = await loadVault(ctx, vaultName);
  const byPath = new Map(index.notes.filter((note) => !note.private && !note.generated).map((note) => [note.rel, note]));
  if (paths.some((p) => !byPath.has(p))) throw new Error('One or more selected notes are unavailable for sharing in this vault.');

  // Secret scanning happens before any candidate is described as publishable.
  const notes = paths.map((p) => byPath.get(p));
  if (notes.some((note) => findSecrets(note.raw).length)) throw new Error('A selected note needs a privacy review before it can be shared.');

  const root = await repositoryRoot(repoPath);
  const files = [];
  for (const note of notes) {
    const relative = `${NOTES_ROOT}/${note.rel}`;
    const target = path.resolve(root, ...relative.split('/'));
    if (!within(root, target)) throw new Error('The selected notes path is outside the repository.');
    await rejectSymlinkPath(root, relative);
    const dirty = await git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', relative]);
    if (dirty) {
      files.push({ path: note.rel, action: 'blocked_local_change' });
      continue;
    }
    let existing;
    try { existing = await readFile(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not safely read a selected repository note.'); }
    files.push({ path: note.rel, action: existing == null ? 'add' : existing === note.raw ? 'unchanged' : 'update' });
  }
  const counts = Object.fromEntries(['add', 'update', 'unchanged', 'blocked_local_change'].map((action) => [action, files.filter((f) => f.action === action).length]));
  return {
    provider: 'github', vault: vaultName, preview_only: true,
    local_checkout: true, remote_state: 'not_checked',
    files, counts,
    notice: 'Read-only preview. No Git files, credentials, configuration, or remote repository were changed or contacted.',
  };
}

async function eligibleRemoteNotes({ ctx, repoPath, vaultName }) {
  const vault = ctx.byName.get(vaultName);
  if (!vault || !ctx.enabled.includes(vaultName)) throw new Error('Choose an enabled vault.');
  if (vault.private) throw new Error('Private vaults are not eligible for GitHub sharing.');
  const root = await repositoryRoot(repoPath);
  const { branch, ref } = await fetchTrackedOrigin(root);
  const notes = await readSafeRemoteNotes(root, ref);
  const localRoot = vaultRoot(ctx, vaultName);
  const files = [];
  for (const note of notes) {
    const target = path.resolve(localRoot, ...note.path.split('/'));
    if (!within(localRoot, target)) continue;
    await rejectSymlinkPath(localRoot, note.path);
    let current;
    try { current = await readFile(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not safely inspect a selected local note.'); }
    files.push({ path: note.path, title: note.title, action: current == null ? 'add' : current === note.raw ? 'unchanged' : 'conflict' });
  }
  return { root, localRoot, branch, ref, notes, files };
}

// Reviewable remote-to-vault flow. It imports only selected, public Markdown notes that do
// not already exist; divergent local notes are reported as conflicts and are never overwritten.
export async function listGitHubPullCandidates(options) {
  const { branch, files } = await eligibleRemoteNotes(options);
  return { provider: 'github', branch, files, notice: 'Remote notes were fetched and privacy-filtered. Preview metadata only; no vault files were changed.' };
}

export async function importGitHubSelectedNotes({ ctx, repoPath, vaultName, paths }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SELECTED_NOTES || paths.some((p) => !safeNotePath(p)) || new Set(paths).size !== paths.length) {
    throw new Error(`Select 1–${MAX_SELECTED_NOTES} distinct Markdown paths from the visible remote notes list.`);
  }
  const current = await eligibleRemoteNotes({ ctx, repoPath, vaultName });
  const remote = new Map(current.notes.map((note) => [note.path, note]));
  const fileState = new Map(current.files.map((file) => [file.path, file]));
  if (paths.some((p) => !remote.has(p))) throw new Error('One or more selected remote notes are unavailable or failed privacy checks.');
  const selected = paths.map((p) => ({ note: remote.get(p), state: fileState.get(p) }));
  const conflicts = selected.filter((x) => x.state.action === 'conflict');
  if (conflicts.length) throw new Error(`No notes were imported because ${conflicts.length} selected path(s) conflict with local content. Resolve conflicts manually, then retry.`);
  const toAdd = selected.filter((x) => x.state.action === 'add');
  if (!toAdd.length) return { provider: 'github', imported: [], unchanged: selected.map((x) => x.note.path), conflicts: [], branch: current.branch };

  const written = [];
  try {
    for (const { note } of toAdd) {
      const target = path.resolve(current.localRoot, ...note.path.split('/'));
      if (!within(current.localRoot, target)) throw new Error('A selected remote note is outside the vault.');
      await rejectSymlinkPath(current.localRoot, note.path);
      await mkdir(path.dirname(target), { recursive: true });
      await rejectSymlinkPath(current.localRoot, note.path);
      await writeFile(target, note.raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      written.push(target);
    }
  } catch {
    for (const target of written.reverse()) await rm(target, { force: true }).catch(() => {});
    throw new Error('Could not safely import the selected remote notes. No selected files were intentionally overwritten; retry after checking the vault.');
  }
  return { provider: 'github', imported: toAdd.map((x) => x.note.path), unchanged: selected.filter((x) => x.state.action === 'unchanged').map((x) => x.note.path), conflicts: [], branch: current.branch };
}

// Preserve both sides of a remote/local divergence without silently choosing a winner.
// The selected remote version is saved beside a clearly named copy; the local file is untouched.
export async function saveGitHubConflictCopies({ ctx, repoPath, vaultName, paths }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SELECTED_NOTES || paths.some((p) => !safeNotePath(p)) || new Set(paths).size !== paths.length) {
    throw new Error(`Select 1–${MAX_SELECTED_NOTES} distinct Markdown conflict paths.`);
  }
  const current = await eligibleRemoteNotes({ ctx, repoPath, vaultName });
  const remote = new Map(current.notes.map((note) => [note.path, note]));
  const state = new Map(current.files.map((file) => [file.path, file]));
  if (paths.some((p) => !remote.has(p) || state.get(p)?.action !== 'conflict')) {
    throw new Error('Select only current remote notes that conflict with local content. No conflict copies were saved.');
  }

  const planned = paths.map((notePath) => {
    const note = remote.get(notePath);
    const digest = createHash('sha256').update(note.raw, 'utf8').digest('hex').slice(0, 12);
    const parsed = path.posix.parse(notePath);
    const copyPath = path.posix.join('BrainLink Conflicts', parsed.dir, `${parsed.name}.remote-${digest}${parsed.ext}`);
    return { note, copyPath };
  });
  const created = [];
  const saved = [];
  try {
    for (const { note, copyPath } of planned) {
      const target = path.resolve(current.localRoot, ...copyPath.split('/'));
      if (!within(current.localRoot, target)) throw new Error('A conflict copy path is outside the selected vault.');
      await rejectSymlinkPath(current.localRoot, copyPath);
      let existing;
      try { existing = await readFile(target, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not safely inspect a conflict-copy destination.'); }
      if (existing != null) {
        if (existing !== note.raw) throw new Error('A conflict-copy destination already contains different content. No local notes were changed.');
        saved.push({ source: note.path, copy: copyPath, action: 'unchanged' });
        continue;
      }
      await ensureSafeParentDirectories(current.localRoot, copyPath);
      await rejectSymlinkPath(current.localRoot, copyPath);
      await writeFile(target, note.raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      created.push(target);
      saved.push({ source: note.path, copy: copyPath, action: 'saved' });
    }
  } catch {
    for (const target of created.reverse()) await rm(target, { force: true }).catch(() => {});
    throw new Error('Could not safely save the selected remote conflict copies. Local notes were preserved; retry after checking the vault.');
  }
  return { provider: 'github', saved, branch: current.branch, local_notes_overwritten: false };
}

// Explicitly publishes selected notes to a local checkout and records one local commit.
// It requires a completely clean checkout so rollback cannot disturb unrelated user work.
// It never fetches or pushes; callers must obtain the user's explicit confirmation first.
export async function commitGitHubSelectedNotes({ ctx, repoPath, vaultName, paths }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SELECTED_NOTES || paths.some((p) => !safeNotePath(p)) || new Set(paths).size !== paths.length) {
    throw new Error(`Select 1–${MAX_SELECTED_NOTES} distinct Markdown paths from the visible notes list.`);
  }
  const vault = ctx.byName.get(vaultName);
  if (!vault || !ctx.enabled.includes(vaultName)) throw new Error('Choose an enabled vault.');
  if (vault.private) throw new Error('Private vaults are not eligible for GitHub sharing.');
  const index = await loadVault(ctx, vaultName);
  const byPath = new Map(index.notes.filter((note) => !note.private && !note.generated).map((note) => [note.rel, note]));
  if (paths.some((p) => !byPath.has(p))) throw new Error('One or more selected notes are unavailable for sharing in this vault.');
  const notes = paths.map((p) => byPath.get(p));
  if (notes.some((note) => findSecrets(note.raw).length)) throw new Error('A selected note needs a privacy review before it can be shared.');

  const root = await repositoryRoot(repoPath);
  if (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('The local repository has changes. Commit or safely set them aside before publishing selected notes.');
  }
  try { await git(root, ['rev-parse', '--verify', 'HEAD']); }
  catch { throw new Error('Create the first commit in this repository before publishing notes.'); }

  const records = [];
  for (const note of notes) {
    const relative = `${NOTES_ROOT}/${note.rel}`;
    const target = path.resolve(root, ...relative.split('/'));
    if (!within(root, target)) throw new Error('The selected notes path is outside the repository.');
    await rejectSymlinkPath(root, relative);
    let previous;
    try { previous = await readFile(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not safely read a selected repository note.'); }
    records.push({ note, relative, target, previous, action: previous == null ? 'add' : previous === note.raw ? 'unchanged' : 'update' });
  }
  const changed = records.filter((r) => r.action !== 'unchanged');
  if (!changed.length) return { provider: 'github', vault: vaultName, committed: false, files: records.map(({ note, action }) => ({ path: note.rel, action })), notice: 'All selected notes already match. No commit was created and nothing was pushed.' };

  const written = [];
  let hooksDir;
  let commitCreated = false;
  try {
    for (const record of changed) {
      await mkdir(path.dirname(record.target), { recursive: true });
      await writeFile(record.target, record.note.raw, { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
        // Existing destinations were read above; wx prevents overwriting a file that appeared meanwhile.
        if (error.code !== 'EEXIST' || record.previous == null) throw error;
        const current = await readFile(record.target, 'utf8');
        if (current !== record.previous) throw new Error('A selected repository file changed during publication. Retry the preview.');
        await writeFile(record.target, record.note.raw, { encoding: 'utf8' });
      });
      written.push(record);
    }
    await gitRaw(root, ['add', '--', ...changed.map((r) => r.relative)]);
    const staged = (await gitRaw(root, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean).sort();
    const expected = changed.map((r) => r.relative.replaceAll('\\', '/')).sort();
    if (staged.length !== expected.length || staged.some((p, i) => p !== expected[i])) throw new Error('Git staged an unexpected file set; publication was cancelled.');
    hooksDir = await mkdtemp(path.join(tmpdir(), 'brainlink-empty-hooks-'));
    await gitRaw(root, ['-c', `core.hooksPath=${hooksDir}`, 'commit', '-m', 'BrainLink: update selected shared notes']);
    commitCreated = true;
    const sha = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
    return { provider: 'github', vault: vaultName, committed: true, commit: sha, files: records.map(({ note, action }) => ({ path: note.rel, action })), notice: 'Local commit created. No fetch or push was performed.' };
  } catch (error) {
    // Restore only the files this operation wrote; the initial clean-tree gate prevents collateral damage.
    if (!commitCreated) {
      for (const record of written.reverse()) {
        if (record.previous == null) await rm(record.target, { force: true }).catch(() => {});
        else await writeFile(record.target, record.previous, 'utf8').catch(() => {});
      }
      await gitRaw(root, ['reset', '--quiet', 'HEAD', '--', ...changed.map((r) => r.relative)]).catch(() => {});
    }
    throw error;
  } finally {
    if (hooksDir) await rm(hooksDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Push exactly the single BrainLink note commit just created, and only when its parent
// is still the fetched origin branch tip. This prevents accidentally publishing any
// unrelated local commits. The operation is explicit, never force-pushes, and uses Git's
// configured credential helper. A concurrent remote update fails safely and requires review.
export async function pushGitHubSelectedNotes({ ctx, repoPath, vaultName, paths, commit }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SELECTED_NOTES || paths.some((p) => !safeNotePath(p)) || new Set(paths).size !== paths.length) {
    throw new Error(`Select 1–${MAX_SELECTED_NOTES} distinct Markdown paths from the visible notes list.`);
  }
  if (typeof commit !== 'string' || !/^[a-f0-9]{7,40}$/.test(commit)) throw new Error('The local commit receipt is invalid; create a fresh preview and commit.');
  const vault = ctx.byName.get(vaultName);
  if (!vault || !ctx.enabled.includes(vaultName)) throw new Error('Choose an enabled vault.');
  if (vault.private) throw new Error('Private vaults are not eligible for GitHub sharing.');
  const index = await loadVault(ctx, vaultName);
  const byPath = new Map(index.notes.filter((note) => !note.private && !note.generated).map((note) => [note.rel, note]));
  if (paths.some((p) => !byPath.has(p))) throw new Error('One or more selected notes are unavailable for sharing in this vault.');
  const notes = paths.map((p) => byPath.get(p));
  if (notes.some((note) => findSecrets(note.raw).length)) throw new Error('A selected note needs a privacy review before it can be shared.');

  const root = await repositoryRoot(repoPath);
  if (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('The repository changed after the local commit. Review its state and create a fresh preview.');
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (head !== await git(root, ['rev-parse', commit])) throw new Error('The local HEAD no longer matches this BrainLink commit receipt.');
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const match = /^origin\/(.+)$/.exec(upstream);
  if (!match) throw new Error('Configure this branch to track its matching origin branch before pushing.');
  const branch = match[1];
  if (branch.startsWith('-') || branch.includes('..') || branch.endsWith('/') || branch.includes('//') || /[\s~^:?*\[\\]/.test(branch)) throw new Error('The tracked origin branch name is not safe to push.');
  await gitRaw(root, ['fetch', '--no-tags', 'origin', branch], process.env, 120000);
  const parent = await git(root, ['rev-parse', `${head}^`]);
  const remoteTip = await git(root, ['rev-parse', `refs/remotes/origin/${branch}`]);
  if (parent !== remoteTip) throw new Error('The remote branch changed or this commit includes earlier local work. Nothing was pushed; review and reconcile the branch first.');
  const changed = (await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', head])).split(/\r?\n/).filter(Boolean).sort();
  const expected = paths.map((p) => `${NOTES_ROOT}/${p}`).sort();
  if (changed.length !== expected.length || changed.some((p, i) => p !== expected[i])) throw new Error('This commit includes files outside the selected notes. Nothing was pushed.');
  for (const note of notes) {
    const relative = `${NOTES_ROOT}/${note.rel}`;
    await rejectSymlinkPath(root, relative);
    const content = await readFile(path.resolve(root, ...relative.split('/')), 'utf8').catch(() => null);
    if (content !== note.raw) throw new Error('A selected note differs from the committed content. Refresh the preview before pushing.');
    if (findSecrets(content).length) throw new Error('A selected note failed the final privacy scan. Nothing was pushed.');
  }
  await gitRaw(root, ['push', '--porcelain', 'origin', `HEAD:refs/heads/${branch}`], process.env, 120000);
  return { provider: 'github', pushed: true, commit: head.slice(0, 12), branch, files: paths.map((p) => ({ path: p, action: 'pushed' })), notice: 'The selected note commit was pushed to the tracked GitHub branch. No force-push was used.' };
}
