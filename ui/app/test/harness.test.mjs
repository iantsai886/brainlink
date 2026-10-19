import test from 'node:test'; import assert from 'node:assert/strict';
import { makeStore, mockServices } from './harness.mjs';
import { createApi } from '../lib/api.mjs';
test('harness: store seeded, private vault hidden from remote callers', async () => {
  const s = await makeStore();
  assert.equal((await s.list({ vault: 'Work' })).length, 4);
  assert.equal((await s.listSessions()).length, 3);
  assert.equal((await s.listSessions({ remote: true })).length, 2);
  const robin = (await s.list({ vault: 'Work', folder: 'People' }))[0];
  assert.ok((await s.links(robin.id)).some((l) => l.target_id === null));
});
test('harness: api wraps store + services', async () => {
  const api = createApi({ store: await makeStore(), services: mockServices() });
  assert.deepEqual(api.vaults().map((v) => v.name), ['Work', 'Journal']);
  assert.equal((await api.services.connectors.detect()).length, 7);
});
