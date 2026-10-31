// Local session store: BrainLink's own persistent record of AI sessions, under <appHome>/sessions.
// Wraps brainlink-store's createMemoryStore (session methods only; one private "Sessions" vault) so
// idempotent import, the secret-filter backstop and privacy rules come from the one canonical contract
// instead of being reimplemented here. Persistence is plain JSON Lines, not node:sqlite: the box runs
// Node 20 and the target is Node 22, and JSONL works unchanged on both, so there is no feature-check
// branch to carry (and none that could be tested on this box).
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMemoryStore } from 'brainlink-store';

export const SESSIONS_VAULT = 'Sessions';

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function loadLines(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const localQueues = new Map();
async function withFileLock(file, fn) {
  const lockFile = `${file}.lock`, owner = randomUUID(), deadline = Date.now() + 8000;
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  while (!handle) {
    try {
      handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, owner, created_at: new Date().toISOString() }));
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (handle) { await handle.close().catch(() => {}); await unlink(lockFile).catch(() => {}); }
        throw error;
      }
      // Reclaim only when the recorded owner is definitely gone. A malformed lock is left for
      // manual inspection instead of risking concurrent session-file replacement.
      const prior = await readFile(lockFile, 'utf8').then(JSON.parse).catch(() => null);
      let stale = false;
      if (Number.isInteger(prior?.pid) && prior.pid > 0) {
        try { process.kill(prior.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') stale = true; }
      }
      if (stale) { await unlink(lockFile).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw new Error('The BrainLink session store is busy or has an unreadable lock. Close other BrainLink instances and inspect the local session lock before retrying.');
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

function serialized(file, fn) {
  const key = path.resolve(`${file}.lock`), previous = localQueues.get(key) || Promise.resolve();
  const next = previous.then(() => withFileLock(file, fn));
  const tracked = next.catch(() => {});
  localQueues.set(key, tracked);
  return next.finally(() => { if (localQueues.get(key) === tracked) localQueues.delete(key); });
}

async function loadStore(file, clock) {
  const inner = createMemoryStore({ vaults: [{ name: SESSIONS_VAULT, private: true }], clock });
  for (const { session, messages } of await loadLines(file)) {
    await inner.putSession({ client: session.client, source_id: session.source_id, vault: SESSIONS_VAULT, project: session.project,
      profile_id: session.profile_id || null, title: session.title, summary: session.summary, started_at: session.started_at, note_refs: session.note_refs, private: session.private, messages });
  }
  return inner;
}

async function persist(inner, file) {
  const lines = [];
  for (const s of await inner.listSessions({ limit: 1e6 })) {
    const { messages } = await inner.readSession(s.id, { limit: 1e6 });
    lines.push(JSON.stringify({ session: s, messages }));
  }
  await atomicWrite(file, lines.length ? lines.join('\n') + '\n' : '');
}

// opts: { dir, clock? }. dir = <appHome>/sessions (caller resolves appHome; keeps this module path-free for tests).
export async function createSessionStore({ dir, clock = () => new Date().toISOString() }) {
  const file = path.join(dir, 'sessions.jsonl');
  await serialized(file, async () => {}); // initialize the directory and wait out an active writer
  let inner;

  async function fresh(action, write = false) {
    return serialized(file, async () => {
      inner = await loadStore(file, clock);
      const result = await action(inner);
      if (write) await persist(inner, file);
      return result;
    });
  }

  return {
    // input: putSession's shape minus `vault` (always the local Sessions vault) plus `messages`.
    putSession: (input) => fresh((store) => store.putSession({ ...input, vault: SESSIONS_VAULT }), true),
    appendSession: (ref, messages, opts = {}) => fresh((store) => {
      const scope = typeof ref === 'string' ? opts : { ...opts, profile_id: ref.profile_id ?? opts.profile_id };
      return store.appendSession(typeof ref === 'string' ? ref : { ...ref, vault: SESSIONS_VAULT }, messages, scope);
    }, true),
    setSessionPrivate: (id, isPrivate) => fresh((store) => store.setSessionPrivate(id, isPrivate), true),
    assignSessionProfile: (id, profileId) => fresh((store) => store.assignSessionProfile(id, profileId), true),
    listSessions: (o) => fresh((store) => store.listSessions(o)),
    readSession: (id, o) => fresh((store) => store.readSession(id, o)),
    // Multi-step operations such as session_close hold the file lock across the duplicate
    // check, session write and vault-note write. Scoped methods avoid re-entering the same lock.
    withExclusive: (action) => serialized(file, async () => {
      inner = await loadStore(file, clock);
      const scoped = {
        readSession: (...args) => inner.readSession(...args),
        putSession: async (input, opts = {}) => {
          const result = await inner.putSession({ ...input, vault: SESSIONS_VAULT }, opts);
          await persist(inner, file);
          return result;
        },
      };
      return action(scoped);
    }),
  };
}
