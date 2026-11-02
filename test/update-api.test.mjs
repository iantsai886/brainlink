import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { startSetup } from '../src/setup.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
const packageBytes = Buffer.from('fictional signed package bytes');
const payload = {
  schema: 1, channel: 'stable', version: '1.2.9', published_at: '2026-10-28T11:00:00Z',
  assets: [{ platform: 'linux', arch: 'x64', format: 'deb', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/brainlink_1.2.9_amd64.deb', sha256: createHash('sha256').update(packageBytes).digest('hex'), size: packageBytes.length }],
};
const bytes = Buffer.from(JSON.stringify(payload));
const envelope = { schema: 1, key_id: keyId, payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };

test('Setup update check requires its local token and returns only signed release metadata', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-update-api-'));
  let launched;
  const app = await startSetup({
    env: { BRAINLINK_HOME: path.join(home, 'app'), HOME: home }, home, os: 'linux', arch: 'x64', useCli: false,
    updatePublicKey: publicPem,
    updateTempRoot: home,
    updateLauncher: async (input) => { launched = input; assert.deepEqual(await readFile(input.file), packageBytes); },
    updateFetch: async (url) => url.includes('/releases/download/')
      ? new Response(packageBytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(packageBytes.length) } })
      : new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } }),
  });
  const base = `http://127.0.0.1:${app.port}`;
  let serverClosed = false;
  try {
    assert.equal((await fetch(`${base}/api/updates/check`)).status, 401);
    const response = await fetch(`${base}/api/updates/check`, { headers: { 'X-BrainLink-Token': app.token } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'available');
    assert.equal(result.version, '1.2.9');
    assert.equal(result.asset.format, 'deb');
    assert.equal(result.asset.sha256, payload.assets[0].sha256);
    assert.equal(JSON.stringify(result).includes('signature'), false);

    const unauthorizedDownload = await fetch(`${base}/api/updates/download`, { method: 'POST' });
    assert.equal(unauthorizedDownload.status, 401);
    const preparedResponse = await fetch(`${base}/api/updates/download`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(preparedResponse.status, 200);
    const prepared = await preparedResponse.json();
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.sha256, payload.assets[0].sha256);
    assert.equal(prepared.format, 'deb');
    assert.match(prepared.ticket, /^[A-Za-z0-9_-]{40,48}$/);
    assert.equal((await fetch(`${base}/api/updates/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: prepared.ticket }) })).status, 401);
    const opened = await fetch(`${base}/api/updates/open`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: prepared.ticket }) });
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), { status: 'opened', version: '1.2.9', format: 'deb' });
    assert.equal(launched.format, 'deb');
    assert.equal(launched.platform, 'linux');
    assert.equal(path.dirname(launched.file).startsWith(home), true);
    const openedAgain = await fetch(`${base}/api/updates/open`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: prepared.ticket }) });
    assert.equal(openedAgain.status, 400);
    assert.match((await openedAgain.json()).error, /already opened/);
    const openedDownload = await fetch(new URL(prepared.download_url, base));
    assert.equal(openedDownload.status, 200, 'the verified manual fallback remains available after opening the installer');
    assert.deepEqual(Buffer.from(await openedDownload.arrayBuffer()), packageBytes);
    assert.equal((await fetch(new URL(prepared.download_url, base))).status, 409, 'a verified fallback download is one-use');
    assert.deepEqual(await readFile(launched.file), packageBytes, 'the installer handoff remains stable after fallback download');

    const manualResponse = await fetch(`${base}/api/updates/download`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: '{}' });
    const manual = await manualResponse.json();
    const fileUrl = new URL(manual.download_url, base);
    fileUrl.searchParams.set('t', 'wrong-token');
    assert.equal((await fetch(fileUrl)).status, 401, 'a bad local token must not consume the one-time download ticket');
    const file = await fetch(new URL(manual.download_url, base));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-disposition'), 'attachment; filename="brainlink_1.2.9_amd64.deb"');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), packageBytes);
    assert.equal((await fetch(new URL(manual.download_url, base))).status, 409, 'the verified download can be used only once');
    const manualOpen = await fetch(`${base}/api/updates/open`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: manual.ticket }) });
    assert.equal(manualOpen.status, 200, 'the installer can still be opened after downloading the package');
    assert.equal(launched.format, 'deb');
    assert.deepEqual(await readFile(launched.file), packageBytes, 'the package remains available for OS handoff');

    const previousFolders = new Set((await readdir(home, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith('brainlink-update-')).map((entry) => entry.name));
    const tamperedResponse = await fetch(`${base}/api/updates/download`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: '{}' });
    const tampered = await tamperedResponse.json();
    const packageFolder = (await readdir(home, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.startsWith('brainlink-update-') && !previousFolders.has(entry.name));
    await writeFile(path.join(home, packageFolder.name, 'brainlink_1.2.9_amd64.deb'), Buffer.from('tampered bytes'));
    const tamperedOpen = await fetch(`${base}/api/updates/open`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: tampered.ticket }) });
    assert.equal(tamperedOpen.status, 400);
    assert.match((await tamperedOpen.json()).error, /changed after download/);
    assert.equal(launched.format, 'deb', 'tampered bytes never reach the OS launcher');
    await new Promise((resolve) => app.server.close(resolve));
    serverClosed = true;
    assert.deepEqual(await readFile(launched.file), packageBytes, 'an installer handoff stays available if BrainLink exits during installation');
  } finally {
    if (!serverClosed) await new Promise((resolve) => app.server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('verified update open and manual download reject overlapping actions but allow the fallback afterward', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-update-race-'));
  let beginLaunch;
  let finishLaunch;
  const launchStarted = new Promise((resolve) => { beginLaunch = resolve; });
  const launchGate = new Promise((resolve) => { finishLaunch = resolve; });
  const app = await startSetup({
    env: { BRAINLINK_HOME: path.join(home, 'app'), HOME: home }, home, os: 'linux', arch: 'x64', useCli: false,
    updatePublicKey: publicPem,
    updateTempRoot: home,
    updateLauncher: async ({ file }) => { assert.deepEqual(await readFile(file), packageBytes); beginLaunch(); await launchGate; },
    updateFetch: async (url) => url.includes('/releases/download/')
      ? new Response(packageBytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(packageBytes.length) } })
      : new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } }),
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const preparedResponse = await fetch(`${base}/api/updates/download`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: '{}' });
    const prepared = await preparedResponse.json();
    const openPromise = fetch(`${base}/api/updates/open`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: prepared.ticket }) });
    await launchStarted;
    const duplicateOpen = await fetch(`${base}/api/updates/open`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: prepared.ticket }) });
    assert.equal(duplicateOpen.status, 400, 'a second open cannot race the active installer handoff');
    const overlappingDownload = await fetch(new URL(prepared.download_url, base));
    assert.equal(overlappingDownload.status, 409, 'download cannot race the active installer handoff');
    finishLaunch();
    assert.equal((await openPromise).status, 200);
    const fallback = await fetch(new URL(prepared.download_url, base));
    assert.equal(fallback.status, 200, 'manual download is allowed after the installer handoff completes');
    assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), packageBytes);
  } finally {
    finishLaunch();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
