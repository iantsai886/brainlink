// Setup UI backend: a local-only web app (127.0.0.1, random session token) that picks the
// vault folder, applies a rule pack, connects AI clients and stores the licence key.
import { createServer } from 'node:http';
import { readFile, readdir, stat, cp, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, configPath, normalize } from './config.mjs';
import { verifyLicense, planFeatures, effectiveLicense, startTrial } from './license.mjs';
import { PACKS, buildPack, scaffold, mergePack } from './packs.mjs';
import { CLIENTS, detect, connectClient, disconnectClient, test } from './connectors.mjs';
import { createContext, search } from './core.mjs';
import { ROOT, launchSpec, readActivity, refreshMap } from './runtime.mjs';
import { detectEmbedder } from './embed.mjs';
import { vaultHealth } from './insights.mjs';
import { loadVault } from './core.mjs';
import { VERSION } from './server.mjs';
import { findObsidianVaults, nestedVaults } from './obsidian.mjs';
import { syncSettings, chooseSync, suggestFolders, PROVIDERS, PROVIDER_LABELS } from './sync/settings.mjs';

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

export function pickFolder(os = process.platform) {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? null : String(out).trim() || null);
    if (os === 'darwin') execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose your Obsidian / Markdown vault folder")'], done);
    else if (os === 'win32') execFile('powershell', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Choose your Obsidian / Markdown vault folder"; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }'], done);
    // Linux: GNOME's zenity, else KDE's kdialog; with neither, Setup asks for the path instead.
    else execFile('zenity', ['--file-selection', '--directory', '--title=Choose your Obsidian / Markdown vault folder'], (err, out) => {
      if (!err || err.code === 1) return done(err, out); // 1 = user cancelled
      execFile('kdialog', ['--getexistingdirectory', process.env.HOME || '/'], (e2, o2) => (e2 && e2.code !== 1 ? resolve(undefined) : done(e2, o2)));
    });
  });
}

async function countNotes(dir, n = 0, depth = 0) {
  if (depth > 12) return n;
  for (const f of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (f.name.startsWith('.') || f.name === 'node_modules') continue;
    if (f.isDirectory()) n = await countNotes(path.join(dir, f.name), n, depth + 1);
    else if (f.name.toLowerCase().endsWith('.md')) n++;
  }
  return n;
}

