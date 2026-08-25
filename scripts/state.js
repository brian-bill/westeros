// Shared mutable world state + constants.
// A single `S` object holds everything the modules read/write, avoiding a web
// of circular imports. Constants that never change are exported directly.

export const CHUNK = 32;         // fine cells per chunk edge
export const COARSE_SCALE = 8;   // fine cells per coarse cell

// Metric scale: one FINE world cell = 100 meters. Every km-based rule
// (settlement separation, road reach) goes through these helpers, so the
// scale can be changed in exactly one place.
// Default 256²-coarse world = 2048² fine cells ≈ 205 km across.
export const M_PER_FINE = 100;
export const fineToKm = cells => cells*M_PER_FINE/1000;
export const kmToFine = km => km*1000/M_PER_FINE;

// Terrain LOD tiers, selected by screen pixels per chunk edge. Tier t < 3
// streams chunks rasterized at every (1<<t)-th fine cell; at tier 3 the whole
// world is drawn from a single raster of the coarse grid (see coarseBitmap.js).
// Thresholds keep each texel >= ~1 screen px so nothing is ever minified.
export const LOD_PX = [18, 8, 4];

export const S = {
  GW: 256,          // coarse grid width  (in coarse cells)
  GH: 256,          // coarse grid height
  world: null,      // coarse skeleton + params + derived structures
  noiseFns: null,   // { el, t, m, w, det } field-noise functions
  agents: [],       // vehicle/boat/pedestrian agents
  view: { x:0, y:0, scale:1.0 },  // scale = screen px per FINE world cell
  layers: { terrain:true, water:true, farmland:true, roads:true,
            settlements:true, buildings:true, vehicles:true, boats:true,
            peds:true, labels:true },
};

export function setGrid(w, h){ S.GW = w; S.GH = h; }
export const worldFineW = () => S.GW * COARSE_SCALE;
export const worldFineH = () => S.GH * COARSE_SCALE;
