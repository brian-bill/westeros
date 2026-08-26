// CHUNK WORKER — off-main-thread generation for the infinite world.
//
// The main thread streams requests; this worker owns the heavy passes:
//   tile     — build one mega-tile's skeleton: pure fields on a (TILE+2·HALO)²
//              context grid, raw-elevation D8 flow, truncated accumulation +
//              downstream propagation for rivers, depression-fill lakes,
//              swamps, biomes — then ship only the OWNED TILE² rect plus
//              settlement-lattice suitability scores for its candidates.
//   chunk    — refine a fine chunk from whatever tiles are loaded (canonical
//              owner-routed sampling, mirrored from worldTiles.js).
//   overview — cheap pure-field classification of a whole OTILE² area for the
//              far-zoom regime, plus a region-name anchor.
//
// Local state lives in W/tiles; nothing here touches the DOM except the
// ImageBitmap transfers back.

import { makeParamNoise, elevationFN, tempFN, moistFN } from './fields.js';
import { B, COLOR, classifyBiome } from './biomes.js';
import { fbm } from './noise.js';
import { computeFlowRaw, truncatedAccum, riverMask, lakeMask } from './hydrology.js';
import { latticeCandidate, UCELL, VCELL, JITTER } from './settlements.js';

// Constants (kept in sync with state.js).
const CHUNK = 32;         // fine cells per chunk edge
const COARSE_SCALE = 8;   // fine cells per coarse cell
const TILE = 64;
const HALO = 32;
const OTILE = 512;
const OSAMP = 128;

const NB4OV = [[1,0],[-1,0],[0,1],[0,-1]];
const NB4 = NB4OV;
const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

let W = null;        // { params }
let N = null;        // noise bundle
let detNoise = null; // detail-octave noise for fine refinement
let bakeFarmland = true;
let gen_ = 0;        // world generation stamp
let tiles = new Map();       // "tx,ty" -> owned-rect arrays
let setts = [];              // minimal settlement records for farmland baking

