import * as THREE from 'three';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';
import { clamp, damp, angleLerp } from './util.js';
import { groundHeight, collideCircle, roadC, BLOCK, ROAD, N, CURB } from './city.js';

/**
 * Pedestrians and police officers on foot.
 * Each ped has its own skinned clone; clips are shared per model kind.
 */
export class PedFactory {
  /** kinds: { name: { gltf, clips: {idle, walk, run}, scale, tint(mat, rnd) } } */
  constructor(kinds) { this.kinds = kinds; }
  make(kind, scene, rnd = Math.random) {
    const k = this.kinds[kind];
    const model = skClone(k.gltf.scene);
    const root = new THREE.Group();
    root.add(model);
    model.scale.setScalar(k.scale);
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.frustumCulled = false;
        o.material = o.material.clone();
        k.tint?.(o.material, rnd, o);
      }
    });
    scene.add(root);
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const [n, clip] of Object.entries(k.clips)) actions[n] = mixer.clipAction(clip);
    return { root, model, mixer, actions, kind };
  }
}

let PID = 1;
export class Ped {
  constructor(parts, role = 'civ') {
    Object.assign(this, parts);
    this.id = PID++;
    this.role = role; // civ | cop | gang
    this.isPed = true;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.reset();
  }
  reset() {
    this.health = this.role === 'cop' ? 90 : this.role === 'gang' ? 70 : 50;
    this.state = 'walk';
    this.timer = 0; this.downT = 0; this.dead = false; this.fall = 0; this.fallDir = 0;
    this.speed = 1.3 + Math.random() * 0.35;
    this.cur = null; this.route = null; this.target = null;
    this.flee = null; this.fireCd = 1 + Math.random(); this.arrestT = 0;
    this.root.visible = true; this.model.rotation.set(0, 0, 0); this.model.position.set(0, 0, 0);
    this.deadT = 0; this.vy = 0; this.lootDropped = false; this.hostile = false; this.attackCd = 0;
    this.attackT = 0; this.vel.set(0, 0, 0);
  }
  play(name, fade = 0.25, ts = 1) {
    const a = this.actions[name];
    if (!a) return;
    if (this.cur === name) { a.setEffectiveTimeScale(ts); return; }
    a.reset().setEffectiveTimeScale(ts).setEffectiveWeight(1).fadeIn(fade).play();
    if (this.cur) this.actions[this.cur].fadeOut(fade);
    this.cur = name;
  }

  /** put on a sidewalk ring around block (bx,bz), at corner index c */
  setRing(bx, bz, c, dir) {
    this.ring = { bx, bz, c, dir };
    const p = ringCorner(bx, bz, c);
    this.pos.set(p[0], CURB, p[1]);
    this.nextCorner();
    this.state = 'walk';
  }
  nextCorner() {
    const r = this.ring;
    // occasionally cross the road to the neighbouring block
    if (Math.random() < 0.25) {
      const opts = crossOptions(r.bx, r.bz, r.c);
      if (opts.length) {
        const o = opts[(Math.random() * opts.length) | 0];
        r.bx = o.bx; r.bz = o.bz; r.c = o.c;
        this.target = ringCorner(r.bx, r.bz, r.c);
        this.crossing = true;
        return;
      }
    }
    this.crossing = false;
    r.c = (r.c + r.dir + 4) % 4;
    const p = ringCorner(r.bx, r.bz, r.c);
    // walk to a random point along the edge first sometimes (to spread out)
    this.target = p;
  }

  knock(vx, vz, up, dmg, world, cause = 'hit') {
    if (this.dead && this.state === 'down') { this.vel.x += vx * 0.3; this.vel.z += vz * 0.3; return; }
    this.health -= dmg;
    this.state = 'down';
    this.vel.set(vx, up, vz);
    this.downT = this.health > 0 ? 2.2 + Math.random() : 0;
    this.fallDir = Math.atan2(vx, vz) - this.heading;
    if (this.health <= 0) { this.dead = true; this.deadT = 0; world?.onPedDown?.(this, cause); }
    if (this.cur) this.actions[this.cur].timeScale = 0;
  }

