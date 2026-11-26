import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, angleLerp } from './util.js';
import { roadC, roadIndex, N, LANE, ROAD, BLOCK, groundHeight, collideCircle } from './city.js';

/* ---------------------------------------------------------------- models */
export const TYPES = {
  sedan: { name: 'Meridian', L: 4.6, W: 1.85, top: 1.0, cab: [0.55, 0.95, 1.55, 1.0], cabH: 1.45, wheel: 0.36, wb: 2.75, accel: 9, max: 42, grip: 7.5, mass: 1.4, hp: 100,
    colors: [0x8b1e24, 0x1d3f6e, 0xd9d9d9, 0x222326, 0x6d6f73, 0x2e5a3a, 0xc9b28a, 0x5a2a5e] },
  sports: { name: 'Razor GT', L: 4.4, W: 1.95, top: 0.85, cab: [0.9, 1.45, 1.6, 0.85], cabH: 1.2, wheel: 0.35, wb: 2.6, accel: 15, max: 58, grip: 9, mass: 1.2, hp: 90,
    colors: [0xd61f1f, 0xf2c200, 0xff6a00, 0x13a3c9, 0xf5f5f5, 0x111111, 0x7a2bd9] },
  van: { name: 'Hauler', L: 5.2, W: 2.05, top: 1.85, cab: [0.25, 0.35, 3.75, 3.1], cabH: 2.3, wheel: 0.4, wb: 3.2, accel: 6.5, max: 33, grip: 6, mass: 2.0, hp: 130, boxy: true,
    colors: [0xeeeeee, 0x9aa3a8, 0x2d4c7a, 0x8a6a3a] },
  taxi: { name: 'Cab', L: 4.7, W: 1.85, top: 1.0, cab: [0.55, 0.95, 1.55, 1.0], cabH: 1.45, wheel: 0.36, wb: 2.8, accel: 9, max: 40, grip: 7.5, mass: 1.4, hp: 100,
    colors: [0xf2b705], taxi: true },
  police: { name: 'Patrol', L: 4.9, W: 1.95, top: 1.0, cab: [0.6, 1.0, 1.6, 1.05], cabH: 1.5, wheel: 0.37, wb: 2.9, accel: 12, max: 50, grip: 8.5, mass: 1.6, hp: 140,
    colors: [0x15171c], police: true },
  pickup: { name: 'Trailhand', L: 5.1, W: 2.0, top: 1.15, cab: [1.7, 1.95, 1.6, 1.2], cabH: 1.8, wheel: 0.42, wb: 3.1, accel: 8.5, max: 38, grip: 7, mass: 1.8, hp: 120, bed: true,
    colors: [0x7a1c1c, 0x2b2b2b, 0xd0c9b8, 0x2f4f6f] },
};
export const TRAFFIC_MIX = ['sedan', 'sedan', 'sedan', 'taxi', 'van', 'pickup', 'sports', 'sedan', 'taxi', 'pickup'];

const geoCache = {};
const matCache = {};
const mat = (key, make) => (matCache[key] ||= make());

