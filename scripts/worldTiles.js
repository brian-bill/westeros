// STREAMING COARSE SKELETON — the backbone of the infinite world.
//
// The old finite world generated one global coarse grid up front; this module
// replaces it with mega-tiles streamed wherever the viewport goes:
//
//   - Each TILE²-coarse mega-tile is rasterized in the worker (fields ->
//     hydrology -> biomes -> settlement candidates) with a HALO context
//     margin, and returns arrays for its OWNED rect only. Every coarse cell
//     in the world has exactly one owner, so all samplers below route through
//     the owner and every consumer (chunk refiner, roads, tooltip) sees the
//     same canonical value no matter which tiles happen to be loaded.
//   - At far zoom, whole OTILE² overview tiles are classified straight from
//     the pure fields (no hydrology) — cheap enough to blanket the screen —
//     and each one also anchors a named region for the labels layer.
//   - This module owns the worker and routes its messages: tiles/overviews
//     are handled here, chunk bitmaps forwarded to chunks.js.

import { S, COARSE_SCALE, TILE, OTILE,
         SCALE_CHUNK_MIN, SCALE_OVERVIEW_MAX } from './state.js';
import { B, COLOR, classifyBiome } from './biomes.js';
import { fbm } from './noise.js';
import { elevationAt, tempAt, moistAt } from './fields.js';
import { regionName } from './names.js';

const tkey = (tx,ty) => tx + ',' + ty;

let worker = null;
let gen = 0;
let params = null;

const tiles = new Map();      // "tx,ty" -> { tx,ty,elev,temp,moist,biome,bmp,state,lastUsed }
const overviews = new Map();  // "ox,oy" -> { bmp, lastUsed }
const pendingOverview = new Set();
let inflightTiles = 0, inflightOverviews = 0;
const MAX_INFLIGHT = 8;

const regionsMap = new Map(); // "ox,oy" -> { name, x, y }  persists once seen
const provCache = new Map();  // provisional placeholder colors

// hooks ---------------------------------------------------------------
let chunkHandler = null;       // chunks.js consumes 'chunk' messages
let tileReadyFn = null;        // settlements registration per fresh tile
let changeFns = [];            // anything that should kick a redraw / retry

export function setChunkHandler(fn){ chunkHandler = fn; }
export function onTileReady(fn){ tileReadyFn = fn; }
export function onChange(fn){ changeFns.push(fn); }
function fireChange(){ for(const fn of changeFns) fn(); }

