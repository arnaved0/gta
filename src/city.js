import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './util.js';

/* ---------------------------------------------------------------- layout */
export const BLOCK = 72;          // road centre to road centre
export const ROAD = 16;           // road width (one wide lane each way)
export const LANE = 4;            // lane centre offset from road centre
export const SW = 4;              // sidewalk width
export const N = 9;               // roads per axis
export const CURB = 0.15;
export const HALF = ((N - 1) / 2) * BLOCK; // 288
export const BEACH_X = -HALF - ROAD / 2;   // sand starts here
export const WATER_X = -HALF - 58;         // shoreline
export const PIER = { x0: WATER_X + 12, x1: WATER_X - 120, z0: -6, z1: 6, y: 1.0 };
export const BOUNDS = { x0: WATER_X - 125, x1: HALF + 22, z0: -HALF - 22, z1: HALF + 22 };

export const roadC = (i) => (i - (N - 1) / 2) * BLOCK;
/** nearest road index to a coordinate */
export const roadIndex = (v) => Math.max(0, Math.min(N - 1, Math.round(v / BLOCK + (N - 1) / 2)));

export const DISTRICTS = {
  downtown: { name: 'Downtown', color: '#59606b' },
  midtown: { name: 'Midtown', color: '#5b5f58' },
  eastside: { name: 'Eastside', color: '#5e5850' },
  hills: { name: 'Palm Hills', color: '#4f6248' },
  beach: { name: 'Vesper Beach', color: '#6a6250' },
  park: { name: 'Lakeside Park', color: '#3f6b3a' },
};

export const SPECIAL = {
  '4,2': 'park',
  '1,5': 'hospital',
  '5,5': 'police',
  '2,2': 'gas',
  '6,3': 'parking',
  '0,3': 'hotel',
};

export function blockDistrict(bx, bz) {
  if (SPECIAL[`${bx},${bz}`] === 'park') return 'park';
  if (bx === 0) return 'beach';
  const d = Math.max(Math.abs(bx - 3.5), Math.abs(bz - 3.5));
  if (d < 1) return 'downtown';
  if (d < 2) return 'midtown';
  if (bx >= 5 || bz <= 1) return d < 3 ? 'eastside' : 'hills';
  return d < 3 ? 'midtown' : 'hills';
}

export function districtAt(x, z) {
  if (x < BEACH_X) return 'beach';
  const bx = Math.floor((x - roadC(0)) / BLOCK), bz = Math.floor((z - roadC(0)) / BLOCK);
  if (bx < 0 || bz < 0 || bx > N - 2 || bz > N - 2) return 'hills';
  return blockDistrict(bx, bz);
}

/* ---------------------------------------------------------------- textures */
function canvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, srgb = true, rep = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
function noiseFill(g, w, h, base, amt, rnd, n = 9000, size = 2) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (rnd() - 0.5) * amt;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    g.fillRect(rnd() * w, rnd() * h, size, size);
  }
}

/** Facade: 8 x 8 window cells. Returns {map, emissive}. */
function facadeTex(style, rnd) {
  const S = 512, cell = S / 8;
  const [c, g] = canvas(S); const [e, ge] = canvas(S);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, S, S);
  const st = {
    glass: { wall: '#2b3a4a', frame: '#9aa7b3', win: ['#3d5a78', '#2f4a66', '#4c6f92'], lit: '#ffd98a', wpad: 2, hpad: 3 },
    concrete: { wall: '#b9ad98', frame: '#8a806f', win: ['#2c3440', '#33404c'], lit: '#ffe2a0', wpad: 12, hpad: 16 },
    brick: { wall: '#8a4a38', frame: '#d8cbb5', win: ['#26303a', '#2e3a46'], lit: '#ffcf80', wpad: 14, hpad: 14 },
    stucco: { wall: '#e7d3b5', frame: '#ffffff', win: ['#3b4f63', '#455c72'], lit: '#ffe6b0', wpad: 14, hpad: 18 },
    pastel: { wall: '#f0a8b8', frame: '#ffffff', win: ['#3e6b85', '#4c7d96'], lit: '#fff0c0', wpad: 12, hpad: 16 },
    mint: { wall: '#9fd8c8', frame: '#ffffff', win: ['#3e6b85', '#4c7d96'], lit: '#fff0c0', wpad: 12, hpad: 16 },
    house: { wall: '#efe4cf', frame: '#ffffff', win: ['#3b4f63', '#455c72'], lit: '#ffe6b0', wpad: 18, hpad: 18 },
  }[style];
  noiseFill(g, S, S, st.wall, 0.08, rnd, 6000);
  if (style === 'brick') {
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < S; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
  }
  for (let r = 0; r < 8; r++) for (let col = 0; col < 8; col++) {
    const x = col * cell + st.wpad, y = r * cell + st.hpad, w = cell - st.wpad * 2, h = cell - st.hpad * 1.6;
    if (style === 'glass') {
      g.fillStyle = st.win[(rnd() * st.win.length) | 0]; g.fillRect(col * cell, r * cell, cell, cell);
      g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(col * cell, r * cell, cell * 0.5, cell);
      g.fillStyle = st.frame; g.fillRect(col * cell, r * cell, 2, cell); g.fillRect(col * cell, r * cell + cell - 6, cell, 6);
    } else {
      g.fillStyle = st.frame; g.fillRect(x - 3, y - 3, w + 6, h + 6);
      const grad = g.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0, st.win[(rnd() * st.win.length) | 0]); grad.addColorStop(1, '#1b2430');
      g.fillStyle = grad; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, y, w * 0.35, h);
    }
    if (rnd() < 0.38) {
      ge.fillStyle = st.lit; ge.globalAlpha = 0.55 + rnd() * 0.45;
      if (style === 'glass') ge.fillRect(col * cell + 3, r * cell + 2, cell - 6, cell - 10);
      else ge.fillRect(x, y, w, h);
      ge.globalAlpha = 1;
    }
  }
  return { map: tex(c), emissive: tex(e) };
}

