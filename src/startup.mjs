import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CLI_PATH } from './runtime.mjs';

const MARKER = 'BrainLink managed startup launcher v1';
const FILE_NAME = 'BrainLink Background.vbs';

export function startupLauncherPath(env = process.env, home = process.env.USERPROFILE || process.env.HOME || '') {
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', FILE_NAME);
}

const vbString = (value) => `"${String(value).replace(/"/g, '""')}"`;

export function startupLauncherSource(nodePath = process.execPath, cliPath = CLI_PATH) {
  return [
    `' ${MARKER}`,
    'Set shell = CreateObject("WScript.Shell")',
    `nodePath = ${vbString(nodePath)}`,
    `cliPath = ${vbString(cliPath)}`,
    'shell.Run """" & nodePath & """ """ & cliPath & """ setup --app --no-open", 0, False',
    '',
  ].join('\r\n');
}

export async function isStartupEnabled(env = process.env, home) {
  const file = startupLauncherPath(env, home);
  const source = await readFile(file, 'utf8').catch(() => '');
  return source.includes(MARKER);
}

export async function setStartupEnabled(enabled, { env = process.env, home, os = process.platform, nodePath = process.execPath, cliPath = CLI_PATH } = {}) {
  if (os !== 'win32') throw new Error('Start at sign-in is currently available on Windows only.');
  const file = startupLauncherPath(env, home);
  const existing = await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const owned = existing?.includes(MARKER) || false;
  if (!enabled) {
    if (existing && !owned) throw new Error('The BrainLink startup file exists but is not managed by BrainLink; it was left unchanged.');
    if (owned) await unlink(file);
    return false;
  }
  if (existing && !owned) throw new Error('A file already exists at the BrainLink startup location; it was left unchanged.');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, startupLauncherSource(nodePath, cliPath), 'utf8');
  return true;
}