  update(dt, world) {
    const city = world.city;
    this.attackCd -= dt; this.fireCd -= dt;
    let moveSpeed = 0, faceTo = null;
    if (this.state === 'down') {
      // tip over and slide
      this.fall = Math.min(1, this.fall + dt * 3.5);
      this.vel.y -= 22 * dt;
      this.pos.addScaledVector(this.vel, dt);
      const gh = groundHeight(city, this.pos.x, this.pos.z);
      if (this.pos.y <= gh) { this.pos.y = gh; this.vel.y = 0; this.vel.x *= 1 - damp(5, dt); this.vel.z *= 1 - damp(5, dt); }
      const hit = collideCircle(city, this.pos, 0.3);
      if (hit) { const vn = this.vel.x * hit.nx + this.vel.z * hit.nz; if (vn < 0) { this.vel.x -= vn * hit.nx * 1.5; this.vel.z -= vn * hit.nz * 1.5; } }
      if (this.dead) { this.deadT += dt; }
      else {
        this.downT -= dt;
        if (this.downT <= 0) {
          this.fall = 0;
          this.state = this.role === 'cop' ? 'chase' : this.hostile ? 'fight' : 'flee';
          this.timer = 8;
          if (this.cur) this.actions[this.cur].timeScale = 1;
        }
      }
      this.applyTransform(dt);
      return;
    }

    if (this.role === 'cop') {
      ({ moveSpeed, faceTo } = this.copBrain(dt, world));
    } else if (this.state === 'fight') {
      ({ moveSpeed, faceTo } = this.fightBrain(dt, world));
    } else if (this.state === 'flee') {
      this.timer -= dt;
      const f = this.flee || world.player.pos;
      let dx = this.pos.x - f.x, dz = this.pos.z - f.z; const d = Math.hypot(dx, dz) || 1;
      faceTo = [this.pos.x + dx / d, this.pos.z + dz / d];
      moveSpeed = 4.6;
      if (this.timer <= 0) { this.state = 'walk'; this.rejoin(); }
    } else if (this.state === 'idle') {
      this.timer -= dt;
      if (this.timer <= 0) this.state = 'walk';
    } else if (this.state === 'walk') {
      if (!this.target) this.rejoin();
      const dx = this.target[0] - this.pos.x, dz = this.target[1] - this.pos.z;
      if (Math.hypot(dx, dz) < 0.6) {
        this.nextCorner();
        if (!this.crossing && Math.random() < 0.15) { this.state = 'idle'; this.timer = 2 + Math.random() * 4; }
      }
      faceTo = this.target;
      moveSpeed = this.speed;
      // wait at the kerb if a car is coming while crossing
      if (this.crossing) {
        for (const c of world.cars) {
          if (c.speed < 2) continue;
          const [lx, lz] = c.toLocal(this.pos.x, this.pos.z);
          if (lz > 0 && lz < 16 && Math.abs(lx) < 3) { moveSpeed = 0; break; }
        }
      }
    }

    // locomotion
    if (faceTo) {
      const want = Math.atan2(faceTo[0] - this.pos.x, faceTo[1] - this.pos.z);
      this.heading = angleLerp(this.heading, want, damp(moveSpeed > 3 ? 10 : 6, dt));
    }
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const k = damp(8, dt);
    this.vel.x += (fx * moveSpeed - this.vel.x) * k; this.vel.z += (fz * moveSpeed - this.vel.z) * k;
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    const hit = collideCircle(city, this.pos, 0.3);
    if (hit && this.state === 'flee') this.heading += 0.9; // slide around obstacles
    const gh = groundHeight(city, this.pos.x, this.pos.z);
    this.pos.y += (gh - this.pos.y) * damp(20, dt);

    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (this.attackT > 0) { this.attackT -= dt; this.play('punch', 0.1, 1.5); }
    else if (sp < 0.25) this.play(this.role === 'cop' && this.aiming ? 'aim' : 'idle');
    else if (sp < 2.6) this.play('walk', 0.25, clamp(sp / 1.45, 0.6, 1.6));
    else this.play('run', 0.2, clamp(sp / 4.6, 0.8, 1.4));
    this.applyTransform(dt);
  }

