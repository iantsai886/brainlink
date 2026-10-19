// `brainlink sync`: wires config.mjs + the local session store to src/sync/engine.mjs's syncOnce
// (Claude 101's module — used here read-only, never edited). Local is the default and needs no
// store at all (syncOnce returns before touching it). Non-local providers sync notes once the
// vault itself is BrainStore-backed; that integration is a separate, already-flagged next step
// (brainlink-store/docs/progress.md: "Next: SQLite store + Obsidian import/export"), so for now
// an empty, single-vault store is passed — real, but inert (nothing to push or pull) until that
// lands. The session index already flows through for real, though see docs/SESSION-INDEX.md §3
// for why it stays local-only today by construction (sessions live in a vault that isn't the one
// SYNC_VAULT sync reads from).
import path from 'node:path';
import { createMemoryStore } from 'brainlink-store';
import { syncOnce, loadState, saveState } from './sync/engine.mjs';
import { syncSettings, SYNC_VAULT } from './sync/settings.mjs';
import { appHome } from './config.mjs';
import { openSessionStore } from './sessions/index.mjs';
import { logActivity } from './runtime.mjs';

export async function runSync(cfg, env = process.env) {
  const stateFile = path.join(appHome(env), 'sync-state.json');
  const state = await loadState(stateFile);
  const sessionStore = await openSessionStore(env);
  const sessions = (await sessionStore.listSessions({ limit: 200 })).map((s) => ({ id: s.id, title: s.title, summary: s.summary, private: s.private, scope: s.vault }));
  const store = createMemoryStore({ vaults: [{ name: SYNC_VAULT, private: false }] });
  const r = await syncOnce({ store, cfg, state, sessions });
  await saveState(stateFile, r.state);
  await logActivity(env, { tool: 'sync', ok: r.status !== 'queued', status: r.status }); // content-free, same convention as every other activity.log entry
  return { ...r, provider: syncSettings(cfg).provider };
}
