#!/usr/bin/env node
// BrainLink command line. AI clients launch `brainlink serve`; people use `brainlink setup`.
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { stat, readFile, writeFile, mkdir, cp, mkdtemp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, configPath, appHome } from '../src/config.mjs';
import { verifyLicense, planFeatures, effectiveLicense } from '../src/license.mjs';
import { buildPack, scaffold, mergePack, PACKS } from '../src/packs.mjs';
import { CLIENTS, detect, connectClient, disconnectClient } from '../src/connectors.mjs';
import { createMcp, serveStdio, serveHttp, VERSION } from '../src/server.mjs';
import { openContext, launchSpec, logActivity, refreshMap, ROOT } from '../src/runtime.mjs';
import { warmSemantic } from '../src/core.mjs';
import { brief } from '../src/insights.mjs';
import { startSetup, openInBrowser } from '../src/setup.mjs';
import { runSync } from '../src/sync-cli.mjs';
import { PROVIDER_LABELS } from '../src/sync/settings.mjs';
import { createConfiguredHost, createFolderHost } from '../src/host.mjs';
import { serveUi } from '../src/ui-server.mjs';

// `brainlink brief | head` closes the pipe early: exit quietly instead of crashing.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i === -1 || argv[i + 1]?.startsWith('--') ? dflt : argv[i + 1] ?? dflt; };
const out = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stderr.write(`brainlink: ${s}\n`); process.exit(1); };
const SETUP_PORT = 47800;
async function setupToken() {
  const file = path.join(appHome(), 'setup-token');
  try { const t = (await readFile(file, 'utf8')).trim(); if (t.length >= 20) return t; } catch {}
  const t = randomBytes(18).toString('base64url');
  await mkdir(appHome(), { recursive: true });
  await writeFile(file, t, { mode: 0o600 });
  return t;
}
const clientOpts = () => ({ home: homedir(), os: process.platform, env: process.env, launch: launchSpec() });

const HELP = `BrainLink MCP ${VERSION} — one Markdown brain for every AI

  brainlink setup [--no-open]          open the Setup app (pick vault, connect AIs, licence)
  brainlink init --vault PATH [--name N] [--pack ${Object.keys(PACKS).join('|')}] [--agent NAME] [--no-scaffold]
  brainlink connect <client|all>       ${Object.keys(CLIENTS).join(', ')} (or --all)
  brainlink disconnect <client>        (disconnect-all removes it from every app)
  brainlink clients                    show detected / connected AI apps
  brainlink license [KEY]              show or set the licence key
  brainlink status                     config, vaults, plan
  brainlink brief [--vault V] [--days 7]  what changed and what is open
  brainlink map                        rebuild each vault's Home map
  brainlink sync                       one sync pass (local by default; set up in Setup)
  brainlink ui [--no-open] [--port N]  open the milestone UI (notes, search, graph) on your vaults
  brainlink demo [--no-open]           try the UI on a throwaway sample vault; touches nothing real
  brainlink serve                      MCP over stdio (what AI apps run)
  brainlink serve --http [PORT]        MCP over local HTTP (bearer token from Setup)

Config: ${configPath()}`;

