// Optional meaning-based search with a local embedding model (Ollama). Nothing leaves the
// computer. Chunks are embedded once per content hash and cached on disk; search uses whatever
// vectors are ready and falls back to keyword ranking for the rest.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_URL = 'http://127.0.0.1:11434';
export const PREFERRED_EMBED_MODEL = 'nomic-embed-text';
const PREFERRED = [PREFERRED_EMBED_MODEL, 'mxbai-embed-large', 'bge-m3', 'all-minilm', 'snowflake-arctic-embed'];
const PULL_HINT = `Run: ollama pull ${PREFERRED_EMBED_MODEL}`;
const INSTALL_HINT = `Install Ollama from https://ollama.com, start it locally, then run: ollama pull ${PREFERRED_EMBED_MODEL}`;

async function getJson(url, body, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// { available, url, model, preferred_model, reason, setup_hint }. Model: configured, else the first installed embedding model.
export async function detectEmbedder(cfg = {}, env = process.env) {
  const sem = cfg.semantic || {};
  if (sem.enabled === false || /^(0|false|off)$/i.test(env.BRAINLINK_SEMANTIC || '')) {
    return { available: false, preferred_model: PREFERRED_EMBED_MODEL, reason: 'turned off in settings', setup_hint: `Enable semantic search in settings and ${PULL_HINT.toLowerCase()}` };
  }
  const url = (env.BRAINLINK_EMBED_URL || sem.url || DEFAULT_URL).replace(/\/+$/, '');
  try {
    const tags = await getJson(`${url}/api/tags`, null, 2500);
    const names = (tags.models || []).map((m) => m.name || m.model).filter(Boolean);
    const want = env.BRAINLINK_EMBED_MODEL || sem.model;
    const model = want ? names.find((n) => n === want || n.startsWith(want + ':')) : PREFERRED.map((p) => names.find((n) => n.startsWith(p))).find(Boolean) || names.find((n) => /embed/i.test(n));
    if (!model) {
      return {
        available: false,
        url,
        preferred_model: PREFERRED_EMBED_MODEL,
        reason: names.length ? `no embedding model installed (${PULL_HINT.toLowerCase()})` : `Ollama has no models (${PULL_HINT.toLowerCase()})`,
        setup_hint: PULL_HINT,
      };
    }
    return { available: true, url, model, preferred_model: PREFERRED_EMBED_MODEL };
  } catch {
    return {
      available: false,
      url,
      preferred_model: PREFERRED_EMBED_MODEL,
      reason: 'Ollama is not running (install it from ollama.com for meaning-based search)',
      setup_hint: INSTALL_HINT,
    };
  }
}

export function normalizeVec(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export async function embedTexts(emb, texts) {
  const r = await getJson(`${emb.url}/api/embed`, { model: emb.model, input: texts }, 120000);
  if (!Array.isArray(r.embeddings) || r.embeddings.length !== texts.length) throw new Error('unexpected embedding response');
  return r.embeddings.map(normalizeVec);
}

const chunkKey = (text) => createHash('sha1').update(text).digest('hex').slice(0, 20);

// Per-vault store: Map(chunkKey → Float32Array), persisted as JSON in the app folder.
export class VectorStore {
  constructor(dir, vaultPath, model) {
    this.file = path.join(dir, 'embeddings', `${createHash('sha1').update(vaultPath + '|' + model).digest('hex').slice(0, 16)}.json`);
    this.vectors = new Map();
    this.loaded = false;
    this.dirty = false;
  }
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try { for (const [k, v] of Object.entries(JSON.parse(await readFile(this.file, 'utf8')))) this.vectors.set(k, Float32Array.from(v)); } catch {}
  }
  async save() {
    if (!this.dirty) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const obj = {};
    for (const [k, v] of this.vectors) obj[k] = Array.from(v, (x) => +x.toFixed(5));
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(obj));
    await rename(tmp, this.file);
    this.dirty = false;
  }
}

export const chunkText = (note, c) => `${note.title}${c.heading ? ' › ' + c.heading : ''}\n${c.text}`.slice(0, 2000);

// Embed chunks that have no vector yet, up to `budget` per call. Returns how many are done.
export async function fillVectors(emb, store, index, budget = 256) {
  await store.load();
  // Old builds could have embedded private notes before the output filter ran. Keep only keys
  // belonging to the current permission-filtered index, even when no new embedding is needed.
  const visibleKeys = new Set(index.chunks.map((c) => c.vkey ||= chunkKey(chunkText(index.notes[c.noteIdx], c))));
  for (const key of store.vectors.keys()) if (!visibleKeys.has(key)) { store.vectors.delete(key); store.dirty = true; }
  const missing = [], queued = new Set();
  for (const c of index.chunks) {
    c.vkey ||= chunkKey(chunkText(index.notes[c.noteIdx], c));
    if (!store.vectors.has(c.vkey) && !queued.has(c.vkey)) { queued.add(c.vkey); missing.push(c); }
    if (missing.length >= budget) break;
  }
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    const vecs = await embedTexts(emb, batch.map((c) => chunkText(index.notes[c.noteIdx], c)));
    batch.forEach((c, k) => store.vectors.set(c.vkey, vecs[k]));
    store.dirty = true;
  }
  if (store.dirty) await store.save();
  const total = index.chunks.length;
  const ready = index.chunks.filter((c) => store.vectors.has(c.vkey)).length;
  return { ready, total };
}

// Nearest chunks to the query vector: [{chunkIdx, sim}].
export function nearest(index, store, qv, k = 30, minSim = 0.3) {
  const out = [];
  index.chunks.forEach((c, i) => { const v = c.vkey && store.vectors.get(c.vkey); if (v) { const sim = cosine(qv, v); if (sim >= minSim) out.push({ chunkIdx: i, sim }); } });
  return out.sort((a, b) => b.sim - a.sim).slice(0, k);
}
