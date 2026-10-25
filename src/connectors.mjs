// One-click "Connect AI": writes BrainLink into each AI client's MCP config, keeping a
// timestamped backup of the previous file. Refuses to touch a config it cannot parse.
import { readFile, writeFile, mkdir, copyFile, rename, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const SERVER_KEY = 'brainlink';

const appData = (home, env) => env.APPDATA || path.join(home, 'AppData', 'Roaming');

export const CLIENTS = {
  'claude-desktop': {
    title: 'Claude Desktop', platform: 'Claude', role: 'Claude Desktop', format: 'json',
    file: ({ home, os, env }) => os === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : os === 'win32' ? path.join(appData(home, env), 'Claude', 'claude_desktop_config.json') : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    note: 'Quit and reopen Claude Desktop to load BrainLink.',
  },
  'claude-code': {
    title: 'Claude Code', platform: 'Claude', role: 'Claude Code', format: 'json', cli: 'claude',
    file: ({ home }) => path.join(home, '.claude.json'),
    note: 'Start a new Claude Code session; run /mcp to check.',
  },
  cursor: {
    title: 'Cursor', platform: 'Cursor', role: 'Cursor', format: 'json',
    file: ({ home }) => path.join(home, '.cursor', 'mcp.json'),
    note: 'Cursor picks it up in Settings → MCP (toggle on if needed).',
  },
  codex: {
    title: 'ChatGPT Codex', platform: 'ChatGPT Codex', role: 'Codex', format: 'toml',
    file: ({ home, env }) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    note: 'Start a new Codex session.',
  },
  gemini: {
    title: 'Gemini CLI', platform: 'Gemini', role: 'Gemini CLI', format: 'json',
    file: ({ home }) => path.join(home, '.gemini', 'settings.json'),
    note: 'Start a new Gemini CLI session; run /mcp to check.',
  },
  antigravity: {
    title: 'Google Antigravity', platform: 'Google Antigravity', role: 'Antigravity agent', format: 'json', manual: true,
    file: ({ home }) => path.join(home, '.gemini', 'config', 'mcp_config.json'),
    note: 'BrainLink is in Antigravity global MCP settings. Reload MCP servers or restart Antigravity.',
  },
  windsurf: {
    title: 'Windsurf', platform: 'other', role: 'Windsurf', format: 'json',
    file: ({ home }) => path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    note: 'Refresh MCP servers in Windsurf settings.',
  },
};

const exists = (p) => stat(p).then(() => true, () => false);

export function serverEntry(client, launch, extraEnv = {}) {
  const c = CLIENTS[client];
  return { command: launch.command, args: [...launch.args], env: { BRAINLINK_AI_PLATFORM: c.platform, BRAINLINK_AGENT_ROLE: c.role, ...extraEnv } };
}

// ChatGPT needs a public HTTPS MCP connector; it can't reach 127.0.0.1, so there is no config
// file to merge-write here. Not available yet; an opt-in tunnel is a possible future option
// (PRODUCT-SPEC §3, §7).
export const UNSUPPORTED = {
  chatgpt: { title: 'ChatGPT', note: 'Not available yet: ChatGPT needs a remote HTTPS MCP connector. Use session_log through any connected client, or Codex, in the meantime.' },
};

// Client is "present" when its config file or config folder exists.
async function detectOne(id, c, opts) {
  const file = c.file(opts);
  const present = (await exists(file)) || (!c.manual && id !== 'claude-code' && (await exists(path.dirname(file))));
  let connected = false;
  if (await exists(file)) {
    const raw = await readFile(file, 'utf8');
    connected = c.format === 'toml' ? /^\[mcp_servers\.brainlink\]/m.test(raw) : (() => { try { return Boolean(JSON.parse(raw || '{}').mcpServers?.[SERVER_KEY]); } catch { return false; } })();
  }
  return { title: c.title, file, present, connected, canConnect: present || Boolean(c.manual), manual: Boolean(c.manual), note: c.note };
}

export async function detect(opts) {
  const out = {};
  for (const [id, c] of Object.entries(CLIENTS)) out[id] = await detectOne(id, c, opts);
  for (const [id, c] of Object.entries(UNSUPPORTED)) out[id] = { title: c.title, file: null, present: false, connected: false, unsupported: true, note: c.note };
  return out;
}

async function backup(file, now) {
  if (!(await exists(file))) return null;
  const dest = `${file}.brainlink-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(file, dest);
  return dest;
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.brainlink-tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

// TOML: drop any existing [mcp_servers.brainlink*] tables, then append ours.
export function codexToml(raw, entry) {
  const lines = String(raw || '').split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (h) skipping = h[1].trim() === `mcp_servers.${SERVER_KEY}` || h[1].trim().startsWith(`mcp_servers.${SERVER_KEY}.`);
    if (!skipping) kept.push(line);
  }
  const s = (v) => JSON.stringify(String(v));
  if (!entry) return kept.join('\n').replace(/\n{3,}/g, '\n\n');
  const block = [`[mcp_servers.${SERVER_KEY}]`, `command = ${s(entry.command)}`, `args = [${entry.args.map(s).join(', ')}]`, '', `[mcp_servers.${SERVER_KEY}.env]`, ...Object.entries(entry.env).map(([k, v]) => `${k} = ${s(v)}`)].join('\n');
  return `${kept.join('\n').replace(/\s+$/, '')}${kept.join('').trim() ? '\n\n' : ''}${block}\n`;
}

function whichCli(name) {
  // On Windows the Claude CLI is a .cmd shim that Node cannot run safely without a shell, so
  // BrainLink edits its config file instead (with a backup).
  if (process.platform === 'win32') return null;
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

// opts: { home, os, env, launch: {command, args}, extraEnv, now, useCli }
export async function connectClient(id, opts) {
  const c = CLIENTS[id];
  if (!c) throw new Error(`Unknown client "${id}". Use one of: ${Object.keys(CLIENTS).join(', ')}`);
  // Refuse to write a config for an app this computer has never seen (no config file or folder
  // for it yet). Without this gate, connecting an app that was never installed still "succeeds":
  // it creates the folder, writes a config nobody reads, and then reports Connected -- a false
  // success a fresh-install test caught on an uninstalled Claude Desktop.
  if (!(await detectOne(id, c, opts)).canConnect) throw new Error(`${c.title} was not found on this computer. Install it, then try Connect again.`);
  const entry = serverEntry(id, opts.launch, opts.extraEnv);
  const now = opts.now || new Date();
  // Claude Code owns ~/.claude.json and rewrites it while running; use its CLI when present.
  const cli = c.cli && opts.useCli !== false ? whichCli(c.cli) : null;
  if (cli) {
    try { execFileSync(cli, ['mcp', 'remove', '-s', 'user', SERVER_KEY], { stdio: 'ignore' }); } catch {}
    execFileSync(cli, ['mcp', 'add-json', '-s', 'user', SERVER_KEY, JSON.stringify({ type: 'stdio', ...entry })], { stdio: 'ignore' });
    return { client: id, title: c.title, via: `${c.cli} mcp add-json`, file: null, backup: null, note: c.note };
  }
  const file = c.file(opts);
  const raw = (await exists(file)) ? await readFile(file, 'utf8') : '';
  let text;
  if (c.format === 'toml') text = codexToml(raw, entry);
  else {
    let json;
    try { json = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error(`${file} is not valid JSON; fix it or remove it, then try again (BrainLink will not overwrite it).`); }
    json.mcpServers = { ...(json.mcpServers || {}), [SERVER_KEY]: entry };
    text = JSON.stringify(json, null, 2) + '\n';
  }
  const b = await backup(file, now);
  await atomicWrite(file, text);
  return { client: id, title: c.title, via: 'config file', file, backup: b, note: c.note };
}

export async function disconnectClient(id, opts) {
  const c = CLIENTS[id];
  if (!c) throw new Error(`Unknown client "${id}"`);
  const cli = c.cli && opts.useCli !== false ? whichCli(c.cli) : null;
  if (cli) { try { execFileSync(cli, ['mcp', 'remove', '-s', 'user', SERVER_KEY], { stdio: 'ignore' }); } catch {} return { client: id, removed: true }; }
  const file = c.file(opts);
  if (!(await exists(file))) return { client: id, removed: false };
  const raw = await readFile(file, 'utf8');
  let text;
  if (c.format === 'toml') text = codexToml(raw, null);
  else {
    const json = JSON.parse(raw || '{}');
    if (!json.mcpServers?.[SERVER_KEY]) return { client: id, removed: false };
    delete json.mcpServers[SERVER_KEY];
    text = JSON.stringify(json, null, 2) + '\n';
  }
  const b = await backup(file, opts.now || new Date());
  await atomicWrite(file, text);
  return { client: id, removed: true, backup: b };
}

// Normalized {ok,message} wrappers over detect/connectClient/disconnectClient, for Setup's
// Connect buttons and anything else that wants one consistent shape instead of each function's
// own richer (and differently-shaped) result. Both call the exact same underlying code, so there
// is only ever one path that writes a client's MCP config.
export async function connect(id, opts) {
  if (UNSUPPORTED[id]) return { ok: false, message: UNSUPPORTED[id].note };
  try {
    const r = await connectClient(id, opts);
    return { ok: true, message: `Connected ${r.title} via ${r.via}${r.file ? ` (${r.file})` : ''}.${r.backup ? ` Backup: ${r.backup}.` : ''} ${r.note}`.trim() };
  } catch (e) { return { ok: false, message: e.message || String(e) }; }
}

export async function disconnect(id, opts) {
  if (UNSUPPORTED[id]) return { ok: false, message: UNSUPPORTED[id].note };
  try {
    const r = await disconnectClient(id, opts);
    return { ok: true, message: r.removed ? `Removed BrainLink from ${id}.` : `${id} had no BrainLink entry.` };
  } catch (e) { return { ok: false, message: e.message || String(e) }; }
}

// A light "is it actually connected" check: re-reads the client's config (no MCP round trip —
// serve isn't necessarily running). A live initialize + tools/list check is a UI-layer concern.
export async function test(id, opts) {
  if (UNSUPPORTED[id]) return { ok: false, message: UNSUPPORTED[id].note };
  try {
    const found = (await detect(opts))[id];
    if (!found) return { ok: false, message: `Unknown client "${id}".` };
    return { ok: found.connected, message: found.connected ? `${found.title} is connected.` : found.present ? `${found.title} was found but is not connected yet.` : `${found.title} was not found on this machine.` };
  } catch (e) { return { ok: false, message: e.message || String(e) }; }
}