//------------------------------------------------------------------------------
// Worker plumbing
//------------------------------------------------------------------------------
function ensureWorker(){
  if(worker) return;
  worker = new Worker(new URL('./chunkWorker.js', import.meta.url), { type:'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if(m.gen !== gen){ m.bitmap?.close?.(); return; }   // stale world
    if(m.type === 'chunk'){ chunkHandler?.(m); return; }
    if(m.type === 'tile'){
      inflightTiles--;
      const k = tkey(m.tx,m.ty);
      let t = tiles.get(k);
      if(!t){ t = { tx:m.tx, ty:m.ty, bmp:null, state:'ready', lastUsed:performance.now() };
              tiles.set(k, t); }
      t.elev=m.elev; t.temp=m.temp; t.moist=m.moist; t.biome=m.biome;
      t.state='ready'; t.lastUsed=performance.now();
      t.cands = m.cands;
      tileReadyFn?.(t);          // register settlements etc. before first draw
      fireChange();
      return;
    }
    if(m.type === 'overview'){
      inflightOverviews--;
      pendingOverview.delete(tkey(m.ox,m.oy));
      overviews.set(tkey(m.ox,m.oy), { bmp:m.bitmap, lastUsed:performance.now() });
      if(m.landFrac >= 0.3 && !regionsMap.has(tkey(m.ox,m.oy))){
        regionsMap.set(tkey(m.ox,m.oy), {
          name: regionName(S.params.seed, m.ox+':'+m.oy), x: m.ax, y: m.ay });
        if(regionsMap.size > 400) regionsMap.delete(regionsMap.keys().next().value);
      }
      fireChange();
    }
  };
}

export function postToWorker(msg, transfer){ ensureWorker(); worker.postMessage(msg, transfer); }

// Fresh world: drop everything, restart the pipeline in the worker.
export function initStream(p){
  params = p;
  gen++;
  tiles.clear(); overviews.clear(); provCache.clear();
  regionsMap.clear(); pendingOverview.clear();
  inflightTiles = inflightOverviews = 0;
  ensureWorker();
  worker.postMessage({ type:'init', gen, params });
}

// Farmland is baked into both tile bitmaps and worker chunks.
export function setFarmland(flag){
  for(const t of tiles.values()) t.bmp = null;
  postToWorker({ type:'farmland', flag });
}

//------------------------------------------------------------------------------
// Viewport-driven scheduling
//------------------------------------------------------------------------------
// Called once per animation frame with the visible fine-world rect. Requests
// missing tiles/overviews nearest-first under an in-flight cap, and evicts
// what the viewport has left behind.
export function updateStreaming(wx0, wy0, wx1, wy1){
  if(!params) return;
  const scale = S.view.scale;
  if(scale >= SCALE_OVERVIEW_MAX){
    const pad = scale >= SCALE_CHUNK_MIN ? 544 : 640;   // ring for chunk margins
    scheduleTiles(wx0-pad, wy0-pad, wx1+pad, wy1+pad);
    evictFar([wx0-2048, wy0-2048, wx1+2048, wy1+2048]);
  } else {
    scheduleOverviews(wx0, wy0, wx1, wy1);
    evictOverviews([wx0-OTILE*COARSE_SCALE*1.5, wy0-OTILE*COARSE_SCALE*1.5,
                    wx1+OTILE*COARSE_SCALE*1.5, wy1+OTILE*COARSE_SCALE*1.5]);
  }
}

function scheduleTiles(wx0, wy0, wx1, wy1){
  const t0x = Math.floor(wx0/(TILE*COARSE_SCALE)), t1x = Math.floor(wx1/(TILE*COARSE_SCALE));
  const t0y = Math.floor(wy0/(TILE*COARSE_SCALE)), t1y = Math.floor(wy1/(TILE*COARSE_SCALE));
  const cx = (wx0+wx1)/2, cy = (wy0+wy1)/2, want = [];
  for(let ty=t0y;ty<=t1y;ty++) for(let tx=t0x;tx<=t1x;tx++){
    const k = tkey(tx,ty), t = tiles.get(k);
    if(!t){ want.push({ tx,ty, d:Math.abs((tx+0.5)*TILE*COARSE_SCALE-cx)+Math.abs((ty+0.5)*TILE*COARSE_SCALE-cy) }); }
    else t.lastUsed = performance.now();
  }
  want.sort((a,b)=>a.d-b.d);
  for(const w of want){
    if(inflightTiles >= MAX_INFLIGHT) break;
    tiles.set(tkey(w.tx,w.ty), { tx:w.tx, ty:w.ty, bmp:null, state:'pending', lastUsed:performance.now() });
    inflightTiles++;
    postToWorker({ type:'tile', gen, tx:w.tx, ty:w.ty });
  }
}

function scheduleOverviews(wx0, wy0, wx1, wy1){
  const E = OTILE*COARSE_SCALE;
  const o0x = Math.floor(wx0/E), o1x = Math.floor(wx1/E);
  const o0y = Math.floor(wy0/E), o1y = Math.floor(wy1/E);
  const cx=(wx0+wx1)/2, cy=(wy0+wy1)/2, want=[];
  for(let oy=o0y;oy<=o1y;oy++) for(let ox=o0x;ox<=o1x;ox++){
    const k = tkey(ox,oy);
    const o = overviews.get(k);
    if(!o && !pendingOverview.has(k))
      want.push({ ox,oy, d:Math.abs((ox+0.5)*E-cx)+Math.abs((oy+0.5)*E-cy) });
    else if(o) o.lastUsed = performance.now();
  }
  want.sort((a,b)=>a.d-b.d);
  for(const w of want){
    if(inflightOverviews >= MAX_INFLIGHT) break;
    pendingOverview.add(tkey(w.ox,w.oy));
    inflightOverviews++;
    postToWorker({ type:'overview', gen, ox:w.ox, oy:w.oy });
  }
}

function tileInRange(t, rect){
  const E = TILE*COARSE_SCALE;
  const x0=t.tx*E, y0=t.ty*E;
  return x0>=rect[0] && y0>=rect[1] && x0+E<=rect[2] && y0+E<=rect[3];
}

function evictFar(keepRect){
  for(const [k,t] of tiles){
    if(tileInRange(t, keepRect)) continue;
    if(t.state==='pending'){ continue; }   // let the reply land, then it's evictable
    tiles.delete(k);
    t.bmp?.close?.();
    postToWorker({ type:'forgetTile', key:k });
    fireChange();                          // chunks may reference this tile
  }
}

function evictOverviews(keepRect){
  const E = OTILE*COARSE_SCALE;
  for(const [k,o] of overviews){
    const [ox,oy] = k.split(',').map(Number);
    if(ox*E>=keepRect[0] && oy*E>=keepRect[1] &&
       (ox+1)*E<=keepRect[2] && (oy+1)*E<=keepRect[3]) continue;
    o.bmp.close?.();
    overviews.delete(k);
  }
}

//------------------------------------------------------------------------------
// Canonical samplers — the only way anyone reads coarse data
//------------------------------------------------------------------------------
export function getTile(tx,ty){ return tiles.get(tkey(tx,ty)); }

// Owner tile of a fine point (null when not loaded).
function ownerOfFine(fx,fy){
  return tiles.get(tkey(Math.floor(fx/(TILE*COARSE_SCALE)), Math.floor(fy/(TILE*COARSE_SCALE))));
}
function localIdx(t, gx, gy){
  const lx = gx - t.tx*TILE, ly = gy - t.ty*TILE;
  if(lx<0||ly<0||lx>=TILE||ly>=TILE) return -1;
  return ly*TILE+lx;
}

// Canonical coarse-cell field fetch; undefined when the owner isn't loaded.
function cellField(name, gx, gy){
  const t = tiles.get(tkey(Math.floor(gx/TILE), Math.floor(gy/TILE)));
  if(!t || t.state!=='ready') return undefined;
  const i = localIdx(t, gx, gy);
  return i<0 ? undefined : t[name][i];
}
function cellBiome(gx,gy){
  const t = tiles.get(tkey(Math.floor(gx/TILE), Math.floor(gy/TILE)));
  if(!t || t.state!=='ready') return -1;
  const i = localIdx(t, gx, gy);
  return i<0 ? -1 : t.biome[i];
}

// Bilinear sample of a coarse field at fine coords. Corners are fetched from
// their OWN owners, so samples straddling a tile border blend two tiles'
// canonical values instead of clamping — no plateau seams between tiles.
export function sampleCoarse(name, fx, fy){
  const gx = fx/COARSE_SCALE-0.5, gy = fy/COARSE_SCALE-0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = gx-x0, ty = gy-y0;
  const v00=cellField(name,x0,y0),   v10=cellField(name,x0+1,y0);
  const v01=cellField(name,x0,y0+1), v11=cellField(name,x0+1,y0+1);
  if(v00===undefined||v10===undefined||v01===undefined||v11===undefined) return undefined;
  return v00*(1-tx)*(1-ty) + v10*tx*(1-ty) + v01*(1-tx)*ty + v11*tx*ty;
}

// Nearest canonical biome at a fine point (-1 when unloaded).
export function coarseBiomeAt(fx,fy){
  return cellBiome(Math.round(fx/COARSE_SCALE-0.5), Math.round(fy/COARSE_SCALE-0.5));
}

// Rivers/lakes painted wider than their coarse cells: proximity discs around
// nearby RIVER/LAKE cells, mirroring the worker's rule.
export function fineRiverAt(fx, fy){
  const gx = Math.round(fx/COARSE_SCALE-0.5), gy = Math.round(fy/COARSE_SCALE-0.5);
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
    const b = cellBiome(gx+dx, gy+dy);
    if(b===B.RIVER || b===B.LAKE){
      const ccx=(gx+dx+0.5)*COARSE_SCALE, ccy=(gy+dy+0.5)*COARSE_SCALE;
      const width = b===B.LAKE ? COARSE_SCALE*0.7 : COARSE_SCALE*0.34;
      if(Math.hypot(fx-ccx, fy-ccy) < width) return b;
    }
  }
  return -1;
}

