// Entry point: wires UI controls, interaction (pan/zoom/hover), the infinite
// generation pipeline, and the animation loop. There is no "generate the
// world" pass any more — terrain, settlements and roads all stream around
// whatever the viewport does.

import { B, COLOR, NAME } from './biomes.js';
import { S, CHUNK, COARSE_SCALE, SCALE_MIN, SCALE_MAX, M_PER_FINE } from './state.js';
import { makeParamNoise, elevationAt } from './fields.js';
import { assignPort, ensureLanes } from './navigation.js';
import { registerTileCandidates, recapFootprints } from './settlements.js';
import { tryLinkSettlement, ensureRoads } from './roads.js';
import { maintainAgents, stepAgents } from './agents.js';
import { onTileReady, onChange, updateStreaming, postToWorker,
         streamStats, refineFineBiome } from './worldTiles.js';
import { resetChunks, setChunkReadyCallback, flushWaiting, setFarmland } from './chunks.js';
import { initRenderer, getCanvas, draw, screenToWorld, viewportRect } from './render.js';

const $ = id => document.getElementById(id);

initRenderer($('c'));
const canvas = getCanvas();

// A new mega-tile just arrived: turn its settlement candidates into real
// places and wire them into the networks.
onTileReady(tile => {
  const fresh = registerTileCandidates(tile);
  if(!fresh.length) return;
  const batch = [];
  for(const s of fresh){
    recapFootprints(s);          // anti-overlap caps (may touch neighbors too)
    tryLinkSettlement(s);        // propose edges to nearest neighbors
    assignPort(s);               // harbor berth if water is close enough
    batch.push({ x:s.x, y:s.y, tier:s.tier, score:s.score });
  }
  postToWorker({ type:'setts', list:batch });   // worker bakes their farmland
});

// Streaming arrivals invalidate what's on screen; coalesce redraws per frame.
let dirty = true;
setChunkReadyCallback(() => { dirty = true; });
onChange(() => { flushWaiting(); dirty = true; });

//--------------------------------------------------------------------------
// World lifecycle
//--------------------------------------------------------------------------
function readParams(){
  return {
    seed: $('seed').value || 'seed',
    sea: +$('sea').value, mtn: +$('mtn').value,
    riverThresh: +$('riv').value,
    density: +$('setn').value/100
  };
}

function initWorld(p){
  const url = new URL(location.href);
  url.searchParams.set('seed', p.seed);
  history.replaceState(null, '', url);

  S.params = p;
  S.noiseFns = makeParamNoise(p.seed);
  S.world = {
    settlements: [], byId: new Map(),
    roads: { edges:[], edgeKeys:new Set(), edgeByKey:new Map(),
             roadCells:new Set(), trunkCells:new Set() },
    roundabouts: [],
    roadGraph:   { nodes:[], adj:new Map() },
    feederGraph: { nodes:[], adj:new Map(), nEdges:0 },
    waterGraph:  { nodes:[], adj:new Map(), lanes:[], laneKeys:new Set() },
  };
  S.agents = [];
  resetChunks(p);      // restarts the worker pipeline + clears all caches
  bootView();
}

// Center the first view on land near the origin (spiral out until the pure
// elevation field rises above sea level).
function bootView(){
  const sea = S.params.sea;
  let cx = 0, cy = 0;
  outer:
  for(let r=0; r<=48; r++){
    for(let a=0; a<24; a++){
      const t = a/24*Math.PI*2;
      const x = Math.round(Math.cos(t)*r*128), y = Math.round(Math.sin(t)*r*128);
      if(elevationAt(x,y) > sea+0.03){ cx=x; cy=y; break outer; }
    }
  }
  S.view.scale = 0.45;
  S.view.x = canvas.clientWidth/2 - cx*S.view.scale;
  S.view.y = canvas.clientHeight/2 - cy*S.view.scale;
}

//--------------------------------------------------------------------------
// Interaction: pan / zoom / hover — unified Pointer Events so touch gets full
// parity with the mouse: one finger drags to pan, two fingers pinch to zoom,
// a quick tap inspects like a hover. (Canvas has `touch-action: none`.)
//--------------------------------------------------------------------------
const pointers = new Map();      // pointerId -> [x,y] canvas-relative
let panning = false, last = [0, 0];
let pinch = null;                // { dist, x, y } mid-point anchor while zooming
let tapStart = null;             // { t, x, y } for tap-vs-drag discrimination
const TAP_MS = 350, TAP_SLOP = 8;

