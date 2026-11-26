import * as THREE from 'three';

/**
 * Procedural PBR texture sets. Each set paints colour, height, roughness and metalness
 * on canvases; the normal map is derived from the height field (Sobel).
 */
const canvas = (w, h = w) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d', { willReadFrequently: true })]; };

function toTex(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function normalFromHeight(hc, strength = 2) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const [nc, ng] = canvas(w, h);
  const img = ng.createImageData(w, h), d = img.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
    let nx = -dx * strength, ny = dy * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * w + x) * 4;
    d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  ng.putImageData(img, 0, 0);
  return nc;
}

/** value noise for organic variation */
function makeNoise(rnd, size = 64) {
  const g = new Float32Array(size * size).map(() => rnd());
  const at = (x, y) => g[((y % size + size) % size) * size + ((x % size + size) % size)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
}
function fbm(n, x, y, oct = 4) { let v = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { v += a * n(x * f, y * f); a *= 0.5; f *= 2; } return v; }

/** Paint a texture set with a per-pixel function: fn(x, y) -> {r,g,b, h, rough, metal} */
function pixelSet(size, fn, { normal = 2, metal = false } = {}) {
  const [cc, cg] = canvas(size), [hc, hg] = canvas(size), [oc, og] = canvas(size);
  const ci = cg.createImageData(size, size), hi = hg.createImageData(size, size), oi = og.createImageData(size, size);
  const o = {};
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    o.r = 0; o.g = 0; o.b = 0; o.h = 0.5; o.rough = 0.9; o.metal = 0;
    fn(x, y, o);
    const i = (y * size + x) * 4;
    ci.data[i] = o.r; ci.data[i + 1] = o.g; ci.data[i + 2] = o.b; ci.data[i + 3] = 255;
    const hv = Math.max(0, Math.min(255, o.h * 255)); hi.data[i] = hi.data[i + 1] = hi.data[i + 2] = hv; hi.data[i + 3] = 255;
    oi.data[i] = 255; oi.data[i + 1] = Math.max(0, Math.min(255, o.rough * 255)); oi.data[i + 2] = Math.max(0, Math.min(255, o.metal * 255)); oi.data[i + 3] = 255;
  }
  cg.putImageData(ci, 0, 0); hg.putImageData(hi, 0, 0); og.putImageData(oi, 0, 0);
  return { color: cc, height: hc, orm: oc, normal: normalFromHeight(hc, normal), cg, og, hg };
}

export function finalize(set) {
  return { map: toTex(set.color, true), normalMap: toTex(set.normal, false), ormMap: toTex(set.orm, false), emissive: set.emissive ? toTex(set.emissive, true) : null };
}

const clamp255 = (v) => Math.max(0, Math.min(255, v));

/* ------------------------------------------------------------------ asphalt */
export function asphalt(rnd, size = 1024) {
  const n = makeNoise(rnd, 64), n2 = makeNoise(rnd, 32);
  const speck = new Float32Array(size * size).map(() => rnd());
  return pixelSet(size, (x, y, o) => {
    const s = speck[y * size + x];
    const big = fbm(n, x / 90, y / 90);
    const patch = n2(x / 170, y / 170) > 0.62 ? 1 : 0; // repaired patches
    let v = 52 + big * 26 + (s > 0.93 ? 30 : s < 0.08 ? -18 : 0) - patch * 10;
    // tyre polish streaks along v
    v += Math.sin(x / size * Math.PI * 2 * 4) * 3;
    o.r = clamp255(v); o.g = clamp255(v + 1); o.b = clamp255(v + 4);
    o.h = 0.5 + (s - 0.5) * 0.12 + big * 0.1;
    o.rough = 0.8 + (s - 0.5) * 0.16 - patch * 0.04 - (big > 0.66 ? 0.12 : 0); // smooth worn spots
  }, { normal: 1.2 });
}

/** Cracks drawn on top of a set (height + colour). */
function cracks(set, rnd, n = 14) {
  const S = set.color.width;
  for (const [g, col, w] of [[set.cg, 'rgba(20,20,22,.8)', 1.6], [set.hg, 'rgba(0,0,0,.9)', 2.4]]) {
    g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round';
    let r = rnd; // same sequence for both layers
    const seq = [];
    for (let k = 0; k < n * 14; k++) seq.push(rnd());
    let q = 0; const R = () => seq[q++ % seq.length];
    for (let k = 0; k < n; k++) {
      let x = R() * S, y = R() * S, a = R() * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 12; s++) { a += (R() - 0.5) * 1.2; x += Math.cos(a) * 14; y += Math.sin(a) * 14; g.lineTo(x, y); }
      g.stroke();
    }
  }
  set.normal = normalFromHeight(set.height, 1.2);
}

