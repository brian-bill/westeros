// FINE CHUNKS (multi-tier LOD) — generated off the main thread by
// chunkWorker.js so the UI never freezes. This module owns the worker, ships
// the coarse skeleton to it once per regenerate, requests visible chunks
// asynchronously, and caches the returned ImageBitmaps (LRU eviction). Each
// LOD tier t keeps its own cache of (CHUNK>>t)² bitmaps; tier 3 doesn't stream
// chunks at all — render.js stretches a single coarse-grid raster instead
// (coarseBitmap.js). Also bakes farmland (feature h) — inside the worker.

import { S, CHUNK, COARSE_SCALE } from './state.js';
import { invalidateCoarseBitmap } from './coarseBitmap.js';

const chunkKey = (cx,cy) => cx + ',' + cy;

let worker = null;
let gen = 0;                 // bumped on every resetChunks(); stamps requests/results
let onReady = null;          // callback invoked when a fresh bitmap arrives (triggers redraw)

// Called by render.js when a bitmap arrives, so it can schedule a redraw.
export function setChunkReadyCallback(fn){ onReady = fn; }

// Per-tier state: cached bitmaps + keys currently in flight to the worker.
const tiers = [];
function tierState(t){
  let ts = tiers[t];
  if(!ts){ ts = { map:new Map(), pending:new Set() }; tiers[t] = ts; }
  return ts;
}

function ensureWorker(){
  if(worker) return worker;
  worker = new Worker(new URL('./chunkWorker.js', import.meta.url), { type:'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if(m.type !== 'chunk') return;
    if(m.gen !== gen){ m.bitmap?.close?.(); return; }  // stale world
    const ts = tierState(m.lod||0), k = chunkKey(m.cx, m.cy);
    ts.pending.delete(k);
    const prev = ts.map.get(k);
    if(prev?.bmp?.close) prev.bmp.close();
    ts.map.set(k, { bmp: m.bitmap, lastUsed: performance.now() });
    if(onReady) onReady();
  };
  return worker;
}

// Ship the freshly-generated coarse skeleton to the worker and invalidate every
// cache. Call after generateCoarse + buildRoads (settlements have tiers by then).
export function resetChunks(){
  ensureWorker();
  gen++;
  invalidateCoarseBitmap();   // tier-3 raster is derived from the old skeleton
  for(const ts of tiers){
    ts.pending.clear();
    for(const ch of ts.map.values()){ ch.bmp?.close?.(); }
    ts.map.clear();
  }

  const w = S.world;
  // Copy typed arrays so the main thread keeps its own (render/tooltip/roads read them).
  const world = {
    params: w.params,
    elev: w.elev.slice(), temp: w.temp.slice(),
    moist: w.moist.slice(), biome: w.biome.slice(),
    settlements: w.settlements.map(s => ({ x:s.x, y:s.y, tier:s.tier, score:s.score })),
    GW: w.GW, GH: w.GH,
  };
  worker.postMessage({ type:'init', gen, seed: w.params.seed, farmland: S.layers.farmland, world });
}

// Return the cached bitmap for a chunk at an LOD tier, or request it (async)
// and return null. render.js draws whatever is cached and skips misses until
// they arrive.
export function getChunk(cx, cy, lod=0){
  const ts = tierState(lod), k = chunkKey(cx,cy);
  const ch = ts.map.get(k);
  if(ch){ ch.lastUsed = performance.now(); return ch; }
  if(worker && !ts.pending.has(k)){
    ts.pending.add(k);
    worker.postMessage({ type:'chunk', gen, cx, cy, lod });
  }
  return null;
}

export function cachedChunkCount(){
  return tiers.reduce((n,t)=>n+(t?t.map.size:0), 0);
}

export function evictChunks(max=400){
  // Each tier-t chunk is a (CHUNK>>t)² ImageBitmap ≈ 4KB/1KB/256B. The cache
  // must hold at least every chunk in the world (worst case 16384 per tier), or
  // eviction thrashes: visible chunks are evicted, re-requested and re-shown as
  // placeholders — seen as flicker. Coarser tiers get proportionally larger
  // count caps so each tier costs roughly the same memory (~64MB worst case).
  const total = Math.ceil(S.GW*COARSE_SCALE/CHUNK) * Math.ceil(S.GH*COARSE_SCALE/CHUNK);
  tiers.forEach((ts,t)=>{
    if(!ts) return;
    const cap = Math.max(max, Math.min(total, 16384) << t);
    if(ts.map.size <= cap) return;
    const arr = [...ts.map.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
    for(let i=0;i<arr.length-cap;i++){
      const ch = arr[i][1];
      ch.bmp?.close?.();
      ts.map.delete(arr[i][0]);
    }
  });
}
