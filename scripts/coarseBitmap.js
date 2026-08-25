// TIER-3 LOD RASTER — the whole world as one GW×GH image read straight off the
// coarse global skeleton. At very far zoom a fine chunk covers only a few
// screen pixels, so streaming thousands of chunks just to throw the resolution
// away is wasteful; instead render.js stretches this single image across the
// world rect and skips chunk streaming entirely. Farmland rings are re-baked
// here with the same hash rule as the chunk worker (the coarse biome array
// doesn't contain them), so zooming out degrades continuously into this image.

import { S, COARSE_SCALE } from './state.js';
import { B, COLOR } from './biomes.js';

let cv = null;

export function invalidateCoarseBitmap(){ cv = null; }

export function getCoarseBitmap(){
  if(cv && cv.width === S.GW) return cv;
  const w = S.world;
  if(!w) return null;
  const GW = w.GW, GH = w.GH;
  const biome = w.biome.slice();

  // farmland rings (mirrors chunkWorker.generateChunkImage)
  if(S.layers.farmland){
    for(const s of w.settlements){
      if(s.tier===0 && s.score<0.5) continue;
      const radius = [4,7,11][s.tier]*COARSE_SCALE*0.55;
      const x0 = Math.max(0, (s.x-radius)/COARSE_SCALE|0), x1 = Math.min(GW-1, (s.x+radius)/COARSE_SCALE|0);
      const y0 = Math.max(0, (s.y-radius)/COARSE_SCALE|0), y1 = Math.min(GH-1, (s.y+radius)/COARSE_SCALE|0);
      for(let gy=y0;gy<=y1;gy++) for(let gx=x0;gx<=x1;gx++){
        const i = gy*GW+gx, b = biome[i];
        if(b!==B.GRASSLAND&&b!==B.FOREST&&b!==B.RAINFOREST) continue;
        const fx=(gx+0.5)*COARSE_SCALE, fy=(gy+0.5)*COARSE_SCALE;
        const dd = Math.hypot(fx-s.x, fy-s.y);
        if(dd>COARSE_SCALE*0.6 && dd<radius){
          const pr = 1 - dd/radius;
          if(((fx*73856093)^(fy*19349663))%100 < pr*80) biome[i] = B.FARMLAND;
        }
      }
    }
  }

  cv = document.createElement('canvas');
  cv.width = GW; cv.height = GH;
  const c2 = cv.getContext('2d'), img = c2.createImageData(GW, GH), d = img.data;
  for(let i=0;i<GW*GH;i++){
    const b = biome[i], col = COLOR[b]||'#000';
    let r=parseInt(col.slice(1,3),16), g=parseInt(col.slice(3,5),16), bl=parseInt(col.slice(5,7),16);
    if(b!==B.OCEAN&&b!==B.DEEP_OCEAN&&b!==B.RIVER&&b!==B.LAKE){ const sh=0.82+w.elev[i]*0.35; r*=sh; g*=sh; bl*=sh; }
    d[i*4]=Math.min(255,r); d[i*4+1]=Math.min(255,g); d[i*4+2]=Math.min(255,bl); d[i*4+3]=255;
  }
  c2.putImageData(img, 0, 0);
  return cv;
}