/** Road: asphalt + markings for a road ROAD metres wide (u) x 16 m (v). */
export function road(rnd, roadW, size = 1024) {
  const set = asphalt(rnd, size);
  cracks(set, rnd, 8);
  const px = size / roadW;
  const paint = (g, col) => {
    g.fillStyle = col;
    g.fillRect(size / 2 - 0.35 * px, 0, 0.16 * px, size); g.fillRect(size / 2 + 0.19 * px, 0, 0.16 * px, size);
    g.fillRect(0.5 * px, 0, 0.16 * px, size); g.fillRect(size - 0.66 * px, 0, 0.16 * px, size);
  };
  // worn paint: draw then scuff
  set.cg.globalAlpha = 0.9; paint(set.cg, '#d8ae2c'); set.cg.globalAlpha = 1;
  set.cg.fillStyle = '#e4e2da';
  set.cg.fillRect(0.5 * px, 0, 0.16 * px, size); set.cg.fillRect(size - 0.66 * px, 0, 0.16 * px, size);
  for (let i = 0; i < 1500; i++) { set.cg.fillStyle = `rgba(55,55,58,${0.3 + rnd() * 0.5})`; set.cg.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 3, 2 + rnd() * 3); }
  // darker tyre tracks in each lane
  for (const c of [size / 2 - 4 * px, size / 2 + 4 * px]) for (const off of [-0.9, 0.9]) {
    const gr = set.cg.createLinearGradient(c + off * px - 0.5 * px, 0, c + off * px + 0.5 * px, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.13)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    set.cg.fillStyle = gr; set.cg.fillRect(c + off * px - 0.5 * px, 0, px, size);
    set.og.fillStyle = 'rgba(255,150,0,0.35)'; set.og.fillRect(c + off * px - 0.3 * px, 0, 0.6 * px, size); // polished
  }
  // paint is slightly raised
  paint(set.hg, 'rgba(200,200,200,0.6)'); set.normal = normalFromHeight(set.height, 1.2);
  return set;
}

export function crossing(rnd, roadW, size = 1024) {
  const set = asphalt(rnd, size);
  const px = size / roadW;
  for (const [g, col] of [[set.cg, '#e2e0d8'], [set.hg, 'rgba(210,210,210,.7)']]) {
    g.fillStyle = col;
    for (let i = 1.4; i < roadW - 1.4; i += 1.4) {
      g.fillRect(i * px, 0, 0.7 * px, 2.4 * px); g.fillRect(i * px, size - 2.4 * px, 0.7 * px, 2.4 * px);
      g.fillRect(0, i * px, 2.4 * px, 0.7 * px); g.fillRect(size - 2.4 * px, i * px, 2.4 * px, 0.7 * px);
    }
  }
  for (let i = 0; i < 2500; i++) { set.cg.fillStyle = `rgba(60,60,62,${0.3 + rnd() * 0.5})`; set.cg.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 4, 2 + rnd() * 4); }
  set.normal = normalFromHeight(set.height, 3);
  return set;
}

/* ------------------------------------------------------------------ sidewalk: 1 m concrete slabs, 4 x 4 per texture */
export function sidewalk(rnd, size = 1024) {
  const n = makeNoise(rnd, 64), cell = size / 4;
  const tint = Array.from({ length: 16 }, () => (rnd() - 0.5) * 16);
  const speck = new Float32Array(size * size).map(() => rnd());
  const set = pixelSet(size, (x, y, o) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    const fx = x % cell, fy = y % cell;
    const edge = Math.min(fx, fy, cell - fx, cell - fy);
    const groove = edge < 3 ? 1 : 0;
    const v = 168 + tint[cy * 4 + cx] + fbm(n, x / 60, y / 60) * 22 + (speck[y * size + x] - 0.5) * 14 - groove * 50 - (edge < 8 ? (8 - edge) * 1.5 : 0);
    o.r = clamp255(v); o.g = clamp255(v - 3); o.b = clamp255(v - 8);
    o.h = groove ? 0.2 : 0.55 + (speck[y * size + x] - 0.5) * 0.03;
    o.rough = 0.88;
  }, { normal: 2.5 });
  // gum spots and stains
  for (let i = 0; i < 40; i++) { set.cg.fillStyle = `rgba(40,35,30,${0.05 + rnd() * 0.12})`; set.cg.beginPath(); set.cg.arc(rnd() * size, rnd() * size, 4 + rnd() * 30, 0, 7); set.cg.fill(); }
  return set;
}

