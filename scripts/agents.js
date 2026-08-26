// Runtime agents in three movement modes, maintained around the viewport:
//   vehicles — route over the road-junction graph (Dijkstra),
//   boats    — route between ports over the water-lane graph,
//   hikers   — STAGED trips along feeder roads only: they walk to a nearby
//              pickup settlement, ride a vehicle over the road network, then
//              walk the last leg to their destination.
// In an infinite world there is no fixed population to simulate: agents are
// spawned just outside the view, despawned when they fall far behind it, and
// finished trips simply retire (the maintainer respawns fresh ones nearby).
// All modes share waypoint machinery: cell paths rasterized into fine world
// points, walked stage by stage at kind-dependent speed.

import { mulberry32 } from './rng.js';
import { S, COARSE_SCALE } from './state.js';

const agentRand = mulberry32(98765);

const PED_COLOR = ['#4a3b2a','#3d3d33','#54423a','#333d2e'];
const BOAT_COLOR = ['#ece5d6','#d9cdb0','#c8b795'];

function dijkstraRoute(graph, from, to){
  const { adj } = graph; if(!adj) return null;
  const dist = new Map([[from,0]]), prev = new Map(), pq = [[0,from]];
  while(pq.length){
    pq.sort((a,b)=>a[0]-b[0]); const [d,u] = pq.shift();
    if(u===to) break; if(d>(dist.get(u)??Infinity)) continue;
    for(const e of (adj.get(u)||[])){ const nd = d+e.dist;
      if(nd<(dist.get(e.to)??Infinity)){ dist.set(e.to,nd); prev.set(e.to,u); pq.push([nd,e.to]); } }
  }
  if(!prev.has(to) && from!==to) return null;
  const seq = [to]; let c = to;
  while(c!==from){ c = prev.get(c); if(c==null) return null; seq.push(c); }
  return seq.reverse();
}

function cellPathFor(graph, seq){
  if(!seq||seq.length<2) return null;
  const { adj } = graph; const cells = [];
  for(let k=0;k<seq.length-1;k++){
    const e = (adj.get(seq[k])||[]).find(e=>e.to===seq[k+1]); if(!e) return null;
    const p = e.path; for(let j=(k===0?0:1);j<p.length;j++) cells.push(p[j]);
  }
  return cells;
}

const ptsFromCells = cells => cells.map(([gx,gy]) =>
  [(gx+0.5)*COARSE_SCALE, (gy+0.5)*COARSE_SCALE]);

// Road-centerline cells -> sidewalk points: shift every vertex onto one side
// of the road (perpendicular to local travel direction). The offset clears the
// widest carriageway (trunks draw 1.7 world units wide, half-width 0.85), so
// walkers never render on top of a highway.
const SIDEWALK = 1.05;
function sidewalkPts(cells, side){
  const pts = ptsFromCells(cells);
  return pts.map(([x,y],i)=>{
    const p0=pts[Math.max(0,i-1)], p1=pts[Math.min(pts.length-1,i+1)];
    const dx=p1[0]-p0[0], dy=p1[1]-p0[1], l=Math.hypot(dx,dy)||1;
    return [x - dy/l*SIDEWALK*side, y + dx/l*SIDEWALK*side];
  });
}

// Reachable nodes from src over `graph`, as [node,dist] sorted near->far.
function reachable(graph, src){
  const { adj } = graph; if(!adj) return [];
  const dist = new Map([[src,0]]), pq = [[0,src]];
  while(pq.length){
    pq.sort((a,b)=>a[0]-b[0]); const [d,u] = pq.shift();
    if(d>(dist.get(u)??Infinity)) continue;
    for(const e of (adj.get(u)||[])){ const nd=d+e.dist;
      if(nd<(dist.get(e.to)??Infinity)){ dist.set(e.to,nd); pq.push([nd,e.to]); } }
  }
  return [...dist.entries()].filter(([n,d])=>n!==src && d>=4).sort((a,b)=>a[1]-b[1]);
}

// Bias toward nearer candidates (quadratic CDF over the sorted list).
const pickTransfer = opts => opts[(agentRand()*agentRand()*opts.length)|0];

