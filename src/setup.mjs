// Setup UI backend: a local-only web app (127.0.0.1, random session token) that picks the
// vault folder, applies a rule pack and connects AI clients.
import { createServer } from 'node:http';
import { readFile, stat, cp, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, configPath, normalize, LOCALES, appHome } from './config.mjs';
import { PACKS, buildPack, scaffold, mergePack } from './packs.mjs';
import { CLIENTS, detect, connectClient, disconnectClient, test } from './connectors.mjs';
import { createContext, search, searchWithVerdict, readNote, ensureDefaultIgnore, readExcludedFolders, writeExcludedFolders, DEFAULT_EXCLUDED_FOLDERS, SUGGESTED_EXCLUDED_FOLDERS } from './core.mjs';
import { ROOT, launchSpec, readActivity, refreshMap, logActivity } from './runtime.mjs';
import { detectEmbedder } from './embed.mjs';
import { vaultHealth } from './insights.mjs';
import { loadVault } from './core.mjs';
import { resolveNoteWikilinks } from './links.mjs';
import { VERSION, createMcp } from './server.mjs';
import { findObsidianVaults, nestedVaults } from './obsidian.mjs';
import { syncSettings, chooseSync, suggestFolders, PROVIDERS, PROVIDER_LABELS } from './sync/settings.mjs';
import { sessionsService } from './host.mjs';
import { addAgent, renameAgent, removeAgent, revokeAgent, markConnected, findAgentByToken, publicAgent, localAgentSnippet, remoteAgentSnippet } from './mcp-agents.mjs';
import { buildGraph3D, noteDetail3D } from './graph3d.mjs';
import { snapshotSettings, chooseSnapshot, suggestSnapshotFolder, clearSnapshot, startSnapshotWatcher, writeSnapshotOnce, loadSnapshotStatus, saveSnapshotStatus } from './snapshot.mjs';
import { listHandoffs } from './writes.mjs';

const UI_STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const UI_DIR = path.join(ROOT, 'ui');

// A small whitelist of ui/* assets this server will hand out with no session token (same trust
// level as index.html itself: static code and styles, never vault content or secrets).
async function readUiStatic(rel) {
  const ext = path.extname(rel);
  if (!UI_STATIC_TYPES[ext] || rel === 'index.html') return null;
  const full = path.resolve(UI_DIR, '.' + rel);
  if (full !== UI_DIR && !full.startsWith(UI_DIR + path.sep)) return null; // no traversal out of ui/
  try { return { body: await readFile(full), type: UI_STATIC_TYPES[ext] }; } catch { return null; }
}

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const LOCALES_DIR = path.join(ROOT, 'ui', 'locales');

export function pickFolder(os = process.platform, prompt = 'Choose your Obsidian / Markdown vault folder') {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? null : String(out).trim() || null);
    if (os === 'darwin') execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${prompt.replace(/"/g, "'")}")`], done);
    else if (os === 'win32') execFile('powershell', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "${prompt.replace(/"/g, "'")}"; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }`], done);
    // Linux: GNOME's zenity, else KDE's kdialog; with neither, Setup asks for the path instead.
    else execFile('zenity', ['--file-selection', '--directory', `--title=${prompt}`], (err, out) => {
      if (!err || err.code === 1) return done(err, out); // 1 = user cancelled
      execFile('kdialog', ['--getexistingdirectory', process.env.HOME || '/'], (e2, o2) => (e2 && e2.code !== 1 ? resolve(undefined) : done(e2, o2)));
    });
  });
}

// P1a: the vault card's note count must count only what the user/AI can actually see -- the same
// definition vaultHealth/the Brain map stats use (excludes private notes, generated notes, and
// anything under an excluded folder, which never even reaches the index). A raw recursive .md
// file count here previously disagreed with that visible count (e.g. showing 8 when only 2 notes
// were actually visible), which is confusing on its own and actively misleading once some of the
// difference is private content.
async function visibleNoteCount(ctx, vaultName) {
  const index = await loadVault(ctx, vaultName);
  return index.notes.filter((n) => !n.generated && !n.private).length;
}

