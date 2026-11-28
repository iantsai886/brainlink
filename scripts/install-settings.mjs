#!/usr/bin/env node
// Deterministic additive config merger for BrainLink AI-native installation.
// - Dry-run by default (--apply required to write).
// - Creates a timestamped backup before modifying any existing config file.
// - Expands $HOME and %USERPROFILE% safely at write time.
// - Merges additively: never overwrites pre-existing MCP servers, hooks, custom keys,
//   or an existing non-empty BRAINLINK_AGENT_TOKEN.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
        // Never overwrite pre-existing non-BrainLink MCP servers.
        continue;
      }
      const prev = base.mcpServers[key];
      const mergedEnv = {
        ...(prev?.env && typeof prev.env === 'object' ? prev.env : {}),
        ...(entry?.env && typeof entry.env === 'object' ? entry.env : {}),
      };
      // Preserve an existing non-empty BRAINLINK_AGENT_TOKEN when incoming has empty/omitted token.
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

  // Copy any other top-level keys only if absent (never clobber user settings).
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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const opt = (n, d = '') => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 || argv[i + 1]?.startsWith('--') ? d : argv[i + 1] ?? d;
  };
  const optAll = (n) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${n}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
  };

  const targetPath = opt('target');
  if (!targetPath) {
    process.stderr.write('Usage: install-settings.mjs --target <file.json> [--apply] [--server-cmd node] [--server-arg ...]\n');
    process.exit(2);
  }
  const cmd = opt('server-cmd', process.execPath);
  const args = optAll('server-arg');
  const incoming = {
    mcpServers: {
      brainlink: {
        command: cmd,
        args: args.length ? args : [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'brainlink.mjs'), 'serve'],
      },
    },
  };
  const result = await installSettings({ targetPath, incoming, apply: flag('apply') });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
