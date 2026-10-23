// Regression test for a real first-load crash: applyI18n() (ui/index.html) does
// `el.innerHTML = translatedText` for every element carrying data-i18n. If that element also
// wraps a live form control (<select>/<input>/<textarea>), the control is wiped out of the DOM
// the moment the page applies translations -- before any code gets a chance to read or fill it.
// That turned "Local only -> Continue" into a dead end (`$('sync-provider')` / `$('sync-onb-device')`
// returned null) and crashed first load with "Cannot set properties of null (setting 'innerHTML')".
// The fix is the pattern already used elsewhere in this file: data-i18n on its own <span>, sibling
// to the control, never wrapping it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'ui', 'locales');

test('ui/index.html: no data-i18n element directly wraps a live form control', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const offenders = [...html.matchAll(/<(\w+)[^>]*\bdata-i18n="[^"]+"[^>]*>\s*<(select|input|textarea)\b/g)];
  assert.deepEqual(offenders.map((m) => `<${m[1]} data-i18n> wraps <${m[2]}>`), []);
});

// A2: the folder picker's fallback (used when the OS has no GUI folder dialog available) must be
// a real, labelled form -- never window.prompt(), a jargon-y browser dialog with no room for
// plain-language instructions.
test('ui/index.html and ui/share.js: the folder-picker fallback never uses window.prompt', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const shareJs = await readFile(path.join(ROOT, 'ui', 'share.js'), 'utf8');
  assert.doesNotMatch(html, /\bwindow\.prompt\(/);
  assert.doesNotMatch(shareJs, /\bwindow\.prompt\?\.\(/);
  assert.match(html, /id="folder-fallback-modal"/);
  assert.match(html, /window\.promptForFolder\s*=/);
});

// After a vault is picked/created, index.html's load() must tell other self-contained panels
// (agents.js, share.js) right away, so they stop saying "Add a vault first" without needing a
// manual reload.
test('ui/index.html dispatches brainlink:state-updated; agents.js and share.js listen for it', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const agentsJs = await readFile(path.join(ROOT, 'ui', 'agents.js'), 'utf8');
  const shareJs = await readFile(path.join(ROOT, 'ui', 'share.js'), 'utf8');
  assert.match(html, /dispatchEvent\(new CustomEvent\(['"]brainlink:state-updated['"]/);
  assert.match(agentsJs, /addEventListener\(['"]brainlink:state-updated['"]/);
  assert.match(shareJs, /addEventListener\(['"]brainlink:state-updated['"]/);
});

// The Agents card (ui/agents.js) and the "Share with cloud agents" card (ui/share.js) are
// self-contained scripts that look up every string through the page's global t()/data-i18n
// (ui/index.html), not hard-coded English — see RB7/RB8. This scans their actual t(...) calls
// (plus the agents./share./sync.provider. data-i18n attributes in index.html) and checks every
// key they use exists, as a non-empty string, in every shipped locale: a key referenced here but
// missing from a catalog would silently fall back to raw English (or the key itself) for that
// language instead of erroring, so it would never be caught just by using the app once in English.
test('every en key actually used by the Agents / Share cards (and sync provider labels) exists, non-empty, in every locale', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const agentsJs = await readFile(path.join(ROOT, 'ui', 'agents.js'), 'utf8');
  const shareJs = await readFile(path.join(ROOT, 'ui', 'share.js'), 'utf8');

  const keys = new Set();
  const scanCalls = (src) => { for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) keys.add(m[1]); };
  scanCalls(agentsJs);
  scanCalls(shareJs);
  for (const m of html.matchAll(/data-i18n(?:-placeholder)?="(agents\.[a-zA-Z0-9_.]+|share\.[a-zA-Z0-9_.]+)"/g)) keys.add(m[1]);
  // The provider <select> options are built as t('sync.provider.' + p) for p in PROVIDERS
  // (src/sync/settings.mjs), not a literal key t() can be grepped for.
  if (/t\(\s*['"]sync\.provider\.['"]\s*\+\s*\w+\)/.test(html)) {
    for (const p of ['local', 'gdrive', 'icloud', 'dropbox']) keys.add(`sync.provider.${p}`);
  }
  assert.ok(keys.size > 30, `sanity check: expected many keys scanned, got ${keys.size}`);

  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, JSON.parse(await readFile(path.join(LOCALES_DIR, `${id}.json`), 'utf8'))])));
  for (const id of LOCALES) {
    for (const key of keys) {
      assert.ok(key in catalogs[id], `${id}.json is missing "${key}", used by the Agents/Share cards`);
      assert.equal(typeof catalogs[id][key], 'string', `${id}.json["${key}"] must be a string`);
      assert.notEqual(catalogs[id][key].trim(), '', `${id}.json["${key}"] must not be empty`);
    }
  }
});

// P1g: the Share card must say, in one plain sentence, that BrainLink writes into a dedicated
// "BrainLink Shared" folder inside whatever folder the user picked, and never touches anything
// else there -- so a user sharing e.g. a whole Dropbox folder knows BrainLink isn't reading or
// overwriting their other files in it.
test('P1g: share.subfolderHint names "BrainLink Shared" and is rendered in the folder area', async () => {
  const shareJs = await readFile(path.join(ROOT, 'ui', 'share.js'), 'utf8');
  assert.match(shareJs, /t\(\s*['"]share\.subfolderHint['"]\s*\)/);
  const en = JSON.parse(await readFile(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  assert.match(en['share.subfolderHint'], /BrainLink Shared/);
  assert.match(en['share.subfolderHint'], /never touches/i);
  for (const id of LOCALES) {
    const s = catalogsOf(await readFile(path.join(LOCALES_DIR, `${id}.json`), 'utf8'))['share.subfolderHint'];
    assert.match(s, /BrainLink Shared/, `${id}.json share.subfolderHint should keep the literal folder name`);
  }
});
function catalogsOf(raw) { return JSON.parse(raw); }

// P1b: the citation/source note modal (ui/index.html's #note-modal, openNote()) must render the
// note as formatted text, not raw Markdown, and must resolve [[wikilinks]] against what the
// server already decided is visible (src/links.mjs's resolveNoteWikilinks, see test/brainlink.test.mjs
// for that resolver's own tests) -- a dead link and a link to a private/excluded note must both
// come back as identical plain text, never a clue either way. These tests actually execute the
// shipped renderer (extracted from ui/index.html, no browser available) rather than just
// grepping for patterns, since this is exactly the kind of string-munging logic regexes miss.
async function loadNoteRenderer() {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const esc = html.match(/const esc = \([^)]*\) => [^\n]+;/)[0];
  const inline = html.match(/function renderNoteInline\(text, linkMap\) \{[\s\S]*?\n\}/)[0];
  const body = html.match(/function renderNoteBody\(md, wikilinks, vault\) \{[\s\S]*?\n\}/)[0];
  const t = (key) => (key === 'note.empty' ? '(This note is empty.)' : key);
  return new Function('t', `${esc}\n${inline}\n${body}\nreturn renderNoteBody;`)(t);
}

test('P1b: note modal renders formatted text (headings/bold/code), never raw [[ ]] or ** syntax', async () => {
  const renderNoteBody = await loadNoteRenderer();
  const html = renderNoteBody('# Title\n\nSome **bold** and `code` and [[Resolved Note]].', [
    { raw: '[[Resolved Note]]', target: 'Resolved Note', label: 'Resolved Note', resolved: { path: 'Resolved Note.md', title: 'Resolved Note' } },
  ], 'Acme Studio');
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.doesNotMatch(html, /\*\*/, 'no raw Markdown bold syntax should survive');
  assert.doesNotMatch(html, /\[\[|\]\]/, 'no raw wikilink brackets should survive, resolved or not');
});

test('P1b: a resolved wikilink becomes a real link; a dead or private one is identical plain text', async () => {
  const renderNoteBody = await loadNoteRenderer();
  const wikilinks = [
    { raw: '[[Real Note]]', target: 'Real Note', label: 'Real Note', resolved: { path: 'Real Note.md', title: 'Real Note' } },
    { raw: '[[Secret Note]]', target: 'Secret Note', label: 'Secret Note', resolved: null }, // private
    { raw: '[[Nope]]', target: 'Nope', label: 'Nope', resolved: null }, // dead
  ];
  const html = renderNoteBody('See [[Real Note]], [[Secret Note]] and [[Nope]].', wikilinks, 'Acme Studio');
  assert.match(html, /<a href="#" data-open-note="Acme Studio::Real Note\.md">Real Note<\/a>/);
  // Identical rendering for private and dead -- plain text, no <a>, no path, no hint.
  assert.doesNotMatch(html, /Secret Note\.md/);
  assert.doesNotMatch(html, /data-open-note="[^"]*Secret/);
  assert.doesNotMatch(html, /data-open-note="[^"]*Nope/);
  assert.match(html, /Secret Note/); // the label text itself still reads naturally
  assert.match(html, /Nope/);
});

test('P1b: an ordinary number in the note text is never mistaken for a code/wikilink placeholder', async () => {
  const renderNoteBody = await loadNoteRenderer();
  const html = renderNoteBody('Section 2 covers `step 0` and [[Plan]].', [
    { raw: '[[Plan]]', target: 'Plan', label: 'Plan', resolved: { path: 'Plan.md', title: 'Plan' } },
  ], 'Acme Studio');
  assert.match(html, /Section 2 covers/);
  assert.match(html, /<code>step 0<\/code>/);
  assert.match(html, /<a href="#" data-open-note="Acme Studio::Plan\.md">Plan<\/a>/);
});

test('P1b: an empty note body renders the empty-state message, not blank', async () => {
  const renderNoteBody = await loadNoteRenderer();
  assert.match(renderNoteBody('', [], 'Acme Studio'), /This note is empty/);
});
