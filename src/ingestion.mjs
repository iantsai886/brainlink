// User-invoked Raw-to-Wiki intake. It scans one explicitly selected folder, checks vault and
// path scope plus bounded frontmatter privacy before reading Markdown bodies, and records only
// opaque identifiers and outcomes in the local app-data journal.
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appHome } from './config.mjs';
import { indexableHeader, isExcludedPath, isPrivateMeta, fmSaysPrivate, parseFrontmatter, safeJoin, vault, vaultRoot } from './core.mjs';
import { extractLinks } from './graph.mjs';

const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const MAX_NOTES = 5000;
const MAX_DEPTH = 32;
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

function selectedFolder(value) {
  const folder = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = folder.split('/');
  if (!folder || folder.length > 240 || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || /[:*?"<>|]/.test(p))) {
    throw new Error('Choose one existing, visible folder inside the selected vault. The vault root is not scanned.');
  }
  return { folder, parts };
}

async function checkedFolder(ctx, vaultName, requested) {
  const v = vault(ctx, vaultName);
  if (v.private) throw new Error('Raw-to-Wiki intake is unavailable for a private vault.');
  const { folder, parts } = selectedFolder(requested);
  const root = vaultRoot(ctx, vaultName);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('The selected vault root is not a regular directory.');
  const realRoot = await realpath(root);
  if (await isExcludedPath(root, folder)) throw new Error('The selected folder is hidden or excluded by this vault.');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const st = await lstat(current);
    if (st.isSymbolicLink()) throw new Error('The selected folder contains a symlink; intake stopped.');
    if (!st.isDirectory()) throw new Error('The selected folder does not exist.');
  }
  const realFolder = await realpath(current);
  const rel = path.relative(realRoot, realFolder);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || await isExcludedPath(root, rel.split(path.sep).join('/'))) throw new Error('The selected folder resolves outside its vault or into an excluded area.');
  return { v, root, realRoot, folder, full: current };
}

function scopeId(ctx, vaultName, root) {
  return hash(`${path.resolve(root)}\0${vaultName}\0${ctx.twinScope?.profile_id || 'unscoped'}`);
}

function sourceId(scope, rel) { return hash(`${scope}\0${rel}`); }

async function readEligible(full, root, realRoot, rel) {
  if (await isExcludedPath(root, rel)) return null;
  const before = await lstat(full);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_NOTE_BYTES) return null;
  if (!/\.md$/i.test(rel)) return null;
  const real = await realpath(full);
  const relReal = path.relative(realRoot, real);
  if (relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal) || await isExcludedPath(root, relReal.split(path.sep).join('/'))) return null;

  const fh = await open(full, 'r');
  try {
    const opened = await fh.stat();
    if (!opened.isFile() || opened.size !== before.size || (opened.ino && before.ino && opened.ino !== before.ino) || (opened.dev && before.dev && opened.dev !== before.dev)) return null;
    const header = Buffer.alloc(Math.min(opened.size, MAX_HEADER_BYTES));
    const { bytesRead } = await fh.read(header, 0, header.length, 0);
    if (!indexableHeader(header.subarray(0, bytesRead).toString('utf8'), opened.size, bytesRead)) return null;
    // Privacy was checked from the bounded header. Only now read the body.
    const raw = await fh.readFile('utf8');
    const after = await fh.stat();
    const pathAfter = await lstat(full);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || pathAfter.isSymbolicLink() || (pathAfter.ino && opened.ino && pathAfter.ino !== opened.ino)) return null;
    const { meta, body, frontmatter } = parseFrontmatter(raw);
    if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || meta.generated_by === 'brainlink') return null;
    return { rel, title: path.posix.basename(rel).replace(/\.md$/i, ''), revision: hash(raw), updated_at: new Date(after.mtimeMs).toISOString() };
  } finally { await fh.close(); }
}

async function sourcesInFolder(ctx, vaultName, folderInfo) {
  const out = [];
  let visited = 0, skipped = 0, truncated = false;
  async function visit(dir, relDir, depth = 0) {
    if (truncated) return;
    if (depth > MAX_DEPTH) { skipped++; return; }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) return;
      if (++visited > MAX_NOTES) { truncated = true; return; }
      if (entry.name.startsWith('.')) { skipped++; continue; }
      const rel = `${relDir}/${entry.name}`;
      if (await isExcludedPath(folderInfo.root, rel)) { skipped++; continue; }
      const full = path.join(dir, entry.name);
      const st = await lstat(full).catch(() => null);
      if (!st || st.isSymbolicLink()) { skipped++; continue; }
      if (st.isDirectory()) { await visit(full, rel, depth + 1); continue; }
      if (!st.isFile() || !/\.md$/i.test(entry.name)) continue;
      const source = await readEligible(full, folderInfo.root, folderInfo.realRoot, rel).catch(() => null);
      if (source) out.push(source); else skipped++;
    }
  }
  await visit(folderInfo.full, folderInfo.folder);
  return { sources: out, scanned: visited, skipped, truncated };
}

function journalPath(ctx, scope) { return path.join(appHome(ctx.env), 'ingestion', `${scope}.jsonl`); }

async function latestEvents(file) {
  const latest = new Map();
  const raw = await readFile(file, 'utf8').catch((e) => e.code === 'ENOENT' ? '' : Promise.reject(e));
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (typeof event.source_id === 'string' && typeof event.revision === 'string') latest.set(event.source_id, event);
  }
  return latest;
}

