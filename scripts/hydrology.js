// Hydrology on the coarse grid: depression filling (priority flood) and D8 flow
// direction + accumulation. Operate on typed arrays sized gw*gh.

const NB4 = [[1,0],[-1,0],[0,1],[0,-1]];
const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

// Priority-flood depression fill starting from the borders, so every land cell
// has a downhill path to the edge (no trapped single-cell pits).
export function fillDepressions(elev, gw, gh){
  const N = gw*gh;
  const filled = Float32Array.from(elev);
  const inQ = new Uint8Array(N);
  const heap = [];
  const push = (el, idx) => { heap.push([el,idx]); let c = heap.length-1;
    while(c>0){ const p=(c-1)>>1; if(heap[p][0]<=heap[c][0]) break;
      [heap[p],heap[c]]=[heap[c],heap[p]]; c=p; } };
  const pop = () => { const t=heap[0], l=heap.pop();
    if(heap.length){ heap[0]=l; let c=0;
      while(true){ let a=2*c+1,b=2*c+2,s=c;
        if(a<heap.length&&heap[a][0]<heap[s][0]) s=a;
        if(b<heap.length&&heap[b][0]<heap[s][0]) s=b;
        if(s===c) break; [heap[s],heap[c]]=[heap[c],heap[s]]; c=s; } }
    return t; };
  for(let x=0;x<gw;x++){ for(const y of [0,gh-1]){ const i=y*gw+x; push(elev[i],i); inQ[i]=1; } }
  for(let y=0;y<gh;y++){ for(const x of [0,gw-1]){ const i=y*gw+x; if(!inQ[i]){ push(elev[i],i); inQ[i]=1; } } }
  while(heap.length){
    const [el,i] = pop(); const px=i%gw, py=(i/gw)|0;
    for(const [dx,dy] of NB4){ const nx=px+dx, ny=py+dy;
      if(nx<0||ny<0||nx>=gw||ny>=gh) continue; const j=ny*gw+nx; if(inQ[j]) continue;
      filled[j] = Math.max(elev[j], el+1e-5); push(filled[j], j); inQ[j]=1; }
  }
  return filled;
}

// D8 flow direction (steepest descent) + flow accumulation over land cells.
export function computeFlow(elev, filled, gw, gh, sea){
  const N = gw*gh;
  const flowTo = new Int32Array(N).fill(-1);
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
    const i=y*gw+x; if(elev[i]<sea) continue;
    let lowest = filled[i], best = -1;
    for(const [dx,dy] of NB8){ const nx=x+dx, ny=y+dy;
      if(nx<0||ny<0||nx>=gw||ny>=gh) continue; const j=ny*gw+nx;
      if(filled[j]<lowest){ lowest=filled[j]; best=j; } }
    flowTo[i] = best;
  }
  const accum = new Float32Array(N).fill(1);
  const order = [...Array(N).keys()].filter(i=>elev[i]>=sea).sort((a,b)=>filled[b]-filled[a]);
  for(const i of order){ const j=flowTo[i]; if(j>=0) accum[j]+=accum[i]; }
  return { flowTo, accum };
}