function bodyGeo(t) {
  const { L, top, cab, wheel } = t;
  const hl = L / 2, wf = t.wb / 2, wr = -t.wb / 2, ra = wheel + 0.06, base = 0.3;
  const s = new THREE.Shape();
  s.moveTo(-hl, base);
  s.lineTo(-hl, top - 0.22);
  s.lineTo(-hl + 0.2, top);
  if (t.boxy) { s.lineTo(hl - 0.15, top); s.lineTo(hl, top - 0.3); }
  else { s.lineTo(hl - cab[3] - 0.1, top + 0.02); s.lineTo(hl - 0.08, top - 0.15); s.lineTo(hl, top - 0.42); }
  s.lineTo(hl, base + 0.05);
  s.lineTo(hl - 0.1, base);
  s.lineTo(wf + ra, base); s.absarc(wf, wheel, ra, 0, Math.PI, false);
  s.lineTo(wr + ra, base); s.absarc(wr, wheel, ra, 0, Math.PI, false);
  s.lineTo(-hl, base);
  const g = new THREE.ExtrudeGeometry(s, { depth: t.W - 0.12, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -(t.W - 0.12) / 2);
  g.rotateY(-Math.PI / 2); // length axis -> +z forward
  return g;
}
function cabinGeo(t) {
  const { L, top, cab, cabH } = t;
  const hl = L / 2;
  const s = new THREE.Shape();
  if (t.boxy) {
    s.moveTo(-hl + cab[0], top - 0.02); s.lineTo(-hl + cab[0], cabH); s.lineTo(hl - cab[2] + 1.5, cabH); s.lineTo(hl - 0.35, top + 0.05); s.lineTo(hl - 0.35, top - 0.02);
  } else {
    s.moveTo(-hl + cab[0], top - 0.02); s.lineTo(-hl + cab[1], cabH); s.lineTo(hl - cab[2], cabH); s.lineTo(hl - cab[3] - 0.1, top - 0.02);
  }
  const w = t.W - 0.32;
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2 });
  g.translate(0, 0, -w / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

function colorize(g, hex) {
  g = g.index ? g.toNonIndexed() : g;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function buildCarMesh(typeKey, color) {
  const t = TYPES[typeKey];
  const G = (geoCache[typeKey] ||= (() => {
    const paint = [bodyGeo(t)];
    if (t.boxy) paint.push(new THREE.BoxGeometry(t.W - 0.14, t.cabH - t.top + 0.05, t.L - t.cab[0] - 1.6).translate(0, (t.cabH + t.top) / 2, -t.L / 2 + t.cab[0] + (t.L - t.cab[0] - 1.6) / 2));
    if (t.bed) {
      paint.push(new THREE.BoxGeometry(0.1, 0.45, 2.0).translate(t.W / 2 - 0.1, t.top + 0.2, -t.L / 2 + 1.1));
      paint.push(new THREE.BoxGeometry(0.1, 0.45, 2.0).translate(-t.W / 2 + 0.1, t.top + 0.2, -t.L / 2 + 1.1));
      paint.push(new THREE.BoxGeometry(t.W - 0.1, 0.45, 0.1).translate(0, t.top + 0.2, -t.L / 2 + 0.12));
    }
    paint.push(new THREE.BoxGeometry(t.W - 0.4, 0.06, (t.boxy ? t.L - t.cab[0] - 1.2 : t.L - t.cab[1] - t.cab[2]) * 0.92)
      .translate(0, t.cabH + 0.05, t.boxy ? -0.2 : (-t.L / 2 + t.cab[1] + (t.L / 2 - t.cab[2])) / 2 + (t.bed ? 0.75 : 0)));
    const body = mergeGeometries(paint.map((g) => { g = g.index ? g.toNonIndexed() : g; if (g.attributes.uv) g.deleteAttribute('uv'); return g; }));
    const cabin = cabinGeo(t); if (t.bed) cabin.translate(0, 0, 0.75);
    // trim: bumpers, mirrors, (taxi checker, police door panels) – vertex coloured
    const trim = [
      colorize(new THREE.BoxGeometry(t.W, 0.2, 0.2).translate(0, 0.42, t.L / 2 + 0.02), 0x1b1c1e),
      colorize(new THREE.BoxGeometry(t.W, 0.2, 0.2).translate(0, 0.42, -t.L / 2 - 0.02), 0x1b1c1e),
      colorize(new THREE.BoxGeometry(t.W * 0.5, 0.12, 0.04).translate(0, 0.62, -t.L / 2 - 0.04), 0xe8e8e8),
    ];
    if (t.taxi) {
      trim.push(colorize(new THREE.BoxGeometry(t.W + 0.01, 0.12, 2.6).translate(0, t.top - 0.12, 0), 0x111111));
      trim.push(colorize(new THREE.BoxGeometry(0.9, 0.25, 0.3).translate(0, t.cabH + 0.2, -0.3), 0xfff3b0));
    }
    if (t.police) {
      trim.push(colorize(new THREE.BoxGeometry(t.W + 0.02, 0.5, 2.2).translate(0, 0.68, 0.05), 0xf4f4f4));
      trim.push(colorize(new THREE.BoxGeometry(1.4, 0.08, 0.32).translate(0, t.cabH + 0.08, -0.1), 0x222222));
    }
    const trimG = mergeGeometries(trim);
    const lights = mergeGeometries([
      colorize(new THREE.BoxGeometry(0.42, 0.14, 0.06).translate(t.W / 2 - 0.4, t.top - 0.32, t.L / 2 + 0.02), 0xfff6dc),
      colorize(new THREE.BoxGeometry(0.42, 0.14, 0.06).translate(-t.W / 2 + 0.4, t.top - 0.32, t.L / 2 + 0.02), 0xfff6dc),
      colorize(new THREE.BoxGeometry(0.4, 0.14, 0.06).translate(t.W / 2 - 0.35, t.top - 0.3, -t.L / 2 - 0.03), 0xff1a1a),
      colorize(new THREE.BoxGeometry(0.4, 0.14, 0.06).translate(-t.W / 2 + 0.35, t.top - 0.3, -t.L / 2 - 0.03), 0xff1a1a),
    ]);
    const wheel = mergeGeometries([
      colorize(new THREE.CylinderGeometry(t.wheel, t.wheel, 0.26, 16).rotateZ(Math.PI / 2), 0x151515),
      colorize(new THREE.CylinderGeometry(t.wheel * 0.62, t.wheel * 0.62, 0.27, 10).rotateZ(Math.PI / 2), 0xb8bcc2),
      colorize(new THREE.BoxGeometry(0.28, t.wheel * 0.9, 0.12), 0x8a8e94),
    ]);
    return { body, cabin, trim: trimG, lights, wheel };
  })());

  const group = new THREE.Group();
  const paint = mat(`paint${color}`, () => new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 2.2 }));
  const body = new THREE.Mesh(G.body, paint); body.castShadow = true;
  const glass = new THREE.Mesh(G.cabin, mat('glass', () => new THREE.MeshPhysicalMaterial({ color: 0x0d1418, metalness: 0.4, roughness: 0.02, transparent: true, opacity: 0.55, depthWrite: false, envMapIntensity: 2.5 })));
  glass.renderOrder = 2;
  const trim = new THREE.Mesh(G.trim, mat('trim', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 })));
  const lights = new THREE.Mesh(G.lights, mat('lights', () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })));
  group.add(body, glass, trim, lights);
  const wheelM = mat('wheel', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 }));
  const wheels = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * (t.W / 2 - 0.16), t.wheel, sz * t.wb / 2);
    const spin = new THREE.Mesh(G.wheel, wheelM);
    pivot.add(spin); group.add(pivot);
    wheels.push({ pivot, spin, front: sz > 0 });
  }
  let bar = null;
  if (t.police) {
    bar = { red: new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.28), new THREE.MeshBasicMaterial({ color: 0x400000, toneMapped: false })),
      blue: new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.28), new THREE.MeshBasicMaterial({ color: 0x000040, toneMapped: false })) };
    bar.red.position.set(0.33, t.cabH + 0.2, -0.1); bar.blue.position.set(-0.33, t.cabH + 0.2, -0.1);
    group.add(bar.red, bar.blue);
  }
  return { group, wheels, bar, paint, body };
}