export async function ingestionQueue(ctx, vaultName, folder, { limit = 50 } = {}) {
  const folderInfo = await checkedFolder(ctx, vaultName, folder);
  const scope = scopeId(ctx, vaultName, folderInfo.root);
  const { sources, scanned, skipped, truncated } = await sourcesInFolder(ctx, vaultName, folderInfo);
  const events = await latestEvents(journalPath(ctx, scope));
  const pending = sources.filter((s) => events.get(sourceId(scope, s.rel))?.revision !== s.revision)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const cap = Math.max(1, Math.min(100, Number(limit) || 50));
  const candidates = pending.slice(0, cap)
    .map((s) => ({ source_id: sourceId(scope, s.rel), revision: s.revision, path: s.rel, title: s.title, updated_at: s.updated_at }));
  return { ok: true, vault: vaultName, folder: folderInfo.folder, candidates, queued_total: pending.length, scanned, skipped, truncated, limited: pending.length > cap, next: 'Read each selected source with vault_read_note. Draft linked knowledge with propose_note and show its preview. After a linked note is saved, record filed; otherwise record skipped. Source files are never changed.' };
}

export async function recordIngestion(ctx, vaultName, folder, { source_id, revision, outcome, knowledge_path } = {}) {
  if (ctx.readOnly) throw new Error('This connection is read-only.');
  const folderInfo = await checkedFolder(ctx, vaultName, folder);
  const v = folderInfo.v;
  if (v.writes === 'off') throw new Error(`Vault "${vaultName}" does not allow writes.`);
  if (!['filed', 'skipped'].includes(outcome)) throw new Error('outcome must be filed or skipped.');
  if (typeof source_id !== 'string' || !/^[a-f0-9]{64}$/.test(source_id) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Choose a current source from ingestion_queue.');

  const scope = scopeId(ctx, vaultName, folderInfo.root);
  const { sources } = await sourcesInFolder(ctx, vaultName, folderInfo);
  const source = sources.find((s) => sourceId(scope, s.rel) === source_id);
  if (!source || source.revision !== revision) throw new Error('This source changed or is no longer available. Refresh the queue and review it again.');

  let destinationId = null;
  if (outcome === 'filed') {
    const dest = String(knowledge_path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!dest || dest.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.')) || !/\.md$/i.test(dest)) throw new Error('A saved Markdown knowledge_path is required for filed.');
    if (dest === source.rel || dest.startsWith(`${folderInfo.folder}/`)) throw new Error('The knowledge note must be outside the selected Raw folder.');
    if (await isExcludedPath(folderInfo.root, dest)) throw new Error('The knowledge note is hidden or excluded.');
    const full = safeJoin(folderInfo.root, dest);
    let component = folderInfo.root;
    const components = dest.split('/');
    for (let i = 0; i < components.length; i++) {
      component = path.join(component, components[i]);
      const partStat = await lstat(component);
      if (partStat.isSymbolicLink() || (i < components.length - 1 && !partStat.isDirectory())) throw new Error('The knowledge note path contains an unsafe link or folder.');
    }
    const st = await lstat(full);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_NOTE_BYTES) throw new Error('The saved knowledge note is not a regular Markdown file.');
    const real = await realpath(full);
    const relativeReal = path.relative(folderInfo.realRoot, real);
    if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal) || await isExcludedPath(folderInfo.root, relativeReal.split(path.sep).join('/'))) throw new Error('The knowledge note resolves outside its vault or into an excluded area.');
    const fh = await open(full, 'r');
    let raw;
    try {
      const opened = await fh.stat();
      if (!opened.isFile() || (opened.ino && st.ino && opened.ino !== st.ino)) throw new Error('The knowledge note changed during review.');
      const header = Buffer.alloc(Math.min(opened.size, MAX_HEADER_BYTES));
      const { bytesRead } = await fh.read(header, 0, header.length, 0);
      if (!indexableHeader(header.subarray(0, bytesRead).toString('utf8'), opened.size, bytesRead)) throw new Error('The knowledge note is private or has malformed frontmatter.');
      raw = await fh.readFile('utf8');
      const after = await fh.stat();
      const pathAfter = await lstat(full);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || pathAfter.isSymbolicLink() || (pathAfter.ino && opened.ino && pathAfter.ino !== opened.ino)) throw new Error('The knowledge note changed during review.');
    } finally { await fh.close(); }
    const { meta, body, frontmatter } = parseFrontmatter(raw);
    if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter)) throw new Error('The knowledge note is private.');
    const targets = extractLinks(body).map((x) => x.replace(/^\.\//, '').replace(/\.md$/i, '').toLowerCase());
    const sourcePath = source.rel.replace(/\.md$/i, '').toLowerCase();
    const sourceTitle = source.title.toLowerCase();
    if (!targets.some((target) => target === sourcePath || target === sourceTitle)) throw new Error('The saved knowledge note must link to the source note.');
    destinationId = hash(`${scope}\0${dest}`);
  }

  const sourceStillCurrent = await readEligible(safeJoin(folderInfo.root, source.rel), folderInfo.root, folderInfo.realRoot, source.rel).catch(() => null);
  if (!sourceStillCurrent || sourceStillCurrent.revision !== revision) throw new Error('This source changed during review. Refresh the queue and review it again.');

  const event = { at: new Date().toISOString(), scope, source_id, revision, outcome, destination_id: destinationId, actor: String(ctx.platform || 'unknown').slice(0, 80) };
  const file = journalPath(ctx, scope);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(event) + '\n', { flag: 'a' });
  return { ok: true, recorded: true, outcome, source_id, next: 'This local receipt contains no note title, path, body, or prompt.' };
}
