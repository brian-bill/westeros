// Multi-modal navigation infrastructure for an unbounded world.
//
// The finite world ran A* over one global grid; infinity extracts a bounded
// WINDOW around each route and searches that. Callers guarantee the window's
// tiles are streamed, so costs always read canonical data. Buffers are pooled
// per window size and stamped per call, so repeated searches never pay an
// O(N) clear.
//
//   vehicles  — over the road-junction graph (roads.js)
//   boats     — between ports along sea lanes laid through navigable water
//   hikers    — along FEEDER-road spurs only (feederGraph, also roads.js)

import { B } from './biomes.js';
import { S } from './state.js';
import { coarseBiomeAt, isAreaReady } from './worldTiles.js';
import { settlementsNear } from './settlements.js';

const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

// Generic windowed 8-connected A*. start/goal are LOCAL indices into the
// w×h window. With noCornerCut, diagonal steps are only allowed when BOTH
// flanking orthogonal cells are passable too, so paths never clip across an
// impassable corner (keeps boats off shoreline land). Returns local indices.
const pools = new Map();
let callId = 0;
export function astarWindow(w, h, startI, goalI, cellCost, maxExpand, noCornerCut){
  const N = w*h;
  let pool = pools.get(N);
  if(!pool){ pool = { g:new Float32Array(N), came:new Int32Array(N), stamp:new Int32Array(N) }; pools.set(N,pool); }
  const { g, came, stamp } = pool;
  const cid = ++callId;
  const G = j => stamp[j]===cid ? g[j] : Infinity;
  const gx = goalI%w, gy=(goalI/w)|0;
  const hEst = i => Math.hypot(i%w-gx, ((i/w)|0)-gy);
  const open = [[hEst(startI), startI]]; g[startI]=0; stamp[startI]=cid; came[startI]=-1;
  const pushO = (f,i)=>{ open.push([f,i]); let c=open.length-1;
    while(c>0){ const p=(c-1)>>1; if(open[p][0]<=open[c][0]) break;
      [open[p],open[c]]=[open[c],open[p]]; c=p; } };
  const popO = ()=>{ const t=open[0], l=open.pop();
    if(open.length){ open[0]=l; let c=0;
      while(true){ let a=2*c+1,b=2*c+2,s=c;
        if(a<open.length&&open[a][0]<open[s][0]) s=a;
        if(b<open.length&&open[b][0]<open[s][0]) s=b;
        if(s===c) break;
        [open[s],open[c]]=[open[c],open[s]]; c=s; } }
    return t; };
  let guard = maxExpand ?? N*3;
  while(open.length){
    if(guard-- <= 0) return null;
    const [,cur] = popO();
    if(cur===goalI){ const p=[]; let k=cur; while(k>=0){ p.push(k); k=came[k]; } return p.reverse(); }
    const cx=cur%w, cy=(cur/w)|0;
    for(const [dx,dy] of NB8){
      const nx=cx+dx, ny=cy+dy;
      if(nx<0||ny<0||nx>=w||ny>=h) continue;
      const j=ny*w+nx;
      const c=cellCost(j); if(!isFinite(c)) continue;
      if(noCornerCut && dx && dy &&
         (!isFinite(cellCost(cy*w+nx)) || !isFinite(cellCost(ny*w+cx)))) continue;
      const ng=g[cur]+(dx&&dy?1.414:1)*c;
      if(ng<G(j)){ g[j]=ng; stamp[j]=cid; came[j]=cur; pushO(ng+hEst(j), j); }
    }
  }
  return null;
}

// Canonical biome at a COARSE cell (-1 when its tile isn't streamed).
export const biomeCell = (gx,gy) => coarseBiomeAt((gx+0.5)*8, (gy+0.5)*8);

// True when every tile under a coarse rect has streamed.
export function coarseRectReady(x0,y0,x1,y1){
  return isAreaReady(x0*8, y0*8, (x1+1)*8, (y1+1)*8);
}

