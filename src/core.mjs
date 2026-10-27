// Runtime context (config + per-connection env), vault index, search, read and
// related notes. Retrieval: heading-ancestry chunks; guaranteed [[mention]] and #tag hits;
// BM25 over stemmed terms, fused (reciprocal rank) across the query, its rephrasings and the
// optional semantic ranking; capped graph boost from links, co-citations and shared tags;
// title boost; demotion of superseded / archived notes; date, folder and tag filters.
import { readdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { termFrequencies, terms, linkGraph, collection, suggestRelated, extractTags } from './graph.mjs';
import { deriveTypedRelations } from './typed-graph.mjs';
import { appHome } from './config.mjs';
import { detectEmbedder, VectorStore, fillVectors, embedTexts, nearest } from './embed.mjs';
import { findAgentByToken, publicAgent } from './mcp-agents.mjs';
import { resolveTwinAgentScope, twinNoteMemoryAllowed } from './twin-profiles.mjs';

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
    cfg, features: FEATURES, byName, enabled, readOnly, env, twinScope,
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
export const isMinor = (rel, title) => /^(_?README|00 INDEX|00 MAP|INDEX|MAP)$|^(DRAFT|PROMOTED|COPY)\b|^00 (INDEX|MAP)\b/.test(title) || /(^|\/)_staging\//.test(rel);

export const ROUTING_NOTE = /^(_?README|00 INDEX|00 MAP|INDEX|Home)$|^00 Moved\b|\bpointer\b/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.backups']);

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
export const DEFAULT_EXCLUDED_FOLDERS = ['.obsidian/', '.trash/', '.git/', 'node_modules/', '00 Home/'];
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
    if (f.name.startsWith('.') || SKIP_DIRS.has(f.name)) continue;
    if (rules.some((re) => re.test(f.name))) continue;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) await walk(root, full, out, rules);
    else if (f.isFile() && f.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

// Same accumulated-rule logic as walk(), for a single already-known relative path (readNote()):
// true if any ancestor folder, or the file itself, is excluded at any depth.
export async function isExcludedPath(root, rel) {
  const parts = String(rel).split('/');
  let dir = root, rules = [];
  for (const name of parts) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) return true;
    rules = rules.concat(await ignoreRules(dir));
    if (rules.some((re) => re.test('*') || re.source === '^.*$')) return true;
    if (rules.some((re) => re.test(name))) return true;
    dir = path.join(dir, name);
  }
  return false;
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