//------------------------------------------------------------------------------
// Tile skeleton generation
//------------------------------------------------------------------------------
function buildTile(tx, ty){
  const p = W.params, sea = p.sea, mtn = p.mtn;
  const gw = TILE + 2*HALO, gh = gw, N_ = gw*gh;
  const ox = tx*TILE - HALO, oy = ty*TILE - HALO;

  // pure fields over the context grid
  const elev = new Float32Array(N_), temp = new Float32Array(N_), moist = new Float32Array(N_);
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
    const i=y*gw+x, fx=(ox+x+0.5)*COARSE_SCALE, fy=(oy+y+0.5)*COARSE_SCALE;
    const e = elevationFN(N, fx, fy); elev[i]=e;
    temp[i] = tempFN(N, fx, fy, e, sea); moist[i] = moistFN(N, fx, fy);
  }

  // hydrology — local rules only, see hydrology.js
  const flowTo = computeFlowRaw(elev, gw, gh, sea);
  const accum = truncatedAccum(flowTo, gw, gh, sea, HALO);
  const lake = lakeMask(elev, flowTo, gw, gh, sea, HALO);

  // Major rivers on a stride-4 sheet: at quarter resolution the same halo
  // radius spans 4x the world context, so accumulation recovers the scale
  // separation between big trunk valleys and minor gullies that a fine-grid
  // truncation loses. The sheet is aligned to absolute world coordinates, so
  // every tile samples identical values near shared borders.
  const RIVER_STRIDE = 4;
  const RH = 28;                                  // halo, low-res cells
  const OWN_L = TILE / RIVER_STRIDE;              // owned rect, low-res cells
  const LS = OWN_L + 2*RH;
  const lox = tx*TILE - RH*RIVER_STRIDE, loy = ty*TILE - RH*RIVER_STRIDE;
  const eLo = new Float32Array(LS*LS);
  for(let y=0;y<LS;y++) for(let x=0;x<LS;x++){
    const fx=(lox + x*RIVER_STRIDE + 2)*COARSE_SCALE, fy=(loy + y*RIVER_STRIDE + 2)*COARSE_SCALE;
    eLo[y*LS+x] = elevationFN(N, fx, fy);
  }
  const flowLo = computeFlowRaw(eLo, LS, LS, sea);
  const accumLo = truncatedAccum(flowLo, LS, LS, sea, RH);
  const riverLo0 = riverMask(accumLo, LS, LS, Math.max(6, Math.min(120, p.riverThresh*0.5)));
  // drop lone segments: a river cell must have a river 4-neighbour, so
  // orphan blobs don't dot the plains
  const riverLo = new Uint8Array(LS*LS);
  for(let y=0;y<LS;y++) for(let x=0;x<LS;x++){
    const i=y*LS+x;
    if(!riverLo0[i]) continue;
    const n = (x>0&&riverLo0[i-1]) || (x<LS-1&&riverLo0[i+1]) ||
              (y>0&&riverLo0[i-LS]) || (y<LS-1&&riverLo0[i+LS]);
    if(n) riverLo[i]=1;
  }

  // paint major rivers into the context biome grid: a coarse cell is river
  // iff the stride-4 sheet cell containing it is river — crisp 4-cell-wide
  // lines that the fine sampler rounds with its usual disc test
  const river = new Uint8Array(N_);
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
    const nx=Math.floor((ox+x-lox)/RIVER_STRIDE), ny=Math.floor((oy+y-loy)/RIVER_STRIDE);
    river[y*gw+x] = (nx>=0&&ny>=0&&nx<LS&&ny<LS) ? riverLo[ny*LS+nx] : 0;
  }
  const riverThresh = Math.max(6, Math.min(120, p.riverThresh*0.30));

  // baseline biomes
  const biome = new Int8Array(N_), isWater = new Uint8Array(N_);
  for(let i=0;i<N_;i++) biome[i] = classifyBiome(elev[i], temp[i], moist[i], sea, mtn);

  // open waters vs inland lakes: below-sea cells flood-filled from the grid
  // border are open ocean; enclosed basins become lakes.
  const openWater = new Uint8Array(N_), stack = [];
  const pushOpen = i => {
    if((biome[i]===B.OCEAN||biome[i]===B.DEEP_OCEAN) && !openWater[i]){ openWater[i]=1; stack.push(i); }
  };
  for(let x=0;x<gw;x++){ pushOpen(x); pushOpen((gh-1)*gw+x); }
  for(let y=0;y<gh;y++){ pushOpen(y*gw); pushOpen(y*gw+gw-1); }
  while(stack.length){
    const i=stack.pop(), px=i%gw, py=(i/gw)|0;
    for(const [dx,dy] of NB4){
      const nx=px+dx, ny=py+dy;
      if(nx<0||ny<0||nx>=gw||ny>=gh) continue;
      const j=ny*gw+nx;
      if(!openWater[j]) pushOpen(j);
    }
  }
  for(let i=0;i<N_;i++)
    if(!openWater[i] && (biome[i]===B.OCEAN||biome[i]===B.DEEP_OCEAN)) biome[i]=B.LAKE;

  // rivers + pooled-basin lakes
  for(let i=0;i<N_;i++){
    if(elev[i]<sea){ isWater[i]=1; continue; }
    if(river[i]){ biome[i]=B.RIVER; isWater[i]=1; }
    else if(lake[i]){ biome[i]=B.LAKE; isWater[i]=1; }
  }

  // swamps: low, flat, wet, near water, not already a river
  for(let y=1;y<gh-1;y++) for(let x=1;x<gw-1;x++){
    const i=y*gw+x;
    if(isWater[i]||elev[i]<sea||elev[i]>sea+0.10) continue;
    const sl = Math.abs(elev[i]-elev[i+1]) + Math.abs(elev[i]-elev[i+gw]);
    let near=false; for(const [dx,dy] of NB8){ if(isWater[(y+dy)*gw+(x+dx)]){ near=true; break; } }
    if(sl<0.006 && moist[i]>0.5 && near && accum[i]<riverThresh) biome[i]=B.SWAMP;
  }

  // extract the owned rect
  const T2 = TILE*TILE;
  const oElev=new Float32Array(T2), oTemp=new Float32Array(T2),
        oMoist=new Float32Array(T2), oBiome=new Int8Array(T2);
  for(let y=0;y<TILE;y++) for(let x=0;x<TILE;x++){
    const gi=(y+HALO)*gw+(x+HALO), oi=y*TILE+x;
    oElev[oi]=elev[gi]; oTemp[oi]=temp[gi]; oMoist[oi]=moist[gi]; oBiome[oi]=biome[gi];
  }

  return { oElev, oTemp, oMoist, oBiome, ctx:{ elev, temp, moist, biome, isWater, accum, riverThresh, gw, ox, oy } };
}