// A search snippet is raw note text (headings, **bold**, `code`); strip the Markdown so the
// instant answer reads as prose instead of exposing the source's formatting.
const plainText = (s) => String(s || '').replace(/^#+\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();

// opts: { env, home, os, port, pick, openUrl }
export async function startSetup(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homedir();
  const os = opts.os || process.platform;
  const file = configPath(env);
  const token = opts.token || randomBytes(18).toString('base64url');
  const pick = opts.pick || (() => pickFolder(os));
  const pickSnapshotFolder = opts.pickSnapshotFolder || (() => pickFolder(os, 'Choose a folder to share a read-only copy with cloud agents'));
  const clientOpts = () => ({ home, os, env, launch: launchSpec(env), useCli: opts.useCli });
  const sessions = sessionsService(env); // src/host.mjs: cross-session reads over src/sessions/* (importAll, session_list/read semantics)
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  let port = opts.port ?? 0;
  // When started from the app (no terminal), exit after idleMinutes without requests. Closing
  // the Done button in the browser only hides that tab's view (see ui/index.html) — it must
  // never stop this background process, so idle timeout is the only thing that quits it here.
  let idleTimer = null;
  const quit = () => setTimeout(() => { snapshotWatcher?.stop(); (opts.onQuit ? opts.onQuit() : server.close()); }, 100);
  const touch = () => { if (!opts.idleMinutes) return; clearTimeout(idleTimer); idleTimer = setTimeout(quit, opts.idleMinutes * 60e3); idleTimer.unref?.(); };

  // Shared snapshot (Ian's RB8): runs for as long as this Setup process is open. Restarted
  // whenever the setting changes so a just-picked folder, or turning it off, takes effect at once.
  const snapshotStateFile = path.join(appHome(env), 'snapshot-state.json');
  let snapshotWatcher = null;
  async function refreshSnapshotWatcher(cfg) {
    snapshotWatcher?.stop();
    snapshotWatcher = null;
    const settings = snapshotSettings(cfg);
    if (!settings.enabled) return;
    const ctx = createContext(cfg, { env });
    if (!ctx.enabled.length) {
      // No vault left to watch (e.g. the last one was just removed) — still run one write so a
      // previously-synced snapshot's note copies are cleared from the destination folder, not
      // left there indefinitely with nothing left enabled to ever clean them up again.
      const result = await writeSnapshotOnce(ctx, cfg, env).catch((e) => ({ ok: false, error: e.message || String(e) }));
      await saveSnapshotStatus(snapshotStateFile, result.ok ? result : { ok: false, error: result.error || 'Add a folder first, then turn sharing on.' });
      return;
    }
    snapshotWatcher = startSnapshotWatcher(ctx, cfg, env, { onResult: (r) => saveSnapshotStatus(snapshotStateFile, r).catch(() => {}) });
    await snapshotWatcher.ready;
  }
  refreshSnapshotWatcher(await loadConfig(file)).catch(() => {});

  async function state() {
    const cfg = await loadConfig(file);
    const ctx = createContext(cfg, { env });
    const vaults = [];
    for (const v of cfg.vaults) {
      const ok = await stat(v.path).then((s) => s.isDirectory(), () => false);
      const excluded = ok ? await readExcludedFolders(v.path) : { active: [], suggested: [] };
      vaults.push({ ...v, exists: ok, notes: ok ? await visibleNoteCount(ctx, v.name) : 0, excluded_folders: excluded.active, excluded_suggestions: excluded.suggested });
    }
    return {
      version: VERSION, config_path: file, os, locale: cfg.locale,
      default_excluded_folders: DEFAULT_EXCLUDED_FOLDERS, suggested_excluded_folders: SUGGESTED_EXCLUDED_FOLDERS,
      vaults, agents: cfg.agents, ai_agents: cfg.ai_agents.map(publicAgent), handoff: cfg.handoff, timezone: cfg.timezone,
      packs: Object.entries(PACKS).map(([id, p]) => ({ id, title: p.title, description: p.description })),
      clients: await detect(clientOpts()),
      http: { port: cfg.http.port, token_set: Boolean(cfg.http.token) },
      activity: await readActivity(env, 15),
      semantic: await detectEmbedder(cfg, env),
      obsidian_vaults: (await findObsidianVaults({ home, os, env })).filter((o) => !cfg.vaults.some((v) => path.resolve(v.path) === path.resolve(o.path))),
      sync: { ...syncSettings(cfg), providers: PROVIDERS, provider_labels: PROVIDER_LABELS, suggested_folders: suggestFolders(home) },
      sessions_sharing: cfg.sessions,
      // P1a: imported sessions default to private, and a private session is invisible to every
      // connected AI while sessions.shareSummaries is off -- regardless of the "Show private
      // sessions" checkbox below, which only controls what this local Setup UI displays. Peeking
      // at a small page is enough to know "at least one exists"; the UI doesn't need the full list.
      sessions_has_private: ((await sessions.list({ include_private: true, limit: 20 }).catch(() => ({ sessions: [] }))).sessions || []).some((x) => x.private),
      snapshot: { ...snapshotSettings(cfg), suggested_folder: suggestSnapshotFolder(home), ...(await loadSnapshotStatus(snapshotStateFile)) },
    };
  }

  // Connect every AI app found on this computer that is not connected yet (within the plan).
  // connectClient already refuses apps it did not detect; a live handshake (clientHealthCheck)
  // confirms the write actually works before it is reported as connected, and is undone otherwise.
  async function connectAll(cfg) {
    const found = await detect(clientOpts());
    const connected = [], skipped = [], failed = [];
    for (const [id, c] of Object.entries(found)) {
      if (!c.present || c.connected) continue;
      try {
        await connectClient(id, clientOpts());
        const health = await clientHealthCheck(id).catch((e) => ({ ok: false, message: e.message || String(e) }));
        if (!health.ok) { await disconnectClient(id, clientOpts()).catch(() => {}); throw new Error(health.message); }
        connected.push(c.title);
      } catch (e) { failed.push(`${c.title}: ${e.message}`); }
    }
    return { connected, skipped, failed, already: Object.values(found).filter((c) => c.connected).map((c) => c.title) };
  }

  // Live proof a just-connected client actually works: an in-process MCP round trip through the
  // exact same createMcp() a real `brainlink serve` process would run, using that client's own
  // platform/role env so the call looks identical to one the client would make. Logs through the
  // normal activity log (content-free: tool name + ok/fail only) so it shows up in the call log too.
  async function clientHealthCheck(clientId) {
    const c = CLIENTS[clientId];
    if (!c) throw new Error(`Unknown client "${clientId}".`);
    const cfg = await loadConfig(file);
    const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AI_PLATFORM: c.platform, BRAINLINK_AGENT_ROLE: c.role } });
    if (!ctx.enabled.length) return { ok: false, client: clientId, tool: null, took_ms: 0, message: 'Add a vault first, then test the connection.' };
    const pending = [];
    const mcp = createMcp(ctx, { onCall: (e) => pending.push(logActivity(env, { ...e, platform: c.platform, mode: 'health-check' })) });
    const t0 = Date.now();
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const called = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
    await Promise.all(pending);
    const took_ms = Date.now() - t0;
    const ok = Boolean(called?.result) && !called.result.isError;
    return { ok, client: clientId, tool: 'brainlink_guide', took_ms, message: ok ? `Live MCP call succeeded: brainlink_guide (${took_ms}ms).` : 'The MCP call failed; see Activity below.' };
  }

  // Same live-proof pattern as clientHealthCheck, keyed by an agent's own token instead of a
  // preset app's env. Agents start out not connected; this is the only path that flips one to
  // connected, and only once the round trip actually succeeds with that exact token.
  async function agentHealthCheck(token) {
    const cfg = await loadConfig(file);
    const agent = findAgentByToken(cfg, token);
    if (!agent) return { ok: false, agent: null, tool: null, took_ms: 0, message: 'That key was not recognized. It may have been revoked or mistyped.' };
    const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: token } });
    if (!ctx.enabled.length) return { ok: false, agent: agent.name, tool: null, took_ms: 0, message: 'Add a vault first, then test the connection.' };
    const pending = [];
    const mcp = createMcp(ctx, { onCall: (e) => pending.push(logActivity(env, { ...e, platform: agent.name, mode: 'agent-check' })) });
    const t0 = Date.now();
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const called = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
    await Promise.all(pending);
    const took_ms = Date.now() - t0;
    const ok = Boolean(called?.result) && !called.result.isError;
    if (ok) await saveConfig(markConnected(cfg, agent.id), file);
    return { ok, agent: agent.name, tool: 'brainlink_guide', took_ms, message: ok ? `Live call succeeded (${took_ms}ms). This agent is now connected.` : 'The call failed; see Activity below.' };
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
      // A real, already-existing folder: ship the default excluded-folder list so personal/system
      // folders never reach search, answers, graph, sessions or sync. Never overrides a vault's
      // own .brainlinkignore if it already has one.
      await ensureDefaultIgnore(vaultPath);
    }
    const already = cfg.vaults.find((v) => path.resolve(v.path) === vaultPath);
    if (!already) {
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
    'POST /api/pick-folder': async () => { const p = await pick(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/quick': (b) => quickStart(b),
    'POST /api/graph': async (b) => {
      const cfg = await loadConfig(file);
      const name = b.vault || cfg.vaults[cfg.vaults.length - 1]?.name;
      if (!name) return { nodes: [], edges: [] };
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_VAULTS: name, BRAINLINK_SEMANTIC: '0' } });
      const index = await loadVault(ctx, name);
      // Big vaults: show the 600 most-connected notes so the map stays readable.
      const deg = (i) => index.backlinks[i].size + index.outlinks[i].size;
      const keep = index.notes.map((n, i) => i).filter((i) => !index.notes[i].generated && !index.notes[i].minor && !index.notes[i].historical && !index.notes[i].private).sort((a, b) => deg(b) - deg(a)).slice(0, 600);
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
      const vaultPath = path.resolve(String(b.path || '').replace(/^~(?=$|[\/\\])/, home));
      if (!(await stat(vaultPath).then((s) => s.isDirectory(), () => false))) throw new Error(`Folder not found: ${vaultPath}`);
      const name = String(b.name || path.basename(vaultPath)).trim();
      // A real vault folder: write the shipped default excluded-folder list (unless the caller
      // already chose one, e.g. from the "connect a vault" form), or keep an existing one as-is.
      if (Array.isArray(b.excludedFolders)) await writeExcludedFolders(vaultPath, b.excludedFolders);
      else await ensureDefaultIgnore(vaultPath);
      const built = buildPack(b.pack || 'simple', { vaultName: name, vaultPath, agentName: String(b.agentName || '').trim() || undefined });
      if (b.private !== undefined) built.vault.private = Boolean(b.private);
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
      // S5: the snapshot watcher was started from whatever vault list existed at launch (or the
      // last /api/snapshot call) and otherwise runs for the life of this process — removing a
      // vault here must stop it from still syncing a now-gone folder until next restart.
      await refreshSnapshotWatcher(next);
      return { ok: true };
    },
    // Excluded folders and the private flag stay editable after connecting, not just at
    // first-connect time (Technical Reviewer's Mac-zip safety review).
    'POST /api/vault/excluded': async (b) => {
      const cfg = await loadConfig(file);
      const v = cfg.vaults.find((x) => x.name === b.name);
      if (!v) throw new Error(`Unknown vault "${b.name}".`);
      const folders = Array.isArray(b.folders) ? b.folders : String(b.folders || '').split(/\r?\n/);
      const active = await writeExcludedFolders(v.path, folders);
      return { ok: true, excluded_folders: active };
    },
    'POST /api/vault/private': async (b) => {
      const cfg = await loadConfig(file);
      const v = cfg.vaults.find((x) => x.name === b.name);
      if (!v) throw new Error(`Unknown vault "${b.name}".`);
      v.private = Boolean(b.private);
      await saveConfig(cfg, file);
      // S5: a vault just marked private must stop being watched/synced into the shared snapshot
      // right away, not only after the app restarts (startSnapshotWatcher already skips private
      // vault roots — see src/snapshot.mjs — but only when it starts watching).
      await refreshSnapshotWatcher(cfg);
      return { ok: true, private: v.private };
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
      // connectClient refuses undetected apps. A write with no verified handshake is not a real
      // connection, so an unhealthy check undoes the write instead of reporting Connected.
      const r = await connectClient(b.client, clientOpts());
      const health = await clientHealthCheck(b.client).catch((e) => ({ ok: false, client: b.client, tool: null, took_ms: 0, message: e.message || String(e) }));
      if (!health.ok) { await disconnectClient(b.client, clientOpts()).catch(() => {}); throw new Error(`Could not verify ${r.title}: ${health.message}`); }
      return { ...r, health };
    },
    'POST /api/client-health': (b) => clientHealthCheck(b.client),
    'POST /api/disconnect': (b) => disconnectClient(b.client, clientOpts()),
    // Normalized {ok,message} check (connectors.mjs `test`): same detect() the buttons above
    // already use, re-shaped for callers that want one consistent result instead of each
    // function's own shape (see connectors.mjs for why /api/connect keeps its richer shape).
    'POST /api/client-test': (b) => test(b.client, clientOpts()),
    'POST /api/locale': async (b) => {
      const locale = String(b.locale || '').trim();
      if (!LOCALES.includes(locale)) throw new Error(`Unknown locale "${locale}".`);
      const cfg = await loadConfig(file);
      await saveConfig({ ...cfg, locale }, file);
      return { ok: true, locale };
    },
    'POST /api/http-token': async () => {
      const cfg = await loadConfig(file);
      const t = randomBytes(24).toString('hex');
      await saveConfig({ ...cfg, http: { ...cfg.http, token: t } }, file);
      return { ok: true, url: `http://127.0.0.1:${cfg.http.port}/mcp`, token: t, start: 'brainlink serve --http' };
    },
    // ---- Agents: any number of user-added AI connections, on top of the preset apps above ----
    'POST /api/agents/add': async (b) => {
      const cfg = await loadConfig(file);
      const { cfg: next, agent, token } = addAgent(cfg, { name: b.name, kind: b.kind });
      await saveConfig(next, file);
      const snippet = agent.kind === 'remote' ? remoteAgentSnippet(agent, token, cfg.http.port) : localAgentSnippet(agent, token, launchSpec(env));
      return { ok: true, agent: publicAgent(agent), token, snippet };
    },
    'POST /api/agents/rename': async (b) => {
      const cfg = await loadConfig(file);
      const next = renameAgent(cfg, b.id, b.name);
      await saveConfig(next, file);
      return { ok: true, agent: publicAgent(next.ai_agents.find((a) => a.id === b.id)) };
    },
    'POST /api/agents/remove': async (b) => {
      const cfg = await loadConfig(file);
      await saveConfig(removeAgent(cfg, b.id), file);
      return { ok: true };
    },
    'POST /api/agents/revoke': async (b) => {
      const cfg = await loadConfig(file);
      const next = revokeAgent(cfg, b.id);
      await saveConfig(next, file);
      return { ok: true, agent: publicAgent(next.ai_agents.find((a) => a.id === b.id)) };
    },
    // Runs the same live round trip as /api/client-health, keyed by the agent's own key instead
    // of a preset app's env; the only path that marks an agent Connected.
    'POST /api/agents/test': (b) => agentHealthCheck(String(b.token || '')),
    // ---- 3D notes graph: nodes/edges plus one note's panel (Markdown, tags, links) ----
    'POST /api/graph3d': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_SEMANTIC: '0' } });
      if (!ctx.enabled.length) return { nodes: [], links: [], shown: 0, total: 0 };
      return buildGraph3D(ctx, b.vault && ctx.enabled.includes(b.vault) ? b.vault : undefined);
    },
    'POST /api/graph3d/note': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_SEMANTIC: '0' } });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      return noteDetail3D(ctx, b.vault, String(b.path || ''));
    },
    'POST /api/sample': async () => {
      const dest = path.join(home, 'Documents', 'BrainLink Sample Vault');
      if (!(await stat(dest).catch(() => null))) await cp(path.join(ROOT, 'samples', 'acme-studio'), dest, { recursive: true, errorOnExist: true, force: false });
      return { ok: true, path: dest };
    },
    'POST /api/sessions': (b) => sessions.list({ q: b.q, client: b.client, project: b.project, since: b.since, limit: b.limit, include_private: Boolean(b.include_private) }),
    'POST /api/sessions/read': (b) => sessions.read({ id: b.id, include_private: Boolean(b.include_private) }),
    'POST /api/sessions/private': (b) => sessions.setPrivate(b.id, b.private),
    // What connected AI apps (not this local UI) may see of imported/logged sessions. The user's
    // own choice; session_list/session_read in src/server.mjs always read this, never a caller flag.
    'POST /api/sessions/sharing': async (b) => {
      const cfg = await loadConfig(file);
      const shareSummaries = typeof b.shareSummaries === 'boolean' ? b.shareSummaries : cfg.sessions.shareSummaries;
      const shareFullText = typeof b.shareFullText === 'boolean' ? b.shareFullText : cfg.sessions.shareFullText;
      const next = { ...cfg, sessions: { shareSummaries, shareFullText: shareSummaries && shareFullText } };
      await saveConfig(next, file);
      return { ok: true, sessions: next.sessions };
    },
    // P0: two-AI handoff receipt -- who handed off, who picked it up (if anyone yet), and when.
    // listHandoffs() already drops anything under an excluded ("00 Home"-style) folder or marked
    // private, so this never has to re-check that itself; it only has to pair each handoff with
    // the later handoff (if any) that acks it via `ack_of` to know whether it was picked up.
    'POST /api/handoffs': async (b) => {
      const cfg = await loadConfig(file);
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_SEMANTIC: '0' } });
      if (!cfg.handoff || !ctx.enabled.includes(cfg.handoff.vault)) return { enabled: false, receipts: [] };
      const list = await listHandoffs(ctx, { limit: b.limit || 30 });
      const ackByTarget = new Map(list.filter((x) => x.ack_of).map((a) => [a.ack_of, a]));
      const receipts = list.filter((x) => !x.ack_of).map((x) => {
        const ack = ackByTarget.get(x.path);
        return {
          from: x.from, to: x.to, subject: x.subject, sent_at: x.sent_at, status: x.status, priority: x.priority,
          picked_up: Boolean(ack), picked_up_by: ack ? ack.from : null, picked_up_at: ack ? ack.sent_at : null,
        };
      });
      return { enabled: true, receipts };
    },
    // ---- Shared snapshot: a read-only copy of the notes for cloud agents (Ian's RB8) ----
    'POST /api/snapshot/pick-folder': async () => { const p = await pickSnapshotFolder(); return p === undefined ? { path: null, unavailable: true } : { path: p }; },
    'POST /api/snapshot': async (b) => {
      const cfg = await loadConfig(file);
      const next = chooseSnapshot(cfg, { enabled: b.enabled, folder: b.folder, includeSessions: b.includeSessions });
      await saveConfig(next, file);
      // Writes once immediately on enabling (or on any change), not just on the next interval or
      // vault edit, and picks up errors (e.g. the folder disappeared) right away.
      await refreshSnapshotWatcher(next);
      const status = await loadSnapshotStatus(snapshotStateFile);
      return { ok: true, snapshot: { ...snapshotSettings(next), suggested_folder: suggestSnapshotFolder(home), ...status } };
    },
    // F2 recovery: force=true is the "Clear and re-share" action -- a full reset of the
    // dedicated subfolder when the manifest was lost, not the normal "Stop sharing" toggle-off.
    'POST /api/snapshot/clear': async (b) => {
      const cfg = await loadConfig(file);
      const result = await clearSnapshot(snapshotSettings(cfg).folder, env, cfg.vaults, { force: Boolean(b?.force) });
      if (b?.force) await refreshSnapshotWatcher(cfg);
      return result;
    },
    'POST /api/test': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AI_PLATFORM: '' } });
      if (!ctx.enabled.length) throw new Error('Add a vault first.');
      const v = b.vault && ctx.enabled.includes(b.vault) ? b.vault : ctx.enabled[0];
      return { vault: v, results: (await search(ctx, v, String(b.query || 'goal'), 5)).map((r) => ({ title: r.title, path: r.path, heading: r.heading, score: r.score })) };
    },
    // Cited instant answer: the same ranked search + status verdict the vault_search MCP tool uses,
    // reshaped for a one-paragraph answer with clickable source chips (/api/note opens each one).
    'POST /api/ask': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AI_PLATFORM: '' } });
      if (!ctx.enabled.length) throw new Error('Add a vault first.');
      const query = String(b.query || '').trim();
      if (!query) throw new Error('Ask a question first.');
      const v = b.vault && ctx.enabled.includes(b.vault) ? b.vault : ctx.enabled[0];
      const r = await searchWithVerdict(ctx, v, query, { limit: 5 });
      const top = r.results.slice(0, 3);
      const answer = r.status === 'not_in_brain' ? null : plainText(top[0]?.snippet) || null;
      return {
        vault: v, query, status: r.status, coverage: r.coverage, note: r.note || null, answer,
        sources: top.map((x) => ({ vault: v, path: x.path, title: x.title, heading: x.heading || '', score: x.score })),
      };
    },
    // Opens one of the answer's source chips (or a citation modal's own wikilink): full
    // frontmatter + body, read-only, plus each [[wikilink]] in the body already resolved (or not)
    // against this vault's privacy-filtered index — P1b: the modal renders formatted text and
    // real links, and a dead/private target must never be distinguishable from the other.
    'POST /api/note': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = createContext(cfg, { env: { ...env, BRAINLINK_AI_PLATFORM: '' } });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const note = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      return { vault: b.vault, ...note, wikilinks: resolveNoteWikilinks(index, note.body) };
    },
  };

  const server = createServer(async (req, res) => {
    // Only this machine, only our port: blocks DNS-rebinding and cross-site requests.
    const host = req.headers.host || '';
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, `http://${host}`);
    touch();
    if (url.pathname === '/health') { json(res, 200, { app: 'brainlink', version: VERSION }); return; }
    if (req.method === 'GET' && /^\/locales\/[A-Za-z-]+\.json$/.test(url.pathname)) {
      const lang = url.pathname.slice('/locales/'.length, -'.json'.length);
      if (!LOCALES.includes(lang)) { res.writeHead(404).end(); return; }
      try {
        const body = await readFile(path.join(LOCALES_DIR, `${lang}.json`), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
      } catch { res.writeHead(404).end(); }
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:", 'X-Frame-Options': 'DENY' }).end(html);
      return;
    }
    // Static code/styles for the Agents and 3D graph panels (ui/agents.js, ui/notes3d.js, their
    // CSS and vendored libraries): same trust level as index.html, no session token needed.
    if (req.method === 'GET') {
      const file = await readUiStatic(url.pathname);
      if (file) { res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' }).end(file.body); return; }
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
  server.once('close', () => snapshotWatcher?.stop());
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
