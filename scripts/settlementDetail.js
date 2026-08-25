// Local streets + building lots inside a settlement footprint (feature g).
// Generated lazily the first time a settlement is drawn at detail zoom.
// Villages grow an organic network (curving radial lanes + wobbling ring
// ways) instead of a grid; towns use a subdivided-and-wobbled grid; cities
// keep a regular grid. Architecture follows the dominant local biome.

import { xmur3, mulberry32 } from './rng.js';
import { S, COARSE_SCALE } from './state.js';
import { B } from './biomes.js';
import { refineFineBiome } from './fields.js';

const isWaterBiome = b => b===B.OCEAN || b===B.DEEP_OCEAN || b===B.RIVER
                       || b===B.LAKE  || b===B.SWAMP;

// Render recipe per architecture style (consumed by render.js): wall fill,
// roof color, dark trim, and whether roofs are gabled (ridge line) or flat
// (parapet inset).
export const ARCH = {
  thatch:{ wall:'#b6a077', roof:'#8a6d3b', trim:'#4a3826', pitched:true },
  timber:{ wall:'#7d5f44', roof:'#553f2a', trim:'#2e2115', pitched:true },
  stone :{ wall:'#98918a', roof:'#6e6862', trim:'#3c3733', pitched:true },
  snow  :{ wall:'#8d8578', roof:'#eef2f5', trim:'#454039', pitched:true },
  adobe :{ wall:'#d9c191', roof:'#bfa06a', trim:'#6b5636', pitched:false },
  stilt :{ wall:'#5d4a33', roof:'#3f3222', trim:'#241c11', pitched:true },
};

const styleForBiome = b =>
  b===B.DESERT||b===B.BEACH ? 'adobe' :
  b===B.SNOW ||b===B.TUNDRA ? 'snow'  :
  b===B.MOUNTAIN            ? 'stone' :
  b===B.TAIGA||b===B.FOREST||b===B.RAINFOREST ? 'timber' :
  b===B.SWAMP               ? 'stilt' : 'thatch';

// Point-to-segment distance (road corridor checks).
function distSeg(px,py, ax,ay, bx,by){
  const dx=bx-ax, dy=by-ay;
  const l2=dx*dx+dy*dy;
  const t=l2 ? Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/l2)) : 0;
  return Math.hypot(px-(ax+dx*t), py-(ay+dy*t));
}

