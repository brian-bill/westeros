// CHUNK WORKER — off-main-thread fine-chunk generation.
//
// The main thread posts the coarse skeleton once per regenerate ("init"), then
// requests chunks by (cx,cy). Each request is rasterized to an ImageData, turned
// into an ImageBitmap, and transferred back (zero-copy) so the main thread never
// blocks on per-pixel work. This mirrors chunks.js + fields.js, but reads a local
// world object `W` instead of the shared global `S`, since the worker has no DOM.

import { makeNoise, fbm } from './noise.js';
import { B, COLOR, classifyBiome } from './biomes.js';

// Constants (kept in sync with state.js).
const CHUNK = 32;         // fine cells per chunk edge
const COARSE_SCALE = 8;   // fine cells per coarse cell

// Local world state, populated by the "init" message.
let W = null;    // { params, elev, temp, moist, biome, settlements, GW, GH }
let detNoise = null;  // makeNoise(seed,'detail') closure, rebuilt from the seed
let bakeFarmland = true;  // farmland layer toggle (baked into bitmaps)

//--------------------------------------------------------------------------
// Field samplers (ports of fields.js that read W instead of S)
//--------------------------------------------------------------------------
function sampleCoarse(arr, fx, fy){
  const gx = fx/COARSE_SCALE-0.5, gy = fy/COARSE_SCALE-0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = gx-x0, ty = gy-y0;
  const cl = (v,m) => Math.max(0, Math.min(m-1, v));
  const g = (x,y) => arr[cl(y,W.GH)*W.GW + cl(x,W.GW)];
  return g(x0,y0)*(1-tx)*(1-ty) + g(x0+1,y0)*tx*(1-ty)
       + g(x0,y0+1)*(1-tx)*ty   + g(x0+1,y0+1)*tx*ty;
}

function coarseBiomeAt(fx, fy){
  const gx = Math.round(fx/COARSE_SCALE-0.5), gy = Math.round(fy/COARSE_SCALE-0.5);
  if(gx<0||gy<0||gx>=W.GW||gy>=W.GH) return B.DEEP_OCEAN;
  return W.biome[gy*W.GW + gx];
}

function fineRiverAt(fx, fy){
  const gx = Math.round(fx/COARSE_SCALE-0.5), gy = Math.round(fy/COARSE_SCALE-0.5);
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
    const cx = gx+dx, cy = gy+dy;
    if(cx<0||cy<0||cx>=W.GW||cy>=W.GH) continue;
    const b = W.biome[cy*W.GW + cx];
    if(b===B.RIVER || b===B.LAKE){
      const ccx = (cx+0.5)*COARSE_SCALE, ccy = (cy+0.5)*COARSE_SCALE;
      const d = Math.hypot(fx-ccx, fy-ccy);
      const width = b===B.LAKE ? COARSE_SCALE*0.7 : COARSE_SCALE*0.28;
      if(d < width) return b;
    }
  }
  return -1;
}

function refineFineBiome(fx, fy){
  const p = W.params, sea = p.sea, mtn = p.mtn;
  let e = sampleCoarse(W.elev, fx, fy);
  e += (fbm(detNoise, fx/22, fy/22, 3, 2, .5) - 0.5)*0.05;
  e = Math.max(0, Math.min(1, e));
  const t = sampleCoarse(W.temp, fx, fy);
  const m = sampleCoarse(W.moist, fx, fy);
  if(e < sea){
    // enclosed basins were relabeled LAKE on the coarse grid — keep the fine
    // pass consistent so landlocked water renders as a lake, not an ocean
    if(coarseBiomeAt(fx,fy)===B.LAKE) return { b:B.LAKE, e };
    return { b:(e < sea-0.06 ? B.DEEP_OCEAN : B.OCEAN), e };
  }
  const riv = fineRiverAt(fx, fy); if(riv >= 0) return { b:riv, e };
  let b = classifyBiome(e, t, m, sea, mtn);
  if(coarseBiomeAt(fx,fy)===B.SWAMP && e < sea+0.10) b = B.SWAMP;
  return { b, e };
}

//--------------------------------------------------------------------------
// Chunk rasterization (port of chunks.js generateChunk, returns ImageData)
// `lod` strides the sampling: tier t evaluates every (1<<t)-th fine cell and
// returns a (CHUNK>>t)² image that the main thread stretches back to chunk
// size — 4×/16× cheaper to build for far-zoom views where texels are big.
// Sampled cells keep their exact tier-0 values, so tiers blend seamlessly.
//--------------------------------------------------------------------------
function generateChunkImage(cx, cy, lod = 0){
  const stride = 1<<lod, n = CHUNK>>lod;
  const img = new ImageData(n, n); const d = img.data;
  const baseX = cx*CHUNK, baseY = cy*CHUNK;

  const nearS = W.settlements.filter(s =>
    Math.abs(s.x-(baseX+CHUNK/2)) < CHUNK*2+90 &&
    Math.abs(s.y-(baseY+CHUNK/2)) < CHUNK*2+90);

  for(let ly=0;ly<n;ly++) for(let lx=0;lx<n;lx++){
    const fx = baseX+(lx<<lod), fy = baseY+(ly<<lod);
    let { b, e } = refineFineBiome(fx, fy);

    if(bakeFarmland && (b===B.GRASSLAND||b===B.FOREST||b===B.RAINFOREST)){
      for(const s of nearS){
        if(s.tier===0 && s.score<0.5) continue;
        const radius = [4,7,11][s.tier]*COARSE_SCALE*0.55;
        const dd = Math.hypot(fx-s.x, fy-s.y);
        if(dd>COARSE_SCALE*0.6 && dd<radius){
          const pr = 1 - dd/radius;
          if(((fx*73856093)^(fy*19349663))%100 < pr*80){ b=B.FARMLAND; break; }
        }
      }
    }

    let col = COLOR[b]||'#000';
    let r=parseInt(col.slice(1,3),16), g=parseInt(col.slice(3,5),16), bl=parseInt(col.slice(5,7),16);
    if(b!==B.OCEAN&&b!==B.DEEP_OCEAN&&b!==B.RIVER&&b!==B.LAKE){ const sh=0.82+e*0.35; r*=sh; g*=sh; bl*=sh; }
    const o = (ly*n+lx)*4;
    d[o]=Math.min(255,r); d[o+1]=Math.min(255,g); d[o+2]=Math.min(255,bl); d[o+3]=255;
  }
  return img;
}

//--------------------------------------------------------------------------
// Message protocol
//   { type:'init', gen, world:{ params, elev, temp, moist, biome, settlements, GW, GH } }
//   { type:'chunk', gen, cx, cy, lod }          (lod: 0 full, 1 half, 2 quarter)
// Responses:
//   { type:'chunk', gen, cx, cy, lod, bitmap }  (bitmap transferred)
//--------------------------------------------------------------------------
let gen = 0;   // generation counter; stale requests (older gen) are ignored

self.onmessage = async (ev) => {
  const msg = ev.data;
  if(msg.type === 'init'){
    W = msg.world;
    detNoise = makeNoise(msg.seed, 'detail');
    bakeFarmland = msg.farmland;
    gen = msg.gen;
    return;
  }
  if(msg.type === 'chunk'){
    if(!W || msg.gen !== gen) return;   // stale request from a previous world
    const img = generateChunkImage(msg.cx, msg.cy, msg.lod||0);
    const bitmap = await createImageBitmap(img);
    self.postMessage({ type:'chunk', gen: msg.gen, cx: msg.cx, cy: msg.cy, lod: msg.lod||0, bitmap }, [bitmap]);
  }
};