// Settlement-lattice suitability over this tile's context grid. Only sites
// landing in the OWNED rect are proposed; each lattice cell therefore belongs
// to exactly one tile (byId dedupe guards the straddling corner cases).
function tileCandidates(tx, ty, ctx){
  const p = W.params, sea = p.sea;
  const { elev, biome, gw, ox, oy } = ctx;
  const gh = gw, N_ = gw*gh;
  const x0 = tx*TILE, x1 = x0+TILE, y0 = ty*TILE, y1 = y0+TILE;

  // BFS distance-to-fresh-water (capped at 6 coarse cells)
  const distW = new Int16Array(N_).fill(9999);
  const q = [];
  for(let i=0;i<N_;i++) if(biome[i]===B.RIVER||biome[i]===B.LAKE){ distW[i]=0; q.push(i); }
  for(let h=0;h<q.length;h++){ const i=q[h]; if(distW[i]>=6) continue;
    const px=i%gw, py=(i/gw)|0;
    for(const [dx,dy] of NB8){ const nx=px+dx, ny=py+dy;
      if(nx<0||ny<0||nx>=gw||ny>=gh) continue; const j=ny*gw+nx;
      if(distW[j]>distW[i]+1){ distW[j]=distW[i]+1; q.push(j); } } }

  const scoreAt = (gx,gy) => {
    const ix=gx-ox, iy=gy-oy, i=iy*gw+ix, b=biome[i];
    if(elev[i]<sea||b===B.RIVER||b===B.LAKE||b===B.SWAMP||b===B.MOUNTAIN||b===B.SNOW||b===B.BEACH) return -1;
    const flat = 1 - Math.min(1,(Math.abs(elev[i]-elev[i+1])+Math.abs(elev[i]-elev[i+gw]))*40);
    const water = Math.max(0, 1 - distW[i]/6);
    const fertile = (b===B.GRASSLAND?1 : b===B.FOREST?0.7 : b===B.RAINFOREST?0.5 : 0.3);
    let coast=0; for(const [dx,dy] of NB8){ if(elev[(iy+dy)*gw+(ix+dx)]<sea){ coast=0.5; break; } }
    return flat*0.35 + water*0.35 + fertile*0.25 + coast*0.2;
  };

  const cands = [];
  for(const [cell,kind] of [[UCELL,'u'],[VCELL,'v']]){
    const m = JITTER[kind];
    const lx0=Math.floor((x0+m)/cell), lx1=Math.floor((x1-1-m)/cell);
    const ly0=Math.floor((y0+m)/cell), ly1=Math.floor((y1-1-m)/cell);
    for(let ly=ly0;ly<=ly1;ly++) for(let lx=lx0;lx<=lx1;lx++){
      const c = latticeCandidate(p.seed, kind, lx, ly);
      const gx = Math.floor(c.gx), gy = Math.floor(c.gy);
      if(gx<x0||gy<y0||gx>=x1||gy>=y1) continue;   // point-in-owned-rect claim
      cands.push({ k:kind, lx, ly, gx:c.gx, gy:c.gy, r0:c.r0, r1:c.r1,
                   score: scoreAt(gx,gy) });
    }
  }
  return cands;
}

