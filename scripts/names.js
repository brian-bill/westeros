// SEEDED NAMES — deterministic syllable-built names for settlements and
// regions. In an infinite world names must be derivable independently for any
// entity from just (seed, kind, coordinates), with no shared sequential RNG:
// every settlement names itself the same way no matter which tile registered
// it or when.

import { xmur3, mulberry32 } from './rng.js';

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

// A name derived purely from (world seed, usage salt): same input, same name,
// regardless of generation order. Collisions are possible across an unbounded
// world but rare enough (syllable space is huge) to ignore.
function derive(seed, salt, gen){
  const rand = mulberry32(xmur3(seed + '::' + salt)());
  return gen(rand);
}

export const settlementName = (seed, id) => derive(seed, 'name:' + id, makeSettlementName);
export const regionName     = (seed, key) => derive(seed, 'region:' + key, makeRegionName);
