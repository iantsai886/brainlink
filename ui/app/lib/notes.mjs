import { createHook, errText } from './state.mjs';
export function useNotes(api) {
  const h = createHook({items:[],note:null,backlinks:[],editing:false,editingMeta:false,body:'',frontmatter:'',dirty:false,error:null,message:'',selectedVault:'',newPath:''});
  const guard = () => !h.get().dirty || (typeof globalThis.confirm !== 'function' || globalThis.confirm('Discard unsaved changes?'));
  async function load() { try { h.set({items:await api.listNotes(),error:null}); } catch(e) { h.set({error:errText(e)}); } }
  async function open(id) { if (!guard()) return false; try { const note=await api.readNote(id); const backlinks=await api.backlinks(id); h.set({note,backlinks,body:note.body,frontmatter:JSON.stringify(note.frontmatter||{},null,2),editing:false,editingMeta:false,dirty:false,error:null,message:''}); return true; } catch(e) { h.set({error:errText(e)}); return false; } }
  function edit() { if(h.get().note) h.set({editing:true}); }
  function setVault(selectedVault) { const allowed=new Set(api.vaults().map(v=>v.name));h.set({selectedVault:allowed.has(selectedVault)?selectedVault:''}); }
  function changeBody(body) { h.set({body,dirty:body !== (h.get().note?.body || '') || h.get().frontmatter !== JSON.stringify(h.get().note?.frontmatter||{},null,2)}); }
  function changeMeta(frontmatter) { h.set({frontmatter,dirty:frontmatter !== JSON.stringify(h.get().note?.frontmatter||{},null,2) || h.get().body !== h.get().note?.body}); }
  function changeMemoryType(memoryType) {
    const allowed = ['working', 'semantic', 'procedural', 'episodic'];
    if (!allowed.includes(memoryType)) { h.set({error:'Choose one of the four supported memory types.'}); return false; }
    const s=h.get(); if(!s.note) return false;
    let frontmatter;
    try { frontmatter=JSON.parse(s.frontmatter); } catch { h.set({error:'Fix the frontmatter JSON before changing the memory type.'}); return false; }
    frontmatter.memory_type=memoryType;
    const serialized=JSON.stringify(frontmatter,null,2);
    h.set({frontmatter:serialized,dirty:serialized!==JSON.stringify(s.note.frontmatter||{},null,2)||s.body!==s.note.body,error:null,editingMeta:true});
    return true;
  }
  const isEpisode = (note, fm = note?.frontmatter || {}) => String(fm.type || '').toLowerCase() === 'episode' && /^BrainLink session\s+\S+/i.test(String(fm.source || ''));
  function history(body, action, now = new Date()) {
    const date = now.toISOString().slice(0, 10), entry = `- ${date} — ${action}. Updated in BrainLink Notes.`;
    const marker = /^## Changelog\s*$/im;
    return marker.test(body) ? body.replace(marker, (heading) => `${heading}\n\n${entry}`) : `${body.trimEnd()}\n\n## Changelog\n\n${entry}\n`;
  }
  function metadataAudit(before = {}, after = {}) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (!keys.length) return null;
    const safe = new Set(['agent_or_role','ai_platform','confidence','created','folder','owner','private','project','scope','session_or_task_id','source','status','tags','type','updated','vault']);
    const fields = keys.filter((key) => safe.has(key)).sort();
    const detail = fields.length ? `fields: ${fields.join(', ')}` : `${keys.length} field${keys.length === 1 ? '' : 's'} (names omitted)`;
    return `Metadata updated (${detail})`;
  }
  async function save() { const s=h.get(); if(!s.note) return false; try { const frontmatter=JSON.parse(s.frontmatter); if(!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw Error('Frontmatter must be a JSON object'); let body=s.body; const episode=isEpisode(s.note)||isEpisode(s.note,frontmatter); if(episode){if(body !== s.note.body) body=history(body,'Summary corrected');const audit=metadataAudit(s.note.frontmatter||{},frontmatter);if(audit)body=history(body,audit);} await api.writeNote({id:s.note.id,vault:s.note.vault,path:s.note.path,body,frontmatter},s.note.etag); const note=await api.readNote(s.note.id); h.set({note,body:note.body,frontmatter:JSON.stringify(note.frontmatter||{},null,2),dirty:false,editing:false,error:null,message:'Saved'}); await load(); return true; } catch(e) { h.set({error:e.code==='E_CONFLICT' ? 'E_CONFLICT: This note was changed elsewhere. Copy your edits before reloading.' : errText(e)}); return false; } }
  async function withdrawEpisode(now = new Date()) {
    const s=h.get(), n=s.note, fm=n?.frontmatter || {};
    if (!n || !isEpisode(n, fm) || String(fm.status || '').toLowerCase() !== 'proposed' || fm.private !== true) {
      h.set({error:'Only a private, proposed BrainLink session episode can be withdrawn.'}); return false;
    }
    if (s.dirty) { h.set({error:'Save or cancel your edits before withdrawing this proposal.'}); return false; }
    try {
      const frontmatter={...fm,status:'withdrawn'};
      const body=history(n.body,'Proposal withdrawn',now);
      await api.writeNote({id:n.id,vault:n.vault,path:n.path,body,frontmatter},n.etag);
      const note=await api.readNote(n.id);
      h.set({note,body:note.body,frontmatter:JSON.stringify(note.frontmatter||{},null,2),dirty:false,editing:false,error:null,message:'Proposal withdrawn; source and history retained.'});
      await load(); return true;
    } catch(e) { h.set({error:e.code==='E_CONFLICT' ? 'E_CONFLICT: This note changed elsewhere. Reload it before withdrawing.' : errText(e)}); return false; }
  }
  async function create(vault,path) { if(!guard()) return false; try { if(!vault || !path.trim()) throw Error('Choose a vault and note path'); const filename=path.trim().endsWith('.md')?path.trim():path.trim()+'.md'; const res=await api.writeNote({vault,path:filename,body:'',frontmatter:{}},''); await load(); await open(res.id); h.set({editing:true,newPath:'',message:'New note created'}); return true; } catch(e) {h.set({error:errText(e)});return false;} }
  async function rename(path) { const s=h.get(); if(!s.note || !guard()) return false; if(!api.renameNote) {h.set({error:'Rename is not supported by this store.'});return false;} try { await api.renameNote(s.note.id,path,s.note.etag); await load(); await open(s.note.id); return true; } catch(e){h.set({error:errText(e)});return false;} }
  function close() {if(!guard())return false;h.set({note:null,dirty:false,editing:false,error:null});return true;}
  function cancel() {if(!guard())return false;const n=h.get().note;h.set({editing:false,editingMeta:false,dirty:false,body:n?.body||'',frontmatter:JSON.stringify(n?.frontmatter||{},null,2)});return true;}
  return {...h,load,open,edit,setVault,changeBody,changeMeta,changeMemoryType,save,withdrawEpisode,create,rename,close,cancel,guard};
}
