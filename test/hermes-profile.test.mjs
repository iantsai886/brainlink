import test from 'node:test';
import { readSetupHtml } from './helpers/setup-html.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';
import { startSetup } from '../src/setup.mjs';

async function makeProfile(home, id, text) {
  await mkdir(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'state.db'));
  db.exec(`CREATE TABLE sessions(id TEXT, source TEXT, title TEXT, cwd TEXT, started_at REAL, ended_at REAL);
    CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER);`);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(id, 'cli', id, '/fictional', 1793149200, 1793149260);
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(1, id, 'user', text, 1793149201, 1);
  db.close();
}

test('Sessions lets a user select one Hermes profile and switch back to the default without deleting prior imports', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'brainlink-hermes-profile-'));
  const appHome = path.join(base, 'app');
  const defaultHome = path.join(base, 'hermes-default');
  const chosenHome = path.join(base, 'hermes', 'profiles', 'fictional');
  const env = { BRAINLINK_HOME: appHome, HOME: base, HERMES_HOME: defaultHome, BRAINLINK_SEMANTIC: '0' };
  await makeProfile(defaultHome, 'default-session', 'Default Hermes profile only.');
  await makeProfile(chosenHome, 'chosen-session', 'Chosen Hermes profile only.');
  const app = await startSetup({ env, home: base, os: 'win32', port: 0, useCli: false });
  const api = (route, body, token = app.token) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await api('/api/sessions/hermes-profile', { home: chosenHome }, 'bad-token')).status, 401);
    assert.equal((await api('/api/sessions/hermes-profile', { home: path.join(base, 'missing') })).status, 400);
    assert.equal((await api('/api/sessions/import-setting', { enabled: true })).status, 200);
    const selectedResponse = await api('/api/sessions/hermes-profile', { home: chosenHome });
    assert.equal(selectedResponse.status, 200);
    const selected = await selectedResponse.json();
    assert.equal(selected.profile.home, chosenHome);
    assert.equal(selected.sessionCount, 2, 'the opt-in imports the default profile before switching to the chosen profile');
    assert.equal((await loadConfig(path.join(appHome, 'config.json'))).sessions.hermesHome, chosenHome);

    const clearedResponse = await api('/api/sessions/hermes-profile', { home: null });
    assert.equal(clearedResponse.status, 200);
    const cleared = await clearedResponse.json();
    assert.equal(cleared.profile.home, null);
    assert.equal(cleared.profile.defaultHome, defaultHome);
    assert.equal(cleared.sessionCount, 2, 'switching profiles keeps earlier imported sessions in the local index');
    assert.equal((await loadConfig(path.join(appHome, 'config.json'))).sessions.hermesHome, null);
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

test('Hermes profile Settings exposes a native folder chooser and explains profile switching', async () => {
  const html = await readSetupHtml();
  assert.match(html, /id="sessions-hermes-profile-choose"/);
  assert.match(html, /POST', '\/api\/sessions\/hermes-profile\/pick'/);
  assert.match(html, /POST', '\/api\/sessions\/hermes-profile'/);
  assert.match(html, /sessions\.hermesProfileHistoryNote/);
});
