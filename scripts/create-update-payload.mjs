#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isValidUtcTimestamp, UPDATE_MANIFEST_LIMITS } from '../src/update-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--dist', '--out', '--channel', '--published-at'].includes(key) || values[key]) {
      throw new Error('Use --dist DIR --out FILE [--channel stable|beta] [--published-at UTC_TIMESTAMP].');
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`A value is required after ${key}.`);
    values[key] = value;
  }
  if (!values['--dist'] || !values['--out']) throw new Error('Use --dist DIR --out FILE [--channel stable|beta] [--published-at UTC_TIMESTAMP].');
  return values;
}

function expectedPackages(version) {
  const windows = `BrainLink-Setup-${version}.exe`;
  const mac = `BrainLink-${version}.pkg`;
  return [
    { platform: 'win32', arch: 'x64', format: 'exe', filename: windows },
    { platform: 'darwin', arch: 'x64', format: 'pkg', filename: mac },
    { platform: 'darwin', arch: 'arm64', format: 'pkg', filename: mac },
    { platform: 'linux', arch: 'x64', format: 'deb', filename: `brainlink_${version}_amd64.deb` },
    { platform: 'linux', arch: 'arm64', format: 'deb', filename: `brainlink_${version}_arm64.deb` },
    { platform: 'linux', arch: 'x64', format: 'tar.gz', filename: `brainlink-${version}-linux-x64.tar.gz` },
    { platform: 'linux', arch: 'arm64', format: 'tar.gz', filename: `brainlink-${version}-linux-arm64.tar.gz` },
  ];
}

async function hashPackage(file, filename) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Package ${filename} must be a regular file, not a link.`);
  if (before.size < 1 || before.size > UPDATE_MANIFEST_LIMITS.maxAssetBytes) throw new Error(`Package ${filename} must be between 1 byte and 2 GiB.`);
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Package ${filename} changed while it was being opened.`);
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(file, { fd: handle.fd, autoClose: false })) {
      size += chunk.length;
      if (size > UPDATE_MANIFEST_LIMITS.maxAssetBytes) throw new Error(`Package ${filename} grew beyond the 2 GiB limit while hashing.`);
      hash.update(chunk);
    }
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
      throw new Error(`Package ${filename} changed while it was being hashed.`);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function createUpdatePayload({ distDir, outputPath, channel = 'stable', publishedAt = new Date().toISOString() }) {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (!VERSION_PATTERN.test(version)) throw new Error('package.json must contain a numeric major.minor.patch version.');
  if (!['stable', 'beta'].includes(channel)) throw new Error('Channel must be stable or beta.');
  if (!isValidUtcTimestamp(publishedAt)) {
    throw new Error('Publication time must be a UTC ISO timestamp.');
  }

  const dist = path.resolve(distDir);
  const output = path.resolve(outputPath);
  const assets = [];
  for (const item of expectedPackages(version)) {
    const file = path.join(dist, item.filename);
    let digest;
    try { digest = await hashPackage(file, item.filename); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Missing release package: ${item.filename}. Build all platform packages first.`);
      throw error;
    }
    assets.push({
      platform: item.platform,
      arch: item.arch,
      format: item.format,
      url: `https://github.com/iantsai886/brainlink/releases/download/v${version}/${item.filename}`,
      sha256: digest.sha256,
      size: digest.size,
    });
  }

  const payload = { schema: 1, channel, version, published_at: publishedAt, assets };
  let handle;
  try { handle = await open(output, 'wx', 0o644); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Output already exists; choose a new path so a reviewed payload is not overwritten.');
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    try { await unlink(output); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
  await handle.close();
  return { path: output, version, channel, assetCount: assets.length };
}

async function main(argv) {
  try {
    const args = parseArgs(argv);
    const result = await createUpdatePayload({
      distDir: args['--dist'],
      outputPath: args['--out'],
      channel: args['--channel'] || 'stable',
      publishedAt: args['--published-at'] || new Date().toISOString(),
    });
    process.stdout.write(`Created ${result.channel} update payload for BrainLink ${result.version} with ${result.assetCount} platform entries.\n`);
    process.stdout.write(`Review ${result.path}, then sign it with the protected release key. No key was read and nothing was published.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
