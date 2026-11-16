// Setup self-test: deterministic checks that the configured second brain is actually usable
// by the AIs connected to it. It reads only what an AI connection could be pointed at
// (read-first rules, role notes, the mailbox, excluded folders) and never changes anything.
// Each check is pass | warn | fail with a plain message the owner can act on.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readNote, readExcludedFolders } from './core.mjs';

// Text the starter packs write into scaffolded notes. A role whose notes still say this is
// loading a template, not the owner's real context.
const TEMPLATE_MARKERS = ['(write the one goal that matters this quarter)', '(one action)'];
const TOOL_FOLDERS = /^(\.|node_modules\/)/;

const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);

async function countMarkdown(dir, cap = 200, depth = 0) {
  if (depth > 6) return 0;
  let n = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (n >= cap) break;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) n += await countMarkdown(path.join(dir, entry.name), cap - n, depth + 1);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) n++;
  }
  return n;
}

async function readable(ctx, vault, rel) {
  try { return { ok: true, note: await readNote(ctx, vault, rel) }; }
  catch (error) { return { ok: false, reason: error.code === 'ENOENT' ? 'missing' : /private/i.test(error.message) ? 'hidden' : 'unreadable' }; }
}

const reasonText = { missing: 'does not exist', hidden: 'is hidden from AIs (private, or inside a folder on this vault\'s excluded list)', unreadable: 'could not be read' };

export async function runSelfTest(ctx) {
  const { cfg } = ctx;
  const checks = [];
  const add = (id, status, message, extra = {}) => checks.push({ id, status, message, ...extra });

  if (!cfg.vaults.length) add('vaults', 'fail', 'No vault is configured yet.');
  for (const v of cfg.vaults) {
    if (!(await isDir(v.path))) { add('vault-folder', 'fail', `Vault "${v.name}": its folder is missing or not reachable.`, { vault: v.name }); continue; }
    if (!ctx.enabled.includes(v.name)) continue;

    for (const rel of v.read_first || []) {
      const r = await readable(ctx, v.name, rel);
      add('read-first', r.ok ? 'pass' : 'fail', r.ok
        ? `Vault "${v.name}": AIs can read the rule note "${rel}".`
        : `Vault "${v.name}": AIs are told to read "${rel}" first, but it ${reasonText[r.reason]}.`, { vault: v.name, path: rel });
    }

    if (!v.flat && v.intake_folder) {
      const ok = await isDir(path.join(v.path, v.intake_folder));
      add('intake-folder', ok ? 'pass' : 'warn', ok
        ? `Vault "${v.name}": the intake folder "${v.intake_folder}" exists.`
        : `Vault "${v.name}": the intake folder "${v.intake_folder}" does not exist yet; the first proposed note will create it. If this vault already has an intake folder under another name, point BrainLink at that one.`, { vault: v.name, path: v.intake_folder });
    }

    const excluded = (await readExcludedFolders(v.path)).active;
    for (const folder of excluded) {
      if (TOOL_FOLDERS.test(folder)) continue;
      const count = await countMarkdown(path.join(v.path, folder));
      if (count > 0) add('excluded-notes', 'warn', `Vault "${v.name}": the excluded folder "${folder}" holds ${count >= 200 ? '200 or more' : count} note${count === 1 ? '' : 's'} that no AI can search or read. Keep it excluded only if that is intended.`, { vault: v.name, path: folder, notes: count });
    }
  }

  for (const agent of ctx.agents || []) {
    if (!ctx.enabled.includes(agent.vault)) { add('role-vault', 'fail', `Role "${agent.name}": its vault "${agent.vault}" is not available.`, { agent: agent.name }); continue; }
    const notes = agent.connect_notes || [];
    if (!notes.length) add('role-notes', 'warn', `Role "${agent.name}" loads no notes when it is activated.`, { agent: agent.name });
    for (const rel of notes) {
      const r = await readable(ctx, agent.vault, rel);
      if (!r.ok) { add('role-notes', 'fail', `Role "${agent.name}": its activation note "${rel}" ${reasonText[r.reason]}.`, { agent: agent.name, path: rel }); continue; }
      const template = TEMPLATE_MARKERS.some((marker) => r.note.body.includes(marker));
      add('role-notes', template ? 'warn' : 'pass', template
        ? `Role "${agent.name}": "${rel}" still contains BrainLink's starter template text, so the role starts without your real context. Fill it in, or point the role at the note you already keep.`
        : `Role "${agent.name}": activation note "${rel}" is readable.`, { agent: agent.name, path: rel });
    }
  }

  if (cfg.handoff) {
    const vault = ctx.byName.get(cfg.handoff.vault);
    const where = `${cfg.handoff.vault}/${cfg.handoff.folder}`;
    if (!vault || !(await isDir(path.join(vault.path, cfg.handoff.folder)))) add('mailbox', 'fail', `The AI mailbox "${where}" does not exist.`);
    else {
      add('mailbox', 'pass', `The AI mailbox is "${where}".`);
      if (vault.private) add('mailbox-private', 'warn', `The AI mailbox is inside the private vault "${vault.name}"; AIs without access to that vault cannot exchange handoffs.`);
      const outside = [...new Set((ctx.agents || []).map((agent) => agent.vault))].filter((name) => name !== cfg.handoff.vault);
      if (outside.length) add('mailbox-scope', 'warn', `Roles in ${outside.map((name) => `"${name}"`).join(', ')} send and read handoffs in "${cfg.handoff.vault}". Confirm that is the vault where inter-AI messages should be kept.`);
    }
  } else if ((ctx.agents || []).length > 1) add('mailbox', 'warn', 'No AI mailbox is configured, so roles cannot hand work to each other.');

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status]++;
  return { ok: summary.fail === 0, summary, checks };
}
