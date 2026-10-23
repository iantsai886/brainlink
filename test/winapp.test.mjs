// B1: the Windows zip release's install-on-first-run + Startup-folder autostart entry (the
// no-admin-needed stand-in for macOS's LaunchAgent). Pure fs logic with injected env/home, so it
// runs the same on this Linux box as it would on a real Windows PC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { installDir, startupScriptPath, installIfNeeded, uninstallWindows } from '../src/winapp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'brainlink.mjs');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

async function fakeRelease(dir) {
  await mkdir(path.join(dir, 'app', 'bin'), { recursive: true });
  await writeFile(path.join(dir, 'app', 'bin', 'brainlink.mjs'), '// fake cli\n');
  await mkdir(path.join(dir, 'node'), { recursive: true });
  await writeFile(path.join(dir, 'node', 'node.exe'), 'fake node binary\n');
  await writeFile(path.join(dir, 'BrainLink.vbs'), '\' fake launcher\n');
  await writeFile(path.join(dir, 'Uninstall BrainLink.cmd'), '@echo off\n');
  await writeFile(path.join(dir, 'READ ME FIRST.txt'), 'read me\n');
  return dir;
}

test('installDir/startupScriptPath: resolve under the injected LOCALAPPDATA/APPDATA, not the real ones', async () => {
  const home = await tmp('winapp-env');
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') };
  assert.strictEqual(installDir(env, home), path.join(home, 'Local', 'BrainLink'));
  assert.strictEqual(startupScriptPath(env, home), path.join(home, 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'BrainLink.vbs'));
});

test('installIfNeeded: copies app/+node/ into installDir() and writes a Startup-folder entry pointing at the installed copy', async () => {
  const home = await tmp('winapp-install');
  const here = await fakeRelease(await tmp('winapp-release'));
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') };

  const { dest, nodeExe, cliPath, startup } = await installIfNeeded({ here, env, home });

  assert.strictEqual(dest, installDir(env, home));
  assert.ok(await stat(path.join(dest, 'app', 'bin', 'brainlink.mjs')).then(() => true, () => false));
  assert.ok(await stat(path.join(dest, 'node', 'node.exe')).then(() => true, () => false));
  assert.ok(await stat(here).then(() => true, () => false), 'the original downloaded folder must be copied, not moved');
  assert.ok(await stat(path.join(dest, 'Uninstall BrainLink.cmd')).then(() => true, () => false), 'the uninstaller must also land in the installed copy, so it survives deleting the download');
  assert.ok(await stat(path.join(dest, 'READ ME FIRST.txt')).then(() => true, () => false));

  const script = await readFile(startup, 'utf8');
  assert.ok(script.includes(nodeExe) && script.includes(cliPath), 'autostart script must point at the installed node.exe and brainlink.mjs, not the download folder');
  assert.match(script, /win-start --no-open/, 'autostart must not pop a browser window at login');
  assert.match(script, /\.Run ".*", 0, False/, 'must run hidden (window style 0) and not block (False)');
});

test('installIfNeeded: running it again from the installed copy itself is a no-op copy (dest === here)', async () => {
  const home = await tmp('winapp-reinstall');
  const here = await fakeRelease(await tmp('winapp-release2'));
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') };
  const first = await installIfNeeded({ here, env, home });

  // Simulate the autostart entry (or a second double-click) now running from the installed dest.
  const second = await installIfNeeded({ here: first.dest, env, home });
  assert.strictEqual(second.dest, first.dest);
  assert.ok(await stat(path.join(second.dest, 'app', 'bin', 'brainlink.mjs')).then(() => true, () => false));
});

test('installIfNeeded: skipCopy avoids re-copying the runtime when the server is already confirmed running', async () => {
  const home = await tmp('winapp-skip');
  const here = await fakeRelease(await tmp('winapp-release3'));
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') };
  await installIfNeeded({ here, env, home });
  // Mark the installed app file so we can tell a skipped copy from a real one.
  const dest = installDir(env, home);
  await writeFile(path.join(dest, 'app', 'bin', 'brainlink.mjs'), '// marker: not overwritten\n');

  await installIfNeeded({ here, env, home, skipCopy: true });
  assert.strictEqual(await readFile(path.join(dest, 'app', 'bin', 'brainlink.mjs'), 'utf8'), '// marker: not overwritten\n');
});

test('uninstallWindows: removes the installed copy and the autostart entry', async () => {
  const home = await tmp('winapp-uninstall');
  const here = await fakeRelease(await tmp('winapp-release4'));
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') };
  const { dest, startup } = await installIfNeeded({ here, env, home });
  assert.ok(await stat(dest).then(() => true, () => false));
  assert.ok(await stat(startup).then(() => true, () => false));

  await uninstallWindows({ env, home });
  assert.ok(!(await stat(dest).then(() => true, () => false)));
  assert.ok(!(await stat(startup).then(() => true, () => false)));
});

test('CLI: `brainlink win-start --no-open` is wired to the same Setup server as `brainlink setup` (install step is win32-only, skipped here)', async () => {
  const home = await tmp('winapp-cli-start');
  const child = spawn(process.execPath, [CLI, 'win-start', '--no-open'], { env: { ...process.env, HOME: home, BRAINLINK_HOME: path.join(home, 'home'), BRAINLINK_SHOW_TOKEN: '1' } });
  let buf = '';
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { buf += d; const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=(\S+)/); if (m) resolve(m[0]); });
    child.on('exit', (code) => reject(new Error(`exited ${code} before printing a URL: ${buf}`)));
    setTimeout(() => reject(new Error(`no URL after 5s: ${buf}`)), 5000);
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
  child.kill();
});

test('CLI: `brainlink win-uninstall` runs cleanly with no AI apps connected (nothing to disconnect)', async () => {
  const home = await tmp('winapp-cli-uninstall');
  const child = spawn(process.execPath, [CLI, 'win-uninstall'], { env: { ...process.env, HOME: home, BRAINLINK_HOME: path.join(home, 'home'), LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') } });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.strictEqual(code, 0);
  assert.match(buf, /BrainLink has been removed/);
});
