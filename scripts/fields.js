// Continuous scalar fields (elevation / temperature / moisture) evaluable at any
// FINE world coordinate, plus coarse-grid samplers and the fine-biome refiner.

import { makeNoise, fbm } from './noise.js';
import { B, classifyBiome } from './biomes.js';
import { S, COARSE_SCALE } from './state.js';

export function makeParamNoise(seed){
  return {
    el:  makeNoise(seed,'elev'),  t: makeNoise(seed,'temp'),
    m:   makeNoise(seed,'moist'), w: makeNoise(seed,'warp'),
    det: makeNoise(seed,'detail')
  };
}

// Continuous elevation at any FINE world coordinate (used by both tiers).
export function elevationAt(fx, fy){
  const n = S.noiseFns;
  const wx = fbm(n.w, fx/480, fy/480, 2, 2, .5) - .5;
  const wy = fbm(n.w, fx/480+5.2, fy/480+1.3, 2, 2, .5) - .5;
  let e = fbm(n.el, (fx+wx*320)/680, (fy+wy*320)/680, 6, 2.0, .55);
  const WFX = S.GW*COARSE_SCALE, WFY = S.GH*COARSE_SCALE, cx = WFX/2, cy = WFY/2;
  const maxR = Math.min(WFX,WFY)*0.52;
  const d = Math.hypot(fx-cx, fy-cy)/maxR;
  const mask = 1 - Math.pow(Math.min(d,1), 2.2);
  e = e*0.72 + mask*0.42 - 0.14;
  return Math.max(0, Math.min(1, e));
}

export function tempAt(fx, fy, e, sea){
  const WFY = S.GH*COARSE_SCALE;
  const lat = 1 - Math.abs((fy/WFY)-0.5)*2;
  let tt = lat*0.7 + fbm(S.noiseFns.t, fx/960, fy/960, 3, 2, .5)*0.3 - Math.max(0,e-sea)*0.55;
  return Math.max(0, Math.min(1, tt));
}

export function moistAt(fx, fy){
  return fbm(S.noiseFns.m, fx/560, fy/560, 4, 2, .5);
}

// Bilinear sample of a coarse field at fine world coords.
export function sampleCoarse(arr, fx, fy){
  const gx = fx/COARSE_SCALE-0.5, gy = fy/COARSE_SCALE-0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = gx-x0, ty = gy-y0;
  const cl = (v,m) => Math.max(0, Math.min(m-1, v));
  const g = (x,y) => arr[cl(y,S.GH)*S.GW + cl(x,S.GW)];
  return g(x0,y0)*(1-tx)*(1-ty) + g(x0+1,y0)*tx*(1-ty)
       + g(x0,y0+1)*(1-tx)*ty   + g(x0+1,y0+1)*tx*ty;
}

// Nearest coarse biome (for water/road overlay decisions).
export function coarseBiomeAt(fx, fy){
  const gx = Math.round(fx/COARSE_SCALE-0.5), gy = Math.round(fy/COARSE_SCALE-0.5);
  if(gx<0||gy<0||gx>=S.GW||gy>=S.GH) return B.DEEP_OCEAN;
  return S.world.biome[gy*S.GW + gx];
}

// Rasterize coarse rivers/lakes into fine space by proximity to their centers.
export function fineRiverAt(fx, fy){
  const gx = Math.round(fx/COARSE_SCALE-0.5), gy = Math.round(fy/COARSE_SCALE-0.5);
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
    const cx = gx+dx, cy = gy+dy;
    if(cx<0||cy<0||cx>=S.GW||cy>=S.GH) continue;
    const b = S.world.biome[cy*S.GW + cx];
    if(b===B.RIVER || b===B.LAKE){
      const ccx = (cx+0.5)*COARSE_SCALE, ccy = (cy+0.5)*COARSE_SCALE;
      const d = Math.hypot(fx-ccx, fy-ccy);
      const width = b===B.LAKE ? COARSE_SCALE*0.7 : COARSE_SCALE*0.28;
      if(d < width) return b;
    }
  }
  return -1;
}

// Refined biome (+ elevation) at a fine world cell.
export function refineFineBiome(fx, fy){
  const p = S.world.params, sea = p.sea, mtn = p.mtn;
  let e = sampleCoarse(S.world.elev, fx, fy);
  e += (fbm(S.noiseFns.det, fx/22, fy/22, 3, 2, .5) - 0.5)*0.05;
  e = Math.max(0, Math.min(1, e));
  const t = sampleCoarse(S.world.temp, fx, fy);
  const m = sampleCoarse(S.world.moist, fx, fy);
  if(e < sea) return { b:(e < sea-0.06 ? B.DEEP_OCEAN : B.OCEAN), e };
  const riv = fineRiverAt(fx, fy); if(riv >= 0) return { b:riv, e };
  let b = classifyBiome(e, t, m, sea, mtn);
  if(coarseBiomeAt(fx,fy)===B.SWAMP && e < sea+0.10) b = B.SWAMP;
  return { b, e };
}
