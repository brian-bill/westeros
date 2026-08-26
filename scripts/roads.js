// Road network, built incrementally as the infinite world streams in.
//
// The finite world meshed hubs with one global A* tournament; infinity uses
// nearest-neighbor wiring, which is deterministic and purely local:
//   trunks  — every town/city links to its 3 nearest urban places
//   feeders — every village links to its 2 nearest settlements of any tier
// Edges are canonical (sorted endpoint ids) and deduped, so both endpoints'
// tiles proposing the same link collapse into one. Paths are laid lazily by
// windowed A* once the corridor's tiles have streamed; through-routes skirt
// settlement cores, feeders avoid trunk corridors, and bridges get siderails
// wherever the alignment crosses painted water. Also maintains the junction
// graph (vehicles), feeder subgraph (hikers) and roundabouts.

import { B } from './biomes.js';
import { S, COARSE_SCALE } from './state.js';
import { biomeCell, routeCoarse } from './navigation.js';
import { settlementsNear } from './settlements.js';

function moveCost(b){
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

// Propose an edge to each of s's nearest neighbors. Cheap (no paths yet);
// runs once per settlement at registration and whenever new candidates appear.
export function tryLinkSettlement(s){
  const urban = s.tier >= 1;
  const R = urban ? 220 : 36;                       // reach, coarse cells
  const K = urban ? 3 : 2;
  const near = settlementsNear(s.cx, s.cy, R, o => o !== s);
  let linked = 0;
  for(const o of near){
    if(linked >= K) break;
    if(urban && o.tier === 0) continue;             // trunks join urban places
    const key = Math.min(s.idx,o.idx) + ':' + Math.max(s.idx,o.idx);
    if(S.world.roads.edgeKeys.has(key)){ linked++; continue; }
    S.world.roads.edgeKeys.add(key);
    const edge = {
      key,
      a: Math.min(s.idx,o.idx), b: Math.max(s.idx,o.idx),
      cls: urban && o.tier >= 1 ? 'trunk' : 'feeder',
      path: null, bridges: []
    };
    S.world.roads.edges.push(edge);
    S.world.roads.edgeByKey.set(key, edge);
    linked++;
  }
}

// Cells inside settlement cores that through-roads should route around.
// Built fresh per path search over the search window only.
function buildCoreAvoid(x0,y0,x1,y1){
  const avoid = new Set();
  for(const s of settlementsNear(((x0+x1)/2)|0, ((y0+y1)/2)|0,
                                 Math.hypot(x1-x0,y1-y0)/2 + 12, () => true)){
    const r = Math.max(2, Math.round([3.5,6,10][s.tier]*0.30));
    for(let y=Math.max(y0,s.cy-r); y<=Math.min(y1,s.cy+r); y++)
      for(let x=Math.max(x0,s.cx-r); x<=Math.min(x1,s.cx+r); x++)
        if((x-s.cx)*(x-s.cx)+(y-s.cy)*(y-s.cy) <= r*r) avoid.add(x+','+y);
  }
  return avoid;
}

// Bridges: siderails go wherever a road passes over PAINTED water. A* can
// slip diagonally between two wet cells without touching either, and fine
// rendering widens rivers beyond their coarse cells, so sample the polyline
// finely against the same water discs the renderer paints.
function computeBridges(edge){
  const wetAt = (x,y)=>{
    const gx=Math.round(x/COARSE_SCALE-0.5), gy=Math.round(y/COARSE_SCALE-0.5);
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      const b = biomeCell(gx+dx, gy+dy);
      if(b!==B.RIVER && b!==B.LAKE) continue;
      const w = b===B.LAKE ? COARSE_SCALE*0.75 : COARSE_SCALE*0.40;
      if(Math.hypot(x-(gx+dx+0.5)*COARSE_SCALE, y-(gy+dy+0.5)*COARSE_SCALE) < w) return true;
    }
    return false;
  };
  const pts = edge.path.map(([gx,gy])=>[(gx+0.5)*COARSE_SCALE, (gy+0.5)*COARSE_SCALE]);
  let run = null;
  for(let k=0;k<pts.length-1;k++){
    const [ax,ay]=pts[k], [bx,by]=pts[k+1];
    const len=Math.hypot(bx-ax,by-ay), n=Math.max(1,Math.ceil(len));
    for(let j=0;j<=n;j++){
      const t=j/n, x=ax+(bx-ax)*t, y=ay+(by-ay)*t;
      if(wetAt(x,y)){ if(!run) run=[]; run.push([x,y]); }
      else if(run){ edge.bridges.push(run); run=null; }
    }
  }
  if(run) edge.bridges.push(run);
}