export function grass(rnd, size = 512) {
  const n = makeNoise(rnd, 64);
  const speck = new Float32Array(size * size).map(() => rnd());
  return pixelSet(size, (x, y, o) => {
    const b = fbm(n, x / 50, y / 50), s = speck[y * size + x];
    o.r = clamp255(52 + b * 40 + s * 30); o.g = clamp255(92 + b * 50 + s * 40); o.b = clamp255(34 + b * 20);
    o.h = s; o.rough = 0.95;
  }, { normal: 1.5 });
}

export function sand(rnd, size = 512) {
  const n = makeNoise(rnd, 64);
  const speck = new Float32Array(size * size).map(() => rnd());
  return pixelSet(size, (x, y, o) => {
    const b = fbm(n, x / 70, y / 70), s = speck[y * size + x];
    const ripple = Math.sin((x + b * 120) / 9) * 0.5 + 0.5;
    const v = 200 + b * 30 + (s - 0.5) * 24;
    o.r = clamp255(v + 22); o.g = clamp255(v + 2); o.b = clamp255(v - 40);
    o.h = ripple * 0.5 + s * 0.3; o.rough = 0.97;
  }, { normal: 1.2 });
}

export function gravelRoof(rnd, size = 512) {
  const speck = new Float32Array(size * size).map(() => rnd());
  const n = makeNoise(rnd, 64);
  return pixelSet(size, (x, y, o) => {
    const s = speck[y * size + x], b = fbm(n, x / 40, y / 40);
    const v = 92 + s * 40 + b * 30;
    o.r = clamp255(v); o.g = clamp255(v - 4); o.b = clamp255(v - 8); o.h = s; o.rough = 0.95;
  }, { normal: 2 });
}

export function wood(rnd, size = 512) {
  const n = makeNoise(rnd, 64);
  return pixelSet(size, (x, y, o) => {
    const plank = Math.floor(y / (size / 8));
    const grain = fbm(n, x / 80 + plank * 7, y / 6) * 0.6 + Math.sin(x / 13 + plank) * 0.1;
    const seam = y % (size / 8) < 3 ? 1 : 0;
    const v = 120 + grain * 70 - seam * 60;
    o.r = clamp255(v + 20); o.g = clamp255(v - 15); o.b = clamp255(v - 50);
    o.h = seam ? 0.1 : 0.5 + grain * 0.3; o.rough = 0.8;
  }, { normal: 2.5 });
}

/* ------------------------------------------------------------------ facades: 8 x 8 window cells */
const FACADES = {
  glass: { wall: [44, 58, 72], frame: [150, 160, 170], glassC: [[60, 92, 124], [48, 78, 108], [74, 108, 140]], full: true },
  concrete: { wall: [186, 176, 158], frame: [120, 112, 100], glassC: [[40, 52, 64], [48, 62, 76]], wpad: 0.2, hpad: 0.24, sill: true },
  brick: { wall: [140, 72, 54], frame: [222, 210, 190], glassC: [[34, 44, 56], [40, 52, 66]], wpad: 0.22, hpad: 0.22, brick: true, sill: true },
  stucco: { wall: [228, 212, 184], frame: [250, 250, 246], glassC: [[52, 74, 98], [60, 86, 110]], wpad: 0.22, hpad: 0.26, sill: true },
  pastel: { wall: [238, 164, 182], frame: [252, 252, 250], glassC: [[58, 104, 132], [70, 120, 146]], wpad: 0.2, hpad: 0.24, sill: true },
  mint: { wall: [156, 214, 198], frame: [252, 252, 250], glassC: [[58, 104, 132], [70, 120, 146]], wpad: 0.2, hpad: 0.24, sill: true },
  house: { wall: [238, 228, 208], frame: [255, 255, 255], glassC: [[52, 74, 98], [60, 86, 110]], wpad: 0.28, hpad: 0.28, sill: true, siding: true },
};