export function ensureSettlementDetail(s){
  if(s.buildings) return;
  const seedFn = xmur3(S.world.params.seed + '::layout::' + s.cx + ':' + s.cy);
  const rand = mulberry32(seedFn());

  // Footprint radius, capped by roads.js so built-up areas never overlap.
  const R = Math.min([3.5,6,10][s.tier]*COARSE_SCALE*0.5, s.maxR ?? Infinity);
  if(R < 8){ s.streets = []; s.buildings = []; s.R = R; return; }

  // Dominant biome across the footprint decides the settlement's look.
  const votes = {};
  for(let i=0;i<9;i++){
    const a=rand()*Math.PI*2, r=Math.sqrt(rand())*R*0.7;
    const { b } = refineFineBiome((s.x+Math.cos(a)*r)|0, (s.y+Math.sin(a)*r)|0);
    if(!isWaterBiome(b)) votes[b]=(votes[b]||0)+1;
  }
  let dom=-1, best=0;
  for(const k in votes) if(votes[k]>best){ best=votes[k]; dom=+k; }
  s.style = styleForBiome(dom);

  const orient = rand()*Math.PI;
  const spacing = (s.tier===2?2.2 : s.tier===1?2.6 : 2.7)*1.4;
  const streets = [], buildings = [];

  // Trunk/feeder road corridors passing near this settlement: candidate lots
  // must clear them so buildings never end up on top of a road.
  const ROAD_CLEAR = 1.8;   // world units kept free either side of a road line
  const corridors = [];
  for(const e of (S.world.roads?.edges)||[]){
    const pts = e.path.map(ci=>[
      ((ci%S.GW)+0.5)*COARSE_SCALE,
      (((ci/S.GW)|0)+0.5)*COARSE_SCALE ]);
    if(pts.some(([px,py]) => Math.abs(px-s.x)<R+8 && Math.abs(py-s.y)<R+8))
      corridors.push(pts);
  }
  const clearOfRoads = (x,y,r)=>{
    for(const pts of corridors)
      for(let k=0;k<pts.length-1;k++)
        if(distSeg(x,y, pts[k][0],pts[k][1], pts[k+1][0],pts[k+1][1]) < r+ROAD_CLEAR)
          return false;
    return true;
  };

  // Lot-overlap rejection via a coarse spatial hash.
  const CELL = 6, occ = new Map();
  const fits = (x,y,r)=>{
    const gx=(x/CELL)|0, gy=(y/CELL)|0;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      const l = occ.get((gx+dx)+'.'+(gy+dy));
      if(l) for(const o of l) if(Math.hypot(x-o.x,y-o.y) < r+o.r) return false;
    }
    return true;
  };
  const claim = (x,y,r)=>{
    const k=((x/CELL)|0)+'.'+((y/CELL)|0);
    let l=occ.get(k); if(!l){ l=[]; occ.set(k,l); }
    l.push({x,y,r});
  };

  // One house beside a point; rejects water lots, road corridors and overlaps.
  const tryLot = (x,y,ang,size)=>{
    if(Math.hypot(x-s.x,y-s.y) > R) return;
    const w=size*(0.8+rand()*0.4), h=size*(0.55+rand()*0.35), r=Math.max(w,h)*0.55;
    if(isWaterBiome(refineFineBiome(x|0,y|0).b)) return;
    if(!clearOfRoads(x,y,r)) return;
    if(!fits(x,y,r)) return;
    claim(x,y,r);
    buildings.push({ x,y,w,h,r,rot:ang+(rand()-0.5)*0.3 });
  };

  // Houses hugging a street polyline, alternating sides with gaps.
  const lineLots = line=>{
    for(let k=0;k<line.length-1;k++){
      const [ax,ay]=line[k], [bx,by]=line[k+1];
      const len=Math.hypot(bx-ax,by-ay); if(len<1) continue;
      const ang=Math.atan2(by-ay,bx-ax), nx=-Math.sin(ang), ny=Math.cos(ang);
      for(let d=spacing*0.35; d<len; d+=spacing*(0.95+rand()*0.75)){
        for(const side of [-1,1]){
          if(rand()<0.16) continue;                       // vacant gaps
          const off=spacing*(0.58+rand()*0.35);
          tryLot(ax+(bx-ax)*d/len+nx*off*side,
                 ay+(by-ay)*d/len+ny*off*side, ang, spacing*0.72);
        }
      }
    }
  };

  if(s.tier === 0){                                       // ORGANIC VILLAGE
    const a0=rand()*Math.PI*2, p1=rand()*6.283, p2=rand()*6.283;
    const spokes=Math.max(6, Math.round(R/spacing*1.6));
    for(let i=0;i<spokes;i++){                            // curving radial lanes
      let a=a0+i*Math.PI*2/spokes+(rand()-0.5)*0.6, r=R*0.08;
      const line=[];
      while(r < R*(0.85+rand()*0.2)){
        line.push([s.x+Math.cos(a)*r, s.y+Math.sin(a)*r]);
        a += (rand()-0.5)*0.34; r += spacing*(0.65+rand()*0.55);
      }
      if(line.length>1) streets.push(line);
    }
    const rings=R>18?3:2;                                 // wobbling ring ways
    for(let k=0;k<rings;k++){
      const rr=R*(0.36+0.19*k)+rand()*2;
      const n=Math.max(12, Math.round(rr)), line=[];
      for(let j=0;j<=n;j++){
        const t=j/n*Math.PI*2;
        const rad=rr*(1+0.13*Math.sin(3*t+p1)+0.09*Math.sin(5*t+p2));
        line.push([s.x+Math.cos(t)*rad, s.y+Math.sin(t)*rad]);
      }
      streets.push(line);
    }
    for(const line of streets) lineLots(line);
  } else if(s.tier === 1){                                // WOBBLED TOWN GRID
    const cos=Math.cos(orient), sin=Math.sin(orient);
    const toWorld=(lx,ly)=>[s.x+lx*cos-ly*sin, s.y+lx*sin+ly*cos];
    const nL=Math.ceil(R/spacing);
    for(let k=-nL;k<=nL;k++){
      const off=k*spacing, ext=Math.sqrt(Math.max(0,R*R-off*off));
      if(ext<0.5) continue;
      for(let dir=0;dir<2;dir++){
        const line=[], STEPS=4;
        for(let j=0;j<=STEPS;j++){
          const u=-ext+2*ext*j/STEPS;
          const w=(j===0||j===STEPS)?0:(rand()-0.5)*spacing*0.8;
          line.push(dir===0 ? toWorld(off+w,u) : toWorld(u,off+w));
        }
        streets.push(line);
      }
    }
    for(const line of streets) lineLots(line);
  } else {                                                // REGULAR CITY GRID
    const cos=Math.cos(orient), sin=Math.sin(orient);
    const toWorld=(lx,ly)=>[s.x+lx*cos-ly*sin, s.y+lx*sin+ly*cos];
    const nLines=Math.ceil(R/spacing);
    for(let k=-nLines;k<=nLines;k++){
      const off=k*spacing; const ext=Math.sqrt(Math.max(0,R*R-off*off));
      if(ext<0.5) continue;
      streets.push([toWorld(off,-ext), toWorld(off,ext)]);
      streets.push([toWorld(-ext,off), toWorld(ext,off)]);
    }
    const density=0.9;
    for(let gx=-nLines;gx<nLines;gx++) for(let gy=-nLines;gy<nLines;gy++){
      const lx=(gx+0.5)*spacing, ly=(gy+0.5)*spacing;
      if(lx*lx+ly*ly > R*R) continue;
      if(rand()>density) continue;
      const [wx,wy] = toWorld(lx,ly);
      const bw = spacing*(0.45+rand()*0.35), bh = spacing*(0.45+rand()*0.35);
      const br = Math.max(bw,bh)*0.55;
      if(isWaterBiome(refineFineBiome(wx|0, wy|0).b)) continue;   // keep houses dry
      if(!clearOfRoads(wx,wy,br)) continue;                       // ...and off the roads
      buildings.push({ x:wx, y:wy, w:bw, h:bh, r:br,
                       rot:orient, big:rand()>0.6 });
    }
  }

  s.streets = streets; s.buildings = buildings; s.R = R;
}
