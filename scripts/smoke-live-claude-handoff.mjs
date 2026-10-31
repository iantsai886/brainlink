#!/usr/bin/env node
// Opt-in live acceptance check. Uses the signed-in Claude Code account for one model turn,
// an ephemeral MCP config, and fictional temporary vaults only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, saveConfig, validate } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { hashToken } from '../src/mcp-agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_CANARY = 'ZQX_LIVE_CLAUDE_PRIVATE_CANARY_41ce72';
const SENDER_TOKEN = 'fictional-codex-token-8a120e';
const CLAUDE_TOKEN = 'fictional-claude-token-1b63c9';
const SUBJECT = 'Read fictional project brief and reply';
const SOURCE_NOTE = 'Project-Brief.md';

function resolveClaude() {
  if (process.env.CLAUDE_BIN?.trim()) return process.env.CLAUDE_BIN.trim();
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(locator, ['claude'], { encoding: 'utf8', windowsHide: true });
  const cli = found.status === 0 ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
  if (!cli) throw new Error('Claude Code CLI was not found. Install it or set CLAUDE_BIN to its executable path.');
  if (process.platform !== 'win32') return cli;
  const executable = path.join(path.dirname(cli), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return executable;
}

function invoke(executable, args, { cwd, env, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Claude live handoff timed out after three minutes.'));
    }, timeoutMs);
    child.on('error', finish);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => finish(null, { code, stdout, stderr }));
  });
}

async function toolCall(mcp, name, args = {}) {
  const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(response.error, undefined, `${name} MCP request failed`);
  const result = response.result;
  const text = result?.content?.[0]?.text || '';
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { isError: result.isError, value };
}

function makeMcp(config, token, platform, appHome) {
  return createMcp(createContext(config, { env: {
    HOME: path.dirname(appHome), BRAINLINK_HOME: appHome, BRAINLINK_CONFIG: path.join(path.dirname(appHome), 'config.json'),
    BRAINLINK_AGENT_TOKEN: token, BRAINLINK_AI_PLATFORM: platform, BRAINLINK_SEMANTIC: '0',
  } }));
}

