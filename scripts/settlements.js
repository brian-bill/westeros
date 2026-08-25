// Settlement placement on the coarse grid: suitability scoring + Poisson-disk-ish
// greedy placement. Tiers (village/town/city) are assigned later in roads.js once
// road connectivity is known; placement predicts a tier from score rank so that
// separation can be enforced per tier in METRIC units (see M_PER_FINE).

import { B } from './biomes.js';
import { S, COARSE_SCALE, fineToKm, kmToFine } from './state.js';
const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

// Minimum pairwise separation in km (metric via M_PER_FINE): any two URBAN
// places (town/city) keep >= 50 km apart; rural villages may cluster much
// closer (7 km), including around towns, as real settlements do.
export const MIN_SEP_KM = { rural:7, urban:50 };

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

  // greedy placement with tier-aware minimum spacing (in km). The k-th best
  // SITE is predicted to become city/town/village with the same Zipf shares
  // roads.js later uses. Two predicted-urban sites need MIN_SEP_KM.urban (50
  // km); everything else just keeps rural elbow room (7 km). Prediction
  // follows candidate rank, so rejected sites can't stall lower tiers.
  const cand = [...Array(N).keys()].filter(i=>score[i]>0.35).sort((a,b)=>score[b]-score[a]);
  const worldKm = fineToKm(GW*COARSE_SCALE);
  const clampKm = km => Math.min(km, worldKm*0.45);   // tiny worlds: scale down
  const sepRural = kmToFine(clampKm(MIN_SEP_KM.rural));
  const sepUrban = kmToFine(clampKm(MIN_SEP_KM.urban));
  const nCity = Math.max(1, Math.round(nSettle*0.10));
  const nTown = Math.round(nSettle*0.25);
  let rank = -1;
  for(const i of cand){
    if(settlements.length>=nSettle) break;
    rank++;
    const px=i%GW, py=(i/GW)|0;
    const fx=(px+0.5)*COARSE_SCALE, fy=(py+0.5)*COARSE_SCALE;   // fine coords
    const predTier = rank<nCity ? 2 : rank<nCity+nTown ? 1 : 0;
    let ok=true;
    for(const s of settlements){
      const need = (predTier>=1 && s.ptier>=1) ? sepUrban : sepRural;
      if(Math.hypot(s.x-fx, s.y-fy) < need){ ok=false; break; }   // fine-space dist
    }
    if(ok) settlements.push({
      cx:px, cy:py,                                       // coarse coords
      x:(px+0.5)*COARSE_SCALE, y:(py+0.5)*COARSE_SCALE,   // fine world coords
      score:score[i], tier:0, degree:0, buildings:null, streets:null, R:0,
      ptier:predTier,                                     // predicted tier at placement
    });
  }
}
