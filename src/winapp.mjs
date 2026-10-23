// Windows zip release: install-on-first-run and the Startup-folder autostart entry that stands in
// for macOS's LaunchAgent. No admin rights needed either way -- everything here lives under the
// current user's own AppData, exactly like the LaunchAgent plist lives under ~/Library.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// %LOCALAPPDATA%\BrainLink: survives deleting the folder BrainLink was unzipped into, so the
// Startup entry (and a re-opened shortcut) keep working after that.
export function installDir(env = process.env, home = homedir()) {
  return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'BrainLink');
}

// The per-user Startup folder: anything placed here runs automatically at login, no admin and no
// Task Scheduler registration needed.
export function startupScriptPath(env = process.env, home = homedir()) {
  return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'BrainLink.vbs');
}

function autostartScript(nodeExe, cliPath) {
  return `' BrainLink: starts the Setup server quietly at login (no window) -- the Startup-folder\r\n' stand-in for a LaunchAgent. Installed and removed only by BrainLink's own setup/uninstall.\r\n' Window style 0 = hidden, False = don't wait: node keeps running after this script exits.\r\nCreateObject("WScript.Shell").Run """${nodeExe}"" ""${cliPath}"" win-start --no-open", 0, False\r\n`;
}

// Copies this whole release folder (app/, node/, BrainLink.vbs, the uninstaller, READ ME FIRST.txt
// -- everything, like macOS's `cp -R "$HERE/."`) into the stable per-user install location, so
// they're all still reachable after the user deletes the folder they originally unzipped, then
// (re)writes the autostart entry. `skipCopy` lets a caller that already confirmed the background
// server is up skip re-copying ~100MB of Node runtime on every single double-click.
export async function installIfNeeded({ here, env = process.env, home = homedir(), skipCopy = false } = {}) {
  const dest = installDir(env, home);
  const alreadyThere = path.resolve(here) === path.resolve(dest);
  if (!alreadyThere && !skipCopy) {
    await mkdir(dest, { recursive: true });
    await cp(here, dest, { recursive: true, force: true });
  }
  const nodeExe = path.join(dest, 'node', 'node.exe');
  const cliPath = path.join(dest, 'app', 'bin', 'brainlink.mjs');
  const startup = startupScriptPath(env, home);
  await mkdir(path.dirname(startup), { recursive: true });
  await writeFile(startup, autostartScript(nodeExe, cliPath));
  return { dest, nodeExe, cliPath, startup };
}

// Removes the Startup entry and the installed copy. Never touches a vault folder -- notes live
// wherever the user pointed BrainLink at, never under installDir().
export async function uninstallWindows({ env = process.env, home = homedir() } = {}) {
  const dest = installDir(env, home);
  const startup = startupScriptPath(env, home);
  await rm(startup, { force: true });
  await rm(dest, { recursive: true, force: true });
  return { dest, startup };
}
