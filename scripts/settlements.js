// Settlement placement on the coarse grid: suitability scoring + Poisson-disk-ish
// greedy placement. Tiers (village/town/city) are assigned later in roads.js once
// road connectivity is known.

import { B } from './biomes.js';
import { S, COARSE_SCALE } from './state.js';

const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

export function placeSettlements(nSettle, sea){
  const { biome, elev } = S.world;
  const GW = S.GW, GH = S.GH, N = GW*GH;
  const settlements = S.world.settlements = [];
  if(nSettle <= 0) return;

  // BFS distance-to-fresh-water (capped at 6 coarse cells)
  const distW = new Int16Array(N).fill(9999);
  const q = [];
  for(let i=0;i<N;i++) if(biome[i]===B.RIVER||biome[i]===B.LAKE){ distW[i]=0; q.push(i); }
  for(let h=0;h<q.length;h++){ const i=q[h]; if(distW[i]>=6) continue;
    const px=i%GW, py=(i/GW)|0;
    for(const [dx,dy] of NB8){ const nx=px+dx, ny=py+dy;
      if(nx<0||ny<0||nx>=GW||ny>=GH) continue; const j=ny*GW+nx;
      if(distW[j]>distW[i]+1){ distW[j]=distW[i]+1; q.push(j); } } }

  // suitability score
  const score = new Float32Array(N).fill(-1);
  for(let y=1;y<GH-1;y++) for(let x=1;x<GW-1;x++){
    const i=y*GW+x, b=biome[i];
    if(elev[i]<sea||b===B.RIVER||b===B.LAKE||b===B.SWAMP||b===B.MOUNTAIN||b===B.SNOW||b===B.BEACH) continue;
    const flat = 1 - Math.min(1,(Math.abs(elev[i]-elev[i+1])+Math.abs(elev[i]-elev[i+GW]))*40);
    const water = Math.max(0, 1 - distW[i]/6);
    const fertile = (b===B.GRASSLAND?1 : b===B.FOREST?0.7 : b===B.RAINFOREST?0.5 : 0.3);
    let coast=0; for(const [dx,dy] of NB8){ if(elev[(y+dy)*GW+(x+dx)]<sea){ coast=0.5; break; } }
    score[i] = flat*0.35 + water*0.35 + fertile*0.25 + coast*0.2;
  }

  // greedy placement with minimum spacing
  const cand = [...Array(N).keys()].filter(i=>score[i]>0.35).sort((a,b)=>score[b]-score[a]);
  const minDist = Math.max(3, Math.round(GW/40));
  for(const i of cand){
    if(settlements.length>=nSettle) break;
    const px=i%GW, py=(i/GW)|0; let ok=true;
    for(const s of settlements){ if(Math.hypot(s.cx-px,s.cy-py)<minDist){ ok=false; break; } }
    if(ok) settlements.push({
      cx:px, cy:py,                                       // coarse coords
      x:(px+0.5)*COARSE_SCALE, y:(py+0.5)*COARSE_SCALE,   // fine world coords
      score:score[i], tier:0, degree:0, buildings:null, streets:null, R:0
    });
  }
}
