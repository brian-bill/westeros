// Road network on the coarse grid with a two-class hierarchy:
//   trunk highways — mesh the hub set (predicted towns/cities), drawn wide;
//   feeder roads   — thin spurs joining every remaining settlement to the net.
// Through-traffic skirts settlement cores (avoid mask), and a metric
// demotion pass guarantees tier>=1 settlements stay >= SEP_KM[1] apart.
// Also builds the junction graph for agent routing.

import { B } from './biomes.js';
import { S, COARSE_SCALE, kmToFine } from './state.js';
import { MIN_SEP_KM } from './settlements.js';
import { gridAstar } from './navigation.js';

function coarseMoveCost(i){
  const b = S.world.biome[i];
  if(b===B.OCEAN||b===B.DEEP_OCEAN) return Infinity;
  // moderate cost: roads cross rivers/lakes with a proper bridge rather than
  // detouring absurdly along the bank (bridges get siderails at render time)
  if(b===B.RIVER||b===B.LAKE) return 14;
  if(b===B.SWAMP) return 20;
  if(b===B.MOUNTAIN) return 25;
  if(b===B.SNOW) return 60;
  if(b===B.BEACH) return 4;
  return 1;
}

export function buildRoads(){
  const S_ = S.world.settlements; const GW = S.GW, GH = S.GH;
  const roadSet = new Set(); const trunkSet = new Set(); const edges = [];
  S.world.roads = { roadSet, edges };
  if(S_.length < 2){ S.world.roadGraph = { nodes:[], adj:new Map() }; return; }
  const N = S_.length;

  // ---- predicted hierarchy (same Zipf shares as the final tiering below):
  // top ~10% of sites are city candidates, next ~25% towns, rest villages.
  const order = [...S_.keys()].sort((a,b)=>S_[b].score-S_[a].score);
  const est = new Int8Array(N);
  const nCity = Math.max(1, Math.round(N*0.10)), nTown = Math.round(N*0.25);
  order.forEach((si,idx)=>{ est[si] = idx<nCity ? 2 : idx<nCity+nTown ? 1 : 0; });

  // cells inside settlement cores that through-roads should route around
  // (endpoints are exempt, so a settlement's own spur still reaches it)
  const avoid = new Uint8Array(GW*GH);
  for(let i=0;i<N;i++){
    const s=S_[i], r=Math.max(2, Math.round([3.5,6,10][est[i]]*0.30));
    for(let y=Math.max(0,s.cy-r); y<=Math.min(GH-1,s.cy+r); y++)
      for(let x=Math.max(0,s.cx-r); x<=Math.min(GW-1,s.cx+r); x++)
        if((x-s.cx)*(x-s.cx)+(y-s.cy)*(y-s.cy) <= r*r) avoid[y*GW+x]=1;
  }

  const parent = [...Array(N).keys()];
  const find = i => { while(parent[i]!==i){ parent[i]=parent[parent[i]]; i=parent[i]; } return i; };
  const uni = (a,b)=>{ a=find(a); b=find(b); if(a!==b){ parent[a]=b; return true; } return false; };

  const link = (a,b,phase)=>{
    const startI=S_[a].cy*GW+S_[a].cx, goalI=S_[b].cy*GW+S_[b].cx;
    const path = gridAstar(startI, goalI, j=>{
      const base=coarseMoveCost(j); if(!isFinite(base)) return Infinity;
      let c=base;
      if(roadSet.has(j)) c*= phase==='highway' ? 0.3 : 0.35;
      // spurs keep their own alignment instead of running down a highway
      // corridor — pedestrians walk these roads and must not end up on trunks
      if(phase==='spur' && trunkSet.has(j)) c*=6;
      if(avoid[j] && j!==startI && j!==goalI) c*=8;   // skirt town cores
      return c;
    });
    if(!path) return false;
    for(const p of path) roadSet.add(p);
    if(phase==='highway') for(const p of path) trunkSet.add(p);
    edges.push({ a, b, path, phase });
    S_[a].degree++; S_[b].degree++;
    uni(a,b);
    return true;
  };

  // ---- highways: mesh the hub set (K nearest hub neighbors), shorter first,
  // reusing existing roads at a discount so trunk routes emerge.
  const hubs = order.slice(0, nCity+nTown);
  const pairs = [];
  for(const a of hubs){
    hubs.map(b=>({ b, d:Math.hypot(S_[b].cx-S_[a].cx, S_[b].cy-S_[a].cy) }))
      .filter(o=>o.b!==a).sort((p,q)=>p.d-q.d).slice(0,3)
      .forEach(({b})=>{ if(b>a) pairs.push([a,b]); });
  }
  pairs.sort((e1,e2)=>Math.hypot(S_[e1[0]].cx-S_[e1[1]].cx, S_[e1[0]].cy-S_[e1[1]].cy)
                    - Math.hypot(S_[e2[0]].cx-S_[e2[1]].cx, S_[e2[0]].cy-S_[e2[1]].cy));
  for(const [a,b] of pairs) link(a, b, 'highway');

  // stitch any separate highway components together (closest rep pair first)
  for(let guard=N*4; guard-->0;){
    const reps = new Map();
    for(const i of hubs) reps.set(find(i), i);
    if(reps.size<=1) break;
    let ba=-1, bb=-1, bd=Infinity;
    for(const a of reps.values()) for(const b of reps.values()){
      if(find(a)===find(b)) continue;
      const d=Math.hypot(S_[a].cx-S_[b].cx, S_[a].cy-S_[b].cy);
      if(d<bd){ bd=d; ba=a; bb=b; }
    }
    if(ba<0 || !link(ba,bb,'highway')) break;
  }
  const netRoot = find(hubs[0]);

  // ---- feeders: every settlement not yet on the net joins at the nearest
  // connected node — one thin spur per village instead of a redundant mesh.
  const failed = new Set();
  for(const si of order){
    if(find(si)===netRoot || failed.has(si)) continue;
    let bj=-1, bd=Infinity;
    for(let j=0;j<N;j++){
      if(j===si || failed.has(j) || find(j)!==netRoot) continue;
      const d=Math.hypot(S_[j].cx-S_[si].cx, S_[j].cy-S_[si].cy);
      if(d<bd){ bd=d; bj=j; }
    }
    if(bj<0 || !link(si,bj,'spur')) failed.add(si);
  }

  // ---- rank-size (Zipf-ish) tier distribution from realized centrality
  const ranked = S_.map(s=>({ s, r:s.degree + s.score*4 })).sort((a,b)=>b.r-a.r);
  const fCity = Math.max(ranked.length?1:0, Math.round(ranked.length*0.10));
  const fTown = Math.round(ranked.length*0.25);
  ranked.forEach((o,idx)=>{ o.s.tier = idx<fCity ? 2 : idx<fCity+fTown ? 1 : 0; });

  // ---- metric rule: keep tier>=1 places >= MIN_SEP_KM.urban (50 km) apart by
  // demoting clashing lower-ranked towns back to villages.
  const minSep = kmToFine(MIN_SEP_KM.urban);
  const kept = [];
  for(const o of ranked){
    const s=o.s; if(s.tier<1) continue;
    let clash=false;
    for(const k of kept) if(Math.hypot(s.x-k.x, s.y-k.y) < minSep){ clash=true; break; }
    if(clash) s.tier=0; else kept.push(s);
  }

  // classify roads: anything built as part of the highway mesh stays a trunk
  // even if an endpoint was later demoted (it's still a major regional route);
  // village spurs are feeders.
  for(const e of edges)
    e.cls = e.phase === 'highway' ? 'trunk' : 'feeder';

  // ---- bridges: siderails go wherever a road passes over PAINTED water.
  // A* can slip diagonally between two wet cells without touching either, and
  // fine rendering widens rivers beyond their coarse cells, so cell membership
  // is not enough — sample the polyline finely against the same water discs
  // the renderer paints (river ~.28 / lake ~.7 of a coarse cell wide).
  const wetAt = (x,y)=>{
    const gx=Math.round(x/COARSE_SCALE-0.5), gy=Math.round(y/COARSE_SCALE-0.5);
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      const cx=gx+dx, cy=gy+dy;
      if(cx<0||cy<0||cx>=GW||cy>=GH) continue;
      const b=S.world.biome[cy*GW+cx];
      if(b!==B.RIVER && b!==B.LAKE) continue;
      const w = b===B.LAKE ? COARSE_SCALE*0.75 : COARSE_SCALE*0.34;
      if(Math.hypot(x-(cx+0.5)*COARSE_SCALE, y-(cy+0.5)*COARSE_SCALE) < w) return true;
    }
    return false;
  };
  for(const e of edges){
    e.bridges = [];
    const pts = e.path.map(ci=>[((ci%GW)+0.5)*COARSE_SCALE, (((ci/GW)|0)+0.5)*COARSE_SCALE]);
    let run = null;
    for(let k=0;k<pts.length-1;k++){
      const [ax,ay]=pts[k], [bx,by]=pts[k+1];
      const len=Math.hypot(bx-ax,by-ay), n=Math.max(1,Math.ceil(len));
      for(let j=0;j<=n;j++){
        const t=j/n, x=ax+(bx-ax)*t, y=ay+(by-ay)*t;
        if(wetAt(x,y)){ if(!run) run=[]; run.push([x,y]); }
        else if(run){ e.bridges.push(run); run=null; }
      }
    }
    if(run) e.bridges.push(run);
  }

  markRoundabouts();

  // Cap built-up footprints (s.maxR) so neighboring settlements never overlap:
  // cities claim their full radius first, then smaller places shrink to fit the
  // gap. ensureSettlementDetail() consumes maxR when laying out streets/lots.
  const BASE_R = [3.5,6,10].map(r=>r*COARSE_SCALE*0.5);
  const MARGIN = 3;
  const byRank = [...S_].sort((a,b)=> b.tier-a.tier || b.score-a.score);
  const placedCircles = [];
  for(const s of byRank){
    let r = BASE_R[s.tier];
    for(const p of placedCircles){
      r = Math.min(r, Math.hypot(s.x-p.x, s.y-p.y) - p.r - MARGIN);
    }
    // 0 => too hemmed in for any buildings; only the marker is drawn
    s.maxR = Math.max(0, r);
    if(s.maxR > 0) placedCircles.push({ x:s.x, y:s.y, r:s.maxR });
  }

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

