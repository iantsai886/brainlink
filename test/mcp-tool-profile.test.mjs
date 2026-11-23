import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp, CORE_MCP_TOOLS } from '../src/server.mjs';
import { startSetup } from '../src/setup.mjs';
import { readSetupHtml } from './helpers/setup-html.mjs';

test('MCP tools/list defaults to the 8-tool core surface and supports opt-in groups and full mode', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainlink-mcp-profile-'));
  try {
    await writeFile(path.join(dir, 'Welcome.md'), '# Welcome\n\nHello BrainLink.\n');
    const baseRaw = {
      vaults: [{ name: 'Main', path: dir }],
      agents: [{ name: 'Researcher', vault: 'Main', close_target: { mode: 'append-section', path: 'Welcome.md' } }],
      handoff: { vault: 'Main', folder: 'Inbox' },
    };

    const coreCfg = normalize(baseRaw);
    assert.equal(coreCfg.mcp.tool_profile, 'core');
    assert.deepEqual(coreCfg.mcp.enabled_groups, []);
    const coreMcp = createMcp(createContext(coreCfg));
    const coreNames = (await coreMcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
    assert.deepEqual(new Set(coreNames), CORE_MCP_TOOLS);
    assert.equal(coreNames.length, 8);
    assert.ok(!coreNames.includes('ingestion_queue'));
    assert.ok(!coreNames.includes('send_handoff'));
    assert.ok(!coreNames.includes('agent_connect_researcher'));

    const groupedCfg = normalize({ ...baseRaw, mcp: { tool_profile: 'core', enabled_groups: ['handoffs', 'agents'] } });
    const groupedMcp = createMcp(createContext(groupedCfg));
    const groupedNames = (await groupedMcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name);
    assert.ok(groupedNames.includes('send_handoff'));
    assert.ok(groupedNames.includes('list_handoffs'));
    assert.ok(groupedNames.includes('agent_connect'));
    assert.ok(groupedNames.includes('agent_connect_researcher'));
    assert.ok(!groupedNames.includes('ingestion_queue'));

    const fullCfg = normalize({ ...baseRaw, mcp: { tool_profile: 'full' } });
    const fullMcp = createMcp(createContext(fullCfg));
    const fullNames = (await fullMcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.map((t) => t.name);
    assert.ok(fullNames.length >= 25);
    assert.ok(fullNames.includes('ingestion_queue'));
    assert.ok(fullNames.includes('send_handoff'));
    assert.ok(fullNames.includes('agent_connect_researcher'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Setup API /api/mcp/profile persists tool_profile and enabled_groups, and Setup UI defaults to Simple 3-step mode with Advanced toggle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainlink-mcp-setup-'));
  const env = { BRAINLINK_HOME: path.join(dir, 'home'), HOME: dir, USERPROFILE: dir };
  const setup = await startSetup({ env, home: dir, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  try {
    const getRes = await fetch(`${base}/api/mcp/profile`, { headers: { 'X-BrainLink-Token': setup.token } });
    assert.equal(getRes.status, 200);
    const initial = await getRes.json();
    assert.equal(initial.tool_profile, 'core');
    assert.deepEqual(initial.enabled_groups, []);
    assert.equal(initial.core_tools.length, 8);

    const postRes = await fetch(`${base}/api/mcp/profile`, {
      method: 'POST',
      headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_profile: 'core', enabled_groups: ['handoffs', 'insights'] }),
    });
    assert.equal(postRes.status, 200);
    const updated = await postRes.json();
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.enabled_groups, ['handoffs', 'insights']);

    const fullRes = await fetch(`${base}/api/mcp/profile`, {
      method: 'POST',
      headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_profile: 'full', enabled_groups: [] }),
    });
    assert.equal(fullRes.status, 200);
    assert.equal((await fullRes.json()).tool_profile, 'full');

    const html = await readSetupHtml();
    assert.match(html, /id="advanced-mode-toggle"/);
    assert.match(html, /id="s-mcp-profile"/);
    assert.match(html, /let uiMode = 'simple';/);
    assert.match(html, /body\[data-ui-mode="simple"\] \[data-advanced-panel="true"\]/);
  } finally {
    await new Promise((resolve) => setup.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
