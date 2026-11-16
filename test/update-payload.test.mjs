import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUpdatePayload } from '../scripts/create-update-payload.mjs';
import { signUpdateManifest } from '../src/update-signing.mjs';
import { verifyUpdateManifest } from '../src/update-manifest.mjs';

// Follow package.json, which the payload script reads, instead of a fixed past version.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PUBLISHED = '2026-10-30T12:00:00Z';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = [
  [`BrainLink-Setup-${VERSION}.exe`, 'win32', 'x64', 'exe'],
  [`BrainLink-${VERSION}.pkg`, 'darwin', 'x64', 'pkg'],
  [`BrainLink-${VERSION}.pkg`, 'darwin', 'arm64', 'pkg'],
  [`brainlink_${VERSION}_amd64.deb`, 'linux', 'x64', 'deb'],
  [`brainlink_${VERSION}_arm64.deb`, 'linux', 'arm64', 'deb'],
  [`brainlink-${VERSION}-linux-x64.tar.gz`, 'linux', 'x64', 'tar.gz'],
  [`brainlink-${VERSION}-linux-arm64.tar.gz`, 'linux', 'arm64', 'tar.gz'],
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-update-payload-'));
  const distDir = path.join(root, 'dist');
  await mkdir(distDir);
  const bodies = new Map();
  for (const [filename] of PACKAGES) {
    if (bodies.has(filename)) continue;
    const body = Buffer.from(`fictional package: ${filename}`);
    bodies.set(filename, body);
    await writeFile(path.join(distDir, filename), body);
  }
  return { root, distDir, bodies };
}

test('creates exact platform payload hashes and release URLs without overwriting', async () => {
  const f = await fixture();
  try {
    const outputPath = path.join(f.root, 'payload.json');
    const result = await createUpdatePayload({ distDir: f.distDir, outputPath, channel: 'beta', publishedAt: PUBLISHED });
    assert.equal(result.assetCount, 7);
    const payload = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(Object.keys(payload), ['schema', 'channel', 'version', 'published_at', 'assets']);
    assert.equal(payload.channel, 'beta');
    assert.equal(payload.version, VERSION);
    assert.equal(payload.published_at, PUBLISHED);
    assert.equal(payload.assets.length, PACKAGES.length);
    for (const [index, [filename, platform, arch, format]] of PACKAGES.entries()) {
      const asset = payload.assets[index];
      const bytes = f.bodies.get(filename);
      assert.deepEqual({ platform: asset.platform, arch: asset.arch, format: asset.format }, { platform, arch, format });
      assert.equal(asset.url, `https://github.com/iantsai886/brainlink/releases/download/v${VERSION}/${filename}`);
      assert.equal(asset.size, bytes.length);
      assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
    const envelope = signUpdateManifest(payload, privateKey, { now: Date.parse(PUBLISHED) });
    const verified = verifyUpdateManifest(envelope, publicKey, {
      currentVersion: '0.0.1', channel: 'beta', platform: 'linux', arch: 'arm64', now: Date.parse(PUBLISHED),
    });
    assert.equal(verified.version, VERSION);
    assert.equal(verified.selected_asset.format, 'deb');
    assert.equal(verified.selected_asset.sha256, payload.assets.find((asset) => asset.platform === 'linux' && asset.arch === 'arm64' && asset.format === 'deb').sha256);
    const before = await readFile(outputPath);
    await assert.rejects(createUpdatePayload({ distDir: f.distDir, outputPath, publishedAt: PUBLISHED }), /already exists/);
    assert.deepEqual(await readFile(outputPath), before, 'existing reviewed payload must stay untouched');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('refuses missing, linked, or non-file release packages and leaves no payload', async (t) => {
  const f = await fixture();
  try {
    const outputPath = path.join(f.root, 'payload.json');
    const linuxAsset = path.join(f.distDir, `brainlink-${VERSION}-linux-arm64.tar.gz`);
    await unlink(linuxAsset);
    await assert.rejects(createUpdatePayload({ distDir: f.distDir, outputPath, publishedAt: PUBLISHED }), /Missing release package/);
    await mkdir(linuxAsset);
    await assert.rejects(createUpdatePayload({ distDir: f.distDir, outputPath, publishedAt: PUBLISHED }), /regular file, not a link/);
    await rm(linuxAsset, { recursive: true });
    if (process.platform === 'win32') {
      try { await symlink(path.join(f.distDir, `brainlink_${VERSION}_amd64.deb`), linuxAsset); }
      catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows symlink privilege unavailable'); return; } throw error; }
    } else {
      await symlink(path.join(f.distDir, `brainlink_${VERSION}_amd64.deb`), linuxAsset);
    }
    await assert.rejects(createUpdatePayload({ distDir: f.distDir, outputPath, publishedAt: PUBLISHED }), /regular file, not a link/);
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects unsupported channels and invalid timestamps before writing', async () => {
  const f = await fixture();
  try {
    await assert.rejects(createUpdatePayload({ distDir: f.distDir, outputPath: path.join(f.root, 'bad-channel.json'), channel: 'preview', publishedAt: PUBLISHED }), /Channel must be/);
    await assert.rejects(createUpdatePayload({ distDir: f.distDir, outputPath: path.join(f.root, 'bad-time.json'), publishedAt: 'next week' }), /UTC ISO timestamp/);
    await assert.rejects(createUpdatePayload({ distDir: f.distDir, outputPath: path.join(f.root, 'impossible-time.json'), publishedAt: '2026-02-31T12:00:00Z' }), /UTC ISO timestamp/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('payload CLI reports the version and does not ask for a signing key', async () => {
  const f = await fixture();
  try {
    const outputPath = path.join(f.root, 'payload.json');
    const result = spawnSync(process.execPath, [
      'scripts/create-update-payload.mjs', '--dist', f.distDir, '--out', outputPath,
      '--channel', 'stable', '--published-at', PUBLISHED,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`stable update payload for BrainLink ${VERSION} with 7 platform entries`), result.stdout);
    assert.match(result.stdout, /No key was read and nothing was published/);
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).assets.length, 7);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
