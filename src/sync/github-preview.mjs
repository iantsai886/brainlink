// Read-only first slice for GitHub-backed shared notes. It inspects an existing local clone;
// it never fetches, stages, commits, pushes, or changes configuration.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { findSecrets, loadVault } from '../core.mjs';

const run = promisify(execFile);
const NOTES_ROOT = 'BrainLink/notes';
const MAX_SELECTED_NOTES = 100;
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

function safeNotePath(value) {
  if (typeof value !== 'string' || value.length > 500 || !value.endsWith('.md') || /[\\:\0\r\n]/.test(value)) return false;
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