/* ---------------------------------------------------------------- lanes */
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const right = (d) => [-DIRS[d][1], DIRS[d][0]];
const inGrid = (i, j) => i >= 0 && j >= 0 && i < N && j < N;
export function signalState(i, j, axis, time) {
  const c = (time + (i * 3 + j * 5) * 1.7) % 22;
  const greenAxis = c < 10 ? 0 : 1;
  const yellow = (c > 8 && c < 10) || c > 20;
  if (c >= 10 && c < 11) return 'red'; // all-red gap
  if (c < 1) return 'red';
  if (axis !== greenAxis) return 'red';
  return yellow ? 'yellow' : 'green';
}

function linePiece(ax, az, bx, bz) { return { type: 'line', ax, az, bx, bz, len: Math.hypot(bx - ax, bz - az) }; }
function curvePiece(p0, p1, p2) {
  let len = 0, px = p0[0], pz = p0[1];
  for (let k = 1; k <= 10; k++) { const t = k / 10; const x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], z = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]; len += Math.hypot(x - px, z - pz); px = x; pz = z; }
  return { type: 'curve', p0, p1, p2, len };
}
function samplePiece(p, s, out) {
  const t = clamp(s / p.len, 0, 1);
  if (p.type === 'line') {
    out.x = p.ax + (p.bx - p.ax) * t; out.z = p.az + (p.bz - p.az) * t;
    out.h = Math.atan2(p.bx - p.ax, p.bz - p.az);
  } else {
    const { p0, p1, p2 } = p;
    out.x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0];
    out.z = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1];
    const dx = 2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]), dz = 2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    out.h = Math.atan2(dx, dz);
  }
  return out;
}
/** start point of the lane on segment (i,j)->dir */
const STOP = ROAD / 2 + 1.5;
function segmentPiece(i, j, d) {
  const [dx, dz] = DIRS[d], [rx, rz] = right(d);
  const x0 = roadC(i), z0 = roadC(j), x1 = roadC(i + dx), z1 = roadC(j + dz);
  const p = linePiece(x0 + dx * STOP + rx * LANE, z0 + dz * STOP + rz * LANE, x1 - dx * STOP + rx * LANE, z1 - dz * STOP + rz * LANE);
  p.seg = { i, j, d, ni: i + dx, nj: j + dz };
  return p;
}
function turnPiece(i, j, d, d2) {
  const [dx, dz] = DIRS[d], [rx, rz] = right(d), [ex, ez] = DIRS[d2], [sx, sz] = right(d2);
  const cx = roadC(i), cz = roadC(j);
  const a = [cx - dx * STOP + rx * LANE, cz - dz * STOP + rz * LANE];
  const b = [cx + ex * STOP + sx * LANE, cz + ez * STOP + sz * LANE];
  if (d === d2) return linePiece(a[0], a[1], b[0], b[1]);
  const c = [cx + rx * LANE + sx * LANE, cz + rz * LANE + sz * LANE];
  return curvePiece(a, c, b);
}
function chooseDir(i, j, d, rnd = Math.random) {
  const opts = [];
  for (const k of [d, (d + 1) % 4, (d + 3) % 4]) if (inGrid(i + DIRS[k][0], j + DIRS[k][1])) opts.push(k);
  if (!opts.length) return (d + 2) % 4;
  if (opts.includes(d) && rnd() < 0.55) return d;
  return opts[(rnd() * opts.length) | 0];
}

