import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, mockServices } from './harness.mjs';
import { createApi } from '../lib/api.mjs';
import { useNotes } from '../lib/notes.mjs';
import { markdown, notesView } from '../views/notes.mjs';

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
test('session episode corrections keep a dated changelog and withdrawal preserves its private source',async()=>{
 const store=await makeStore(),api=createApi({store}),h=useNotes(api);
 const created=await store.write({vault:'Journal',path:'Knowledge Intake/Session.md',frontmatter:{type:'episode',status:'proposed',private:true,source:'BrainLink session s_test'},body:'# Session\n\nOriginal summary.\n\n## Changelog\n\n- 2031-03-04 — Created.'},{expected_etag:''});
 await h.load();await h.open(created.id);h.edit();h.changeBody('# Session\n\nCorrected summary.\n\n## Changelog\n\n- 2031-03-04 — Created.');assert.equal(await h.save(),true);
 let note=await store.read(created.id);assert.match(note.body,/Corrected summary/);assert.match(note.body,/Summary corrected/);assert.equal(note.frontmatter.status,'proposed');
 await h.open(created.id);assert.equal(await h.withdrawEpisode(new Date('2031-03-05T12:00:00Z')),true);
 note=await store.read(created.id);assert.equal(note.frontmatter.status,'withdrawn');assert.equal(note.frontmatter.private,true);assert.equal(note.frontmatter.source,'BrainLink session s_test');assert.match(note.body,/Corrected summary/);assert.match(note.body,/2031-03-05 — Proposal withdrawn/);
});
test('session episode metadata changes get a dated, value-free audit entry',async()=>{
 const store=await makeStore(),api=createApi({store}),h=useNotes(api);
 const created=await store.write({vault:'Journal',path:'Knowledge Intake/Metadata.md',frontmatter:{type:'episode',status:'proposed',private:true,source:'BrainLink session s_metadata'},body:'# Session\n\nSummary.\n'},{expected_etag:''});
 await h.load();await h.open(created.id);const original=(await store.read(created.id)).frontmatter;h.changeMeta(JSON.stringify({...original,status:'accepted',customerEmail:'private@example.test'},null,2));assert.equal(await h.save(),true);
 const saved=await store.read(created.id);assert.equal(saved.frontmatter.status,'accepted');assert.match(saved.body,/Metadata updated \(fields: status\)/);assert.doesNotMatch(saved.body,/accepted|customerEmail|private@example\.test/);
});
test('Notes shows the withdrawal action only for a private proposed BrainLink episode',async()=>{
 const api=createApi({store:await makeStore()});
 const item={id:'ep1',title:'Session',vault:'Journal',path:'Session.md',frontmatter:{type:'episode',status:'proposed',private:true,source:'BrainLink session s1'},body:'Summary',version:1,etag:'e1'};
 const view=notesView({items:[item],note:item,backlinks:[],editing:false,editingMeta:false,frontmatter:'{}'},api);
 assert.match(view,/data-action="noteWithdraw"/);
 const notProposed=notesView({items:[item],note:{...item,frontmatter:{...item.frontmatter,status:'accepted'}},backlinks:[],editing:false,editingMeta:false,frontmatter:'{}'},api);
 assert.doesNotMatch(notProposed,/data-action="noteWithdraw"/);
});
test('episode withdrawal refuses unrelated notes, non-private notes and stale revisions',async()=>{
 const store=await makeStore(),api=createApi({store}),h=useNotes(api);
 const plain=await store.write({vault:'Work',path:'Plain.md',frontmatter:{type:'episode',status:'proposed',private:true,source:'Imported session s1'},body:'Summary'},{expected_etag:''});
 const unsafe=await store.write({vault:'Work',path:'Public.md',frontmatter:{type:'episode',status:'proposed',private:false,source:'BrainLink session s2'},body:'Summary'},{expected_etag:''});
 await h.load();await h.open(plain.id);assert.equal(await h.withdrawEpisode(),false);assert.equal((await store.read(plain.id)).frontmatter.status,'proposed');
 await h.open(unsafe.id);assert.equal(await h.withdrawEpisode(),false);assert.equal((await store.read(unsafe.id)).frontmatter.status,'proposed');
 const fm={type:'episode',status:'proposed',private:true,source:'BrainLink session s3'};
 const valid=await store.write({vault:'Journal',path:'Stale.md',frontmatter:fm,body:'Summary'},{expected_etag:''});
 await h.load();await h.open(valid.id);await store.write({id:valid.id,vault:'Journal',path:'Stale.md',frontmatter:fm,body:'Concurrent update'},{expected_etag:valid.etag});
 assert.equal(await h.withdrawEpisode(),false);assert.match(h.get().error,/E_CONFLICT/);assert.equal((await store.read(valid.id)).frontmatter.status,'proposed');
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
