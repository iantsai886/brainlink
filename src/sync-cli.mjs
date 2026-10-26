// `brainlink sync` connects the sync engine to the configured on-disk Brain vault.
// Sync is deliberately limited to a public vault named `brain`: if it is missing or private,
// stop before reading notes or writing session indexes. Other vaults remain local-only.
import path from 'node:path';
import { createFolderStore } from './store/folder-store.mjs';
import { syncOnce, loadState, saveState } from './sync/engine.mjs';
import { syncSettings, SYNC_VAULT } from './sync/settings.mjs';
import { appHome } from './config.mjs';
import { openSessionStore, importAll } from './sessions/index.mjs';
import { logActivity } from './runtime.mjs';

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function runSync(cfg, env = process.env) {
  const settings = syncSettings(cfg);
  const eligibleVaults = (cfg.vaults || []).filter((v) => !v.private);
  const brain = eligibleVaults.find((v) => v.name === SYNC_VAULT)
    || (eligibleVaults.length === 1 ? eligibleVaults[0] : null);
  if (settings.provider !== 'local') {
    if (!brain) {
      const status = eligibleVaults.length ? 'vault-ambiguous' : 'vault-required';
      await logActivity(env, { tool: 'sync', ok: false, status });
      return { status, pushed: [], pulled: [], conflicts: [], snapshot: null, sessions: 0, provider: settings.provider };
    }
    if (containsPath(brain.path, settings.folder)) {
      const status = 'target-inside-vault';
      await logActivity(env, { tool: 'sync', ok: false, status });
      return { status, pushed: [], pulled: [], conflicts: [], snapshot: null, sessions: 0, provider: settings.provider };
    }
  }
  const stateFile = path.join(appHome(env), 'sync-state.json');
  const state = await loadState(stateFile);
  const sessionStore = await openSessionStore(env);
  await importAll({ store: sessionStore, env }); // keep the local session index fresh before reading it for sync
  const sessions = (await sessionStore.listSessions({ limit: 200 })).map((s) => ({ id: s.id, title: s.title, summary: s.summary, private: s.private, scope: s.private ? s.vault : SYNC_VAULT }));
  const store = settings.provider === 'local' ? null : createFolderStore({
    vaults: [{ name: SYNC_VAULT, private: false }],
    vaultPaths: { [SYNC_VAULT]: brain.path },
  });
  const r = await syncOnce({ store, cfg, state, sessions });
  await saveState(stateFile, r.state);
  await logActivity(env, { tool: 'sync', ok: r.status !== 'queued', status: r.status }); // content-free, same convention as every other activity.log entry
  return { ...r, provider: syncSettings(cfg).provider };
}