export function facade(style, rnd, size = 1024) {
  const st = FACADES[style];
  const cell = size / 8;
  const n = makeNoise(rnd, 64);
  const speck = new Float32Array(size * size).map(() => rnd());
  const winCol = Array.from({ length: 64 }, () => st.glassC[(rnd() * st.glassC.length) | 0]);
  const blinds = Array.from({ length: 64 }, () => (rnd() < 0.35 ? 0.2 + rnd() * 0.6 : 0));
  const lit = Array.from({ length: 64 }, () => rnd() < 0.4);
  const set = pixelSet(size, (x, y, o) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), k = cy * 8 + cx;
    const fx = (x % cell) / cell, fy = (y % cell) / cell;
    const s = speck[y * size + x];
    const dirt = fbm(n, x / 120, y / 60) * 0.35 + (1 - y / size) * 0; // streaks
    let wall = st.wall.map((c) => c * (0.9 + dirt * 0.25) + (s - 0.5) * 10);
    let h = 0.6 + (s - 0.5) * 0.015, rough = 0.85, metal = 0;
    if (st.brick) {
      const by = Math.floor(y / 10), bx = Math.floor((x + (by % 2) * 11) / 22);
      const mortar = y % 10 < 2 || (x + (by % 2) * 11) % 22 < 2;
      const bt = ((bx * 31 + by * 17) % 7) / 7;
      wall = mortar ? [170, 160, 148] : st.wall.map((c) => c * (0.85 + bt * 0.25) + (s - 0.5) * 16);
      h = mortar ? 0.45 : 0.62;
    }
    if (st.siding) { const ln = y % 16; if (ln < 2) { wall = wall.map((c) => c * 0.8); h = 0.45; } }
    let col = wall;
    if (st.full) {
      // curtain wall: glass with thin mullions and a spandrel band
      const mull = fx < 0.03 || fx > 0.97, band = fy > 0.86;
      if (mull || band) { col = st.frame.map((c) => c * (band ? 0.55 : 1)); h = 0.7; rough = 0.4; metal = 0.8; }
      else {
        const g = winCol[k], refl = 1 - fy * 0.35 + (fx < 0.45 ? 0.12 : 0);
        col = g.map((c) => c * refl); h = 0.5; rough = 0.06; metal = 0.9;
        if (blinds[k] && fy < blinds[k]) { col = [200, 196, 186]; rough = 0.6; metal = 0; }
      }
    } else {
      const x0 = st.wpad, x1 = 1 - st.wpad, y0 = st.hpad, y1 = 1 - st.hpad * 0.7;
      const inWin = fx > x0 && fx < x1 && fy > y0 && fy < y1;
      const fr = 0.035;
      const inFrame = fx > x0 - fr && fx < x1 + fr && fy > y0 - fr && fy < y1 + fr;
      if (inWin) {
        const mull = Math.abs(fx - 0.5) < 0.012;
        const g = winCol[k], refl = 1.05 - (fy - y0) / (y1 - y0) * 0.4;
        col = mull ? st.frame : g.map((c) => c * refl);
        h = mull ? 0.55 : 0.25; rough = mull ? 0.5 : 0.05; metal = mull ? 0 : 0.85;
        if (!mull && blinds[k] && (fy - y0) / (y1 - y0) < blinds[k]) { col = [222, 214, 196]; rough = 0.7; metal = 0; }
      } else if (inFrame) { col = st.frame; h = 0.72; rough = 0.5; }
      if (st.sill && fx > x0 - 0.06 && fx < x1 + 0.06 && fy > y1 + fr && fy < y1 + fr + 0.04) { col = st.frame.map((c) => c * 0.92); h = 0.85; }
      // rain streaks below sills
      if (!inWin && !inFrame && fy > y1 + 0.08 && fx > x0 && fx < x1) { const st2 = fbm(n, x / 7, 0) ; col = col.map((c) => c * (1 - st2 * 0.12 * (1 - fy))); }
    }
    o.r = clamp255(col[0]); o.g = clamp255(col[1]); o.b = clamp255(col[2]);
    o.h = h; o.rough = rough; o.metal = metal;
  }, { normal: 2.5 });
  // emissive night windows
  const [e, ge] = canvas(size);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, size, size);
  const warm = ['#ffd98a', '#ffe7b0', '#ffcf80', '#e8f0ff', '#ffe0a0'];
  for (let k = 0; k < 64; k++) {
    if (!lit[k]) continue;
    const cx = k % 8, cy = Math.floor(k / 8);
    const x0 = st.full ? 0.04 : st.wpad, x1 = st.full ? 0.96 : 1 - st.wpad, y0 = st.full ? 0.02 : st.hpad, y1 = st.full ? 0.85 : 1 - st.hpad * 0.7;
    ge.globalAlpha = 0.45 + rnd() * 0.55;
    ge.fillStyle = warm[(rnd() * warm.length) | 0];
    ge.fillRect((cx + x0) * cell, (cy + y0) * cell, (x1 - x0) * cell, (y1 - y0) * cell);
  }
  ge.globalAlpha = 1;
  set.emissive = e;
  return set;
}