function makeTextures(rnd) {
  const T = {};
  // asphalt
  { const [c, g] = canvas(512); noiseFill(g, 512, 512, '#3a3b3e', 0.16, rnd, 30000, 2); T.asphalt = tex(c); }
  // road with markings: texture spans road width (u) x 16 m (v)
  {
    const [c, g] = canvas(256, 256); noiseFill(g, 256, 256, '#38393c', 0.15, rnd, 8000, 2);
    const px = 256 / ROAD;
    g.fillStyle = '#e0b52a'; g.fillRect(128 - 0.35 * px, 0, 0.18 * px, 256); g.fillRect(128 + 0.17 * px, 0, 0.18 * px, 256);
    g.fillStyle = '#dcdcd4';
    g.fillRect(0.5 * px, 0, 0.18 * px, 256); g.fillRect(256 - 0.68 * px, 0, 0.18 * px, 256);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(2.6 * px, 0, 2.6 * px, 256); g.fillRect(256 - 5.2 * px, 0, 2.6 * px, 256);
    T.road = tex(c);
  }
  // intersection with crosswalks
  {
    const [c, g] = canvas(256); noiseFill(g, 256, 256, '#38393c', 0.15, rnd, 8000, 2);
    const px = 256 / ROAD; g.fillStyle = '#e4e4dc';
    for (let i = 1.4; i < ROAD - 1.4; i += 1.4) {
      g.fillRect(i * px, 0, 0.7 * px, 2.4 * px); g.fillRect(i * px, 256 - 2.4 * px, 0.7 * px, 2.4 * px);
      g.fillRect(0, i * px, 2.4 * px, 0.7 * px); g.fillRect(256 - 2.4 * px, i * px, 2.4 * px, 0.7 * px);
    }
    T.cross = tex(c, true, false);
  }
  // sidewalk tiles
  {
    const [c, g] = canvas(256); noiseFill(g, 256, 256, '#a9a59c', 0.1, rnd, 8000, 2);
    g.strokeStyle = 'rgba(60,55,50,0.35)'; g.lineWidth = 2;
    for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
    T.sidewalk = tex(c);
  }
  { const [c, g] = canvas(256); noiseFill(g, 256, 256, '#4d7a35', 0.22, rnd, 20000, 2); T.grass = tex(c); }
  { const [c, g] = canvas(256); noiseFill(g, 256, 256, '#dcc79a', 0.14, rnd, 20000, 1); T.sand = tex(c); }
  { const [c, g] = canvas(256); noiseFill(g, 256, 256, '#6b6560', 0.2, rnd, 6000, 3); T.roof = tex(c); }
  { const [c, g] = canvas(128); noiseFill(g, 128, 128, '#8a5a3a', 0.15, rnd, 3000, 2); g.strokeStyle = 'rgba(0,0,0,.25)'; for (let i = 0; i < 128; i += 10) { g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); } T.wood = tex(c); }
  for (const s of ['glass', 'concrete', 'brick', 'stucco', 'pastel', 'mint', 'house']) T[s] = facadeTex(s, rnd);
  return T;
}

/* ---------------------------------------------------------------- geometry helpers */
/** Box walls with world-scaled UVs (cellW metres per window column, cellH per floor; texture = 8x8 cells). */
function wallsGeo(w, h, d, x, y, z, cellW, cellH, rnd) {
  const pos = [], nor = [], uv = [];
  const uo = Math.floor(rnd() * 8) / 8, vo = Math.floor(rnd() * 8) / 8;
  const hw = w / 2, hd = d / 2;
  const faces = [
    [[-hw, hd], [hw, hd], [0, 1], w], [[hw, hd], [hw, -hd], [1, 0], d],
    [[hw, -hd], [-hw, -hd], [0, -1], w], [[-hw, -hd], [-hw, hd], [-1, 0], d],
  ];
  for (const [a, b, n, len] of faces) {
    const u1 = len / (cellW * 8), v1 = h / (cellH * 8);
    const q = [[a, 0, 0, 0], [b, 0, u1, 0], [b, h, u1, v1], [a, h, 0, v1]];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [p, yy, u, v] = q[i];
      pos.push(x + p[0], y + yy, z + p[1]); nor.push(n[0], 0, n[1]); uv.push(u + uo, v + vo);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}
function boxAt(w, h, d, x, y, z, uvScale = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (uvScale) {
    const uv = g.attributes.uv, n = g.attributes.normal;
    for (let i = 0; i < uv.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
      const sw = ay > 0.5 ? w : ax > 0.5 ? d : w, sh = ay > 0.5 ? d : h;
      uv.setXY(i, uv.getX(i) * sw / uvScale, uv.getY(i) * sh / uvScale);
    }
  }
  g.translate(x, y + h / 2, z);
  return g;
}
function planeAt(w, d, x, y, z, uvW = 0, uvD = 0, rotUV = false) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    let u = uv.getX(i) * (uvW ? w / uvW : 1), v = uv.getY(i) * (uvD ? d / uvD : 1);
    if (rotUV) [u, v] = [v, u];
    uv.setXY(i, u, v);
  }
  g.translate(x, y, z);
  return g;
}

