# Westeros - Self-Generating 2D World

A procedurally generated, navigable 2D map rendered on the HTML Canvas API.
Inspired by Juraj Majerik's grid-based map ([draw-map](https://jurajmajerik.com/blog/draw-map/)),
extended from hand-placed obstacles into a fully procedural world covering all
natural terrain and human activity.

## Goal
A virtual world of purely 2D navigable maps covering:
a. Forest cover · b. Mountains · c. Rivers, swamps & bogs · d. Lakes ·
e. Oceans · f. Roads · g. Houses · h. Farmlands · i. Villages · j. Towns · k. Cities.

## Core design principle
Don't generate terrain types directly. Generate a few continuous **scalar fields**
(elevation, temperature, moisture), then derive discrete terrain by thresholding
combinations of them. Human settlement layers on top via suitability scoring.
The pipeline is a sequence of passes, each reading previous layers.

## Architecture: two-tier chunked world
- **Coarse global skeleton** — the whole world at low resolution, generated once:
  elevation, hydrology, biomes, settlements, road network.
- **Fine chunks** — refined on demand as the viewport moves, cached and evicted.
  Noise is a pure function of world coordinates, so chunk borders are seamless.
- **Metric scale** — 1 fine cell = 100 m (`M_PER_FINE` in state.js); the default
  256² world spans ≈205 km. All spacing rules (settlements ≥7/50/90 km by tier)
  are expressed in km via `kmToFine`/`fineToKm`.

---

## Generation pipeline & feature checklist

- [x] **Seeded deterministic PRNG** (`xmur3` + `mulberry32`) — reproducible worlds
- [x] **Hash-based value noise + fBm** — seamless, coordinate-based (no perm table)
- [x] **Elevation** — domain-warped fBm × radial continent mask (produces landmasses)
- [x] **Temperature** — latitude gradient − elevation lapse rate + noise
- [x] **Moisture** — fBm noise field
- [x] **Biome classification** — Whittaker-style thresholds:
  - [x] (a) Forest cover (forest / rainforest / taiga)
  - [x] (b) Mountains (rock + snow above snowline)
  - [x] (e) Oceans (ocean / deep ocean below sea level)
  - [x] Grassland, desert, tundra, beach
- [x] **Hydrology**
  - [x] Depression filling (priority flood) so water reaches the sea
  - [x] D8 flow direction + flow accumulation
  - [x] (c) Rivers (high flow accumulation)
  - [x] (d) Lakes (filled basins)
  - [x] (c) Swamps / bogs (low + flat + wet + near-water)
- [x] **Settlements** — suitability score (flatness, fresh water, fertility, coast)
      + Poisson-disk spacing (metric: villages ≥7 km apart, towns ≥50 km, cities ≥90 km),
      rank-size (Zipf) tiering:
  - [x] (i) Villages
  - [x] (j) Towns
  - [x] (k) Cities
- [x] **(f) Roads** — two-class hierarchy: trunk highways mesh the towns/cities
      (weighted A* with existing-road reuse discount; through-roads skirt town
      cores), thin feeder spurs join every village to the network; bridges over
      water
- [x] **(h) Farmland** — fertile flat rings around settlements (radius scales with tier)
- [x] **(g) Houses / streets** — per-settlement local street grid + building lots
      (density and size scale with tier)
- [x] **Chunking / LOD** — viewport-driven chunk streaming, LRU eviction, and
      level-of-detail (dots when zoomed out, streets + buildings when zoomed in)
- [x] **Web Worker chunk generation** — fine chunks rasterized off the main thread
      and returned as transferable `ImageBitmap`s, so panning/zoom never freezes;
      coarse-biome placeholders shown until each chunk streams in
- [x] **Runtime navigation / agents** — road-junction graph (Dijkstra routing)
      with vehicles animating along roads; multi-modal: boats route between
      ports over an A*-laid water-lane graph (sea lanes through ocean/lake/
      river); pedestrians follow FEEDER-road sidewalks only (never trunks,
      never cross-country, buildings keep clear of road corridors) on staged
      trips — walk to a pickup village, ride a vehicle over the road network,
      then walk from the drop-off to their destination

### Rendering & UI
- [x] Canvas 2D with cached offscreen chunk bitmaps
- [x] Pan / zoom / hover inspection tooltip — full desktop + mobile parity
      (drag to pan, scroll or pinch to zoom, tap to inspect)
- [x] Controls: seed, sea level, mountain level, river density, settlement count, world size
- [x] Layer toggles + biome legend + live stats

---

## Possible future work
- [x] Multi-tier LOD rendering from the coarse grid at very far zoom
      (full/half/quarter-resolution chunk streams, then a single whole-world
      raster of the coarse grid at extreme zoom-out)
- [x] Named settlements / regions and a labels layer
      (seeded syllable names; landmass regions anchored at their interior)
- [x] Biome-aware building styles and organic (non-grid) village streets
      (radial lanes + wobbling ring ways for villages, wobbled grids for
      towns; walls/roofs follow the dominant local biome)
- [ ] Save/load worlds; shareable seed URLs
- [x] Multi-modal navigation (boats on water, pedestrians off-road)
      (shared grid A* in `navigation.js`; ports + sea lanes for boats;
      pedestrians restricted to a feeder-road subgraph with staged
      walk → ride → walk trips and sidewalk offsets)
- [ ] Truly infinite world (streaming coarse skeleton in mega-tiles)

---

## Project layout

```
westeros/
├── index.html               UI shell (loads scripts/main.js as an ES module)
├── PLAN.md                  this file
└── scripts/
    ├── rng.js               deterministic PRNG (xmur3, mulberry32)
    ├── noise.js             hash value noise + fBm
    ├── biomes.js            biome enum, colors, names, classifier
    ├── state.js             shared mutable state (S) + constants
    ├── fields.js            elevation/temp/moisture + coarse samplers + fine refiner
    ├── hydrology.js         depression fill + D8 flow/accumulation
    ├── settlements.js       suitability scoring + placement (metric spacing)
    ├── names.js             seeded settlement/region names + label anchors
    ├── coarse.js            coarse global skeleton generation
    ├── roads.js             weighted A*, trunk/feeder hierarchy, tiers,
                             junction graph
    ├── navigation.js        shared grid A* (pooled + stamped), water/port
                             graph (sea lanes), feeder-road pedestrian subgraph
├── chunks.js            chunk worker orchestration, multi-tier LOD caches + eviction
├── chunkWorker.js       off-main-thread fine chunk rasterization (module worker)
├── coarseBitmap.js      whole-world coarse-grid raster for the far-zoom LOD tier
    ├── settlementDetail.js  per-settlement streets + building layout
                             (organic villages; biome-styled buildings kept off
                             road corridors)
    ├── agents.js            road-graph routing + vehicle agents
    ├── render.js            viewport rendering + LOD overlays
    └── main.js              UI wiring, interaction, boot, animation loop
```

## Running
ES modules require serving over HTTP (not `file://`):

```
cd westeros
python3 -m http.server 8000
# open http://localhost:8000/
```