// Run a windowed A* between two coarse points; returns WORLD-cell pairs.
//   path   — reachable
//   null   — searched and truly unreachable
//   undefined — window not streamed yet; caller should retry later
export function routeCoarse(ax, ay, bx, by, costAt, pad=10, noCornerCut=false){
  const x0=Math.min(ax,bx)-pad, y0=Math.min(ay,by)-pad;
  const w=Math.abs(ax-bx)+2*pad+1, h=Math.abs(ay-by)+2*pad+1;
  if(!coarseRectReady(x0,y0,x0+w-1,y0+h-1)) return undefined;
  const startI=(ay-y0)*w+(ax-x0), goalI=(by-y0)*w+(bx-x0);
  const local = j => costAt(x0+(j%w), y0+((j/w)|0));
  const path = astarWindow(w, h, startI, goalI, local, w*h*3, noCornerCut);
  if(!path) return null;
  return path.map(j => [x0+(j%w), y0+((j/w)|0)]);
}

// ---- boats -----------------------------------------------------------------
// Deep channels are fastest; narrow winding rivers slow boats down a lot, so
// lanes prefer open water and only use rivers to reach inland harbors.
const WATER_COST = {
  [B.DEEP_OCEAN]:0.8, [B.OCEAN]:1, [B.LAKE]:1, [B.RIVER]:3,
};
const isNavigable = b => b===B.OCEAN || b===B.DEEP_OCEAN || b===B.LAKE || b===B.RIVER;

// Every settlement within ~6 coarse cells of navigable water becomes a port.
// Anchorage quality tiers: fully offshore (hulls never touch painted
// shoreline) > open water (ocean/lake) > river bank, nearest within tier.
export function assignPort(s){
  if(s.portTried) return;
  s.portTried = true;          // one attempt; ports don't move once placed
  const R = 6;
  let best=null, bestScore=-Infinity;
  for(let dy=-R;dy<=R;dy++) for(let dx=-R;dx<=R;dx++){
    const gx=s.cx+dx, gy=s.cy+dy;
    const b = biomeCell(gx,gy);
    if(b<0 || !isNavigable(b)) continue;
    const d2 = dx*dx+dy*dy;
    let cls = b!==B.RIVER ? 1 : 0;
    if(cls===1){
      let offshore=true;
      for(const [ox,oy] of NB8) if(!isNavigable(biomeCell(gx+ox,gy+oy))){ offshore=false; break; }
      if(offshore) cls=2;
    }
    const score = cls*10000 - d2;   // class dominates: a usable berth far away beats a closer river bank
    if(score>bestScore){ bestScore=score; best={ cx:gx, cy:gy }; }
  }
  s.port = best;
  if(best){
    const idx = S.world.waterGraph.nodes.length;
    S.world.waterGraph.nodes.push({ idx, cx:best.cx, cy:best.cy });
    S.world.waterGraph.adj.set(idx, []);
    s.wnode = idx;
  }
}

const LANE_MAX = 140;     // routine ferry hops: <= ~140 coarse cells (~112 km)

// Lay missing lanes between nearby ports whose corridors have streamed.
// Called each frame with the viewport rect (coarse cells).
export function ensureLanes(x0,y0,x1,y1){
  const wg = S.world.waterGraph;
  const center_x=(x0+x1)/2, center_y=(y0+y1)/2;
  const reach = Math.max(x1-x0, y1-y0)/2 + LANE_MAX;
  const ports = settlementsNear(center_x|0, center_y|0, reach,
                                s => s.port && s.wnode!==undefined);
  for(const s of ports){
    const others = settlementsNear(s.cx, s.cy, LANE_MAX,
                                   o => o!==s && o.port && o.wnode!==undefined);
    let linked = 0;
    for(const o of others){
      if(linked >= 2) break;
      const key = Math.min(s.wnode,o.wnode) + ':' + Math.max(s.wnode,o.wnode);
      if(wg.laneKeys.has(key)){ linked++; continue; }
      const path = routeCoarse(s.port.cx, s.port.cy, o.port.cx, o.port.cy,
                               (gx,gy) => WATER_COST[biomeCell(gx,gy)] ?? Infinity,
                               8, true);
      if(path === undefined) continue;       // tiles not in yet; retry later
      wg.laneKeys.add(key);                  // definitive result — don't retry
      if(path === null || path.length < 2) continue;
      wg.adj.get(s.wnode)?.push({ to:o.wnode, dist:path.length, path });
      wg.adj.get(o.wnode)?.push({ to:s.wnode, dist:path.length, path:[...path].reverse() });
      wg.lanes.push(path);
      linked++;
    }
  }
}
