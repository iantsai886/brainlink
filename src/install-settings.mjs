// Deterministic additive config merger for BrainLink AI-native installation.
// Lives in src/ so packaged Windows, macOS, and Linux runtimes (which ship bin/ + src/) can load it.
// - Dry-run by default (apply: true required to write).
// - Creates a timestamped backup before modifying any existing config file.
// - Expands $HOME and %USERPROFILE% safely at write time.
// - Merges additively: never overwrites pre-existing MCP servers, hooks, custom keys,
//   or an existing non-empty BRAINLINK_AGENT_TOKEN.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function expandHomeVars(value, home = homedir()) {
  if (typeof value === 'string') {
    return value
      .replace(/\$HOME(?=$|[\\/])/g, home)
      .replace(/\$\{HOME\}/g, home)
      .replace(/%USERPROFILE%/gi, home);
  }
  if (Array.isArray(value)) return value.map((item) => expandHomeVars(item, home));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandHomeVars(v, home);
    return out;
  }
  return value;
}

// Additive deep merge: preserves every pre-existing user key, array entry, hook, and MCP server.
// Only inserts or updates the specific BrainLink server entry while preserving any existing token.
export function mergeSettingsAdditive(existing, incoming, { serverKey = 'brainlink' } = {}) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? structuredClone(existing)
    : {};

  if (incoming.mcpServers && typeof incoming.mcpServers === 'object') {
    base.mcpServers = base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
      ? { ...base.mcpServers }
      : {};
    for (const [key, entry] of Object.entries(incoming.mcpServers)) {
      if (key !== serverKey && key in base.mcpServers) {
        continue;
      }
      const prev = base.mcpServers[key];
      const mergedEnv = {
        ...(prev?.env && typeof prev.env === 'object' ? prev.env : {}),
        ...(entry?.env && typeof entry.env === 'object' ? entry.env : {}),
      };
      if (prev?.env?.BRAINLINK_AGENT_TOKEN && !entry?.env?.BRAINLINK_AGENT_TOKEN) {
        mergedEnv.BRAINLINK_AGENT_TOKEN = prev.env.BRAINLINK_AGENT_TOKEN;
      }
      base.mcpServers[key] = {
        ...(prev && typeof prev === 'object' ? prev : {}),
        ...entry,
        ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}),
      };
    }
  }

  if (incoming.hooks && typeof incoming.hooks === 'object') {
    base.hooks = base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks)
      ? { ...base.hooks }
      : {};
    for (const [eventName, list] of Object.entries(incoming.hooks)) {
      const prevList = Array.isArray(base.hooks[eventName]) ? [...base.hooks[eventName]] : [];
      const incomingList = Array.isArray(list) ? list : [];
      for (const hook of incomingList) {
        const sig = JSON.stringify(hook);
        if (!prevList.some((h) => JSON.stringify(h) === sig)) prevList.push(hook);
      }
      base.hooks[eventName] = prevList;
    }
  }

  for (const [k, v] of Object.entries(incoming)) {
    if (k === 'mcpServers' || k === 'hooks') continue;
    if (!(k in base)) base[k] = v;
  }

  return base;
}

export async function installSettings({
  targetPath,
  incoming,
  apply = false,
  home = homedir(),
  now = new Date(),
  serverKey = 'brainlink',
}) {
  if (!targetPath || !String(targetPath).trim()) {
    throw new Error('installSettings requires targetPath.');
  }
  const expandedTarget = expandHomeVars(String(targetPath), home);
  const resolvedTarget = path.resolve(expandedTarget);
  const expandedIncoming = expandHomeVars(incoming || {}, home);

  let existed = false;
  let existing = {};
  try {
    const raw = await readFile(resolvedTarget, 'utf8');
    existed = true;
    existing = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Refusing to touch unparseable config at ${resolvedTarget}: ${err.message}`);
    }
  }

  const merged = mergeSettingsAdditive(existing, expandedIncoming, { serverKey });
  const serialized = JSON.stringify(merged, null, 2) + '\n';

  let backupPath = null;
  if (apply) {
    await mkdir(path.dirname(resolvedTarget), { recursive: true });
    if (existed) {
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      backupPath = `${resolvedTarget}.brainlink-backup-${stamp}`;
      await copyFile(resolvedTarget, backupPath);
    }
    await writeFile(resolvedTarget, serialized, 'utf8');
  }

  return {
    mode: apply ? 'applied' : 'dry-run',
    target: resolvedTarget,
    existed,
    backup: backupPath,
    preserved_servers: Object.keys(merged.mcpServers || {}),
    merged,
  };
}
