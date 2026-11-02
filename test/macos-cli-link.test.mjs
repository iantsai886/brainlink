import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(ROOT, 'packaging', 'macos', 'scripts', 'install-cli-link');
const run = (source, target) => spawnSync('bash', [helper, source, target], { encoding: 'utf8' });

test('macOS pkg CLI link creates and reuses only its own command link', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-mac-cli-link-'));
  try {
    const app = path.join(root, 'BrainLink App', 'brainlink');
    const bin = path.join(root, 'usr', 'local', 'bin');
    const link = path.join(bin, 'brainlink');
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(app), { recursive: true });
    await writeFile(app, '#!/bin/sh\nprintf ok\n', { mode: 0o755 });

    let result = run(app, link);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readlink(link), app);
    result = run(app, link);
    assert.equal(result.status, 0, result.stderr, 'reinstall is safe when the existing link is already BrainLink');
    assert.equal(await readlink(link), app);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('macOS pkg CLI link refuses to replace unrelated files or symlinks', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-mac-cli-link-'));
  try {
    const app = path.join(root, 'BrainLink', 'brainlink');
    const other = path.join(root, 'other-command');
    const fileTarget = path.join(root, 'file-bin', 'brainlink');
    const linkTarget = path.join(root, 'link-bin', 'brainlink');
    await mkdir(path.dirname(fileTarget), { recursive: true });
    await mkdir(path.dirname(linkTarget), { recursive: true });
    await mkdir(path.dirname(app), { recursive: true });
    await writeFile(app, '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(other, 'unrelated command\n', { mode: 0o755 });
    await writeFile(fileTarget, 'preserve this file\n');
    await symlink(other, linkTarget);

    const fileResult = run(app, fileTarget);
    assert.notEqual(fileResult.status, 0);
    assert.equal(await readFile(fileTarget, 'utf8'), 'preserve this file\n');
    const linkResult = run(app, linkTarget);
    assert.notEqual(linkResult.status, 0);
    assert.equal(await readlink(linkTarget), other);

    const missingDirResult = run(app, path.join(root, 'missing', 'brainlink'));
    assert.notEqual(missingDirResult.status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('macOS pkg builder installs the safe CLI-link helper and postinstall never force-replaces a command', async () => {
  const builder = await readFile(path.join(ROOT, 'packaging', 'macos', 'build-pkg.sh'), 'utf8');
  const postinstall = await readFile(path.join(ROOT, 'packaging', 'macos', 'scripts', 'postinstall'), 'utf8');
  assert.match(builder, /scripts\/install-cli-link/);
  assert.match(builder, /chmod 755 "\$APP\/Contents\/Resources\/bin\/install-cli-link"/);
  assert.match(postinstall, /Resources\/bin\/install-cli-link/);
  assert.doesNotMatch(postinstall, /ln\s+-sf/);
});
