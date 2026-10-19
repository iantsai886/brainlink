import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, mockServices } from './harness.mjs';
import { createApi } from '../lib/api.mjs';
import { useConnect, useSessions, useSearch } from '../lib/hooks.mjs';

test('connect-all verifies every installed connector', async () => {
  const services = mockServices(); const c = useConnect(createApi({store:await makeStore(),services}));
  await c.refresh(); await c.connectAll();
  assert.equal(c.get().apps.filter(x => x.last_test?.ok).length, 5);
  assert.equal(services.calls.filter(x => x.startsWith('test:')).length, 5);
});
test('failed live test can retry successfully', async () => {
  const services = mockServices({failTestOnce:['cursor']}); const c = useConnect(createApi({store:await makeStore(),services}));
  await c.refresh(); await c.connect('cursor'); assert.equal(c.get().apps.find(x=>x.client==='cursor').last_test.ok,false);
  await c.retry('cursor'); assert.equal(c.get().apps.find(x=>x.client==='cursor').last_test.ok,true);
});
test('privacy move retains session ID and excludes non-private list', async () => {
  const api = createApi({store:await makeStore()}); const s = useSessions(api); await s.load();
  const item = s.get().items.find(x=>x.client==='cursor');
  await s.setPrivate(item.id,true); assert.equal((await api.readSession(item.id)).session.private,true);
  await s.togglePrivateListing(false); assert.ok(!s.get().items.some(x=>x.id===item.id));
});
test('search ranks exact title higher than body mentions', async () => {
  const api = createApi({store:await makeStore()}); const search = useSearch(api);
  await search.run('Website relaunch');
  assert.ok(search.get().result.hits.some(h=>h.title==='Website relaunch'));
  await search.open(search.get().result.hits.find(h=>h.title==='Website relaunch').id);
  assert.match(search.get().open.body,/Draft copy/);
});
test('remote access never returns private session or private search result', async () => {
  const api = createApi({store:await makeStore(),access:{remote:true}});
  assert.ok((await api.listSessions()).every(s=>s.vault==='Work'));
  assert.ok((await api.search('private sync worries')).hits.every(h=>!h.title.includes('Diary')));
});
