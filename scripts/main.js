// Entry point: wires UI controls, interaction (pan/zoom/hover), the generation
// pipeline, and the animation loop.

import { B, COLOR, NAME } from './biomes.js';
import { S, CHUNK, COARSE_SCALE, M_PER_FINE, worldFineW, worldFineH } from './state.js';
import { generateCoarse } from './coarse.js';
import { buildRoads } from './roads.js';
import { buildWaterways, buildFeederGraph } from './navigation.js';
import { spawnAgents, stepAgents } from './agents.js';
import { refineFineBiome } from './fields.js';
import { initRenderer, getCanvas, draw, screenToWorld } from './render.js';
import { resetChunks, setChunkReadyCallback } from './chunks.js';

const $ = id => document.getElementById(id);

initRenderer($('c'));
const canvas = getCanvas();

// When the worker finishes a chunk, coalesce redraws into the next animation frame.
let redrawQueued = false;
setChunkReadyCallback(() => {
  if(redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; draw(); });
});

//--------------------------------------------------------------------------
// Generation pipeline
//--------------------------------------------------------------------------
function readParams(){
  return {
    seed: $('seed').value || 'seed',
    sea: +$('sea').value, mtn: +$('mtn').value,
    riverThresh: +$('riv').value, nSettle: +$('setn').value,
    worldSize: +$('worldSz').value
  };
}

function regenerate(){
  const p = readParams(); const t0 = performance.now();
  const url = new URL(location.href);
  url.searchParams.set('seed', p.seed);
  history.replaceState(null, '', url);
  generateCoarse(p);
  buildRoads();
  buildWaterways();
  buildFeederGraph();   // pedestrian network: feeder-road spurs only
  spawnAgents();
  resetChunks();   // ship the fresh coarse skeleton to the chunk worker + clear cache
  const t1 = performance.now();
  const c = {0:0,1:0,2:0}; S.world.settlements.forEach(s=>c[s.tier]++);
  const modes = {vehicle:0,boat:0,ped:0}; S.agents.forEach(a=>modes[a.mode]++);
  const WFX = worldFineW();
  const km = WFX*M_PER_FINE/1000;
  $('stat').textContent =
    `skeleton ${(t1-t0).toFixed(0)}ms · coarse ${S.GW}×${S.GH} → ${WFX}×${WFX} fine cells\n` +
    `${c[2]} cities, ${c[1]} towns, ${c[0]} villages · ${S.world.roads.edges.length} roads · ${S.world.waterGraph?.lanes.length||0} sea lanes\n` +
    `${S.agents.length} agents: ${modes.vehicle} vehicles · ${modes.boat} boats · ${modes.ped} hikers · ` +
    `scale ${M_PER_FINE} m/cell · world ${km.toFixed(0)} km across`;
  draw();
}

function fit(){
  const WFX = worldFineW(); const s = Math.min(canvas.clientWidth, canvas.clientHeight)/WFX*0.95;
  S.view.scale = s;
  S.view.x = (canvas.clientWidth - WFX*s)/2;
  S.view.y = (canvas.clientHeight - worldFineH()*s)/2;
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
  S.view.scale = Math.max(0.08, Math.min(30, S.view.scale*f));
  S.view.x = mx - wx*S.view.scale; S.view.y = my - wy*S.view.scale;
  draw();
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
    last = pt; draw();
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
  if(fx<0||fy<0||fx>=worldFineW()||fy>=worldFineH()){ tip.textContent='—'; return; }
  let head = '';
  let near=null, nd=Infinity;   // nearest named settlement, within a screen-ish radius
  for(const s of S.world.settlements){
    const d = Math.hypot(s.x-fx, s.y-fy);
    if(d<nd){ nd=d; near=s; }
  }
  if(near && nd < Math.max(10, 22/S.view.scale))
    head = `${near.name} · ${TIER_NAME[near.tier]}\n`;
  const { b, e:el } = refineFineBiome(fx,fy);
  const cx=(fx/CHUNK)|0, cy=(fy/CHUNK)|0;
  tip.textContent =
    `${head}world ${fx.toFixed(0)},${fy.toFixed(0)} (${(fx*M_PER_FINE/1000).toFixed(1)}, ${(fy*M_PER_FINE/1000).toFixed(1)} km) chunk ${cx},${cy}\n` +
    `${NAME[b]}  elev ${el.toFixed(2)}`;
}

//--------------------------------------------------------------------------
// UI wiring
//--------------------------------------------------------------------------
const bind = (id,lbl,fn) => { const el=$(id);
  el.addEventListener('input', ()=>{ $(lbl).textContent = fn ? fn(el.value) : el.value; }); };
bind('sea','seaLbl'); bind('mtn','mtnLbl'); bind('riv','rivLbl'); bind('setn','setLbl');
bind('worldSz','worldLbl', v => `${v} · ${(v*COARSE_SCALE*M_PER_FINE/1000).toFixed(0)} km`);

const togWrap = $('toggles');
Object.keys(S.layers).forEach(k=>{
  const lab = document.createElement('label');
  lab.innerHTML = `<input type="checkbox" ${S.layers[k]?'checked':''}/> ${k}`;
  togWrap.appendChild(lab);
  lab.querySelector('input').addEventListener('change', ev=>{
    S.layers[k] = ev.target.checked;
    if(k==='farmland') resetChunks();   // farmland is baked into chunk bitmaps (worker)
    draw();
  });
});

const legend = $('legend');
[B.OCEAN,B.BEACH,B.GRASSLAND,B.FOREST,B.RAINFOREST,B.TAIGA,B.TUNDRA,B.DESERT,B.MOUNTAIN,B.SNOW,B.RIVER,B.LAKE,B.SWAMP,B.FARMLAND]
  .forEach(b=>{ const sw=document.createElement('div'); sw.className='sw'; sw.style.background=COLOR[b];
    const t=document.createElement('div'); t.textContent=NAME[b]; legend.appendChild(sw); legend.appendChild(t); });

$('gen').addEventListener('click', regenerate);
$('rnd').addEventListener('click', ()=>{ $('seed').value = Math.random().toString(36).slice(2,9); regenerate(); });
window.addEventListener('resize', draw);

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
// Animation loop
//--------------------------------------------------------------------------
let lastT = performance.now();
function loop(now){
  const dt = Math.min(50, (now-lastT))/16.67; lastT = now;
  if((S.layers.vehicles||S.layers.boats||S.layers.peds) && S.agents.length){ stepAgents(dt); draw(); }
  requestAnimationFrame(loop);
}

// boot
const urlSeed = new URLSearchParams(location.search).get('seed');
if(urlSeed) $('seed').value = urlSeed;
fit(); regenerate(); requestAnimationFrame(loop);
window.__S = S;   // debug/inspection handle