// ---- roundabouts -----------------------------------------------------------
// Where two roads cross away from settlement junctions, plant a roundabout.
// A crossing is a cell shared by two distinct edges whose local headings are
// NOT parallel — merged stretches run in the same direction and need none.
const cellPasses = new Map();   // "gx,gy" -> [[edgeKey, k]]
const raSet = new Set();
const tangent = (path,k)=>{
  const a=path[Math.max(0,k-1)], b=path[Math.min(path.length-1,k+1)];
  const dx=b[0]-a[0], dy=b[1]-a[1], l=Math.hypot(dx,dy)||1;
  return [dx/l, dy/l];
};
function markRoundabouts(edge){
  const byKey = S.world.roads.edgeByKey;
  for(let k=1;k<edge.path.length-1;k++){
    const [gx,gy]=edge.path[k], ck=gx+','+gy;
    let list=cellPasses.get(ck); if(!list){ list=[]; cellPasses.set(ck,list); }
    list.push([edge.key, k]);
    if(list.length<2) continue;
    // compare only against the previous pass: enough to catch fresh crossings
    const [ea,ka]=list[list.length-2], [eb,kb]=list[list.length-1];
    if(ea===eb) continue;
    const ea2=byKey.get(ea), eb2=byKey.get(eb);
    if(!ea2||!eb2||!ea2.path||!eb2.path) continue;
    const ua=tangent(ea2.path,ka), ub=tangent(eb2.path,kb);
    if(Math.abs(ua[0]*ub[0]+ua[1]*ub[1]) >= 0.85) continue;   // parallel merge
    const x=(gx+0.5)*COARSE_SCALE, y=(gy+0.5)*COARSE_SCALE;
    if(S.world.roundabouts.every(p => Math.hypot(p.x-x,p.y-y) > COARSE_SCALE*1.5)){
      S.world.roundabouts.push({x,y}); raSet.add(ck);
    }
  }
}

// Lay pending paths for edges near the viewport (coarse rect). Called each
// frame; returns true when anything new was built (callers may redraw).
export function ensureRoads(x0,y0,x1,y1){
  let built = false;
  for(const e of S.world.roads.edges){
    if(e.path) continue;
    const sa=S.world.settlements[e.a], sb=S.world.settlements[e.b];
    if(!sa || !sb) continue;
    const ex0=Math.min(sa.cx,sb.cx)-4, ex1=Math.max(sa.cx,sb.cx)+4;
    const ey0=Math.min(sa.cy,sb.cy)-4, ey1=Math.max(sa.cy,sb.cy)+4;
    if(ex1<x0||ex0>x1||ey1<y0||ey0>y1) continue;

    const pad = 12;
    const avoidSet = buildCoreAvoid(ex0-pad, ey0-pad, ex1+pad, ey1+pad);
    const path = routeCoarse(sa.cx, sa.cy, sb.cx, sb.cy, (gx,gy)=>{
      const base = moveCost(biomeCell(gx,gy));
      if(!isFinite(base)) return Infinity;
      let c = base;
      const ck = gx+','+gy;
      if(S.world.roads.roadCells.has(ck)) c *= e.cls==='trunk' ? 0.3 : 0.35;
      if(e.cls==='feeder' && S.world.roads.trunkCells.has(ck)) c *= 6;
      if(avoidSet.has(ck) && !(gx===sa.cx&&gy===sa.cy) && !(gx===sb.cx&&gy===sb.cy)) c *= 8;
      return c;
    }, pad);
    if(path === undefined) continue;   // corridor not streamed yet; retry later
    if(path !== null){
      e.path = path;
      for(const [gx,gy] of e.path){
        const ck = gx+','+gy;
        S.world.roads.roadCells.add(ck);
        if(e.cls==='trunk') S.world.roads.trunkCells.add(ck);
      }
      computeBridges(e);
      markRoundabouts(e);
      const dist = e.path.length;
      S.world.roadGraph.adj.get(e.a)?.push({ to:e.b, dist, path:e.path });
      S.world.roadGraph.adj.get(e.b)?.push({ to:e.a, dist, path:[...e.path].reverse() });
      if(e.cls==='feeder'){
        S.world.feederGraph.adj.get(e.a)?.push({ to:e.b, dist, path:e.path });
        S.world.feederGraph.adj.get(e.b)?.push({ to:e.a, dist, path:[...e.path].reverse() });
        S.world.feederGraph.nEdges++;
      }
      sa.degree++; sb.degree++;
      built = true;
    }
  }
  return built;
}
