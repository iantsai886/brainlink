// src/mcp-agents.mjs: pure config transforms for user-added AI agents (RB7 item 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, validate } from '../src/config.mjs';
import { addAgent, renameAgent, removeAgent, revokeAgent, markConnected, findAgentByToken, publicAgent, hashToken, localAgentSnippet, remoteAgentSnippet } from '../src/mcp-agents.mjs';

test('addAgent: generates a token shown once, stores only its hash, defaults to kind local', () => {
  const cfg = normalize({});
  const { cfg: next, agent, token } = addAgent(cfg, { name: 'Grok Bot' });
  assert.equal(agent.kind, 'local');
  assert.equal(agent.connected, false);
  assert.equal(agent.revoked, false);
  assert.ok(token.length > 20);
  assert.equal(agent.tokenHash, hashToken(token));
  assert.notEqual(agent.tokenHash, token);
  assert.deepEqual(validate(next), []);
  assert.deepEqual(Object.keys(publicAgent(agent)).sort(), ['connected', 'createdAt', 'id', 'kind', 'lastSeenAt', 'name', 'revoked'].sort());
  assert.ok(!('tokenHash' in publicAgent(agent)), 'publicAgent must never expose the hash');
});

test('addAgent: rejects an empty name and a duplicate name (case-insensitive)', () => {
  const cfg = normalize({});
  assert.throws(() => addAgent(cfg, { name: '  ' }), /name/i);
  const { cfg: next } = addAgent(cfg, { name: 'Grok Bot' });
  assert.throws(() => addAgent(next, { name: 'grok bot' }), /already exists/);
});

test('addAgent: kind "remote" is accepted; anything else falls back to local', () => {
  const cfg = normalize({});
  assert.equal(addAgent(cfg, { name: 'A', kind: 'remote' }).agent.kind, 'remote');
  assert.equal(addAgent(cfg, { name: 'B', kind: 'nonsense' }).agent.kind, 'local');
});

test('findAgentByToken: matches the right agent, rejects wrong/empty tokens, ignores revoked agents', () => {
  const cfg = normalize({});
  const { cfg: c1, agent: a1, token: t1 } = addAgent(cfg, { name: 'Agent One' });
  const { cfg: c2, agent: a2, token: t2 } = addAgent(c1, { name: 'Agent Two' });
  assert.equal(findAgentByToken(c2, t1).id, a1.id);
  assert.equal(findAgentByToken(c2, t2).id, a2.id);
  assert.equal(findAgentByToken(c2, 'not-a-real-token'), null);
  assert.equal(findAgentByToken(c2, ''), null);
  assert.equal(findAgentByToken(c2, null), null);
  const revoked = revokeAgent(c2, a1.id);
  assert.equal(findAgentByToken(revoked, t1), null, 'a revoked token must never match again');
  assert.equal(findAgentByToken(revoked, t2).id, a2.id, 'revoking one agent must not affect another');
});

test('revoke: disables the token and clears connected, but keeps the agent (name/history) visible', () => {
  const cfg = normalize({});
  const { cfg: c1, agent } = addAgent(cfg, { name: 'Agent One' });
  const connected = markConnected(c1, agent.id);
  assert.equal(connected.ai_agents[0].connected, true);
  const revoked = revokeAgent(connected, agent.id);
  const a = revoked.ai_agents.find((x) => x.id === agent.id);
  assert.equal(a.revoked, true);
  assert.equal(a.connected, false);
  assert.equal(a.tokenHash, null);
  assert.equal(a.name, 'Agent One', 'removal is separate from revoke; the record stays until removed');
});

test('removeAgent: deletes the agent entirely; renameAgent: renames and rejects duplicates/unknown ids', () => {
  const cfg = normalize({});
  const { cfg: c1, agent: a1 } = addAgent(cfg, { name: 'Agent One' });
  const { cfg: c2, agent: a2 } = addAgent(c1, { name: 'Agent Two' });
  const renamed = renameAgent(c2, a1.id, 'Renamed One');
  assert.equal(renamed.ai_agents.find((a) => a.id === a1.id).name, 'Renamed One');
  assert.throws(() => renameAgent(renamed, a1.id, 'Agent Two'), /already exists/);
  assert.throws(() => renameAgent(renamed, 'nope', 'X'), /[Uu]nknown agent/);
  const removed = removeAgent(renamed, a1.id);
  assert.equal(removed.ai_agents.length, 1);
  assert.equal(removed.ai_agents[0].id, a2.id);
  assert.throws(() => removeAgent(removed, a1.id), /[Uu]nknown agent/);
});

test('markConnected: sets connected + lastSeenAt for the right agent only', () => {
  const cfg = normalize({});
  const { cfg: c1, agent: a1 } = addAgent(cfg, { name: 'Agent One' });
  const { cfg: c2, agent: a2 } = addAgent(c1, { name: 'Agent Two' });
  const next = markConnected(c2, a1.id, new Date('2026-10-21T00:00:00Z'));
  const got1 = next.ai_agents.find((a) => a.id === a1.id);
  const got2 = next.ai_agents.find((a) => a.id === a2.id);
  assert.equal(got1.connected, true);
  assert.equal(got1.lastSeenAt, '2026-10-21T00:00:00.000Z');
  assert.equal(got2.connected, false, 'unrelated agents stay untouched');
});

test('config validate: duplicate agent names and unknown kind are rejected', () => {
  const base = normalize({ ai_agents: [{ id: 'a', name: 'Dup', kind: 'local' }, { id: 'b', name: 'dup', kind: 'local' }] });
  const errors = validate(base);
  assert.ok(errors.some((e) => /duplicate agent/.test(e)));
  const bad = normalize({ ai_agents: [{ id: 'a', name: 'X', kind: 'cloud' }] });
  assert.ok(validate(bad).some((e) => /kind must be/.test(e)));
});

test('localAgentSnippet / remoteAgentSnippet: carry the real token, bind only to 127.0.0.1, no tunnels', () => {
  const cfg = normalize({});
  const { agent, token } = addAgent(cfg, { name: 'Local Tool' });
  const local = localAgentSnippet(agent, token, { command: '/usr/bin/node', args: ['/x/bin/brainlink.mjs', 'serve'] });
  const key = Object.keys(local.mcpServers)[0];
  assert.equal(local.mcpServers[key].env.BRAINLINK_AGENT_TOKEN, token);
  assert.equal(local.mcpServers[key].command, '/usr/bin/node');

  const remote = remoteAgentSnippet(agent, token, 8765);
  assert.match(remote.url, /^http:\/\/127\.0\.0\.1:8765\/mcp$/);
  assert.doesNotMatch(JSON.stringify(remote), /0\.0\.0\.0/);
  assert.equal(remote.headers.Authorization, `Bearer ${token}`);
});
