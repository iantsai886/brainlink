const TYPES = new Set(['working', 'semantic', 'procedural', 'episodic']);
const ALIASES = Object.freeze({
  'operating-manual':'procedural','operations-manual':'procedural','role-manual':'procedural',
  'agent-manual':'procedural','procedure':'procedural','standard-operating-procedure':'procedural',
  'runbook':'procedural','skill':'procedural','agent-skill':'procedural','role-instructions':'procedural',
  'handoff':'working','handoff-request':'working','task':'working','open-loop':'working','work-item':'working',
  'episode':'episodic','session-episode':'episodic','session-summary':'episodic',
});
function normalize(value) { return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-'); }
export function memoryTypeInfo(frontmatter = {}) {
  const explicit=String(frontmatter.memory_type||frontmatter.brainlink_memory_type||'').trim().toLowerCase();
  const current=TYPES.has(explicit)?explicit:null;
  if (current) return {current,suggested:null};
  const noteType=normalize(frontmatter.type||frontmatter.note_type);
  if (ALIASES[noteType]) return {current:null,suggested:ALIASES[noteType]};
  const tags=Array.isArray(frontmatter.tags)?frontmatter.tags.flat(Infinity):String(frontmatter.tags||'').replace(/^\[|\]$/g,'').split(',');
  const suggested=tags.map((tag)=>ALIASES[normalize(String(tag).replace(/^['"]|['"]$/g,''))]).find(Boolean)||null;
  return {current:null,suggested};
}
