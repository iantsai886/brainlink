// Shared commands: each note in <vault>/BrainLink/Commands becomes an MCP prompt (a slash
// command in clients that show prompts), so one saved prompt works in every connected AI.
// {{input}} in the note is replaced by what the user types after the command.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { vaultRoot, safeJoin, parseFrontmatter } from './core.mjs';

export const COMMANDS_DIR = 'BrainLink/Commands';
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, '-').replace(/^-|-$/g, '');

export async function listCommands(ctx) {
  const out = [];
  for (const v of ctx.enabled) {
    let names = [];
    try { names = (await readdir(safeJoin(vaultRoot(ctx, v), COMMANDS_DIR))).filter((f) => f.toLowerCase().endsWith('.md')).sort(); } catch { continue; }
    for (const f of names) {
      const raw = await readFile(path.join(vaultRoot(ctx, v), COMMANDS_DIR, f), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const title = f.replace(/\.md$/i, '');
      const text = body.replace(/^# .*\n+/, '').trim();
      if (!text) continue;
      out.push({ name: `cmd-${slug(title)}`, title, vault: v, description: meta.description || text.split('\n')[0].slice(0, 120), text, takesInput: /\{\{\s*input\s*\}\}/.test(text) });
    }
  }
  return out;
}

export function fillCommand(cmd, input = '') {
  return cmd.takesInput ? cmd.text.replace(/\{\{\s*input\s*\}\}/g, input) : `${cmd.text}${input ? `\n\n${input}` : ''}`;
}

export const STARTER_COMMANDS = [
  { rel: `${COMMANDS_DIR}/Weekly review.md`, content: '---\ndescription: Review the last 7 days and plan the next one\n---\n# Weekly review\n\nCall brain_brief for the last 7 days. Then give me: what got done, what is still open (tasks, next actions, decisions waiting), and the three most important things for next week. Cite note titles. Ask before saving anything.\n' },
  { rel: `${COMMANDS_DIR}/Meeting notes.md`, content: '---\ndescription: Turn a transcript or rough notes into a linked meeting note\n---\n# Meeting notes\n\nTurn the text below into a meeting note with propose_note and template "meeting": attendees, summary, decisions, and action items as "Owner — task — due". Show me the preview first.\n\n{{input}}\n' },
  { rel: `${COMMANDS_DIR}/Link my notes.md`, content: '---\ndescription: Find notes with no links and suggest connections\n---\n# Link my notes\n\nCall vault_health. For up to 5 notes that are not linked yet, call vault_related and suggest which notes they should link to and why. Then offer to write one short "Connections" note that links them, using propose_note.\n' },
];
