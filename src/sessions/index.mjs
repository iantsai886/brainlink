// Entry point for the session store + importers: what bin/ and the MCP server (session_list,
// session_read, session_log) actually call.
import path from 'node:path';
import { appHome, configPath, loadConfig } from '../config.mjs';
import { createSessionStore } from './store.mjs';
import { importClaudeCode, defaultRoot as claudeRoot } from './claude-code.mjs';
import { importCodex, defaultRoot as codexRoot, defaultHistoryFile } from './codex.mjs';
import { importDeepSeekHarness, defaultRoot as deepSeekHarnessRoot } from './deepseek-harness.mjs';
import { importHermes, defaultRoot as hermesRoot } from './hermes.mjs';
import { homedir } from 'node:os';

export { createSessionStore, SESSIONS_VAULT } from './store.mjs';
export { importClaudeCode } from './claude-code.mjs';
export { importCodex } from './codex.mjs';
export { importDeepSeekHarness } from './deepseek-harness.mjs';
export { importHermes } from './hermes.mjs';

export const sessionsDir = (env = process.env) => path.join(appHome(env), 'sessions');

export const openSessionStore = (env = process.env) => createSessionStore({ dir: sessionsDir(env) });

// Importers use file cursors, so refreshing is cheap when nothing changed. Serialize refreshes
// and throttle background/MCP reads, while allowing explicit UI/session-end refreshes to bypass
// the cooldown so a just-finished client session can be reviewed without restarting BrainLink.
export function createSessionRefresher({ getStore, env = process.env, clock = () => Date.now(), cooldownMs = 15_000 }) {
  let lastImportedAt = null;
  let inFlight = null;
  return async ({ force = false } = {}) => {
    if (inFlight) return inFlight;
    if (!force && lastImportedAt !== null && clock() - lastImportedAt < cooldownMs) return getStore();
    const pending = (async () => {
      const store = await getStore();
      await importAll({ store, env });
      lastImportedAt = clock();
      return store;
    })();
    inFlight = pending;
    try { return await pending; }
    finally { if (inFlight === pending) inFlight = null; }
  };
}

// Runs every local, read-only importer once. Each is independent and incremental; one failing
// does not stop the other.
export async function importAll({ store, env = process.env } = {}) {
  const dir = sessionsDir(env);
  const s = store || await openSessionStore(env);
  // Use the same caller-supplied home in tests and subprocesses. os.homedir() on Windows
  // ignores HOME, which previously caused a fictional test to import the user's real history.
  const sourceHome = env.HOME || env.USERPROFILE || homedir();
  const config = await loadConfig(configPath(env)).catch(() => null);
  const selectedHermesHome = config?.sessions?.hermesHome;
  const [claudeCode, codex, deepSeekHarness, hermes] = await Promise.all([
    importClaudeCode({ store: s, root: claudeRoot(sourceHome), cursorsFile: path.join(dir, 'cursors-claude-code.json') }),
    importCodex({ store: s, root: codexRoot(sourceHome), historyFile: defaultHistoryFile(sourceHome),
      cursorsFile: path.join(dir, 'cursors-codex.json') }),
    importDeepSeekHarness({ store: s, root: deepSeekHarnessRoot(sourceHome, env), cursorsFile: path.join(dir, 'cursors-deepseek-harness.json') }),
    importHermes({ store: s, root: selectedHermesHome || hermesRoot(sourceHome, env), cursorsFile: path.join(dir, 'cursors-hermes.json') }),
  ]);
  return { 'claude-code': claudeCode, codex, 'deepseek-harness': deepSeekHarness, hermes };
}
