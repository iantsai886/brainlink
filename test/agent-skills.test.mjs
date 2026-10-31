import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAgentSkills, installAgentSkills, removeAgentSkills, skillClientRoot } from '../src/agent-skills.mjs';
import { connectClient } from '../src/connectors.mjs';
import { startSetup } from '../src/setup.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceSkills = path.join(repoRoot, 'skills');
const skillNames = ['brainlink-cross-ai-handoff', 'brainlink-graph-curation', 'brainlink-raw-to-wiki', 'brainlink-session-closeout'];

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'brainlink-agent-skills-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), stateDir = path.join(base, 'appdata'), bundled = path.join(base, 'bundled-skills');
  await mkdir(home, { recursive: true });
  await cp(sourceSkills, bundled, { recursive: true });
  return { base, home, stateDir, bundled, env: { CODEX_HOME: path.join(base, 'codex-home'), DSH_HOME: path.join(base, 'dsh-home'), HERMES_HOME: path.join(base, 'hermes-home') } };
}

test('BrainLink skills use each supported client’s user skill folder', () => {
  const home = path.join(os.tmpdir(), 'brainlink-skills-user');
  const env = { CODEX_HOME: path.join(os.tmpdir(), 'brainlink-codex'), DSH_HOME: path.join(os.tmpdir(), 'brainlink-dsh'), HERMES_HOME: path.join(os.tmpdir(), 'brainlink-hermes') };
  assert.equal(skillClientRoot('claude-code', { home, env }), path.join(home, '.claude', 'skills'));
  assert.equal(skillClientRoot('codex', { home, env }), path.join(env.CODEX_HOME, 'skills'));
  assert.equal(skillClientRoot('codex', { home, env: {} }), path.join(home, '.codex', 'skills'));
  assert.equal(skillClientRoot('gemini', { home, env }), path.join(home, '.gemini', 'skills'));
  assert.equal(skillClientRoot('antigravity', { home, env }), path.join(home, '.gemini', 'config', 'skills'));
  assert.equal(skillClientRoot('antigravity-cli', { home, env }), path.join(home, '.gemini', 'antigravity-cli', 'skills'));
  assert.equal(skillClientRoot('hermes', { home, env }), path.join(env.HERMES_HOME, 'skills'));
  assert.equal(skillClientRoot('hermes', { home, env: { LOCALAPPDATA: path.join(home, 'AppData', 'Local') } }), path.join(home, '.hermes', 'skills'), 'Hermes documents ~/.hermes as the default skill root on Windows too');
  assert.equal(skillClientRoot('deepseek-harness', { home, env }), path.join(env.DSH_HOME, 'skills'));
  assert.equal(skillClientRoot('deepseek-harness@research', { home, env }), path.join(env.DSH_HOME, 'skills'));
  assert.throws(() => skillClientRoot('unknown', { home, env }), /not supported/);
});