// ---- roundabouts -----------------------------------------------------------
// Where two roads cross away from settlement junctions, plant a roundabout.
// A crossing is a cell shared by two distinct edges whose local headings are
// NOT parallel — merged stretches run in the same direction and need no circle.
function markRoundabouts(){
  const GW = S.GW;
  const tangent = (path,k)=>{
    const a=path[Math.max(0,k-1)], b=path[Math.min(path.length-1,k+1)];
    const dx=(b%GW)-(a%GW), dy=((b/GW)|0)-((a/GW)|0), l=Math.hypot(dx,dy)||1;
    return [dx/l, dy/l];
  };
  const at = new Map();   // interior cell -> [edgeIdx, pathIdx] passes
  S.world.roads.edges.forEach((e,ei)=>{
    for(let k=1;k<e.path.length-1;k++){
      let l=at.get(e.path[k]); if(!l){ l=[]; at.set(e.path[k], l); }
      l.push([ei,k]);
    }
  });
  const pts = [];
  for(const [ci,list] of at){
    if(list.length<2) continue;
    cross:
    for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++){
      const [ea,ka]=list[i], [eb,kb]=list[j];
      if(ea===eb) continue;
      const ua=tangent(S.world.roads.edges[ea].path, ka);
      const ub=tangent(S.world.roads.edges[eb].path, kb);
      // |dot| well below 1 means the headings genuinely diverge (a crossing)
      if(Math.abs(ua[0]*ub[0]+ua[1]*ub[1]) < 0.85){
        const x=((ci%GW)+0.5)*COARSE_SCALE, y=(((ci/GW)|0)+0.5)*COARSE_SCALE;
        if(pts.every(p=>Math.hypot(p.x-x,p.y-y) > COARSE_SCALE*1.5)) pts.push({x,y});
        break cross;
      }
    }
  }
  S.world.roundabouts = pts;
}
