// `brainlink ui` / `brainlink demo` must serve the v1.1 Setup app (ui/index.html), not ui/app/,
// on 127.0.0.1 with a per-launch token (RB1 merge).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'brainlink.mjs');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

// Launches `brainlink <cmd> --no-open`, waits for the printed URL, hands back a fetch-ready base
// + token and a stop() to kill the child. The CLI never exits on its own (the HTTP server keeps
// the event loop alive, same as a real `ui`/`demo` session) so every caller must stop() it.
async function launch(cmd, env) {
  // BRAINLINK_SHOW_TOKEN: the Terminal normally shows the URL with the token masked (RB3 safety
  // fix); tests need the real token to drive the API the way the browser (which always gets the
  // full URL) would.
  const child = spawn(process.execPath, [CLI, cmd, '--no-open'], { env: { ...env, BRAINLINK_SHOW_TOKEN: '1' } });
  let buf = '';
  let timer;
  let url;
  try {
    url = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=(\S+)/);
        if (m) resolve({ port: m[1], token: m[2] });
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`exited ${code} before printing a URL: ${buf}`)));
      timer = setTimeout(() => reject(new Error(`no URL after 30s: ${buf}`)), 30_000);
    });
  } catch (error) {
    // A failed readiness check must not leave a hidden server running and interfere with later
    // tests or a developer's next attempt. On Windows, wait for the spawned CLI to exit too.
    if (!child.killed) child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const base = `http://127.0.0.1:${url.port}`;
  const api = (method, p, body) => fetch(base + p, { method, headers: { 'X-BrainLink-Token': url.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { base, token: url.token, api, stop: () => child.kill() };
}

test('`brainlink demo`: serves ui/index.html, pre-populated with the sample vault + agent, nothing real touched', async () => {
  const home = await tmp('demo-cli-home');
  const s = await launch('demo', { ...process.env, HOME: home });
  try {
    const page = await (await fetch(s.base + `/?t=${s.token}`, { headers: { 'X-BrainLink-Token': s.token } })).text();
    assert.match(page, /BrainLink Setup/, 'serves ui/index.html, not ui\/app\'s boot stub');
    assert.match(page, /id="sessions-panel"/);
    assert.match(page, /id="s-sync"/);
    assert.doesNotMatch(page, /brainlinkHost/, 'must not be ui/app\'s RPC bridge page');

    const st = await (await s.api('GET', '/api/state')).json();
    assert.deepEqual(st.vaults.map((v) => v.name), ['Acme Studio']);
    assert.deepEqual(st.agents.map((a) => a.name), ['Chief of Staff']);
    assert.ok(!st.config_path.startsWith(home), 'demo config must be isolated from the real BrainLink home');

    const sessions = await (await s.api('POST', '/api/sessions', {})).json();
    assert.deepEqual(sessions.sessions, []);
  } finally { s.stop(); }
});

test('`brainlink ui`: with no vaults configured yet, serves the v1.1 onboarding screen instead of failing', async () => {
  const home = await tmp('ui-cli-home');
  const s = await launch('ui', { ...process.env, BRAINLINK_HOME: home });
  try {
    const page = await (await fetch(s.base + `/?t=${s.token}`, { headers: { 'X-BrainLink-Token': s.token } })).text();
    assert.match(page, /BrainLink Setup/);
    const st = await (await s.api('GET', '/api/state')).json();
    assert.deepEqual(st.vaults, []);
  } finally { s.stop(); }
});

test('`brainlink ui`: the Terminal shows the URL with the token masked, not in full', async () => {
  const home = await tmp('ui-mask-home');
  const child = spawn(process.execPath, [CLI, 'ui', '--no-open'], { env: { ...process.env, BRAINLINK_HOME: home } });
  try {
    let buf = '';
    const line = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { buf += d; const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/); if (m) resolve(m[0]); });
      child.on('exit', (code) => reject(new Error(`exited ${code} before printing a URL: ${buf}`)));
      setTimeout(() => reject(new Error(`no URL after 5s: ${buf}`)), 5000);
    });
    assert.match(line, /\?t=.{1,4}…$/, `expected a masked token, got: ${line}`);
  } finally { child.kill(); }
});

test('P1e: "Done, close setup" never stops the background server', async () => {
  const home = await tmp('done-no-quit-home');
  const s = await launch('ui', { ...process.env, BRAINLINK_HOME: home });
  try {
    // There is no server-side quit route to call anymore.
    assert.equal((await s.api('POST', '/api/quit', {})).status, 404);
    // The server (and whatever background work it does, e.g. the shared-snapshot watcher) is
    // still up afterwards — proven by a normal call still succeeding.
    assert.equal((await s.api('GET', '/api/state')).status, 200);
    // The page's own Done handler must not call any quit-like endpoint either.
    const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
    const doneHandler = html.match(/\$\('done'\)\.onclick = .*?;(?=\r?\n)/s)[0];
    assert.doesNotMatch(doneHandler, /api\(['"]POST['"],\s*['"]\/api\/quit['"]/);
  } finally { s.stop(); }
});
