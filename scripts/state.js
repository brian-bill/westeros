// Shared mutable world state + constants.
// A single `S` object holds everything the modules read/write, avoiding a web
// of circular imports. Constants that never change are exported directly.

export const CHUNK = 32;         // fine cells per chunk edge
export const COARSE_SCALE = 8;   // fine cells per coarse cell

// Metric scale: one FINE world cell = 100 meters. Every km-based rule
// (settlement separation, road reach) goes through these helpers, so the
// scale can be changed in exactly one place.
export const M_PER_FINE = 100;
export const fineToKm = cells => cells*M_PER_FINE/1000;
export const kmToFine = km => km*1000/M_PER_FINE;

//------------------------------------------------------------------------------
// Infinite world geometry
//------------------------------------------------------------------------------
// The world is unbounded: the coarse skeleton is streamed in square
// mega-tiles (TILE² coarse cells) wherever the viewport goes. Each tile is
// computed with a HALO-wide context margin so hydrology stays local, and
// every coarse cell is owned by exactly one tile — samplers always route to
// the owner, so chunk borders stay seamless no matter which tiles are in.
// At far zoom whole OTILE² overview tiles (pure field classification, no
// hydrology) stand in where streaming full tiles would be wasteful.
export const TILE = 64;     // coarse cells per streamed mega-tile edge
export const HALO = 32;     // hydrology context margin around a tile, coarse cells
export const OTILE = 512;   // coarse cells per far-zoom overview tile
export const OSAMP = 128;   // overview raster resolution (samples per edge)

// Zoom regimes, in screen pixels per FINE cell:
//   >= SCALE_CHUNK_MIN       stream fine chunks (full-resolution tier)
//   >= SCALE_OVERVIEW_MAX    stretch per-mega-tile coarse bitmaps
//   else                     stretch cheap overview tiles
// SCALE_MIN floors the zoom-out so a frame never needs an absurd tile count.
// The chunk floor sits where a chunk is still ~16 screen px: below it the
// tile regime covers the same ground with a fraction of the work.
export const SCALE_CHUNK_MIN = 0.5;
export const SCALE_OVERVIEW_MAX = 0.09;
export const SCALE_MIN = 0.02;
export const SCALE_MAX = 30;

// Climate bands repeat every CLIMATE_PERIOD fine cells (~4800 km) of
// north-south travel: an endless pan or ride cycles tropical -> polar zones.
export const CLIMATE_PERIOD = 48000;

export const S = {
  params: null,     // { seed, sea, mtn, riverThresh, density }
  noiseFns: null,   // { el, t, m, w } field-noise functions
  world: null,      // growing structures: settlements registry, road/water
                    // graphs, edges, roundabouts, regions (see initWorld)
  agents: [],       // vehicle/boat/pedestrian agents
  view: { x:0, y:0, scale: SCALE_MAX },  // scale = screen px per FINE world cell
  layers: { terrain:true, water:true, farmland:true, roads:true,
            settlements:true, buildings:true, vehicles:true, boats:true,
            peds:true, labels:true },
};