// Pure-fields fallback so tooltips/placeholders work over unstreamed land.
function approxBiome(fx,fy){
  const p=S.params, sea=p.sea, mtn=p.mtn;
  const e=elevationAt(fx,fy), t=tempAt(fx,fy,e,sea), m=moistAt(fx,fy);
  if(e < sea) return e < sea-0.06 ? B.DEEP_OCEAN : B.OCEAN;
  return classifyBiome(e,t,m,sea,mtn);
}

// Refined biome (+ elevation) at a fine world cell. Falls back to the pure
// fields when the owning tile hasn't streamed in yet.
export function refineFineBiome(fx, fy){
  const p=S.params, sea=p.sea, mtn=p.mtn;
  let e = sampleCoarse('elev', fx, fy);
  if(e === undefined) return { b:approxBiome(fx,fy), e:elevationAt(fx,fy) };
  e += (fbm(S.noiseFns.det, fx/22, fy/22, 3, 2, .5) - 0.5)*0.05;
  e = Math.max(0, Math.min(1, e));
  const t = sampleCoarse('temp', fx, fy);
  const m = sampleCoarse('moist', fx, fy);
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

//------------------------------------------------------------------------------
// Placeholders & mid-zoom tile bitmaps
//------------------------------------------------------------------------------
// Instant approximate color for terrain that hasn't streamed yet (pure-field
// classification at the area's center, cached per key).
export function provisionalColor(keyFx, keyFy, key){
  const k = key ?? (keyFx+':'+keyFy);
  let c = provCache.get(k);
  if(c) return c;
  c = COLOR[approxBiome(keyFx, keyFy)] || '#0a0d11';
  if(provCache.size > 20000) provCache.clear();
  provCache.set(k, c);
  return c;
}

// Farmland rings baked into tile bitmaps (same hash rule as the chunk
// worker), so the mid-zoom regime degrades continuously into chunk views.
function bakeFarmColor(biome, gx, gy){
  const fx=(gx+0.5)*COARSE_SCALE, fy=(gy+0.5)*COARSE_SCALE;
  for(const s of S.world.settlements){
    if(s.tier===0 && s.score<0.5) continue;
    const radius = [4,7,11][s.tier]*COARSE_SCALE*0.55;
    if(Math.abs(s.x-fx)>radius || Math.abs(s.y-fy)>radius) continue;
    const dd = Math.hypot(fx-s.x, fy-s.y);
    if(dd>COARSE_SCALE*0.6 && dd<radius){
      const pr = 1 - dd/radius;
      if(((fx*73856093)^(fy*19349663))%100 < pr*80) return B.FARMLAND;
    }
  }
  return biome;
}

// One small canvas per loaded tile for the mid-zoom regime (stretched by
// render.js). Built lazily, freed on eviction.
export function getTileBitmap(tx,ty){
  const t = tiles.get(tkey(tx,ty));
  if(!t || t.state!=='ready') return null;
  if(t.bmp) return t.bmp;
  const w = S.params;
  const cv = document.createElement('canvas');
  cv.width = TILE; cv.height = TILE;
  const c2 = cv.getContext('2d');
  const img = c2.createImageData(TILE, TILE), d = img.data;
  for(let gy=0;gy<TILE;gy++) for(let gx=0;gx<TILE;gx++){
    const i = gy*TILE+gx;
    const b = bakeFarmColor(t.biome[i], t.tx*TILE+gx, t.ty*TILE+gy);
    const col = COLOR[b]||'#000';
    let r=parseInt(col.slice(1,3),16), g=parseInt(col.slice(3,5),16), bl=parseInt(col.slice(5,7),16);
    if(b!==B.OCEAN&&b!==B.DEEP_OCEAN&&b!==B.RIVER&&b!==B.LAKE){
      const sh=0.82+t.elev[i]*0.35; r*=sh; g*=sh; bl*=sh;
    }
    d[i*4]=Math.min(255,r); d[i*4+1]=Math.min(255,g); d[i*4+2]=Math.min(255,bl); d[i*4+3]=255;
  }
  c2.putImageData(img, 0, 0);
  t.bmp = cv;
  return cv;
}

export function getOverviewBitmap(ox,oy){
  const o = overviews.get(tkey(ox,oy));
  if(!o) return null;
  o.lastUsed = performance.now();
  return o.bmp;
}

export function regionsList(){ return regionsMap.values(); }

export function streamStats(){
  let ready=0; for(const t of tiles.values()) if(t.state==='ready') ready++;
  return { tiles:ready, pending:inflightTiles+inflightOverviews,
           overviews:overviews.size, regions:regionsMap.size };
}

// True when every tile overlapping a fine rect (e.g. a chunk plus its sampler
// margin) is ready — the gate before requesting chunk rasterization.
export function isAreaReady(x0,y0,x1,y1){
  const T = TILE*COARSE_SCALE;
  for(let ty=Math.floor(y0/T); ty<=Math.floor(y1/T); ty++)
    for(let tx=Math.floor(x0/T); tx<=Math.floor(x1/T); tx++){
      const t = tiles.get(tkey(tx,ty));
      if(!t || t.state!=='ready') return false;
    }
  return true;
}
