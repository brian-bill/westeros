// FINE CHUNKS — generated on demand, rendered to an offscreen bitmap, cached,
// and evicted (LRU). Also bakes farmland into the chunk bitmap (feature h).

import { B, COLOR } from './biomes.js';
import { S, CHUNK, COARSE_SCALE } from './state.js';
import { refineFineBiome } from './fields.js';

const chunkKey = (cx,cy) => cx + ',' + cy;

// Render one chunk to an offscreen bitmap. cx/cy are in chunk units.
function generateChunk(cx, cy){
  const off = document.createElement('canvas'); off.width = CHUNK; off.height = CHUNK;
  const octx = off.getContext('2d');
  const img = octx.createImageData(CHUNK, CHUNK); const d = img.data;
  const baseX = cx*CHUNK, baseY = cy*CHUNK;

  // settlements whose farmland could touch this chunk
  const nearS = S.world.settlements.filter(s =>
    Math.abs(s.x-(baseX+CHUNK/2)) < CHUNK*2+90 &&
    Math.abs(s.y-(baseY+CHUNK/2)) < CHUNK*2+90);

  for(let ly=0;ly<CHUNK;ly++) for(let lx=0;lx<CHUNK;lx++){
    const fx = baseX+lx, fy = baseY+ly;
    let { b, e } = refineFineBiome(fx, fy);

    // farmland: fertile flat land within a settlement radius
    if(b===B.GRASSLAND||b===B.FOREST||b===B.RAINFOREST){
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
    const o = (ly*CHUNK+lx)*4;
    d[o]=Math.min(255,r); d[o+1]=Math.min(255,g); d[o+2]=Math.min(255,bl); d[o+3]=255;
  }
  octx.putImageData(img, 0, 0);
  return { bmp: off };
}

export function getChunk(cx, cy){
  const k = chunkKey(cx,cy); let ch = S.chunks.get(k);
  if(!ch){ ch = generateChunk(cx,cy); ch.lastUsed = performance.now(); S.chunks.set(k, ch); }
  else ch.lastUsed = performance.now();
  return ch;
}

export function evictChunks(max=400){
  if(S.chunks.size <= max) return;
  const arr = [...S.chunks.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
  for(let i=0;i<arr.length-max;i++) S.chunks.delete(arr[i][0]);
}
