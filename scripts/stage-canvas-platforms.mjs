#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [destinationArg, ...targets] = process.argv.slice(2);
const allowed = new Set(['win32-x64-msvc', 'darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu']);
if (!destinationArg || targets.length < 1 || targets.some((target) => !allowed.has(target)) || new Set(targets).size !== targets.length) {
  console.error('Usage: npm run stage:canvas-platforms -- NODE_MODULES_DIR win32-x64-msvc|darwin-x64|darwin-arm64|linux-x64-gnu|linux-arm64-gnu [...]');
  process.exit(2);
}
const destination = path.resolve(destinationArg);
const canvasEntry = path.join(destination, '@napi-rs', 'canvas', 'package.json');
try { await access(canvasEntry); }
catch { throw new Error('Refusing to stage native packages outside a node_modules tree containing @napi-rs/canvas.'); }

const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const canvasLock = lock.packages?.['node_modules/@napi-rs/canvas'];
if (!canvasLock?.optionalDependencies) throw new Error('The pinned canvas platform package list is missing from package-lock.json.');
const nativeNames = Object.keys(canvasLock.optionalDependencies).filter((name) => name.startsWith('@napi-rs/canvas-'));
const wanted = targets.map((target) => `@napi-rs/canvas-${target}`);
const scope = path.join(destination, '@napi-rs');
await mkdir(scope, { recursive: true });

for (const name of nativeNames) {
  const target = path.join(scope, name.slice('@napi-rs/'.length));
  if (!wanted.includes(name)) await rm(target, { recursive: true, force: true });
}

for (const name of wanted) {
  const version = canvasLock.optionalDependencies[name];
  const packageLock = lock.packages?.[`node_modules/${name}`];
  if (!version || packageLock?.version !== version) throw new Error(`Canvas binary ${name} is not pinned consistently in the lock file.`);
  let source = path.join(root, 'node_modules', name);
  let installedVersion;
  try {
    installedVersion = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version;
  } catch { installedVersion = undefined; }
  let temporary;
  if (installedVersion !== version) {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'brainlink-canvas-'));
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('Run this through `npm run stage:canvas-platforms` so the locked npm client can fetch platform binaries.');
    const result = spawnSync(process.execPath, [npmCli, 'install', '--prefix', temporary, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '--force', `${name}@${version}`], {
      cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) {
      await rm(temporary, { recursive: true, force: true });
      throw new Error(`Could not fetch locked canvas binary ${name}@${version}: ${(result.stderr || result.stdout || result.error?.message || 'npm failed').trim().slice(0, 600)}`);
    }
    source = path.join(temporary, 'node_modules', name);
    installedVersion = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version;
  }
  try {
    if (installedVersion !== version) throw new Error(`Canvas binary ${name} has unexpected version ${installedVersion}.`);
    const target = path.join(scope, name.slice('@napi-rs/'.length));
    const sourceReal = await realpath(source);
    await rm(target, { recursive: true, force: true });
    await cp(sourceReal, target, { recursive: true, dereference: true });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

console.log(`Staged PDF-rendering canvas binaries for ${targets.join(', ')}.`);
