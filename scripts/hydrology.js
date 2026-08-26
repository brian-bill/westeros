// Hydrology on a local grid (a mega-tile plus its halo). Every rule here is
// computed from RAW elevations with strictly local context, which is what
// lets independently generated tiles agree about shared borders:
//
//  - flow directions: steepest descent on raw elevation with a deterministic
//    tie-break. Two tiles evaluating neighbouring cells always derive the
//    same global flow field, because it is a pure function of elevation.
//  - rivers: non-maximum-suppressed blurred TRUNCATED accumulation — valley
//    axis detection; see riverMask for why truncation keeps it seamless.
//  - lakes: cells whose downstream chain reaches a terminal sink within R
//    steps and sit near the sink's level — see lakeMask; the old global
//    depression-fill gave each tile its own spill level and drew rectangular
//    lake edges at tile boundaries.
//
// All functions operate on typed arrays sized gw*gh and are worker-safe.

const NB8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

// D8 steepest-descent flow directions on raw elevation. Below-sea cells and
// pits (no lower neighbour) are terminals: flowTo = -1.
export function computeFlowRaw(elev, gw, gh, sea){
  const N = gw*gh;
  const flowTo = new Int32Array(N).fill(-1);
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
    const i=y*gw+x; if(elev[i]<sea) continue;
    let lowest = elev[i], best = -1;
    for(let k=0;k<8;k++){
      const nx=x+NB8[k][0], ny=y+NB8[k][1];
      if(nx<0||ny<0||nx>=gw||ny>=gh) continue;
      const j=ny*gw+nx;
      // strict `<` plus scan order = deterministic tie-break by lowest index
      if(elev[j]<lowest){ lowest=elev[j]; best=j; }
    }
    flowTo[i] = best;
  }
  return flowTo;
}

// Flow accumulation truncated at exactly R flow-distance steps: accum[i]
// counts every cell whose downstream chain reaches i within R steps. Computed
// as R rounds of "one more step" scattering over the flow field — O(R*N).
// Because the window never exceeds R = HALO cells around any point of
// interest, two tiles compute identical values near their shared border.
export function truncatedAccum(flowTo, gw, gh, sea, R){
  const N = gw*gh;
  const cur = new Float32Array(N), next = new Float32Array(N), accum = new Float32Array(N);
  for(let i=0;i<N;i++){ const v = flowTo[i]>=0 ? 1 : 0; cur[i]=v; accum[i]=v; }
  for(let r=1;r<R;r++){
    next.fill(0);
    for(let j=0;j<N;j++){
      const t = flowTo[j];
      if(cur[j]!==0 && t>=0) next[t] += cur[j];
    }
    let active = false;
    for(let i=0;i<N;i++){ cur[i]=next[i]; if(next[i]!==0){ accum[i]+=next[i]; active=true; } }
    if(!active) break;
  }
  return accum;
}

// Rivers: non-maximum-suppressed blurred accumulation above threshold —
// valley AXIS detection. Deliberately PURE and strictly local (radius
// R + blur): any two tiles evaluating neighbouring cells get identical
// answers, so networks cross tile borders seamlessly; where drainage thins,
// a line fades out and (often) resumes, identically on both sides. NMS thins
// the wet valley floors to 1-cell spines so fine rendering shows connected
// rivers rather than runoff smears.
export function riverMask(accum, gw, gh, thresh){
  const N = gw*gh;
  const blur = new Float32Array(N);
  const RB = 3;   // blur radius (7x7)
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
    let sum=0;
    for(let dy=-RB;dy<=RB;dy++) for(let dx=-RB;dx<=RB;dx++){
      const nx=x+dx, ny=y+dy;
      if(nx<0||ny<0||nx>=gw||ny>=gh) continue;
      sum += accum[ny*gw+nx];
    }
    blur[y*gw+x] = sum;
  }
  const mask = new Uint8Array(N);
  const pass = thresh*49*0.045;
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
    const i=y*gw+x;
    if(blur[i] < pass || accum[i] < 2) continue;   // real convergence only
    // valley axis: no nearby neighbour is (nearly) as wet
    let nb = 0;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      if(!dx && !dy) continue;
      const nx=x+dx, ny=y+dy;
      if(nx<0||ny<0||nx>=gw||ny>=gh) continue;
      nb = Math.max(nb, blur[ny*gw+nx]);
    }
    if(blur[i] >= nb*0.97) mask[i]=1;
  }
  return mask;
}

// Lakes, purely local: a land cell is lakebed when its downstream chain
// reaches a PIT (terminal sink) within R steps and it sits within `pool` of
// the pit's elevation — water pooling in a closed basin before spilling.
// Both conditions are R-local, so tiles agree about shared borders.
export function lakeMask(elev, flowTo, gw, gh, sea, R, pool=0.008){
  const N = gw*gh;
  const mask = new Uint8Array(N);
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
    const i=y*gw+x;
    if(elev[i]<sea) continue;
    const j0=flowTo[i];
    if(j0<0){ mask[i]=1; continue; }   // the pit itself holds water
    let j=j0;
    for(let d=1; d<R && j>=0; d++){
      if(flowTo[j]<0){                 // reached a sink
        if(elev[i] <= elev[j]+pool) mask[i]=1;
        break;
      }
      j=flowTo[j];
    }
  }
  return mask;
}
