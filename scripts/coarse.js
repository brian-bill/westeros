// COARSE GLOBAL SKELETON — generated once for the whole world:
// elevation/temp/moisture fields, hydrology (rivers/lakes/swamps), baseline
// biomes, and settlement placement.

import { B, classifyBiome } from './biomes.js';
import { S, COARSE_SCALE, setGrid } from './state.js';
import { makeParamNoise, elevationAt, tempAt, moistAt } from './fields.js';
import { fillDepressions, computeFlow } from './hydrology.js';
import { placeSettlements } from './settlements.js';
import { assignNames } from './names.js';

const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
const NB4 = [[1,0],[-1,0],[0,1],[0,-1]];

export function generateCoarse(params){
  const { seed, sea, mtn, riverThresh, nSettle } = params;
  setGrid(params.worldSize, params.worldSize);
  const GW = S.GW, GH = S.GH, N = GW*GH;
  S.noiseFns = makeParamNoise(seed);

  const elev = new Float32Array(N), temp = new Float32Array(N), moist = new Float32Array(N);
  const biome = new Int8Array(N);

  // sample coarse fields at coarse-cell centers (in fine coords)
  for(let y=0;y<GH;y++) for(let x=0;x<GW;x++){
    const i=y*GW+x, fx=(x+0.5)*COARSE_SCALE, fy=(y+0.5)*COARSE_SCALE;
    const e = elevationAt(fx,fy); elev[i]=e;
    temp[i] = tempAt(fx,fy,e,sea); moist[i] = moistAt(fx,fy);
  }

  // hydrology
  const filled = fillDepressions(elev, GW, GH);
  const { flowTo, accum } = computeFlow(elev, filled, GW, GH, sea);

  // baseline biome + rivers/lakes/swamps
  const isWater = new Uint8Array(N);
  for(let i=0;i<N;i++) biome[i] = classifyBiome(elev[i], temp[i], moist[i], sea, mtn);

  // Open waters vs inland lakes: below-sea cells flood-filled from the map
  // border are true open ocean; enclosed below-sea basins cut off from the sea
  // become lakes instead of phantom landlocked oceans.
  const openWater = new Uint8Array(N);
  const stack = [];
  for(let x=0;x<GW;x++) for(const y of [0,GH-1]){
    const i=y*GW+x;
    if((biome[i]===B.OCEAN||biome[i]===B.DEEP_OCEAN) && !openWater[i]){ openWater[i]=1; stack.push(i); }
  }
  for(let y=0;y<GH;y++) for(const x of [0,GW-1]){
    const i=y*GW+x;
    if((biome[i]===B.OCEAN||biome[i]===B.DEEP_OCEAN) && !openWater[i]){ openWater[i]=1; stack.push(i); }
  }
  while(stack.length){
    const i=stack.pop(), px=i%GW, py=(i/GW)|0;
    for(const [dx,dy] of NB4){
      const nx=px+dx, ny=py+dy;
      if(nx<0||ny<0||nx>=GW||ny>=GH) continue;
      const j=ny*GW+nx;
      if(!openWater[j] && (biome[j]===B.OCEAN||biome[j]===B.DEEP_OCEAN)){ openWater[j]=1; stack.push(j); }
    }
  }
  for(let i=0;i<N;i++)
    if(!openWater[i] && (biome[i]===B.OCEAN||biome[i]===B.DEEP_OCEAN)) biome[i]=B.LAKE;

  for(let i=0;i<N;i++){
    if(elev[i]<sea){ isWater[i]=1; continue; }
    if(accum[i]>riverThresh){ biome[i]=B.RIVER; isWater[i]=1; }
    else if(filled[i]-elev[i]>0.012){ biome[i]=B.LAKE; isWater[i]=1; }
  }
  for(let y=1;y<GH-1;y++) for(let x=1;x<GW-1;x++){
    const i=y*GW+x;
    if(isWater[i]||elev[i]<sea||elev[i]>sea+0.10) continue;
    const sl = Math.abs(elev[i]-elev[i+1]) + Math.abs(elev[i]-elev[i+GW]);
    let near=false; for(const [dx,dy] of NB8){ if(isWater[(y+dy)*GW+(x+dx)]){ near=true; break; } }
    if(sl<0.006 && moist[i]>0.5 && near && accum[i]<riverThresh) biome[i]=B.SWAMP;
  }

  S.world = { params, elev, temp, moist, biome, isWater, accum, filled, flowTo,
              settlements:[], GW, GH };

  placeSettlements(nSettle, sea);
  assignNames();   // settlement + region names for the labels layer
  return S.world;
}
