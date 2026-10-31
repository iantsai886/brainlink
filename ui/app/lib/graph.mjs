// Pure, DOM-free graph preparation and bounded deterministic force layout.
export function parseWikiLinks(body){const clean=String(body||'').replace(/```[\s\S]*?```|`[^`\n]*`/g,'');return [...clean.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m=>m[1].trim());}
export function buildGraph(notes,{vault='',includePrivate=false,vaults=[]}={}){
 const privateVaults=new Set(vaults.filter(v=>v.private).map(v=>v.name));
 const visible=notes.filter(n=>(!vault||n.vault===vault)&&(includePrivate||(!privateVaults.has(n.vault)&&n.private!==true&&n.frontmatter?.private!==true&&n.frontmatter?.private!=='true'))&&!n.deleted&&!n.superseded);
 const nodes=visible.map(n=>({id:n.id,title:n.title,path:n.path,vault:n.vault}));const byVault=new Map();
 const norm=s=>String(s).normalize('NFKC').toLowerCase().trim().replace(/\.md$/i,'');
 for(const n of nodes){if(!byVault.has(n.vault))byVault.set(n.vault,[]);byVault.get(n.vault).push(n);}
 const edges=[];const seen=new Set();for(const n of visible){const choices=byVault.get(n.vault)||[];for(const target of parseWikiLinks(n.body)){const key=norm(target);const hit=choices.find(t=>norm(t.path)===key)||choices.find(t=>norm(t.title)===key||norm(t.path).endsWith('/'+key));if(!hit)continue;const signature=n.id+'\0'+hit.id;if(!seen.has(signature)){seen.add(signature);edges.push({source:n.id,target:hit.id});}}}return {nodes,edges};
}
export function layoutGraph(graph,{seed=42,iterations=220,width=900,height=560}={}){
 let rand=seed>>>0;const random=()=>{rand=(Math.imul(rand,1664525)+1013904223)>>>0;return rand/4294967296;};
 const nodes=graph.nodes.map(n=>({...n,x:40+random()*(width-80),y:40+random()*(height-80)}));const map=new Map(nodes.map((n,i)=>[n.id,i]));const edges=graph.edges.filter(e=>map.has(e.source)&&map.has(e.target));
 if(nodes.length>2000)return {nodes:nodes.map((n,i)=>({...n,x:width/2+Math.cos(i*2.39996)*Math.sqrt(i)*9,y:height/2+Math.sin(i*2.39996)*Math.sqrt(i)*9})),edges,static:true};
 const steps=Math.min(Math.max(0,iterations),300);for(let step=0;step<steps;step++){
  const fx=new Float64Array(nodes.length),fy=new Float64Array(nodes.length);
  if(nodes.length<=400)for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){let dx=nodes[i].x-nodes[j].x,dy=nodes[i].y-nodes[j].y,d=dx*dx+dy*dy+10,f=Math.min(8,1100/d);fx[i]+=dx*f;fy[i]+=dy*f;fx[j]-=dx*f;fy[j]-=dy*f;}
  for(const e of edges){const a=map.get(e.source),b=map.get(e.target);const dx=nodes[b].x-nodes[a].x,dy=nodes[b].y-nodes[a].y;const f=.008;fx[a]+=dx*f;fy[a]+=dy*f;fx[b]-=dx*f;fy[b]-=dy*f;}
  const cool=1-step/Math.max(1,steps);for(let i=0;i<nodes.length;i++){nodes[i].x=Math.max(15,Math.min(width-15,nodes[i].x+Math.max(-4,Math.min(4,fx[i]))*cool));nodes[i].y=Math.max(15,Math.min(height-15,nodes[i].y+Math.max(-4,Math.min(4,fy[i]))*cool));}
 }return {nodes,edges,static:false};
}

// Deterministic 3D force layout for the interactive Setup graph.
export function layoutGraph3d(graph,{seed=42,iterations=140}={}){
 let rand=seed>>>0;const random=()=>{rand=(Math.imul(rand,1664525)+1013904223)>>>0;return rand/4294967296;};
 const nodes=graph.nodes.map(n=>({...n,x:(random()-.5)*440,y:(random()-.5)*300,z:(random()-.5)*360}));
 const map=new Map(nodes.map((n,i)=>[n.id,i]));
 const edges=graph.edges.filter(e=>map.has(e.source)&&map.has(e.target));
 if(nodes.length>400){
  const golden=Math.PI*(3-Math.sqrt(5));
  for(let i=0;i<nodes.length;i++){const t=(i+.5)/nodes.length, r=300*Math.sqrt(1-t*t),a=i*golden;nodes[i].x=Math.cos(a)*r;nodes[i].y=Math.sin(a)*r;nodes[i].z=(t-.5)*420;}
  return {nodes,edges,static:true};
 }
 const steps=Math.min(Math.max(0,iterations),180);
 for(let step=0;step<steps;step++){
  const fx=new Float64Array(nodes.length),fy=new Float64Array(nodes.length),fz=new Float64Array(nodes.length);
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
   const a=nodes[i],b=nodes[j],dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z,d2=dx*dx+dy*dy+dz*dz+16,f=Math.min(7,1500/d2);
   fx[i]+=dx*f;fy[i]+=dy*f;fz[i]+=dz*f;fx[j]-=dx*f;fy[j]-=dy*f;fz[j]-=dz*f;
  }
  for(const e of edges){const a=map.get(e.source),b=map.get(e.target),dx=nodes[b].x-nodes[a].x,dy=nodes[b].y-nodes[a].y,dz=nodes[b].z-nodes[a].z;fx[a]+=dx*.006;fy[a]+=dy*.006;fz[a]+=dz*.006;fx[b]-=dx*.006;fy[b]-=dy*.006;fz[b]-=dz*.006;}
  const cool=1-step/Math.max(1,steps);
  for(let i=0;i<nodes.length;i++){nodes[i].x=bound(nodes[i].x+bound(fx[i],-4,4)*cool,-340,340);nodes[i].y=bound(nodes[i].y+bound(fy[i],-4,4)*cool,-240,240);nodes[i].z=bound(nodes[i].z+bound(fz[i],-4,4)*cool,-300,300);}
 }
 return {nodes,edges,static:false};
}
const bound=(n,min,max)=>Math.max(min,Math.min(max,n));
