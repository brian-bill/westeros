// Entry point: wires UI controls, interaction (pan/zoom/hover), the generation
// pipeline, and the animation loop.

import { B, COLOR, NAME } from './biomes.js';
import { S, CHUNK, worldFineW, worldFineH } from './state.js';
import { generateCoarse } from './coarse.js';
import { buildRoads } from './roads.js';
import { spawnAgents, stepAgents } from './agents.js';
import { refineFineBiome } from './fields.js';
import { initRenderer, getCanvas, draw, screenToWorld } from './render.js';

const $ = id => document.getElementById(id);

initRenderer($('c'));
const canvas = getCanvas();

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
  S.chunks.clear();
  generateCoarse(p);
  buildRoads();
  spawnAgents();
  const t1 = performance.now();
  const c = {0:0,1:0,2:0}; S.world.settlements.forEach(s=>c[s.tier]++);
  const WFX = worldFineW();
  $('stat').textContent =
    `skeleton ${(t1-t0).toFixed(0)}ms · coarse ${S.GW}×${S.GH} → ${WFX}×${WFX} fine cells\n` +
    `${c[2]} cities, ${c[1]} towns, ${c[0]} villages · ${S.world.roads.edges.length} roads · ${S.agents.length} agents`;
  draw();
}

function fit(){
  const WFX = worldFineW(); const s = Math.min(canvas.clientWidth, canvas.clientHeight)/WFX*0.95;
  S.view.scale = s;
  S.view.x = (canvas.clientWidth - WFX*s)/2;
  S.view.y = (canvas.clientHeight - worldFineH()*s)/2;
}

//--------------------------------------------------------------------------
// Interaction: pan / zoom / hover
//--------------------------------------------------------------------------
let dragging=false, last={x:0,y:0};
canvas.addEventListener('mousedown', e=>{ dragging=true; last={x:e.clientX,y:e.clientY}; canvas.classList.add('dragging'); });
window.addEventListener('mouseup', ()=>{ dragging=false; canvas.classList.remove('dragging'); });
window.addEventListener('mousemove', e=>{
  if(dragging){ S.view.x += e.clientX-last.x; S.view.y += e.clientY-last.y;
    last={x:e.clientX,y:e.clientY}; draw(); }
  updateTip(e);
});
canvas.addEventListener('wheel', e=>{
  e.preventDefault();
  const r = canvas.getBoundingClientRect(); const mx=e.clientX-r.left, my=e.clientY-r.top;
  const [wx,wy] = screenToWorld(mx,my); const f = e.deltaY<0 ? 1.12 : 1/1.12;
  S.view.scale = Math.max(0.08, Math.min(30, S.view.scale*f));
  S.view.x = mx - wx*S.view.scale; S.view.y = my - wy*S.view.scale; draw();
}, { passive:false });

const tip = $('tip');
function updateTip(e){
  if(!S.world) return;
  const r = canvas.getBoundingClientRect();
  const [fx,fy] = screenToWorld(e.clientX-r.left, e.clientY-r.top);
  if(fx<0||fy<0||fx>=worldFineW()||fy>=worldFineH()){ tip.textContent='—'; return; }
  const { b, e:el } = refineFineBiome(fx,fy);
  const cx=(fx/CHUNK)|0, cy=(fy/CHUNK)|0;
  tip.textContent = `world ${fx.toFixed(0)},${fy.toFixed(0)}  chunk ${cx},${cy}\n${NAME[b]}  elev ${el.toFixed(2)}`;
}

//--------------------------------------------------------------------------
// UI wiring
//--------------------------------------------------------------------------
const bind = (id,lbl,fn) => { const el=$(id);
  el.addEventListener('input', ()=>{ $(lbl).textContent = fn ? fn(el.value) : el.value; }); };
bind('sea','seaLbl'); bind('mtn','mtnLbl'); bind('riv','rivLbl'); bind('setn','setLbl'); bind('worldSz','worldLbl');

const togWrap = $('toggles');
Object.keys(S.layers).forEach(k=>{
  const lab = document.createElement('label');
  lab.innerHTML = `<input type="checkbox" ${S.layers[k]?'checked':''}/> ${k}`;
  togWrap.appendChild(lab);
  lab.querySelector('input').addEventListener('change', ev=>{
    S.layers[k] = ev.target.checked;
    if(k==='farmland') S.chunks.clear();   // farmland is baked into chunk bitmaps
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
// Animation loop
//--------------------------------------------------------------------------
let lastT = performance.now();
function loop(now){
  const dt = Math.min(50, (now-lastT))/16.67; lastT = now;
  if(S.layers.agents && S.agents.length){ stepAgents(dt); draw(); }
  requestAnimationFrame(loop);
}

// boot
fit(); regenerate(); requestAnimationFrame(loop);
