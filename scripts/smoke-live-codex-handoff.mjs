#!/usr/bin/env node
// Opt-in live acceptance check. Uses the signed-in Codex account for one model turn,
// an ephemeral Codex session, and fictional temporary vaults only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, saveConfig, validate } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { hashToken } from '../src/mcp-agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_CANARY = 'ZQX_LIVE_CODEX_PRIVATE_CANARY_8bd9f0';
const SENDER_TOKEN = 'fictional-sender-token-4f093e';
const CODEX_TOKEN = 'fictional-codex-token-8cc109';
const SUBJECT = 'Read fictional project brief and reply';
const SOURCE_NOTE = 'Project-Brief.md';

function resolveCodex() {
  if (process.env.CODEX_BIN?.trim()) return process.env.CODEX_BIN.trim();
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(locator, ['codex'], { encoding: 'utf8', windowsHide: true });
  const executable = found.status === 0 ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
  if (!executable) throw new Error('Codex CLI was not found. Install it or set CODEX_BIN to its executable path.');
  return executable;
}

function invoke(executable, args, { cwd, env, input, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Codex live handoff timed out after three minutes.'));
    }, timeoutMs);
    child.on('error', finish);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => finish(null, { code, stdout, stderr }));
    child.stdin.end(input);
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

function safeEventSummary(stdout) {
  const summary = [];
  const sendCalls = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item || event;
    const toolName = item.name || item.tool_name || item.tool;
    summary.push([event.type, item.type, typeof toolName === 'string' ? toolName : null].filter(Boolean).join(':'));
    if (item.type === 'mcp_tool_call' && toolName === 'send_handoff') {
      let args = item.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const result = item.result || item.output || {};
      let structured = result.structured_content || result.structuredContent || {};
      if (!Object.keys(structured).length && Array.isArray(result.content)) {
        const text = result.content.find((part) => part.type === 'text')?.text;
        try { structured = JSON.parse(text || '{}'); } catch { structured = {}; }
      }
      const safeStatus = typeof structured.status === 'string' && /^[A-Z_]{2,24}$/.test(structured.status) ? structured.status : 'unknown';
      const errorPresent = Boolean(item.error || structured.error || result.isError === true);
      const requestedStatus = typeof args.status === 'string' && /^[A-Z_]{2,24}$/.test(args.status) ? args.status : 'omitted';
      sendCalls.push(`confirm=${args.confirm === true ? 'true' : args.confirm === false ? 'false' : 'missing'},ack_of=${typeof args.ack_of === 'string' ? 'present' : 'missing'},requested=${requestedStatus},failed=${errorPresent},written=${structured.written === true ? 'true' : structured.written === false ? 'false' : 'unknown'},ok=${structured.ok === true ? 'true' : structured.ok === false ? 'false' : 'unknown'},status=${safeStatus},resultKeys=${Object.keys(structured).sort().join('.')}`);
    }
  }
  const tools = [...new Set(summary)].slice(0, 20).join(', ') || 'no structured events captured';
  return `${tools}; send_handoff calls: ${sendCalls.join(' | ') || 'none'}`;
}