/* ---------------------------------------------------------------- city */
export function buildCity(scene, seed = 1234) {
  const rnd = mulberry32(seed);
  const T = makeTextures(rnd);
  const city = {
    group: new THREE.Group(), boxes: [], circles: [], ramps: [], lots: [], blocks: [], signs: [],
    nightMats: [], lampPositions: [], textures: T, parkingSpots: [], shops: [],
  };
  scene.add(city.group);
  const buckets = {}; // material key -> geometries
  const add = (k, g) => (buckets[k] ||= []).push(g);

  // ---------------- ground layers
  add('asphalt', planeAt(BOUNDS.x1 - BEACH_X + 4, BOUNDS.z1 - BOUNDS.z0, (BOUNDS.x1 + BEACH_X) / 2, 0, (BOUNDS.z0 + BOUNDS.z1) / 2, 12, 12));
  // roads with markings
  for (let i = 0; i < N; i++) {
    const c = roadC(i);
    for (let j = 0; j < N - 1; j++) {
      const a = roadC(j) + ROAD / 2, b = roadC(j + 1) - ROAD / 2, len = b - a, m = (a + b) / 2;
      // along z (x = c)
      add('road', planeAt(ROAD, len, c, 0.01, m, ROAD, 16));
      // along x (z = c)
      add('road', planeAt(len, ROAD, m, 0.01, c, 16, ROAD, true));
    }
    for (let j = 0; j < N; j++) add('cross', planeAt(ROAD, ROAD, c, 0.012, roadC(j)));
  }
  // outer grass ring (hills) beyond the grid on N/E/S
  const ringW = 40;
  add('grass', planeAt(BOUNDS.x1 - BEACH_X + 80, ringW, (BOUNDS.x1 + BEACH_X) / 2 + 40, 0.02, -HALF - ROAD / 2 - ringW / 2, 8, 8));
  add('grass', planeAt(BOUNDS.x1 - BEACH_X + 80, ringW, (BOUNDS.x1 + BEACH_X) / 2 + 40, 0.02, HALF + ROAD / 2 + ringW / 2, 8, 8));
  add('grass', planeAt(ringW, 2 * HALF + ROAD, HALF + ROAD / 2 + ringW / 2, 0.02, 0, 8, 8));
  // beach
  {
    const w = BEACH_X - WATER_X + 30;
    const g = new THREE.PlaneGeometry(w, BOUNDS.z1 - BOUNDS.z0 + 80, 24, 4);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + BEACH_X - w / 2;
      p.setY(i, sandHeight(x));
      p.setX(i, x);
      uv.setXY(i, uv.getX(i) * w / 8, uv.getY(i) * (BOUNDS.z1 - BOUNDS.z0 + 80) / 8);
    }
    g.computeVertexNormals();
    add('sand', g);
  }
  // pier
  {
    const { x0, x1, z0, z1, y } = PIER;
    add('wood', boxAt(x0 - x1, 0.3, z1 - z0, (x0 + x1) / 2, y - 0.3, 0, 2));
    for (let x = x1 + 2; x < x0; x += 8) for (const z of [z0 + 0.5, z1 - 0.5]) add('wood', boxAt(0.5, y + 4, 0.5, x, -4, z));
    for (let x = x1; x < x0; x += 3) for (const z of [z0 + 0.1, z1 - 0.1]) add('rail', boxAt(0.12, 1.0, 0.12, x, y, z));
    add('rail', boxAt(x0 - x1, 0.1, 0.12, (x0 + x1) / 2, y + 1, z0 + 0.1));
    add('rail', boxAt(x0 - x1, 0.1, 0.12, (x0 + x1) / 2, y + 1, z1 - 0.1));
    // ramp up from the sand
    city.ramps.push({ x0: x0, x1: x0 + 10, z0, z1, h0: y, h1: sandHeight(x0 + 10), axis: 'x' });
    add('wood', rampGeo(x0, x0 + 10, z0, z1, y, sandHeight(x0 + 10)));
  }

  // ---------------- blocks
  for (let bx = 0; bx < N - 1; bx++) for (let bz = 0; bz < N - 1; bz++) {
    const x0 = roadC(bx) + ROAD / 2, x1 = roadC(bx + 1) - ROAD / 2;
    const z0 = roadC(bz) + ROAD / 2, z1 = roadC(bz + 1) - ROAD / 2;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, size = x1 - x0;
    const dist = blockDistrict(bx, bz), special = SPECIAL[`${bx},${bz}`];
    const block = { bx, bz, x0, x1, z0, z1, cx, cz, dist, special };
    city.blocks.push(block);
    // curb / sidewalk slab
    add('sidewalk', boxAt(size, CURB, size, cx, 0, cz, 4));
    const lx0 = x0 + SW, lx1 = x1 - SW, lz0 = z0 + SW, lz1 = z1 - SW, lot = lx1 - lx0;
    // lamps around the block
    for (const t of [0.15, 0.5, 0.85]) {
      const px = x0 + size * t, pz = z0 + size * t;
      city.lampPositions.push([px, z0 + 0.6, 0], [px, z1 - 0.6, Math.PI], [x0 + 0.6, pz, Math.PI / 2], [x1 - 0.6, pz, -Math.PI / 2]);
    }
    fillBlock(block, { lx0, lx1, lz0, lz1, lot, cx, cz }, add, city, rnd);
  }

  // ---------------- street lamps (instanced)
  {
    const poleG = mergeGeometries([
      boxAt(0.16, 6.5, 0.16, 0, 0, 0),
      boxAt(0.12, 0.12, 2.0, 0, 6.4, 1.0),
    ]);
    const headG = boxAt(0.5, 0.18, 0.8, 0, 6.25, 1.9);
    const n = city.lampPositions.length;
    const poles = new THREE.InstancedMesh(poleG, new THREE.MeshStandardMaterial({ color: 0x3a3d40, metalness: 0.6, roughness: 0.5 }), n);
    const heads = new THREE.InstancedMesh(headG, new THREE.MeshStandardMaterial({ color: 0x444444, emissive: 0xffd9a0, emissiveIntensity: 0 }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    const glowPos = [];
    city.lampPositions.forEach(([x, z, r], i) => {
      // face the road: arm points along +z local; rotate so it points away from the block
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r);
      m.compose(new THREE.Vector3(x, CURB, z), q, s);
      poles.setMatrixAt(i, m); heads.setMatrixAt(i, m);
      const off = new THREE.Vector3(0, 6.1, 1.9).applyQuaternion(q);
      glowPos.push(x + off.x, CURB + off.y, z + off.z);
      city.circles.push({ x, z, r: 0.25, kind: 'pole' });
    });
    poles.castShadow = true;
    city.group.add(poles, heads);
    city.lampHeads = heads.material;
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
    city.lampGlow = new THREE.Points(gg, new THREE.PointsMaterial({ size: 4, map: glowTex(), color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    city.group.add(city.lampGlow);
    // fake light pools on the pavement under each lamp
    const pc = document.createElement('canvas'); pc.width = pc.height = 128;
    const pg = pc.getContext('2d'); const gr = pg.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,200,130,0.9)'); gr.addColorStop(0.5, 'rgba(255,180,110,0.35)'); gr.addColorStop(1, 'rgba(255,170,100,0)');
    pg.fillStyle = gr; pg.fillRect(0, 0, 128, 128);
    const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(pc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 }), n);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < n; i++) mm.makeTranslation(glowPos[i * 3], 0.2, glowPos[i * 3 + 2]), pool.setMatrixAt(i, mm);
    pool.renderOrder = 1;
    city.group.add(pool);
    city.lampPool = pool.material;
  }

  // ---------------- traffic lights at intersections (instanced bulbs, colour updated per phase)
  {
    const poleG = mergeGeometries([boxAt(0.15, 5.2, 0.15, 0, 0, 0), boxAt(0.1, 0.1, 4.2, 0, 5.1, 2.1), boxAt(0.4, 1.1, 0.35, 0, 4.6, 4.0)]);
    const list = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = roadC(i), z = roadC(j);
      // one pole per approach, on the right-hand corner; axis 0 = travelling along x, 1 = along z
      list.push({ x: x - ROAD / 2 - 0.6, z: z - ROAD / 2 - 0.6, rot: 0, axis: 1, i, j });      // southbound faces north
      list.push({ x: x + ROAD / 2 + 0.6, z: z + ROAD / 2 + 0.6, rot: Math.PI, axis: 1, i, j });
      list.push({ x: x + ROAD / 2 + 0.6, z: z - ROAD / 2 - 0.6, rot: -Math.PI / 2, axis: 0, i, j });
      list.push({ x: x - ROAD / 2 - 0.6, z: z + ROAD / 2 + 0.6, rot: Math.PI / 2, axis: 0, i, j });
    }
    const poles = new THREE.InstancedMesh(poleG, new THREE.MeshStandardMaterial({ color: 0x2a2c2e, metalness: 0.5, roughness: 0.6 }), list.length);
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    list.forEach((l, k) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.rot);
      m.compose(new THREE.Vector3(l.x, CURB, l.z), q, one);
      poles.setMatrixAt(k, m);
      const o = new THREE.Vector3(0, 4.6, 4.0).applyQuaternion(q);
      l.bulb = new THREE.Vector3(l.x + o.x, CURB + o.y, l.z + o.z);
      city.circles.push({ x: l.x, z: l.z, r: 0.25, kind: 'pole' });
    });
    city.group.add(poles, bulbs);
    city.signalList = list; city.signalBulbs = bulbs;
  }

  // ---------------- materials & merge
  const M = {
    asphalt: new THREE.MeshStandardMaterial({ map: T.asphalt, roughness: 0.95 }),
    road: new THREE.MeshStandardMaterial({ map: T.road, roughness: 0.9 }),
    cross: new THREE.MeshStandardMaterial({ map: T.cross, roughness: 0.9 }),
    sidewalk: new THREE.MeshStandardMaterial({ map: T.sidewalk, roughness: 0.92 }),
    grass: new THREE.MeshStandardMaterial({ map: T.grass, roughness: 1 }),
    sand: new THREE.MeshStandardMaterial({ map: T.sand, roughness: 1 }),
    wood: new THREE.MeshStandardMaterial({ map: T.wood, roughness: 0.9 }),
    rail: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }),
    roof: new THREE.MeshStandardMaterial({ map: T.roof, roughness: 0.95 }),
    tile: new THREE.MeshStandardMaterial({ color: 0xb4553a, roughness: 0.85, flatShading: true }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.7 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.8 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x7a5c3e, roughness: 1 }),
    frond: new THREE.MeshStandardMaterial({ color: 0x3f7a2c, roughness: 0.9, side: THREE.DoubleSide }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x3d6e2e, roughness: 1, flatShading: true }),
    water: new THREE.MeshStandardMaterial({ color: 0x3f8fae, roughness: 0.3 }),
    awning: new THREE.MeshStandardMaterial({ color: 0xc8463c, roughness: 0.8 }),
    pump: new THREE.MeshStandardMaterial({ color: 0xd23b30, roughness: 0.6 }),
    hedge: new THREE.MeshStandardMaterial({ color: 0x35602a, roughness: 1 }),
  };
  for (const s of ['glass', 'concrete', 'brick', 'stucco', 'pastel', 'mint', 'house']) {
    M[s] = new THREE.MeshStandardMaterial({
      map: T[s].map, emissiveMap: T[s].emissive, emissive: 0xffffff, emissiveIntensity: 0,
      roughness: s === 'glass' ? 0.25 : 0.85, metalness: s === 'glass' ? 0.5 : 0,
    });
    city.nightMats.push(M[s]);
  }
  const noShadowRecv = new Set();
  const castSet = new Set(['glass', 'concrete', 'brick', 'stucco', 'pastel', 'mint', 'house', 'roof', 'tile', 'trunk', 'frond', 'leaf', 'metal', 'white', 'awning', 'pump', 'wood', 'dark', 'hedge']);
  for (const [k, geos] of Object.entries(buckets)) {
    if (!geos.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)).map(stripAttrs)), M[k]);
    mesh.receiveShadow = !noShadowRecv.has(k);
    mesh.castShadow = castSet.has(k);
    mesh.matrixAutoUpdate = false;
    city.group.add(mesh);
  }
  city.materials = M;

  // signs (text planes)
  for (const s of city.signs) city.group.add(makeSign(s));

  // ---------------- collision grid
  city.grid = new Map();
  const cellOf = (x, z) => `${Math.floor(x / 32)},${Math.floor(z / 32)}`;
  const put = (o, x0, x1, z0, z1) => {
    for (let gx = Math.floor(x0 / 32); gx <= Math.floor(x1 / 32); gx++)
      for (let gz = Math.floor(z0 / 32); gz <= Math.floor(z1 / 32); gz++) {
        const k = `${gx},${gz}`; (city.grid.get(k) || city.grid.set(k, []).get(k)).push(o);
      }
  };
  for (const b of city.boxes) put(b, b.x0, b.x1, b.z0, b.z1);
  for (const c of city.circles) put(c, c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r);
  city.near = (x, z) => city.grid.get(cellOf(x, z)) || [];
  city.nearArea = (x, z, r) => {
    const out = new Set();
    for (let gx = Math.floor((x - r) / 32); gx <= Math.floor((x + r) / 32); gx++)
      for (let gz = Math.floor((z - r) / 32); gz <= Math.floor((z + r) / 32); gz++)
        for (const o of city.grid.get(`${gx},${gz}`) || []) out.add(o);
    return out;
  };

  city.mapCanvas = drawMap(city);
  return city;
}

