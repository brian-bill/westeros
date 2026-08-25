// Road network on the coarse grid: weighted A* between nearest-neighbor
// settlements (with existing-road reuse discount), rank-size tier assignment,
// and a junction graph for agent routing.

import { B } from './biomes.js';
import { S } from './state.js';

const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

function coarseMoveCost(i){
  const b = S.world.biome[i];
  if(b===B.OCEAN||b===B.DEEP_OCEAN) return 9999;
  if(b===B.RIVER||b===B.LAKE) return 40;   // bridge/ford
  if(b===B.SWAMP) return 20;
  if(b===B.MOUNTAIN) return 25;
  if(b===B.SNOW) return 60;
  if(b===B.BEACH) return 4;
  return 1;
}

function coarseAstar(startI, goalI, roadSet){
  const GW = S.GW, GH = S.GH, N = GW*GH;
  const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1);
  const gx = goalI%GW, gy = (goalI/GW)|0;
  const h = i => Math.hypot(i%GW-gx, (i/GW|0)-gy);
  const open = [[h(startI), startI]]; g[startI]=0;
  const pushO = (f,i) => { open.push([f,i]); let c=open.length-1;
    while(c>0){ const p=(c-1)>>1; if(open[p][0]<=open[c][0]) break;
      [open[p],open[c]]=[open[c],open[p]]; c=p; } };
  const popO = () => { const t=open[0], l=open.pop();
    if(open.length){ open[0]=l; let c=0;
      while(true){ let a=2*c+1,b=2*c+2,s=c;
        if(a<open.length&&open[a][0]<open[s][0]) s=a;
        if(b<open.length&&open[b][0]<open[s][0]) s=b;
        if(s===c) break; [open[s],open[c]]=[open[c],open[s]]; c=s; } }
    return t; };
  let guard=0, maxG=N*3;
  while(open.length){
    if(++guard>maxG) return null;
    const [,cur] = popO();
    if(cur===goalI){ const p=[]; let k=cur; while(k>=0){ p.push(k); k=came[k]; } return p.reverse(); }
    const cx=cur%GW, cy=(cur/GW)|0;
    for(const [dx,dy] of NB8){ const nx=cx+dx, ny=cy+dy;
      if(nx<0||ny<0||nx>=GW||ny>=GH) continue; const j=ny*GW+nx;
      let c=coarseMoveCost(j); if(c>=9999) continue;
      if(roadSet.has(j)) c*=0.3;
      const step=(dx&&dy?1.414:1)*c; const ng=g[cur]+step;
      if(ng<g[j]){ g[j]=ng; came[j]=cur; pushO(ng+h(j), j); } }
  }
  return null;
}

export function buildRoads(){
  const S_ = S.world.settlements; const GW = S.GW;
  const roadSet = new Set(); const edges = [];
  S.world.roads = { roadSet, edges };
  if(S_.length < 2){ S.world.roadGraph = { nodes:[], adj:new Map() }; return; }

  // candidate edges: each settlement to its K nearest neighbors
  const K = 3, pairs = [];
  for(let a=0;a<S_.length;a++){
    const nbrs = S_.map((s,b)=>({ b, d:Math.hypot(s.cx-S_[a].cx, s.cy-S_[a].cy) }))
      .filter(o=>o.b!==a).sort((p,q)=>p.d-q.d).slice(0,K);
    for(const {b} of nbrs){ if(b>a) pairs.push([a,b]); }
  }
  // shorter edges first so trunk roads form and get reused
  pairs.sort((e1,e2)=>Math.hypot(S_[e1[0]].cx-S_[e1[1]].cx, S_[e1[0]].cy-S_[e1[1]].cy)
                    - Math.hypot(S_[e2[0]].cx-S_[e2[1]].cx, S_[e2[0]].cy-S_[e2[1]].cy));
  for(const [a,b] of pairs){
    const path = coarseAstar(S_[a].cy*GW+S_[a].cx, S_[b].cy*GW+S_[b].cx, roadSet);
    if(path){ for(const p of path) roadSet.add(p); edges.push({a,b,path});
      S_[a].degree++; S_[b].degree++; }
  }

  // rank-size (Zipf-ish) tier distribution: many villages, few cities
  const ranked = S_.map(s=>({ s, r:s.degree + s.score*4 })).sort((a,b)=>b.r-a.r);
  const nCity = Math.max(ranked.length?1:0, Math.round(ranked.length*0.10));
  const nTown = Math.round(ranked.length*0.25);
  ranked.forEach((o,idx)=>{ o.s.tier = idx<nCity ? 2 : idx<nCity+nTown ? 1 : 0; });

  buildRoadGraph();
}

export function buildRoadGraph(){
  const S_ = S.world.settlements;
  const nodes = S_.map((s,idx)=>({ idx, cx:s.cx, cy:s.cy, tier:s.tier }));
  const adj = new Map(nodes.map(n=>[n.idx, []]));
  for(const e of S.world.roads.edges){
    const dist = e.path.length;
    adj.get(e.a).push({ to:e.b, dist, path:e.path });
    adj.get(e.b).push({ to:e.a, dist, path:[...e.path].reverse() });
  }
  S.world.roadGraph = { nodes, adj };
}
