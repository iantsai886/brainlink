#!/usr/bin/env node
// BrainLink command line. AI clients launch `brainlink serve`; people use `brainlink setup`.
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { stat, readFile, writeFile, mkdir, cp, mkdtemp, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, configPath, appHome, emptyConfig, normalize } from '../src/config.mjs';
import { markConnected } from '../src/mcp-agents.mjs';
import { buildPack, scaffold, mergePack, PACKS } from '../src/packs.mjs';
import { CLIENTS, detect, connectClient, disconnectClient } from '../src/connectors.mjs';
import { createMcp, serveStdio, serveHttp, VERSION } from '../src/server.mjs';
import { openContext, launchSpec, logActivity, refreshMap, ROOT } from '../src/runtime.mjs';
import { readGitSourceState } from '../src/git-source-state.mjs';
import { createContext, warmSemantic } from '../src/core.mjs';
import { brief } from '../src/insights.mjs';
import { startSetup, openInBrowser, openInAppWindow } from '../src/setup.mjs';
import { runSync } from '../src/sync-cli.mjs';
import { PROVIDER_LABELS } from '../src/sync/settings.mjs';
import { importAll } from '../src/sessions/index.mjs';
import { recordSessionEndCue, listSessionEndCues } from '../src/sessions/end-cue.mjs';
import { setSessionHook } from '../src/sessions/hooks.mjs';
import { evaluateRetrieval, RETRIEVAL_EVALUATOR_VERSION } from '../src/retrieval-eval.mjs';
import { createRsiWeekly, taipeiWeek } from '../src/rsi-weekly.mjs';
import { evaluateSessionFiling } from '../src/sessions/filing-eval.mjs';
import { evaluateTypedGraphDiscovery, TYPED_GRAPH_EVALUATOR_VERSION } from '../src/typed-graph-eval.mjs';

// `brainlink brief | head` closes the pipe early: exit quietly instead of crashing.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i === -1 || argv[i + 1]?.startsWith('--') ? dflt : argv[i + 1] ?? dflt; };
const out = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stderr.write(`brainlink: ${s}\n`); process.exit(1); };
const gitClean = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore' });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error('git status check failed');
  return result.status === 0;
};
// The Setup/UI URL carries a bearer-style session token (?t=...). The browser gets the real
// link (openInBrowser below uses the unmasked url); anything printed to the Terminal — which can
// end up in screen recordings, shared terminals or scrollback — shows only the first few chars.
// BRAINLINK_SHOW_TOKEN is for test/debug harnesses that need the real value; it is not documented
// for end users and masking stays the default.
const maskUrl = (url) => (process.env.BRAINLINK_SHOW_TOKEN ? url : url.replace(/([?&]t=)([^&\s]+)/, (_, p, t) => `${p}${t.slice(0, 4)}…`));
const SETUP_PORT = 47800;
async function setupToken(env = process.env) {
  const file = path.join(appHome(env), 'setup-token');
  try { const t = (await readFile(file, 'utf8')).trim(); if (t.length >= 20) return t; } catch {}
  const t = randomBytes(18).toString('base64url');
  await mkdir(appHome(), { recursive: true });
  await writeFile(file, t, { mode: 0o600 });
  return t;
}
const setupInstancePath = (env = process.env) => path.join(appHome(env), 'setup-instance.json');
async function readSetupInstance(env) {
  try {
    const value = JSON.parse(await readFile(setupInstancePath(env), 'utf8'));
    return Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 ? value : null;
  } catch { return null; }
}
async function writeSetupInstance(env, port) {
  const file = setupInstancePath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ port, pid: process.pid, version: VERSION }), { mode: 0o600 });
  await rename(tmp, file);
}
async function removeSetupInstance(env, port) {
  const file = setupInstancePath(env);
  try {
    const value = await readSetupInstance(env);
    if (value?.port === port) await unlink(file);
  } catch {}
}
const clientOpts = () => ({ home: process.env.HOME || homedir(), os: process.platform, env: process.env, launch: launchSpec() });

