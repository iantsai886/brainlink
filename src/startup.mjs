import { readFile, writeFile, mkdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CLI_PATH } from './runtime.mjs';

const MARKER = 'BrainLink managed startup launcher v1';
const FILES = {
  win32: 'BrainLink Background.vbs',
  darwin: 'com.iango.brainlink.background.plist',
  linux: 'brainlink-background.desktop',
};

function homeDir(env, home) { return home || env.HOME || env.USERPROFILE || ''; }

export function startupLauncherPath(env = process.env, home, os = process.platform) {
  const userHome = homeDir(env, home);
  if (os === 'win32') {
    const roaming = env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
    return path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', FILES.win32);
  }
  if (os === 'darwin') return path.join(userHome, 'Library', 'LaunchAgents', FILES.darwin);
  if (os === 'linux') return path.join(env.XDG_CONFIG_HOME || path.join(userHome, '.config'), 'autostart', FILES.linux);
  throw new Error(`Start at sign-in is not supported on ${os}.`);
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

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function macStartupSource(nodePath = process.execPath, cliPath = CLI_PATH) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARKER} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.iango.brainlink.background</string>\n<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(cliPath)}</string><string>setup</string><string>--app</string><string>--no-open</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
}

const desktopArg = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/%/g, '%%')}"`;

export function linuxStartupSource(nodePath = process.execPath, cliPath = CLI_PATH) {
  return `# ${MARKER}\n[Desktop Entry]\nType=Application\nName=BrainLink Background\nComment=Run BrainLink quietly at sign-in\nExec=${desktopArg(nodePath)} ${desktopArg(cliPath)} setup --app --no-open\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}

export function startupSource(os = process.platform, nodePath = process.execPath, cliPath = CLI_PATH) {
  if (os === 'win32') return startupLauncherSource(nodePath, cliPath);
  if (os === 'darwin') return macStartupSource(nodePath, cliPath);
  if (os === 'linux') return linuxStartupSource(nodePath, cliPath);
  throw new Error(`Start at sign-in is not supported on ${os}.`);
}

export async function isStartupEnabled(env = process.env, home, os = process.platform) {
  const file = startupLauncherPath(env, home, os);
  const source = await readFile(file, 'utf8').catch(() => '');
  return source.includes(MARKER);
}

export async function setStartupEnabled(enabled, { env = process.env, home, os = process.platform, nodePath = process.execPath, cliPath = CLI_PATH } = {}) {
  const file = startupLauncherPath(env, home, os);
  const existing = await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing !== null) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The BrainLink startup entry is not a regular managed file; it was left unchanged.');
  }
  const owned = existing?.includes(MARKER) || false;
  if (!enabled) {
    if (existing && !owned) throw new Error('The BrainLink startup file exists but is not managed by BrainLink; it was left unchanged.');
    if (owned) await unlink(file);
    return false;
  }
  if (existing && !owned) throw new Error('A file already exists at the BrainLink startup location; it was left unchanged.');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, startupSource(os, nodePath, cliPath), { encoding: 'utf8', mode: 0o600 });
  return true;
}