const relPt = e => {
  const r = canvas.getBoundingClientRect();
  return [e.clientX-r.left, e.clientY-r.top];
};
const pinchSpan = () => {
  const [[ax,ay],[bx,by]] = [...pointers.values()];
  return Math.hypot(ax-bx, ay-by);
};
const pinchMid = () => {
  const [[ax,ay],[bx,by]] = [...pointers.values()];
  return [(ax+bx)/2, (ay+by)/2];
};

function zoomAt(mx, my, f){
  const [wx,wy] = screenToWorld(mx,my);
  S.view.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, S.view.scale*f));
  S.view.x = mx - wx*S.view.scale; S.view.y = my - wy*S.view.scale;
  dirty = true;
}

canvas.addEventListener('pointerdown', e=>{
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, relPt(e));
  if(pointers.size === 1){
    panning = true; last = relPt(e);
    tapStart = { t: performance.now(), x: last[0], y: last[1] };
    canvas.classList.add('dragging');
  } else if(pointers.size === 2){
    panning = false;                       // second finger: switch to pinch
    tapStart = null;
    const [x,y] = pinchMid();
    pinch = { dist: pinchSpan(), x, y };
  }
});

canvas.addEventListener('pointermove', e=>{
  const pt = relPt(e);
  if(!pointers.has(e.pointerId)){ if(e.pointerType==='mouse') updateTip(e); return; }
  pointers.set(e.pointerId, pt);
  if(pinch && pointers.size >= 2){
    // pan follows the midpoint, zoom anchors the world point under it
    const [mx,my] = pinchMid();
    S.view.x += mx-pinch.x; S.view.y += my-pinch.y;
    zoomAt(mx, my, pinchSpan()/pinch.dist);
    pinch = { dist: pinchSpan(), x: mx, y: my };
  } else if(panning && pointers.size === 1){
    S.view.x += pt[0]-last[0]; S.view.y += pt[1]-last[1];
    last = pt; dirty = true;
  }
  if(e.pointerType==='mouse') updateTip(e);
});

