// Runtime context (config + per-connection env), vault index, search, read and
// related notes. Retrieval: heading-ancestry chunks; guaranteed [[mention]] and #tag hits;
// BM25 over stemmed terms, fused (reciprocal rank) across the query, its rephrasings and the
// optional semantic ranking; capped graph boost from links, co-citations and shared tags;
// title boost; demotion of superseded / archived notes; date, folder and tag filters.
import { readdir, readFile, writeFile, stat, lstat, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { termFrequencies, terms, linkGraph, collection, suggestRelated, extractTags } from './graph.mjs';
import { deriveTypedRelations } from './typed-graph.mjs';
import { appHome } from './config.mjs';
import { rerankResults } from './rerank.mjs';
import { detectEmbedder, publicEmbedStatus, isLocalEmbedder, VectorStore, fillVectors, embedTexts, nearest, PREFERRED_EMBED_MODEL } from './embed.mjs';
import { buildWikiLayer, queryWikiLayer, isWikiIndexPath, renderAllowlistedWikiIndex, allowlistedWikiMeta, normalizeWikiPath } from './wiki-layer.mjs';
import { findAgentByToken, publicAgent } from './mcp-agents.mjs';
import { resolveTwinAgentScope, twinNoteMemoryAllowed } from './twin-profiles.mjs';
import { MEMORY_TYPES, classifyNoteMemoryType, detectQueryMemoryIntent, memoryTypeScoreMultiplier } from './memory-ranking.mjs';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

// Every install unlocks every feature; there is no plan or licence gating.
export const FEATURES = Object.freeze({ plan: 'full', writes: true, agents: true, http: true, maxVaults: Infinity, maxConnections: Infinity });

export function createContext(cfg, { env = process.env, trustedLocal = false } = {}) {
  const byName = new Map(cfg.vaults.map((v) => [v.name, v]));
  const configuredEnabled = env.BRAINLINK_VAULTS ? env.BRAINLINK_VAULTS.split(',').map((s) => s.trim()).filter((v) => byName.has(v)) : cfg.vaults.map((v) => v.name);
  const readOnly = truthy(env.BRAINLINK_READ_ONLY);
  // An AI agent the user added themselves (src/mcp-agents.mjs), identified by the token it was
  // launched with. Revoked or unknown tokens resolve to no agent — never a guess at identity.
  const matchedAgent = findAgentByToken(cfg, env.BRAINLINK_AGENT_TOKEN) || null;
  const twinScope = trustedLocal
    ? { mode: 'legacy', profile_id: null, grants: [] }
    : resolveTwinAgentScope(cfg, matchedAgent, Boolean(env.BRAINLINK_AGENT_TOKEN));
  const enabled = twinScope.mode === 'scoped'
    ? configuredEnabled.filter((name) => twinScope.grants.some((grant) => grant.name === name))
    : twinScope.mode === 'unassigned' ? [] : configuredEnabled;
  return {
    cfg, features: FEATURES, byName, enabled, readOnly, env, twinScope, trustedLocal,
    platform: String(env.BRAINLINK_AI_PLATFORM || '').trim() || (matchedAgent ? matchedAgent.name : ''),
    agentRole: String(env.BRAINLINK_AGENT_ROLE || 'direct assistant').trim(),
    connectorPrivate: truthy(env.BRAINLINK_CONNECTOR_PRIVATE),
    tz: cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    agents: cfg.agents.filter((a) => enabled.includes(a.vault)),
    mcpAgent: matchedAgent ? publicAgent(matchedAgent) : null,
    dataDir: appHome(env),
    cache: new Map(),
    stores: new Map(),
    embedder: null, // Promise of detectEmbedder(), created on first search
  };
}

export function vault(ctx, name) {
  const v = ctx.byName.get(name);
  if (!v) throw new Error(`Unknown vault "${name}". Use one of: ${ctx.enabled.join(', ')}`);
  if (!ctx.enabled.includes(name)) throw new Error(`Vault "${name}" is not enabled for this connection. Enabled: ${ctx.enabled.join(', ')}`);
  return v;
}

export const vaultRoot = (ctx, name) => path.resolve(vault(ctx, name).path);

export function safeJoin(root, rel) {
  const full = path.resolve(root, String(rel));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path escapes the vault');
  return full;
}

// ISO timestamp with the configured zone's offset, e.g. 2026-10-18T09:05:00+08:00.
export function zonedNow(tz, d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' }).formatToParts(d).map((p) => [p.type, p.value]));
  const off = parts.timeZoneName.replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

// A leading UTF-8 BOM (some editors/OSes write one) or blank lines before the opening `---` must
// not stop `private: true` (or any other field) from being detected — such a note reads identically
// once opened in Obsidian, so it must be gated the same as one with no stray leading bytes/lines.
export function parseFrontmatter(text) {
  const stripped = String(text).replace(/^\uFEFF/, '');
  // F4: trailing spaces/tabs after either fence (e.g. "--- \n") must not stop detection -- a note
  // otherwise identical in Obsidian was leaking as non-private because of a stray trailing byte.
  const m = stripped.match(/^(?:[ \t]*\r?\n)*---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/);
  if (!m) return { meta: {}, body: stripped, frontmatter: '' };
  const meta = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) { meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim(); listKey = kv[2].trim() === '' ? kv[1] : null; continue; }
    // YAML block list ("tags:\n  - a\n  - b") becomes "[a, b]" like the inline form.
    const item = listKey && line.match(/^\s*-\s+(.*)$/);
    if (item) { const v = item[1].replace(/^["']|["']$/g, '').trim(); meta[listKey] = meta[listKey] ? `${meta[listKey].replace(/\]$/, '')}, ${v}]` : `[${v}]`; }
  }
  return { meta, body: stripped.slice(m[0].length), frontmatter: m[1] };
}

const MAX_WORDS = 256;

export function chunkMarkdown(body, ancestry = [], level = 1) {
  const words = body.split(/\s+/).filter(Boolean).length;
  const headingRe = (n) => new RegExp(`^#{${n}} .+$`, 'm');
  while (level <= 6 && !headingRe(level).test(body)) level++;
  if (words <= MAX_WORDS || level > 6) return splitByWords(body, ancestry);
  const chunks = [];
  for (const part of body.split(new RegExp(`^(?=#{${level}} .+$)`, 'm'))) {
    if (!part.trim()) continue;
    const first = part.split('\n', 1)[0];
    const h = first.match(new RegExp(`^#{${level}} (.+)$`));
    if (h) chunks.push(...chunkMarkdown(part.slice(first.length), [...ancestry, h[1].trim()], level + 1));
    else chunks.push(...chunkMarkdown(part, ancestry, level + 1));
  }
  return chunks;
}

function splitByWords(text, ancestry) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return ancestry.length ? [{ heading: ancestry.join(' › '), text: '' }] : [];
  const out = [];
  for (let i = 0; i < words.length; i += MAX_WORDS) out.push({ heading: ancestry.join(' › '), text: words.slice(i, i + MAX_WORDS).join(' ') });
  return out;
}

// The one shared, fail-closed "is this note private?" predicate — used by core.mjs itself,
// snapshot.mjs and graph3d.mjs (import from here instead of keeping a local copy; three
// independent regexes drifting out of sync is exactly how `Private: true`, `private: true #
// comment` and `private: on` used to fall through on some paths but not others). Case-insensitive
// key lookup (parseFrontmatter keeps the YAML key's original case); strips a trailing `# comment`
// and surrounding quotes from the value. Allow-listing "true-ish" spellings is how new spellings
// slip through — deny-list instead, so private:true is the floor: anything not explicitly one of
// the recognized "off" spellings is treated as private.
export const isPrivateMeta = (meta = {}) => {
  const k = Object.keys(meta || {}).find((x) => x.toLowerCase() === 'private');
  if (k === undefined) return false;
  const v = String(meta[k]).replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
  return !/^(false|no|0|off|null|~|)$/i.test(v);
};

// isPrivateMeta's line-by-line key parser (above) is strict on purpose -- a looser leading-\s*
// key regex would also match a `private:` line nested under an unrelated block key (e.g.
// `settings:\n  private: false` or a `|` block scalar), which can flip an actually-private note
// to public. Spellings that strict parser legitimately misses (`private : true` with a space
// before the colon, indented `  private: true`, a quoted `"private": true` key) must still be
// caught, so this is a second, independent, fail-closed scan of the *raw* frontmatter block: any
// line or flow-style occurrence of a `private` key is treated as private unless its value is one
// of a short list of explicit "off" spellings. Over-blocking (e.g. `title: my private: thoughts`)
// is the acceptable failure mode here, not under-blocking.
const PRIV_RE = /(?:^|[\s{,])["']?private["']?\s*:[ \t]*([^\n,}#]*)/gim;
export const fmSaysPrivate = (block) => [...String(block || '').matchAll(PRIV_RE)].some((m) =>
  !/^(false|no|0|off|null|~)$/i.test(m[1].replace(/^["']|["']$/g, '').trim()));

export function isHistorical(rel, meta) {
  const name = path.posix.basename(rel);
  return /^(SUPERSEDED|BACKUP)\b|\bSUPERSEDED\b/i.test(name) || /^(archived|historical|superseded)$/i.test(meta.status || '') || Boolean(meta.superseded_by);
}

// A note's date: frontmatter date fields, else a YYYY-MM-DD in the filename, else modified time.
export function noteDate(rel, meta, mtime) {
  for (const k of ['date', 'created', 'created_date', 'written_at']) { const m = String(meta[k] || '').match(/\d{4}-\d{2}-\d{2}/); if (m) return m[0]; }
  const f = path.posix.basename(rel).match(/(\d{4}-\d{2}-\d{2})/);
  return f ? f[1] : new Date(mtime).toISOString().slice(0, 10);
}

export const listValue = (v) => String(v || '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

// Index pages, drafts and staging copies repeat other notes' words; rank them below real notes.
export const isMinor = (rel, title) => /^(_?README|00 INDEX|00 MAP|INDEX|MAP)$|^(DRAFT|PROMOTED|COPY)\b|^00 (INDEX|MAP)\b/.test(title) || /(^|\/)_staging[\s.]*\//i.test(rel);

export const ROUTING_NOTE = /^(_?README|00 INDEX|00 MAP|INDEX|Home)$|^00 Moved\b|\bpointer\b/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.backups', '_staging']);
export const normalizeDirName = (name) => String(name || '').replace(/[\s.]+$/g, '').toLowerCase();
export const isSkippedDirName = (name) => {
  const norm = normalizeDirName(name);
  return !norm || norm.startsWith('.') || SKIP_DIRS.has(norm);
};

// A .brainlinkignore file in any folder lists names to skip there, one per line ("samples/",
// "drafts", "*.tmp", or "*" for the whole folder). Lines starting with # are comments.
async function ignoreRules(dir) {
  try {
    return (await readFile(path.join(dir, '.brainlinkignore'), 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => new RegExp(`^${l.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'));
  } catch { return []; }
}

// Shipped in every newly connected real vault's root .brainlinkignore (never overwrites one
// already there). These folders are never read, chunked, searched, answered from, graphed,
// surfaced in sessions or synced — same as the rest of .brainlinkignore (see walk(), below).
export const DEFAULT_EXCLUDED_FOLDERS = ['.obsidian/', '.trash/', '.git/', 'node_modules/', '00 Home/', '_staging/'];
// Common personal folders people keep out of an AI-connected vault; shipped as commented-out
// suggestions so the user opts in rather than losing folders silently.
export const SUGGESTED_EXCLUDED_FOLDERS = ['finance/', 'personal/', 'home/'];

export function defaultBrainlinkignore() {
  return [
    '# Folders BrainLink never reads, searches, answers from, graphs or syncs. Edit any time in Settings.',
    ...DEFAULT_EXCLUDED_FOLDERS,
    '',
    '# Common folders people keep private from an AI-connected vault -- uncomment any that apply:',
    ...SUGGESTED_EXCLUDED_FOLDERS.map((f) => `# ${f}`),
    '',
  ].join('\n');
}

// Writes the default .brainlinkignore into a newly connected vault's root; a no-op if that vault
// already has one (never overwrites a user's own choices).
export async function ensureDefaultIgnore(vaultPath) {
  try { await writeFile(path.join(vaultPath, '.brainlinkignore'), defaultBrainlinkignore(), { flag: 'wx' }); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

// A commented-out folder suggestion ("# finance/") is a single bare name/pattern; explanatory
// comment sentences ("# Edit any time in Settings.") have whitespace or punctuation and are not.
const SUGGESTION_RE = /^[A-Za-z0-9_.\/-]+$/;

// The vault root's own excluded-folder lines: active rules plus commented-out suggestions, in
// file order. Used by Setup to show (and let the user edit) what a vault excludes.
export async function readExcludedFolders(vaultPath) {
  let raw;
  try { raw = await readFile(path.join(vaultPath, '.brainlinkignore'), 'utf8'); } catch { return { active: [], suggested: [] }; }
  const active = [], suggested = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) { const s = t.replace(/^#\s*/, ''); if (SUGGESTION_RE.test(s)) suggested.push(s); continue; }
    active.push(t);
  }
  return { active, suggested };
}

// Rewrites a vault root's .brainlinkignore with exactly the given active folder list.
export async function writeExcludedFolders(vaultPath, folders) {
  const lines = [...new Set(folders.map((f) => String(f).trim()).filter(Boolean))];
  await writeFile(path.join(vaultPath, '.brainlinkignore'), lines.length ? lines.join('\n') + '\n' : '');
  return lines;
}

// Ignore rules accumulate down the tree (like .gitignore) so a root-level rule such as
// "00 Home/" also excludes "sub/00 Home/" at any depth, not just a direct child of root.
async function walk(root, dir = root, out = [], inherited = []) {
  const rules = inherited.concat(await ignoreRules(dir));
  if (rules.some((re) => re.test('*') || re.source === '^.*$')) return out;
  for (const f of await readdir(dir, { withFileTypes: true })) {
    if (isSkippedDirName(f.name)) continue;
    const trimmedName = f.name.replace(/[\s.]+$/g, '');
    if (rules.some((re) => re.test(f.name) || (trimmedName && re.test(trimmedName)))) continue;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) await walk(root, full, out, rules);
    else if (f.isFile() && f.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

async function visibleFolderPaths(root, dir = root, out = [], inherited = []) {
  const rules = inherited.concat(await ignoreRules(dir));
  if (rules.some((re) => re.test('*') || re.source === '^.*$')) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (isSkippedDirName(entry.name)) continue;
    const trimmedName = entry.name.replace(/[\s.]+$/g, '');
    if (rules.some((re) => re.test(entry.name) || (trimmedName && re.test(trimmedName))) || !entry.isDirectory()) continue;
    const full = path.join(dir, entry.name), rel = path.relative(root, full).split(path.sep).join('/');
    out.push(rel);
    await visibleFolderPaths(root, full, out, rules);
  }
  return out;
}

// Same accumulated-rule logic as walk(), for a single already-known relative path (readNote()):
// true if any ancestor folder, or the file itself, is excluded at any depth.
export async function isExcludedPath(root, rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  let dir = root, rules = [];
  for (const name of parts) {
    if (isSkippedDirName(name)) return true;
    rules = rules.concat(await ignoreRules(dir));
    if (rules.some((re) => re.test('*') || re.source === '^.*$')) return true;
    const trimmedName = name.replace(/[\s.]+$/g, '');
    if (rules.some((re) => re.test(name) || (trimmedName && re.test(trimmedName)))) return true;
    dir = path.join(dir, name);
  }
  return false;
}

// Refuse excluded destinations and link-backed path components before writing within a vault.
export async function assertRegularWritePath(root, rel) {
  const full = safeJoin(root, rel);
  const parts = path.relative(root, full).split(path.sep);
  if (await isExcludedPath(root, parts.join('/'))) throw new Error('Destination is excluded.');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) break;
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('Destination is not a regular path in the vault.');
  }
  return full;
}

// Inspect only a bounded frontmatter prefix before reading/indexing a note body. A malformed
// or overlong frontmatter is hidden until the owner fixes it; never guess "public" when the
// privacy marker might be beyond the bounded header.
function inspectIndexableHeader(prefix, size, bytesRead = Buffer.byteLength(prefix, 'utf8')) {
  prefix = String(prefix).replace(/^\uFEFF/, '');
  const start = prefix.match(/^(?:[ \t]*\r?\n)*---[^\S\r\n]*\r?\n/);
  if (!start) return { indexable: /\S/.test(prefix) || bytesRead >= size, meta: {} };
  const tail = prefix.slice(start[0].length);
  const end = tail.match(/^---[^\S\r\n]*(?:\r?\n|$)/m);
  if (!end) return { indexable: false, meta: {} };
  const header = tail.slice(0, end.index);
  const { meta } = parseFrontmatter(prefix.slice(0, start[0].length + end.index + end[0].length));
  return { indexable: !(isPrivateMeta(meta) || fmSaysPrivate(header)), meta };
}

export function indexableHeader(prefix, size, bytesRead = Buffer.byteLength(prefix, 'utf8')) {
  return inspectIndexableHeader(prefix, size, bytesRead).indexable;
}

async function readIndexableHeader(full, size) {
  const fd = await open(full, 'r');
  const buffer = Buffer.alloc(Math.min(size, 65536));
  let bytesRead;
  try { ({ bytesRead } = await fd.read(buffer, 0, buffer.length, 0)); }
  finally { await fd.close(); }
  return inspectIndexableHeader(buffer.subarray(0, bytesRead).toString('utf8'), size, bytesRead);
}

// Owner-only Setup helper for adopting an existing Markdown folder. Returns paths, not note
// bodies, and omits private, excluded, hidden and malformed-frontmatter notes.
export async function inspectVaultStructure(vaultPath, { limit = 1000 } = {}) {
  const root = await realpath(path.resolve(String(vaultPath || '')));
  if (!(await stat(root)).isDirectory()) throw new Error('Choose an existing folder.');
  const files = await walk(root), notes = [], folders = new Set(await visibleFolderPaths(root));
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const info = await stat(full);
    const header = await readIndexableHeader(full, Number(info.size));
    if (!header.indexable) continue;
    notes.push({ path: rel, title: path.posix.basename(rel).replace(/\.md$/i, '') });
    let folder = path.posix.dirname(rel);
    while (folder && folder !== '.') { folders.add(folder); folder = path.posix.dirname(folder); }
  }
  notes.sort((a, b) => a.path.localeCompare(b.path));
  const sortedFolders = [...folders].sort((a, b) => a.localeCompare(b));
  const cap = Math.max(1, Math.min(2000, Number.isSafeInteger(limit) ? limit : 1000));
  return { path: root, existing: files.length > 0 || (await readdir(root)).length > 0, note_count: notes.length, folder_count: sortedFolders.length, notes: notes.slice(0, cap), folders: sortedFolders.slice(0, cap), truncated: notes.length > cap || sortedFolders.length > cap };
}

// Setup needs a useful note count, but building the full search index just to display that
// number reads every public Markdown body and can consume large amounts of memory on synced
// vaults. Count from bounded frontmatter reads only; search still builds its normal index lazily.
export async function countVisibleNotes(ctx, name) {
  const root = vaultRoot(ctx, name);
  let count = 0;
  for (const full of await walk(root)) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (!twinNoteMemoryAllowed(ctx, name, rel)) continue;
    const st = await stat(full, { bigint: true });
    const header = await readIndexableHeader(full, Number(st.size));
    if (!header.indexable || !twinNoteMemoryAllowed(ctx, name, rel, header.meta)) continue;
    if (header.meta.generated_by === 'brainlink' || /^BrainLink\/Commands\//i.test(rel)) continue;
    count++;
  }
  return count;
}

// Hash-incremental: unchanged files are not re-chunked on the next call. Concurrent first
// requests (for example the graph and a background vault scan) must share one index build; without
// this, each request walks, parses and chunks the full vault independently before racing to cache it.
const vaultLoadsInFlight = new WeakMap();
export async function loadVault(ctx, name) {
  let inFlight = vaultLoadsInFlight.get(ctx);
  if (!inFlight) { inFlight = new Map(); vaultLoadsInFlight.set(ctx, inFlight); }
  if (inFlight.has(name)) return inFlight.get(name);
  const pending = loadVaultFresh(ctx, name);
  inFlight.set(name, pending);
  try { return await pending; }
  finally { if (inFlight.get(name) === pending) inFlight.delete(name); }
}

async function loadVaultFresh(ctx, name) {
  const root = vaultRoot(ctx, name);
  const state = ctx.cache.get(name) || { files: new Map(), index: null };
  const seen = new Set();
  let changed = !state.index;
  const files = await walk(root);
  const statBatchSize = 96, readBatchSize = 32;
  const fileStates = [];
  // Drive-backed vaults pay substantial latency per metadata lookup. Check a bounded batch in
  // parallel rather than awaiting stat() once per note; the batch cap avoids unbounded I/O.
  for (let start = 0; start < files.length; start += statBatchSize) {
    fileStates.push(...await Promise.all(files.slice(start, start + statBatchSize).map(async (full) => {
      const rel = path.relative(root, full).split(path.sep).join('/');
      const stNow = await stat(full, { bigint: true });
      return { full, rel, mtime: Number(stNow.mtimeNs) / 1e6, bytes: Number(stNow.size), ctime: String(stNow.ctimeNs) };
    })));
  }
  const processFile = async ({ full, rel, mtime, bytes, ctime }) => {
    seen.add(rel);
    const prev = state.files.get(rel);
    // Configured paths such as the handoff mailbox and capture log have known types;
    // exclude them before even opening their Markdown body.
    if (!twinNoteMemoryAllowed(ctx, name, rel)) {
      if (prev?.note) changed = true;
      state.files.set(rel, { hash: null, mtime, bytes, ctime, note: null });
      return;
    }
    let header = null;
    if (prev?.note && prev.mtime === mtime && prev.bytes === bytes && prev.ctime === ctime) {
      // Scoped agents must not reuse a cached note based only on stat metadata: a sync tool or
      // filesystem can preserve those values while changing the memory-type frontmatter.
      // Check the bounded header before retaining the cached body for ranking or excerpts.
      if (ctx.twinScope?.mode !== 'scoped') return;
      header = await readIndexableHeader(full, bytes);
      if (!header.indexable || !twinNoteMemoryAllowed(ctx, name, rel, header.meta)) {
        changed = true;
        state.files.set(rel, { hash: null, mtime, bytes, ctime, note: null });
        return;
      }
      if (JSON.stringify(header.meta) === JSON.stringify(prev.note.meta)) return;
    }
    header ||= await readIndexableHeader(full, bytes);
    if (!header.indexable || !twinNoteMemoryAllowed(ctx, name, rel, header.meta)) {
      if (prev?.note) changed = true;
      state.files.set(rel, { hash: null, mtime, bytes, ctime, note: null });
      return;
    }
    const raw = await readFile(full, 'utf8');
    const hash = createHash('sha1').update(raw).digest('hex');
    if (prev?.hash === hash) { prev.mtime = mtime; prev.bytes = bytes; prev.ctime = ctime; return; }
    changed = true;
    const { meta, body, frontmatter } = parseFrontmatter(raw);
    const title = path.posix.basename(rel).replace(/\.md$/i, '');
    const aliases = listValue(meta.aliases);
    const names = [title, ...aliases].join(' ');
    const chunks = chunkMarkdown(body).map((c, i) => ({ ...c, id: `${rel}#${i}`, tokens: termFrequencies(`${names} ${c.heading} ${c.text}`) }));
    // Recheck after the full read in case the file changed between the header and body reads.
    if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || !twinNoteMemoryAllowed(ctx, name, rel, meta)) {
      state.files.set(rel, { hash: null, mtime, bytes, ctime, note: null });
      return;
    }
    const noteTags = extractTags(body, meta);
    state.files.set(rel, { hash, mtime, bytes, ctime, note: { rel, title, aliases, raw, meta, body, chunks, mtime, minor: isMinor(rel, title), date: noteDate(rel, meta, mtime), tags: noteTags, memory_type: classifyNoteMemoryType(rel, meta, noteTags), generated: meta.generated_by === 'brainlink' || /^BrainLink\/Commands\//i.test(rel), historical: isHistorical(rel, meta), private: false } });
  };
  for (let start = 0; start < fileStates.length; start += readBatchSize) {
    await Promise.all(fileStates.slice(start, start + readBatchSize).map(processFile));
  }
  for (const rel of [...state.files.keys()]) if (!seen.has(rel)) { state.files.delete(rel); changed = true; }
  if (changed) state.index = buildIndex([...state.files.values()].map((f) => f.note).filter(Boolean).sort((a, b) => a.rel.localeCompare(b.rel)));
  ctx.cache.set(name, state);
  return state.index;
}

// A graph view needs note text only to resolve links and typed records. Building the full search
// index first tokenizes and chunks every body, which can consume over a gigabyte on large vaults.
// Keep this lightweight path independent so opening the graph does not require a search index.
// Setup creates a short-lived request context for each local API call. Keep the lightweight
// graph index across those contexts, keyed by vault path and the exact Twin visibility policy.
const graphVaultCache = new Map();
const GRAPH_STAT_BATCH_SIZE = 96;
const GRAPH_READ_BATCH_SIZE = 32;
const GRAPH_CACHE_MAX_ENTRIES = 4;
const GRAPH_CACHE_TTL_MS = 60_000;
function graphVaultCacheKey(ctx, name) {
  const scope = ctx.twinScope || { mode: 'legacy' };
  const grants = (scope.grants || []).filter((grant) => grant.name === name)
    .map(({ name: vaultName, operations, memory_policy }) => ({ name: vaultName, operations: [...(operations || [])].sort(), memory_policy }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rolePaths = (ctx.agents || []).filter((agent) => agent.vault === name).map((agent) => ({
    connect_notes: [...(agent.connect_notes || [])], tail_notes: [...(agent.tail_notes || [])],
    close_target: agent.close_target || null,
  }));
  const vault = ctx.byName.get(name);
  const handoffFolder = ctx.cfg?.handoff?.vault === name ? ctx.cfg.handoff.folder : null;
  return `${path.resolve(vaultRoot(ctx, name))}\0${JSON.stringify({ private: Boolean(vault?.private), mode: scope.mode, grants, rolePaths, read_first: vault?.read_first || [], handoffFolder })}`;
}
export async function loadVaultGraph(ctx, name) {
  const root = path.resolve(vaultRoot(ctx, name));
  const isPrivateVault = Boolean(ctx.byName.get(name)?.private);
  // Do not retain note bodies from a private vault in the process-wide graph cache. Also purge
  // any formerly-public entry for this path if its privacy setting has changed.
  if (isPrivateVault) {
    for (const [entryKey, entry] of graphVaultCache) if (entry.root === root || entryKey.startsWith(`${root}\0`)) graphVaultCache.delete(entryKey);
    return buildVaultGraph(ctx, name);
  }

  const now = Date.now();
  for (const [entryKey, entry] of graphVaultCache) {
    if (!entry.pending && entry.expiresAt <= now) graphVaultCache.delete(entryKey);
  }
  const key = graphVaultCacheKey(ctx, name);
  const cached = graphVaultCache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached) { graphVaultCache.delete(key); graphVaultCache.set(key, cached); }
  const pending = (async () => {
    const value = await buildVaultGraph(ctx, name, cached);
    const signatures = value.signatures;
    graphVaultCache.set(key, { value: value.graph, signatures, root, expiresAt: Date.now() + GRAPH_CACHE_TTL_MS });
    while (graphVaultCache.size > GRAPH_CACHE_MAX_ENTRIES) graphVaultCache.delete(graphVaultCache.keys().next().value);
    return value.graph;
  })();
  graphVaultCache.set(key, { pending, root, expiresAt: Number.POSITIVE_INFINITY });
  while (graphVaultCache.size > GRAPH_CACHE_MAX_ENTRIES) graphVaultCache.delete(graphVaultCache.keys().next().value);
  try { return await pending; }
  catch (error) { if (graphVaultCache.get(key)?.pending === pending) graphVaultCache.delete(key); throw error; }
}

async function buildVaultGraph(ctx, name, cached = null) {
  const root = vaultRoot(ctx, name), notes = [], files = await walk(root);
  // Check the current eligible paths and metadata on each request. A time-only cache could
  // continue showing a note immediately after it was made private or its folder excluded.
  const states = [];
  for (let start = 0; start < files.length; start += GRAPH_STAT_BATCH_SIZE) states.push(...await Promise.all(files.slice(start, start + GRAPH_STAT_BATCH_SIZE).map(async (full) => {
    const st = await stat(full, { bigint: true });
    return { full, rel: path.relative(root, full).split(path.sep).join('/'), mtime: Number(st.mtimeNs) / 1e6, bytes: Number(st.size),
      signature: `${st.size}:${st.mtimeNs}:${st.ctimeNs}` };
  })));
  const signatures = new Map(states.map((item) => [item.rel, item.signature]));
  if (cached?.value && cached.signatures?.size === signatures.size && [...signatures].every(([rel, value]) => cached.signatures.get(rel) === value)) {
    return { graph: cached.value, signatures };
  }
  for (let start = 0; start < files.length; start += GRAPH_READ_BATCH_SIZE) {
    const batch = await Promise.all(states.slice(start, start + GRAPH_READ_BATCH_SIZE).map(async ({ full, rel, mtime, bytes }) => {
      if (!twinNoteMemoryAllowed(ctx, name, rel)) return null;
      const header = await readIndexableHeader(full, bytes);
      if (!header.indexable || !twinNoteMemoryAllowed(ctx, name, rel, header.meta)) return null;
      const raw = await readFile(full, 'utf8');
      const { meta, body, frontmatter } = parseFrontmatter(raw);
      if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || !twinNoteMemoryAllowed(ctx, name, rel, meta)) return null;
      return { rel, title: path.posix.basename(rel).replace(/\.md$/i, ''), aliases: listValue(meta.aliases), raw, meta, body, mtime,
        tags: extractTags(raw, meta), generated: meta.generated_by === 'brainlink' || /^BrainLink\/Commands\//i.test(rel), private: false };
    }));
    notes.push(...batch.filter(Boolean));
  }
  notes.sort((a, b) => a.rel.localeCompare(b.rel));
  const value = { notes, noteEdges: linkGraph(notes).edges, byRel: new Map(notes.map((note, index) => [note.rel, index])) };
  return { graph: value, signatures };
}

export function buildIndex(notes) {
  notes = notes.filter((n) => n && !n.private); // defensive: even direct callers cannot rank private content
  const { edges: noteEdges, broken } = linkGraph(notes);
  const typedRelations = deriveTypedRelations(notes);
  const edges = [...noteEdges];
  const edgeKeys = new Set(edges.map(([source, target]) => `${source}>${target}`));
  for (const edge of typedRelations) {
    const key = `${edge.source}>${edge.target}`;
    if (!edgeKeys.has(key)) { edges.push([edge.source, edge.target]); edgeKeys.add(key); }
  }
  const backlinks = notes.map(() => new Set()), outlinks = notes.map(() => new Set());
  for (const [a, b] of edges) { backlinks[b].add(a); outlinks[a].add(b); }
  // Addendum A 00 MAP.md and folder 00 INDEX.md notes are used strictly as the parsed,
  // privacy-filtered wiki prior (buildWikiLayer), never as searchable/embeddable chunks,
  // so stale index rows referencing private or excluded titles can never leak into hits.
  const chunks = notes.flatMap((n, noteIdx) => (isWikiIndexPath(n.rel)
    ? []
    : n.chunks.map((c) => ({ ...c, noteIdx, len: [...c.tokens.values()].reduce((s, x) => s + x, 0) }))));
  const df = new Map();
  for (const c of chunks) for (const t of c.tokens.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = chunks.reduce((s, c) => s + c.len, 0) / Math.max(1, chunks.length);
  const byRel = new Map(notes.map((n, i) => [n.rel, i]));
  const byTitle = new Map();
  notes.forEach((n, i) => { if (!byTitle.has(n.title)) byTitle.set(n.title, []); byTitle.get(n.title).push(i); });
  const byAlias = new Map();
  notes.forEach((n, i) => { for (const a of n.aliases || []) if (!byAlias.has(a.toLowerCase())) byAlias.set(a.toLowerCase(), i); });
  const byTag = new Map();
  notes.forEach((n, i) => { for (const t of n.tags) { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(i); } });
  const wiki = buildWikiLayer(notes, byRel, byTitle);
  return { notes, chunks, df, avgLen, backlinks, outlinks, byRel, byTitle, byAlias, byTag, edges, noteEdges, broken, typedRelations, wiki, termSets: null };
}

// Note-level term sets and document frequencies, built lazily (used by related and linking).
export function noteTerms(index) {
  if (!index.termSets) {
    index.termSets = index.notes.map((n) => terms(`${n.title} ${n.body}`));
    index.noteDf = new Map();
    for (const s of index.termSets) for (const t of s) index.noteDf.set(t, (index.noteDf.get(t) || 0) + 1);
  }
  return { termSets: index.termSets, df: index.noteDf };
}

function bm25(index, qTerms, c, k1 = 1.2, b = 0.75) {
  const N = index.chunks.length;
  let s = 0;
  for (const t of qTerms) {
    const f = c.tokens.get(t);
    if (!f) continue;
    const df = index.df.get(t) || 0;
    s += Math.log(1 + (N - df + 0.5) / (df + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (c.len / index.avgLen)));
  }
  return s;
}

export function summarize(index, i, extra = {}) {
  const n = index.notes[i];
  if (isWikiIndexPath(n.rel)) {
    const safeMeta = allowlistedWikiMeta(n.rel, n.meta);
    return { path: n.rel, title: safeMeta.title, date: n.date, status: safeMeta.status || '', collection: collection(n.rel), historical: isHistorical(n.rel, safeMeta), ...extra };
  }
  const confidence = ['verified', 'reported', 'inferred', 'unknown'].includes(String(n.meta.confidence || '').toLowerCase())
    ? String(n.meta.confidence).toLowerCase() : undefined;
  return { path: n.rel, title: n.title, date: n.date, status: n.meta.status || '', ...(confidence ? { confidence } : {}), memory_type: n.memory_type || classifyNoteMemoryType(n.rel, n.meta, n.tags), collection: collection(n.rel), ...(n.tags.size ? { tags: [...n.tags] } : {}), historical: n.historical, ...(n.meta.superseded_by ? { superseded_by: n.meta.superseded_by } : {}), ...extra };
}

// Filter predicate from {folder, tag, since, until, memory_type}.
export function noteFilter(index, { folder, tag, since, until, memory_type, exclude } = {}) {
  const f = folder ? String(folder).replace(/^\/+|\/+$/g, '').toLowerCase() + '/' : null;
  const t = tag ? String(tag).replace(/^#/, '').toLowerCase() : null;
  const mt = memory_type ? String(memory_type).trim().toLowerCase() : null;
  return (i) => {
    const n = index.notes[i];
    if (n.private || isWikiIndexPath(n.rel)) return false; // frontmatter private: true or wiki routing index — never surfaced as a search hit
    if (f && !n.rel.toLowerCase().startsWith(f)) return false;
    if (t && !n.tags.has(t)) return false;
    if (mt && MEMORY_TYPES.includes(mt) && (n.memory_type || classifyNoteMemoryType(n.rel, n.meta, n.tags)) !== mt) return false;
    if (since && n.date < since) return false;
    if (until && n.date > until) return false;
    if (exclude && exclude.test(n.rel)) return false; // internal: e.g. evaluation notes
    return true;
  };
}

const RRF_K = 60;
const CJK_CHAR = /[\u3400-\u9fff]/;
const idfOf = (index, t) => Math.log(1 + (index.chunks.length || 1) / (index.df.get(t) || 1));

// opts: { limit, folder, tag, since, until, queries: [rephrasings], semantic: [{chunkIdx, sim}] lists }
export function searchIndex(index, query, opts = {}) {
  const limit = opts.limit ?? 8;
  const keep = noteFilter(index, opts);
  const results = [], guaranteed = new Set();
  const guarantee = (i, match, snippet) => { if (guaranteed.has(i) || !keep(i)) return; guaranteed.add(i); results.push(summarize(index, i, { match, score: 1, heading: '', snippet })); };
  for (const m of query.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const key = m[1].trim().replace(/\.md$/i, '');
    const hit = index.byRel.get(key + '.md') ?? (index.byTitle.get(key)?.length === 1 ? index.byTitle.get(key)[0] : undefined);
    if (hit !== undefined) guarantee(hit, 'mention', index.notes[hit].body.slice(0, 600));
  }
  // #tags in the query pull in the newest notes carrying that tag.
  for (const m of query.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) {
    for (const i of (index.byTag.get(m[1].toLowerCase()) || []).slice().sort((a, b) => index.notes[b].date.localeCompare(index.notes[a].date)).slice(0, 3)) guarantee(i, 'tag', index.notes[i].body.slice(0, 400));
  }
  const strip = (q) => q.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/(?:^|\s)#[\p{L}\p{N}_/-]+/gu, ' ');
  const queries = [query, ...(opts.queries || [])].map(strip);
  const allTerms = new Set(queries.flatMap((q) => [...terms(q)]));
  // One ranked chunk list per query (and per semantic list), fused by reciprocal rank.
  const fused = new Map(); // chunkIdx → {rrf, bm25, sim}
  const add = (list, field, w = 1) => list.forEach((x, rank) => { const e = fused.get(x.i) || { rrf: 0 }; e.rrf += w / (RRF_K + rank + 1); e[field] = Math.max(e[field] || 0, x.v); fused.set(x.i, e); });
  // When phrasings are in different scripts (a question plus its translation), each list counts
  // in proportion to how much of the vault is written in that script.
  const mixed = queries.some((q) => CJK_CHAR.test(q)) && queries.some((q) => q.trim() && !CJK_CHAR.test(q));
  const share = mixed ? cjkShare(index) : 0.5;
  for (const q of queries) {
    const qTerms = [...terms(q)];
    if (!qTerms.length) continue;
    const list = [];
    index.chunks.forEach((c, i) => { if (guaranteed.has(c.noteIdx) || !keep(c.noteIdx)) return; const v = bm25(index, qTerms, c); if (v > 0) list.push({ i, v }); });
    const w = mixed ? Math.max(0.25, CJK_CHAR.test(q) ? share : 1 - share) : 1;
    add(list.sort((a, b) => b.v - a.v).slice(0, 50), 'bm25', w);
  }
  // Title/alias field ranking: notes whose name matches the question join the candidates
  // even when their body text ranks low.
  if (allTerms.size) {
    const tl = [];
    const total = [...allTerms].reduce((a, t) => a + idfOf(index, t), 0) || 1;
    index.notes.forEach((n, i) => {
      if (guaranteed.has(i) || !keep(i) || !n.chunks.length) return;
      const tt = n.nameTerms ||= terms([n.title, ...(n.aliases || [])].join(' '));
      let v = 0;
      for (const t of allTerms) if (tt.has(t)) v += idfOf(index, t);
      // Only titles that carry a real share of the question's weight (rare words count more).
      if (v / total >= 0.3) tl.push({ i: index.chunks.findIndex((c) => c.noteIdx === i), v });
    });
    add(tl.filter((x) => x.i >= 0).sort((a, b) => b.v - a.v).slice(0, 20), 'title');
  }
  for (const sem of opts.semantic || []) add(sem.filter((x) => !guaranteed.has(index.chunks[x.chunkIdx].noteIdx) && keep(index.chunks[x.chunkIdx].noteIdx)).map((x) => ({ i: x.chunkIdx, v: x.sim })), 'sim');
  if (opts.wiki !== false && index.wiki?.present) {
    const wikiHit = queryWikiLayer(index, queries, (i) => !guaranteed.has(i) && keep(i));
    if (wikiHit.chunkCandidates.length) add(wikiHit.chunkCandidates, 'wiki', 1.25);
  }
  if (!fused.size) return results.slice(0, limit);

  const top = [...fused.entries()].map(([i, e]) => ({ c: index.chunks[i], ...e })).sort((a, b) => b.rrf - a.rrf).slice(0, 40);
  // "latest / newest / current / 最新": newer candidates get a mild boost.
  const recent = /\b(latest|newest|current|most recent|recent)\b|最新|最近|目前/i.test(query);
  if (recent) {
    const dates = [...new Set(top.map((x) => index.notes[x.c.noteIdx].date))].sort();
    for (const x of top) x.recency = dates.length > 1 ? dates.indexOf(index.notes[x.c.noteIdx].date) / (dates.length - 1) : 0;
  }
  const candidates = new Set(top.map((x) => x.c.noteIdx));
  const qList = [...allTerms];
  const memoryIntent = opts.memory_type ? null : detectQueryMemoryIntent(query);
  const nowMs = Date.now();
  for (const x of top) {
    const i = x.c.noteIdx, note = index.notes[i];
    // Graph boost among candidates only: links 1.0, co-citations 0.5, shared tags 0.3; capped at ×1.2.
    let g = 0;
    for (const o of candidates) {
      if (o === i) continue;
      if (index.backlinks[i].has(o) || index.outlinks[i].has(o)) g += 1;
      else if ([...index.backlinks[i]].some((p) => index.outlinks[p].has(o))) g += 0.5;
      if (note.tags.size && [...note.tags].some((t) => index.notes[o].tags.has(t))) g += 0.3;
    }
    x.boost = Math.min(1.2, 1 + 0.1 * Math.log(1 + g));
    x.s = x.rrf * x.boost;
    const titleTerms = note.nameTerms ||= terms([note.title, ...(note.aliases || [])].join(' '));
    if (qList.length && titleTerms.size) {
      const hit = qList.filter((t) => titleTerms.has(t));
      const qShare = hit.reduce((a, t) => a + idfOf(index, t), 0) / (qList.reduce((a, t) => a + idfOf(index, t), 0) || 1);
      // Reward both: how much of the question's weight the title covers, and how much of the title matches.
      x.s *= 1 + 0.5 * qShare + (hit.length >= 2 ? 0.6 * qShare * (hit.length / titleTerms.size) : 0);
    }
    if (recent) x.s *= 1 + 0.3 * (x.recency || 0);
    if (x.wiki) x.s *= 1 + Math.min(0.45, 0.35 * x.wiki);
    const noteDateMs = note.date ? Date.parse(note.date) : NaN;
    const ageDays = Number.isFinite(noteDateMs) ? Math.max(0, (nowMs - noteDateMs) / 86400e3) : 0;
    const mType = note.memory_type || classifyNoteMemoryType(note.rel, note.meta, note.tags);
    x.s *= memoryTypeScoreMultiplier({
      memoryType: mType,
      intent: memoryIntent,
      ageDays,
      status: note.meta?.status || '',
      superseded: Boolean(note.meta?.superseded_by),
      recentQuery: recent,
    });
    if (/(^|› )Changelog$/i.test(x.c.heading)) x.s *= 0.5;
    if (note.historical) x.s *= 0.3;
    if (note.generated) x.s *= 0.2;
    if (note.minor) x.s *= 0.35;
  }
  top.sort((a, b) => b.s - a.s
    || compareReviewTrust(index.notes[a.c.noteIdx], index.notes[b.c.noteIdx])
    || index.notes[a.c.noteIdx].rel.localeCompare(index.notes[b.c.noteIdx].rel));
  // One result per note (its best section), so five results are five different notes.
  const seenNote = new Set();
  const maxScore = top[0]?.s || 1;
  for (const x of top) {
    if (seenNote.has(x.c.noteIdx)) continue;
    seenNote.add(x.c.noteIdx);
    const match = x.bm25 && x.sim ? 'keyword+meaning' : x.sim ? 'meaning' : 'keyword';
    results.push(summarize(index, x.c.noteIdx, { match, score: +(x.s / maxScore).toFixed(3), graph_boost: +x.boost.toFixed(3), heading: x.c.heading, snippet: x.c.text.slice(0, 300), coverage: +coverage(index, x.c.noteIdx, qList).toFixed(2) }));
    if (results.length >= limit) break;
  }
  return results;
}

export function compareReviewTrust(a, b) {
  const tier = (note) => {
    const status = String(note.meta?.status || '').toLowerCase();
    const confidence = String(note.meta?.confidence || '').toLowerCase();
    if (confidence === 'verified' || ['verified', 'active', 'final'].includes(status)) return 2;
    if (['proposed', 'draft'].includes(status)) return 0;
    return 1;
  };
  return tier(b) - tier(a);
}

// How much of the query's term weight (idf) note i contains, 0..1.
export function coverage(index, i, qList) {
  const N = index.chunks.length || 1;
  const known = qList.filter((t) => index.df.get(t));
  if (!known.length) return 0;
  const idf = (t) => Math.log(1 + N / index.df.get(t));
  const have = new Set();
  for (const c of index.notes[i].chunks) for (const t of known) if (c.tokens.has(t)) have.add(t);
  return known.reduce((a, t) => a + (have.has(t) ? idf(t) : 0), 0) / known.reduce((a, t) => a + idf(t), 0);
}

// The vault's own vocabulary for CJK text: whole CJK runs from titles, aliases, tags and folder
// names (e.g. 威瑪舒培, 月眉). Built from the vault itself, so nothing is tuned to any question.
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]{2,12}/g;
export function vaultLexicon(index) {
  if (!index.lexicon) {
    const lex = new Set();
    for (const n of index.notes) {
      const names = [n.title, ...(n.aliases || []), ...n.tags, ...n.rel.split('/').slice(0, -1)];
      for (const x of names) for (const m of String(x).matchAll(CJK_RUN)) lex.add(m[0]);
    }
    index.lexicon = lex;
  }
  return index.lexicon;
}

// Search verdict: "not_in_brain" only when no result covers a fifth of the question's weight
// and (for questions in Chinese/Japanese) the question uses none of the vault's own words.
// Calibrated on a real 2,000-note vault to avoid false "not in brain" on answerable questions.
export const NOT_IN_BRAIN_COVERAGE = 0.2;

// Share of the vault's chunks written mostly in CJK (computed once per index).
export function cjkShare(index) {
  if (index.cjkShare === undefined) {
    let n = 0;
    for (const c of index.chunks) { const t = c.text.slice(0, 400); const k = (t.match(/[\u3400-\u9fff]/g) || []).length; if (k > t.length * 0.15) n++; }
    index.cjkShare = n / (index.chunks.length || 1);
  }
  return index.cjkShare;
}

// Verdict over the question and its rephrasings: each phrasing is scored on its own terms and
// the best one counts, so an English translation can rescue a Chinese question.
export function verdict(index, query, results, queries = []) {
  if (!results.length) return { status: 'not_in_brain', coverage: 0 };
  if (results.some((r) => r.match === 'mention' || r.match === 'tag')) return { status: 'hits', coverage: 1 };
  const variants = [query, ...queries].filter((q) => q && q.trim());
  let best = 0;
  for (const q of variants) {
    const qt = [...terms(q)];
    for (const r of results) { const i = index.byRel.get(r.path); if (i !== undefined) best = Math.max(best, coverage(index, i, qt)); }
  }
  const lex = vaultLexicon(index);
  const vocab = variants.filter((q) => CJK_CHAR.test(q)).flatMap((q) => [...lex].filter((w) => q.includes(w)));
  // A CJK question on a mostly non-CJK vault may simply be in the wrong language: ask for a
  // translation before ever concluding "not in brain".
  const needsTranslation = CJK_CHAR.test(query) && cjkShare(index) < 0.5 && !variants.some((q) => !CJK_CHAR.test(q));
  let status = best < NOT_IN_BRAIN_COVERAGE && !vocab.length ? 'not_in_brain' : best < 0.4 && !vocab.length ? 'weak' : 'hits';
  if (needsTranslation && status !== 'hits') status = 'weak';
// Specific words of the question that appear nowhere in the vault ("cholesterol"): the notes
  // probably don't cover it, so never present near-misses as an answer.
  const missing = [...new Set(variants.filter((q) => !CJK_CHAR.test(q)).flatMap((q) => [...terms(q)]))].filter((t) => t.length >= 5 && !index.df.get(t) && !/\d/.test(t));
  if (missing.length && status === 'hits' && !vocab.length) status = 'weak';
  // Never return confident "hits" for queries asking for credentials/passwords or personal
  // account balances: BrainLink notes do not store secrets or private balances, so adjacent
  // topic notes (e.g. a release audit or move log) must trigger abstention rather than an answer.
  const sensitiveQuery = variants.some((q) => /\b(password|passcode|credential|credentials|api[_ -]?key|access[_ -]?key|secret[_ -]?key|private[_ -]?key|account\s+balance|bank\s+balance|current\s+balance)\b/i.test(q));
  if (sensitiveQuery && status === 'hits') status = 'not_in_brain';
  return { status, coverage: +best.toFixed(2), ...(vocab.length ? { vault_words: [...new Set(vocab)].slice(0, 5) } : {}), ...(missing.length ? { missing_words: missing.slice(0, 5) } : {}), ...(needsTranslation ? { needs_translation: true } : {}) };
}

// search + verdict in one call (what the MCP tool returns).
export async function searchWithVerdict(ctx, name, query, opts = {}) {
  const results = await search(ctx, name, query, opts);
  const index = await loadVault(ctx, name);
  const rawEmb = opts.semantic === false
    ? { available: false, preferred_model: PREFERRED_EMBED_MODEL, reason: 'disabled for this search' }
    : await semanticStatus(ctx);
  const isPrivateVault = Boolean(ctx.byName.get(name)?.private);
  const emb = (rawEmb.available && isPrivateVault && !isLocalEmbedder(rawEmb))
    ? { available: false, provider: rawEmb.provider, remote: true, preferred_model: rawEmb.preferred_model || PREFERRED_EMBED_MODEL, reason: 'private vault stays keyword-only when using a remote embedding provider' }
    : rawEmb;
  const semantic = emb.available
    ? { available: true, provider: emb.provider || 'ollama', model: emb.model, preferred_model: emb.preferred_model || PREFERRED_EMBED_MODEL, ...(emb.remote ? { remote: true } : {}), ...(emb.action ? { action: emb.action } : {}) }
    : { available: false, ...(emb.provider ? { provider: emb.provider } : {}), ...(emb.remote ? { remote: true } : {}), preferred_model: emb.preferred_model || PREFERRED_EMBED_MODEL, reason: emb.reason, ...(emb.action ? { action: emb.action } : {}), ...(emb.install_url ? { install_url: emb.install_url } : {}), ...(emb.setup_hint ? { setup_hint: emb.setup_hint } : {}) };
  const v = verdict(index, String(query || ''), results, opts.queries || []);
  const wikiLayer = !index.wiki?.present
    ? { present: false, consulted: false }
    : opts.wiki === false
      ? { present: true, consulted: false }
      : (() => {
          const strip = (q) => String(q || '').replace(/\[\[[^\]]*\]\]/g, ' ').replace(/(?:^|\s)#[\p{L}\p{N}_/-]+/gu, ' ');
          const qs = [query, ...(opts.queries || [])].map(strip);
          const hit = queryWikiLayer(index, qs, noteFilter(index, opts));
          return { present: true, consulted: true, matched_folders: hit.matched_folders, matched_entries: hit.matched_entries };
        })();
  const note = v.status === 'not_in_brain' ? 'This search did not find a sufficiently strong match. Do not infer that the information is absent from the vault; suggest a rephrasing or another permitted source rather than guessing.'
    : v.needs_translation ? 'Most notes here are not in the language of this question. Search again with an English (or the notes\' language) translation in queries before answering or saying it is not in the notes.'
    : v.status === 'weak' ? `Only partial matches${v.missing_words ? ` (these words were not found in the indexed notes: ${v.missing_words.join(', ')})` : ''}. Answer only if a snippet clearly answers; otherwise explain that this search did not find a reliable answer, and suggest another search.` : null;
  const memoryIntent = opts.memory_type ? null : detectQueryMemoryIntent(query);
  const memoryTypeFilter = opts.memory_type && MEMORY_TYPES.includes(String(opts.memory_type).toLowerCase())
    ? String(opts.memory_type).toLowerCase()
    : null;
  return { status: v.status, coverage: v.coverage, semantic, wiki_layer: wikiLayer, ...(memoryIntent ? { memory_intent: memoryIntent } : {}), ...(memoryTypeFilter ? { memory_type_filter: memoryTypeFilter } : {}), ...(v.vault_words ? { vault_words: v.vault_words } : {}), ...(v.missing_words ? { missing_words: v.missing_words } : {}), ...(v.needs_translation ? { needs_translation: true } : {}), ...(note ? { note } : {}), results };
}

// Semantic layer: detect an embedder once per context; embed a slice of missing chunks
// per search so large vaults fill in gradually.
async function getEmbedder(ctx) {
  ctx.embedder ||= detectEmbedder(ctx.cfg, ctx.env);
  return ctx.embedder;
}

export async function semanticStatus(ctx) {
  return publicEmbedStatus(await getEmbedder(ctx));
}

async function semanticLists(ctx, name, index, queries) {
  const emb = await getEmbedder(ctx);
  if (!emb.available) return [];
  const remote = !isLocalEmbedder(emb);
  const isPrivateVault = Boolean(ctx.byName.get(name)?.private);
  if (remote && isPrivateVault) return [];
  const safeQueries = remote ? queries.filter((q) => findSecrets(q).length === 0) : queries;
  if (!safeQueries.length) return [];
  try {
    if (!ctx.stores.has(name)) ctx.stores.set(name, new VectorStore(ctx.dataDir, vaultRoot(ctx, name), emb.model));
    const store = ctx.stores.get(name);
    await fillVectors(emb, store, index, 64, { isPrivateVault, hasSecrets: (t) => findSecrets(t).length > 0 });
    const qvecs = await embedTexts(emb, safeQueries);
    return qvecs.map((qv) => nearest(index, store, qv));
  } catch { return []; }
}

// Pre-embed a whole vault in the background (called when the server starts).
export async function warmSemantic(ctx, name) {
  const emb = await getEmbedder(ctx);
  if (!emb.available) return null;
  const remote = !isLocalEmbedder(emb);
  const isPrivateVault = Boolean(ctx.byName.get(name)?.private);
  if (remote && isPrivateVault) return null;
  const index = await loadVault(ctx, name);
  if (!ctx.stores.has(name)) ctx.stores.set(name, new VectorStore(ctx.dataDir, vaultRoot(ctx, name), emb.model));
  let r;
  do {
    r = await fillVectors(emb, ctx.stores.get(name), index, 256, { isPrivateVault, hasSecrets: (t) => findSecrets(t).length > 0 });
  } while (r.processed > 0 && r.ready + (r.skipped || 0) < r.total);
  return r;
}

export async function search(ctx, name, query, opts = {}) {
  const strictReranker = opts.strictReranker === true;
  const searchOptions = { ...opts };
  delete searchOptions.strictReranker;
  const index = await loadVault(ctx, name);
  const q = String(query || '');
  const extra = (opts.queries || []).map(String).filter(Boolean).slice(0, 4);
  const semantic = opts.semantic === false ? [] : await semanticLists(ctx, name, index, [q, ...extra].filter((x) => x.trim()));
  const limit = opts.limit ?? 8;
  if (ctx.cfg?.reranker?.enabled !== true) return searchIndex(index, q, { ...searchOptions, queries: extra, semantic });
  const pool = Math.min(40, Math.max(limit, limit * 3));
  const candidates = searchIndex(index, q, { ...searchOptions, limit: pool, queries: extra, semantic });
  try { return (await rerankResults(ctx.cfg.reranker, q, candidates)).slice(0, limit); }
  catch (error) { if (strictReranker) throw error; return candidates.slice(0, limit); }
}

const PRIVATE_NOTE_ERROR = 'This note is private.';

export async function readNote(ctx, name, rel, { readBody = readFile } = {}) {
  const root = vaultRoot(ctx, name);
  const relInput = String(rel || '').replace(/\\/g, '/');
  const full = safeJoin(root, relInput);
  if (!full.toLowerCase().endsWith('.md')) throw new Error('Only Markdown notes can be read');
  const relNorm = path.relative(root, full).split(path.sep).join('/');
  if (await isExcludedPath(root, relNorm)) throw new Error(PRIVATE_NOTE_ERROR);
  // Direct reads must not build the full vault index just to check one known path. Validate
  // every path component, reject symlinks, and confirm the resolved target stays in this vault.
  // This preserves walk()'s symlink boundary without scanning every Markdown file first.
  let current = root;
  const parts = relNorm.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) throw new Error(PRIVATE_NOTE_ERROR);
  }
  const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
  const realRel = path.relative(realRoot, realFull);
  if (!realRel || realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) throw new Error(PRIVATE_NOTE_ERROR);
  // The index can be stale if a file changes while preserving size and timestamps. Re-read
  // only the bounded frontmatter first so a changed memory type is denied before loading the
  // note body. Keep the post-read check below as a second guard against edits during the read.
  const before = await stat(full);
  const header = await readIndexableHeader(full, before.size);
  if (!header.indexable || !twinNoteMemoryAllowed(ctx, name, relNorm, header.meta)) throw new Error(PRIVATE_NOTE_ERROR);
  const raw = await readBody(full, 'utf8');
  const { meta, body, frontmatter } = parseFrontmatter(raw);
  if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || !twinNoteMemoryAllowed(ctx, name, relNorm, meta)) throw new Error(PRIVATE_NOTE_ERROR);
  if (isWikiIndexPath(relNorm)) {
    const safe = renderAllowlistedWikiIndex(relNorm, body, meta, await loadVault(ctx, name));
    return { path: relNorm, meta: safe.meta, body: safe.body, historical: isHistorical(relNorm, safe.meta) };
  }
  return { path: rel, meta, body, historical: isHistorical(rel, meta) };
}

// Fails closed on n.private: every caller (vault_related's own "suggested" list below, and
// links.mjs's suggestLinks/buildHomeMap) must never surface a private note's title, whether as a
// suggested link, an auto-linked [[mention]] in a newly written note, or an entry in the
// generated Home map.
const eligibleFor = (index) => (j) => { const n = index.notes[j]; return !(n.historical || n.generated || n.private || isWikiIndexPath(n.rel) || ROUTING_NOTE.test(n.title) || n.body.trim().length < 120); };

export async function related(ctx, name, rel) {
  const index = await loadVault(ctx, name);
  const relNorm = normalizeWikiPath(rel);
  const i = index.byRel.get(relNorm);
  if (i === undefined || index.notes[i].private) throw new Error(`Note not found in ${name}: ${rel}`);
  const { termSets, df } = noteTerms(index);
  const exclude = new Set([i, ...index.outlinks[i], ...index.backlinks[i]]);
  const visible = (j) => !index.notes[j].private && !isWikiIndexPath(index.notes[j].rel);
  return {
    note: summarize(index, i),
    links_to: [...index.outlinks[i]].filter(visible).map((j) => summarize(index, j)),
    linked_from: [...index.backlinks[i]].filter(visible).map((j) => summarize(index, j)),
    suggested: suggestRelated(termSets[i], termSets, df, { exclude, eligible: (j) => eligibleFor(index)(j) && visible(j) }).map((s) => ({ ...summarize(index, s.j), score: +s.score.toFixed(3), shared_terms: s.shared })),
  };
}

// Suggest same-vault links for a draft or a source that is not itself a Markdown note.
// The vault index already applies privacy and profile-scope rules; this reuses the same
// shared-term ranking and candidate filters as related().
export async function relatedText(ctx, name, text, { excludePath = '' } = {}) {
  const index = await loadVault(ctx, name);
  const { termSets, df } = noteTerms(index);
  const exclude = new Set();
  const excludeNorm = excludePath ? normalizeWikiPath(excludePath) : '';
  const sourceIndex = excludeNorm ? index.byRel.get(excludeNorm) : undefined;
  if (sourceIndex !== undefined) {
    if (index.notes[sourceIndex].private) throw new Error(`Note not found in ${name}: ${excludePath}`);
    exclude.add(sourceIndex);
    for (const j of index.outlinks[sourceIndex] || []) exclude.add(j);
    for (const j of index.backlinks[sourceIndex] || []) exclude.add(j);
  }
  const visible = (j) => !index.notes[j].private && !isWikiIndexPath(index.notes[j].rel);
  return {
    suggested: suggestRelated(terms(text), termSets, df, { exclude, eligible: (j) => eligibleFor(index)(j) && visible(j) })
      .map((s) => ({ ...summarize(index, s.j), score: +s.score.toFixed(3), shared_terms: s.shared })),
  };
}

export { eligibleFor };

export async function fileInfo(full) {
  const st = await stat(full);
  return { mtime: st.mtime, ageDays: Math.floor((Date.now() - st.mtime.getTime()) / 86400e3) };
}

// ---- secrets ----

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key (sk-)'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\b(?:\d[ -]?){13,19}\b/, 'card/account-like number'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/, 'long token-like string'],
];

export function findSecrets(text) {
  // Experiment and source receipts include public cryptographic fingerprints. Mask only these
  // exact, schema-shaped fields before the generic long-token detector runs; do not exempt hashes
  // elsewhere in prose or permit arbitrary metadata fields to bypass secret scanning.
  const scanText = String(text).replace(
    /(["']?)(fixture_sha256|source_commit_sha(?:_after)?|question_sha256)\1\s*:\s*(["']?)([a-f0-9]+)\3(?=\s*[,}\]\n]|$)/gi,
    (match, keyQuote, key, _valueQuote, value) => {
      const expectedLength = ['fixture_sha256', 'question_sha256'].includes(key.toLowerCase()) ? 64 : 40;
      return value.length === expectedLength ? `${keyQuote}${key}${keyQuote}: "[public hash]"` : match;
    },
  );
  return SECRET_PATTERNS.filter(([re]) => re.test(scanText)).map(([, label]) => label);
}
