// Continuous scalar fields (elevation / temperature / moisture) — PURE
// functions of world coordinates, so they exist everywhere without any
// streaming. This is the foundation of the infinite world: mega-tile
// hydrology, chunk refinement and overview rasters all evaluate these.
//
// The n-first variants take the noise bundle explicitly so the chunk worker
// can call them directly; the tail helpers bind S.noiseFns for main-thread
// callers.

import { makeNoise, fbm } from './noise.js';
import { S, CLIMATE_PERIOD } from './state.js';

export function makeParamNoise(seed){
  return {
    el:  makeNoise(seed,'elev'),  t: makeNoise(seed,'temp'),
    m:   makeNoise(seed,'moist'), w: makeNoise(seed,'warp'),
    det: makeNoise(seed,'detail')
  };
}

// Domain-warped elevation. The finite world multiplied a radial mask to
// guarantee one central continent; infinity replaces it with a second, much
// lower-frequency continent sheet, so landmasses of every size occur
// everywhere. The contrast stretch widens relief around sea level, and a
// superlinear high tail grows real mountain belts. `oct` trims the octave
// count for low-pass sampling (overview rasters sample far below the full
// field's Nyquist rate and must not alias).
export function elevationFN(n, fx, fy, oct=6){
  const wx = fbm(n.w, fx/480, fy/480, 2, 2, .5) - .5;
  const wy = fbm(n.w, fx/480+5.2, fy/480+1.3, 2, 2, .5) - .5;
  const cont  = fbm(n.el, fx/2600+11.7, fy/2600+7.3, 2, 2, .5);
  const hills = fbm(n.el, (fx+wx*320)/680, (fy+wy*320)/680, oct, 2.0, .55);
  let e = hills*0.72 + cont*0.46 - 0.145;
  e = 0.42 + (e-0.42)*1.6;
  if(e > 0.55) e += (e-0.55)*0.9;
  return Math.max(0, Math.min(1, e));
}

// Temperature: latitude bands periodic in fy (endless pan cycles tropical ->
// polar), minus elevation lapse rate, plus noise.
export function tempFN(n, fx, fy, e, sea){
  const lat = 0.5 + 0.5*Math.cos(fy/CLIMATE_PERIOD*Math.PI*2);
  let tt = lat*0.78 + fbm(n.t, fx/960, fy/960, 3, 2, .5)*0.3 - Math.max(0,e-sea)*0.55;
  return Math.max(0, Math.min(1, tt));
}

// `oct` trims octaves for low-pass overview sampling (see elevationFN).
export function moistFN(n, fx, fy, oct=4){
  return fbm(n.m, fx/560, fy/560, oct, 2, .5);
}

// Main-thread bindings (worker uses the *FN forms directly).
export const elevationAt = (fx,fy) => elevationFN(S.noiseFns, fx, fy);
export const tempAt = (fx,fy,e,sea) => tempFN(S.noiseFns, fx, fy, e, sea);
export const moistAt = (fx,fy) => moistFN(S.noiseFns, fx, fy);