  fightBrain(dt, world) {
    const p = world.player;
    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z, d = Math.hypot(dx, dz);
    if (p.dead || d > 40) { this.state = 'walk'; this.hostile = false; this.rejoin(); return { moveSpeed: 0, faceTo: null }; }
    if (d < 1.4) {
      if (this.attackCd <= 0 && p.inCar == null) {
        this.attackCd = 1.1 + Math.random() * 0.5; this.attackT = 0.55;
        setTimeout(() => { if (!this.dead && this.state === 'fight' && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) < 1.8) world.damagePlayer(8, this.pos); }, 300);
      }
      return { moveSpeed: 0, faceTo: [p.pos.x, p.pos.z] };
    }
    return { moveSpeed: 4.4, faceTo: [p.pos.x, p.pos.z] };
  }

  copBrain(dt, world) {
    const p = world.player;
    const stars = world.wanted.level;
    this.aiming = false;
    if (stars === 0 || p.dead) {
      // walk back to a sidewalk & resume
      if (this.state !== 'walk') { this.state = 'walk'; this.rejoin(); }
      if (!this.target) this.rejoin();
      const dx = this.target[0] - this.pos.x, dz = this.target[1] - this.pos.z;
      if (Math.hypot(dx, dz) < 0.6) this.nextCorner();
      return { moveSpeed: 1.4, faceTo: this.target };
    }
    this.state = 'chase';
    const tx = p.pos.x, tz = p.pos.z;
    const dx = tx - this.pos.x, dz = tz - this.pos.z, d = Math.hypot(dx, dz);
    world.wanted.seen(this.pos, d);
    const inCar = p.inCar;
    // arrest when close
    const canArrest = stars <= 2 && !p.dead;
    if (canArrest && d < (inCar ? 3.2 : 1.6) && (!inCar || inCar.speed < 1.5) && (inCar || p.speedH < 4.5)) {
      this.arrestT += dt;
      if (this.arrestT > (inCar ? 1.6 : 0.9)) world.bust();
      return { moveSpeed: 0, faceTo: [tx, tz] };
    }
    this.arrestT = Math.max(0, this.arrestT - dt);
    if (stars >= 2 && d < 32) {
      const los = world.lineOfSight(this.pos, p.pos);
      if (los) {
        this.aiming = true;
        if (this.fireCd <= 0) {
          this.fireCd = 0.7 + Math.random() * 0.8;
          world.copShoot(this, d);
        }
        // keep some distance
        const want = stars >= 3 ? 12 : 6;
        if (d > want + 4) return { moveSpeed: 3.8, faceTo: [tx, tz] };
        if (d < want - 4) return { moveSpeed: 0, faceTo: [tx, tz] };
        return { moveSpeed: 0, faceTo: [tx, tz] };
      }
    }
    return { moveSpeed: d > 2 ? 5.0 : 0, faceTo: [tx, tz] };
  }

  rejoin() {
    // nearest block ring
    const bx = clamp(Math.floor((this.pos.x - roadC(0)) / BLOCK), 0, N - 2), bz = clamp(Math.floor((this.pos.z - roadC(0)) / BLOCK), 0, N - 2);
    let best = 0, bd = Infinity;
    for (let c = 0; c < 4; c++) { const p = ringCorner(bx, bz, c); const d = Math.hypot(p[0] - this.pos.x, p[1] - this.pos.z); if (d < bd) { bd = d; best = c; } }
    this.ring = { bx, bz, c: best, dir: Math.random() < 0.5 ? 1 : -1 };
    this.target = ringCorner(bx, bz, best);
    this.crossing = true; // treat as crossing until we reach it (waits for cars)
  }

  applyTransform(dt) {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.heading;
    // knocked-down pose: tip the whole body over around the feet
    const f = this.state === 'down' ? this.fall : 0;
    const e = 1 - (1 - f) ** 3;
    this.model.rotation.set(-Math.cos(this.fallDir) * e * Math.PI / 2, 0, Math.sin(this.fallDir) * e * Math.PI / 2);
    this.model.position.y = e * 0.12;
    this.mixer.update(dt);
  }

  dispose(scene) { scene.remove(this.root); this.mixer.stopAllAction(); }
}

/* ---------------- sidewalk rings */
const INSET = ROAD / 2 + 1.8;
export function ringCorner(bx, bz, c) {
  const x0 = roadC(bx) + INSET, x1 = roadC(bx + 1) - INSET, z0 = roadC(bz) + INSET, z1 = roadC(bz + 1) - INSET;
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]][c];
}
function crossOptions(bx, bz, c) {
  // from corner c, the blocks across the road to the left/right/front
  const out = [];
  const add = (nbx, nbz, nc) => { if (nbx >= 0 && nbz >= 0 && nbx < N - 1 && nbz < N - 1) out.push({ bx: nbx, bz: nbz, c: nc }); };
  if (c === 0) { add(bx - 1, bz, 1); add(bx, bz - 1, 3); }
  if (c === 1) { add(bx + 1, bz, 0); add(bx, bz - 1, 2); }
  if (c === 2) { add(bx + 1, bz, 3); add(bx, bz + 1, 1); }
  if (c === 3) { add(bx - 1, bz, 2); add(bx, bz + 1, 0); }
  return out;
}