test('Agent Skill installer accepts CRLF metadata and preserves the exact source bytes', async (t) => {
  const f = await fixture(t);
  const sourceBytes = new Map();
  for (const name of skillNames) {
    const file = path.join(f.bundled, name, 'SKILL.md');
    const text = (await readFile(file, 'utf8')).replace(/\r?\n/g, '\r\n');
    const bytes = Buffer.from(text, 'utf8');
    sourceBytes.set(name, bytes);
    await writeFile(file, bytes);
  }

  const installed = await installAgentSkills({ client: 'codex', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(installed.installed, skillNames);
  const targetRoot = skillClientRoot('codex', { home: f.home, env: f.env });
  for (const name of skillNames) {
    assert.deepEqual(await readFile(path.join(targetRoot, name, 'SKILL.md')), sourceBytes.get(name));
  }
  assert.deepEqual((await inspectAgentSkills({ client: 'codex', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env })).skills.map((item) => item.state), skillNames.map(() => 'managed'));
  assert.deepEqual((await removeAgentSkills({ client: 'codex', stateDir: f.stateDir, home: f.home, env: f.env })).removed, skillNames);
});

test('Antigravity installs global Agent Skills in its documented user folder', async (t) => {
  const f = await fixture(t);
  const installed = await installAgentSkills({ client: 'antigravity', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(installed.installed, skillNames);
  const status = await inspectAgentSkills({ client: 'antigravity', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(status.skills.map((item) => item.state), skillNames.map(() => 'managed'));
  const removed = await removeAgentSkills({ client: 'antigravity', stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(removed.removed, skillNames);
});

test('Antigravity CLI installs global Agent Skills in its separate documented user folder', async (t) => {
  const f = await fixture(t);
  const installed = await installAgentSkills({ client: 'antigravity-cli', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(installed.installed, skillNames);
  const status = await inspectAgentSkills({ client: 'antigravity-cli', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(status.skills.map((item) => item.state), skillNames.map(() => 'managed'));
  const removed = await removeAgentSkills({ client: 'antigravity-cli', stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(removed.removed, skillNames);
});

test('install is repeatable, updates only files BrainLink still owns, and preserves extra user files', async (t) => {
  const f = await fixture(t);
  const first = await installAgentSkills({ client: 'codex', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(first.installed, skillNames);
  assert.deepEqual(first.updated, []);
  assert.deepEqual((await inspectAgentSkills({ client: 'codex', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env })).skills.map((item) => item.state), skillNames.map(() => 'managed'));
  const again = await installAgentSkills({ client: 'codex', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(again.unchanged, skillNames);

  const updatedName = skillNames[0];
  const sourceFile = path.join(f.bundled, updatedName, 'SKILL.md');
  await writeFile(sourceFile, `${await readFile(sourceFile, 'utf8')}\n<!-- reviewed update -->\n`);
  const update = await installAgentSkills({ client: 'codex', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(update.updated, [updatedName]);
  assert.equal(update.unchanged.length, skillNames.length - 1);

  const root = skillClientRoot('codex', { home: f.home, env: f.env });
  const locallyChanged = skillNames[1], changedFile = path.join(root, locallyChanged, 'SKILL.md');
  const edited = `${await readFile(changedFile, 'utf8')}\n<!-- local edit -->\n`;
  await writeFile(changedFile, edited);
  const extra = path.join(root, updatedName, 'user-reference.txt');
  await writeFile(extra, 'keep this user file');
  const removed = await removeAgentSkills({ client: 'codex', stateDir: f.stateDir, home: f.home, env: f.env });
  assert.deepEqual(removed.removed, skillNames.filter((name) => name !== locallyChanged).sort());
  assert.deepEqual(removed.changed, [locallyChanged]);
  assert.equal(await readFile(changedFile, 'utf8'), edited);
  assert.equal(await readFile(extra, 'utf8'), 'keep this user file');
});

test('an existing non-BrainLink skill collision blocks the whole install', async (t) => {
  const f = await fixture(t);
  const root = skillClientRoot('gemini', { home: f.home, env: f.env });
  const collision = path.join(root, skillNames[0], 'SKILL.md');
  await mkdir(path.dirname(collision), { recursive: true });
  await writeFile(collision, 'user-owned skill');
  await assert.rejects(installAgentSkills({ client: 'gemini', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env }), /differs from BrainLink/);
  assert.equal(await readFile(collision, 'utf8'), 'user-owned skill');
  assert.equal(await readFile(path.join(root, skillNames[1], 'SKILL.md')).catch(() => null), null);
});

test('an identical pre-existing skill is not claimed or removed by BrainLink', async (t) => {
  const f = await fixture(t);
  const root = skillClientRoot('hermes', { home: f.home, env: f.env });
  const preexisting = path.join(root, skillNames[0], 'SKILL.md');
  const exactBundle = await readFile(path.join(f.bundled, skillNames[0], 'SKILL.md'));
  await mkdir(path.dirname(preexisting), { recursive: true });
  await writeFile(preexisting, exactBundle);
  const result = await installAgentSkills({ client: 'hermes', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env });
  assert.ok(result.unchanged.includes(skillNames[0]));
  assert.equal((await inspectAgentSkills({ client: 'hermes', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env })).skills.find((item) => item.name === skillNames[0]).state, 'current');
  const removed = await removeAgentSkills({ client: 'hermes', stateDir: f.stateDir, home: f.home, env: f.env });
  assert.equal(await readFile(preexisting, 'utf8'), exactBundle.toString('utf8'));
  assert.deepEqual(removed.removed, skillNames.slice(1));
});

test('damaged install receipt fails closed before touching skill files', async (t) => {
  const f = await fixture(t);
  await mkdir(f.stateDir, { recursive: true });
  await writeFile(path.join(f.stateDir, 'agent-skills.json'), '{bad json');
  await assert.rejects(installAgentSkills({ client: 'deepseek-harness', sourceRoot: f.bundled, stateDir: f.stateDir, home: f.home, env: f.env }), /record is damaged/);
  assert.equal(await readFile(path.join(skillClientRoot('deepseek-harness', { home: f.home, env: f.env }), skillNames[0], 'SKILL.md')).catch(() => null), null);
});

test('Setup shows skill status and requires an authenticated, connected AI before installing', async (t) => {
  const f = await fixture(t);
  const env = { ...f.env, BRAINLINK_HOME: path.join(f.base, 'brainlink-app'), BRAINLINK_SEMANTIC: '0' };
  const config = path.join(f.home, '.claude.json');
  await writeFile(config, JSON.stringify({ mcpServers: { brainlink: { command: 'node', args: [], env: {} } } }));
  const antigravityConfig = path.join(f.home, '.gemini', 'config', 'mcp_config.json');
  await mkdir(path.dirname(antigravityConfig), { recursive: true });
  await writeFile(antigravityConfig, JSON.stringify({ mcpServers: { brainlink: { command: 'node', args: [], env: {} } } }));
  const dshHome = f.env.DSH_HOME;
  await mkdir(path.join(dshHome, 'profiles', 'work'), { recursive: true });
  await connectClient('deepseek-harness@work', { home: f.home, os: 'win32', env: f.env, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, extraEnv: { BRAINLINK_AGENT_TOKEN: 'fictional-profile-token' }, useCli: false });
  const app = await startSetup({ env, home: f.home, os: 'win32', port: 0, useCli: false });
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.port}`;
  const api = (method, route, body, token = app.token) => fetch(base + route, { method, headers: { 'X-BrainLink-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  assert.equal((await api('POST', '/api/skills/install', { client: 'claude-code' }, 'wrong-token')).status, 401);
  const before = await (await api('GET', '/api/state')).json();
  assert.equal(before.clients['claude-code'].connected, true);
  assert.equal(before.clients.antigravity.connected, true, 'the shared Antigravity MCP config is the connection gate for both skill surfaces');
  assert.equal(before.clients['deepseek-harness@work'].connected, true, 'the named Harness profile is connected without a shared home-level entry');
  assert.deepEqual(before.agent_skills['claude-code'].skills.map((item) => item.state), skillNames.map(() => 'missing'));
  assert.deepEqual(before.agent_skills.antigravity.skills.map((item) => item.state), skillNames.map(() => 'missing'));
  assert.deepEqual(before.agent_skills['antigravity-cli'].skills.map((item) => item.state), skillNames.map(() => 'missing'));
  assert.equal((await api('POST', '/api/skills/install', { client: 'codex' })).status, 400, 'unconnected clients cannot receive BrainLink skills');
  const appSkillsInstalled = await (await api('POST', '/api/skills/install', { client: 'antigravity' })).json();
  assert.deepEqual(appSkillsInstalled.installed, skillNames);
  assert.deepEqual((await (await api('GET', '/api/state')).json()).agent_skills.antigravity.skills.map((item) => item.state), skillNames.map(() => 'managed'));
  assert.equal((await api('POST', '/api/skills/remove', { client: 'antigravity' })).status, 200);
  const cliSkillsInstalled = await (await api('POST', '/api/skills/install', { client: 'antigravity-cli' })).json();
  assert.deepEqual(cliSkillsInstalled.installed, skillNames, 'CLI skills can be installed through the connected shared Antigravity MCP entry');
  assert.deepEqual((await (await api('GET', '/api/state')).json()).agent_skills['antigravity-cli'].skills.map((item) => item.state), skillNames.map(() => 'managed'));
  assert.equal((await api('POST', '/api/skills/remove', { client: 'antigravity-cli' })).status, 200);
  assert.deepEqual((await (await api('GET', '/api/state')).json()).agent_skills['antigravity-cli'].skills.map((item) => item.state), skillNames.map(() => 'missing'));
  assert.equal((await api('POST', '/api/skills/install', { client: 'deepseek-harness' })).status, 200, 'a connected named Harness profile enables the shared user-level skills');
  assert.deepEqual((await (await api('GET', '/api/state')).json()).agent_skills['deepseek-harness'].skills.map((item) => item.state), skillNames.map(() => 'managed'));
  assert.equal((await api('POST', '/api/skills/remove', { client: 'deepseek-harness' })).status, 200);
  const installed = await (await api('POST', '/api/skills/install', { client: 'claude-code' })).json();
  assert.deepEqual(installed.installed, skillNames);
  const after = await (await api('GET', '/api/state')).json();
  assert.deepEqual(after.agent_skills['claude-code'].skills.map((item) => item.state), skillNames.map(() => 'managed'));
  assert.equal((await api('POST', '/api/skills/remove', { client: 'claude-code' })).status, 200);
  const afterRemove = await (await api('GET', '/api/state')).json();
  assert.deepEqual(afterRemove.agent_skills['claude-code'].skills.map((item) => item.state), skillNames.map(() => 'missing'));
});
