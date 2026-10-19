// Entry point for the session store + importers: what bin/ and the MCP server (session_list,
// session_read, session_log) actually call.
import path from 'node:path';
import { appHome } from '../config.mjs';
import { createSessionStore } from './store.mjs';
import { importClaudeCode } from './claude-code.mjs';
import { importCodex } from './codex.mjs';

export { createSessionStore, SESSIONS_VAULT } from './store.mjs';
export { importClaudeCode } from './claude-code.mjs';
export { importCodex } from './codex.mjs';

export const sessionsDir = (env = process.env) => path.join(appHome(env), 'sessions');

export const openSessionStore = (env = process.env) => createSessionStore({ dir: sessionsDir(env) });

// Runs every local, read-only importer once. Each is independent and incremental; one failing
// does not stop the other.
export async function importAll({ store, env = process.env } = {}) {
  const dir = sessionsDir(env);
  const s = store || await openSessionStore(env);
  const [claudeCode, codex] = await Promise.all([
    importClaudeCode({ store: s, cursorsFile: path.join(dir, 'cursors-claude-code.json') }),
    importCodex({ store: s, cursorsFile: path.join(dir, 'cursors-codex.json') }),
  ]);
  return { 'claude-code': claudeCode, codex };
}
