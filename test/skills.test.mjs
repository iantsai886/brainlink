import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = 'brainlink-cross-ai-handoff';
const paths = [
  `skills/${SKILL}/SKILL.md`,
  `.agents/skills/${SKILL}/SKILL.md`,
  `.claude/skills/${SKILL}/SKILL.md`,
];

function parseSkill(text, relativePath) {
  // GitHub's Windows checkout can materialize committed LF files as CRLF.
  text = text.replace(/\r\n/g, '\n');
  assert.ok(text.startsWith('---\n'), `${relativePath}: frontmatter must start the file`);
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 4, `${relativePath}: frontmatter must close`);
  const lines = text.slice(4, end).split(/\r?\n/);
  const fields = {};
  let metadata = null;
  for (const line of lines) {
    if (/^metadata:\s*$/.test(line)) { metadata = {}; fields.metadata = metadata; continue; }
    const item = line.match(/^  ([a-z][a-z0-9-]*):\s*(?:"([^"\n]*)"|([^\r\n]+))\s*$/);
    if (item && metadata) { metadata[item[1]] = item[2] ?? item[3].trim(); continue; }
    const field = line.match(/^([a-z][a-z0-9-]*):\s*(.+)$/);
    if (field) { metadata = null; fields[field[1]] = field[2]; }
  }
  const directory = path.basename(path.dirname(relativePath));
  assert.equal(fields.name, directory, `${relativePath}: skill name must match its directory`);
  assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(fields.name.length <= 64);
  assert.ok(fields.description.length > 0 && fields.description.length <= 1024);
  assert.ok(!fields.compatibility || fields.compatibility.length <= 500);
  assert.ok(Object.values(fields.metadata || {}).every((value) => typeof value === 'string'));
  return { fields, body: text.slice(end + 5) };
}

test('portable handoff Skill follows Agent Skills manifest constraints and supports connected MCP clients', async () => {
  const contents = await Promise.all(paths.map((file) => readFile(path.join(ROOT, file), 'utf8')));
  assert.equal(new Set(contents).size, 1, 'canonical and client discovery copies must stay byte-identical');
  const { fields, body } = parseSkill(contents[0], paths[0]);
  assert.equal(fields.metadata.version, '0.3.0');
  assert.equal(fields.metadata.owner, 'Iango');
  for (const client of ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Google Antigravity', 'Hermes Agent', 'DeepSeek Harness']) assert.ok(fields.metadata['applicable-clients'].includes(client), client);
  assert.match(fields.metadata['test-status'], /Local fictional MCP handoff and Git checkpoint fixtures pass/);
  assert.match(fields.metadata['test-status'], /live behavior must be validated for each client/);
  assert.match(body, /confirm=false/);
  assert.match(body, /confirm=true/);
  assert.match(body, /private-note contents/);
  assert.match(body, /untrusted project data/);
  assert.match(body, /ack_of/);
});

test('portable Raw-to-Wiki Skill is identical for Claude Code and Codex and requires preview approval before filing', async () => {
  const id = 'brainlink-raw-to-wiki';
  const skillPaths = [`skills/${id}/SKILL.md`, `.agents/skills/${id}/SKILL.md`, `.claude/skills/${id}/SKILL.md`];
  const contents = await Promise.all(skillPaths.map((file) => readFile(path.join(ROOT, file), 'utf8')));
  assert.equal(new Set(contents).size, 1, 'canonical skill and client copies must stay byte-identical');
  const { fields, body } = parseSkill(contents[0], skillPaths[0]);
  assert.equal(fields.metadata.version, '1.0.0');
  assert.match(fields.metadata['applicable-clients'], /Any AI client/);
  for (const tool of ['brainlink_guide', 'ingestion_queue', 'vault_read_note', 'vault_search', 'propose_note', 'ingestion_record']) assert.ok(fields.compatibility.includes(tool) || fields.metadata['required-tools'].includes(tool), tool);
  assert.match(body, /single folder/);
  assert.match(body, /confirm=false/);
  assert.match(body, /clearly approves/);
  assert.match(body, /After BrainLink confirms the note was actually saved/);
  assert.match(body, /scheduled scan only detects changed-file metadata/);
  assert.match(body, /content-free/);
});

test('portable session-closeout Skill is identical across clients and preserves privacy and save receipts', async () => {
  const id = 'brainlink-session-closeout';
  const skillPaths = [`skills/${id}/SKILL.md`, `.agents/skills/${id}/SKILL.md`, `.claude/skills/${id}/SKILL.md`];
  const contents = await Promise.all(skillPaths.map((file) => readFile(path.join(ROOT, file), 'utf8')));
  assert.equal(new Set(contents).size, 1, 'canonical skill and client copies must stay byte-identical');
  const { fields, body } = parseSkill(contents[0], skillPaths[0]);
  assert.equal(fields.metadata.version, '1.1.0');
  assert.match(fields.metadata['applicable-clients'], /Any AI client/);
  for (const tool of ['brainlink_guide', 'session_close', 'vault_search', 'vault_read_note', 'propose_note']) assert.ok(fields.compatibility.includes(tool) || fields.metadata['required-tools'].includes(tool), tool);
  assert.match(body, /session_close/);
  assert.match(body, /confirm=false/);
  assert.match(body, /confirm=true/);
  assert.match(body, /never guess across Personal, Organisation, or Client boundaries/);
  assert.match(body, /Never read a transcript just because a hook provides its path/);
  assert.match(body, /both the `written` and `session_saved` fields/);
  assert.match(body, /Do not promote an AI-reported outcome to verified semantic knowledge/);
  assert.match(body, /Working:/);
  assert.match(body, /Episodic:/);
  assert.match(body, /Semantic:/);
  assert.match(body, /Procedural:/);
  assert.match(body, /Do not create a duplicate episode note/);
  assert.match(body, /at most three strong semantic or procedural candidates/);
  assert.match(body, /saving a session does not authorize these additional durable notes/i);
  assert.match(body, /If no durable candidate qualifies, say none was proposed/);
});

test('portable graph-curation Skill keeps entities separate, scoped, evidence-backed and review-gated', async () => {
  const id = 'brainlink-graph-curation';
  const skillPaths = [`skills/${id}/SKILL.md`, `.agents/skills/${id}/SKILL.md`, `.claude/skills/${id}/SKILL.md`];
  const contents = await Promise.all(skillPaths.map((file) => readFile(path.join(ROOT, file), 'utf8')));
  assert.equal(new Set(contents).size, 1, 'canonical skill and client copies must stay byte-identical');
  const { fields, body } = parseSkill(contents[0], skillPaths[0]);
  assert.equal(fields.metadata.version, '1.0.0');
  assert.match(fields.metadata['applicable-clients'], /Any AI client/);
  for (const tool of ['brainlink_guide', 'vault_search', 'vault_read_note', 'propose_note']) assert.ok(fields.compatibility.includes(tool) || fields.metadata['required-tools'].includes(tool), tool);
  for (const type of ['person', 'team', 'workflow', 'dataset', 'artifact', 'project', 'policy', 'concept']) assert.ok(body.includes('`' + type + '`'), type);
  assert.match(body, /one vault/);
  assert.match(body, /short exact source excerpt/);
  assert.match(body, /stores new typed entities and relationships as proposed/i);
  assert.match(body, /confirm=false/);
  assert.match(body, /wait for the user's approval/);
  assert.match(body, /do not link to it yet/);
  assert.match(body, /Never cross Personal, Organisation, and Client boundaries/);
  assert.match(body, /Do not claim token savings/);
});
