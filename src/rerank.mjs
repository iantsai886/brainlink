// Optional local cross-encoder reranking. Only pre-filtered search candidates are sent to an
// explicitly configured loopback service; failures leave the normal BrainLink ranking intact.
const MAX_CANDIDATES = 20;
const TIMEOUT_MS = 30_000;
const LOOPBACKS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function validateRerankerSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Reranker settings must be an object.');
  for (const key of Object.keys(input)) if (!['enabled', 'url'].includes(key)) throw new Error(`Unknown reranker setting: ${key}`);
  const enabled = input.enabled === true;
  const urlText = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : 'http://127.0.0.1:8080/v1/rerank';
  let parsed;
  try { parsed = new URL(urlText); } catch { throw new Error('Enter a valid local reranker URL.'); }
  if (parsed.protocol !== 'http:' || !LOOPBACKS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Reranker must use plain HTTP on this computer only, without credentials or query parameters.');
  }
  if (!['/rerank', '/v1/rerank', '/v1/reranking'].includes(parsed.pathname.replace(/\/$/, '') || '/')) {
    throw new Error('Use a supported local rerank endpoint: /rerank, /v1/rerank, or /v1/reranking.');
  }
  return { enabled, url: `${parsed.origin}${parsed.pathname.replace(/\/$/, '') || '/v1/rerank'}` };
}

function candidateText(result) {
  return [result.title, result.heading, result.snippet].filter(Boolean).join('\n').slice(0, 1200);
}

function parseOrder(body, count) {
  const rows = Array.isArray(body) ? body : body?.results;
  if (!Array.isArray(rows)) throw new Error('The local reranker returned an invalid response.');
  const seen = new Set(), ranked = [];
  for (const row of rows) {
    const index = row?.index;
    const score = row?.relevance_score ?? row?.score;
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index) || !Number.isFinite(score)) continue;
    seen.add(index);
    ranked.push({ index, score });
  }
  if (!ranked.length) throw new Error('The local reranker returned no usable scores.');
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map((item) => item.index);
}

export async function rerankResults(settings, query, results, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const config = validateRerankerSettings(settings);
  if (!config.enabled || !Array.isArray(results) || results.length < 2 || !String(query || '').trim()) return results;

  // Exact note links and explicit tag requests are deterministic user intent; keep them pinned.
  const pinned = results.filter((item) => item.match === 'mention' || item.match === 'tag');
  const candidates = results.filter((item) => item.match !== 'mention' && item.match !== 'tag');
  const batch = candidates.slice(0, MAX_CANDIDATES);
  if (batch.length < 2) return results;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ query: String(query).slice(0, 2000), documents: batch.map(candidateText), top_n: batch.length }),
    });
    if (!response.ok) throw new Error(`Local reranker returned HTTP ${response.status}.`);
    const order = parseOrder(await response.json(), batch.length);
    const ranked = order.map((index) => batch[index]);
    const returned = new Set(order);
    for (let i = 0; i < batch.length; i++) if (!returned.has(i)) ranked.push(batch[i]);
    return [...pinned, ...ranked, ...candidates.slice(batch.length)];
  } finally { clearTimeout(timer); }
}

export async function testReranker(settings, options = {}) {
  const config = validateRerankerSettings({ ...settings, enabled: true });
  const started = Date.now();
  const results = await rerankResults(config, 'Which note explains local reranking?', [
    { title: 'Local reranking', heading: 'Setup', snippet: 'Run a local cross-encoder to reorder search results.' },
    { title: 'Backup', heading: 'Schedule', snippet: 'Create a verified copy of the vault every day.' },
  ], options);
  // A connection test checks that the service speaks the supported protocol. Ranking quality
  // needs a separate benchmark and must not be inferred from this tiny synthetic request.
  return { ok: results.length === 2, elapsed_ms: Date.now() - started };
}

export const rerankerLimits = Object.freeze({ maxCandidates: MAX_CANDIDATES, timeoutMs: TIMEOUT_MS });