function releasePointer(e){
  pointers.delete(e.pointerId);
  const remaining = [...pointers.values()];
  if(pinch && remaining.length < 2) pinch = null;
  // lifting one finger of a pinch hands control back to the other
  if(remaining.length === 1){ panning = true; last = remaining[0]; }
  if(remaining.length === 0){
    panning = false;
    canvas.classList.remove('dragging');
    if(tapStart && e.type === 'pointerup'){
      const pt = relPt(e);
      const dx = pt[0]-tapStart.x, dy = pt[1]-tapStart.y;
      if(performance.now()-tapStart.t < TAP_MS && Math.hypot(dx,dy) < TAP_SLOP)
        showTapTip(e);                        // a tap acts as a transient hover
    }
    tapStart = null;
  }
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('contextmenu', e=>e.preventDefault());

// Touch has no persistent hover: show the inspection tooltip on tap, then fade
const tip = $('tip');
let tipTimer = 0;
function showTapTip(e){
  updateTip(e);
  tip.classList.remove('fade');
  clearTimeout(tipTimer);
  tipTimer = setTimeout(()=>tip.classList.add('fade'), 4000);
}

canvas.addEventListener('wheel', e=>{
  e.preventDefault();
  const r = canvas.getBoundingClientRect(); const mx=e.clientX-r.left, my=e.clientY-r.top;
  const f = e.deltaY<0 ? 1.12 : 1/1.12;
  zoomAt(mx, my, f);
}, { passive:false });

const TIER_NAME = ['village','town','city'];
function updateTip(e){
  if(!S.world) return;
  const r = canvas.getBoundingClientRect();
  const [fx,fy] = screenToWorld(e.clientX-r.left, e.clientY-r.top);
  let head = '';
  let near=null, nd=Infinity;   // nearest named settlement, within a screen-ish radius
  for(const s of S.world.settlements){
    const d = Math.hypot(s.x-fx, s.y-fy);
    if(d<nd){ nd=d; near=s; }
  }
  if(near && nd < Math.max(10, 22/S.view.scale))
    head = `${near.name} · ${TIER_NAME[near.tier]}\n`;
  const { b, e:el } = refineFineBiome(fx,fy);
  const cx=Math.floor(fx/CHUNK), cy=Math.floor(fy/CHUNK);
  tip.textContent =
    `${head}world ${fx.toFixed(0)},${fy.toFixed(0)} (${(fx*M_PER_FINE/1000).toFixed(1)}, ${(fy*M_PER_FINE/1000).toFixed(1)} km) chunk ${cx},${cy}\n` +
    `${NAME[b]}  elev ${el.toFixed(2)}`;
}

//--------------------------------------------------------------------------
// UI wiring
//--------------------------------------------------------------------------
const bind = (id,lbl,fn) => { const el=$(id);
  el.addEventListener('input', ()=>{ $(lbl).textContent = fn ? fn(el.value) : el.value; }); };
bind('sea','seaLbl'); bind('mtn','mtnLbl'); bind('riv','rivLbl');
bind('setn','setLbl', v => `${v}%`);

const togWrap = $('toggles');
Object.keys(S.layers).forEach(k=>{
  const lab = document.createElement('label');
  lab.innerHTML = `<input type="checkbox" ${S.layers[k]?'checked':''}/> ${k}`;
  togWrap.appendChild(lab);
  lab.querySelector('input').addEventListener('change', ev=>{
    S.layers[k] = ev.target.checked;
    if(k==='farmland'){ setFarmland(ev.target.checked); dirty = true; }
    dirty = true;
  });
});

const legend = $('legend');
[B.OCEAN,B.BEACH,B.GRASSLAND,B.FOREST,B.RAINFOREST,B.TAIGA,B.TUNDRA,B.DESERT,B.MOUNTAIN,B.SNOW,B.RIVER,B.LAKE,B.SWAMP,B.FARMLAND]
  .forEach(b=>{ const sw=document.createElement('div'); sw.className='sw'; sw.style.background=COLOR[b];
    const t=document.createElement('div'); t.textContent=NAME[b]; legend.appendChild(sw); legend.appendChild(t); });

$('gen').addEventListener('click', ()=>initWorld(readParams()));
$('rnd').addEventListener('click', ()=>{ $('seed').value = Math.random().toString(36).slice(2,9); initWorld(readParams()); });
window.addEventListener('resize', ()=>{ dirty = true; });

//--------------------------------------------------------------------------
// Small-screen UX: collapsible panel (button shown via CSS media query)
//--------------------------------------------------------------------------
const panel = $('panel');
const panelToggle = $('panelToggle');
panelToggle.addEventListener('click', ()=>{
  const open = panel.classList.toggle('open');
  panelToggle.setAttribute('aria-expanded', String(open));
});

//--------------------------------------------------------------------------
// Animation loop: keep the skeleton streamed under the viewport, extend the
// road/lane networks into fresh ground, maintain agents near the view.
//--------------------------------------------------------------------------
let lastT = performance.now(), statTimer = 0;
function loop(now){
  const dt = Math.min(50, (now-lastT))/16.67; lastT = now;
  requestAnimationFrame(loop);
  if(!S.world) return;

  const [wx0,wy0,wx1,wy1] = viewportRect();
  updateStreaming(wx0, wy0, wx1, wy1);

  // network growth works in coarse cells
  const gx0=Math.floor(wx0/COARSE_SCALE), gy0=Math.floor(wy0/COARSE_SCALE);
  const gx1=Math.ceil(wx1/COARSE_SCALE), gy1=Math.ceil(wy1/COARSE_SCALE);
  let built = ensureRoads(gx0, gy0, gx1, gy1);
  ensureLanes(gx0, gy0, gx1, gy1);

  const animating = (S.layers.vehicles||S.layers.boats||S.layers.peds) && S.agents.length;
  maintainAgents(dt, wx0, wy0, wx1, wy1);
  if(animating || S.agents.length) stepAgents(dt);

  statTimer -= dt;
  if(statTimer <= 0){ statTimer = 60; updateStats(); }

  if(dirty || built || animating){ dirty = false; draw(); }
}

function updateStats(){
  const st = streamStats();
  const w = S.world;
  const laid = w.roads.edges.filter(e=>e.path).length;
  const c = {0:0,1:0,2:0}; w.settlements.forEach(s=>c[s.tier]++);
  const modes = {vehicle:0,boat:0,ped:0}; S.agents.forEach(a=>modes[a.mode]++);
  $('stat').textContent =
    `${st.tiles} tiles · ${st.overviews} overviews streamed (${st.pending} in flight)\n` +
    `${w.settlements.length} places: ${c[2]} cities, ${c[1]} towns, ${c[0]} villages · ${laid} roads · ${st.regions} regions\n` +
    `${S.agents.length} agents: ${modes.vehicle} vehicles · ${modes.boat} boats · ${modes.ped} hikers · ` +
    `scale ${(M_PER_FINE*S.view.scale).toFixed(1)} m/px`;
}

//--------------------------------------------------------------------------
// Boot
//--------------------------------------------------------------------------
const urlSeed = new URLSearchParams(location.search).get('seed');
if(urlSeed) $('seed').value = urlSeed;
initWorld(readParams());
requestAnimationFrame(loop);
window.__S = S;   // debug/inspection handle