function makeStage(kind, pts, base){
  const spd = kind==='ride' ? 1 : kind==='boat' ? 0.55 : 0.2;
  return { kind, pts, speed: spd*(0.15+base*0.2)*COARSE_SCALE*0.15 };
}

// A pedestrian trip: O --walk(feeder)--> T1 ==ride(roads)==> T2 --walk(feeder)--> D,
// or a direct walk when origin and destination are close feeder neighbors.
// Confined to settlements near the viewport (`pool` of registry indexes).
function newTrip(pool){
  const fg = S.world.feederGraph, rg = S.world.roadGraph;
  if(!fg || !fg.nEdges || !rg || rg.nodes.length<2) return null;
  const st = S.world.settlements;
  if(!pool.length) return null;
  const base = agentRand();
  for(let tries=0; tries<8; tries++){
    const O=pool[(agentRand()*pool.length)|0], D=pool[(agentRand()*pool.length)|0];
    if(O===D || !st[O]) continue;
    const stages = [];
    const side = agentRand()<0.5 ? -1 : 1;

    // nearby destinations are often walked outright (no lift needed)
    const direct = reachable(fg,O).find(([n])=>n===D);
    if(direct && direct[1]<70 && agentRand()<0.5){
      const cells = cellPathFor(fg, dijkstraRoute(fg,O,D));
      if(!cells) continue;
      stages.push(makeStage('walk', sidewalkPts(cells,side), base));
      return { mode:'ped', stages, si:0, t:0,
        color: PED_COLOR[(agentRand()*PED_COLOR.length)|0],
        carColor: `hsl(${(agentRand()*360)|0} 80% 60%)` };
    }

    // otherwise: walk to pickup, ride the network, walk from dropoff
    const nearO = reachable(fg,O); if(!nearO.length) continue;
    const nearD = reachable(fg,D); if(!nearD.length) continue;
    const T1 = pickTransfer(nearO)[0], T2 = pickTransfer(nearD)[0];
    const w1 = cellPathFor(fg, dijkstraRoute(fg,O,T1)); if(!w1) continue;
    const w2cells = cellPathFor(fg, dijkstraRoute(fg,D,T2)); if(!w2cells) continue;
    const ride = cellPathFor(rg, dijkstraRoute(rg,T1,T2)); if(!ride) continue;

    stages.push(makeStage('walk', sidewalkPts(w1,side), base));
    if(ride.length>3) stages.push(makeStage('ride', ptsFromCells(ride), base));
    stages.push(makeStage('walk', sidewalkPts([...w2cells].reverse(), side), base));
    return { mode:'ped', stages, si:0, t:agentRand()*3,
      color: PED_COLOR[(agentRand()*PED_COLOR.length)|0],
      carColor: `hsl(${(agentRand()*360)|0} 80% 60%)` };
  }
  return null;
}

// graph-routed trip between two random nodes of the road/water network that
// both sit near the viewport (`pool` of node indexes into graph.nodes)
function newGraphAgent(graph, mode, pool){
  const nodes = graph.nodes; if(!pool.length) return null;
  let from=pool[(agentRand()*pool.length)|0], to=pool[(agentRand()*pool.length)|0], tr=0;
  while(to===from && tr++<10) to=pool[(agentRand()*pool.length)|0];
  const cells = cellPathFor(graph, dijkstraRoute(graph, from, to));
  if(!cells||cells.length<2) return null;
  return { mode, stages:[makeStage(mode, ptsFromCells(cells), agentRand())],
    si:0, t:agentRand()*(cells.length-1),
    color: mode==='vehicle' ? `hsl(${(agentRand()*360)|0} 80% 60%)`
         : BOAT_COLOR[(agentRand()*BOAT_COLOR.length)|0],
    carColor:'#888' };
}

// Random node/settlement indexes inside a coarse rect (random probes — the
// registries are append-only and unsorted, so probing beats filtering).
function probePool(count, total, inRect){
  const pool = [];
  for(let t=0;t<count && pool.length<40;t++){
    const i=(agentRand()*total)|0;
    if(inRect(i)) pool.push(i);
  }
  return pool;
}

