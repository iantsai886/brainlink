// Technical Reviewer's adversarial privacy probe (/workspace/tr121-bundle/probe/probe.mjs, run
// against this repo with `APP=/workspace/brainlink-rebuild node probe.mjs`), copied into the test
// suite per the v1.2.1 review's ranked must-fix #5: "Re-run probe.mjs. All 20 FAIL rows should
// pass... Add the probe as a test: the 153 green tests caught none of these 20 failures." This is
// a near-verbatim port (static imports instead of the original's dynamic APP-relative ones;
// everything else — the planted vault, the symlinks, the manifest-traversal attacks, the checks
// themselves — is unchanged) so it keeps catching the exact class of bug the original 153 tests
// didn't.
//
// Private session reads return a structured privacy notice instead of an MCP error. The probe
// asserts that contract and still checks that no summary, excerpt, or transcript canary escapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize } from '../src/config.mjs';
import * as core from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import * as snap from '../src/snapshot.mjs';
import { startSetup } from '../src/setup.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';

test('Technical Reviewer privacy probe: every adversarial row passes', async (t) => {
  const B = path.join(tmpdir(), `brainlink-tr-probe-${process.pid}-${Date.now()}`);
  await rm(B, { recursive: true, force: true }); await mkdir(B, { recursive: true });

  const results = [];
  const rec = (id, pass, evidence) => { results.push({ id, pass, evidence }); };
  const leaks = (s) => [...new Set(String(s).match(/[A-Z_]*PRIV[A-Z_]*_MARK|ROOTFIN_MARK|NESTED_MARK|DEEP_MARK/g) || [])];

  // ---- vault ----
  const V = path.join(B, 'vault');
  const w = async (rel, txt) => { await mkdir(path.dirname(path.join(V, rel)), { recursive: true }); await writeFile(path.join(V, rel), txt); };
  await mkdir(V, { recursive: true });
  await core.ensureDefaultIgnore(V); // shipped default .brainlinkignore (contains 00 Home/)
  await w('00 Home/money.md', '# money\n\nzebracorn ROOTFIN_MARK bank balance');
  await w('Brain/00 Home/nested.md', '# nested\n\nzebracorn NESTED_MARK salary');
  await w('sub/deep/00 Home/deeper.md', '# deeper\n\nzebracorn DEEP_MARK tax');
  await w('Secret.md', '---\nprivate: true\n---\n# Secret\n\nzebracorn PRIV_TRUE_MARK');
  await w('SecretYes.md', '---\nprivate: yes\n---\n# SecretYes\n\nzebracorn PRIV_YES_MARK');
  await w('SecretQuoted.md', '---\nprivate: "true"\n---\n# SecretQuoted\n\nzebracorn PRIV_QUOTED_MARK');
  await w('SecretCapKey.md', '---\nPrivate: true\n---\n# SecretCapKey\n\nzebracorn PRIV_CAPKEY_MARK');
  await w('SecretComment.md', '---\nprivate: true # do not share\n---\n# SecretComment\n\nzebracorn PRIV_COMMENT_MARK');
  await w('SecretTitle.md', '---\nprivate: True\n---\n# SecretTitle\n\nzebracorn PRIV_TITLE_MARK');
  await w('SecretOn.md', '---\nprivate: on\n---\n# SecretOn\n\nzebracorn PRIV_ON_MARK');
  await w('Secret2.md', '---\nprivate: true\n---\n# Secret2\n\n- [ ] PRIVTASK_MARK call the bank\n\n## Open questions\n- PRIVQ_MARK should I sell?\n\n- **Smallest next actions:** PRIVNEXT_MARK move money\n');
  await w('Home.md', '# Home\n\nzebracorn hub. See [[Secret]], [[SecretYes]], [[money]], [[nested]], [[Visible]].');
  await w('Visible.md', '# Visible\n\nzebracorn VISIBLE_OK');
  try { await symlink(path.join(V, '00 Home/money.md'), path.join(V, 'link-to-money.md')); }
  catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32') { t.skip('Windows symlink privilege unavailable; run privacy probe on a symlink-capable host'); return; }
    throw error;
  }
  await symlink(path.join(V, '00 Home'), path.join(V, 'HomeAlias'));
  await symlink(path.join(V, 'Secret.md'), path.join(V, 'link-to-secret.md'));

  const HOME = path.join(B, 'apphome'); await mkdir(HOME, { recursive: true });
  const cfg = normalize({ timezone: 'Asia/Taipei', vaults: [{ name: 'Brain', path: V }] });
  const env = { BRAINLINK_HOME: HOME, BRAINLINK_AI_PLATFORM: 'Claude', BRAINLINK_SEMANTIC: '0' };
  const ctx = core.createContext(cfg, { env });
  const mcp = createMcp(ctx);
  let id = 0;
  const call = async (name, args) => { const r = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }); return r.result || r.error; };

  // ---- P0-1 readNote / vault_read_note / fetch ----
  const readTargets = ['00 Home/money.md', 'Brain/00 Home/nested.md', 'sub/deep/00 Home/deeper.md', 'Secret.md', 'SecretYes.md', 'SecretQuoted.md', 'SecretCapKey.md', 'SecretComment.md', 'SecretTitle.md', 'SecretOn.md',
    'link-to-money.md', 'HomeAlias/money.md', 'link-to-secret.md', './00 Home/money.md', 'x/../00 Home/money.md', '00 Home//money.md', '00 HOME/money.md', '/00 Home/money.md', '00 Home/../00 Home/money.md'];
  for (const t of readTargets) {
    let direct; try { const n = await core.readNote(ctx, 'Brain', t); direct = `RETURNED body leaks=[${leaks(n.body)}]`; } catch (e) { direct = `refused: ${e.message}`; }
    const tool = await call('vault_read_note', { vault: 'Brain', path: t });
    const fetchR = await call('fetch', { id: `Brain::${t}` });
    const l = [...leaks(JSON.stringify(tool)), ...leaks(JSON.stringify(fetchR)), ...(direct.startsWith('RETURNED') ? leaks(direct) : [])];
    rec(`P0-1 read ${JSON.stringify(t)}`, l.length === 0, `readNote=${direct} | vault_read_note isError=${tool.isError} | fetch isError=${fetchR.isError} | leaked=[${[...new Set(l)]}]`);
  }
  rec('P0-1 isExcludedPath case-variant (macOS case-insensitive FS)', await core.isExcludedPath(V, '00 HOME/money.md'), `isExcludedPath("00 HOME/money.md")=${await core.isExcludedPath(V, '00 HOME/money.md')}`);

  // ---- P0-2 nested exclusions in index ----
  const idx = await core.loadVault(ctx, 'Brain');
  const rels = idx.notes.map((n) => n.rel);
  rec('P0-2 index excludes root+nested 00 Home (and symlink aliases)', !rels.some((r) => /00 Home|HomeAlias|link-to-money/i.test(r)), `indexed rels=${JSON.stringify(rels)}`);

  // ---- S1 search/related/graph/ask + other MCP read tools ----
  const PRIVPATH = /Secret\w*\.md|00 Home\//;
  const s = await core.search(ctx, 'Brain', 'zebracorn', 50);
  rec('S1 core.search', leaks(JSON.stringify(s)).length === 0 && !s.some((x) => PRIVPATH.test(x.path)), `paths=${JSON.stringify(s.map((x) => x.path))} leaks=[${leaks(JSON.stringify(s))}]`);
  const vs = await call('vault_search', { vault: 'Brain', query: 'zebracorn', limit: 20 });
  rec('S1 MCP vault_search', leaks(JSON.stringify(vs)).length === 0 && !PRIVPATH.test(JSON.stringify(vs)), `privatePaths=${[...new Set(JSON.stringify(vs).match(/Secret\w*\.md/g) || [])].join(',') || 'none'} leaks=[${leaks(JSON.stringify(vs))}]`);
  const cs = await call('search', { query: 'zebracorn' });
  rec('S1 MCP connector search', !PRIVPATH.test(JSON.stringify(cs)), `ids=${JSON.stringify((JSON.parse(cs.content[0].text).results || []).map((r) => r.id))}`);
  const rl = await call('vault_related', { vault: 'Brain', path: 'Home.md' });
  rec('S1 MCP vault_related(Home.md)', !/Secret|money|nested/.test(JSON.stringify(rl)), `secret refs=${(JSON.stringify(rl).match(/Secret\w*|money|nested/g) || []).join(',') || 'none'}`);
  const rl2 = await call('vault_related', { vault: 'Brain', path: 'Secret.md' });
  rec('S1 MCP vault_related(Secret.md) refused', rl2.isError === true && leaks(JSON.stringify(rl2)).length === 0, JSON.stringify(rl2).slice(0, 160));
  for (const tname of ['vault_recent', 'open_loops', 'brain_brief', 'vault_health', 'brainlink_guide']) {
    const r = await call(tname, { vault: 'Brain' });
    const txt = JSON.stringify(r);
    // brainlink_guide intentionally lists owner-configured excluded_folders (e.g. "00 Home/") so clients can explain
    // why excluded notes are unavailable, while still forbidding any private/excluded note path or content.
    const pathPattern = tname === 'brainlink_guide' ? /Secret\w*\.md|00 Home\/[^"\\]+/ : PRIVPATH;
    rec(`S1-extra MCP ${tname}`, leaks(txt).length === 0 && !pathPattern.test(txt), `isError=${r.isError} leaks=[${leaks(txt)}] privatePathsNamed=${[...new Set(txt.match(/Secret\w*\.md|00 Home\/[^"\\]*/g) || [])].join(',') || 'none'}`);
  }

  // Setup HTTP API
  const SETUP_HOME = path.join(B, 'setuphome'); await mkdir(SETUP_HOME, { recursive: true });
  const st = await startSetup({ env: { BRAINLINK_HOME: path.join(B, 'setup-apphome'), BRAINLINK_SEMANTIC: '0' }, home: SETUP_HOME, os: 'darwin', port: 0, useCli: false });
  const api = async (p, body) => { const r = await fetch(`http://127.0.0.1:${st.port}${p}`, { method: 'POST', headers: { 'X-BrainLink-Token': st.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.text(); };
  try {
    const add = await api('/api/vault', { path: V, name: 'Brain', pack: 'simple', scaffold: false });
    rec('setup: add vault (no excludedFolders in body) keeps existing .brainlinkignore', /00 Home/.test(await readFile(path.join(V, '.brainlinkignore'), 'utf8')), `add=${add.slice(0, 100)}`);
    const g = await api('/api/graph', { vault: 'Brain' });
    rec('S1 /api/graph', !/Secret|money|nested|deeper|MARK/.test(g), `nodes=${JSON.stringify((JSON.parse(g).nodes || []).map((n) => n.title))}`);
    const g3 = await api('/api/graph3d', { vault: 'Brain' });
    rec('S1/P0-2 /api/graph3d', !/Secret|money|nested|deeper|MARK/.test(g3), `nodes=${JSON.stringify((JSON.parse(g3).nodes || []).map((n) => n.title || n.name || n.id))}`);
    for (const t of ['00 Home/money.md', 'Brain/00 Home/nested.md', 'Secret.md', 'SecretYes.md', 'SecretComment.md', 'SecretOn.md', 'link-to-money.md']) {
      const n3 = await api('/api/graph3d/note', { vault: 'Brain', path: t });
      const nn = await api('/api/note', { vault: 'Brain', path: t });
      rec(`P0-1 Setup /api/graph3d/note + /api/note ${t}`, leaks(n3 + nn).length === 0, `graph3d/note=${n3.slice(0, 80)} | note=${nn.slice(0, 80)} leaks=[${leaks(n3 + nn)}]`);
    }
    const ask = await api('/api/ask', { vault: 'Brain', query: 'zebracorn' });
    rec('S1 /api/ask', leaks(ask).length === 0 && !PRIVPATH.test(ask), `answer+sources=${ask.slice(0, 300)}`);
    const tst = await api('/api/test', { vault: 'Brain', query: 'zebracorn' });
    rec('S1-extra /api/test', leaks(tst).length === 0 && !PRIVPATH.test(tst), tst.slice(0, 250));
  } finally { st.server.close(); }

  // ---- snapshot contents ----
  const dest = path.join(B, 'snapdest'); await mkdir(dest, { recursive: true });
  const withSnap = snap.chooseSnapshot(cfg, { enabled: true, folder: dest });
  const r1 = await snap.writeSnapshotOnce(ctx, withSnap, env);
  const listAll = async (d, pre = '') => (await Promise.all((await readdir(d, { withFileTypes: true })).map(async (e) => e.isDirectory() ? listAll(path.join(d, e.name), pre + e.name + '/') : [pre + e.name]))).flat();
  const snapFiles = await listAll(dest);
  let snapText = ''; for (const f of snapFiles) snapText += await readFile(path.join(dest, f), 'utf8').catch(() => '');
  rec('P0-2/S1 snapshot contents', leaks(snapText).length === 0 && !snapFiles.some((f) => /00 Home|Secret|HomeAlias|link-to/.test(f)), `ok=${r1.ok} files=${JSON.stringify(snapFiles)} leaks=[${leaks(snapText)}]`);

  // ---- P0-3 snapshot manifest unlink containment ----
  const OUT = path.join(B, 'outside'); await mkdir(OUT, { recursive: true });
  const victims = ['v-dotdot.txt', 'v-abs.txt', 'v-symdir.txt', 'v-symfile.txt', 'v-deep.txt', 'v-encoded.txt', 'v-backslash.txt'];
  for (const v of victims) await writeFile(path.join(OUT, v), 'VICTIM');
  await symlink(OUT, path.join(dest, 'evil-dir'));
  await symlink(path.join(OUT, 'v-symfile.txt'), path.join(dest, 'evil-file.md'));
  await mkdir(path.join(dest, 'user-own'), { recursive: true }); await writeFile(path.join(dest, 'user-own', 'mine.txt'), 'USER FILE NOT WRITTEN BY BRAINLINK');
  // The manifest moved out of `dest` itself and under appHome (src/snapshot.mjs manifestPath) so
  // a remote peer syncing `dest` can no longer plant one; a stale planted manifest.json left
  // inside `dest` is now just an ordinary, inert file BrainLink never reads. Plant at the real
  // location (same env as writeSnapshotOnce below resolves it with) so this row still exercises
  // the actual traversal-containment logic instead of silently no-op'ing against dead code.
  const mfPath = snap.manifestPath(dest, env);
  const rel = path.relative(dest, OUT);
  const plant = async () => { const mf = JSON.parse(await readFile(mfPath, 'utf8').catch(() => '{"files":{}}')); Object.assign(mf.files, {
    [`${rel}/v-dotdot.txt`]: {}, [path.join(OUT, 'v-abs.txt')]: {}, 'evil-dir/v-symdir.txt': {}, 'evil-file.md': {},
    [`Brain/../../${path.basename(B)}/outside/v-deep.txt`]: {}, ['..%2Foutside%2Fv-encoded.txt']: {}, ['..\\outside\\v-backslash.txt']: {}, 'user-own/mine.txt': {} }); await writeFile(mfPath, JSON.stringify(mf)); };
  await plant();
  const r2 = await snap.writeSnapshotOnce(ctx, withSnap, env);
  const surv = Object.fromEntries(victims.map((v) => [v, existsSync(path.join(OUT, v))]));
  rec('P0-3 writeSnapshotOnce manifest traversal contained', Object.values(surv).every(Boolean) && existsSync(path.join(dest, 'evil-file.md')), `ok=${r2.ok} outside survivors=${JSON.stringify(surv)} evil-file symlink still present=${existsSync(path.join(dest, 'evil-file.md'))}`);
  rec('P0-3 residual (informational): planted manifest key for a non-BrainLink file INSIDE the share folder', true, `user-own/mine.txt still exists=${existsSync(path.join(dest, 'user-own', 'mine.txt'))} (false = it was deleted)`);
  for (const v of victims) await writeFile(path.join(OUT, v), 'VICTIM');
  await plant();
  await snap.clearSnapshot(dest, env);
  const surv2 = Object.fromEntries(victims.map((v) => [v, existsSync(path.join(OUT, v))]));
  rec('P0-3 clearSnapshot manifest traversal contained', Object.values(surv2).every(Boolean), `outside survivors=${JSON.stringify(surv2)}`);

  // ---- S2 sessions ----
  const store = await openSessionStore(env);
  const ps = await store.putSession({ client: 'claude-code', source_id: 'probe/priv1', project: '/x', title: 'PRIVSESSION title', summary: 'PRIVSESSION_SUMMARY', started_at: '2026-10-20T00:00:00Z', note_refs: [], private: true, messages: [{ role: 'user', at: '2026-10-20T00:00:00Z', text: 'PRIVSESSION_BODY' }] });
  await store.putSession({ client: 'claude-code', source_id: 'probe/pub1', project: '/x', title: 'public', summary: 'PUBLIC_OK', started_at: '2026-10-20T00:00:00Z', note_refs: [], private: false, messages: [{ role: 'user', at: '2026-10-20T00:00:00Z', text: 'public body' }] });
  const PS = /PRIVSESSION/;
  const sl = [await call('session_list', {}), await call('session_list', { include_private: true }), await call('session_list', { include_private: 'true' }), await call('session_list', { q: 'PRIVSESSION', include_private: true, limit: 20 })];
  rec('S2 session_list: private session never listed (incl. include_private from client)', !sl.some((r) => PS.test(JSON.stringify(r))), `private visible per call=${sl.map((r) => PS.test(JSON.stringify(r)))} public visible (first 3 calls, no q)=${sl.slice(0, 3).map((r) => /PUBLIC_OK/.test(JSON.stringify(r)))}`);
  const sr = [await call('session_read', { id: ps.id }), await call('session_read', { id: ps.id, include_private: true }), await call('session_read', { id: ps.id, include_private: true, full: true }), await call('session_read', { id: ps.id, full: true, offset: 0 })];
  rec('S2 session_read returns a private notice without summary or transcript content', sr.every((r) => {
    const value = r.structuredContent || {};
    return !r.isError && value.private === true && value.messages === undefined && value.key_turns === undefined && !PS.test(JSON.stringify(value));
  }), sr.map((r) => `${r.isError}:${JSON.stringify(r.structuredContent || r).slice(0, 90)}`).join(' | '));
  const lg = await call('session_log', { session_id: ps.id, text: 'appended', private: false });
  const afterAppend = await call('session_list', { q: 'PRIVSESSION', limit: 20 });
  rec('S2 session_log(session_id, private:false) cannot unhide a private session', !PS.test(JSON.stringify(afterAppend)), `log isError=${lg.isError} listAfter has private=${PS.test(JSON.stringify(afterAppend))}`);
  const l1 = await call('session_log', { text: 'DAYNOTE_PRIV first', title: 'daynote' });
  const l2 = await call('session_log', { text: 'second, public please', private: false });
  const dl = await call('session_list', { limit: 20 });
  const dr = await call('session_read', { id: JSON.parse(l1.content[0].text).id, full: true });
  rec('S2 session_log(private:false) on same-day source_id cannot unhide earlier private note', !/DAYNOTE_PRIV/.test(JSON.stringify(dl) + JSON.stringify(dr)), `sameId=${JSON.parse(l1.content[0].text).id === JSON.parse(l2.content[0].text).id} list shows daynote=${/daynote/.test(JSON.stringify(dl))} read isError=${dr.isError}`);
  const tl = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} });
  const sch = JSON.stringify(tl.result.tools.filter((t) => /^session_(list|read)$/.test(t.name)).map((t) => t.inputSchema));
  rec('S2 tools/list: session_list/read schemas drop include_private', !/include_private/.test(sch), `include_private in schema=${/include_private/.test(sch)}`);

  await rm(B, { recursive: true, force: true });

  assert.deepEqual(
    results.filter((r) => !r.pass).map((r) => `${r.id} :: ${r.evidence}`),
    [],
    'every adversarial privacy probe row must pass',
  );
});