async function main() {
  if (!process.argv.includes('--live')) {
    process.stdout.write('No run made. Pass --live to use one signed-in Codex model turn with fictional temporary vaults.\n');
    return;
  }

  const codex = resolveCodex();
  const auth = spawnSync(codex, ['login', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (auth.status !== 0 || !/logged in/i.test(`${auth.stdout}\n${auth.stderr}`)) {
    throw new Error('Codex CLI is not signed in. No BrainLink fixture was sent.');
  }

  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-live-codex-handoff-'));
  const company = path.join(root, 'fictional-company');
  const restricted = path.join(root, 'fictional-restricted');
  const mailbox = path.join(root, 'fictional-mailbox');
  const appHome = path.join(root, 'brainlink-home');
  const configPath = path.join(root, 'config.json');
  const mailboxPath = path.join(mailbox, 'Handoffs');
  try {
    await Promise.all([company, restricted, mailboxPath, appHome].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(company, SOURCE_NOTE), '---\ntitle: Fictional project brief\n---\nProject code: ORCHID-41. Required response: the exact word READY and the source filename. Do not change any files.\n');
    await writeFile(path.join(restricted, 'Private.md'), `---\nprivate: true\ntitle: Restricted fixture\n---\n${PRIVATE_CANARY}\n`);

    const config = normalize({
      version: 2,
      vaults: [
        { name: 'Fictional Company', path: company },
        { name: 'Fictional Restricted', path: restricted, private: true },
        { name: 'Fictional Handoff Mailbox', path: mailbox },
      ],
      handoff: { vault: 'Fictional Handoff Mailbox', folder: 'Handoffs' },
      ai_agents: [
        { id: 'fixture_sender', name: 'Fictional Claude Code', tokenHash: hashToken(SENDER_TOKEN) },
        { id: 'fixture_codex', name: 'Codex CLI', tokenHash: hashToken(CODEX_TOKEN) },
      ],
      twin_profiles: [{
        id: 'fictional_org_twin', name: 'Fictional Organisation Twin', mode: 'organisation', owner: 'fixture-owner',
        vaults: [{ name: 'Fictional Company', access: 'propose' }, { name: 'Fictional Handoff Mailbox', access: 'propose' }],
        source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
        memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
        allowed_actions: ['search', 'read_note', 'handoff_read', 'write_handoff'],
        agent_access: ['fixture_sender', 'fixture_codex'].map((agent_id) => ({
          agent_id,
          vaults: [
            { name: 'Fictional Company', access: 'propose', operations: ['search', 'read_note'] },
            { name: 'Fictional Handoff Mailbox', access: 'propose', operations: ['handoff_read', 'write_handoff'] },
          ],
        })),
      }],
    });
    assert.deepEqual(validate(config), [], 'the fictional handoff profiles must have valid explicit grants');
    await saveConfig(config, configPath);

    const sender = makeMcp(config, SENDER_TOKEN, 'Claude Code', path.join(root, 'sender-home'));
    const payload = {
      to: 'Codex CLI', subject: SUBJECT,
      goal: 'Read the fictional project brief and return the exact response word and source filename.',
      current_state: 'The fictional project note is ready. No files should be changed.',
      decisions: ['Use only the fictional company vault and the handoff mailbox.'],
      modified_files: [], tests: ['No software tests were run for this read-only fixture task.'],
      open_questions: [], next_steps: ['Read the source note and send a reply with the observed word and filename.'],
      source_refs: ['Fictional Company::Project-Brief.md'], scope: 'company', confidence: 'verified',
      ai_platform: 'Claude Code', agent_or_role: 'fictional fixture sender', session_or_task_id: 'live-codex-smoke',
    };
    const preview = await toolCall(sender, 'send_handoff', { ...payload, confirm: false });
    assert.equal(preview.value.ok, true, 'sender preview must pass');
    assert.equal(preview.value.written, false, 'preview must not write');
    const sent = await toolCall(sender, 'send_handoff', { ...payload, preview_path: preview.value.path, confirm: true });
    assert.equal(sent.value.written, true, 'fixture handoff must be written to the temporary mailbox');

    const configOverrides = [
      ['mcp_servers.brainlink.command', JSON.stringify(process.execPath)],
      ['mcp_servers.brainlink.args', JSON.stringify([path.join(ROOT, 'bin', 'brainlink.mjs'), 'serve'])],
      ['mcp_servers.brainlink.enabled', 'true'],
      ['mcp_servers.brainlink.env.BRAINLINK_HOME', JSON.stringify(appHome)],
      ['mcp_servers.brainlink.env.BRAINLINK_CONFIG', JSON.stringify(configPath)],
      ['mcp_servers.brainlink.env.BRAINLINK_AGENT_TOKEN', JSON.stringify(CODEX_TOKEN)],
      ['mcp_servers.brainlink.env.BRAINLINK_AI_PLATFORM', JSON.stringify('Codex')],
      ['mcp_servers.brainlink.env.BRAINLINK_SEMANTIC', JSON.stringify('0')],
    ].flatMap(([key, value]) => ['-c', `${key}=${value}`]);
    const prompt = [
      'Use only the BrainLink MCP tools for this task. Do not use shell, filesystem, network, or any other MCP tools.',
      '1. Call brainlink_guide, then list_handoffs for recipient "Codex CLI" and select the request with this exact subject:',
      SUBJECT,
      `2. Read only the cited source note ${SOURCE_NOTE} from the Fictional Company vault using vault_read_note.`,
      '3. The note asks for the exact word READY and the source filename. Send an append-only reply using send_handoff. Set ack_of to the exact request path returned by list_handoffs, set status to COMPLETED, and include the observed word and filename in current_state. Preview first, then confirm using the exact preview_path returned by BrainLink.',
      '4. In the reply current_state, report the observed word and filename. Do not claim tests or file changes. Do not open other vaults or disclose private material.',
      'Return a one-line summary of the result and the handoff path.',
    ].join('\n');
    const run = await invoke(codex, [
      'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
      '--json', '-C', root, ...configOverrides, '-',
    ], { cwd: root, env: process.env, input: prompt });
    if (run.code !== 0) throw new Error(`Codex live handoff failed (exit ${run.code}); safe event summary: ${safeEventSummary(run.stdout)}.`);
    assert.doesNotMatch(run.stdout, new RegExp(PRIVATE_CANARY), 'private canary must not reach Codex output');

    const recipient = makeMcp(config, CODEX_TOKEN, 'Codex', appHome);
    // Replies are addressed back to the sender, so query this profile's mailbox without a recipient filter.
    const replies = await toolCall(recipient, 'list_handoffs', { limit: 10 });
    assert.ok(Array.isArray(replies.value), 'Codex must be able to read the mailbox');
    const reply = replies.value.find((item) => item.ack_of === sent.value.path && item.status === 'COMPLETED');
    assert.ok(reply, `Codex must append a COMPLETED reply linked to the original request; reply statuses: ${replies.value.map((item) => `${item.status || 'unknown'}:linked=${item.ack_of === sent.value.path}`).join(', ') || 'none'}; safe event summary: ${safeEventSummary(run.stdout)}`);
    assert.match(reply.excerpt || '', /READY[\s\S]*Project-Brief\.md|Project-Brief\.md[\s\S]*READY/i, 'reply must contain both the observed answer and source filename');
    assert.doesNotMatch(JSON.stringify(replies.value), new RegExp(PRIVATE_CANARY), 'private canary must not enter handoff results');
    process.stdout.write('PASS: signed-in Codex used the BrainLink MCP server, read the fictional handoff/source, and saved a scoped reply; the private canary stayed hidden.\n');
    process.stdout.write('Scope: one ephemeral model turn with temporary fictional vaults. This does not validate a Claude sender, production notes, or user acceptance.\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