async function main() {
  if (!process.argv.includes('--live')) {
    process.stdout.write('No run made. Pass --live to use one signed-in Claude model turn with fictional temporary vaults.\n');
    return;
  }

  const claude = resolveClaude();
  const auth = spawnSync(claude, ['auth', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  let authStatus = {};
  try { authStatus = JSON.parse(auth.stdout || '{}'); } catch {}
  if (auth.status !== 0 || authStatus.loggedIn !== true) {
    throw new Error('Claude Code is not signed in. No BrainLink fixture was created or sent. Sign in, then rerun this opt-in check.');
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-live-claude-handoff-'));
  const company = path.join(root, 'fictional-company');
  const restricted = path.join(root, 'fictional-restricted');
  const mailbox = path.join(root, 'fictional-mailbox');
  const appHome = path.join(root, 'brainlink-home');
  const configPath = path.join(root, 'config.json');
  const mcpConfigPath = path.join(root, 'mcp.json');
  const mailboxPath = path.join(mailbox, 'Handoffs');
  try {
    await Promise.all([company, restricted, mailboxPath, appHome].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(company, SOURCE_NOTE), '---\ntitle: Fictional project brief\n---\nProject code: ORCHID-41. Required response: the exact word READY and the source filename. Do not change any files.\n', { flag: 'wx' });
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
        { id: 'fixture_sender', name: 'Codex CLI', tokenHash: hashToken(SENDER_TOKEN) },
        { id: 'fixture_claude', name: 'Claude Code', tokenHash: hashToken(CLAUDE_TOKEN) },
      ],
      twin_profiles: [{
        id: 'fictional_org_twin', name: 'Fictional Organisation Twin', mode: 'organisation', owner: 'fixture-owner',
        vaults: [{ name: 'Fictional Company', access: 'propose' }, { name: 'Fictional Handoff Mailbox', access: 'propose' }],
        source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
        memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
        allowed_actions: ['search', 'read_note', 'handoff_read', 'write_handoff'],
        agent_access: ['fixture_sender', 'fixture_claude'].map((agent_id) => ({
          agent_id,
          vaults: [
            { name: 'Fictional Company', access: 'propose', operations: ['search', 'read_note'] },
            { name: 'Fictional Handoff Mailbox', access: 'propose', operations: ['handoff_read', 'write_handoff'] },
          ],
        })),
      }],
    });
    assert.deepEqual(validate(config), [], 'the fictional handoff profile must have valid explicit grants');
    await saveConfig(config, configPath);

    const sender = makeMcp(config, SENDER_TOKEN, 'Codex', path.join(root, 'sender-home'));
    const payload = {
      to: 'Claude Code', subject: SUBJECT,
      goal: 'Read the fictional project brief and return the exact response word and source filename.',
      current_state: 'The fictional project note is ready. No files should be changed.',
      decisions: ['Use only the fictional company vault and the handoff mailbox.'],
      modified_files: [], tests: ['No software tests were run for this read-only fixture task.'],
      open_questions: [], next_steps: ['Read the source note and send a reply with the observed word and filename.'],
      source_refs: ['Fictional Company::Project-Brief.md'], scope: 'company', confidence: 'verified',
      ai_platform: 'Codex', agent_or_role: 'fictional fixture sender', session_or_task_id: 'live-claude-smoke',
    };
    const preview = await toolCall(sender, 'send_handoff', { ...payload, confirm: false });
    assert.equal(preview.value.ok, true, 'sender preview must pass');
    assert.equal(preview.value.written, false, 'preview must not write');
    const sent = await toolCall(sender, 'send_handoff', { ...payload, preview_path: preview.value.path, confirm: true });
    assert.equal(sent.value.written, true, 'fixture handoff must be written to the temporary mailbox');

    const mcpConfig = {
      mcpServers: { brainlink: {
        command: process.execPath,
        args: [path.join(ROOT, 'bin', 'brainlink.mjs'), 'serve'],
        env: {
          BRAINLINK_HOME: appHome,
          BRAINLINK_CONFIG: configPath,
          BRAINLINK_AGENT_TOKEN: CLAUDE_TOKEN,
          BRAINLINK_AI_PLATFORM: 'Claude Code',
          BRAINLINK_SEMANTIC: '0',
        },
      } },
    };
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { flag: 'wx' });
    const prompt = [
      'Use only the BrainLink MCP tools for this task. Do not use shell, filesystem, network, or any other MCP tools.',
      '1. Call brainlink_guide, then list_handoffs for recipient "Claude Code" and select the request with this exact subject:',
      SUBJECT,
      `2. Read only the cited source note ${SOURCE_NOTE} from the Fictional Company vault using vault_read_note.`,
      '3. The note asks for the exact word READY and the source filename. Send an append-only reply using send_handoff. Set ack_of to the exact request path returned by list_handoffs, set status to COMPLETED, and include the observed word and filename in current_state. Preview first, then confirm using the exact preview_path returned by BrainLink.',
      '4. In the reply current_state, report the observed word and filename. Do not claim tests or file changes. Do not open other vaults or disclose private material.',
      'Return a one-line summary of the result and the handoff path.',
    ].join('\n');
    const run = await invoke(claude, [
      '--print', '--output-format', 'json', '--no-session-persistence', '--max-turns', '8',
      '--strict-mcp-config', '--mcp-config', mcpConfigPath,
      '--setting-sources', '', '--tools', '',
      '--allowedTools', 'mcp__brainlink__brainlink_guide,mcp__brainlink__list_handoffs,mcp__brainlink__vault_read_note,mcp__brainlink__send_handoff',
      prompt,
    ], { cwd: root, env: process.env });
    assert.doesNotMatch(run.stdout, new RegExp(PRIVATE_CANARY), 'private canary must not reach Claude output');
    assert.doesNotMatch(run.stderr, new RegExp(PRIVATE_CANARY), 'private canary must not reach Claude diagnostics');
    if (run.code !== 0) throw new Error(`Claude live handoff failed (exit ${run.code}); stderr: ${run.stderr.slice(-1200)}`);
    let result;
    try { result = JSON.parse(run.stdout); } catch { throw new Error('Claude returned an unreadable JSON result.'); }

    const recipient = makeMcp(config, CLAUDE_TOKEN, 'Claude Code', appHome);
    const replies = await toolCall(recipient, 'list_handoffs', { limit: 10 });
    assert.ok(Array.isArray(replies.value), 'Claude must be able to read the mailbox');
    const reply = replies.value.find((item) => item.ack_of === sent.value.path && item.status === 'COMPLETED');
    assert.ok(reply, `Claude must append a COMPLETED reply linked to the request; statuses: ${replies.value.map((item) => `${item.status || 'unknown'}:linked=${item.ack_of === sent.value.path}`).join(', ') || 'none'}`);
    assert.match(reply.excerpt || '', /READY[\s\S]*Project-Brief\.md|Project-Brief\.md[\s\S]*READY/i, 'reply must contain both the observed answer and source filename');
    assert.doesNotMatch(JSON.stringify(replies.value), new RegExp(PRIVATE_CANARY), 'private canary must not enter handoff results');
    process.stdout.write('PASS: signed-in Claude Code used the BrainLink MCP server, read the fictional handoff/source, and saved a scoped reply; the private canary stayed hidden.\n');
    process.stdout.write('Scope: one ephemeral model turn with temporary fictional vaults. This does not validate a Codex sender, production notes, or user acceptance.\n');
    if (result.result) process.stdout.write(`Claude result: ${String(result.result).slice(0, 300)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
