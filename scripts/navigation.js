// Multi-modal navigation infrastructure. A shared 8-connected grid A* powers
// the generated networks:
//   vehicles  — over the road-junction graph (see roads.js)
//   boats     — between ports along sea lanes laid by waterA* through any
//               navigable water (ocean / lake / river)
//   hikers    — along FEEDER roads only (never trunks, never cross-country);
//               they ride vehicles for long hauls (see agents.js)

import { B } from './biomes.js';
import { S } from './state.js';

const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

// Generic grid A* on the coarse world grid. cellCost(j) returns the per-cell
// move cost, or Infinity for impassable cells. maxExpand caps popped nodes
// (fail-fast for unreachable goals). With noCornerCut, diagonal steps are only
// allowed when BOTH flanking orthogonal cells are passable too, so paths never
// clip across an impassable corner (keeps boats off shoreline land). Buffers
// are pooled and stamped per call, so repeated searches never pay an O(grid)
// clear. Returns coarse cell indices start..goal, or null when unreachable.
let pool = { N:0 };
let callId = 0;
export function gridAstar(startI, goalI, cellCost, maxExpand, noCornerCut){
  const GW = S.GW, GH = S.GH, N = GW*GH;
  if(pool.N !== N) pool = { N, g:new Float32Array(N), came:new Int32Array(N),
                            stamp:new Int32Array(N) };
  const { g, came, stamp } = pool;
  const cid = ++callId;
  const G = j => stamp[j]===cid ? g[j] : Infinity;
  const gx = goalI%GW, gy = (goalI/GW)|0;
  const h = i => Math.hypot(i%GW-gx, (i/GW|0)-gy);
  const open = [[h(startI), startI]]; g[startI] = 0; stamp[startI] = cid; came[startI] = -1;
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
  let guard = maxExpand ?? N*3;
  while(open.length){
    if(guard-- <= 0) return null;
    const [,cur] = popO();
    if(cur===goalI){ const p=[]; let k=cur; while(k>=0){ p.push(k); k=came[k]; } return p.reverse(); }
    const cx=cur%GW, cy=(cur/GW)|0;
    for(const [dx,dy] of NB8){ const nx=cx+dx, ny=cy+dy;
      if(nx<0||ny<0||nx>=GW||ny>=GH) continue; const j=ny*GW+nx;
      const c=cellCost(j); if(!isFinite(c)) continue;
      if(noCornerCut && dx && dy &&
         (!isFinite(cellCost(cy*GW+nx)) || !isFinite(cellCost(ny*GW+cx)))) continue;
      const ng=g[cur]+(dx&&dy?1.414:1)*c;
      if(ng<G(j)){ g[j]=ng; stamp[j]=cid; came[j]=cur; pushO(ng+h(j), j); } }
  }
  return null;
}

// ---- boats -----------------------------------------------------------------
// Deep channels are fastest; narrow winding rivers slow boats down a lot, so
// lanes prefer open water and only use rivers to reach inland harbors.
const WATER_COST = {
  [B.DEEP_OCEAN]:0.8, [B.OCEAN]:1, [B.LAKE]:1, [B.RIVER]:3,
};
const isNavigable = b => b===B.OCEAN || b===B.DEEP_OCEAN || b===B.LAKE || b===B.RIVER;

