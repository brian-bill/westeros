# Westeros — Self-Generating Infinite 2D World

A procedurally generated, endlessly navigable 2D map rendered on the HTML
Canvas API. Inspired by Juraj Majerik's grid-based map
([draw-map](https://jurajmajerik.com/blog/draw-map/)), extended from
hand-placed obstacles into a fully procedural, *infinite* world covering all
natural terrain and human activity.

## Goal
A virtual world of purely 2D navigable maps, unbounded in every direction:
a. Forest cover · b. Mountains · c. Rivers, swamps & bogs · d. Lakes ·
e. Oceans · f. Roads · g. Houses · h. Farmlands · i. Villages · j. Towns · k. Cities.

## Core design principle
Don't generate terrain types directly. Generate a few continuous **scalar
fields** (elevation, temperature, moisture), then derive discrete terrain by
thresholding combinations of them. Human settlement layers on top via
suitability scoring. Because the fields are pure functions of world
coordinates, the world is infinite: everything else streams in around the
viewport.

## Architecture: streamed mega-tiles on an infinite plane
- **Pure fields** — elevation/temperature/moisture are evaluable at any
  world coordinate, forever (domain-warped fBm + a low-frequency continent
  sheet; temperature follows latitude bands that repeat every ~4800 km so
  endless north–south travel cycles tropical → polar).
- **Coarse skeleton mega-tiles** — the old finite grid is gone. TILE²-coarse
  tiles (64², ~5 km) generate wherever the viewport goes, each with a HALO
  context margin, in a Web Worker. Every coarse cell has exactly one owner
  tile, so all samplers route through the owner and every consumer sees the
  same canonical value no matter which tiles are loaded.
- **Seamless local hydrology** — flow directions are steepest descent on raw
  elevation (a pure function, identical in every window). Rivers come from
  *truncated, blurred* accumulation — exact-distance passes over a
  stride-4 sheet — with non-maximum suppression picking valley axes; lakes
  pool around terminal sinks within radius. Every rule is strictly local, so
  independently generated tiles agree perfectly about shared borders.
- **Deterministic settlement lattices** — villages and urban sites sit on
  two fixed lattices (pitch 10.4 km / 76.8 km) with seeded jitter whose
  margins *are* the metric separation rules (villages ≥ 7 km, urban sites
  ≥ 50 km apart — by construction, independent of load order). Suitability
  (flatness, fresh water, fertility, coast) gates which lattice cells settle.
- **Incremental networks** — roads (trunks mesh towns/cities, feeders join
  villages), ports and sea lanes are proposed per settlement and laid by
  windowed A* once the corridor's tiles stream in; the junction graphs grow
  monotonically and agents route over them via Dijkstra.
- **Metric scale** — 1 fine cell = 100 m (`M_PER_FINE` in state.js); all
  spacing rules are expressed in km via `kmToFine`/`fineToKm`.

---

## Generation pipeline & feature checklist

- [x] **Seeded deterministic PRNG** (`xmur3` + `mulberry32`) — reproducible worlds
- [x] **Hash-based value noise + fBm** — seamless, coordinate-based (no perm table)
- [x] **Elevation** — domain-warped fBm + low-frequency continent sheet
      (endless landmasses, no radial mask), relief stretch + alpine tail
- [x] **Temperature** — periodic latitude bands − elevation lapse rate + noise
- [x] **Moisture** — fBm noise field
- [x] **Biome classification** — Whittaker-style thresholds:
  - [x] (a) Forest cover (forest / rainforest / taiga)
  - [x] (b) Mountains (rock + snow above snowline)
  - [x] (e) Oceans (ocean / deep ocean below sea level)
  - [x] Grassland, desert, tundra, beach
- [x] **Hydrology** (streamed per mega-tile, strictly local rules):
  - [x] D8 flow directions on raw elevation (pure function of the field)
  - [x] Truncated flow accumulation (exact-distance passes, halo-bounded)
  - [x] (c) Rivers — blurred accumulation on a stride-4 sheet with
        non-maximum suppression (valley axes; big trunks vs gullies)
  - [x] (d) Lakes — water pooling around terminal sinks
  - [x] (c) Swamps / bogs (low + flat + wet + near-water)
- [x] **Settlements** — deterministic two-lattice placement (the lattice
      margins *are* the metric spacing rules: villages ≥ 7 km, urban sites
      ≥ 50 km) + suitability gating (flatness, fresh water, fertility, coast):
  - [x] (i) Villages
  - [x] (j) Towns
  - [x] (k) Cities
- [x] **(f) Roads** — incremental two-class hierarchy: trunk highways mesh
      towns/cities, thin feeder spurs join every village to the network;
      windowed A* with existing-road reuse discount; through-roads skirt town
      cores; bridges over water; roundabouts where routes cross
- [x] **(h) Farmland** — fertile flat rings around settlements (radius scales
      with tier), baked into chunk bitmaps and tile rasters by the worker
- [x] **(g) Houses / streets** — per-settlement local street grid + building
      lots (density and size scale with tier)
- [x] **Chunking / LOD** — three zoom regimes: fine chunks (scale ≥ 0.5),
      stretched mega-tile bitmaps (≥ 0.09), low-pass overview tiles beyond;
      LRU eviction everywhere; instant provisional colors fill gaps
- [x] **Web Worker generation** — mega-tiles, fine chunks and overview
      rasters all generated off the main thread as transferable
      `ImageBitmap`s, so panning/zoom never freezes
- [x] **Runtime navigation / agents** — road-junction graph (Dijkstra routing)
      with vehicles animating along roads; multi-modal: boats route between
      ports over an A*-laid water-lane graph (sea lanes through ocean/lake/
      river); pedestrians follow FEEDER-road sidewalks only (never trunks,
      never cross-country, buildings keep clear of road corridors) on staged
      trips — walk to a pickup village, ride a vehicle over the road network,
      then walk from the drop-off to their destination; agents spawn around
      the viewport and retire when left behind

### Rendering & UI
- [x] Canvas 2D with cached offscreen chunk/tile bitmaps, screen-space
      device-pixel snapping (no seams between streamed bitmaps)
- [x] Pan / zoom / hover inspection tooltip — full desktop + mobile parity
      (drag to pan, scroll or pinch to zoom, tap to inspect)
- [x] Controls: seed, sea level, mountain level, river density, settlement density
- [x] Layer toggles + biome legend + live stats (tiles streamed, places,
      roads, agents)

---

## Possible future work
- [x] Multi-tier LOD rendering from the coarse grid at very far zoom
      (fine chunks → mega-tile bitmaps → low-pass overview tiles, selected
      by screen pixels per fine cell)
- [x] Named settlements / regions and a labels layer
      (seeded syllable names; regions anchored at their most-interior land
      sample per overview tile)
- [x] Biome-aware building styles and organic (non-grid) village streets
      (radial lanes + wobbling ring ways for villages, wobbled grids for
      towns; walls/roofs follow the dominant local biome)
- [x] Multi-modal navigation (boats on water, pedestrians off-road)
      (windowed grid A* in `navigation.js`; ports + sea lanes for boats;
      pedestrians restricted to a feeder-road subgraph with staged
      walk → ride → walk trips and sidewalk offsets)
- [x] Truly infinite world (streaming coarse skeleton in mega-tiles)
      (pure fields + owner-canonical streamed tiles with hydrology-local
      rules, lattice settlements, incremental roads/lanes/agents — pan
      forever in any direction)

---

## Project layout

```
westeros/
├── index.html               UI shell (loads scripts/main.js as an ES module)
├── README.md                this file
└── scripts/
    ├── rng.js               deterministic PRNG (xmur3, mulberry32)
    ├── noise.js             hash value noise + fBm
    ├── biomes.js            biome enum, colors, names, classifier
    ├── state.js             shared mutable state (S) + infinite-world constants
    ├── fields.js            pure elevation/temp/moisture fields (evaluable
                             at any coordinate, forever; low-pass variants)
    ├── hydrology.js         local-hydrology rules: raw-elevation D8 flow,
                             truncated accumulation, NMS river mask,
                             sink-pool lake mask
    ├── settlements.js       deterministic lattices + suitability gating +
                             registry/nearest queries
    ├── names.js             seeded per-entity settlement/region names
    ├── worldTiles.js        the streaming backbone: worker orchestration,
                             mega-tile + overview lifecycle, canonical
                             samplers, tile bitmaps, region registry
    ├── chunkWorker.js       off-main-thread generation (module worker):
                             mega-tile skeletons, fine chunks, overviews
    ├── chunks.js            chunk bitmap caches gated on tile readiness
    ├── navigation.js        windowed grid A* (pooled + stamped), ports,
                             sea lanes, canonical biome accessors
    ├── roads.js             incremental trunk/feeder network, bridges,
                             roundabouts, junction + pedestrian graphs
    ├── settlementDetail.js  per-settlement streets + building layout
                             (organic villages; biome-styled buildings kept off
                             road corridors)
    ├── agents.js            viewport-maintained multi-modal agents
                             (vehicles / boats / staged hiker trips)
    ├── render.js            three-regime viewport rendering + overlays
    └── main.js              UI wiring, interaction, boot, animation loop
```

## Running
ES modules require serving over HTTP (not `file://`):

```
cd westeros
python3 -m http.server 8000
# open http://localhost:8000/
```
