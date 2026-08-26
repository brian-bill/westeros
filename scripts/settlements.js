// Settlements on deterministic lattices.
//
// The finite world placed settlements with one global greedy pass; infinity
// needs placement that is independent of load order. Two fixed lattices do
// exactly that, because membership is a pure function of (seed, lattice
// coords, local suitability):
//
//   urban  — pitch UCELL coarse cells (~64 km): each cell may host ONE place,
//            rolled city/town/village by hash shares and gated by site score.
//            The pitch itself guarantees the metric rule (any two urban sites
//            >= ~57 km apart, above the 50 km spec) with no demotion pass.
//   rural  — pitch VCELL coarse cells (~8 km): frequent village candidates,
//            gated harder so only fertile, well-watered sites settle.
//
// The chunk worker evaluates SUITABILITY (needs terrain context); the main
// thread applies GATES + tiers + names and registers the survivors here.

import { xmur3, mulberry32 } from './rng.js';
import { S, COARSE_SCALE } from './state.js';
import { settlementName } from './names.js';

export const UCELL = 96;   // urban lattice pitch, coarse cells (~77 km)
export const VCELL = 13;   // rural lattice pitch, coarse cells (~10 km)

// Built-up footprint radii before neighbor clamping (fine cells), consumed by
// settlementDetail.js via s.maxR.
export const BASE_R = [3.5,6,10].map(r => r*COARSE_SCALE*0.5);

// Min gap between adjacent-cell candidates is 2*JITTER (positions live in
// [m, cell-m]), so: villages >= 8.8 coarse = ~7.0 km; urban sites
// >= 63 coarse = ~50.4 km — the metric separation rules, by construction.
export const JITTER = { u:31.5, v:4.4 };

// Deterministic jittered candidate for a lattice cell: same everywhere, forever.
export function latticeCandidate(seed, kind, lx, ly){
  const rand = mulberry32(xmur3(seed + '::lat:' + kind + ':' + lx + ':' + ly)());
  const cell = kind==='u' ? UCELL : VCELL, m = JITTER[kind];
  return {
    gx: lx*cell + m + rand()*(cell - 2*m),
    gy: ly*cell + m + rand()*(cell - 2*m),
    r0: rand(),   // occupancy roll
    r1: rand()    // tier roll (urban cells)
  };
}

// Gate + register the candidates a freshly streamed tile proposed. Returns
// the new settlement objects (caller wires roads/ports/worker forwarding).
export function registerTileCandidates(tile){
  const p = S.params;
  const dens = Math.max(0, Math.min(1.6, p.density));
  const fresh = [];
  for(const c of tile.cands || []){
    const id = c.k + ':' + c.lx + ':' + c.ly;
    if(S.world.byId.has(id)) continue;          // lattice cells can straddle tiles
    let tier;
    if(c.k === 'u'){
      if(c.score <= 0.40 || c.r0 >= 0.38*dens) continue;
      tier = (c.r1 < 0.14 && c.score > 0.56) ? 2 : c.score > 0.46 ? 1 : 0;
    } else {
      if(c.score <= 0.34 || c.r0 >= 0.62*dens) continue;
      tier = 0;
    }
    const idx = S.world.settlements.length;
    const cx = Math.floor(c.gx), cy = Math.floor(c.gy);   // integer coarse site
    const s = {
      id,
      idx,                                        // stable registry index
      cx, cy,                                     // coarse coords
      x: (cx+0.5)*COARSE_SCALE, y: (cy+0.5)*COARSE_SCALE,   // fine coords
      score: c.score, tier, ptier: tier,
      degree: 0, maxR: Infinity,
      buildings: null, streets: null, R: 0, style: null,
      name: settlementName(p.seed, id),
      port: null
    };
    S.world.byId.set(id, s);
    S.world.settlements.push(s);
    S.world.roadGraph.nodes.push({ idx, cx:s.cx, cy:s.cy, tier:s.tier });
    S.world.roadGraph.adj.set(idx, []);
    S.world.feederGraph.nodes.push({ idx, cx:s.cx, cy:s.cy });
    S.world.feederGraph.adj.set(idx, []);
    fresh.push(s);
  }
  return fresh;
}

// Cap built-up footprints so neighboring settlements never overlap. Runs per
// registration and mutually re-clamps already-known lattice neighbors, whose
// positions are deterministic, so the result converges to the same caps any
// order would produce.
export function recapFootprints(s){
  const MARGIN = 3;
  const touch = new Set([s]);
  const reach = BASE_R[2] * 2 + MARGIN;
  for(const n of settlementsNear(s.cx, s.cy, reach, () => true)){
    if(n === s) continue;
    touch.add(n);
  }
  for(const t of touch){
    let r = t === s ? BASE_R[t.tier] : (t.maxR===Infinity ? BASE_R[t.tier] : t.maxR);
    for(const n of settlementsNear(t.cx, t.cy, reach, () => true)){
      if(n === t) continue;
      const nr = n.maxR===Infinity ? BASE_R[n.tier] : n.maxR;
      r = Math.min(r, Math.hypot(t.x-n.x, t.y-n.y) - nr - MARGIN);
    }
    const was = t.maxR;
    t.maxR = Math.max(0, r);
    if(t.maxR !== was){           // footprint shrank -> drop any built detail
      t.buildings = null; t.streets = null;
    }
  }
}

// Registered settlements within r coarse cells of (cx,cy), nearest first.
// Enumerates lattice cells directly — no spatial index needed.
export function settlementsNear(cx, cy, r, pred){
  const out = [];
  const scan = (cell, kind) => {
    const lx0 = Math.floor((cx-r)/cell), lx1 = Math.floor((cx+r)/cell);
    const ly0 = Math.floor((cy-r)/cell), ly1 = Math.floor((cy+r)/cell);
    for(let ly=ly0; ly<=ly1; ly++) for(let lx=lx0; lx<=lx1; lx++){
      const st = S.world.byId.get(kind + ':' + lx + ':' + ly);
      if(st && (!pred || pred(st)) && Math.hypot(st.cx-cx, st.cy-cy) <= r) out.push(st);
    }
  };
  scan(UCELL,'u'); scan(VCELL,'v');
  out.sort((a,b)=>Math.hypot(a.cx-cx,a.cy-cy)-Math.hypot(b.cx-cx,b.cy-cy));
  return out;
}