function stripAttrs(g) {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

export function sandHeight(x) {
  if (x >= BEACH_X) return 0;
  if (x > WATER_X) return 0.05 - ((BEACH_X - x) / (BEACH_X - WATER_X)) * 0.45;
  return -0.4 - (WATER_X - x) * 0.06;
}

function rampGeo(xa, xb, z0, z1, ha, hb) {
  const g = new THREE.BufferGeometry();
  const p = [xa, ha, z0, xb, hb, z0, xb, hb, z1, xa, ha, z0, xb, hb, z1, xa, ha, z1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 2, 3, 0, 0, 2, 3, 0, 3], 2));
  g.computeVertexNormals();
  return g;
}

function glowTex() {
  const [c, g] = canvas(64);
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
export { glowTex };

/* ---------------------------------------------------------------- block contents */
const SHOP_NAMES = ['CLUCK SHACK', 'VESPER MART', 'DONUT PLANET', 'TACO LOCO', 'PAWN KINGS', 'LAUNDRO-MAT', 'PHONE ZONE', 'NOODLE BAR', 'LIQUOR', 'PIZZA PALACE', 'NAIL STUDIO', 'GYM 24/7'];

function fillBlock(b, L, add, city, rnd) {
  const { lx0, lx1, lz0, lz1, lot, cx, cz } = L;
  const building = (style, w, h, d, x, z, opts = {}) => {
    const cellW = style === 'glass' ? 2.2 : 3.2, cellH = style === 'house' ? 3.2 : 3.6;
    add(style, wallsGeo(w, h, d, x, CURB, z, cellW, cellH, rnd));
    add('roof', planeAt(w, d, x, CURB + h, z, 6, 6));
    if (opts.parapet !== false && style !== 'house') {
      add('roof', boxAt(w, 0.8, 0.3, x, CURB + h, z - d / 2 + 0.15));
      add('roof', boxAt(w, 0.8, 0.3, x, CURB + h, z + d / 2 - 0.15));
      add('roof', boxAt(0.3, 0.8, d, x - w / 2 + 0.15, CURB + h, z));
      add('roof', boxAt(0.3, 0.8, d, x + w / 2 - 0.15, CURB + h, z));
      // rooftop clutter
      for (let i = 0; i < 2 + rnd() * 3; i++) add('metal', boxAt(1.5 + rnd() * 2, 1 + rnd(), 1.5 + rnd() * 2, x + (rnd() - 0.5) * (w - 5), CURB + h, z + (rnd() - 0.5) * (d - 5)));
      if (rnd() < 0.35) { add('wood', boxAt(0.3, 3, 0.3, x + w / 4, CURB + h, z)); add('wood', new THREE.CylinderGeometry(1.6, 1.6, 3, 10).translate(x + w / 4, CURB + h + 4, z)); }
    }
    if (style === 'house') {
      const roof = new THREE.ConeGeometry(Math.max(w, d) * 0.78, 2.6, 4, 1);
      roof.rotateY(Math.PI / 4); roof.scale(w / Math.max(w, d), 1, d / Math.max(w, d));
      roof.translate(x, CURB + h + 1.3, z); add('tile', roof);
    }
    city.boxes.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, h: h + CURB, kind: 'building' });
  };
  const palm = (x, z, h = 7 + rnd() * 4) => {
    const lean = (rnd() - 0.5) * 0.25;
    const trunk = new THREE.CylinderGeometry(0.16, 0.26, h, 6, 4);
    const p = trunk.attributes.position;
    for (let i = 0; i < p.count; i++) { const t = (p.getY(i) + h / 2) / h; p.setX(i, p.getX(i) + lean * t * t * h); }
    trunk.translate(x, CURB + h / 2, z); add('trunk', trunk);
    const tx = x + lean * h, ty = CURB + h;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rnd();
      const f = new THREE.PlaneGeometry(0.9, 4.2, 1, 3);
      const fp = f.attributes.position;
      for (let k = 0; k < fp.count; k++) { const t = (fp.getY(k) + 2.1) / 4.2; fp.setZ(k, -t * t * 1.6); }
      f.translate(0, 2.1, 0); f.rotateX(-1.15); f.rotateY(a); f.translate(tx, ty, z);
      add('frond', f);
    }
    city.circles.push({ x, z, r: 0.35, kind: 'tree' });
  };
  const tree = (x, z, s = 1) => {
    add('trunk', new THREE.CylinderGeometry(0.18 * s, 0.25 * s, 2.4 * s, 6).translate(x, CURB + 1.2 * s, z));
    add('leaf', new THREE.IcosahedronGeometry(1.8 * s, 0).translate(x, CURB + 3.4 * s, z));
    add('leaf', new THREE.IcosahedronGeometry(1.3 * s, 0).translate(x + 0.7 * s, CURB + 4.2 * s, z - 0.4 * s));
    city.circles.push({ x, z, r: 0.4 * s, kind: 'tree' });
  };
  const sign = (text, x, y, z, rot, w, h, bg, fg, glow = true) => city.signs.push({ text, x, y, z, rot, w, h, bg, fg, glow });
  // street trees on sidewalks (beach + hills get palms)
  const sidewalkTrees = (n, palmy) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = 0.08 + (i / n) * 0.84 + rnd() * 0.03;
      pts.push([b.x0 + (b.x1 - b.x0) * t, b.z0 + 1.6], [b.x0 + (b.x1 - b.x0) * t, b.z1 - 1.6], [b.x0 + 1.6, b.z0 + (b.z1 - b.z0) * t], [b.x1 - 1.6, b.z0 + (b.z1 - b.z0) * t]);
    }
    for (const [x, z] of pts) if (rnd() < 0.55) (palmy ? palm(x, z) : tree(x, z, 0.8));
  };

  const s = b.special;
  if (s === 'park') {
    add('grass', planeAt(lot, lot, cx, CURB + 0.01, cz, 6, 6));
    add('water', new THREE.CylinderGeometry(9, 9, 0.1, 24).translate(cx + 6, CURB + 0.02, cz + 5));
    city.circles.push({ x: cx + 6, z: cz + 5, r: 9, kind: 'pond', soft: true });
    for (let i = 0; i < 22; i++) { const x = lx0 + 2 + rnd() * (lot - 4), z = lz0 + 2 + rnd() * (lot - 4); if (Math.hypot(x - cx - 6, z - cz - 5) > 11) tree(x, z, 0.9 + rnd() * 0.6); }
    b.parkPaths = true;
    return;
  }
  if (s === 'hospital') {
    add('grass', planeAt(lot, lot, cx, CURB + 0.01, cz, 6, 6));
    building('concrete', 34, 22, 26, cx, cz - 4);
    add('white', boxAt(12, 4, 6, cx, CURB, cz + 12));
    sign('ST. BRENNAN HOSPITAL', cx, CURB + 18, cz + 9.05, 0, 22, 2.6, '#ffffff', '#1d6fb8');
    sign('H', cx + 14, CURB + 24, cz + 9.05, 0, 4, 4, '#1d6fb8', '#ffffff');
    city.boxes.push({ x0: cx - 6, x1: cx + 6, z0: cz + 9, z1: cz + 15, h: 4, kind: 'building' });
    b.door = [cx, b.z1 + 1];
    return;
  }
  if (s === 'police') {
    building('brick', 36, 14, 24, cx, cz - 6);
    add('sidewalk', boxAt(lot, 0.02, 14, cx, CURB, cz + 17));
    sign('VESPER POLICE DEPT.', cx, CURB + 10, cz + 6.05, 0, 20, 2.4, '#14284a', '#ffffff');
    add('dark', boxAt(0.2, 10, 0.2, cx + 16, CURB, cz + 8)); // flag pole
    b.door = [cx, b.z1 + 1];
    return;
  }
  if (s === 'gas') {
    add('white', boxAt(26, 0.8, 14, cx, CURB + 5.2, cz + 4));
    for (const [px, pz] of [[-9, 0], [9, 0], [-9, 8], [9, 8]]) { add('white', boxAt(0.5, 5.2, 0.5, cx + px, CURB, cz + pz)); city.circles.push({ x: cx + px, z: cz + pz, r: 0.4, kind: 'pole' }); }
    for (const px of [-4, 4]) { add('pump', boxAt(1, 1.6, 0.6, cx + px, CURB, cz + 4)); city.circles.push({ x: cx + px, z: cz + 4, r: 0.7, kind: 'pole' }); }
    building('stucco', 18, 5, 10, cx, lz0 + 6);
    sign('GAS & GO', cx, CURB + 6.2, cz + 11.05, 0, 9, 1.2, '#d23b30', '#ffffff');
    add('pump', boxAt(0.4, 8, 0.4, lx1 - 2, CURB, lz1 - 2));
    sign('$4.19', lx1 - 2, CURB + 9, lz1 - 1.75, 0, 4, 2, '#111111', '#ffcc33');
    return;
  }
  if (s === 'parking') {
    building('concrete', lot, 3.2, 10, cx, lz0 + 5);
    for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) {
      const x = lx0 + 4 + i * 7.5, z = lz0 + 16 + r * 10;
      add('rail', planeAt(0.15, 5.5, x - 3.6, CURB + 0.015, z));
      city.parkingSpots.push({ x, z, h: rnd() < 0.5 ? 0 : Math.PI });
    }
    sign('PARK $5', lx1 - 4, CURB + 4.5, lz1 + 0.3, 0, 6, 1.4, '#1f4aa8', '#ffffff');
    return;
  }

  const d = b.dist;
  if (d === 'downtown') {
    // 1-2 towers + a plaza
    const n = rnd() < 0.5 ? 1 : 2;
    if (n === 1) {
      const w = 26 + rnd() * 12, h = 70 + rnd() * 70;
      building('glass', w, h, w, cx, cz);
      if (rnd() < 0.6) building('glass', w * 0.7, 14, w * 0.7, cx, cz, {}); // podium overlap is fine
      add('dark', boxAt(lot, 0.03, lot, cx, CURB, cz, 4));
    } else {
      building(rnd() < 0.7 ? 'glass' : 'concrete', 20, 45 + rnd() * 60, lot - 6, lx0 + 12, cz);
      building(rnd() < 0.5 ? 'glass' : 'concrete', 20, 30 + rnd() * 70, lot - 6, lx1 - 12, cz);
    }
    sidewalkTrees(3, false);
    return;
  }
  if (d === 'midtown' || d === 'eastside') {
    const styles = d === 'midtown' ? ['concrete', 'brick', 'glass', 'stucco'] : ['brick', 'concrete', 'brick', 'stucco'];
    // 4 buildings around the block's edges facing the streets
    const hmax = d === 'midtown' ? 34 : 18;
    const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [qx, qz] of quads) {
      const w = lot / 2 - 2 - rnd() * 4, dd = lot / 2 - 2 - rnd() * 4, h = 8 + rnd() * hmax;
      const x = cx + qx * (lot / 4 + 0.5) + qx * (lot / 4 - 0.5 - w / 2), z = cz + qz * (lot / 4 + 0.5) + qz * (lot / 4 - 0.5 - dd / 2);
      const st = styles[(rnd() * styles.length) | 0];
      building(st, w, h, dd, x, z);
      // storefront on the street side
      if (rnd() < 0.7) {
        const face = rnd() < 0.5 ? 'x' : 'z';
        const name = SHOP_NAMES[(rnd() * SHOP_NAMES.length) | 0];
        const colors = [['#c8463c', '#fff'], ['#1f6f8b', '#fff'], ['#f2c14e', '#222'], ['#2d2d2d', '#ff5ea8'], ['#26734d', '#fff']][(rnd() * 5) | 0];
        if (face === 'z') {
          const zz = z + qz * (dd / 2 + 0.06);
          sign(name, x, CURB + 4.4, zz, qz > 0 ? 0 : Math.PI, Math.min(w - 2, 10), 1.3, colors[0], colors[1]);
          add('awning', boxAt(Math.min(w - 2, 10), 0.15, 1.6, x, CURB + 3.2, z + qz * (dd / 2 + 0.8)));
          city.shops.push({ name, x, z: zz + qz * 2 });
        } else {
          const xx = x + qx * (w / 2 + 0.06);
          sign(name, xx, CURB + 4.4, z, qx > 0 ? Math.PI / 2 : -Math.PI / 2, Math.min(dd - 2, 10), 1.3, colors[0], colors[1]);
          add('awning', boxAt(1.6, 0.15, Math.min(dd - 2, 10), x + qx * (w / 2 + 0.8), CURB + 3.2, z));
          city.shops.push({ name, x: xx + qx * 2, z });
        }
      }
    }
    sidewalkTrees(2, d === 'eastside');
    return;
  }
  if (d === 'beach' || s === 'hotel') {
    // art-deco pastel hotels facing the ocean (west)
    const styles = ['pastel', 'mint', 'stucco'];
    const names = ['HOTEL FLAMINGO', 'THE SEAGLASS', 'CORAL INN', 'SUNSET ARMS', 'OCEAN VIEW'];
    for (const qz of [-1, 1]) {
      const w = 18 + rnd() * 6, dd = lot / 2 - 3, h = 10 + rnd() * 14;
      const x = lx0 + w / 2 + 1, z = cz + qz * (lot / 4);
      building(styles[(rnd() * 3) | 0], w, h, dd, x, z);
      add('white', boxAt(1.2, h + 3, 4, x - w / 2 - 0.6, CURB, z));
      sign(names[(rnd() * names.length) | 0], x - w / 2 - 1.25, CURB + h - 2, z, -Math.PI / 2, dd - 4, 1.6, '#00000000', '#ff7ad9');
    }
    add('grass', planeAt(lot / 2, lot, lx1 - lot / 4, CURB + 0.01, cz, 6, 6));
    add('water', boxAt(10, 0.05, 6, lx1 - lot / 4, CURB + 0.01, cz));
    sidewalkTrees(3, true);
    return;
  }
  // hills / suburbs: houses with lawns
  add('grass', planeAt(lot, lot, cx, CURB + 0.01, cz, 6, 6));
  const per = 3, cell = lot / per;
  for (let i = 0; i < per; i++) for (let j = 0; j < per; j++) {
    if (i === 1 && j === 1) { tree(cx, cz, 1.4); continue; }
    const x = lx0 + cell * (i + 0.5), z = lz0 + cell * (j + 0.5);
    const w = 8 + rnd() * 3, dd = 7 + rnd() * 3;
    building(rnd() < 0.7 ? 'house' : 'stucco', w, rnd() < 0.3 ? 6.4 : 3.4, dd, x, z, { parapet: false });
    if (rnd() < 0.5) palm(x + w / 2 + 1.5, z + dd / 2 + 1);
    if (rnd() < 0.4) add('hedge', boxAt(cell - 2, 1, 0.8, x, CURB, z + cell / 2 - 0.6));
  }
  sidewalkTrees(2, true);
}