// Ports + sea lanes: every settlement within ~6 coarse cells of navigable
// water becomes a port. First flood the water network FROM OPEN OCEAN using
// the exact movement rules lanes will use (corner-cut-free diagonals), so a
// port is only ever anchored on water a boat can actually sail away from —
// narrow diagonal river kinks that break legal movement strand no ports.
// Anchorage quality tiers: fully offshore (hulls never touch painted
// shoreline) > open water (ocean/lake) > river bank, nearest within tier.
// Lanes join each port to its nearest neighbor ports (plus component
// stitching so harbors on one coast reach those of another). Same shape as
// the road graph, so agent routing works identically over both.
export function buildWaterways(){
  const { biome } = S.world;
  const GW = S.GW, GH = S.GH, N = GW*GH;

  // legally-reachable water, flooded from the open sea with lane movement rules
  const reach = new Uint8Array(N);
  const stack = [];
  for(let i=0;i<N;i++){
    const b=biome[i];
    if(b===B.OCEAN || b===B.DEEP_OCEAN){ reach[i]=1; stack.push(i); }
  }
  while(stack.length){
    const i=stack.pop(), x=i%GW, y=(i/GW)|0;
    for(const [dx,dy] of NB8){
      const nx=x+dx, ny=y+dy;
      if(nx<0||ny<0||nx>=GW||ny>=GH) continue;
      const j=ny*GW+nx;
      if(reach[j] || !isNavigable(biome[j])) continue;
      if(dx && dy &&
         (!isNavigable(biome[y*GW+nx]) || !isNavigable(biome[ny*GW+x]))) continue;
      reach[j]=1; stack.push(j);
    }
  }

  const offshore = ci => {
    const x=ci%GW, y=(ci/GW)|0;
    if(x<1||y<1||x>=GW-1||y>=GH-1) return false;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++)
      if(!isNavigable(biome[(y+dy)*GW+(x+dx)])) return false;
    return true;
  };
  const ports = [];
  for(const s of S.world.settlements){
    const R = 6;
    let best=-1, bestScore=-Infinity;
    for(let y=Math.max(0,s.cy-R); y<=Math.min(GH-1,s.cy+R); y++)
      for(let x=Math.max(0,s.cx-R); x<=Math.min(GW-1,s.cx+R); x++){
        const j=y*GW+x;
        if(!reach[j]) continue;
        const d=(x-s.cx)*(x-s.cx)+(y-s.cy)*(y-s.cy);
        const cls = offshore(j) ? 2 : biome[j]!==B.RIVER ? 1 : 0;
        // class dominates: a usable berth far away beats a closer river bank
        const score = cls*10000 - d;
        if(score>bestScore){ bestScore=score; best=j; }
      }
    if(best>=0) ports.push(best);
  }

  const nodes = ports.map((ci,idx)=>({ idx, cx:ci%GW, cy:(ci/GW|0) }));
  const adj = new Map(nodes.map(n=>[n.idx, []]));
  S.world.waterGraph = { nodes, adj, lanes:[] };
  if(nodes.length < 2) return;

  const tried = new Set();
  const LANE_MAX = 90;      // routine ferry hops: <= ~90 coarse cells (~72 km)
  const STITCH_MAX = 170;   // longer hops allowed when joining separate networks
  const lane = (a,b,maxLen)=>{
    const key = a<b ? a*nodes.length+b : b*nodes.length+a;
    if(tried.has(key)) return false;         // dedupe pairs & failed retries
    tried.add(key);
    if(Math.hypot(nodes[a].cx-nodes[b].cx, nodes[a].cy-nodes[b].cy) > (maxLen ?? LANE_MAX)) return false;
    const path = gridAstar(nodes[a].cy*GW+nodes[a].cx, nodes[b].cy*GW+nodes[b].cx,
                           j => WATER_COST[biome[j]] ?? Infinity, 80000, true);
    if(!path || path.length<2) return false;
    adj.get(a).push({ to:b, dist:path.length, path });
    adj.get(b).push({ to:a, dist:path.length, path:[...path].reverse() });
    S.world.waterGraph.lanes.push(path);
    return true;
  };

  // each port tries its 3 nearest harbor neighbors
  for(let a=0;a<nodes.length;a++){
    nodes.map((n,b)=>({ b, d:Math.hypot(n.cx-nodes[a].cx, n.cy-nodes[a].cy) }))
      .filter(o=>o.b!==a).sort((p,q)=>p.d-q.d).slice(0,3)
      .forEach(({b})=>lane(a,b));
  }

  // stitch separate components together (closest pair first) until either one
  // navigable network remains or no crossing exists (landlocked seas stay put)
  const parent = [...nodes.keys()];
  const find = i => { while(parent[i]!==i){ parent[i]=parent[parent[i]]; i=parent[i]; } return i; };
  let misses = 0;
  // union via lane endpoints recorded during construction
  for(const [k,edges] of adj) for(const l of edges){
    const a=find(+k), b=find(l.to);
    if(a!==b) parent[a]=b;
  }
  for(let guard=nodes.length*2; guard-->0;){
    const reps = new Map();
    for(const i of parent.keys()) reps.set(find(i), i);
    if(reps.size<=1) break;
    let ba=-1, bb=-1, bd=Infinity;
    for(const a of reps.values()) for(const b of reps.values()){
      if(find(a)===find(b)) continue;
      const d=Math.hypot(nodes[a].cx-nodes[b].cx, nodes[a].cy-nodes[b].cy);
      if(d<bd){ bd=d; ba=a; bb=b; }
    }
    if(ba<0) break;
    // a single unroutable hop must not abandon stitching — try the next
    // closest pair (a few consecutive misses means the seas really are apart)
    if(!lane(ba,bb,STITCH_MAX)){ if(++misses>=10) break; continue; }
    misses = 0;
    const ra=find(ba), rb=find(bb);
    if(ra!==rb) parent[ra]=rb;   // union now so the next pass sees progress
  }
}

// ---- pedestrians -----------------------------------------------------------
// Walkers are restricted to the FEEDER-road subgraph: thin village spurs only.
// Trunk highways are excluded (people don't walk on major roads) and so is
// cross-country travel. Buildings already keep clear of road corridors
// (settlementDetail.js ROAD_CLEAR), and walkers get a sidewalk offset, so a
// walking leg never crosses a house. The graph has the same shape as the road
// graph, so Dijkstra routing + cell-path extraction work identically on both.
export function buildFeederGraph(){
  const nodes = S.world.settlements.map((s,idx)=>({ idx, cx:s.cx, cy:s.cy }));
  const adj = new Map(nodes.map(n=>[n.idx, []]));
  let nEdges = 0;
  for(const e of S.world.roads.edges){
    if(e.cls !== 'feeder') continue;
    adj.get(e.a)?.push({ to:e.b, dist:e.path.length, path:e.path });
    adj.get(e.b)?.push({ to:e.a, dist:e.path.length, path:[...e.path].reverse() });
    nEdges++;
  }
  S.world.feederGraph = { nodes, adj, nEdges };
}