//------------------------------------------------------------------------------
// Canonical samplers over loaded tiles (mirror of worldTiles.js)
//------------------------------------------------------------------------------
function wCellField(name, gx, gy){
  const t = tiles.get(Math.floor(gx/TILE)+','+Math.floor(gy/TILE));
  if(!t) return undefined;
  const lx=gx-t.tx*TILE, ly=gy-t.ty*TILE;
  if(lx<0||ly<0||lx>=TILE||ly>=TILE) return undefined;
  return t[name][ly*TILE+lx];
}
function wCellBiome(gx,gy){
  const t = tiles.get(Math.floor(gx/TILE)+','+Math.floor(gy/TILE));
  if(!t) return -1;
  const lx=gx-t.tx*TILE, ly=gy-t.ty*TILE;
  if(lx<0||ly<0||lx>=TILE||ly>=TILE) return -1;
  return t.biome[ly*TILE+lx];
}
function wSample(name, fx, fy){
  const gx=fx/COARSE_SCALE-0.5, gy=fy/COARSE_SCALE-0.5;
  const x0=Math.floor(gx), y0=Math.floor(gy), tx=gx-x0, ty=gy-y0;
  const v00=wCellField(name,x0,y0), v10=wCellField(name,x0+1,y0);
  const v01=wCellField(name,x0,y0+1), v11=wCellField(name,x0+1,y0+1);
  if(v00===undefined||v10===undefined||v01===undefined||v11===undefined) return undefined;
  return v00*(1-tx)*(1-ty) + v10*tx*(1-ty) + v01*(1-tx)*ty + v11*tx*ty;
}
function wRiverAt(fx, fy){
  const gx=Math.round(fx/COARSE_SCALE-0.5), gy=Math.round(fy/COARSE_SCALE-0.5);
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
    const b=wCellBiome(gx+dx, gy+dy);
    if(b===B.RIVER || b===B.LAKE){
      const ccx=(gx+dx+0.5)*COARSE_SCALE, ccy=(gy+dy+0.5)*COARSE_SCALE;
      const width = b===B.LAKE ? COARSE_SCALE*0.7 : COARSE_SCALE*0.34;
      if(Math.hypot(fx-ccx, fy-ccy) < width) return b;
    }
  }
  return -1;
}
function refineFineBiome(fx, fy){
  const p=W.params, sea=p.sea, mtn=p.mtn;
  let e = wSample('elev', fx, fy);
  if(e === undefined) return { b:B.DEEP_OCEAN, e:0 };
  e += (fbm(detNoise, fx/22, fy/22, 3, 2, .5) - 0.5)*0.05;
  e = Math.max(0, Math.min(1, e));
  const t = wSample('temp', fx, fy), m = wSample('moist', fx, fy);
  if(t===undefined||m===undefined) return { b:B.OCEAN, e };
  if(e < sea){
    if(wCellBiome(Math.round(fx/COARSE_SCALE-0.5),Math.round(fy/COARSE_SCALE-0.5))===B.LAKE)
      return { b:B.LAKE, e };
    return { b:(e < sea-0.06 ? B.DEEP_OCEAN : B.OCEAN), e };
  }
  const riv = wRiverAt(fx, fy); if(riv >= 0) return { b:riv, e };
  let b = classifyBiome(e, t, m, sea, mtn);
  if(wCellBiome(Math.round(fx/COARSE_SCALE-0.5),Math.round(fy/COARSE_SCALE-0.5))===B.SWAMP && e < sea+0.10)
    b = B.SWAMP;
  return { b, e };
}