const HELP = `BrainLink MCP ${VERSION} — one Markdown brain for every AI

  brainlink setup [--no-open]          open the Setup app (pick vault, connect AIs)
  brainlink init --vault PATH [--name N] [--pack ${Object.keys(PACKS).join('|')}] [--agent NAME] [--no-scaffold]
  brainlink connect <client|all>       ${Object.keys(CLIENTS).join(', ')} (or --all)
  brainlink disconnect <client>        (disconnect-all removes it from every app)
  brainlink clients                    show detected / configured AI apps
  brainlink status                     config, vaults, timezone
  brainlink brief [--vault V] [--days 7]  what changed and what is open
  brainlink miss add --profile NAME --agent NAME --question TEXT --result found|not_found|stale --seconds N --fix-needed TYPE [--date ISO]
  brainlink miss import --file FILE | miss list --profile NAME [--week YYYY-Www]
  brainlink bench run --fixture FILE [--vault-root DIR --vault-name NAME] [--week YYYY-Www]
  brainlink bench report [--weeks N]
  brainlink eval --fixture FILE [--vault-root DIR --vault-name NAME]  compare labelled retrieval (read-only)
  brainlink eval-filing --fixture FILE evaluate session folder suggestions (read-only)
  brainlink eval-graph --fixture FILE evaluate typed relationship proposals (read-only)
  brainlink map                        rebuild each vault's Home map
  brainlink sync                       one sync pass (local by default; set up in Setup)
  brainlink session-end-cue --client claude-code|codex|hermes  record a local, metadata-only end cue from stdin
  brainlink session-end-cues            list local end cues (no transcripts are read)
  brainlink ui [--no-open] [--port N]  open the milestone UI (notes, search, graph) on your vaults
  brainlink demo [--no-open]           try the UI on a throwaway sample vault; touches nothing real
  brainlink serve                      MCP over stdio (what AI apps run)
  brainlink serve --http [PORT]        MCP over local HTTP (bearer token from Setup)

Config: ${configPath()}`;

