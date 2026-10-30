// Opt-in local client configuration. Never edits trust decisions or unrelated hooks.
import path from 'node:path';
import { readFile, writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CLI_PATH } from '../runtime.mjs';
import { appHome } from '../config.mjs';
import { isMap, isSeq, parseDocument } from 'yaml';

const MARKER = 'BrainLink session closeout reminder';
const HERMES_MARKER = /\bsession-end-cue['"]?\s+['"]?--client['"]?\s+['"]?hermes['"]?\b/;
const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
function location(client, home, env) {
  if (client === 'claude-code') return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
  if (client === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json');
  throw new Error('Choose Claude Code or Codex.');
}
function quote(value, os) {
  if (os === 'win32') {
    if (/["%!$`\r\n]/.test(value)) throw new Error('This installation path cannot safely be used in a Windows hook command.');
    return `"${value.replace(/\\/g, '/')}"`;
  }
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
function owned(handler) {
  return handler?.statusMessage === MARKER && handler?.type === 'command' && /\bsession-end-cue\s+--client\s+(?:claude-code|codex)\b/.test(handler.command || '');
}
async function load(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { config: {}, raw: null }; throw e; }
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('Client settings contain invalid JSON. Repair them before changing hooks.'); }
  if (!object(config) || (config.hooks !== undefined && !object(config.hooks)) || (config.hooks?.SessionEnd !== undefined && !Array.isArray(config.hooks.SessionEnd))) throw new Error('Client hook settings have an unsupported structure.');
  if ((config.hooks?.SessionEnd || []).some((g) => !object(g) || !Array.isArray(g.hooks))) throw new Error('Client SessionEnd settings have an unsupported structure.');
  return { config, raw };
}
export async function sessionHookStatus(client, { home, env = process.env } = {}) {
  const file = location(client, home, env);
  const { config } = await load(file);
  return { client, configured: (config.hooks?.SessionEnd || []).some((g) => g.hooks.some(owned)), trust_required: client === 'codex' };
}
export async function setSessionHook(client, enabled, { home, env = process.env, os = process.platform, node = process.execPath, cli = CLI_PATH } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether reminders are enabled.');
  const file = location(client, home, env);
  const { config, raw } = await load(file);
  const groups = (config.hooks?.SessionEnd || []).flatMap((g) => {
    const hooks = g.hooks.filter((h) => !owned(h));
    return hooks.length || !g.hooks.some(owned) ? [{ ...g, hooks }] : [];
  });
  if (enabled) {
    const command = `${quote(node, os)} ${quote(cli, os)} session-end-cue --client ${client} --data-home ${quote(appHome(env), os)}`;
    groups.push({ hooks: [{ type: 'command', command, timeout: 3, statusMessage: MARKER }] });
  }
  if (!enabled && !config.hooks?.SessionEnd?.some((g) => g.hooks.some(owned))) return { ok: true, configured: false, changed: false };
  const next = { ...config, hooks: { ...config.hooks, SessionEnd: groups } };
  const text = JSON.stringify(next, null, 2) + '\n';
  if (text === raw) return { ok: true, configured: enabled, changed: false };
  await mkdir(path.dirname(file), { recursive: true });
  const backup = raw === null ? null : `${file}.brainlink-backup-${randomUUID()}`;
  if (backup) await copyFile(file, backup);
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    let current;
    try { current = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; current = null; }
    if (current !== raw) throw new Error('Client settings changed while saving. Try again.');
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
  return { ok: true, configured: enabled, changed: true, backup, trust_required: enabled && client === 'codex' };
}

function hermesLocation(profileRoot) {
  if (typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot)) throw new Error('Choose an absolute Hermes profile folder.');
  return path.join(profileRoot, 'config.yaml');
}
function hermesManaged(item) {
  const command = isMap(item) ? item.get('command') : null;
  return typeof command === 'string' && HERMES_MARKER.test(command);
}
async function readHermesConfig(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { raw: null, doc: parseDocument('') }; throw e; }
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Hermes config.yaml contains invalid YAML. Repair it before changing hooks.');
  if (doc.contents && !isMap(doc.contents)) throw new Error('Hermes config.yaml must contain a YAML mapping.');
  return { raw, doc };
}
function hermesHooksNode(doc, create = false) {
  let hooks = doc.get('hooks', true);
  if (hooks === undefined && create) {
    doc.set('hooks', {});
    hooks = doc.get('hooks', true);
  }
  if (hooks !== undefined && !isMap(hooks)) throw new Error('Hermes hooks settings have an unsupported structure.');
  return hooks;
}
function hermesEventNode(doc, create = false) {
  const hooks = hermesHooksNode(doc, create);
  if (!hooks) return undefined;
  let event = hooks.get('on_session_finalize', true);
  if (event === undefined && create) {
    hooks.set('on_session_finalize', doc.createNode([]));
    event = hooks.get('on_session_finalize', true);
  }
  if (event !== undefined && !isSeq(event)) throw new Error('Hermes on_session_finalize hooks have an unsupported structure.');
  return event;
}
function hermesQuote(value, os) {
  const normalized = os === 'win32' ? String(value).replace(/\\/g, '/') : String(value);
  return `'${normalized.replace(/'/g, `'"'"'`)}'`;
}
export async function hermesSessionHookStatus(profileRoot) {
  const file = hermesLocation(profileRoot);
  const { doc } = await readHermesConfig(file);
  const event = hermesEventNode(doc);
  return { client: 'hermes', configured: Boolean(event?.items.some(hermesManaged)), profile: profileRoot, trust_required: true, privileged_shell_hook: true };
}
export async function setHermesSessionHook(profileRoot, enabled, { env = process.env, os = process.platform, node = process.execPath, cli = CLI_PATH } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether reminders are enabled.');
  const file = hermesLocation(profileRoot);
  const { doc, raw } = await readHermesConfig(file);
  const event = hermesEventNode(doc, enabled);
  const items = event?.items || [];
  const managed = items.filter(hermesManaged);
  if (enabled && managed.length) return { ok: true, configured: true, changed: false, trust_required: true, privileged_shell_hook: true };
  if (!enabled && !managed.length) return { ok: true, configured: false, changed: false, trust_required: true, privileged_shell_hook: true };
  if (enabled) {
    const command = [node, cli, 'session-end-cue', '--client', 'hermes', '--data-home', appHome(env), '--session-root', profileRoot]
      .map((part) => hermesQuote(part, os)).join(' ');
    event.items.push(doc.createNode({ command, timeout: 3 }));
  } else {
    event.items.splice(0, event.items.length, ...items.filter((item) => !hermesManaged(item)));
  }
  if (!enabled && event.items.length === 0) hermesHooksNode(doc).delete('on_session_finalize');
  const hooks = hermesHooksNode(doc);
  if (hooks && [...hooks.items].length === 0) doc.delete('hooks');
  const text = doc.toString();
  if (text === raw) return { ok: true, configured: enabled, changed: false, trust_required: true, privileged_shell_hook: true };
  await mkdir(path.dirname(file), { recursive: true });
  const backup = raw === null ? null : `${file}.brainlink-backup-${randomUUID()}`;
  if (backup) await copyFile(file, backup);
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    let current;
    try { current = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; current = null; }
    if (current !== raw) throw new Error('Hermes config changed while saving. Try again.');
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
  return { ok: true, configured: enabled, changed: true, backup, trust_required: true, privileged_shell_hook: true };
}
