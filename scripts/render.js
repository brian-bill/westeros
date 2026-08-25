// Viewport-driven rendering: stream visible chunks, draw road/building/settlement/
// agent overlays, apply level-of-detail (LOD) based on zoom.

import { S, CHUNK, COARSE_SCALE, worldFineW, worldFineH } from './state.js';
import { getChunk, evictChunks } from './chunks.js';
import { ensureSettlementDetail } from './settlementDetail.js';
import { agentPos } from './agents.js';

let canvas, ctx;
export function initRenderer(cnv){ canvas = cnv; ctx = cnv.getContext('2d'); }
export function getCanvas(){ return canvas; }

export function screenToWorld(sx, sy){
  return [(sx-S.view.x)/S.view.scale, (sy-S.view.y)/S.view.scale];
}

export function draw(){
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  canvas.width = cw*dpr; canvas.height = ch*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#0a0d11'; ctx.fillRect(0,0,cw,ch);
  if(!S.world) return;
  const { view, layers } = S;
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale);

  // visible fine-world rect -> chunk range
  const [wx0,wy0] = screenToWorld(0,0), [wx1,wy1] = screenToWorld(cw,ch);
  const WFX = worldFineW(), WFY = worldFineH();
  const minCX = Math.max(0, Math.floor(wx0/CHUNK)), maxCX = Math.min(Math.ceil(WFX/CHUNK)-1, Math.floor(wx1/CHUNK));
  const minCY = Math.max(0, Math.floor(wy0/CHUNK)), maxCY = Math.min(Math.ceil(WFY/CHUNK)-1, Math.floor(wy1/CHUNK));

  let drawn = 0;
  if(layers.terrain){
    for(let cy=minCY;cy<=maxCY;cy++) for(let cx=minCX;cx<=maxCX;cx++){
      const c = getChunk(cx,cy); ctx.drawImage(c.bmp, cx*CHUNK, cy*CHUNK); drawn++;
    }
  }
  evictChunks();

  // roads (coarse cell paths -> fine world polylines)
  if(layers.roads && S.world.roads){
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.strokeStyle='rgba(60,45,30,0.9)'; ctx.lineWidth=Math.max(0.6,1.6);
    for(const e of S.world.roads.edges){
      ctx.beginPath();
      for(let k=0;k<e.path.length;k++){ const ci=e.path[k];
        const x=((ci%S.GW)+0.5)*COARSE_SCALE, y=((ci/S.GW|0)+0.5)*COARSE_SCALE;
        if(k===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
      ctx.stroke();
    }
  }

  // LOD: streets + buildings when zoomed in
  const detail = view.scale >= 3;
  if(detail && layers.buildings){
    for(const s of S.world.settlements){
      if(s.x<wx0-60||s.x>wx1+60||s.y<wy0-60||s.y>wy1+60) continue;
      ensureSettlementDetail(s);
      ctx.strokeStyle='rgba(70,60,45,0.55)'; ctx.lineWidth=0.5; ctx.lineCap='round';
      for(const [[ax,ay],[bx,by]] of s.streets){ ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.stroke(); }
      for(const b of s.buildings){
        ctx.save(); ctx.translate(b.x,b.y); ctx.rotate(b.rot);
        ctx.fillStyle=b.big?'#8a8079':'#6f5a48'; ctx.strokeStyle='#33281f'; ctx.lineWidth=0.15;
        ctx.fillRect(-b.w/2,-b.h/2,b.w,b.h); ctx.strokeRect(-b.w/2,-b.h/2,b.w,b.h); ctx.restore();
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

  // agents
  if(layers.agents && S.agents.length){
    for(const a of S.agents){ const [x,y]=agentPos(a);
      if(x<wx0-20||x>wx1+20||y<wy0-20||y>wy1+20) continue;
      ctx.fillStyle=a.color; ctx.strokeStyle='#000'; ctx.lineWidth=0.2;
      ctx.beginPath(); ctx.arc(x,y,1.4,0,7); ctx.fill(); ctx.stroke(); }
  }

  ctx.restore();
  window.__stats = { drawn, cached:S.chunks.size };
}
