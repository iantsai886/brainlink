// Opt-in RSI research discovery. Off by default; when the user enables it, BrainLink queries one
// fixed public research feed (arXiv's Atom API) for the user's topic terms, keeps only entries that
// match one of the user's own problem statements and a BrainLink memory/agent workflow, and appends
// them to the local RSI ledger as `discovered` proposals. It never fetches a caller-supplied URL,
// never sends problem statements or vault content off the machine, never executes or promotes
// anything, and never moves a proposal past `discovered`.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findSecrets } from './core.mjs';

// The only network origin discovery may contact. Adding a source is a reviewed code change.
export const DISCOVERY_SOURCES = Object.freeze({
  arxiv: Object.freeze({ id: 'arxiv', label: 'arXiv', host: 'export.arxiv.org', path: '/api/query', entryHosts: ['arxiv.org', 'www.arxiv.org'] }),
});
const ALLOWED_HOSTS = new Set(Object.values(DISCOVERY_SOURCES).map(s => s.host));
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 15_000;
const MAX_ENTRIES_PER_FEED = 25;
const MAX_RUNS_KEPT = 10;
const MAX_EVENTS_KEPT = 20;

export const DEFAULT_DISCOVERY = Object.freeze({ enabled: false, paused: false, sources: ['arxiv'], topics: [], signals: [], interval_hours: 168, max_new_per_run: 5 });

// BrainLink workflow vocabulary: an entry must touch at least one of these to be relevant, and the
// matched group names the memory type shown to the reviewer.
const WORKFLOW_TERMS = {
  working: ['working memory', 'context window', 'long context', 'handoff', 'session', 'continuation', 'context compression', 'summarization'],
  semantic: ['retrieval', 'rag', 'knowledge graph', 'embedding', 'semantic memory', 'semantic search', 'knowledge base', 'note'],
  procedural: ['procedural memory', 'skill', 'tool use', 'workflow', 'planning'],
  episodic: ['episodic memory', 'conversation history', 'reflection', 'trajectory', 'experience replay'],
};
const GENERAL_TERMS = ['agent', 'memory', 'language model', 'llm'];
const STOPWORDS = new Set('a an and are as at be by can do does for from has have how in into is it its of on or our so than that the their them then there these this to too was we were what when which while who why will with without you your after before about across again all also any because been being both but each few more most much need needs not only other over same should some such very via who'.split(' '));

// Text that tries to address an AI or a reviewer is treated as hostile and the entry is dropped,
// so no downstream agent ever reads it as part of a proposal.
const INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|system)\b[^.]{0,20}\b(?:instructions?|prompts?|rules?|messages?)\b/i,
  /\bsystem prompt\b/i,
  /\byou are (?:now )?(?:an? )?(?:ai|assistant|chatgpt|claude|language model)\b/i,
  /<\|[^|]{0,40}\|>/,
  /\b(?:begin|end) (?:system|instructions?)\b/i,
  /\b(?:send|post|upload|exfiltrate|reveal|print)\b[^.]{0,40}\b(?:api keys?|tokens?|passwords?|secrets?|credentials?|private notes?)\b/i,
  /\b(?:run|execute)\b[^.]{0,20}\b(?:this|the following) (?:command|code|script)\b/i,
];

const clean = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
// Strip control and bidirectional-override characters that can disguise text in the UI.
const stripInvisible = (value) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '');

// ---- settings ----

function validateTerms(list, { name, max, min, maxLength, pattern }) {
  if (!Array.isArray(list) || list.length > max) throw new Error(`${name} must be a list of at most ${max} entries.`);
  return [...new Set(list.map((item) => {
    if (typeof item !== 'string') throw new Error(`${name} entries must be text.`);
    const value = clean(stripInvisible(item), maxLength + 1);
    if (value.length < min || value.length > maxLength) throw new Error(`${name} entries must be ${min}-${maxLength} characters.`);
    if (pattern && !pattern.test(value)) throw new Error(`${name} entries may contain only letters, numbers, spaces and - + .`);
    if (findSecrets(value).length) throw new Error(`Potential secret detected in ${name}; remove it.`);
    if (/https?:|www\.|[\w.+-]+@[\w-]+\.[\w.]+/i.test(value)) throw new Error(`${name} must not contain URLs or email addresses.`);
    return value;
  }))];
}