let maintTimer = 0;

// Spawn missing agents near the view and drop those far behind it.
export function maintainAgents(dt, rx0, ry0, rx1, ry1){
  maintTimer -= dt;
  const wSpan = rx1-rx0, hSpan = ry1-ry0;
  // spawn ring: just outside the view
  const mx = wSpan*0.25, my = hSpan*0.25;
  // despawn ring: well behind it (agents finishing trips out there retire)
  const ex0=rx0-wSpan*0.75, ex1=rx1+wSpan*0.75, ey0=ry0-hSpan*0.75, ey1=ry1+hSpan*0.75;
  const inRect = (x,y) => x>=rx0-mx && x<=rx1+mx && y>=ry0-my && y<=ry1+my;

  for(let i=S.agents.length-1;i>=0;i--){
    const a=S.agents[i];
    const st=a.stages[a.si], n=st.pts.length;
    const p=st.pts[Math.max(0,Math.min(n-1,Math.floor(a.t)))];
    if(!p || p[0]<ex0 || p[0]>ex1 || p[1]<ey0 || p[1]>ey1){
      S.agents[i]=S.agents[S.agents.length-1]; S.agents.pop();
    }
  }

  if(maintTimer > 0) return;
  maintTimer = 0.8;
  const w = S.world; if(!w) return;

  const nodeInRect = g => i => {
    const n=g.nodes[i]; return n && inRect((n.cx+0.5)*COARSE_SCALE,(n.cy+0.5)*COARSE_SCALE);
  };
  const targets = [
    ['vehicle', Math.min(80, Math.max(8, w.roads.edges.length/3|0)),
     () => newGraphAgent(w.roadGraph,'vehicle',
           probePool(30, w.roadGraph.nodes.length, nodeInRect(w.roadGraph)))],
    ['boat', Math.min(36, Math.max(4, w.waterGraph.lanes.length*0.8|0)),
     () => newGraphAgent(w.waterGraph,'boat',
           probePool(30, w.waterGraph.nodes.length, nodeInRect(w.waterGraph)))],
    ['ped', Math.min(60, Math.max(6, w.settlements.length/4|0)),
     () => newTrip(probePool(30, w.settlements.length,
            i => { const s=w.settlements[i]; return s && inRect(s.x,s.y); }))],
  ];
  for(const [mode, target, make] of targets){
    let have = S.agents.filter(a=>a.mode===mode).length;
    let guard = 12;
    while(have < target && guard-- > 0){
      const a = make();
      if(a){ S.agents.push(a); have++; }
    }
  }
}

export function stepAgents(dt){
  for(const a of S.agents){
    const st = a.stages[a.si];
    a.t += st.speed*dt/COARSE_SCALE;
    if(a.t >= st.pts.length-1){
      if(a.si < a.stages.length-1){ a.si++; a.t=0; }
      else a.retired = true;   // maintainer will replace it near the viewport
    }
  }
  for(let i=S.agents.length-1;i>=0;i--)
    if(S.agents[i].retired){ S.agents[i]=S.agents[S.agents.length-1]; S.agents.pop(); }
}

const curPts = a => a.stages[a.si].pts;

export function agentPos(a){
  const pts = curPts(a); const n = pts.length; if(!n) return [0,0];
  const i = Math.max(0, Math.floor(a.t)), f = a.t-i;
  const p0 = pts[Math.min(i,n-1)], p1 = pts[Math.min(i+1,n-1)];
  return [p0[0]+(p1[0]-p0[0])*f, p0[1]+(p1[1]-p0[1])*f];
}

// unit direction of travel, for orienting shaped agents (boat hulls)
export function agentTangent(a){
  const pts = curPts(a); const n = pts.length; if(n<2) return [1,0];
  const i = Math.max(0, Math.floor(a.t));
  const p0 = pts[Math.min(i,n-1)], p1 = pts[Math.min(i+1,n-1)];
  const dx=p1[0]-p0[0], dy=p1[1]-p0[1], l=Math.hypot(dx,dy)||1;
  return [dx/l, dy/l];
}
