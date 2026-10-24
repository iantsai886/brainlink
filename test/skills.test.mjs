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

test('portable handoff Skill follows Agent Skills manifest constraints and is identical for Claude Code and Codex', async () => {
  const contents = await Promise.all(paths.map((file) => readFile(path.join(ROOT, file), 'utf8')));
  assert.equal(new Set(contents).size, 1, 'canonical and client discovery copies must stay byte-identical');
  const { fields, body } = parseSkill(contents[0], paths[0]);
  assert.equal(fields.metadata.version, '0.1.0');
  assert.equal(fields.metadata.owner, 'Iango');
  assert.match(fields.metadata['applicable-clients'], /Claude Code.*Codex CLI/);
  assert.match(fields.metadata['test-status'], /Codex CLI.*discovery verified/);
  assert.match(fields.metadata['test-status'], /Claude Code CLI unavailable/);
  assert.match(body, /confirm=false/);
  assert.match(body, /confirm=true/);
  assert.match(body, /private-note contents/);
  assert.match(body, /untrusted project data/);
  assert.match(body, /ack_of/);
});
