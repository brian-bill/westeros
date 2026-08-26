// Viewport-driven rendering across three regimes selected by zoom:
//   fine chunks   — streamed ImageBitmaps, LOD tiers by screen px per chunk;
//   coarse tiles  — one small canvas per mega-tile, stretched;
//   overview      — cheap pure-field tiles for planetary zoom-out.
// Road/building/settlement/agent/label overlays draw on top in world space at
// every regime; labels are placed in SCREEN space so they stay legible.

import { S, CHUNK, COARSE_SCALE, TILE, OTILE,
         SCALE_CHUNK_MIN, SCALE_OVERVIEW_MAX } from './state.js';
import { getChunk, evictChunks, cachedChunkCount } from './chunks.js';
import { getTileBitmap, getOverviewBitmap, provisionalColor, regionsList } from './worldTiles.js';
import { ensureSettlementDetail, ARCH } from './settlementDetail.js';
import { agentPos, agentTangent } from './agents.js';

let canvas, ctx;
export function initRenderer(cnv){ canvas = cnv; ctx = cnv.getContext('2d'); }
export function getCanvas(){ return canvas; }

export function screenToWorld(sx, sy){
  return [(sx-S.view.x)/S.view.scale, (sy-S.view.y)/S.view.scale];
}

// Visible fine-world rect (used by the streaming maintainer too).
export function viewportRect(){
  return [...screenToWorld(0,0), ...screenToWorld(canvas.clientWidth, canvas.clientHeight)];
}