export function validateDiscoverySettings(input, previous = DEFAULT_DISCOVERY) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Discovery settings must be an object.');
  const next = { ...previous };
  if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false.'); next.enabled = input.enabled; }
  if ('topics' in input) next.topics = validateTerms(input.topics, { name: 'topics', max: 5, min: 2, maxLength: 60, pattern: /^[\p{L}\p{N}][\p{L}\p{N} .+-]*$/u });
  if ('signals' in input) next.signals = validateTerms(input.signals, { name: 'signals', max: 8, min: 8, maxLength: 200 });
  if ('interval_hours' in input) {
    if (!Number.isInteger(input.interval_hours) || input.interval_hours < 24 || input.interval_hours > 720) throw new Error('interval_hours must be a whole number from 24 to 720.');
    next.interval_hours = input.interval_hours;
  }
  if ('max_new_per_run' in input) {
    if (!Number.isInteger(input.max_new_per_run) || input.max_new_per_run < 1 || input.max_new_per_run > 10) throw new Error('max_new_per_run must be a whole number from 1 to 10.');
    next.max_new_per_run = input.max_new_per_run;
  }
  if ('sources' in input) {
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.some(s => !Object.hasOwn(DISCOVERY_SOURCES, s))) throw new Error('sources may contain only built-in discovery sources.');
    next.sources = [...new Set(input.sources)];
  }
  for (const key of Object.keys(input)) if (!['enabled', 'topics', 'signals', 'interval_hours', 'max_new_per_run', 'sources'].includes(key)) throw new Error(`Unknown discovery setting: ${key}.`);
  if (next.enabled && (!next.topics.length || !next.signals.length)) throw new Error('Add at least one topic and one problem statement before turning discovery on.');
  next.paused = previous.paused;
  return next;
}

// ---- network ----

function privateAddress(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) return ip === '::' || ip === '::1' || /^(?:fc|fd|fe[89ab]|ff)/.test(ip) || ip.startsWith('64:ff9b:') || ip.startsWith('2001:db8');
  return true; // anything that is not a literal address is not trusted as public
}

