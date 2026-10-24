// Local, append-only RSI proposal ledger. This stores proposal metadata only; it never executes
// experiments, fetches sources, changes vault content, or promotes a candidate into live behavior.
import { appendFile, mkdir, readFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { findSecrets } from './core.mjs';

const STATUSES = new Set(['discovered', 'triaged', 'researching', 'proposed', 'testing', 'review', 'accepted', 'rejected', 'deferred', 'rolled_back']);
const TRANSITIONS = {
  discovered: new Set(['triaged', 'rejected', 'deferred']),
  triaged: new Set(['researching', 'proposed', 'rejected', 'deferred']),
  researching: new Set(['proposed', 'rejected', 'deferred']),
  proposed: new Set(['testing', 'rejected', 'deferred']),
  testing: new Set(['review', 'rejected', 'deferred']),
  review: new Set(['accepted', 'rejected', 'testing', 'deferred']),
  accepted: new Set(['rolled_back']), rejected: new Set(), deferred: new Set(['triaged', 'rejected']), rolled_back: new Set(['testing', 'rejected']),
};
const FIELDS = ['title', 'user_problem', 'hypothesis', 'memory_types', 'sources', 'baseline_version', 'candidate_version', 'test_set_version', 'metrics', 'guardrails', 'privacy_scope', 'cost_cap', 'results', 'reviewer', 'decision_and_reason', 'rollback'];
const MAX_TEXT = 1200;
const clean = (v, max = MAX_TEXT) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const canonical = (v) => JSON.stringify(v);
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');

function similarity(left, right) {
  const words = (value) => new Set(clean(value, 4000).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []);
  const a = words(left), b = words(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap++;
  return overlap / (a.size + b.size - overlap);
}

function duplicateCandidates(rows, fields) {
  return rows.map((row) => {
    const title = similarity(fields.title, row.fields.title);
    const problem = similarity(fields.user_problem, row.fields.user_problem);
    return { id: row.id, title: row.fields.title, status: row.status, score: Math.round((title * 0.45 + problem * 0.55) * 100) };
  }).filter((candidate) => candidate.score >= 55)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 3);
}

function validatePayload(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Idea must be an object.');
  const out = {};
  for (const key of FIELDS) {
    if (partial && !(key in input)) continue;
    const value = input[key] === undefined && !partial
      ? (['memory_types', 'metrics', 'guardrails', 'sources'].includes(key) ? [] : '')
      : input[key];
    if (['memory_types', 'metrics', 'guardrails'].includes(key)) {
      if (value === undefined && partial) continue;
      if (!Array.isArray(value) || value.length > 12 || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 160)) throw new Error(`${key} must be a list of at most 12 short strings.`);
      out[key] = value.map(x => x.trim());
      if (key === 'memory_types' && out[key].some(x => !['working', 'semantic', 'procedural', 'episodic'].includes(x))) throw new Error('memory_types may contain only working, semantic, procedural, and episodic.');
    } else if (key === 'sources') {
      if (value === undefined && partial) continue;
      if (!Array.isArray(value) || value.length > 12) throw new Error('sources must be a list of at most 12 HTTPS URLs.');
      out.sources = value.map((source) => {
        const raw = typeof source === 'string' ? source : source?.url;
        let url; try { url = new URL(raw); } catch { throw new Error('Each source must be a valid public HTTPS URL.'); }
        const host = url.hostname.toLowerCase();
        const privateIpv4 = /^10\./.test(host) || /^127\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        const privateIpv6 = host === '[::1]' || host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80:');
        if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || privateIpv4 || privateIpv6) throw new Error('Each source must be a public HTTPS URL without credentials.');
        const published = clean(source?.published_at, 40);
        if (published && published !== 'unknown' && !/^\d{4}-\d{2}-\d{2}$/.test(published)) throw new Error('Source publication dates must use YYYY-MM-DD or unknown.');
        const confidence = clean(source?.confidence, 80).toLowerCase();
        if (confidence && !['low', 'medium', 'high'].includes(confidence)) throw new Error('Source confidence must be low, medium, or high.');
        return {
          url: url.href, title: clean(source?.title, 240), published_at: published,
          accessed_at: clean(source?.accessed_at, 40), claim: clean(source?.claim, 500),
          confidence, limitations: clean(source?.limitations, 500),
        };
      });
    } else {
      if (value === undefined && partial) continue;
      const maximum = key === 'title' ? 160 : MAX_TEXT;
      if (typeof value !== 'string' || value.length > maximum) throw new Error(`${key} must be text up to ${maximum} characters.`);
      out[key] = value.trim();
    }
  }
  if (!partial && (!out.title || !out.user_problem)) throw new Error('title and user_problem are required.');
  const text = JSON.stringify(out);
  if (findSecrets(text).length) throw new Error('Potential secret detected; remove it before saving an RSI idea.');
  if (/<(?:script|iframe)\b/i.test(text)) throw new Error('HTML markup is not allowed in RSI idea fields.');
  return out;
}

async function readEvents(file) {
  let raw; try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const events = [];
  let prev = '0'.repeat(64);
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch { throw new Error(`RSI ledger is damaged at line ${i + 1}; refusing to continue.`); }
    const { hash, ...payload } = event;
    if (payload.prev_hash !== prev || digest(payload) !== hash) throw new Error(`RSI ledger integrity check failed at line ${i + 1}; refusing to continue.`);
    prev = hash; events.push(event);
  }
  return events;
}