export function draw(){
  // Cap the backing-store ratio at 2: phones reporting 3x gain nothing visible
  // but pay heavily in fragment-fill cost on every frame.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  // Only resize the backing store when it actually changes: assigning width/height
  // clears the whole canvas, and doing it every frame causes visible flicker.
  const bw = cw*dpr, bh = ch*dpr;
  if(canvas.width !== bw || canvas.height !== bh){ canvas.width = bw; canvas.height = bh; }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#0a0d11'; ctx.fillRect(0,0,cw,ch);
  if(!S.world) return;
  const { view, layers } = S;

  // visible fine-world rect -> source ranges (unbounded world: no clamps)
  const [wx0,wy0] = screenToWorld(0,0), [wx1,wy1] = screenToWorld(cw,ch);

  // Terrain is drawn in SCREEN space with device-pixel-snapped edges:
  // adjacent bitmaps then share exact boundary coordinates, which kills the
  // hairline seams fractional world-transform scaling otherwise leaves.
  // Overlays below re-apply the world transform.
  const s2x = wx => wx*view.scale + view.x;
  const s2y = wy => wy*view.scale + view.y;

  let drawn = 0, pending = 0, regime = 'chunk';
  if(layers.terrain){
    if(view.scale >= SCALE_CHUNK_MIN){
      // ---- fine chunks (full-resolution tier) ---------------------------
      regime = 'chunk';
      // minified chunks: bilinear blends neighbouring bitmaps
      ctx.imageSmoothingEnabled = view.scale < 1;
      const minCX = Math.floor(wx0/CHUNK), maxCX = Math.floor(wx1/CHUNK);
      const minCY = Math.floor(wy0/CHUNK), maxCY = Math.floor(wy1/CHUNK);
      for(let cy=minCY;cy<=maxCY;cy++) for(let cx=minCX;cx<=maxCX;cx++){
        const sx = Math.round(s2x(cx*CHUNK)), sy = Math.round(s2y(cy*CHUNK));
        const sw = Math.round(s2x((cx+1)*CHUNK)) - sx, sh = Math.round(s2y((cy+1)*CHUNK)) - sy;
        const c = getChunk(cx,cy,0);
        if(c){ ctx.drawImage(c.bmp, sx, sy, sw, sh); drawn++; }
        else {
          ctx.fillStyle = provisionalColor((cx+0.5)*CHUNK, (cy+0.5)*CHUNK, 'c:'+cx+','+cy);
          ctx.fillRect(sx, sy, sw, sh); pending++;
        }
      }
      ctx.imageSmoothingEnabled = false;
    } else if(view.scale >= SCALE_OVERVIEW_MAX){
      // ---- mega-tile bitmaps -------------------------------------------
      regime = 'tile';
      const T = TILE*COARSE_SCALE;
      ctx.imageSmoothingEnabled = true;   // coarse texels are sub-pixel here
      const minTX = Math.floor(wx0/T), maxTX = Math.floor(wx1/T);
      const minTY = Math.floor(wy0/T), maxTY = Math.floor(wy1/T);
      for(let ty=minTY;ty<=maxTY;ty++) for(let tx=minTX;tx<=maxTX;tx++){
        const sx = Math.round(s2x(tx*T)), sy = Math.round(s2y(ty*T));
        const sw = Math.round(s2x((tx+1)*T)) - sx, sh = Math.round(s2y((ty+1)*T)) - sy;
        const bmp = getTileBitmap(tx,ty);
        if(bmp){ ctx.drawImage(bmp, sx, sy, sw, sh); drawn++; }
        else {
          ctx.fillStyle = provisionalColor((tx+0.5)*T, (ty+0.5)*T, 't:'+tx+','+ty);
          ctx.fillRect(sx, sy, sw, sh); pending++;
        }
      }
      ctx.imageSmoothingEnabled = false;
    } else {
      // ---- overview tiles ------------------------------------------------
      regime = 'overview';
      const E = OTILE*COARSE_SCALE;
      ctx.imageSmoothingEnabled = true;
      const minOX = Math.floor(wx0/E), maxOX = Math.floor(wx1/E);
      const minOY = Math.floor(wy0/E), maxOY = Math.floor(wy1/E);
      for(let oy=minOY;oy<=maxOY;oy++) for(let ox=minOX;ox<=maxOX;ox++){
        const sx = Math.round(s2x(ox*E)), sy = Math.round(s2y(oy*E));
        const sw = Math.round(s2x((ox+1)*E)) - sx, sh = Math.round(s2y((oy+1)*E)) - sy;
        const bmp = getOverviewBitmap(ox,oy);
        if(bmp){ ctx.drawImage(bmp, sx, sy, sw, sh); drawn++; }
        else { ctx.fillStyle = '#101722'; ctx.fillRect(sx, sy, sw, sh); pending++; }
      }
      ctx.imageSmoothingEnabled = false;
    }
  }
  evictChunks();

  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale);

  // roads — two visual classes: wide dark trunk highways and thin faint
  // village feeder spurs; paths are world-space cell pair polylines
  if(layers.roads && S.world.roads){
    ctx.lineCap='round'; ctx.lineJoin='round';
    const cellPt = c => [(c[0]+0.5)*COARSE_SCALE, (c[1]+0.5)*COARSE_SCALE];
    for(const e of S.world.roads.edges){
      if(!e.path) continue;
      const hi = e.cls !== 'feeder';
      ctx.strokeStyle = hi ? 'rgba(58,45,30,0.95)' : 'rgba(80,66,48,0.5)';
      ctx.lineWidth = hi ? 1.7 : 0.85;
      ctx.beginPath();
      for(let k=0;k<e.path.length;k++){ const [x,y]=cellPt(e.path[k]);
        if(k===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
      ctx.stroke();
    }

    // bridge siderails: paired lines flanking the roadway wherever it runs
    // over water (spans precomputed in roads.js as world-space polylines)
    for(const e of S.world.roads.edges){
      if(!e.path || !e.bridges || !e.bridges.length) continue;
      const hi = e.cls !== 'feeder';
      const off = hi ? 1.05 : 0.65;   // just outside the carriageway edge
      ctx.strokeStyle = 'rgba(139,109,59,0.95)';
      ctx.lineWidth = Math.max(0.2, (hi?1.7:0.85)*0.18);
      for(const pts of e.bridges){
        for(const side of [-1,1]){
          ctx.beginPath();
          pts.forEach(([x,y],k)=>{
            const p0=pts[Math.max(0,k-1)], p1=pts[Math.min(pts.length-1,k+1)];
            const dx=p1[0]-p0[0], dy=p1[1]-p0[1], l=Math.hypot(dx,dy)||1;
            k ? ctx.lineTo(x-dy/l*off*side, y+dx/l*off*side)
              : ctx.moveTo(x-dy/l*off*side, y+dx/l*off*side);
          });
          ctx.stroke();
        }
      }
    }

    // roundabouts: grassy islands ringed by road where routes cross
    for(const r of S.world.roundabouts || []){
      ctx.beginPath(); ctx.arc(r.x, r.y, 1.15, 0, 7);
      ctx.fillStyle = '#7d9c58'; ctx.fill();
      ctx.lineWidth = 0.55; ctx.strokeStyle = 'rgba(58,45,30,0.95)'; ctx.stroke();
    }
  }

  // LOD: streets + buildings when zoomed in
  const detail = view.scale >= 3;
  if(detail && layers.buildings){
    for(const s of S.world.settlements){
      if(s.x<wx0-60||s.x>wx1+60||s.y<wy0-60||s.y>wy1+60) continue;
      ensureSettlementDetail(s);
      // streets are polylines: straight 2-point segments (city grid) or
      // multi-point curves (organic villages, wobbled towns)
      ctx.strokeStyle='rgba(70,60,45,0.55)'; ctx.lineWidth=0.5;
      ctx.lineCap='round'; ctx.lineJoin='round';
      for(const line of s.streets){
        ctx.beginPath();
        line.forEach(([x,y],i)=> i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
        ctx.stroke();
      }
      const st = ARCH[s.style] || ARCH.thatch;   // biome-aware architecture
      for(const b of s.buildings){
        ctx.save(); ctx.translate(b.x,b.y); ctx.rotate(b.rot);
        ctx.fillStyle=b.big?'#8a8079':st.wall; ctx.strokeStyle=b.big?'#33281f':st.trim;
        ctx.lineWidth=0.15;
        ctx.fillRect(-b.w/2,-b.h/2,b.w,b.h); ctx.strokeRect(-b.w/2,-b.h/2,b.w,b.h);
        if(st.pitched){                          // gabled roof: ridge along the long axis
          ctx.strokeStyle=st.roof; ctx.lineWidth=Math.max(0.3,b.h*0.34); ctx.lineCap='round';
          ctx.beginPath(); ctx.moveTo(-b.w*0.32,0); ctx.lineTo(b.w*0.32,0); ctx.stroke();
        } else {                                 // flat roof: parapet inset
          ctx.strokeStyle=st.roof; ctx.lineWidth=0.12;
          ctx.strokeRect(-b.w*0.32,-b.h*0.32,b.w*0.64,b.h*0.64);
        }
        ctx.restore();
      }
    }
  }

  // settlement markers
  if(layers.settlements){
    for(const s of S.world.settlements){
      if(s.x<wx0-40||s.x>wx1+40||s.y<wy0-40||s.y>wy1+40) continue;
      const size=[1.6,2.6,3.8][s.tier]*(COARSE_SCALE*0.35), col=['#f2d94e','#f28c28','#e8443b'][s.tier];
      ctx.globalAlpha=detail?0.5:1; ctx.fillStyle=col; ctx.strokeStyle='#1a1200'; ctx.lineWidth=0.6;
      ctx.beginPath(); ctx.arc(s.x,s.y,detail?size*0.5:size,0,7); ctx.fill(); ctx.stroke(); ctx.globalAlpha=1;
    }
  }

  // agents, per movement mode: vehicles on roads (colored dots), boats on
  // water (oriented hulls), hikers on feeder-road sidewalks (tiny dark dots,
  // only worth drawing once a fine cell is several screen px). Hikers mid-trip
  // in a vehicle are drawn as ordinary traffic on the vehicles layer.
  if((layers.vehicles||layers.boats||layers.peds) && S.agents.length){
    for(const a of S.agents){
      const kind = a.stages[a.si].kind;
      const layer = a.mode==='boat' ? layers.boats
                  : kind==='ride' ? layers.vehicles : layers.peds;
      if(!layer || (kind==='walk' && view.scale<0.45)) continue;
      const [x,y]=agentPos(a);
      if(x<wx0-20||x>wx1+20||y<wy0-20||y>wy1+20) continue;
      if(a.mode==='boat'){
        // hull: pointed bow toward the direction of travel, ~1-2 cells long
        const [tx,ty]=agentTangent(a);
        ctx.save(); ctx.translate(x,y); ctx.rotate(Math.atan2(ty,tx));
        const L=detail?1.0:1.6, W=L*0.36;
        ctx.fillStyle=a.color; ctx.strokeStyle='rgba(15,22,28,0.8)';
        ctx.lineWidth=detail?0.12:0.2;
        ctx.beginPath(); ctx.moveTo(L*0.6,0); ctx.lineTo(-L*0.4,W); ctx.lineTo(-L*0.4,-W);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.strokeRect(-L*0.18,-W*0.55,L*0.36,W*1.1);   // deckhouse
        ctx.restore();
      } else {
        const riding = kind==='ride';
        const r = riding ? (detail?0.55:1.2) : (detail?0.3:0.55);
        ctx.fillStyle=riding?a.carColor:a.color;
        ctx.strokeStyle='#000'; ctx.lineWidth=detail?0.12:0.2;
        ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill(); ctx.stroke();
      }
    }
  }

  ctx.restore();

  // Named labels — drawn in SCREEN space after the world transform is popped,
  // so font size stays legible at any zoom. Greedy rectangle rejection stops
  // labels from overprinting: cities claim space first, then
  // towns/villages/regions fit in wherever there's room.
  if(layers.labels && S.world.settlements){
    const rects = [];
    const fits = (x,y,w,h)=>{ for(const r of rects)
      if(x<r.x+r.w && x+w>r.x && y<r.y+r.h && y+h>r.y) return false; return true; };
    const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
    const put = (text, sx, sy, fs, font, fill, alpha=1, pad=2) => {
      ctx.font = font;
      const w = ctx.measureText(text).width;
      if(!fits(sx-w/2-pad, sy-fs-pad, w+pad*2, fs+pad*2)) return false;
      rects.push({ x:sx-w/2-pad, y:sy-fs-pad, w:w+pad*2, h:fs+pad*2 });
      ctx.textAlign='center'; ctx.textBaseline='alphabetic'; ctx.lineJoin='round';
      ctx.globalAlpha=alpha;
      ctx.lineWidth=Math.max(2, fs/4); ctx.strokeStyle='rgba(8,10,14,0.85)';
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle=fill; ctx.fillText(text, sx, sy);
      ctx.globalAlpha=1;
      return true;
    };

    // settlements: LOD by zoom (cities always, towns mid, villages close-up)
    const minScale = [0.9, 0.32, -1];                 // per tier: village/town/city
    for(let tier=2; tier>=0; tier--){
      if(view.scale < minScale[tier]) continue;
      const fs = [9.5, 11, 13][tier];
      for(const s of S.world.settlements){
        if(s.tier !== tier || !s.name) continue;
        const sx = s.x*view.scale + view.x, sy = s.y*view.scale + view.y;
        if(sx<-100||sx>cw+100||sy<-40||sy>ch+40) continue;
        const mr = [1.6,2.6,3.8][tier]*(COARSE_SCALE*0.35)*view.scale*(detail?0.5:1);
        put(s.name, sx, sy-mr-4, fs, `${tier===2?'bold ':''}${fs}px ${MONO}`,
            tier===2 ? '#ffe9a8' : '#f2ead8', tier===2 ? 1 : 0.92);
      }
    }

    // regions: large, quiet, all-caps italic names anchored inside landmasses
    ctx.letterSpacing = '3px';
    for(const rg of regionsList()){
      const sx = rg.x*view.scale + view.x, sy = rg.y*view.scale + view.y;
      if(sx<-200||sx>cw+200||sy<-60||sy>ch+60) continue;
      put(rg.name.toUpperCase(), sx, sy, 15, `italic 600 15px ${MONO}`,
          'rgba(240,234,214,0.78)', 0.75, 6);
    }
    ctx.letterSpacing = '0px';
  }

  window.__stats = { drawn, pending, cached:cachedChunkCount(), regime };
}