// Fetch one allowlisted feed URL with no redirects, no credentials, a timeout and a byte cap.
// DNS answers are checked before connecting; a name that resolves to any private, loopback,
// link-local or multicast address is refused.
export async function fetchFeed(rawUrl, { fetchImpl = fetch, lookup = dnsLookup, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let url; try { url = new URL(rawUrl); } catch { throw new Error('Discovery refused an invalid feed URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname)) throw new Error('Discovery refused a feed outside the built-in HTTPS allowlist.');
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  const addresses = (Array.isArray(answers) ? answers : [answers]).map(a => typeof a === 'string' ? a : a?.address).filter(Boolean);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error('Discovery refused a feed host that resolves to a private or reserved address.');
  // One deadline covers connecting and reading the whole body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Feed request timed out.', 'TimeoutError')), timeoutMs);
  try { return await readFeed(await fetchImpl(url.href, {
    method: 'GET', redirect: 'manual', credentials: 'omit',
    headers: { Accept: 'application/atom+xml, application/xml;q=0.9', 'User-Agent': 'BrainLink-RSI-Discovery' },
    signal: controller.signal,
  }), maxBytes); } finally { clearTimeout(timer); }
}

async function readFeed(response, maxBytes) {
  if (response.status >= 300 && response.status < 400) throw new Error('Discovery refused a redirect from the feed.');
  if (response.status !== 200) throw new Error(`Feed answered HTTP ${response.status}.`);
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!/^(?:application\/atom\+xml|application\/xml|text\/xml)\b/.test(type)) throw new Error('Feed returned an unexpected content type.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Feed response is larger than the discovery limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Feed response is larger than the discovery limit.');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('Feed response is larger than the discovery limit.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

export function feedUrl(sourceId, topic) {
  const source = DISCOVERY_SOURCES[sourceId];
  if (!source) throw new Error('Unknown discovery source.');
  const params = new URLSearchParams({ search_query: `all:"${topic}"`, sortBy: 'submittedDate', sortOrder: 'descending', max_results: String(MAX_ENTRIES_PER_FEED) });
  return `https://${source.host}${source.path}?${params}`;
}

// ---- parsing ----

function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (whole, dec, hex, named) => {
    if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
// Tags are removed both before and after decoding so escaped markup cannot reappear as HTML.
const plain = (xml, max) => clean(stripInvisible(decodeEntities(xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ')), max);
const tag = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] || '';

export function parseAtom(xml, sourceId = 'arxiv') {
  if (typeof xml !== 'string') throw new Error('Feed was not text.');
  // No DTDs: entity definitions are how XML bombs and external-entity reads begin.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feed contains a DTD; refusing to parse it.');
  if (!/<feed\b/i.test(xml)) throw new Error('Feed is not an Atom document.');
  const source = DISCOVERY_SOURCES[sourceId];
  const entries = [];
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    if (entries.length >= MAX_ENTRIES_PER_FEED) break;
    const body = match[1];
    let url = '';
    try {
      const link = new URL(plain(tag(body, 'id'), 400));
      const id = link.pathname.match(/^\/abs\/([\w./-]{4,40}?)(?:v\d+)?$/)?.[1];
      if (source.entryHosts.includes(link.hostname.toLowerCase()) && id && !link.username && !link.password) url = `https://arxiv.org/abs/${id}`;
    } catch { /* invalid id below */ }
    const published = plain(tag(body, 'published'), 40).slice(0, 10);
    entries.push({ url, title: plain(tag(body, 'title'), 240), summary: plain(tag(body, 'summary'), 2000), published_at: /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : 'unknown' });
  }
  return entries;
}

// ---- relevance ----

const stem = (w) => w.length > 3 ? w.replace(/(?:ies)$/, 'y').replace(/(?<!s)s$/, '') : w;
const tokens = (text) => (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 1 && !STOPWORDS.has(w));
const words = (text) => tokens(text).map(stem);
const containsPhrase = (haystack, phrase) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?:$|[^\\p{L}\\p{N}])`, 'iu').test(haystack);

export function assessRelevance(entry, signals) {
  const text = `${entry.title} ${entry.summary}`.toLowerCase();
  const memoryTypes = Object.entries(WORKFLOW_TERMS).filter(([, terms]) => terms.some(t => containsPhrase(text, t))).map(([type]) => type);
  const workflowTerms = [...Object.values(WORKFLOW_TERMS).flat(), ...GENERAL_TERMS].filter(t => containsPhrase(text, t)).slice(0, 8);
  if (!workflowTerms.length) return null;
  const entryWords = new Set(words(text));
  let best = null;
  for (const signal of signals) {
    // Match on stems, but show the reviewer the words as they appear in their own statement.
    const original = new Map();
    for (const w of tokens(signal)) if (!original.has(stem(w))) original.set(stem(w), w);
    const signalWords = [...original.keys()];
    const matched = signalWords.filter(w => entryWords.has(w)).map(w => original.get(w));
    if (matched.length < 2) continue;
    const score = Math.round((matched.length / signalWords.length) * 100);
    if (score < 25) continue;
    if (!best || score > best.score) best = { signal, matched_terms: matched.slice(0, 8), score };
  }
  if (!best) return null;
  return { ...best, workflow_terms: workflowTerms, memory_types: memoryTypes };
}

export function hostileReason(entry) {
  const text = `${entry.title} ${entry.summary}`;
  if (findSecrets(text).length) return 'secret';
  if (INSTRUCTION_PATTERNS.some(re => re.test(text))) return 'instruction_like';
  return null;
}

function firstSentence(text, max = 320) {
  const sentence = text.match(/^.{20,}?[.!?](?=\s|$)/)?.[0] || text;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function candidateFor(entry, relevance, { runId, sourceId, topic, accessedAt }) {
  return {
    fields: {
      title: entry.title.slice(0, 160),
      user_problem: relevance.signal,
      hypothesis: '',
      memory_types: relevance.memory_types,
      sources: [{
        url: entry.url, title: entry.title, published_at: entry.published_at, accessed_at: accessedAt,
        claim: `Abstract states (not verified): ${firstSentence(entry.summary)}`.slice(0, 500),
        confidence: 'low',
        limitations: 'Found automatically from public feed metadata. The abstract was not reviewed by a person, preprints may not be peer reviewed, and nothing here shows the idea improves BrainLink.',
      }],
      privacy_scope: 'Public research metadata only. Only the configured topic terms were sent to the source.',
    },
    discovery: { run_id: runId, source: sourceId, topic, signal: relevance.signal, matched_terms: relevance.matched_terms, workflow_terms: relevance.workflow_terms, score: relevance.score },
  };
}

// ---- service ----

const safeError = (error) => clean(String(error?.name === 'TimeoutError' ? 'Feed request timed out.' : error?.message || error).replace(/https?:\/\/\S+/g, '[url]'), 200);

export function createRsiDiscovery({ home, ledger, fetchImpl, lookup, now = () => new Date() }) {
  const file = path.join(home, 'rsi', 'discovery.json');
  let running = null;
  let writes = Promise.resolve();

  async function load() {
    let raw; try { raw = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') raw = {}; else throw new Error('Discovery settings are unreadable; fix or remove the local discovery.json file.'); }
    const settings = { ...DEFAULT_DISCOVERY, ...(raw.settings || {}) };
    return { settings, runs: Array.isArray(raw.runs) ? raw.runs : [], events: Array.isArray(raw.events) ? raw.events : [] };
  }
  function save(mutator) {
    const next = writes.then(async () => {
      const current = await load();
      const updated = await mutator(current);
      updated.runs = updated.runs.slice(0, MAX_RUNS_KEPT);
      updated.events = updated.events.slice(0, MAX_EVENTS_KEPT);
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temp, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temp, file);
      return updated;
    });
    writes = next.catch(() => {});
    return next;
  }
  const event = (state, kind) => ({ ...state, events: [{ kind, at: now().toISOString() }, ...state.events] });
  const view = (state) => ({ ...state, running: Boolean(running), sources: Object.values(DISCOVERY_SOURCES).map(({ id, label, host }) => ({ id, label, host })) });

  async function run({ trigger = 'manual' } = {}) {
    if (running) throw new Error('Discovery is already running.');
    const { settings } = await load();
    if (!settings.enabled) throw new Error('Turn discovery on before running it.');
    if (settings.paused) throw new Error('Discovery is paused. Resume it to run.');
    running = (async () => {
      const runId = `RUN-${now().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
      const receipt = { run_id: runId, trigger, started_at: now().toISOString(), status: 'ok', sources: settings.sources, topics: settings.topics.length, fetched: 0, entries: 0, dropped: { invalid: 0, secret: 0, instruction_like: 0, irrelevant: 0, over_limit: 0 }, duplicates: 0, created: [], errors: [] };
      const accessedAt = now().toISOString().slice(0, 10);
      const candidates = [], seen = new Set();
      for (const sourceId of settings.sources) {
        for (const topic of settings.topics) {
          try {
            const xml = await fetchFeed(feedUrl(sourceId, topic), { fetchImpl, lookup });
            receipt.fetched++;
            for (const entry of parseAtom(xml, sourceId)) {
              receipt.entries++;
              if (!entry.url || !entry.title || !entry.summary) { receipt.dropped.invalid++; continue; }
              const hostile = hostileReason(entry);
              if (hostile) { receipt.dropped[hostile]++; continue; }
              if (seen.has(entry.url)) continue;
              const relevance = assessRelevance(entry, settings.signals);
              if (!relevance) { receipt.dropped.irrelevant++; continue; }
              seen.add(entry.url);
              candidates.push({ score: relevance.score, candidate: candidateFor(entry, relevance, { runId, sourceId, topic, accessedAt }) });
            }
          } catch (error) { receipt.errors.push(`${DISCOVERY_SOURCES[sourceId].label} / ${topic}: ${safeError(error)}`); }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const batch = candidates.slice(0, 20).map(c => c.candidate);
      try {
        // Pausing or turning discovery off while feeds are being read discards the run: nothing is
        // written to the ledger.
        const result = await ledger.appendDiscoveries(batch, { shouldContinue: async () => { const latest = (await load()).settings; return latest.enabled && !latest.paused; }, limit: settings.max_new_per_run });
        receipt.created = result.created;
        receipt.duplicates = result.duplicates.length;
        receipt.dropped.over_limit = result.over_limit + Math.max(0, candidates.length - batch.length);
        receipt.dropped.invalid += result.invalid;
        if (result.stopped) receipt.status = 'paused';
      } catch (error) { receipt.errors.push(`Ledger: ${safeError(error)}`); }
      if (receipt.status !== 'paused' && receipt.errors.length) receipt.status = receipt.fetched ? 'partial' : 'failed';
      receipt.finished_at = now().toISOString();
      await save((state) => ({ ...state, runs: [receipt, ...state.runs] }));
      return receipt;
    })();
    try { return await running; } finally { running = null; }
  }

  return {
    file,
    status: async () => view(await load()),
    configure: async (input) => view(await save((state) => {
      const settings = validateDiscoverySettings(input, state.settings);
      const kind = settings.enabled === state.settings.enabled ? 'settings_changed' : settings.enabled ? 'enabled' : 'disabled';
      return event({ ...state, settings }, kind);
    })),
    pause: async () => view(await save((state) => state.settings.paused ? state : event({ ...state, settings: { ...state.settings, paused: true } }, 'paused'))),
    resume: async () => view(await save((state) => state.settings.paused ? event({ ...state, settings: { ...state.settings, paused: false } }, 'resumed') : state)),
    run,
    // True when the scheduler should start a run now; a run of either trigger resets the clock.
    due: async () => {
      const { settings, runs } = await load();
      if (!settings.enabled || settings.paused || running) return false;
      const last = Date.parse(runs[0]?.started_at || '');
      return !Number.isFinite(last) || now().getTime() - last >= settings.interval_hours * 3600e3;
    },
  };
}