function project(events) {
  const records = new Map();
  for (const event of events) {
    const row = records.get(event.idea_id);
    if (event.kind === 'created') records.set(event.idea_id, { id: event.idea_id, status: 'discovered', revision: 1, created_at: event.at, updated_at: event.at, fields: event.fields, history: [{ status: 'discovered', at: event.at, note: 'Created' }] });
    else if (row) {
      if (event.kind === 'updated') row.fields = { ...row.fields, ...event.fields };
      if (event.status) { row.status = event.status; row.history.push({ status: event.status, at: event.at, note: event.note || '' }); }
      row.revision++; row.updated_at = event.at;
    }
  }
  return [...records.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function createRsiLedger({ home, now = () => new Date() }) {
  const file = path.join(home, 'rsi', 'ledger.jsonl');
  const lockFile = file + '.lock';
  let queue = Promise.resolve();
  async function withFileLock(fn) {
    await mkdir(path.dirname(file), { recursive: true });
    const owner = randomUUID(), until = Date.now() + 8000;
    let handle;
    while (!handle) {
      try {
        handle = await open(lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, owner, created_at: new Date().toISOString() }));
      } catch (error) {
        if (error.code !== 'EEXIST') { await handle?.close().catch(() => {}); throw error; }
        // Recover only a lock whose recorded process is definitely gone. Unknown/malformed locks
        // fail closed instead of risking concurrent writes to the hash chain.
        const prior = await readFile(lockFile, 'utf8').then(JSON.parse).catch(() => null);
        let stale = false;
        if (Number.isInteger(prior?.pid) && prior.pid > 0) {
          try { process.kill(prior.pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') stale = true; }
        }
        if (stale) { await unlink(lockFile).catch(() => {}); continue; }
        if (Date.now() >= until) throw new Error('RSI ledger is busy or has an unreadable lock; close other BrainLink instances and inspect the local lock file before retrying.');
        await delay(25);
      }
    }
    try { return await fn(); }
    finally {
      await handle.close().catch(() => {});
      const record = await readFile(lockFile, 'utf8').then(JSON.parse).catch(() => null);
      if (record?.owner === owner) await unlink(lockFile).catch(() => {});
    }
  }
  const locked = (fn) => { const next = queue.then(() => withFileLock(fn)); queue = next.catch(() => {}); return next; };
  const append = async (payload) => {
    await mkdir(path.dirname(file), { recursive: true });
    const events = await readEvents(file);
    const previous = events.at(-1)?.hash || '0'.repeat(64);
    const body = { ...payload, prev_hash: previous };
    await appendFile(file, `${JSON.stringify({ ...body, hash: digest(body) })}\n`, { encoding: 'utf8', mode: 0o600 });
  };
  return {
    list: () => locked(async () => project(await readEvents(file))),
    similar: (input) => locked(async () => duplicateCandidates(project(await readEvents(file)), validatePayload(input))),
    create: (input) => locked(async () => {
      const fields = validatePayload(input);
      const id = `BL-RSI-${now().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
      const at = now().toISOString(); await append({ kind: 'created', idea_id: id, at, fields });
      return project(await readEvents(file)).find(x => x.id === id);
    }),
    update: ({ id, expected_revision, fields: changes, status, note }) => locked(async () => {
      if (typeof id !== 'string' || !/^BL-RSI-\d{8}-[a-f0-9-]{8,36}$/.test(id)) throw new Error('Invalid RSI idea id.');
      const rows = project(await readEvents(file)); const row = rows.find(x => x.id === id);
      if (!row) throw new Error('RSI idea not found.');
      if (!Number.isInteger(expected_revision) || expected_revision !== row.revision) throw new Error('RSI idea changed; reload it before updating.');
      const fields = changes ? validatePayload(changes, { partial: true }) : {};
      if (status !== undefined && (!STATUSES.has(status) || !TRANSITIONS[row.status]?.has(status))) throw new Error(`Status cannot move from ${row.status} to ${status}.`);
      const merged = { ...row.fields, ...fields };
      if (status === 'accepted' && ['baseline_version', 'candidate_version', 'test_set_version', 'results', 'reviewer', 'decision_and_reason', 'rollback'].some(key => !clean(merged[key]))) throw new Error('Acceptance requires baseline and candidate versions, test set, measured results, reviewer, decision rationale, and rollback instructions.');
      if (status === 'accepted' && (!merged.metrics?.length || !merged.guardrails?.length)) throw new Error('Acceptance requires measured metrics and guardrail results.');
      const safeNote = clean(note, 500);
      if (status === 'rolled_back' && !safeNote) throw new Error('Record why the accepted change was rolled back.');
      if (findSecrets(safeNote).length) throw new Error('Potential secret detected in status note.');
      if (!Object.keys(fields).length && !status) throw new Error('Provide fields or a valid status transition.');
      const at = now().toISOString();
      await append({ kind: status ? 'status' : 'updated', idea_id: id, at, ...(Object.keys(fields).length ? { fields } : {}), ...(status ? { status, note: safeNote } : {}) });
      return project(await readEvents(file)).find(x => x.id === id);
    }),
    file,
  };
}