// Hash-incremental: unchanged files are not re-chunked on the next call.
export async function loadVault(ctx, name) {
  const root = vaultRoot(ctx, name);
  const state = ctx.cache.get(name) || { files: new Map(), index: null };
  const seen = new Set();
  let changed = !state.index;
  for (const full of await walk(root)) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    seen.add(rel);
    const prev = state.files.get(rel);
    if (prev) { const st = await stat(full); if (st.mtimeMs === prev.mtime && st.size === prev.bytes) continue; }
    const stNow = await stat(full);
    // Configured paths such as the handoff mailbox and capture log have known types;
    // exclude them before even opening their Markdown body.
    if (!twinNoteMemoryAllowed(ctx, name, rel)) {
      changed = true;
      state.files.set(rel, { hash: null, mtime: stNow.mtimeMs, bytes: stNow.size, note: null });
      continue;
    }
    const header = await readIndexableHeader(full, stNow.size);
    if (!header.indexable || !twinNoteMemoryAllowed(ctx, name, rel, header.meta)) {
      changed = true;
      state.files.set(rel, { hash: null, mtime: stNow.mtimeMs, bytes: stNow.size, note: null });
      continue;
    }
    const raw = await readFile(full, 'utf8');
    const hash = createHash('sha1').update(raw).digest('hex');
    if (prev?.hash === hash) { prev.mtime = stNow.mtimeMs; prev.bytes = stNow.size; continue; }
    changed = true;
    const { meta, body, frontmatter } = parseFrontmatter(raw);
    const mtime = stNow.mtimeMs;
    const title = path.posix.basename(rel).replace(/\.md$/i, '');
    const aliases = listValue(meta.aliases);
    const names = [title, ...aliases].join(' ');
    const chunks = chunkMarkdown(body).map((c, i) => ({ ...c, id: `${rel}#${i}`, tokens: termFrequencies(`${names} ${c.heading} ${c.text}`) }));
    // Recheck after the full read in case the file changed between the header and body reads.
    if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || !twinNoteMemoryAllowed(ctx, name, rel, meta)) {
      state.files.set(rel, { hash: null, mtime: stNow.mtimeMs, bytes: stNow.size, note: null });
      continue;
    }
    state.files.set(rel, { hash, mtime, bytes: stNow.size, note: { rel, title, aliases, raw, meta, body, chunks, mtime, minor: isMinor(rel, title), date: noteDate(rel, meta, mtime), tags: extractTags(body, meta), generated: meta.generated_by === 'brainlink' || /^BrainLink\/Commands\//i.test(rel), historical: isHistorical(rel, meta), private: false } });
  }
  for (const rel of [...state.files.keys()]) if (!seen.has(rel)) { state.files.delete(rel); changed = true; }
  if (changed) state.index = buildIndex([...state.files.values()].map((f) => f.note).filter(Boolean).sort((a, b) => a.rel.localeCompare(b.rel)));
  ctx.cache.set(name, state);
  return state.index;
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
  const chunks = notes.flatMap((n, noteIdx) => n.chunks.map((c) => ({ ...c, noteIdx, len: [...c.tokens.values()].reduce((s, x) => s + x, 0) })));
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
  return { notes, chunks, df, avgLen, backlinks, outlinks, byRel, byTitle, byAlias, byTag, edges, broken, typedRelations, termSets: null };
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
  return { path: n.rel, title: n.title, date: n.date, status: n.meta.status || '', collection: collection(n.rel), ...(n.tags.size ? { tags: [...n.tags] } : {}), historical: n.historical, ...(n.meta.superseded_by ? { superseded_by: n.meta.superseded_by } : {}), ...extra };
}

// Filter predicate from {folder, tag, since, until}.
export function noteFilter(index, { folder, tag, since, until, exclude } = {}) {
  const f = folder ? String(folder).replace(/^\/+|\/+$/g, '').toLowerCase() + '/' : null;
  const t = tag ? String(tag).replace(/^#/, '').toLowerCase() : null;
  return (i) => {
    const n = index.notes[i];
    if (n.private) return false; // frontmatter private: true — never surfaced outside readNote's own check
    if (f && !n.rel.toLowerCase().startsWith(f)) return false;
    if (t && !n.tags.has(t)) return false;
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
    if (/(^|› )Changelog$/i.test(x.c.heading)) x.s *= 0.5;
    if (note.historical) x.s *= 0.3;
    if (note.generated) x.s *= 0.2;
    if (note.minor) x.s *= 0.35;
  }
  top.sort((a, b) => b.s - a.s);
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
  return { status, coverage: +best.toFixed(2), ...(vocab.length ? { vault_words: [...new Set(vocab)].slice(0, 5) } : {}), ...(missing.length ? { missing_words: missing.slice(0, 5) } : {}), ...(needsTranslation ? { needs_translation: true } : {}) };
}

// search + verdict in one call (what the MCP tool returns).
export async function searchWithVerdict(ctx, name, query, opts = {}) {
  const results = await search(ctx, name, query, opts);
  const index = await loadVault(ctx, name);
  const v = verdict(index, String(query || ''), results, opts.queries || []);
  const note = v.status === 'not_in_brain' ? 'Nothing in this vault answers this. Tell the user it is not in their notes rather than guessing from these results.'
    : v.needs_translation ? 'Most notes here are not in the language of this question. Search again with an English (or the notes\' language) translation in queries before answering or saying it is not in the notes.'
    : v.status === 'weak' ? `Only partial matches${v.missing_words ? ` (these words appear nowhere in the notes: ${v.missing_words.join(', ')})` : ''}. Answer only if a snippet clearly answers; otherwise say it is not in the notes.` : null;
  return { status: v.status, coverage: v.coverage, ...(v.vault_words ? { vault_words: v.vault_words } : {}), ...(v.missing_words ? { missing_words: v.missing_words } : {}), ...(note ? { note } : {}), results };
}

// Semantic layer: detect a local embedder once per context; embed a slice of missing chunks
// per search so large vaults fill in gradually.
export async function semanticStatus(ctx) {
  ctx.embedder ||= detectEmbedder(ctx.cfg, ctx.env);
  return ctx.embedder;
}

async function semanticLists(ctx, name, index, queries) {
  const emb = await semanticStatus(ctx);
  if (!emb.available) return [];
  try {
    if (!ctx.stores.has(name)) ctx.stores.set(name, new VectorStore(ctx.dataDir, vaultRoot(ctx, name), emb.model));
    const store = ctx.stores.get(name);
    await fillVectors(emb, store, index, 64);
    const qvecs = await embedTexts(emb, queries);
    return qvecs.map((qv) => nearest(index, store, qv));
  } catch { return []; }
}

// Pre-embed a whole vault in the background (called when the server starts).
export async function warmSemantic(ctx, name) {
  const emb = await semanticStatus(ctx);
  if (!emb.available) return null;
  const index = await loadVault(ctx, name);
  if (!ctx.stores.has(name)) ctx.stores.set(name, new VectorStore(ctx.dataDir, vaultRoot(ctx, name), emb.model));
  let r;
  do { r = await fillVectors(emb, ctx.stores.get(name), index, 256); } while (r.ready < r.total);
  return r;
}

export async function search(ctx, name, query, opts = {}) {
  const index = await loadVault(ctx, name);
  const q = String(query || '');
  const extra = (opts.queries || []).map(String).filter(Boolean).slice(0, 4);
  const semantic = opts.semantic === false ? [] : await semanticLists(ctx, name, index, [q, ...extra].filter((x) => x.trim()));
  return searchIndex(index, q, { ...opts, queries: extra, semantic });
}

const PRIVATE_NOTE_ERROR = 'This note is private.';

export async function readNote(ctx, name, rel) {
  const root = vaultRoot(ctx, name);
  const full = safeJoin(root, rel);
  if (!full.toLowerCase().endsWith('.md')) throw new Error('Only Markdown notes can be read');
  const relNorm = path.relative(root, full).split(path.sep).join('/');
  if (await isExcludedPath(root, relNorm)) throw new Error(PRIVATE_NOTE_ERROR);
  // safeJoin only resolves `..`/absolute-path tricks (path.resolve), not symlinks: a file or
  // directory symlink that *looks* like it's inside the vault can still point at 00 Home or
  // anywhere else on disk. walk() (the index builder) already skips symlinks entirely, so
  // requiring the note to be indexed under this exact relative path closes that gap for free —
  // a symlinked path is simply never in index.byRel, no matter what it resolves to on disk.
  const index = await loadVault(ctx, name);
  const i = index.byRel.get(relNorm);
  if (i === undefined || index.notes[i].private) throw new Error(PRIVATE_NOTE_ERROR);
  const raw = await readFile(full, 'utf8');
  const { meta, body, frontmatter } = parseFrontmatter(raw);
  if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || !twinNoteMemoryAllowed(ctx, name, relNorm, meta)) throw new Error(PRIVATE_NOTE_ERROR);
  return { path: rel, meta, body, historical: isHistorical(rel, meta) };
}

// Fails closed on n.private: every caller (vault_related's own "suggested" list below, and
// links.mjs's suggestLinks/buildHomeMap) must never surface a private note's title, whether as a
// suggested link, an auto-linked [[mention]] in a newly written note, or an entry in the
// generated Home map.
const eligibleFor = (index) => (j) => { const n = index.notes[j]; return !(n.historical || n.generated || n.private || ROUTING_NOTE.test(n.title) || n.body.trim().length < 120); };

export async function related(ctx, name, rel) {
  const index = await loadVault(ctx, name);
  const i = index.byRel.get(rel);
  if (i === undefined || index.notes[i].private) throw new Error(`Note not found in ${name}: ${rel}`);
  const { termSets, df } = noteTerms(index);
  const exclude = new Set([i, ...index.outlinks[i], ...index.backlinks[i]]);
  const notPrivate = (j) => !index.notes[j].private;
  return {
    note: summarize(index, i),
    links_to: [...index.outlinks[i]].filter(notPrivate).map((j) => summarize(index, j)),
    linked_from: [...index.backlinks[i]].filter(notPrivate).map((j) => summarize(index, j)),
    suggested: suggestRelated(termSets[i], termSets, df, { exclude, eligible: (j) => eligibleFor(index)(j) && notPrivate(j) }).map((s) => ({ ...summarize(index, s.j), score: +s.score.toFixed(3), shared_terms: s.shared })),
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
  return SECRET_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}