async function main() {
  switch (cmd) {
    case 'serve': {
      const { ctx, cfg } = await openContext();
      importAll({ env: ctx.env }).catch(() => {}); // keep the local session index warm at server start; cheap and incremental after the first run
      const mcp = createMcp(ctx, { onCall: (e) => {
        logActivity(process.env, { ...e, platform: ctx.platform || 'unknown', mode: flag('http') ? 'http' : 'stdio' });
        // Connected only after a verified call that used that agent's token — same rule as the
        // Connect buttons (clientHealthCheck in src/setup.mjs). Written once, not on every call.
        if (ctx.mcpAgent && e.ok && !ctx.mcpAgent.connected) {
          ctx.mcpAgent.connected = true; // avoid re-saving on every subsequent call this process makes
          loadConfig().then((c) => saveConfig(markConnected(c, ctx.mcpAgent.id))).catch(() => {});
        }
      } });
      if (flag('http')) {
        const port = Number(opt('http', cfg.http.port)) || cfg.http.port;
        const token = process.env.BRAINLINK_MCP_TOKEN || cfg.http.token;
        await serveHttp(mcp, port, token);
        process.stderr.write(`BrainLink ${VERSION}: http://127.0.0.1:${port}/mcp (vaults: ${ctx.enabled.join(', ')})\n`);
      } else serveStdio(mcp);
      // Fill the meaning-based search cache in the background (no-op without a local model).
      setTimeout(async () => { for (const v of ctx.enabled) { try { await warmSemantic(ctx, v); } catch {} } }, 1500).unref();
      return;
    }
    case 'setup': {
      // Same address every time (fixed port + saved token), so a bookmark or old tab works again
      // once BrainLink is reopened. If Setup is already running, just bring it to the front.
      const fromApp = flag('app');
      const preferredPort = Number(opt('port', SETUP_PORT)) || SETUP_PORT;
      const token = await setupToken(process.env);
      const instance = await readSetupInstance(process.env);
      let port = instance?.port || preferredPort;
      const running = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json(), () => null);
      if (running?.app === 'brainlink') {
        const url = `http://127.0.0.1:${port}/?t=${token}`;
        if (!flag('no-open')) (fromApp ? openInAppWindow : openInBrowser)(url);
        out(`BrainLink Setup: ${maskUrl(url)}`);
        return;
      }
      if (instance) await removeSetupInstance(process.env, instance.port);
      const openSetup = fromApp ? openInAppWindow : openInBrowser;
      const opts = { token, openUrl: flag('no-open') ? null : (u) => openSetup(u), idleMinutes: fromApp ? 30 : 0, onQuit: () => process.exit(0) };
      const s = await startSetup({ ...opts, port }).catch((e) => (e.code === 'EADDRINUSE' ? startSetup({ ...opts, port: 0 }) : Promise.reject(e)));
      await writeSetupInstance(process.env, s.port);
      s.server.once('close', () => { removeSetupInstance(process.env, s.port).catch(() => {}); });
      out(fromApp ? `BrainLink Setup: ${maskUrl(s.url)}` : `BrainLink Setup is open at ${maskUrl(s.url)}\nKeep this window open while you set up; press Control-C when done.`);
      return;
    }
    case 'init': {
      const vaultPath = opt('vault');
      if (!vaultPath) fail('--vault PATH is required');
      const full = path.resolve(vaultPath.replace(/^~(?=$|[\/\\])/, homedir()));
      if (!(await stat(full).then((s) => s.isDirectory(), () => false))) fail(`folder not found: ${full}`);
      const cfg = await loadConfig();
      const name = opt('name', path.basename(full));
      const built = buildPack(opt('pack', 'simple'), { vaultName: name, vaultPath: full, agentName: opt('agent') });
      const created = flag('no-scaffold') ? [] : await scaffold(full, built.scaffold);
      const next = mergePack(cfg, built);
      next.timezone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
      await saveConfig(next);
      await refreshMap(next, name);
      out(`Vault "${name}" added (${full}).${created.length ? `\nCreated: ${created.join(', ')}` : ''}\nAgents: ${built.agents.map((a) => `${a.name} ("${a.activation[0]}" / "${a.close[0]}")`).join('; ')}`);
      return;
    }
    case 'connect': {
      const which = argv[1];
      const all = flag('all') || which === 'all';
      if (!which && !all) fail(`connect needs a client: ${Object.keys(CLIENTS).join(', ')}, or --all`);
      const found = await detect(clientOpts());
      const ids = all ? Object.keys(found).filter((id) => found[id].present) : [which];
      // One app's bad/unreadable config must not stop the rest from connecting; every app's
      // outcome (connected or failed) is reported, not just the first failure.
      const results = [];
      for (const id of ids) {
        const title = found[id]?.title || id;
        try {
          const r = await connectClient(id, clientOpts());
          out(`connected ${r.title} via ${r.via}${r.file ? ` (${r.file})` : ''}${r.backup ? `\n  backup: ${r.backup}` : ''}\n  ${r.note}`);
          results.push({ title: r.title, status: 'connected' });
        } catch (e) {
          out(`failed to connect ${title}: ${e.message || e}`);
          results.push({ title, status: `failed: ${e.message || e}` });
        }
      }
      if (all) out(`\n${results.length ? results.map((r) => `${r.title}: ${r.status}`).join('\n') : 'No AI apps found on this computer.'}`);
      return;
    }
    case 'disconnect': {
      const r = await disconnectClient(argv[1], clientOpts());
      out(r.removed ? `removed BrainLink from ${argv[1]}` : `${argv[1]} had no BrainLink entry`);
      return;
    }
    case 'disconnect-all': {
      // Used by the uninstallers: remove BrainLink from every AI app (with backups).
      for (const [id, c] of Object.entries(await detect(clientOpts()))) {
        if (!c.connected) continue;
        try { await disconnectClient(id, clientOpts()); out(`removed BrainLink from ${c.title}`); } catch (e) { out(`could not update ${c.title}: ${e.message}`); }
      }
      for (const client of ['claude-code', 'codex']) {
        try { await setSessionHook(client, false, clientOpts()); }
        catch (e) { out(`could not remove ${client} closeout reminder: ${e.message}`); }
      }
      return;
    }
    case 'clients': {
      for (const [id, c] of Object.entries(await detect(clientOpts()))) out(`${c.connected ? '●' : c.present ? '○' : '·'} ${id.padEnd(15)} ${c.title}${c.unsupported ? ` — ${c.note}` : c.connected ? ' — configured' : c.present ? ' — found' : ''}`);
      return;
    }
    case 'status': {
      const { cfg, ctx } = await openContext(process.env, { trustedLocal: true });
      out(`BrainLink ${VERSION}\nconfig: ${configPath()}\ndata:   ${appHome()}\ntimezone: ${ctx.tz}`);
      for (const v of cfg.vaults) out(`vault  ${v.name}: ${v.path}${await stat(v.path).then(() => '', () => '  ← MISSING')}`);
      for (const a of ctx.agents) out(`agent  ${a.name} @ ${a.vault}: "${a.activation[0]}" / "${a.close[0]}"`);
      return;
    }
    case 'brief': {
      const { ctx } = await openContext(process.env, { trustedLocal: true });
      const v = opt('vault', ctx.enabled[0]);
      if (!v) fail('no vault configured; run brainlink setup');
      const b = await brief(ctx, v, { days: Number(opt('days', 7)) });
      out(`${b.vault} · last ${b.period_days} days · ${b.health.notes} notes, ${b.health.links} links, ${b.health.not_linked} not linked`);
      out(`\nChanged (${b.changed.length}):${b.changed.map((c) => `\n  ${c.changed}  ${c.title}`).join('') || ' none'}`);
      const l = b.open_loops;
      out(`\nOpen: ${l.counts.tasks} tasks, ${l.counts.next_actions} next actions, ${l.counts.decisions_waiting} decisions waiting, ${l.counts.unresolved_questions} questions`);
      for (const x of [...l.decisions_waiting.map((d) => `decision: ${d.decision}`), ...l.next_actions.map((n) => `next: ${n.action}`)].slice(0, 8)) out(`  · ${x}`);
      return;
    }
    case 'miss': {
      const rsi = createRsiWeekly({ home: appHome() });
      if (argv[1] === 'add') {
        const input = { date: opt('date', new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00').replace(/\.\d+/, '')), profile: opt('profile'), agent: opt('agent'), question: opt('question'), result: opt('result'), seconds: Number(opt('seconds')), fix_needed: opt('fix-needed') };
        out(JSON.stringify(await rsi.addMiss(input))); return;
      }
      if (argv[1] === 'import') { if (!opt('file')) fail('--file required'); out(JSON.stringify(await rsi.importMarkdown(path.resolve(opt('file'))))); return; }
      if (argv[1] === 'list') { if (!opt('profile')) fail('--profile required'); out(JSON.stringify({ misses: await rsi.listMisses(opt('profile'), opt('week')), summary: await rsi.aggregateMisses(opt('profile'), opt('week')) }, null, 2)); return; }
      fail('use miss add, import or list');
    }
    case 'bench': {
      const rsi = createRsiWeekly({ home: appHome() });
      if (argv[1] === 'report') { out(JSON.stringify(await rsi.benchmarkReport(Number(opt('weeks', 8))), null, 2)); return; }
      if (argv[1] !== 'run') fail('use bench run or report');
      if (!opt('fixture')) fail('--fixture required');
      const fixtureBytes = await readFile(path.resolve(opt('fixture')));
      const fixture = JSON.parse(fixtureBytes.toString('utf8'));
      const root = opt('vault-root'), name = opt('vault-name', fixture.vault);
      const { ctx } = root ? { ctx: createContext(normalize({ vaults: [{ name, path: path.resolve(root) }] }), { env: { ...process.env, BRAINLINK_SEMANTIC: '0' } }) } : await openContext(process.env, { trustedLocal: true });
      out(JSON.stringify(await rsi.runBenchmark({ ctx, fixture, fixtureBytes, week: opt('week', taipeiWeek(new Date().toISOString())), softwareVersion: VERSION, sourceState: readGitSourceState(ROOT), getSourceState: () => readGitSourceState(ROOT) }), null, 2)); return;
    }
    case 'eval': {
      const fixtureFile = opt('fixture');
      if (!fixtureFile) fail('--fixture FILE is required');
      const fixtureBytes = await readFile(path.resolve(fixtureFile));
      const fixture = JSON.parse(fixtureBytes.toString('utf8'));
      const vaultRoot = opt('vault-root');
      const vaultName = opt('vault-name', fixture.vault);
      const { ctx } = vaultRoot
        ? { ctx: createContext(normalize({ vaults: [{ name: vaultName, path: path.resolve(vaultRoot) }] }), { env: { ...process.env, BRAINLINK_SEMANTIC: '0' } }) }
        : await openContext(process.env, { trustedLocal: true });
      let sourceCommit = null, sourceBranch = null, workingTreeClean = null, trackedTreeClean = null, untrackedPathsPresent = null;
      try {
        sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        sourceBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
        trackedTreeClean = gitClean(['diff-index', '--quiet', 'HEAD', '--'], ROOT) && gitClean(['diff', '--cached', '--quiet'], ROOT);
        untrackedPathsPresent = Boolean(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
        workingTreeClean = trackedTreeClean && !untrackedPathsPresent;
      } catch {}
      const receipt = { source_commit: sourceCommit, source_branch: sourceBranch, working_tree_clean: workingTreeClean, tracked_tree_clean: trackedTreeClean, untracked_paths_present: untrackedPathsPresent, environment: { node: process.version, platform: process.platform, arch: process.arch }, package_version: VERSION };
      out(JSON.stringify(await evaluateRetrieval(ctx, fixture, { fixtureBytes, receipt }), null, 2));
      return;
    }
    case 'eval-filing': {
      const fixtureFile = opt('fixture');
      if (!fixtureFile) fail('--fixture FILE is required');
      const fixture = JSON.parse(await readFile(path.resolve(fixtureFile), 'utf8'));
      const { ctx } = await openContext(process.env, { trustedLocal: true });
      out(JSON.stringify(await evaluateSessionFiling(ctx, fixture), null, 2));
      return;
    }
    case 'eval-graph': {
      const fixtureFile = opt('fixture');
      if (!fixtureFile) fail('--fixture FILE is required');
      const fixtureBytes = await readFile(path.resolve(fixtureFile));
      const fixture = JSON.parse(fixtureBytes.toString('utf8'));
      let sourceCommit = null, sourceBranch = null, workingTreeClean = null, trackedTreeClean = null, untrackedPathsPresent = null;
      try {
        sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        sourceBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
        trackedTreeClean = gitClean(['diff-index', '--quiet', 'HEAD', '--'], ROOT) && gitClean(['diff', '--cached', '--quiet'], ROOT);
        untrackedPathsPresent = Boolean(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
        workingTreeClean = trackedTreeClean && !untrackedPathsPresent;
      } catch {}
      const report = evaluateTypedGraphDiscovery(fixture, { fixtureBytes });
      out(JSON.stringify({ ...report, source_commit: sourceCommit, source_branch: sourceBranch,
        working_tree_clean: workingTreeClean, tracked_tree_clean: trackedTreeClean, untracked_paths_present: untrackedPathsPresent,
        environment: { node: process.version, platform: process.platform, arch: process.arch }, package_version: VERSION,
        evaluator_version: TYPED_GRAPH_EVALUATOR_VERSION }, null, 2));
      return;
    }
    case 'map': {
      const cfg = await loadConfig();
      for (const v of cfg.vaults) { const r = await refreshMap(cfg, v.name); out(r ? `updated ${v.name}/${r}` : `skipped ${v.name} (map off, read-only, or a note of yours already uses that name)`); }
      return;
    }
    case 'sync': {
      const cfg = await loadConfig();
      const r = await runSync(cfg);
      const label = PROVIDER_LABELS[r.provider] || r.provider;
      const notesNote = r.status === 'vault-required' ? ' (add one public vault to sync)' : r.status === 'vault-ambiguous' ? ' (choose a vault in Setup)' : r.status === 'vault-unavailable' ? ' (select an existing public vault in Setup)' : r.status === 'target-inside-vault' ? ' (choose a separate sync folder outside the vault)' : '';
      out(`sync (${label}): ${r.status}${notesNote}; sessions in index: ${r.sessions}`
        + (r.pushed?.length ? `; pushed ${r.pushed.length}` : '') + (r.pulled?.length ? `; pulled ${r.pulled.length}` : '') + (r.conflicts?.length ? `; conflicts ${r.conflicts.length}` : ''));
      return;
    }
    case 'session-end-cue': {
      const client = opt('client', '');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 32 * 1024) fail('hook event is too large');
        chunks.push(chunk);
      }
      const dir = path.join(opt('data-home', appHome()), 'sessions', 'end-cues');
      const sessionRoot = client === 'hermes' ? opt('session-root', '') : undefined;
      const result = await recordSessionEndCue({ input: Buffer.concat(chunks), client, dir, sessionRoot });
      out(result.duplicate ? 'BrainLink: session end cue already recorded.' : 'BrainLink: local session end cue recorded; transcript was not read.');
      return;
    }
    case 'session-end-cues': {
      const cues = await listSessionEndCues(path.join(appHome(), 'sessions', 'end-cues'));
      if (!cues.length) { out('No pending session end cues.'); return; }
      for (const cue of cues) out(`${cue.ended_at}  ${cue.client}  session ${cue.session_id}  (${cue.reason})`);
      return;
    }
    case 'ui': {
      // Same v1.1 Setup app (ui/index.html) as `brainlink setup`, but a per-launch token/port
      // instead of the fixed, reopenable one: a dedicated "just use it" entry point.
      importAll().catch(() => {}); // keep the local session index warm; cheap and incremental after the first run
      const port = Number(opt('port', 0)) || 0;
      const s = await startSetup({ port, openUrl: flag('no-open') ? null : (u) => openInBrowser(u) });
      out(`BrainLink UI: ${maskUrl(s.url)}\nKeep this window open while you use it; press Control-C when done.`);
      return;
    }
    case 'demo': {
      // Throwaway vault + throwaway config/session home (BRAINLINK_HOME), pre-populated with the
      // sample vault under the Founder OS pack, so the demo opens straight into the v1.1
      // experience (vault, agent, graph, sessions) with nothing real touched.
      const demoRoot = await mkdtemp(path.join(tmpdir(), 'brainlink-demo-'));
      const demoPath = path.join(demoRoot, 'Acme Studio');
      await cp(path.join(ROOT, 'samples', 'acme-studio'), demoPath, { recursive: true });
      const demoEnv = { ...process.env, BRAINLINK_HOME: path.join(demoRoot, 'home') };
      const built = buildPack('founder-os', { vaultName: 'Acme Studio', vaultPath: demoPath, agentName: 'Chief of Staff' });
      const cfg = mergePack(emptyConfig(), built);
      cfg.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await saveConfig(cfg, configPath(demoEnv));
      await refreshMap(cfg, 'Acme Studio', demoEnv);
      importAll({ env: demoEnv }).catch(() => {}); // same session-index warm-up as `brainlink ui`
      const s = await startSetup({ env: demoEnv, port: 0, openUrl: flag('no-open') ? null : (u) => openInBrowser(u) });
      out(`BrainLink demo (made-up sample notes, nothing real touched): ${maskUrl(s.url)}\nVault copied to: ${demoPath}\nPress Control-C when done.`);
      return;
    }
    case 'version': case '--version': out(VERSION); return;
    default: out(HELP);
  }
}

main().catch((e) => fail(e.message || String(e)));
