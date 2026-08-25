// Hash-based value noise + fractal Brownian motion (fBm).
// The noise is a pure function of world coordinates (no permutation table),
// which is what makes chunk boundaries seamless.

import { xmur3 } from './rng.js';

export function makeNoise(seed, salt){
  const s = xmur3(seed + '::' + salt)();
  const hash = (ix, iy) => {
    let h = Math.imul(ix|0, 374761393) ^ Math.imul(iy|0, 668265263) ^ s;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = t => t*t*t*(t*(t*6-15)+10);
  const lerp = (a,b,t) => a + (b-a)*t;
  return function(x, y){
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = fade(x-x0), fy = fade(y-y0);
    const v00 = hash(x0,y0),   v10 = hash(x0+1,y0);
    const v01 = hash(x0,y0+1), v11 = hash(x0+1,y0+1);
    return lerp(lerp(v00,v10,fx), lerp(v01,v11,fx), fy);
  };
}

export function fbm(noise, x, y, oct, lac, gain){
  let amp=1, freq=1, sum=0, norm=0;
  for(let o=0;o<oct;o++){
    sum += amp * noise(x*freq, y*freq);
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}