/* ---------------------------------------------------------------- signs */
function makeSign({ text, x, y, z, rot, w, h, bg, fg, glow }) {
  const ppm = 64;
  const [c, g] = canvas(Math.min(2048, Math.ceil(w * ppm)), Math.ceil(h * ppm));
  if (bg && bg !== '#00000000') { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
  g.fillStyle = fg;
  let fs = c.height * 0.72;
  g.font = `900 ${fs}px "Arial Black", Impact, sans-serif`;
  while (g.measureText(text).width > c.width * 0.92 && fs > 8) { fs -= 2; g.font = `900 ${fs}px "Arial Black", Impact, sans-serif`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (!bg || bg === '#00000000') { g.shadowColor = fg; g.shadowBlur = 12; }
  g.fillText(text, c.width / 2, c.height / 2 + fs * 0.04);
  const t = tex(c, true, false);
  const mat = new THREE.MeshStandardMaterial({
    map: t, transparent: !bg || bg === '#00000000', emissive: 0xffffff, emissiveMap: t, emissiveIntensity: glow ? 0.25 : 0, roughness: 0.6,
  });
  mat.userData.night = glow;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(x, y, z); m.rotation.y = rot;
  m.userData.signMat = mat;
  return m;
}

/* ---------------------------------------------------------------- height & collisions */
export function groundHeight(city, x, z) {
  for (const r of city.ramps) {
    if (z >= r.z0 && z <= r.z1) {
      if (r.axis === 'x' && x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1)) return r.h0 + ((x - r.x0) / (r.x1 - r.x0)) * (r.h1 - r.h0);
      if (r.axis === 'z2') { /* unused */ }
    }
    if (r.axis === 'zr' && x >= r.x0 && x <= r.x1 && z >= Math.min(r.z0, r.z1) && z <= Math.max(r.z0, r.z1)) return r.h0 + ((z - r.z0) / (r.z1 - r.z0)) * (r.h1 - r.h0);
  }
  if (x <= PIER.x0 && x >= PIER.x1 && z >= PIER.z0 && z <= PIER.z1) return PIER.y;
  if (x < BEACH_X) return Math.max(sandHeight(x), -1.2);
  // curbs
  const fx = (x - roadC(0)) / BLOCK, fz = (z - roadC(0)) / BLOCK;
  const bx = Math.floor(fx), bz = Math.floor(fz);
  if (bx >= 0 && bz >= 0 && bx < N - 1 && bz < N - 1) {
    const lx = x - roadC(bx), lz = z - roadC(bz);
    if (lx > ROAD / 2 && lx < BLOCK - ROAD / 2 && lz > ROAD / 2 && lz < BLOCK - ROAD / 2) return CURB;
  }
  return 0;
}

/** Push a circle out of buildings / props. Returns the collision normal if hit. */
export function collideCircle(city, pos, r, { props = true, y = 0 } = {}) {
  let hit = null;
  for (const o of city.nearArea(pos.x, pos.z, r + 2)) {
    if (o.x0 !== undefined) {
      if (y > o.h) continue;
      const cx = Math.max(o.x0, Math.min(pos.x, o.x1)), cz = Math.max(o.z0, Math.min(pos.z, o.z1));
      let dx = pos.x - cx, dz = pos.z - cz, d = Math.hypot(dx, dz);
      if (d < r) {
        if (d < 1e-4) { // centre inside: push out the shortest way
          const l = pos.x - o.x0, rr = o.x1 - pos.x, t = pos.z - o.z0, b = o.z1 - pos.z, m = Math.min(l, rr, t, b);
          if (m === l) { dx = -1; dz = 0; pos.x = o.x0 - r; } else if (m === rr) { dx = 1; dz = 0; pos.x = o.x1 + r; }
          else if (m === t) { dx = 0; dz = -1; pos.z = o.z0 - r; } else { dx = 0; dz = 1; pos.z = o.z1 + r; }
          hit = { nx: dx, nz: dz, obj: o };
        } else {
          pos.x = cx + (dx / d) * r; pos.z = cz + (dz / d) * r;
          hit = { nx: dx / d, nz: dz / d, obj: o };
        }
      }
    } else if (props && !o.soft) {
      const dx = pos.x - o.x, dz = pos.z - o.z, d = Math.hypot(dx, dz), m = r + o.r;
      if (d < m && d > 1e-4) { pos.x = o.x + (dx / d) * m; pos.z = o.z + (dz / d) * m; hit = { nx: dx / d, nz: dz / d, obj: o }; }
    }
  }
  // world bounds
  if (pos.x < BOUNDS.x0) { pos.x = BOUNDS.x0; hit = { nx: 1, nz: 0 }; }
  if (pos.x > BOUNDS.x1) { pos.x = BOUNDS.x1; hit = { nx: -1, nz: 0 }; }
  if (pos.z < BOUNDS.z0) { pos.z = BOUNDS.z0; hit = { nx: 0, nz: 1 }; }
  if (pos.z > BOUNDS.z1) { pos.z = BOUNDS.z1; hit = { nx: 0, nz: -1 }; }
  return hit;
}

/** Ray vs buildings: returns distance or Infinity (2D slab test with height). */
export function rayBuildings(city, ox, oy, oz, dx, dy, dz, maxD) {
  let best = maxD;
  const steps = Math.ceil(maxD / 24);
  const seen = new Set();
  for (let s = 0; s <= steps; s++) {
    const px = ox + dx * s * 24, pz = oz + dz * s * 24;
    for (const o of city.nearArea(px, pz, 24)) {
      if (o.x0 === undefined || seen.has(o)) continue;
      seen.add(o);
      let t0 = 0, t1 = best;
      for (const [p, d, a, b] of [[ox, dx, o.x0, o.x1], [oz, dz, o.z0, o.z1], [oy, dy, -10, o.h]]) {
        if (Math.abs(d) < 1e-6) { if (p < a || p > b) { t0 = Infinity; break; } continue; }
        let ta = (a - p) / d, tb = (b - p) / d; if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) break;
      }
      if (t0 <= t1 && t0 < best) best = t0;
    }
  }
  return best;
}

