#!/usr/bin/env node
// Opt-in, two-client acceptance check. Uses only fictional temporary vaults and runs
// neither client until both authentication checks pass.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, saveConfig, validate } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { hashToken } from '../src/mcp-agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_CANARY = 'ZQX_CROSS_CLIENT_PRIVATE_CANARY_74d5c1';
const CLAUDE_TOKEN = 'fictional-claude-sender-token-bf82';
const CODEX_TOKEN = 'fictional-codex-receiver-token-920a';
const SUBJECT = 'Cross-client fictional project check';
const SOURCE_NOTE = 'Project-Brief.md';

function findExecutable(name, envName) {
  if (process.env[envName]?.trim()) return process.env[envName].trim();
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(locator, [name], { encoding: 'utf8', windowsHide: true });
  const executable = found.status === 0 ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
  if (!executable) throw new Error(`${name} CLI was not found. Install it or set ${envName} to its executable path.`);
  if (name === 'claude' && process.platform === 'win32') {
    return path.join(path.dirname(executable), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  }
  return executable;
}

function invoke(executable, args, { cwd, env, input = '', timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${path.basename(executable)} cross-client handoff timed out.`));
    }, timeoutMs);
    child.on('error', finish);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => finish(null, { code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function assertNoPrivateCanary(text, label) {
  assert.doesNotMatch(text, new RegExp(PRIVATE_CANARY), `${label} must not expose the private fixture`);
}

async function toolCall(mcp, name, args = {}) {
  const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(response.error, undefined, `${name} MCP request failed`);
  const result = response.result;
  const text = result?.content?.[0]?.text || '';
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  assert.notEqual(result?.isError, true, `${name} returned an MCP error`);
  return value;
}

function makeMcp(config, token, platform, appHome) {
  return createMcp(createContext(config, { env: {
    HOME: path.dirname(appHome), BRAINLINK_HOME: appHome, BRAINLINK_CONFIG: path.join(path.dirname(appHome), 'config.json'),
    BRAINLINK_AGENT_TOKEN: token, BRAINLINK_AI_PLATFORM: platform, BRAINLINK_SEMANTIC: '0',
  } }));
}

function requireClaudeLogin(executable) {
  const auth = spawnSync(executable, ['auth', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  let status = {};
  try { status = JSON.parse(auth.stdout || '{}'); } catch {}
  if (auth.status !== 0 || status.loggedIn !== true) throw new Error('Claude Code is not signed in. No fixture was created.');
}

function requireCodexLogin(executable) {
  const auth = spawnSync(executable, ['login', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (auth.status !== 0 || !/logged in/i.test(`${auth.stdout}\n${auth.stderr}`)) throw new Error('Codex CLI is not signed in. No fixture was created.');
}

async function main() {
  if (!process.argv.includes('--live')) {
    process.stdout.write('No run made. Pass --live after signing in to both Claude Code and Codex CLI. Only fictional temporary vaults are used.\n');
    return;
  }

  const claude = findExecutable('claude', 'CLAUDE_BIN');
  const codex = findExecutable('codex', 'CODEX_BIN');
  requireClaudeLogin(claude);
  requireCodexLogin(codex);

  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-live-cross-client-'));
  const company = path.join(root, 'fictional-company');
  const restricted = path.join(root, 'fictional-restricted');
  const mailbox = path.join(root, 'fictional-mailbox');
  const appHome = path.join(root, 'brainlink-home');
  const configPath = path.join(root, 'config.json');
  const claudeConfigPath = path.join(root, 'claude-mcp.json');
  const mailboxPath = path.join(mailbox, 'Handoffs');
  try {
    await Promise.all([company, restricted, mailboxPath, appHome].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(company, SOURCE_NOTE), '---\ntitle: Fictional project brief\n---\nProject code: ORCHID-41. Required response: the exact word READY and the source filename.\n', { flag: 'wx' });
    await writeFile(path.join(restricted, 'Private.md'), `---\nprivate: true\ntitle: Restricted fixture\n---\n${PRIVATE_CANARY}\n`, { flag: 'wx' });

    const config = normalize({
      version: 2,
      vaults: [
        { name: 'Fictional Company', path: company },
        { name: 'Fictional Restricted', path: restricted, private: true },
        { name: 'Fictional Handoff Mailbox', path: mailbox },
      ],
      handoff: { vault: 'Fictional Handoff Mailbox', folder: 'Handoffs' },
      ai_agents: [
        { id: 'claude_sender', name: 'Claude Code', tokenHash: hashToken(CLAUDE_TOKEN) },
        { id: 'codex_receiver', name: 'Codex CLI', tokenHash: hashToken(CODEX_TOKEN) },
      ],
      twin_profiles: [{
        id: 'fictional_org_twin', name: 'Fictional Organisation Twin', mode: 'organisation', owner: 'fixture-owner',
        vaults: [{ name: 'Fictional Company', access: 'propose' }, { name: 'Fictional Handoff Mailbox', access: 'propose' }],
        source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
        memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
        allowed_actions: ['search', 'read_note', 'handoff_read', 'write_handoff'],
        agent_access: [
          { agent_id: 'claude_sender', vaults: [
            { name: 'Fictional Company', access: 'propose', operations: ['search', 'read_note'] },
            { name: 'Fictional Handoff Mailbox', access: 'propose', operations: ['write_handoff'] },
          ] },
          { agent_id: 'codex_receiver', vaults: [
            { name: 'Fictional Company', access: 'propose', operations: ['search', 'read_note'] },
            { name: 'Fictional Handoff Mailbox', access: 'propose', operations: ['handoff_read', 'write_handoff'] },
          ] },
        ],
      }],
    });
    assert.deepEqual(validate(config), [], 'the fixture must grant only the two clients the required operations');
    await saveConfig(config, configPath);

    await writeFile(claudeConfigPath, JSON.stringify({ mcpServers: { brainlink: {
      command: process.execPath,
      args: [path.join(ROOT, 'bin', 'brainlink.mjs'), 'serve'],
      env: {
        BRAINLINK_HOME: appHome, BRAINLINK_CONFIG: configPath,
        BRAINLINK_AGENT_TOKEN: CLAUDE_TOKEN, BRAINLINK_AI_PLATFORM: 'Claude Code', BRAINLINK_SEMANTIC: '0',
      },
    } } }), { flag: 'wx' });

    const claudePrompt = [
      'Use only the BrainLink MCP tools for this fictional task. Do not use shell, filesystem, network, or other MCP tools.',
      `Call brainlink_guide, search the Fictional Company vault for ${SOURCE_NOTE}, and read only that note.`,
      `Send a handoff to Codex CLI with the exact subject "${SUBJECT}". Ask Codex to read the same cited note and reply with the exact required word and source filename. Include current_state and the exact source_refs entry "Fictional Company::${SOURCE_NOTE}", no claimed file changes, and no claimed tests. Preview first, then confirm using the exact preview path.`,
      'Return only the handoff path and a short confirmation. Never search or mention the restricted vault.',
    ].join('\n');
    const senderRun = await invoke(claude, [
      '--print', '--output-format', 'json', '--no-session-persistence', '--max-turns', '8',
      '--strict-mcp-config', '--mcp-config', claudeConfigPath,
      '--setting-sources', '', '--tools', '',
      '--allowedTools', 'mcp__brainlink__brainlink_guide,mcp__brainlink__vault_search,mcp__brainlink__vault_read_note,mcp__brainlink__send_handoff',
      claudePrompt,
    ], { cwd: root, env: process.env });
    assertNoPrivateCanary(`${senderRun.stdout}\n${senderRun.stderr}`, 'Claude sender');
    if (senderRun.code !== 0) throw new Error(`Claude sender failed with exit ${senderRun.code}.`);

    const receiver = makeMcp(config, CODEX_TOKEN, 'Codex', appHome);
    const senderMailbox = await toolCall(receiver, 'list_handoffs', { to: 'Codex CLI', limit: 10 });
    assert.ok(Array.isArray(senderMailbox), 'Codex must be able to read its handoff mailbox');
    const request = senderMailbox.find((item) => item.subject === SUBJECT && item.status === 'OPEN');
    assert.ok(request, 'Claude must send the exact fictional task to Codex');
    assert.deepEqual(request.source_refs, ['Fictional Company::Project-Brief.md']);
    assertNoPrivateCanary(JSON.stringify(senderMailbox), 'Claude mailbox receipt');

    const codexArgs = [
      'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', root,
      ...[
        ['mcp_servers.brainlink.command', JSON.stringify(process.execPath)],
        ['mcp_servers.brainlink.args', JSON.stringify([path.join(ROOT, 'bin', 'brainlink.mjs'), 'serve'])],
        ['mcp_servers.brainlink.enabled', 'true'],
        ['mcp_servers.brainlink.env.BRAINLINK_HOME', JSON.stringify(appHome)],
        ['mcp_servers.brainlink.env.BRAINLINK_CONFIG', JSON.stringify(configPath)],
        ['mcp_servers.brainlink.env.BRAINLINK_AGENT_TOKEN', JSON.stringify(CODEX_TOKEN)],
        ['mcp_servers.brainlink.env.BRAINLINK_AI_PLATFORM', JSON.stringify('Codex')],
        ['mcp_servers.brainlink.env.BRAINLINK_SEMANTIC', JSON.stringify('0')],
      ].flatMap(([key, value]) => ['-c', `${key}=${value}`]),
      '-',
    ];
    const codexPrompt = [
      'Use only the BrainLink MCP tools for this task. Do not use shell, filesystem, network, or any other MCP tools.',
      `Call brainlink_guide, then list_handoffs and select the open request with exact subject "${SUBJECT}".`,
      `Read only the cited ${SOURCE_NOTE} in Fictional Company using vault_read_note.`,
      'Send an append-only reply with the exact word READY and the source filename, set ack_of to the original request path, status to COMPLETED, and preview before confirming.',
      'Do not claim tests or file changes. Do not search or disclose private material. Return only a short result and reply path.',
    ].join('\n');
    const receiverRun = await invoke(codex, codexArgs, { cwd: root, env: process.env, input: codexPrompt });
    assertNoPrivateCanary(`${receiverRun.stdout}\n${receiverRun.stderr}`, 'Codex receiver');
    if (receiverRun.code !== 0) throw new Error(`Codex receiver failed with exit ${receiverRun.code}.`);

    const replies = await toolCall(receiver, 'list_handoffs', { limit: 10 });
    assert.ok(Array.isArray(replies), 'Codex must read the shared fictional mailbox');
    const reply = replies.find((item) => item.ack_of === request.path && item.status === 'COMPLETED');
    assert.ok(reply, 'Codex must complete the handoff and link its reply to the request');
    assert.match(reply.excerpt || '', /READY[\s\S]*Project-Brief\.md|Project-Brief\.md[\s\S]*READY/i);
    assertNoPrivateCanary(JSON.stringify(replies), 'Codex handoff results');
    process.stdout.write('PASS: signed-in Claude sent a fictional BrainLink handoff, signed-in Codex read the cited note and replied, and the private canary stayed hidden.\n');
    process.stdout.write('Scope: one live two-client turn with temporary fictional vaults; this does not prove customer acceptance or repeat reliability.\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
