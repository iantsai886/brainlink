import {esc} from '../lib/state.mjs';
import {buildGraph,layoutGraph3d} from '../lib/graph.mjs';
export function graphView(s){return `<header><h2>Graph</h2><p>Wikilink connections between notes. Drag to rotate, use the wheel to zoom, and select a node to open it.</p><label>Vault <select data-graph="vault"><option value="">All visible vaults</option>${s.vaults.map(v=>`<option value="${esc(v.name)}" ${s.vault===v.name?'selected':''}>${esc(v.name)}</option>`).join('')}</select></label> <label><input type="checkbox" data-graph="private" ${s.includePrivate?'checked':''}> Show private notes (local only)</label></header>${s.error?`<p role="alert">${esc(s.error)}</p>`:''}<p aria-live="polite">${s.graph.nodes.length} notes · ${s.graph.edges.length} links</p><canvas id="brain-graph" width="900" height="560" tabindex="0" role="img" aria-label="Interactive 3D notes graph. Use the node list below to open notes with a keyboard."></canvas><p><button type="button" data-graph-reset>Reset graph view</button></p><div class="detail"><h3>Notes (keyboard accessible)</h3><ul class="graph-list">${s.graph.nodes.map(n=>`<li><button data-action="graphOpen" data-arg="${esc(n.id)}">${esc(n.title)} — ${esc(n.vault)}</button></li>`).join('')||'<li>No visible notes.</li>'}</ul></div>`;}
export function useGraph(api){const state={vault:'',includePrivate:false,vaults:api.vaults(),graph:{nodes:[],edges:[]},error:''};const listeners=new Set();const get=()=>state;const set=p=>{Object.assign(state,p);listeners.forEach(f=>f());};async function load(){try{const summaries=await api.listNotes();const notes=await Promise.all(summaries.map(n=>api.readNote(n.id)));set({graph:buildGraph(notes,{vault:state.vault,includePrivate:state.includePrivate,vaults:state.vaults}),error:''});}catch(e){set({error:e.message||String(e)});}}return {get,sub:f=>listeners.add(f),set,load};}

export function projectGraphNode(node,{yaw=0,pitch=0,zoom=1,width=900,height=560,camera=900}={}){
 const x=node.x*Math.cos(yaw)+node.z*Math.sin(yaw),z=-node.x*Math.sin(yaw)+node.z*Math.cos(yaw);
 const y=node.y*Math.cos(pitch)-z*Math.sin(pitch),depth=node.y*Math.sin(pitch)+z*Math.cos(pitch);
 const scale=camera/(camera+depth)*zoom;
 return {x:width/2+x*scale,y:height/2+y*scale,depth,scale};
}

export function drawGraph(canvas,graph,onOpen){
 if(!canvas)return ()=>{};
 const ctx=canvas.getContext?.('2d');if(!ctx)return ()=>{};
 const model=layoutGraph3d(graph),byId=new Map(model.nodes.map(n=>[n.id,n]));
 let yaw=.35,pitch=.18,zoom=1,hover=null,down=null;
 const resetButton=canvas.parentElement?.querySelector('[data-graph-reset]');
 const project=n=>projectGraphNode(n,{yaw,pitch,zoom,width:canvas.width,height:canvas.height});
 function point(e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};}
 function locate(e){const p=point(e);let found=null,best=Infinity;for(const n of model.nodes){const q=project(n),d=Math.hypot(q.x-p.x,q.y-p.y);if(d<Math.max(9,7*q.scale)&&d<best){found=n;best=d;}}return found;}
 function paint(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const points=new Map(model.nodes.map(n=>[n.id,project(n)]));
  const edgeOrder=[...model.edges].sort((a,b)=>(points.get(a.source).depth+points.get(a.target).depth)-(points.get(b.source).depth+points.get(b.target).depth));
  for(const e of edgeOrder){const a=points.get(e.source),b=points.get(e.target);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=`rgba(120,145,165,${Math.max(.12,Math.min(.48,.42-(a.depth+b.depth)/2400))})`;ctx.lineWidth=1;ctx.stroke();}
  const order=[...model.nodes].sort((a,b)=>points.get(a.id).depth-points.get(b.id).depth);
  for(const n of order){const p=points.get(n.id),active=hover?.id===n.id,r=(active?8:5)*Math.max(.65,Math.min(1.3,p.scale));ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fillStyle=active?'#d58336':'#5183b4';ctx.fill();if(active){ctx.fillStyle='#182c3b';ctx.font='14px sans-serif';ctx.fillText(n.title,p.x+12,p.y-12);}}
 }
 const move=e=>{if(down){const dx=e.clientX-down.x,dy=e.clientY-down.y;if(Math.abs(dx)+Math.abs(dy)>2){down.moved=true;yaw+=dx*.008;pitch=Math.max(-1.35,Math.min(1.35,pitch+dy*.008));down.x=e.clientX;down.y=e.clientY;}}hover=down?.moved?null:locate(e)||null;canvas.style.cursor=down?'grabbing':hover?'pointer':'grab';paint();};
 const start=e=>{down={x:e.clientX,y:e.clientY,moved:false};canvas.setPointerCapture?.(e.pointerId);};
 const end=e=>{if(down&&!down.moved){const n=locate(e);if(n)onOpen(n.id);}down=null;canvas.style.cursor='grab';};
 const cancel=()=>{down=null;canvas.style.cursor='grab';};
 const wheel=e=>{e.preventDefault();zoom=Math.min(4,Math.max(.35,zoom*(e.deltaY<0?1.12:.89)));paint();};
 const reset=()=>{yaw=.35;pitch=.18;zoom=1;hover=null;paint();};
 canvas.addEventListener('pointerdown',start);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',cancel);canvas.addEventListener('wheel',wheel,{passive:false});resetButton?.addEventListener('click',reset);paint();
 return ()=>{canvas.removeEventListener('pointerdown',start);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',end);canvas.removeEventListener('pointercancel',cancel);canvas.removeEventListener('wheel',wheel);resetButton?.removeEventListener('click',reset);};
}