//------------------------------------------------------------------------------
// Chunk rasterization
//------------------------------------------------------------------------------
function generateChunkImage(cx, cy, lod = 0){
  const stride = 1<<lod, n = CHUNK>>lod;
  const img = new ImageData(n, n); const d = img.data;
  const baseX = cx*CHUNK, baseY = cy*CHUNK;

  const nearS = setts.filter(s =>
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

function chunkTilesReady(cx, cy){
  const pad = 16;   // sampler margin around the chunk, fine cells
  const T = TILE*COARSE_SCALE;
  const x0=cx*CHUNK-pad, y0=cy*CHUNK-pad, x1=cx*CHUNK+CHUNK+pad, y1=cy*CHUNK+CHUNK+pad;
  for(let ty=Math.floor(y0/T); ty<=Math.floor(y1/T); ty++)
    for(let tx=Math.floor(x0/T); tx<=Math.floor(x1/T); tx++)
      if(!tiles.has(tx+','+ty)) return false;
  return true;
}

//------------------------------------------------------------------------------
// Overview rasterization (far-zoom regime; pure fields, no hydrology)
//------------------------------------------------------------------------------
function generateOverview(ox, oy){
  const p = W.params, sea = p.sea, mtn = p.mtn;
  const stride = OTILE*COARSE_SCALE/OSAMP;    // fine cells per sample
  const img = new ImageData(OSAMP, OSAMP), d = img.data;
  const land = new Uint8Array(OSAMP*OSAMP);

  // sample fields first: elevation at LOW PASS (2 octaves stay above the
  // stride-32 Nyquist rate; the full 6-octave field aliases into static),
  // lightly smoothed; temp/moist are already low-frequency. The mix leans on
  // the continent sheet so planetary views read as landmasses in an ocean
  // rather than a 50/50 mosaic — coastlines shift slightly vs the fine
  // regimes, which is the same accepted LOD pop the old world had.
  const eS = new Float32Array(OSAMP*OSAMP), tS = new Float32Array(OSAMP*OSAMP),
        mS = new Float32Array(OSAMP*OSAMP);
  for(let sy=0;sy<OSAMP;sy++) for(let sx=0;sx<OSAMP;sx++){
    const fx = ox*OTILE*COARSE_SCALE + (sx+0.5)*stride;
    const fy = oy*OTILE*COARSE_SCALE + (sy+0.5)*stride;
    const wx = fbm(N.w, fx/480, fy/480, 2, 2, .5) - .5;
    const wy = fbm(N.w, fx/480+5.2, fy/480+1.3, 2, 2, .5) - .5;
    const cont = N.el(fx/3400+11.7, fy/3400+7.3);   // single octave: broad masses
    const hills = fbm(N.el, (fx+wx*320)/680, (fy+wy*320)/680, 2, 2.0, .55);
    let e = 0.42 + ((hills*0.42 + cont*0.72 - 0.17) - 0.42)*1.8;
    if(e > 0.55) e += (e-0.55)*0.9;
    eS[sy*OSAMP+sx] = Math.max(0, Math.min(1, e));
  }
  const RB = 3;
  for(let sy=0;sy<OSAMP;sy++) for(let sx=0;sx<OSAMP;sx++){
    let sum=0, n=0;
    for(let dy=-RB;dy<=RB;dy++) for(let dx=-RB;dx<=RB;dx++){
      const nx=sx+dx, ny=sy+dy;
      if(nx<0||ny<0||nx>=OSAMP||ny>=OSAMP) continue;
      sum += eS[ny*OSAMP+nx]; n++;
    }
    eS[sy*OSAMP+sx] = sum/n;
  }
  for(let sy=0;sy<OSAMP;sy++) for(let sx=0;sx<OSAMP;sx++){
    const fx = ox*OTILE*COARSE_SCALE + (sx+0.5)*stride;
    const fy = oy*OTILE*COARSE_SCALE + (sy+0.5)*stride;
    const e = eS[sy*OSAMP+sx];
    tS[sy*OSAMP+sx] = tempFN(N, fx, fy, e, sea);
    mS[sy*OSAMP+sx] = moistFN(N, fx, fy, 2);
  }

  for(let sy=0;sy<OSAMP;sy++) for(let sx=0;sx<OSAMP;sx++){
    const i=sy*OSAMP+sx;
    const e = eS[i], t = tS[i], m = mS[i];
    const b = e<sea ? (e<sea-0.06?B.DEEP_OCEAN:B.OCEAN) : classifyBiome(e,t,m,sea,mtn);
    land[i] = e>=sea ? 1 : 0;
    const col = COLOR[b]||'#000';
    let r=parseInt(col.slice(1,3),16), g=parseInt(col.slice(3,5),16), bl=parseInt(col.slice(5,7),16);
    if(b!==B.OCEAN&&b!==B.DEEP_OCEAN&&b!==B.RIVER&&b!==B.LAKE){ const sh=0.82+e*0.35; r*=sh; g*=sh; bl*=sh; }
    const o=i*4;
    d[o]=Math.min(255,r); d[o+1]=Math.min(255,g); d[o+2]=Math.min(255,bl); d[o+3]=255;
  }

  // region anchor: most interior sample of the largest landmass
  let bestComp=-1, bestSize=0;
  const comp = new Int32Array(OSAMP*OSAMP).fill(-1);
  for(let i=0;i<OSAMP*OSAMP;i++){
    if(!land[i]||comp[i]>=0) continue;
    const id=i, stk=[i]; comp[i]=id; let size=0;
    while(stk.length){
      const c=stk.pop(); size++;
      const cx=c%OSAMP, cy=(c/OSAMP)|0;
      for(const [dx,dy] of NB4OV){
        const nx=cx+dx, ny=cy+dy;
        if(nx<0||ny<0||nx>=OSAMP||ny>=OSAMP) continue;
        const j=ny*OSAMP+nx;
        if(land[j]&&comp[j]<0){ comp[j]=id; stk.push(j); }
      }
    }
    if(size>bestSize){ bestSize=size; bestComp=id; }
  }
  let ax=null, ay=null;
  if(bestComp>=0){
    // BFS graph-distance from water within the whole grid; the anchor is the
    // deepest land sample of the winning component
    const dist = new Int16Array(OSAMP*OSAMP).fill(-1), bq=[];
    for(let i=0;i<OSAMP*OSAMP;i++) if(!land[i]){ dist[i]=0; bq.push(i); }
    for(let h=0;h<bq.length;h++){
      const i=bq[h], cx=i%OSAMP, cy=(i/OSAMP)|0;
      for(const [dx,dy] of NB4OV){
        const nx=cx+dx, ny=cy+dy;
        if(nx<0||ny<0||nx>=OSAMP||ny>=OSAMP) continue;
        const j=ny*OSAMP+nx;
        if(dist[j]<0){ dist[j]=dist[i]+1; bq.push(j); }
      }
    }
    let bd=-1;
    for(let i=0;i<OSAMP*OSAMP;i++)
      if(comp[i]===bestComp && dist[i]>bd){ bd=dist[i]; ax=i%OSAMP; ay=(i/OSAMP)|0; }
  }
  const anchor = ax===null ? null : {
    ax: ox*OTILE*COARSE_SCALE + (ax+0.5)*stride,
    ay: oy*OTILE*COARSE_SCALE + (ay+0.5)*stride,
    landFrac: bestSize/(OSAMP*OSAMP)
  };
  return { img, anchor };
}

//------------------------------------------------------------------------------
// Message protocol
//   init      { gen, params }
//   tile      { gen, tx, ty }                    -> tile { gen, tx, ty, arrays, cands }
//   chunk     { gen, cx, cy, lod }               -> chunk {..., bitmap} | chunkFail
//   overview  { gen, ox, oy }                    -> overview {..., bitmap, anchor}
//   setts     { list }        minimal settlement records (farmland baking)
//   forgetTile{ key }         drop an evicted tile's arrays
//   farmland  { flag }
//------------------------------------------------------------------------------
self.onmessage = async (ev) => {
  const msg = ev.data;
  if(msg.type === 'init'){
    W = { params: msg.params };
    N = makeParamNoise(msg.params.seed);
    detNoise = N.det;
    gen_ = msg.gen;
    tiles = new Map(); setts = [];
    return;
  }
  // world-stamped requests: drop anything from a previous world. Control
  // messages (setts/farmland/forgetTile) carry no stamp and always apply.
  if(!W) return;
  if(msg.gen !== undefined && msg.gen !== gen_ &&
     (msg.type==='tile' || msg.type==='chunk' || msg.type==='overview')) return;

  switch(msg.type){
    case 'tile': {
      const { oElev, oTemp, oMoist, oBiome, ctx } = buildTile(msg.tx, msg.ty);
      const cands = tileCandidates(msg.tx, msg.ty, ctx);
      // keep our own copies for chunk refinement; the clone crosses to main
      tiles.set(msg.tx+','+msg.ty, { tx:msg.tx, ty:msg.ty,
        elev:oElev, temp:oTemp, moist:oMoist, biome:oBiome });
      self.postMessage({ type:'tile', gen:msg.gen, tx:msg.tx, ty:msg.ty,
        elev:oElev, temp:oTemp, moist:oMoist, biome:oBiome, cands });
      return;
    }
    case 'chunk': {
      if(!chunkTilesReady(msg.cx, msg.cy)){
        self.postMessage({ type:'chunkFail', gen:msg.gen, cx:msg.cx, cy:msg.cy, lod:msg.lod||0 });
        return;
      }
      const img = generateChunkImage(msg.cx, msg.cy, msg.lod||0);
      const bitmap = await createImageBitmap(img);
      self.postMessage({ type:'chunk', gen:msg.gen, cx:msg.cx, cy:msg.cy, lod:msg.lod||0, bitmap }, [bitmap]);
      return;
    }
    case 'overview': {
      const { img, anchor } = generateOverview(msg.ox, msg.oy);
      const bitmap = await createImageBitmap(img);
      self.postMessage({ type:'overview', gen:msg.gen, ox:msg.ox, oy:msg.oy, bitmap,
        ax:anchor?.ax ?? 0, ay:anchor?.ay ?? 0, landFrac:anchor?.landFrac ?? 0 }, [bitmap]);
      return;
    }
    case 'setts': setts.push(...msg.list); return;
    case 'forgetTile': tiles.delete(msg.key); return;
    case 'farmland': bakeFarmland = msg.flag; return;
  }
};