/* ---------------------------------------------------------------- Car */
let NEXT_ID = 1;
export class Car {
  constructor(typeKey, scene, color) {
    this.id = NEXT_ID++;
    this.type = typeKey; this.t = TYPES[typeKey];
    color ??= this.t.colors[(Math.random() * this.t.colors.length) | 0];
    this.color = color;
    const m = buildCarMesh(typeKey, color);
    Object.assign(this, m);
    this.group.userData.car = this;
    scene.add(this.group);
    this.scene = scene;
    this.pos = new THREE.Vector3(); this.heading = 0;
    this.vx = 0; this.vz = 0; this.vy = 0; this.yawRate = 0;
    this.steer = 0; this.wheelSpin = 0;
    this.health = this.t.hp; this.dead = false; this.burnTimer = 0;
    this.mode = 'parked'; // parked | traffic | player | police | physics | wreck
    this.driver = null;   // 'npc' | 'player' | 'cop'
    this.path = []; this.s = 0; this.aiSpeed = 0;
    this.siren = false; this.honk = 0; this.blocked = 0; this.airborne = false; this.airTime = 0;
    this.roll = 0; this.pitch = 0; this.lastAccel = 0; this.skid = 0; this.stuck = 0; this.reverseT = 0;
    this.recentHit = 0;
  }
  get speed() { return Math.hypot(this.vx, this.vz); }
  get fwdSpeed() { return this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading); }
  forward() { return [Math.sin(this.heading), Math.cos(this.heading)]; }
  toLocal(x, z) {
    const dx = x - this.pos.x, dz = z - this.pos.z, s = Math.sin(this.heading), c = Math.cos(this.heading);
    return [-(dx * c - dz * s), dx * s + dz * c]; // [right, forward]
  }
  /** world position of a local point (lx to the car's left (+), ly up, lz forward) */
  local(lx, ly, lz, out = new THREE.Vector3()) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    return out.set(this.pos.x + lx * c + lz * s, this.pos.y + ly, this.pos.z - lx * s + lz * c);
  }
  doorPos(out) { return this.local(this.t.W / 2 + 0.9, 0, 0.2, out); }
  seatPos(out) { return this.local(this.t.W / 2 - 0.62, 0, -0.15, out); }
  circles() {
    const [fx, fz] = this.forward(), r = this.t.W / 2 + 0.05, off = this.t.L / 2 - r;
    return [[this.pos.x + fx * off, this.pos.z + fz * off], [this.pos.x, this.pos.z], [this.pos.x - fx * off, this.pos.z - fz * off]].map(([x, z]) => ({ x, z, r }));
  }
  contains(x, z, pad = 0) {
    const [lx, lz] = this.toLocal(x, z);
    return Math.abs(lx) < this.t.W / 2 + pad && Math.abs(lz) < this.t.L / 2 + pad;
  }

  place(x, z, h) {
    this.pos.set(x, 0, z); this.heading = h; this.vx = this.vz = this.vy = 0; this.sync(0);
  }

  /* ---------- traffic planning */
  startTraffic(i, j, d, s = 0) {
    this.mode = 'traffic'; this.driver = 'npc';
    this.path = [segmentPiece(i, j, d)]; this.s = s;
    this.aiSpeed = 9;
    this.planAhead();
    const o = samplePiece(this.path[0], s, {});
    this.place(o.x, o.z, o.h);
  }
  planAhead() {
    while (this.path.length < 3) {
      const last = this.path[this.path.length - 1];
      if (last.seg) {
        const { ni, nj, d } = last.seg;
        const d2 = chooseDir(ni, nj, d);
        const tp = turnPiece(ni, nj, d, d2); tp.node = { i: ni, j: nj, axis: DIRS[d][0] !== 0 ? 0 : 1 };
        tp.next = d2;
        this.path.push(tp);
        this.path.push(segmentPiece(ni, nj, d2));
      } else break;
    }
  }
  /** Re-join the road network from wherever we are (after being bumped). */
  rejoin() {
    const i = roadIndex(this.pos.x), j = roadIndex(this.pos.z);
    const ex = Math.abs(this.pos.x - roadC(i)), ez = Math.abs(this.pos.z - roadC(j));
    let d;
    const [fx, fz] = this.forward();
    if (ex < ez) d = fz >= 0 ? 1 : 3; else d = fx >= 0 ? 0 : 2;
    // segment we are on: from node behind us
    let si = i, sj = j;
    if (d === 0) si = Math.min(N - 2, Math.max(0, Math.floor((this.pos.x - roadC(0)) / BLOCK)));
    if (d === 2) si = Math.min(N - 1, Math.max(1, Math.ceil((this.pos.x - roadC(0)) / BLOCK)));
    if (d === 1) sj = Math.min(N - 2, Math.max(0, Math.floor((this.pos.z - roadC(0)) / BLOCK)));
    if (d === 3) sj = Math.min(N - 1, Math.max(1, Math.ceil((this.pos.z - roadC(0)) / BLOCK)));
    if (!inGrid(si + DIRS[d][0], sj + DIRS[d][1])) d = (d + 2) % 4;
    const seg = segmentPiece(si, sj, d);
    const p = linePiece(this.pos.x, this.pos.z, seg.bx, seg.bz); p.seg = seg.seg;
    if (p.len < 3) { this.path = [seg]; this.s = seg.len - 1; }
    else { this.path = [p]; this.s = 0; }
    this.planAhead();
    this.mode = 'traffic';
  }

  /* ---------- per-frame */
  updateTraffic(dt, world) {
    const p = this.path[0];
    // speed target
    let target = p.type === 'curve' ? 6.5 : 11;
    const remaining = p.len - this.s;
    // signals at the end of a straight
    if (p.seg && this.path[1]?.node) {
      const n = this.path[1].node;
      const st = signalState(n.i, n.j, n.axis, world.time);
      if (st !== 'green' && remaining < 22 && !(st === 'yellow' && remaining < 6)) target = Math.min(target, Math.sqrt(Math.max(0, remaining - 0.5)) * 2.2);
    }
    // obstacles ahead
    let blockedBy = null;
    const look = 6 + this.aiSpeed * 1.1;
    for (const o of world.obstacles) {
      if (o === this) continue;
      const [lx, lz] = this.toLocal(o.pos.x, o.pos.z);
      if (lz > 0 && lz < look + this.t.L / 2 && Math.abs(lx) < (o.isPed ? 1.6 : 2.4)) {
        const gap = lz - this.t.L / 2 - (o.isPed ? 0.6 : o.t.L / 2);
        const v = Math.max(0, (gap - 2.5) * 1.3);
        if (v < target) { target = v; blockedBy = o; }
      }
    }
    if (blockedBy && blockedBy.isPlayerThing && this.aiSpeed < 0.5) {
      this.blocked += dt;
      if (this.blocked > 2.5 && this.honk <= 0) { this.honk = 2 + Math.random() * 2; world.sfx?.horn(this.pos); }
    } else this.blocked = 0;
    this.honk -= dt;
    const a = target > this.aiSpeed ? 4 : 9;
    this.aiSpeed += clamp(target - this.aiSpeed, -a * dt, a * dt);
    this.s += this.aiSpeed * dt;
    while (this.path.length && this.s >= this.path[0].len) { this.s -= this.path[0].len; this.path.shift(); this.planAhead(); }
    if (!this.path.length) { this.rejoin(); return; }
    const o = samplePiece(this.path[0], this.s, {});
    const prevH = this.heading;
    const nx = o.x, nz = o.z;
    this.vx = (nx - this.pos.x) / Math.max(dt, 1e-4); this.vz = (nz - this.pos.z) / Math.max(dt, 1e-4);
    this.pos.x = nx; this.pos.z = nz;
    this.heading = angleLerp(this.heading, o.h, damp(12, dt));
    this.yawRate = (this.heading - prevH) / Math.max(dt, 1e-4);
    this.pos.y = 0;
  }

  /** arcade driving physics. ctl = {throttle -1..1, steer -1..1 (+right), handbrake} */
  updatePhysics(dt, ctl, world) {
    const t = this.t;
    const [fx, fz] = this.forward();
    const rx = -fz, rz = fx; // world "left"?? -> compute lateral using right = (-cos h, sin h)
    let vf = this.vx * fx + this.vz * fz;
    let vl = this.vx * rx + this.vz * rz;
    const grounded = !this.airborne;
    const dead = this.dead;
    if (grounded) {
      // engine / brakes
      const thr = dead ? 0 : ctl.throttle;
      if (thr > 0) vf += (vf < -0.5 ? 18 : t.accel * (1 - Math.max(0, vf) / t.max * 0.85)) * thr * dt;
      else if (thr < 0) vf += (vf > 0.5 ? -18 : -t.accel * 0.6 * (vf > -12 ? 1 : 0)) * -thr * dt * (vf > 0.5 ? 1 : 1);
      // rolling resistance & drag
      vf -= vf * (0.25 + Math.abs(vf) * 0.006) * dt;
      if (!thr) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 2.2 * dt);
      if (ctl.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 7 * dt);
      // steering
      const steerTarget = ctl.steer * (0.62 - Math.min(0.38, Math.abs(vf) / 90));
      this.steer += (steerTarget - this.steer) * damp(9, dt);
      const yaw = (vf / t.wb) * Math.tan(this.steer);
      const grip = ctl.handbrake ? 1.3 : t.grip;
      this.yawRate += (-yaw - this.yawRate) * damp(ctl.handbrake ? 4 : grip, dt);
      vl *= Math.exp(-grip * dt);
      this.skid = Math.abs(vl) > 3 || (ctl.handbrake && Math.abs(vf) > 6) ? 1 : 0;
    } else {
      this.yawRate *= 1 - damp(0.8, dt);
    }
    this.heading += this.yawRate * dt;
    const nf = this.forward();
    const nrx = -nf[1], nrz = nf[0];
    this.vx = nf[0] * vf + nrx * vl; this.vz = nf[1] * vf + nrz * vl;
    this.lastAccel = vf - (this._pvf ?? vf); this._pvf = vf;

    // integrate
    this.pos.x += this.vx * dt; this.pos.z += this.vz * dt;
    // vertical: follow ground or fly
    const gh = Math.max(groundHeight(world.city, this.pos.x, this.pos.z), -0.6);
    if (this.airborne) {
      this.vy -= 22 * dt; this.pos.y += this.vy * dt; this.airTime += dt;
      if (this.pos.y <= gh) { this.pos.y = gh; this.airborne = false; this.land = this.airTime; this.vy = 0; }
    } else {
      const vyGround = (gh - this.pos.y) / Math.max(dt, 1e-4);
      if (gh < this.pos.y - 0.25 && this.lastVy > 1.5) { // left a ramp
        this.airborne = true; this.vy = this.lastVy; this.airTime = 0;
      } else { this.pos.y += (gh - this.pos.y) * Math.min(1, dt * 25); }
      this.lastVy = vyGround;
    }

    // collisions with the city (three circles)
    this.collideCity(world);
  }

  collideCity(world) {
    const [fx, fz] = this.forward();
    const r = this.t.W / 2 + 0.02, off = this.t.L / 2 - r;
    let impact = 0;
    for (const k of [1, 0, -1]) {
      const p = { x: this.pos.x + fx * off * k, z: this.pos.z + fz * off * k };
      const hit = collideCircle(world.city, p, r, { y: this.pos.y + 0.5 });
      if (hit) {
        this.pos.x += p.x - (this.pos.x + fx * off * k); this.pos.z += p.z - (this.pos.z + fz * off * k);
        const vn = this.vx * hit.nx + this.vz * hit.nz;
        if (vn < 0) {
          this.vx -= vn * hit.nx * 1.3; this.vz -= vn * hit.nz * 1.3;
          impact = Math.max(impact, -vn);
          // spin a bit when clipping corners
          if (k !== 0) this.yawRate += k * (hit.nx * fz - hit.nz * fx) * -vn * 0.12;
        }
      }
    }
    if (impact > 2) world.onCarImpact?.(this, impact, null);
  }

  damage(n, world) {
    if (this.dead) return;
    this.health -= n;
    if (this.health <= 0) { this.health = 0; this.burnTimer = 4.5; }
  }

  explode(world) {
    this.dead = true; this.mode = 'wreck';
    this.paint = this.paint; // keep shared material; swap to burnt one
    const burnt = mat('burnt', () => new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 1 }));
    this.body.material = burnt;
    this.vy = 6; this.airborne = true;
    world.onExplosion?.(this.pos.clone());
  }

  /** visuals: transforms, wheels, lights, body roll */
  sync(dt, time = 0, night = 0) {
    this.group.position.copy(this.pos);
    const vf = this.fwdSpeed;
    const latA = this.yawRate * vf;
    this.roll += (clamp(-latA * 0.006, -0.08, 0.08) - this.roll) * damp(6, dt || 1);
    this.pitch += (clamp(-this.lastAccel * 0.6, -0.06, 0.06) - this.pitch) * damp(5, dt || 1);
    this.group.rotation.set(0, this.heading, 0);
    this.group.rotateZ(this.roll); this.group.rotateX(this.pitch);
    if (this.airborne) this.group.rotateX(-clamp(this.vy * 0.02, -0.3, 0.3));
    this.wheelSpin += (vf / this.t.wheel) * dt;
    for (const w of this.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.pivot.rotation.y = w.front ? -this.steer * (this.mode === 'traffic' ? 0 : 1) : 0;
    }
    if (this.bar) {
      const on = this.siren;
      const ph = Math.floor(time * 6) % 2;
      this.bar.red.material.color.setRGB(on && ph ? 6 : 0.25, 0, 0);
      this.bar.blue.material.color.setRGB(0, on && !ph ? 1.2 : 0, on && !ph ? 8 : 0.25);
    }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

/** simple controller for police / chasing AI on the physics model */
export function chaseControl(car, tx, tz, world, aggressive = true) {
  const dx = tx - car.pos.x, dz = tz - car.pos.z, dist = Math.hypot(dx, dz);
  let gx = tx, gz = tz;
  if (dist > 45) {
    // route via road grid: head to the next node toward the target
    const i = roadIndex(car.pos.x), j = roadIndex(car.pos.z);
    const ti = roadIndex(tx), tj = roadIndex(tz);
    const onX = Math.abs(car.pos.z - roadC(j)) < ROAD; // on an east-west road
    const onZ = Math.abs(car.pos.x - roadC(i)) < ROAD;
    let ni = i, nj = j;
    if (onX && ti !== i) ni = i + Math.sign(ti - i);
    else if (onZ && tj !== j) nj = j + Math.sign(tj - j);
    else if (ti !== i) ni = i + Math.sign(ti - i); else nj = j + Math.sign(tj - j);
    // if far from the node line we are on, aim for the node itself
    gx = roadC(ni); gz = roadC(nj);
    if (Math.hypot(gx - car.pos.x, gz - car.pos.z) < 10) { gx = roadC(ti); gz = roadC(tj); }
  }
  const want = Math.atan2(gx - car.pos.x, gz - car.pos.z);
  let diff = ((want - car.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const ctl = { throttle: 1, steer: clamp(-diff * 2.2, -1, 1), handbrake: false };
  if (Math.abs(diff) > 1.2 && car.speed > 12) ctl.throttle = -0.5;
  if (dist < 12 && !aggressive) ctl.throttle = car.fwdSpeed > 2 ? -1 : 0;
  if (Math.abs(diff) > 2.4 && car.speed < 6) { ctl.throttle = -1; ctl.steer = -ctl.steer; }
  // stuck recovery
  if (car.speed < 1 && ctl.throttle > 0) car.stuck += world.dt; else car.stuck = Math.max(0, car.stuck - world.dt);
  if (car.stuck > 1.2) { car.reverseT = 1.2; car.stuck = 0; }
  if (car.reverseT > 0) { car.reverseT -= world.dt; ctl.throttle = -1; ctl.steer = -ctl.steer; }
  return ctl;
}

/** car-car collision resolution */
export function collideCars(a, b, world) {
  const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
  if (dx * dx + dz * dz > 49) return;
  if (Math.abs(a.pos.y - b.pos.y) > 1.4) return;
  let best = null;
  for (const ca of a.circles()) for (const cb of b.circles()) {
    const ex = cb.x - ca.x, ez = cb.z - ca.z, d = Math.hypot(ex, ez), m = ca.r + cb.r;
    if (d < m && d > 1e-4 && (!best || m - d > best.pen)) best = { nx: ex / d, nz: ez / d, pen: m - d };
  }
  if (!best) return;
  const ma = a.t.mass * (a.mode === 'parked' || a.mode === 'wreck' ? 1.5 : 1), mb = b.t.mass * (b.mode === 'parked' || b.mode === 'wreck' ? 1.5 : 1);
  const ka = mb / (ma + mb), kb = ma / (ma + mb);
  a.pos.x -= best.nx * best.pen * ka; a.pos.z -= best.nz * best.pen * ka;
  b.pos.x += best.nx * best.pen * kb; b.pos.z += best.nz * best.pen * kb;
  const rv = (b.vx - a.vx) * best.nx + (b.vz - a.vz) * best.nz;
  if (rv < 0) {
    const j = -(1.35) * rv / (1 / ma + 1 / mb);
    a.vx -= (j / ma) * best.nx; a.vz -= (j / ma) * best.nz;
    b.vx += (j / mb) * best.nx; b.vz += (j / mb) * best.nz;
    world.onCarImpact?.(a, -rv, b);
  }
}
