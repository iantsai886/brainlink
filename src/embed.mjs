// Flexible meaning-based search for BrainLink RAG.
// Supported providers:
//   - ollama             (default, 100% local via http://127.0.0.1:11434, nomic-embed-text)
//   - openai-compatible  (local/custom /v1/embeddings e.g. LM Studio, vLLM, LocalAI)
//   - openai             (opt-in cloud /v1/embeddings with locally stored 0600 API key)
//   - lexical            (smart zero-dependency mode: BM25 + 00 MAP/00 INDEX, no Ollama/API)
// Chunks are embedded once per content hash and cached on disk; search uses whatever
// vectors are ready and falls back to keyword + MAP/INDEX ranking for the rest.
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appHome } from './app-home.mjs';

export function detectOllamaBinary(os = process.platform, env = process.env) {
  const candidates = os === 'win32'
    ? [
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
        env.ProgramFiles ? path.join(env.ProgramFiles, 'Ollama', 'ollama.exe') : '',
      ].filter(Boolean)
    : os === 'darwin'
      ? ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama']
      : ['/usr/local/bin/ollama', '/usr/bin/ollama'];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return new Promise((resolve) => {
    execFile(os === 'win32' ? 'where' : 'which', ['ollama'], { timeout: 2000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const first = String(stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

export async function pullOllamaModel(url = DEFAULT_URL, model = PREFERRED_EMBED_MODEL, timeoutMs = 300_000) {
  const base = String(url || DEFAULT_URL).trim().replace(/\/+$/, '');
  const cleanModel = String(model || PREFERRED_EMBED_MODEL).trim();
  if (!cleanModel || !/^[a-zA-Z0-9._:/-]+$/.test(cleanModel)) {
    throw new Error('Invalid Ollama model name.');
  }
  return getJson(`${base}/api/pull`, { name: cleanModel, stream: false }, timeoutMs);
}

export const DEFAULT_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
export const DEFAULT_LOCAL_COMPAT_URL = 'http://127.0.0.1:1234/v1';
export const PREFERRED_EMBED_MODEL = 'nomic-embed-text';
export const DEFAULT_OPENAI_EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_PROVIDERS = Object.freeze(['ollama', 'openai-compatible', 'openai', 'lexical']);
export const RECOMMENDED_OLLAMA_EMBED_MODELS = Object.freeze([
  { name: 'nomic-embed-text', note: 'Fast, lightweight (~274 MB, recommended)' },
  { name: 'mxbai-embed-large', note: 'Higher accuracy English (~670 MB)' },
  { name: 'bge-m3', note: 'Best multilingual / Chinese + English (~1.2 GB)' },
  { name: 'all-minilm', note: 'Ultra-tiny & fast (~45 MB)' },
  { name: 'snowflake-arctic-embed', note: 'Strong retrieval (~670 MB)' },
]);
const PROVIDER_SET = new Set(EMBED_PROVIDERS);

const PREFERRED = [PREFERRED_EMBED_MODEL, 'mxbai-embed-large', 'bge-m3', 'all-minilm', 'snowflake-arctic-embed'];
const PULL_HINT = `Run: ollama pull ${PREFERRED_EMBED_MODEL}`;
const INSTALL_HINT = `Install Ollama from https://ollama.com, start it locally, then run: ollama pull ${PREFERRED_EMBED_MODEL}`;

export function embedKeyPath(homeDir) {
  return path.join(homeDir, 'embed-api-key');
}

export async function readEmbedApiKey(homeDir) {
  if (!homeDir) return '';
  try { return (await readFile(embedKeyPath(homeDir), 'utf8')).trim(); }
  catch { return ''; }
}

export async function saveEmbedApiKey(homeDir, apiKey) {
  if (!homeDir) throw new Error('homeDir is required to save embed API key');
  const file = embedKeyPath(homeDir);
  const clean = String(apiKey || '').trim();
  if (!clean) {
    try { await unlink(file); } catch {}
    return false;
  }
  await mkdir(homeDir, { recursive: true });
  await writeFile(file, clean + '\n', { mode: 0o600, encoding: 'utf8' });
  return true;
}

async function getJson(url, body, timeoutMs, extraHeaders = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = body ? { 'Content-Type': 'application/json', ...extraHeaders } : { ...extraHeaders };
    const r = await fetch(url, body ? { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal } : { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// { available, provider, url, model, preferred_model, action, install_url, reason, setup_hint }
export async function detectEmbedder(cfg = {}, env = process.env) {
  const sem = cfg.semantic || {};
  const rawProvider = String(env.BRAINLINK_EMBED_PROVIDER || sem.provider || 'ollama').trim().toLowerCase();
  const provider = PROVIDER_SET.has(rawProvider) ? rawProvider : 'ollama';

  if (provider === 'lexical' || sem.enabled === false || /^(0|false|off)$/i.test(env.BRAINLINK_SEMANTIC || '')) {
    const isExplicitLexical = provider === 'lexical';
    return {
      available: false,
      provider: isExplicitLexical ? 'lexical' : provider,
      action: isExplicitLexical ? 'lexical_active' : 'disabled',
      preferred_model: PREFERRED_EMBED_MODEL,
      reason: isExplicitLexical
        ? 'Smart Lexical + MAP/INDEX mode active (no Ollama or API needed)'
        : 'turned off in settings',
      setup_hint: isExplicitLexical ? '' : `Enable semantic search in settings and ${PULL_HINT.toLowerCase()}`,
    };
  }

  if (provider === 'openai' || provider === 'openai-compatible') {
    const defaultBase = provider === 'openai' ? DEFAULT_OPENAI_URL : DEFAULT_LOCAL_COMPAT_URL;
    const url = String(env.BRAINLINK_EMBED_URL || sem.url || defaultBase).trim().replace(/\/+$/, '');
    const model = String(env.BRAINLINK_EMBED_MODEL || sem.model || (provider === 'openai' ? DEFAULT_OPENAI_EMBED_MODEL : PREFERRED_EMBED_MODEL)).trim();
    const homeDir = appHome(env);
    const savedKey = await readEmbedApiKey(homeDir);
    const apiKey = String(env.BRAINLINK_EMBED_API_KEY || (provider === 'openai' ? env.OPENAI_API_KEY : '') || savedKey || '').trim();

    if (provider === 'openai' && !apiKey) {
      return {
        available: false,
        provider,
        url,
        model,
        preferred_model: DEFAULT_OPENAI_EMBED_MODEL,
        action: 'set_api_key',
        reason: 'API key required for cloud embeddings',
        setup_hint: 'Add your API key in RAG settings or set BRAINLINK_EMBED_API_KEY',
      };
    }

    if (provider === 'openai-compatible') {
      try {
        await getJson(`${url}/models`, null, 2500, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
      } catch {
        return {
          available: false,
          provider,
          url,
          model,
          preferred_model: model,
          action: 'start_local_server',
          reason: `OpenAI-compatible server not reachable at ${url}`,
          setup_hint: `Start LM Studio / local server at ${url}, or switch to Ollama / Smart Lexical`,
        };
      }
    }

    return {
      available: true,
      provider,
      url,
      model,
      preferred_model: model,
      action: 'ready',
      has_api_key: Boolean(apiKey),
      _apiKey: apiKey,
    };
  }

  // Default: local Ollama
  const url = (env.BRAINLINK_EMBED_URL || sem.url || DEFAULT_URL).replace(/\/+$/, '');
  try {
    const tags = await getJson(`${url}/api/tags`, null, 2500);
    const names = (tags.models || []).map((m) => m.name || m.model).filter(Boolean);
    let runningModels = [];
    try {
      const ps = await getJson(`${url}/api/ps`, null, 1000);
      runningModels = (ps.models || []).map((m) => m.name || m.model).filter(Boolean);
    } catch {}
    const want = env.BRAINLINK_EMBED_MODEL || sem.model;
    const model = want ? names.find((n) => n === want || n.startsWith(want + ':')) : PREFERRED.map((p) => names.find((n) => n.startsWith(p))).find(Boolean) || names.find((n) => /embed/i.test(n));
    if (!model) {
      return {
        available: false,
        provider: 'ollama',
        url,
        preferred_model: PREFERRED_EMBED_MODEL,
        installed_models: names,
        running_models: runningModels,
        action: 'pull_model',
        install_url: 'https://ollama.com',
        reason: names.length ? `no embedding model installed (${PULL_HINT.toLowerCase()})` : `Ollama has no models (${PULL_HINT.toLowerCase()})`,
        setup_hint: PULL_HINT,
      };
    }
    return {
      available: true,
      provider: 'ollama',
      url,
      model,
      preferred_model: PREFERRED_EMBED_MODEL,
      installed_models: names,
      running_models: runningModels,
      action: 'ready',
    };
  } catch {
    const isDefaultLocal = url === DEFAULT_URL;
    const bin = isDefaultLocal ? await detectOllamaBinary(process.platform, env) : null;
    if (bin) {
      return {
        available: false,
        provider: 'ollama',
        url,
        preferred_model: PREFERRED_EMBED_MODEL,
        installed: true,
        action: 'start_ollama',
        install_url: 'https://ollama.com',
        reason: 'Ollama is installed, but not running yet',
        setup_hint: 'Start Ollama locally (or click Start Ollama in RAG settings)',
      };
    }
    return {
      available: false,
      provider: 'ollama',
      url,
      preferred_model: PREFERRED_EMBED_MODEL,
      installed: false,
      action: 'install_ollama',
      install_url: 'https://ollama.com',
      reason: 'Ollama is not running (install it from ollama.com, or choose API / Smart Lexical mode)',
      setup_hint: INSTALL_HINT,
    };
  }
}

export function publicEmbedStatus(emb) {
  if (!emb || typeof emb !== 'object') return emb;
  const { _apiKey, ...safe } = emb;
  return safe;
}

export function normalizeVec(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export async function embedTexts(emb, texts) {
  if (emb.provider === 'openai' || emb.provider === 'openai-compatible') {
    const headers = emb._apiKey ? { Authorization: `Bearer ${emb._apiKey}` } : {};
    const r = await getJson(`${emb.url}/embeddings`, { model: emb.model, input: texts }, 120000, headers);
    if (!Array.isArray(r.data) || r.data.length !== texts.length) throw new Error('unexpected OpenAI embedding response');
    const ordered = [...r.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((item) => normalizeVec(item.embedding));
  }
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
    const key = c.vkey ||= chunkKey(chunkText(index.notes[c.noteIdx], c));
    if (!store.vectors.has(key) && !queued.has(key)) { queued.add(key); missing.push(c); }
    if (missing.length >= budget) break;
  }
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    const vecs = await embedTexts(emb, batch.map((c) => chunkText(index.notes[c.noteIdx], c)));
    batch.forEach((c, j) => store.vectors.set(c.vkey, vecs[j]));
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
  index.chunks.forEach((c, i) => {
    const v = c.vkey && store.vectors.get(c.vkey);
    if (v && v.length === qv.length) {
      const sim = cosine(qv, v);
      if (sim >= minSim) out.push({ chunkIdx: i, sim });
    }
  });
  return out.sort((a, b) => b.sim - a.sim).slice(0, k);
}
