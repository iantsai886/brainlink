import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, mockServices } from './harness.mjs';
import { createApi } from '../lib/api.mjs';
import { useNotes } from '../lib/notes.mjs';
import { markdown } from '../views/notes.mjs';

test('v0.2 ranked search forwards canonical options without re-ranking',async()=>{
 const store=await makeStore();let seen;store.search=async(q,o)=>{seen={q,o};return [{id:'n_any',title:'As ranked by store',snippet:'hit',score:.3,sha12:'abcdef123456'}]};
 const api=createApi({store});const result=await api.search('words',{limit:3,scope:'Work'});
 assert.deepEqual(seen,{q:'words',o:{limit:3,scope:'Work',includeSessions:false}});assert.equal(result.hits[0].title,'As ranked by store');
});
test('v0.2 session setPrivate is preferred and privacy is read from record',async()=>{
 const store=await makeStore();const s=(await store.listSessions())[0];let seen;store.setSessionPrivate=async(...args)=>{seen=args;return {...s,private:false};};
 const api=createApi({store});await api.setPrivate(s.id,false);assert.deepEqual(seen,[s.id,false,{}]);
});
test('feature detect: legacy session privacy vault-move and search fallback',async()=>{
 const store=await makeStore();store.setSessionPrivate=undefined;store.search=undefined;const api=createApi({store});
 const s=(await api.listSessions())[0];const oldVault=s.vault;const moved=await api.setPrivate(s.id,oldVault!=='Journal');
 assert.equal(moved.id,s.id);assert.equal(moved.vault,oldVault==='Journal'?'Work':'Journal');
 assert.ok((await api.search('Website relaunch')).hits.length);
});
test('v0.2 connector shape: client and ok/message result',async()=>{
 const api=createApi({store:await makeStore(),services:mockServices()});const apps=await api.detect();assert.ok(apps.every(a=>typeof a.client==='string'&&typeof a.installed==='boolean'&&typeof a.connected==='boolean'));
 const res=await api.connect('cursor');assert.deepEqual(Object.keys(res).sort(),['message','ok']);assert.equal((await api.test('cursor')).ok,true);
 assert.equal((await api.disconnect('cursor')).ok,true);
});
test('notes save uses full etag CAS and reports external conflict without overwriting',async()=>{
 const store=await makeStore(),api=createApi({store}),h=useNotes(api);await h.load();const id=h.get().items.find(n=>n.title==='Home').id;
 await h.open(id);h.edit();h.changeBody('new content');assert.equal(h.get().dirty,true);assert.equal(await h.save(),true);assert.equal((await store.read(id)).body,'new content');
 h.changeBody('local changes');await store.write({id,vault:'Work',path:'Home.md',body:'remote changes',frontmatter:(await store.read(id)).frontmatter},{expected_etag:(await store.read(id)).etag});
 assert.equal(await h.save(),false);assert.match(h.get().error,/E_CONFLICT/);assert.equal((await store.read(id)).body,'remote changes');assert.equal(h.get().dirty,true);
});
test('wikilinks render safely and backlinks resolve by target id',async()=>{
 const store=await makeStore(),api=createApi({store});const list=await api.listNotes();const website=list.find(n=>n.title==='Website relaunch');const backlinks=await api.backlinks(website.id);
 assert.ok(backlinks.some(l=>list.find(n=>n.id===l.src_id)?.title==='Home'));
 assert.match(markdown('# Heading\n- list\n[[Home|start]]\n```js\n<unsafe>\n```'),/data-note-target="Home"/);
 assert.match(markdown('<script>alert(1)</script>'),/&lt;script&gt;/);
});
test('unsaved-change navigation guard blocks opens and close',async()=>{
 const api=createApi({store:await makeStore()}),h=useNotes(api);await h.load();const items=h.get().items;
 await h.open(items[0].id);h.changeBody('not saved');const prev=globalThis.confirm;globalThis.confirm=()=>false;
 try {assert.equal(await h.open(items[1].id),false);assert.equal(h.close(),false);assert.equal(h.get().note.id,items[0].id);assert.equal(h.get().dirty,true);}finally{globalThis.confirm=prev;}
});
