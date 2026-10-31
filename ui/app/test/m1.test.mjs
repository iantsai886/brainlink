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
test('search scope selection is retained and passed to the authorized store query',async()=>{
 const store=await makeStore(),api=createApi({store});let seen;
 store.search=async(q,options)=>{seen={q,options};return [];};
 const search=useSearch(api);await search.run('website');await search.setScope('Work');
 assert.equal(search.get().scope,'Work');assert.equal(seen.q,'website');assert.equal(seen.options.scope,'Work');
 await search.setScope('');assert.equal(search.get().scope,'');assert.equal(seen.options.scope,undefined);
});
test('fallback search enforces a selected accessible vault before reading note content',async()=>{
 const store=await makeStore();store.search=undefined;const api=createApi({store,access:{vaults:['Work']}});
 const result=await api.search('private sync worries',{scope:'Journal'});assert.equal(result.hits.length,0);
 const visible=await api.search('Website relaunch',{scope:'Work'});assert.ok(visible.hits.length>0);assert.ok(visible.hits.every(hit=>hit.vault==='Work'));
});
test('remote access never returns private session or private search result', async () => {
  const api = createApi({store:await makeStore(),access:{remote:true}});
  assert.ok((await api.listSessions()).every(s=>s.vault==='Work'));
  assert.ok((await api.search('private sync worries')).hits.every(h=>!h.title.includes('Diary')));
});
