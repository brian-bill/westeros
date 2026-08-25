// Shared mutable world state + constants.
// A single `S` object holds everything the modules read/write, avoiding a web
// of circular imports. Constants that never change are exported directly.

export const CHUNK = 32;         // fine cells per chunk edge
export const COARSE_SCALE = 8;   // fine cells per coarse cell

export const S = {
  GW: 256,          // coarse grid width  (in coarse cells)
  GH: 256,          // coarse grid height
  world: null,      // coarse skeleton + params + derived structures
  noiseFns: null,   // { el, t, m, w, det } field-noise functions
  chunks: new Map(),// key "cx,cy" -> { bmp, lastUsed }
  agents: [],       // vehicle agents
  view: { x:0, y:0, scale:1.0 },  // scale = screen px per FINE world cell
  layers: { terrain:true, water:true, farmland:true, roads:true,
            settlements:true, buildings:true, agents:true },
};

export function setGrid(w, h){ S.GW = w; S.GH = h; }
export const worldFineW = () => S.GW * COARSE_SCALE;
export const worldFineH = () => S.GH * COARSE_SCALE;
