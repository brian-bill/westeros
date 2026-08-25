// Local street grid + building lots inside a settlement footprint (feature g).
// Generated lazily the first time a settlement is drawn at detail zoom.

import { xmur3, mulberry32 } from './rng.js';
import { S, COARSE_SCALE } from './state.js';

export function ensureSettlementDetail(s){
  if(s.buildings) return;
  const seedFn = xmur3(S.world.params.seed + '::layout::' + s.cx + ':' + s.cy);
  const rand = mulberry32(seedFn());

  const R = [3.5,6,10][s.tier]*COARSE_SCALE*0.5;
  const orient = rand()*Math.PI, cos = Math.cos(orient), sin = Math.sin(orient);
  const spacing = (s.tier===2?2.2 : s.tier===1?2.6 : 3.2)*1.4;
  const nLines = Math.ceil(R/spacing);
  const toWorld = (lx,ly) => [s.x + lx*cos - ly*sin, s.y + lx*sin + ly*cos];

  // street grid (clipped to circular footprint)
  const streets = [], buildings = [];
  for(let k=-nLines;k<=nLines;k++){
    const off = k*spacing; const ext = Math.sqrt(Math.max(0, R*R - off*off));
    if(ext<0.5) continue;
    streets.push([toWorld(off,-ext), toWorld(off,ext)]);
    streets.push([toWorld(-ext,off), toWorld(ext,off)]);
  }

  // building lots between street lines
  const density = s.tier===2?0.9 : s.tier===1?0.7 : 0.5;
  for(let gx=-nLines;gx<nLines;gx++) for(let gy=-nLines;gy<nLines;gy++){
    const lx=(gx+0.5)*spacing, ly=(gy+0.5)*spacing;
    if(lx*lx+ly*ly > R*R) continue;
    if(rand()>density) continue;
    const [wx,wy] = toWorld(lx,ly);
    const bw = spacing*(0.45+rand()*0.35), bh = spacing*(0.45+rand()*0.35);
    buildings.push({ x:wx, y:wy, w:bw, h:bh, rot:orient, big:s.tier===2 && rand()>0.6 });
  }

  s.streets = streets; s.buildings = buildings; s.R = R;
}
