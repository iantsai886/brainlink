import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'brainlink.mjs');

function run(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, done: new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr }))) };
}

test('desktop Setup reuses the saved running instance when opened again', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-setup-instance-'));
  const env = { ...process.env, BRAINLINK_HOME: home, HOME: home };
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let first;
  try {
    first = run(['setup', '--app', '--no-open', '--port', String(port)], env);
    let firstText = '';
    const firstReady = new Promise((resolve, reject) => {
      first.child.stdout.on('data', (chunk) => {
        firstText += chunk;
        if (firstText.includes('BrainLink Setup:')) resolve(firstText);
      });
      first.child.once('exit', (code) => reject(new Error(`first Setup exited ${code}: ${firstText}`)));
      setTimeout(() => reject(new Error(`first Setup did not start: ${firstText}; ${first.stderr}`)), 30000).unref();
    });
    await firstReady;
    const firstPort = Number(firstText.match(/127\.0\.0\.1:(\d+)/)?.[1]);
    assert.ok(firstPort > 0);

    const marker = JSON.parse(await readFile(path.join(home, 'setup-instance.json'), 'utf8'));
    assert.equal(marker.port, firstPort);
    const second = run(['setup', '--app', '--no-open', '--port', String(port)], env);
    const result = await second.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`127\\.0\\.0\\.1:${firstPort}`));
    assert.equal((await fetch(`http://127.0.0.1:${firstPort}/health`).then((r) => r.json())).app, 'brainlink');
  } finally {
    first?.child.kill();
    await first?.done;
    await rm(home, { recursive: true, force: true });
  }
});
