// Runtime agents (vehicles) that route over the coarse road-junction graph
// (Dijkstra) and move through fine world space between waypoints.

import { mulberry32 } from './rng.js';
import { S, COARSE_SCALE } from './state.js';

const agentRand = mulberry32(98765);

function routeNodes(from, to){
  const { adj } = S.world.roadGraph; if(!adj) return null;
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

function cellPathFor(seq){
  if(!seq||seq.length<2) return null;
  const { adj } = S.world.roadGraph; const cells = [];
  for(let k=0;k<seq.length-1;k++){
    const e = (adj.get(seq[k])||[]).find(e=>e.to===seq[k+1]); if(!e) return null;
    const p = e.path; for(let j=(k===0?0:1);j<p.length;j++) cells.push(p[j]);
  }
  return cells;
}

function newAgent(){
  const nodes = S.world.roadGraph.nodes; const N = nodes.length; if(N<2) return null;
  let from=(agentRand()*N)|0, to=(agentRand()*N)|0, tr=0;
  while(to===from && tr++<10) to=(agentRand()*N)|0;
  const cells = cellPathFor(routeNodes(from,to)); if(!cells||cells.length<2) return null;
  const pts = cells.map(ci => [((ci%S.GW)+0.5)*COARSE_SCALE, ((ci/S.GW|0)+0.5)*COARSE_SCALE]);
  return { pts, t:0, speed:(0.15+agentRand()*0.2)*COARSE_SCALE*0.15,
    color:`hsl(${(agentRand()*360)|0} 80% 60%)` };
}

export function spawnAgents(){
  S.agents = [];
  if(!S.world.roadGraph || S.world.roadGraph.nodes.length<2) return;
  const target = Math.min(120, Math.max(10, S.world.roads.edges.length));
  let guard = 0;
  while(S.agents.length<target && guard++<target*5){ const a=newAgent(); if(a) S.agents.push(a); }
}

export function stepAgents(dt){
  for(const a of S.agents){
    a.t += a.speed*dt/COARSE_SCALE;
    if(a.t >= a.pts.length-1){ const na=newAgent(); if(na) Object.assign(a,na); else a.t=0; }
  }
}

export function agentPos(a){
  const i = Math.floor(a.t), f = a.t-i;
  const p0 = a.pts[Math.min(i,a.pts.length-1)], p1 = a.pts[Math.min(i+1,a.pts.length-1)];
  return [p0[0]+(p1[0]-p0[0])*f, p0[1]+(p1[1]-p0[1])*f];
}
