// FINE CHUNKS — cached ImageBitmaps rasterized by chunkWorker.js off the
// main thread. A chunk is only sent to the worker once every mega-tile under
// it (plus sampler margin) has streamed in; requests that arrive too early
// park in a wait queue and flush when the next tile lands. An LRU map keeps
// the bitmap cache bounded while the viewport roams the infinite plane.

import { S, CHUNK } from './state.js';
import { postToWorker, setChunkHandler, isAreaReady, initStream,
         setFarmland as streamSetFarmland } from './worldTiles.js';

const chunkKey = (cx,cy) => cx + ',' + cy;

let onReady = null;   // callback invoked when a fresh bitmap arrives (redraw)
export function setChunkReadyCallback(fn){ onReady = fn; }

// Per-tier state: cached bitmaps + keys currently in flight to the worker.
const tiers = [];
function tierState(t){
  let ts = tiers[t];
  if(!ts){ ts = { map:new Map(), pending:new Set(), waiting:new Set() }; tiers[t] = ts; }
  return ts;
}

setChunkHandler((m) => {
  if(m.type === 'chunkFail'){
    const ts = tierState(m.lod||0), k = chunkKey(m.cx,m.cy);
    ts.pending.delete(k);      // tile vanished mid-flight; retry on next view
    return;
  }
  const ts = tierState(m.lod||0), k = chunkKey(m.cx,m.cy);
  ts.pending.delete(k);
  const prev = ts.map.get(k);
  if(prev?.bmp?.close) prev.bmp.close();
  ts.map.set(k, { bmp:m.bitmap, lastUsed:performance.now() });
  if(onReady) onReady();
});

let gen = 0;

// Fresh world: restart the worker pipeline and clear every cache. Call after
// params change (seed/sea/mtn/rivers/density).
export function resetChunks(params){
  gen++;
  initStream(params);
  for(const ts of tiers){
    ts.pending.clear(); ts.waiting.clear();
    for(const ch of ts.map.values()){ ch.bmp?.close?.(); }
    ts.map.clear();
  }
  postToWorker({ type:'farmland', flag:S.layers.farmland });
}

export function setFarmland(flag){
  streamSetFarmland(flag);
  for(const ts of tiers){
    for(const ch of ts.map.values()){ ch.bmp?.close?.(); }
    ts.map.clear();
  }
}

// Return the cached bitmap for a chunk at an LOD tier, or request it (async)
// and return null. render.js draws whatever is cached and skips misses until
// they arrive. Chunks over unstreamed tiles are parked until those land.
export function getChunk(cx, cy, lod=0){
  const ts = tierState(lod), k = chunkKey(cx,cy);
  const ch = ts.map.get(k);
  if(ch){ ch.lastUsed = performance.now(); return ch; }
  if(ts.pending.has(k)) return null;
  const pad = 16;   // must match chunkWorker.chunkTilesReady
  const x0=cx*CHUNK-pad, y0=cy*CHUNK-pad,
        x1=cx*CHUNK+CHUNK+pad, y1=cy*CHUNK+CHUNK+pad;
  if(!isAreaReady(x0,y0,x1,y1)){ ts.waiting.add(k); return null; }
  ts.waiting.delete(k);
  ts.pending.add(k);
  postToWorker({ type:'chunk', gen, cx, cy, lod });
  return null;
}

// Tiles arrived -> some parked chunks may now be buildable.
export function flushWaiting(){
  for(let t=0;t<tiers.length;t++){
    const ts = tiers[t]; if(!ts || !ts.waiting.size) continue;
    for(const k of [...ts.waiting]){
      const [cx,cy] = k.split(',').map(Number);
      getChunk(cx, cy, t);
    }
  }
}

export function cachedChunkCount(){
  return tiers.reduce((n,t)=>n+(t?t.map.size:0), 0);
}

// Cache cap: each 32² bitmap is 4 KB, so 3000 chunks cost ~12 MB.
export function evictChunks(){
  const CAP = 3000;
  const ts = tiers[0];
  if(!ts || ts.map.size <= CAP) return;
  const arr = [...ts.map.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
  for(let i=0;i<arr.length-CAP;i++){
    arr[i][1].bmp?.close?.();
    ts.map.delete(arr[i][0]);
  }
}