/* ---------------------------------------------------------------- minimap base */
export const MAP_SCALE = 2; // px per metre
function drawMap(city) {
  const W = (BOUNDS.x1 - BOUNDS.x0) * MAP_SCALE, H = (BOUNDS.z1 - BOUNDS.z0) * MAP_SCALE;
  const [c, g] = canvas(W, H);
  const X = (x) => (x - BOUNDS.x0) * MAP_SCALE, Z = (z) => (z - BOUNDS.z0) * MAP_SCALE;
  g.fillStyle = '#2c4b5e'; g.fillRect(0, 0, W, H);                       // water
  g.fillStyle = '#9b9070'; g.fillRect(X(WATER_X), 0, X(BEACH_X) - X(WATER_X), H); // sand
  g.fillStyle = '#3e4f3a'; g.fillRect(X(BEACH_X), 0, W - X(BEACH_X), H);  // land
  g.fillStyle = '#7c7360'; g.fillRect(X(PIER.x1), Z(PIER.z0), X(PIER.x0) - X(PIER.x1), Z(PIER.z1) - Z(PIER.z0));
  g.fillStyle = '#c9c9c9';
  for (let i = 0; i < N; i++) {
    g.fillRect(X(roadC(i) - ROAD / 2), Z(roadC(0) - ROAD / 2), ROAD * MAP_SCALE, (2 * HALF + ROAD) * MAP_SCALE);
    g.fillRect(X(roadC(0) - ROAD / 2), Z(roadC(i) - ROAD / 2), (2 * HALF + ROAD) * MAP_SCALE, ROAD * MAP_SCALE);
  }
  for (const b of city.blocks) {
    g.fillStyle = b.dist === 'park' ? '#4f7f46' : DISTRICTS[b.dist].color;
    g.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * MAP_SCALE, (b.z1 - b.z0) * MAP_SCALE);
  }
  g.fillStyle = '#878a8e';
  for (const o of city.boxes) g.fillRect(X(o.x0), Z(o.z0), (o.x1 - o.x0) * MAP_SCALE, (o.z1 - o.z0) * MAP_SCALE);
  return c;
}
