// Local session store: BrainLink's own persistent record of AI sessions, under <appHome>/sessions.
// Wraps brainlink-store's createMemoryStore (session methods only; one private "Sessions" vault) so
// idempotent import, the secret-filter backstop and privacy rules come from the one canonical contract
// instead of being reimplemented here. Persistence is plain JSON Lines, not node:sqlite: the box runs
// Node 20 and the target is Node 22, and JSONL works unchanged on both, so there is no feature-check
// branch to carry (and none that could be tested on this box).
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryStore } from 'brainlink-store';

export const SESSIONS_VAULT = 'Sessions';

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function loadLines(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// opts: { dir, clock? }. dir = <appHome>/sessions (caller resolves appHome; keeps this module path-free for tests).
export async function createSessionStore({ dir, clock = () => new Date().toISOString() }) {
  const file = path.join(dir, 'sessions.jsonl');
  const inner = createMemoryStore({ vaults: [{ name: SESSIONS_VAULT, private: true }], clock });
  for (const { session, messages } of await loadLines(file)) {
    await inner.putSession({ client: session.client, source_id: session.source_id, vault: SESSIONS_VAULT, project: session.project,
      title: session.title, summary: session.summary, started_at: session.started_at, note_refs: session.note_refs, private: session.private, messages });
  }

  // Two importers can both call putSession/appendSession concurrently (src/sessions/index.mjs
  // runs them via Promise.all). Each writes the *full* current state, so overlapping writes to the
  // same file are not merge conflicts, but their completion order is not guaranteed to match call
  // order (real disk I/O). Chaining every persist() through one queue forces writes to land in call
  // order, so the last one to finish always reflects the fullest state instead of a stale snapshot
  // winning the race.
  let queue = Promise.resolve();
  function persist() {
    const run = queue.then(async () => {
      const lines = [];
      for (const s of await inner.listSessions({ limit: 1e6 })) {
        const { messages } = await inner.readSession(s.id, { limit: 1e6 });
        lines.push(JSON.stringify({ session: s, messages }));
      }
      await atomicWrite(file, lines.length ? lines.join('\n') + '\n' : '');
    });
    queue = run.catch(() => {}); // keep the queue alive even if this write failed
    return run;
  }

  return {
    // input: putSession's shape minus `vault` (always the local Sessions vault) plus `messages`.
    async putSession(input) {
      const r = await inner.putSession({ ...input, vault: SESSIONS_VAULT });
      await persist();
      return r;
    },
    async appendSession(ref, messages) {
      const r = await inner.appendSession(typeof ref === 'string' ? ref : { ...ref, vault: SESSIONS_VAULT }, messages);
      await persist();
      return r;
    },
    async setSessionPrivate(id, isPrivate) {
      const r = await inner.setSessionPrivate(id, isPrivate);
      await persist();
      return r;
    },
    listSessions: (o) => inner.listSessions(o),
    readSession: (id, o) => inner.readSession(id, o),
  };
}