const mask = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-6)}` : null);

// opts: { env, home, os, port, pick, openUrl }
export async function startSetup(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homedir();
  const os = opts.os || process.platform;
  const file = configPath(env);
  const token = opts.token || randomBytes(18).toString('base64url');
  const pick = opts.pick || (() => pickFolder(os));
  const clientOpts = () => ({ home, os, env, launch: launchSpec(env), useCli: opts.useCli });
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  let port = opts.port ?? 0;
  // When started from the app (no terminal), exit after idleMinutes without requests or on Done.
  let idleTimer = null;
  const quit = () => setTimeout(() => (opts.onQuit ? opts.onQuit() : server.close()), 100);
  const touch = () => { if (!opts.idleMinutes) return; clearTimeout(idleTimer); idleTimer = setTimeout(quit, opts.idleMinutes * 60e3); idleTimer.unref?.(); };

  async function state() {
    const cfg = await loadConfig(file);
    const lic = effectiveLicense(cfg);
    const features = planFeatures(lic);
    const vaults = [];
    for (const v of cfg.vaults) {
      const ok = await stat(v.path).then((s) => s.isDirectory(), () => false);
      vaults.push({ ...v, exists: ok, notes: ok ? await countNotes(v.path) : 0 });
    }
    return {
      version: VERSION, config_path: file, os,
      license: { ...lic, key: mask(cfg.license), features: { ...features, maxVaults: String(features.maxVaults), maxConnections: String(features.maxConnections) } },
      vaults, agents: cfg.agents, handoff: cfg.handoff, timezone: cfg.timezone,
      packs: Object.entries(PACKS).map(([id, p]) => ({ id, title: p.title, description: p.description })),
      clients: await detect(clientOpts()),
      http: { port: cfg.http.port, token_set: Boolean(cfg.http.token) },
      activity: await readActivity(env, 15),
      semantic: await detectEmbedder(cfg, env),
      obsidian_vaults: (await findObsidianVaults({ home, os, env })).filter((o) => !cfg.vaults.some((v) => path.resolve(v.path) === path.resolve(o.path))),
      sync: { ...syncSettings(cfg), providers: PROVIDERS, provider_labels: PROVIDER_LABELS, suggested_folders: suggestFolders(home) },
    };
  }

  // Connect every AI app found on this computer that is not connected yet (within the plan).
  async function connectAll(cfg) {
    const features = planFeatures(effectiveLicense(cfg));
    const found = await detect(clientOpts());
    let count = Object.values(found).filter((c) => c.connected).length;
    const connected = [], skipped = [], failed = [];
    for (const [id, c] of Object.entries(found)) {
      if (!c.present || c.connected) continue;
      if (count >= features.maxConnections) { skipped.push(c.title); continue; }
      try { await connectClient(id, clientOpts()); connected.push(c.title); count++; } catch (e) { failed.push(`${c.title}: ${e.message}`); }
    }
    return { connected, skipped, failed, already: Object.values(found).filter((c) => c.connected).map((c) => c.title) };
  }

  // The one-click path: use an Obsidian vault, a folder, or a brand-new vault; then connect all AIs.
  async function quickStart(b) {
    const cfg = await loadConfig(file);
    let vaultPath;
    if (b.mode === 'new') {
      const docs = path.join(home, 'Documents');
      let n = 1;
      vaultPath = path.join(docs, 'My Brain');
      while (await stat(vaultPath).catch(() => null)) vaultPath = path.join(docs, `My Brain ${++n}`);
      await mkdir(vaultPath, { recursive: true });
      await writeFile(path.join(vaultPath, 'Welcome.md'), '# Welcome to your brain\n\nThis folder is your second brain. Every AI you connect can read it and add notes here.\n\nTry it: open Claude and say **"Connect to my brain"**. At the end of a chat, say **"Close loop"** to save what you decided.\n\nYou can open this folder in Obsidian (free) any time to read and edit your notes.\n', { flag: 'wx' });
    } else {
      vaultPath = path.resolve(String(b.path || '').replace(/^~(?=$|[\/\\])/, home));
      if (!(await stat(vaultPath).then((x) => x.isDirectory(), () => false))) return { ok: false, error: `Folder not found: ${vaultPath}` };
      const nested = await nestedVaults(vaultPath);
      if (nested.length > 1) return { ok: false, nested: nested.map((n) => ({ name: n, path: path.join(vaultPath, n) })), error: `This folder holds ${nested.length} separate vaults. Pick one so they stay separate.` };
    }
    const already = cfg.vaults.find((v) => path.resolve(v.path) === vaultPath);
    if (!already) {
      startTrial(cfg);
      const features = planFeatures(effectiveLicense(cfg));
      if (cfg.vaults.length >= features.maxVaults) return { ok: false, error: 'Your free plan has one vault. Remove it in Settings or add a licence key.' };
      let name = path.basename(vaultPath);
      while (cfg.vaults.some((v) => v.name === name)) name += ' 2';
      const agentName = cfg.agents.some((a) => a.name === 'Brain') ? name : 'Brain';
      const built = buildPack('simple', { vaultName: name, vaultPath, agentName });
      await scaffold(vaultPath, built.scaffold);
      const next = mergePack(cfg, built);
      next.timezone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
      await saveConfig(next, file);
      await refreshMap(next, name, env);
    }
    const saved = await loadConfig(file);
    const vault = saved.vaults.find((v) => path.resolve(v.path) === vaultPath);
    const agent = saved.agents.find((a) => a.vault === vault.name);
    return { ok: true, vault: vault.name, path: vault.path, phrase: agent?.activation[0], close: agent?.close[0], ...(await connectAll(saved)) };
  }

  const routes = {
    'GET /api/state': () => state(),
    'POST /api/quit': () => { quit(); return { ok: true }; },
    'POST /api/pick-folder': async () => { const p = await pick(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/quick': (b) => quickStart(b),
    'POST /api/graph': async (b) => {
      const cfg = await loadConfig(file);
      const name = b.vault || cfg.vaults[cfg.vaults.length - 1]?.name;
      if (!name) return { nodes: [], edges: [] };
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_VAULTS: name, BRAINLINK_SEMANTIC: '0' }, license: effectiveLicense(cfg) });
      const index = await loadVault(ctx, name);
      // Big vaults: show the 600 most-connected notes so the map stays readable.
      const deg = (i) => index.backlinks[i].size + index.outlinks[i].size;
      const keep = index.notes.map((n, i) => i).filter((i) => !index.notes[i].generated && !index.notes[i].minor && !index.notes[i].historical).sort((a, b) => deg(b) - deg(a)).slice(0, 600);
      const pos = new Map(keep.map((i, k) => [i, k]));
      const health = await vaultHealth(ctx, name);
      return {
        vault: name, shown: keep.length, health: { notes: health.notes, links: health.links, not_linked: health.orphan_count, broken: health.broken_count },
        nodes: keep.map((i) => ({ title: index.notes[i].title, group: index.notes[i].rel.includes('/') ? index.notes[i].rel.split('/')[0] : '', degree: index.backlinks[i].size + index.outlinks[i].size })),
        edges: index.edges.filter(([a, c]) => pos.has(a) && pos.has(c)).map(([a, c]) => [pos.get(a), pos.get(c)]),
      };
    },
    'POST /api/connect-all': async () => connectAll(await loadConfig(file)),
    'POST /api/vault': async (b) => {
      const cfg = await loadConfig(file);
      const features = planFeatures(effectiveLicense(cfg));
      const vaultPath = path.resolve(String(b.path || '').replace(/^~(?=$|[\/\\])/, home));
      if (!(await stat(vaultPath).then((s) => s.isDirectory(), () => false))) throw new Error(`Folder not found: ${vaultPath}`);
      const name = String(b.name || path.basename(vaultPath)).trim();
      if (!cfg.vaults.some((v) => v.name === name) && cfg.vaults.length >= features.maxVaults) throw new Error('The free plan supports one vault. Add a licence key to connect more.');
      const built = buildPack(b.pack || 'simple', { vaultName: name, vaultPath, agentName: String(b.agentName || '').trim() || undefined });
      const created = b.scaffold === false ? [] : await scaffold(vaultPath, built.scaffold);
      const next = mergePack(cfg, built);
      if (!next.timezone) next.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await saveConfig(next, file);
      await refreshMap(next, name, env);
      return { ok: true, vault: name, created };
    },
    'POST /api/vault/remove': async (b) => {
      const cfg = await loadConfig(file);
      const next = { ...cfg, vaults: cfg.vaults.filter((v) => v.name !== b.name), agents: cfg.agents.filter((a) => a.vault !== b.name), handoff: cfg.handoff?.vault === b.name ? null : cfg.handoff };
      await saveConfig(next, file);
      return { ok: true };
    },
    'POST /api/sync': async (b) => {
      // Local by default; Drive/iCloud/Dropbox need an existing, writable folder (the user's own
      // desktop client syncs it — no API, no credentials). validateSync (src/sync/settings.mjs)
      // rejects anything else.
      const cfg = await loadConfig(file);
      const next = chooseSync(cfg, { provider: b.provider, folder: b.folder, device: b.device });
      await saveConfig(next, file);
      return { ok: true, sync: syncSettings(next) };
    },
    'POST /api/agent': async (b) => {
      const cfg = await loadConfig(file);
      const a = cfg.agents.find((x) => x.name === b.name);
      if (!a) throw new Error(`Unknown agent ${b.name}`);
      const clean = (arr) => (Array.isArray(arr) ? arr : String(arr || '').split('\n')).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
      if (b.role !== undefined) a.role = String(b.role).slice(0, 600);
      if (b.activation !== undefined && clean(b.activation).length) a.activation = clean(b.activation);
      if (b.close !== undefined && clean(b.close).length) a.close = clean(b.close);
      if (b.capture_approved !== undefined) a.capture_approved = Boolean(b.capture_approved);
      await saveConfig(cfg, file);
      return { ok: true, agent: a };
    },
    'POST /api/connect': async (b) => {
      const cfg = await loadConfig(file);
      const features = planFeatures(effectiveLicense(cfg));
      const connected = Object.entries(await detect(clientOpts())).filter(([, c]) => c.connected).map(([id]) => id);
      if (!connected.includes(b.client) && connected.length >= features.maxConnections) throw new Error(`The free plan connects ${features.maxConnections} AI apps. Add a licence key to connect more.`);
      return connectClient(b.client, clientOpts());
    },
    'POST /api/disconnect': (b) => disconnectClient(b.client, clientOpts()),
    // Normalized {ok,message} check (connectors.mjs `test`): same detect() the buttons above
    // already use, re-shaped for callers that want one consistent result instead of each
    // function's own shape (see connectors.mjs for why /api/connect keeps its richer shape).
    'POST /api/client-test': (b) => test(b.client, clientOpts()),
    'POST /api/license': async (b) => {
      const key = String(b.key || '').trim();
      const lic = verifyLicense(key);
      if (key && !lic.valid) throw new Error(`Licence not accepted: ${lic.reason}`);
      const cfg = await loadConfig(file);
      await saveConfig({ ...cfg, license: key || null }, file);
      return { ok: true, license: { ...lic, key: mask(key) } };
    },
    'POST /api/http-token': async () => {
      const cfg = await loadConfig(file);
      if (!planFeatures(effectiveLicense(cfg)).http) throw new Error('HTTP clients need a licence key.');
      const t = randomBytes(24).toString('hex');
      await saveConfig({ ...cfg, http: { ...cfg.http, token: t } }, file);
      return { ok: true, url: `http://127.0.0.1:${cfg.http.port}/mcp`, token: t, start: 'brainlink serve --http' };
    },
    'POST /api/sample': async () => {
      const dest = path.join(home, 'Documents', 'BrainLink Sample Vault');
      if (!(await stat(dest).catch(() => null))) await cp(path.join(ROOT, 'samples', 'acme-studio'), dest, { recursive: true, errorOnExist: true, force: false });
      return { ok: true, path: dest };
    },
    'POST /api/test': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AI_PLATFORM: '' }, license: effectiveLicense(cfg) });
      if (!ctx.enabled.length) throw new Error('Add a vault first.');
      const v = b.vault && ctx.enabled.includes(b.vault) ? b.vault : ctx.enabled[0];
      return { vault: v, results: (await search(ctx, v, String(b.query || 'goal'), 5)).map((r) => ({ title: r.title, path: r.path, heading: r.heading, score: r.score })) };
    },
  };

  const server = createServer(async (req, res) => {
    // Only this machine, only our port: blocks DNS-rebinding and cross-site requests.
    const host = req.headers.host || '';
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, `http://${host}`);
    touch();
    if (url.pathname === '/health') { json(res, 200, { app: 'brainlink', version: VERSION }); return; }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:", 'X-Frame-Options': 'DENY' }).end(html);
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) { res.writeHead(404).end(); return; }
    const given = Buffer.from(String(req.headers['x-brainlink-token'] || ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) { json(res, 401, { error: 'Setup session expired. Reopen BrainLink.' }); return; }
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 1e5) { res.writeHead(413).end(); return; } }
      try { body = raw ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Bad JSON' }); return; }
    }
    try { json(res, 200, await route(body)); } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  port = server.address().port;
  touch();
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  if (opts.openUrl) opts.openUrl(url);
  return { server, url, port, token };
}

export function openInBrowser(url, os = process.platform) {
  if (os === 'darwin') execFile('open', [url]);
  else if (os === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else execFile('xdg-open', [url]);
}

export { CLIENTS };
