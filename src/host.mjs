// Builds the real host object ui/app/README.md asks for: createApi({store, services, access}).
// store: a real-vault-folder BrainStore. services.connectors: src/connectors.mjs, reshaped to the
// UI's detect() array. services.settings: src/sync/settings.mjs's pure functions, wrapped with
// config.json load/save (that wiring lives here, not in src/sync/, which Claude 101 owns).
import { homedir } from 'node:os';
import { CLIENTS, detect as detectClients, connect as connectClient, test as testClient, disconnect as disconnectClient } from './connectors.mjs';
import { launchSpec } from './runtime.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { syncSettings, suggestFolders, validateSync, chooseSync } from './sync/settings.mjs';
import { createFolderStore } from './store/folder-store.mjs';
import { openSessionStore, createSessionRefresher } from './sessions/index.mjs';
import { sessionList, sessionRead } from './sessions/mcp.mjs';

export { CLIENTS };

// Cross-session reads over the local session store (src/sessions/*): list, read-summary, privacy
// toggle. Import incrementally, with a fast refresh method for an explicit session review.
export function sessionsService(env, home, configFile) {
  // Setup's explicit home is also the boundary for session import. Without this fallback,
  // a test or secondary BrainLink profile that supplies an isolated home but no HOME variable
  // can silently scan the OS user's real Claude/Codex history.
  const sessionEnv = { ...env, HOME: env.HOME || home || env.USERPROFILE || homedir(), ...(configFile ? { BRAINLINK_CONFIG: configFile } : {}) };
  let ready = null;
  const store = () => ready ||= openSessionStore(sessionEnv);
  const refresh = createSessionRefresher({ getStore: store, env: sessionEnv });
  return {
    store,
    refresh: () => refresh({ force: true }),
    list: async (a = {}) => sessionList(await refresh(), a),
    read: async (a = {}) => sessionRead(await store(), a),
    async setPrivate(id, isPrivate) { const r = await (await store()).setSessionPrivate(id, Boolean(isPrivate)); return { id: r.id, private: r.private }; },
  };
}

function connectorService(clientOpts) {
  return {
    async detect() {
      const found = await detectClients(clientOpts());
      return Object.entries(found).map(([id, c]) => ({
        client: id, name: c.title, transport: c.unsupported ? 'tunnel' : 'stdio',
        installed: c.present, connected: c.connected, config_path: c.file || '', last_test: null,
      }));
    },
    connect: (id) => connectClient(id, clientOpts()),
    test: (id) => testClient(id, clientOpts()),
    disconnect: (id) => disconnectClient(id, clientOpts()),
  };
}

function settingsService({ env, configFile }) {
  return {
    async get() { return syncSettings(await loadConfig(configFile)); },
    async suggestFolders() { return suggestFolders(); },
    async validate(sync) { const errors = validateSync(sync); return errors.length ? { ok: false, message: errors.join('; ') } : { ok: true, message: 'Looks good.' }; },
    async save(sync) {
      try { const next = chooseSync(await loadConfig(configFile), sync); await saveConfig(next, configFile); return { ok: true, message: 'Sync settings saved.' }; }
      catch (e) { return { ok: false, message: e.message || String(e) }; }
    },
  };
}

function services({ env, os, home, configFile }) {
  const clientOpts = () => ({ home, os, env, launch: launchSpec(env) });
  return { connectors: connectorService(clientOpts), settings: settingsService({ env, configFile }), sessions: sessionsService(env, home, configFile) };
}

// The real host: store backed by every vault in config.json.
export async function createConfiguredHost({ env = process.env, os = process.platform, home = homedir(), configFile } = {}) {
  const cfg = await loadConfig(configFile);
  if (!cfg.vaults.length) throw new Error('No vaults configured yet. Run `brainlink setup` or `brainlink init --vault PATH` first.');
  const vaults = cfg.vaults.map((v) => ({ name: v.name, private: !!v.private }));
  const vaultPaths = Object.fromEntries(cfg.vaults.map((v) => [v.name, v.path]));
  const store = createFolderStore({ vaults, vaultPaths });
  return { store, services: services({ env, os, home, configFile }), access: {} };
}

// A throwaway host over a single folder — used by `brainlink demo` so trying BrainLink never
// touches config.json or a real vault.
export async function createFolderHost({ name = 'Demo', folder, env = process.env, os = process.platform, home = homedir(), configFile } = {}) {
  if (!folder) throw new Error('createFolderHost needs a folder');
  const store = createFolderStore({ vaults: [{ name, private: false }], vaultPaths: { [name]: folder } });
  return { store, services: services({ env, os, home, configFile }), access: {} };
}
