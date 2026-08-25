// NAMED SETTLEMENTS & REGIONS — deterministic, seeded name generation plus
// label anchors. Settlements get unique syllable-built names; regions are the
// significant landmasses (connected land components), each named and anchored
// at its most interior cell (farthest graph distance from the ocean) so the
// label sits comfortably inside the landmass.

import { xmur3, mulberry32 } from './rng.js';
import { S, COARSE_SCALE } from './state.js';

// syllable inventory (onset + vowel + optional coda)
const ONSET = ['b','br','c','cr','d','dr','f','g','gr','h','k','kr','l','m','n','p','r','s','st','t','th','tr','v','w'];
const VOWEL = ['a','e','i','o','u','y','ae','ei','ia','ou','au'];
const CODA  = ['','','','','l','n','r','s','nd','rk','st','rn','lm','ss','th','rm'];
const CODA_REAL = CODA.slice(4);   // endings that actually close a syllable

// settlement suffixes give names a lived-in, toponymic feel
const TOWN_SUFFIX = ['bury','burgh','by','combe','dale','fell','ford','gate','ham',
                     'haven','holt','mark','mere','moor','shaw','stead','ton','wick','worth','wold'];

// region second words evoke geography rather than habitation
const REGION_WORD = ['Reach','Marches','Vale','Wold','Downs','Fens','Weald','Moors',
                     'Barrens','Uplands','Heartlands','Wilds','Crags','Shore','Hollows','Basin'];

function coreWord(rand, long=false){
  let w = ONSET[(rand()*ONSET.length)|0] + VOWEL[(rand()*VOWEL.length)|0];
  if(long || rand() < 0.45) w += ONSET[(rand()*ONSET.length)|0] + VOWEL[(rand()*VOWEL.length)|0];
  // short words must get a real ending ("Purndale", never "Pu")
  const pool = w.length > 3 ? CODA : CODA_REAL;
  w += pool[(rand()*pool.length)|0];
  return w[0].toUpperCase() + w.slice(1);
}

function makeSettlementName(rand){
  const base = coreWord(rand);
  return rand() < 0.6 ? base + TOWN_SUFFIX[(rand()*TOWN_SUFFIX.length)|0] : base;
}

function makeRegionName(rand){
  return coreWord(rand, true) + ' ' + REGION_WORD[(rand()*REGION_WORD.length)|0];
}

function uniqueName(gen, rand, used){
  for(let tries=0; tries<80; tries++){
    const nm = gen(rand);
    if(!used.has(nm)){ used.add(nm); return nm; }
  }
  // practically unreachable given the name space; fall back to numbering
  let n = 2;
  while(true){
    const nm = 'New ' + coreWord(rand);
    if(!used.has(nm)){ used.add(nm); return nm; }
    if(++n > 99) used.clear();
  }
}

export function assignNames(){
  const seedFn = xmur3(S.world.params.seed + '::names');
  const rand = mulberry32(seedFn());

  const used = new Set();
  for(const s of S.world.settlements) s.name = uniqueName(makeSettlementName, rand, used);

  S.world.regions = findRegions(rand, used);
}

// Connected land components on the coarse grid; keep the significant ones,
// name them, and anchor each at its interior-most cell.
function findRegions(rand, used){
  const { elev } = S.world;
  const sea = S.world.params.sea;
  const GW = S.GW, GH = S.GH, N = GW*GH;

  // multi-source BFS from ocean cells: dist = graph distance to the sea
  const dist = new Int16Array(N).fill(-1);
  const q = [];
  for(let i=0;i<N;i++) if(elev[i] < sea){ dist[i]=0; q.push(i); }
  for(let h=0;h<q.length;h++){
    const i=q[h], px=i%GW, py=(i/GW)|0;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx=px+dx, ny=py+dy;
      if(nx<0||ny<0||nx>=GW||ny>=GH) continue;
      const j=ny*GW+nx;
      if(dist[j]<0 && elev[j]>=sea){ dist[j]=dist[i]+1; q.push(j); }
    }
  }

  // flood-fill land components (lakes don't split a landmass)
  const comp = new Int32Array(N).fill(-1);
  const stats = [];   // per component: { size, bestI }
  for(let i=0;i<N;i++){
    if(elev[i]<sea || comp[i]>=0) continue;
    const id = stats.length;
    let size=0, bestI=i, stack=[i]; comp[i]=id;
    while(stack.length){
      const c=stack.pop(); size++;
      if(dist[c] > dist[bestI]) bestI=c;
      const px=c%GW, py=(c/GW)|0;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=px+dx, ny=py+dy;
        if(nx<0||ny<0||nx>=GW||ny>=GH) continue;
        const j=ny*GW+nx;
        if(elev[j]>=sea && comp[j]<0){ comp[j]=id; stack.push(j); }
      }
    }
    stats.push({ size, bestI });
  }

  // significant landmasses only: mainland + larger islands
  const minSize = Math.max(48, Math.round(N*0.0015));
  const regions = stats.filter(r=>r.size>=minSize)
    .sort((a,b)=>b.size-a.size).slice(0,6)
    .map(r=>({
      name: uniqueName(makeRegionName, rand, used),
      cx: r.bestI%GW, cy:(r.bestI/GW)|0,
      x: ((r.bestI%GW)+0.5)*COARSE_SCALE,
      y: (((r.bestI/GW)|0)+0.5)*COARSE_SCALE,
      size: r.size
    }));
  return regions;
}
