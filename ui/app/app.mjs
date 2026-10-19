import { createHook } from './lib/state.mjs';
import { useConnect, useSessions, useSearch } from './lib/hooks.mjs';
import { useNotes } from './lib/notes.mjs';
import { shell, connectView, sessionsView, searchView } from './views/screens.mjs';
import { notesView } from './views/notes.mjs';
export async function startApp(root, api) {
  const routes=['connect','sessions','search','notes'];
  const ui=createHook({route:globalThis.location?.hash.slice(1)||'connect'});
  const conn=useConnect(api),sess=useSessions(api),srch=useSearch(api),notes=useNotes(api);
  const render=()=>{const route=ui.get().route;root.innerHTML=shell(route,route==='notes'?notesView(notes.get(),api):route==='sessions'?sessionsView(sess.get()):route==='search'?searchView(srch.get()):connectView(conn.get()));};
  for(const hook of [ui,conn,sess,srch,notes])hook.sub(render);
  const actions={connect:id=>conn.connect(id),retry:id=>conn.retry(id),disconnect:id=>conn.disconnect(id),connectAll:()=>conn.connectAll(),refresh:()=>conn.refresh(),openSession:id=>sess.open(id),closeSession:()=>sess.close(),openNote:id=>srch.open(id),closeNote:()=>srch.close(),noteOpen:id=>notes.open(id),noteEdit:()=>notes.edit(),noteSave:()=>notes.save(),noteCancel:()=>notes.cancel(),noteClose:()=>notes.close(),noteToggleMeta:()=>notes.set({editingMeta:!notes.get().editingMeta}),noteRename:()=>{const n=notes.get().note;const path=globalThis.prompt?.('Rename note path',n?.path);if(path&&path!==n?.path)notes.rename(path);}};
  root.addEventListener('click',e=>{const link=e.target.closest('[data-note-target]');if(link){e.preventDefault();const target=link.dataset.noteTarget;const note=notes.get().items.find(n=>n.title.toLowerCase()===target.toLowerCase()||n.path.replace(/\.md$/i,'').toLowerCase()===target.toLowerCase()||n.path.replace(/\.md$/i,'').toLowerCase().endsWith('/'+target.toLowerCase()));if(note)notes.open(note.id);else notes.set({error:`Unresolved wikilink: ${target}`});return;}const x=e.target.closest('button[data-action]');if(x)actions[x.dataset.action]?.(x.dataset.arg);});
  root.addEventListener('submit',e=>{if(e.target.id==='new-note-form'){e.preventDefault();const data=new FormData(e.target);notes.create(String(data.get('vault')),String(data.get('path')||''));}});
  root.addEventListener('change',e=>{const x=e.target;if(x.dataset.action==='private')sess.setPrivate(x.dataset.arg,x.checked);if(x.dataset.action==='includePrivate')sess.togglePrivateListing(x.checked);});
  root.addEventListener('input',e=>{const x=e.target;if(x.dataset.noteField==='body'||x.dataset.noteField==='meta'){const field=x.dataset.noteField, caret=x.selectionStart; if(field==='body')notes.changeBody(x.value);else notes.changeMeta(x.value);const next=root.querySelector(`[data-note-field="${field}"]`);if(next){next.focus();next.setSelectionRange(caret,caret);}return;}const key=x.dataset.input;if(!key)return;const caret=x.selectionStart;clearTimeout(root._searchTimer);root._searchTimer=setTimeout(async()=>{if(key==='sessionQ')await sess.search(x.value);else await srch.run(x.value);const next=root.querySelector(`[data-input="${key}"]`);if(next){next.focus();next.setSelectionRange(caret,caret);}},160);});
  const onHash=()=>{const route=globalThis.location?.hash.slice(1);if(route!==ui.get().route){if(!notes.guard()){globalThis.location.hash='#'+ui.get().route;return;}ui.set({route:routes.includes(route)?route:'connect'});}};
  const onBeforeUnload=e=>{if(notes.get().dirty){e.preventDefault();e.returnValue='';}};
  const onKey=e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&ui.get().route==='notes'){e.preventDefault();notes.save();}};
  globalThis.addEventListener?.('hashchange',onHash);globalThis.addEventListener?.('beforeunload',onBeforeUnload);globalThis.addEventListener?.('keydown',onKey);
  await Promise.all([conn.refresh(),sess.load(),notes.load()]);render();
  return {api,ui,hooks:{conn,sess,srch,notes},actions,render,dispose:()=>{globalThis.removeEventListener?.('hashchange',onHash);globalThis.removeEventListener?.('beforeunload',onBeforeUnload);globalThis.removeEventListener?.('keydown',onKey);}};
}
