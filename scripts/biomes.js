// Biome enum, colors, display names, and the Whittaker-style classifier.

export const B = {
  OCEAN:0, DEEP_OCEAN:1, BEACH:2, DESERT:3, GRASSLAND:4, FOREST:5,
  RAINFOREST:6, TAIGA:7, TUNDRA:8, MOUNTAIN:9, SNOW:10, RIVER:11,
  LAKE:12, SWAMP:13, FARMLAND:14
};

export const COLOR = {
  [B.DEEP_OCEAN]:'#1b3a63', [B.OCEAN]:'#2b5b8c', [B.BEACH]:'#d9cfa3',
  [B.DESERT]:'#d8c07a', [B.GRASSLAND]:'#8bab55', [B.FOREST]:'#4f7a3a',
  [B.RAINFOREST]:'#2f6b34', [B.TAIGA]:'#5b7a63', [B.TUNDRA]:'#b7bfae',
  [B.MOUNTAIN]:'#7d746a', [B.SNOW]:'#eef2f5', [B.RIVER]:'#3d7fb5',
  [B.LAKE]:'#356fa0', [B.SWAMP]:'#4d5f43', [B.FARMLAND]:'#c9b466'
};

export const NAME = {
  [B.DEEP_OCEAN]:'Deep ocean', [B.OCEAN]:'Ocean', [B.BEACH]:'Beach',
  [B.DESERT]:'Desert', [B.GRASSLAND]:'Grassland', [B.FOREST]:'Forest',
  [B.RAINFOREST]:'Rainforest', [B.TAIGA]:'Taiga', [B.TUNDRA]:'Tundra',
  [B.MOUNTAIN]:'Mountain', [B.SNOW]:'Snow', [B.RIVER]:'River',
  [B.LAKE]:'Lake', [B.SWAMP]:'Swamp/Bog', [B.FARMLAND]:'Farmland'
};

// Classify a land/water cell from elevation, temperature, moisture.
export function classifyBiome(e, t, m, sea, mtn){
  if(e < sea - 0.06) return B.DEEP_OCEAN;
  if(e < sea)        return B.OCEAN;
  if(e < sea + 0.02) return B.BEACH;
  if(e > mtn + 0.08) return t < 0.35 ? B.SNOW : B.MOUNTAIN;
  if(e > mtn)        return B.MOUNTAIN;
  if(t < 0.25) return m > 0.45 ? B.TAIGA : B.TUNDRA;
  if(t > 0.68 && m < 0.32) return B.DESERT;
  if(m > 0.72) return t > 0.6 ? B.RAINFOREST : B.FOREST;
  if(m > 0.45) return B.FOREST;
  return B.GRASSLAND;
}