async function main() {
  switch (cmd) {
    case 'serve': {
      const { ctx, cfg } = await openContext();
      const mcp = createMcp(ctx, { onCall: (e) => logActivity(process.env, { ...e, platform: ctx.platform || 'unknown', mode: flag('http') ? 'http' : 'stdio' }) });
      if (flag('http')) {
        if (!ctx.features.http) fail('HTTP mode needs a licence key (brainlink license KEY).');
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
      const port = Number(opt('port', SETUP_PORT)) || SETUP_PORT;
      const token = await setupToken();
      const url = `http://127.0.0.1:${port}/?t=${token}`;
      const running = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json(), () => null);
      if (running?.app === 'brainlink') { if (!flag('no-open')) openInBrowser(url); out(`BrainLink Setup: ${url}`); return; }
      const opts = { token, openUrl: flag('no-open') ? null : (u) => openInBrowser(u), idleMinutes: fromApp ? 30 : 0, onQuit: () => process.exit(0) };
      const s = await startSetup({ ...opts, port }).catch((e) => (e.code === 'EADDRINUSE' ? startSetup({ ...opts, port: 0 }) : Promise.reject(e)));
      out(fromApp ? `BrainLink Setup: ${s.url}` : `BrainLink Setup is open at ${s.url}\nKeep this window open while you set up; press Control-C when done.`);
      return;
    }
    case 'init': {
      const vaultPath = opt('vault');
      if (!vaultPath) fail('--vault PATH is required');
      const full = path.resolve(vaultPath.replace(/^~(?=$|[\/\\])/, homedir()));
      if (!(await stat(full).then((s) => s.isDirectory(), () => false))) fail(`folder not found: ${full}`);
      const cfg = await loadConfig();
      const name = opt('name', path.basename(full));
      const features = planFeatures(effectiveLicense(cfg));
      if (!cfg.vaults.some((v) => v.name === name) && cfg.vaults.length >= features.maxVaults) fail('the free plan supports one vault; add a licence key first');
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
      const cfg = await loadConfig();
      const features = planFeatures(effectiveLicense(cfg));
      const found = await detect(clientOpts());
      const ids = all ? Object.keys(found).filter((id) => found[id].present) : [which];
      let connected = Object.values(found).filter((c) => c.connected).length;
      for (const id of ids) {
        if (!found[id]?.connected && connected >= features.maxConnections) { out(`skip ${id}: the free plan connects ${features.maxConnections} AI apps`); continue; }
        const r = await connectClient(id, clientOpts());
        if (!found[id]?.connected) connected++;
        out(`connected ${r.title} via ${r.via}${r.file ? ` (${r.file})` : ''}${r.backup ? `\n  backup: ${r.backup}` : ''}\n  ${r.note}`);
      }
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
      return;
    }
    case 'clients': {
      for (const [id, c] of Object.entries(await detect(clientOpts()))) out(`${c.connected ? '●' : c.present ? '○' : '·'} ${id.padEnd(15)} ${c.title}${c.unsupported ? ` — ${c.note}` : c.connected ? ' — connected' : c.present ? ' — found' : ''}`);
      return;
    }
    case 'license': {
      const cfg = await loadConfig();
      if (argv[1]) {
        const lic = verifyLicense(argv[1]);
        if (!lic.valid) fail(`licence not accepted: ${lic.reason}`);
        await saveConfig({ ...cfg, license: argv[1].trim() });
        out(`Licence OK: ${lic.plan} for ${lic.email}${lic.expires ? `, until ${lic.expires}` : ''}.`);
      } else {
        const lic = effectiveLicense(cfg);
        out(lic.valid ? `${lic.plan} licence for ${lic.email}${lic.expires ? ` (expires ${lic.expires})` : ''}` : `Free plan (${lic.reason}).`);
      }
      return;
    }
    case 'status': {
      const { cfg, license, ctx } = await openContext();
      out(`BrainLink ${VERSION}\nconfig: ${configPath()}\ndata:   ${appHome()}\nplan:   ${ctx.features.plan}${license.valid ? ` (${license.email})` : ''}\ntimezone: ${ctx.tz}`);
      for (const v of cfg.vaults) out(`vault  ${v.name}${ctx.enabled.includes(v.name) ? '' : ' (disabled on free plan)'}: ${v.path}${await stat(v.path).then(() => '', () => '  ← MISSING')}`);
      for (const a of ctx.agents) out(`agent  ${a.name} @ ${a.vault}: "${a.activation[0]}" / "${a.close[0]}"`);
      return;
    }
    case 'brief': {
      const { ctx } = await openContext();
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
    case 'map': {
      const cfg = await loadConfig();
      for (const v of cfg.vaults) { const r = await refreshMap(cfg, v.name); out(r ? `updated ${v.name}/${r}` : `skipped ${v.name} (map off, read-only, or a note of yours already uses that name)`); }
      return;
    }
    case 'sync': {
      const cfg = await loadConfig();
      const r = await runSync(cfg);
      const label = PROVIDER_LABELS[r.provider] || r.provider;
      const notesNote = r.provider !== 'local' ? ' (notes: pending the store integration — see brainlink-store/docs/progress.md)' : '';
      out(`sync (${label}): ${r.status}${notesNote}; sessions in index: ${r.sessions}`
        + (r.pushed?.length ? `; pushed ${r.pushed.length}` : '') + (r.pulled?.length ? `; pulled ${r.pulled.length}` : '') + (r.conflicts?.length ? `; conflicts ${r.conflicts.length}` : ''));
      return;
    }
    case 'ui': {
      let host;
      try { host = await createConfiguredHost(); } catch (e) { fail(e.message); return; }
      const port = Number(opt('port', 0)) || 0;
      const s = await serveUi({ host, port, openUrl: flag('no-open') ? null : (u) => openInBrowser(u) });
      out(`BrainLink UI: ${s.url}\nKeep this window open while you use it; press Control-C when done.`);
      return;
    }
    case 'demo': {
      const demoRoot = await mkdtemp(path.join(tmpdir(), 'brainlink-demo-'));
      const demoPath = path.join(demoRoot, 'Demo Vault');
      await cp(path.join(ROOT, 'samples', 'acme-studio'), demoPath, { recursive: true });
      const host = await createFolderHost({ name: 'Demo Vault', folder: demoPath });
      const s = await serveUi({ host, port: 0, openUrl: flag('no-open') ? null : (u) => openInBrowser(u) });
      out(`BrainLink demo (made-up sample notes, nothing real touched): ${s.url}\nVault copied to: ${demoPath}\nPress Control-C when done.`);
      return;
    }
    case 'version': case '--version': out(VERSION); return;
    default: out(HELP);
  }
}

main().catch((e) => fail(e.message || String(e)));
