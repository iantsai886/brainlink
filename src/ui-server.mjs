// Serves the milestone UI (ui/app/*, untouched) over 127.0.0.1 with a per-launch token. The
// browser never touches the filesystem: a tiny generated boot script turns the real host object
// (src/host.mjs) into a fetch-backed `globalThis.brainlinkHost`, one JSON-RPC-ish call per method,
// then hands it to ui/app's own createApi()/startApp().
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './runtime.mjs';

const APP_DIR = path.join(ROOT, 'ui', 'app');
const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const noInject = (s) => s.replace(/<\/script/gi, '<\\/script');

function bootScript(vaults) {
  return `
const T = new URLSearchParams(location.search).get('t') || '';
async function rpc(target, method, args) {
  const r = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': T }, body: JSON.stringify({ target, method, args }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.code = j.code; throw e; }
  return j.result;
}
function proxy(name, overrides = {}) { return new Proxy({ ...overrides }, { get(t, prop) { return prop in t ? t[prop] : (...args) => rpc(name, prop, args); } }); }
const vaults = ${noInject(JSON.stringify(vaults))};
const store = proxy('store', { vaults: () => vaults });
const prefs = { get: (k) => rpc('prefs', 'get', [k]), set: (k, v) => rpc('prefs', 'set', [k, v]) };
const events = new EventSource('/api/events?t=' + encodeURIComponent(T));
const onVaultChange = (fn) => { events.addEventListener('vault-refresh', fn); return () => events.removeEventListener('vault-refresh', fn); };
globalThis.brainlinkHost = { store, services: { connectors: proxy('connectors'), settings: proxy('settings') }, access: { prefs, onVaultChange } };
import('/app/app.mjs').then(({ startApp }) => import('/app/lib/api.mjs').then(({ createApi }) => startApp(document.getElementById('app'), createApi(globalThis.brainlinkHost))));
`.trim();
}

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BrainLink</title><link rel="stylesheet" href="/app/styles.css"><div id="app">Loading BrainLink…</div><script type="module" src="/boot.js"></script></html>`;

async function readStatic(rel) {
  const ext = path.extname(rel);
  if (!TYPES[ext]) return null;
  const full = path.resolve(APP_DIR, '.' + rel);
  if (full !== APP_DIR && !full.startsWith(APP_DIR + path.sep)) return null; // no traversal out of ui/app
  try { return { body: await readFile(full), type: TYPES[ext] }; } catch { return null; }
}

// host: { store, services: { connectors, settings }, access }, built by src/host.mjs.
export async function serveUi({ host, port = 0, token, openUrl } = {}) {
  if (!host?.store) throw new Error('serveUi needs a host with a store');
  token = token || randomBytes(18).toString('base64url');
  const prefs = new Map(); // theme etc.; per-process only, not persisted across launches
  const targets = { store: host.store, connectors: host.services?.connectors || {}, settings: host.services?.settings || {},
    prefs: { async get(k) { return prefs.get(k); }, async set(k, v) { prefs.set(k, v); return true; } } };
  const eventClients = new Set();
  const watcher = host.store.watchFiles?.(() => {
    for (const res of eventClients) { try { res.write('event: vault-refresh\ndata: {}\n\n'); } catch { eventClients.delete(res); } }
  });

  const server = createServer(async (req, res) => {
    const host_ = req.headers.host || '';
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host_)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, `http://${host_}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'", 'X-Frame-Options': 'DENY' }).end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/boot.js') {
      const vaults = host.store.vaults();
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }).end(bootScript(vaults));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const given = Buffer.from(url.searchParams.get('t') || ''); const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n'); eventClients.add(res);
      res.on('close', () => eventClients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/app/')) {
      const file = await readStatic(url.pathname.slice('/app'.length));
      if (!file) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' }).end(file.body);
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/rpc') { res.writeHead(404).end(); return; }
    const given = Buffer.from(String(req.headers['x-brainlink-token'] || ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) { json(res, 401, { error: 'Session expired. Reopen BrainLink.' }); return; }
    let body = '';
    for await (const c of req) { body += c; if (body.length > 2e6) { res.writeHead(413).end(); return; } }
    let call;
    try { call = body ? JSON.parse(body) : {}; } catch { json(res, 400, { error: 'Bad JSON' }); return; }
    const target = targets[call.target];
    if (!target || typeof target[call.method] !== 'function') { json(res, 400, { error: `Unknown call ${call.target}.${call.method}` }); return; }
    try { json(res, 200, { result: await target[call.method](...(call.args || [])) }); }
    catch (e) { json(res, 400, { error: e.message || String(e), code: e.code }); }
  });
  server.on('close', () => { watcher?.stop(); for (const res of eventClients) res.end(); eventClients.clear(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  port = server.address().port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  if (openUrl) openUrl(url);
  return { server, url, port, token };
}
