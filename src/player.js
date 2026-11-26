import * as THREE from 'three';
import { clamp, damp, angleLerp } from './util.js';
import { groundHeight, collideCircle } from './city.js';
import { GluteJiggle } from './jiggle.js';

const RADIUS = 0.32;
const GRAVITY = 24;
const JUMP_V = 7.2;
const SPEEDS = { walk: 1.6, run: 5.0, sprint: 7.6, aim: 2.2, crouch: 1.8 };
const CLIP_SPEED = { walk: 1.5, run: 4.6, sprint: 7.0, crouchWalk: 1.3, gunWalk: 1.4, gunRun: 5.0, aimWalk: 1.3 };

export class Player {
  constructor(gltf, extraClips, scene) {
    this.root = new THREE.Group();
    this.model = gltf.scene;
    this.root.add(this.model);
    scene.add(this.root);
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.frustumCulled = false;
        o.material = o.material.clone(); o.material.roughness = 0.85; o.material.metalness = 0;
      }
    });
    this.hand = this.model.getObjectByName('mixamorigRightHand');
    this.leftHand = this.model.getObjectByName('mixamorigLeftHand');
    this.head = this.model.getObjectByName('mixamorigHead');

    // animations: built-in clips + extra Mixamo clips, root locked horizontally
    this.mixer = new THREE.AnimationMixer(this.model);
    const hips = this.model.getObjectByName('mixamorigHips');
    const rest = hips.position.clone();
    this.actions = {};
    for (const clip of [...gltf.animations, ...extraClips]) {
      const t = clip.tracks.find((tr) => tr.name === 'mixamorigHips.position');
      if (t) {
        const v = t.values;
        // extra clips come from raw Mixamo (Y-bot proportions): scale height to this rig
        const isExtra = extraClips.includes(clip);
        const base = isExtra ? v[1] : 0;
        for (let i = 0; i < v.length; i += 3) {
          v[i] = rest.x; v[i + 2] = rest.z;
          if (isExtra) v[i + 1] = rest.y + (v[i + 1] - base) * 0.95;
          if (clip.name === 'jump' || clip.name === 'fall') v[i + 1] = Math.min(v[i + 1], rest.y);
        }
      }
      this.actions[clip.name] = this.mixer.clipAction(clip);
    }
    this.current = null;
    this.play('idle', 0);
    this.jiggle = new GluteJiggle(this.model, this.root);

    // gun prop (positioned every frame from the hand / aim direction)
    this.gun = makeGun();
    scene.add(this.gun);
    this.gun.visible = false;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.reset(new THREE.Vector3());
  }

  reset(p, heading = 0) {
    this.pos.copy(p); this.vel.set(0, 0, 0);
    this.facing = heading; this.onGround = true; this.airTime = 0;
    this.health = 100; this.armor = 0; this.dead = false; this.downT = 0;
    this.inCar = null; this.carState = null; this.carT = 0; this.carTarget = null;
    this.attackT = 0; this.combo = 0; this.comboT = 0; this.attackHit = false;
    this.aiming = false; this.fireCd = 0; this.jumpTimer = 0; this.landTimer = 0; this.crouch = false;
    this.root.visible = true; this.model.rotation.set(0, 0, 0); this.model.position.set(0, 0, 0);
    this.stepTimer = 0; this.hurtT = 0; this.speedH = 0; this.waving = 0;
  }

  play(name, fade = 0.18, { once = false, timeScale = 1, at = 0 } = {}) {
    if (this.current === name) return this.actions[name];
    const next = this.actions[name];
    if (!next) return null;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.time = at;
    next.setEffectiveTimeScale(timeScale);
    next.setEffectiveWeight(1);
    next.fadeIn(fade).play();
    if (this.current) this.actions[this.current].fadeOut(fade);
    this.current = name;
    return next;
  }

  get focus() {
    if (this.inCar && this.carState === 'driving') return new THREE.Vector3(this.inCar.pos.x, this.inCar.pos.y + 1.6, this.inCar.pos.z);
    return new THREE.Vector3(this.pos.x, this.pos.y + (this.crouch ? 1.1 : 1.5), this.pos.z);
  }

  /* ------------------------------------------------------------ on foot */
  update(dt, input, cam, world) {
    const city = world.city;
    const ctl = !!input && !this.dead;
    this.fireCd -= dt; this.hurtT -= dt; this.comboT -= dt;
    let event = null;

    // ---- in / entering / exiting car
    if (this.carState) return this.updateCar(dt, input, cam, world);

    if (this.dead) {
      this.downT += dt;
      this.vel.y -= GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      this.vel.x *= 1 - damp(3, dt); this.vel.z *= 1 - damp(3, dt);
      const gh = groundHeight(city, this.pos.x, this.pos.z);
      if (this.pos.y < gh) { this.pos.y = gh; this.vel.y = 0; }
      const e = Math.min(1, this.downT * 2.5);
      this.root.position.copy(this.pos); this.root.rotation.y = this.facing;
      this.model.rotation.x = -(1 - (1 - e) ** 3) * Math.PI / 2; this.model.position.y = e * 0.15;
      this.play('fall', 0.2);
      this.mixer.update(dt * (1 - e * 0.9));
      return null;
    }

    let ix = 0, iz = 0;
    if (ctl) {
      if (input.down('KeyW')) iz += 1;
      if (input.down('KeyS')) iz -= 1;
      if (input.down('KeyD')) ix += 1;
      if (input.down('KeyA')) ix -= 1;
      if (input.hit('KeyC')) this.crouch = !this.crouch;
      if (input.hit('KeyE') && this.onGround) this.waving = 1.6;
    }
    const armed = world.weapon === 'gun';
    this.aiming = ctl && armed && input.mouse(2);
    const firing = ctl && armed && input.mouse(0) && world.ammo > 0;
    const sprint = ctl && input.down('ShiftLeft', 'ShiftRight') && !this.aiming && !this.crouch;
    const { fx, fz, rx, rz } = cam.basis();
    let dx = fx * iz + rx * ix, dz = fz * iz + rz * ix;
    const len = Math.hypot(dx, dz);
    if (len > 0) { dx /= len; dz /= len; this.waving = 0; if (sprint) this.crouch = false; }

    // melee
    if (ctl && !armed && input.hit('Mouse0') && this.attackT <= 0 && this.onGround) {
      this.combo = this.comboT > 0 ? (this.combo + 1) % 3 : 0;
      this.attackT = this.combo === 2 ? 0.75 : 0.5; this.comboT = 0.9; this.attackHit = false;
      this.facing = Math.atan2(fx, fz) * 0 + (len > 0 ? Math.atan2(dx, dz) : this.facing);
      world.sfx.whoosh();
    }
    if (this.attackT > 0) {
      this.attackT -= dt;
      const total = this.combo === 2 ? 0.75 : 0.5;
      if (!this.attackHit && this.attackT < total * 0.55) { this.attackHit = true; event = { type: 'melee', kick: this.combo === 2 }; }
    }

    // shooting faces the camera
    if (this.aiming || firing) this.facing = angleLerp(this.facing, Math.atan2(fx, fz), damp(20, dt));
    if (firing && this.fireCd <= 0) { this.fireCd = 0.11; event = { type: 'shoot' }; }

    let target = this.crouch ? SPEEDS.crouch : this.aiming ? SPEEDS.aim : sprint ? SPEEDS.sprint : SPEEDS.run;
    if (ctl && input.down('AltLeft')) target = SPEEDS.walk;
    if (this.attackT > 0) target = 0;
    const accel = this.onGround ? (len > 0 ? 12 : 16) : 2.5;
    const k = damp(accel, dt);
    this.vel.x += (dx * target - this.vel.x) * k; this.vel.z += (dz * target - this.vel.z) * k;

    // jump
    this.jumpTimer -= dt; this.landTimer -= dt;
    if (ctl && input.hit('Space') && this.onGround && this.attackT <= 0) {
      this.vel.y = JUMP_V; this.onGround = false; this.jumpTimer = 0.4; this.crouch = false; world.sfx.jump();
    }

    // move + collide
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    collideCircle(city, this.pos, RADIUS, { y: this.pos.y + 0.3 });
    // cars are solid
    for (const c of world.cars) {
      if (Math.abs(c.pos.x - this.pos.x) > 5 || Math.abs(c.pos.z - this.pos.z) > 5) continue;
      if (this.pos.y > c.pos.y + c.t.top + 0.2) continue;
      const [lx, lz] = c.toLocal(this.pos.x, this.pos.z);
      const hw = c.t.W / 2 + RADIUS, hl = c.t.L / 2 + RADIUS;
      if (Math.abs(lx) < hw && Math.abs(lz) < hl) {
        const px = hw - Math.abs(lx), pz = hl - Math.abs(lz);
        const s = Math.sin(c.heading), co = Math.cos(c.heading);
        if (px < pz) { const sg = Math.sign(lx) || 1; this.pos.x += -co * px * sg; this.pos.z += s * px * sg; }
        else { const sg = Math.sign(lz) || 1; this.pos.x += s * pz * sg; this.pos.z += co * pz * sg; }
      }
    }

    // vertical
    const gh = groundHeight(city, this.pos.x, this.pos.z);
    const wasGround = this.onGround;
    if (this.onGround && gh <= this.pos.y + 0.45 && gh >= this.pos.y - 0.45) { this.pos.y += (gh - this.pos.y) * Math.min(1, dt * 30); this.vel.y = 0; }
    else {
      this.vel.y -= GRAVITY * dt; this.pos.y += this.vel.y * dt;
      if (this.pos.y <= gh) {
        this.pos.y = gh;
        if (!wasGround || this.vel.y < 0) {
          if (this.airTime > 0.9) { this.landTimer = 0.4; this.jiggle.thump(1); }
          if (this.airTime > 0.1) world.sfx.land(this.airTime > 0.9);
          if (this.airTime > 1.5) world.damagePlayer((this.airTime - 1.2) * 40, null, true);
        }
        this.vel.y = 0; this.onGround = true; this.airTime = 0;
      } else { this.onGround = false; this.airTime += dt; }
    }
    // swimming is not a thing in Port Isaac
    if (this.pos.y < -1.0 && !this.dead) world.damagePlayer(200, null, true, 'drown');

    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speedH = hs;
    if (len > 0 && !this.aiming && !firing && this.attackT <= 0) this.facing = angleLerp(this.facing, Math.atan2(dx, dz), damp(this.onGround ? 12 : 5, dt));
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.facing;
    this.model.rotation.set(0, 0, 0); this.model.position.set(0, 0, 0);

    if (this.onGround && hs > 1) {
      this.stepTimer -= dt * hs;
      if (this.stepTimer <= 0) { world.sfx.step(); this.stepTimer = 1.6; }
    }
    this.animate(dt, hs, armed, firing);
    this.mixer.update(dt);
    this.jiggle.update(dt, 0);
    this.updateGun(armed, cam);
    return event;
  }

  animate(dt, hs, armed, firing) {
    this.waving -= dt;
    let name = 'idle', ts = 1;
    const opts = {};
    if (this.attackT > 0) {
      name = ['punchL', 'punchR', 'kick'][this.combo]; ts = this.combo === 2 ? 1.9 : 1.6;
      opts.once = true;
    } else if (!this.onGround) name = this.jumpTimer > 0 ? 'jump' : 'fall';
    else if (this.landTimer > 0 && hs < 1) { name = 'land'; ts = 1.7; opts.once = true; }
    else if (this.aiming || firing) { name = hs > 0.4 ? 'aimWalk' : firing ? 'fire' : 'aim'; if (name === 'aimWalk') ts = clamp(hs / CLIP_SPEED.aimWalk, 0.7, 1.6); }
    else if (this.crouch) { name = hs > 0.3 ? 'crouchWalk' : 'crouchIdle'; ts = clamp(hs / CLIP_SPEED.crouchWalk, 0.6, 1.6); }
    else if (armed) {
      if (hs < 0.4) name = 'gunIdle';
      else if (hs < 3) { name = 'gunWalk'; ts = clamp(hs / CLIP_SPEED.gunWalk, 0.7, 1.8); }
      else { name = 'gunRun'; ts = clamp(hs / CLIP_SPEED.gunRun, 0.8, 1.5); }
    }
    else if (hs < 0.4) name = this.waving > 0 ? 'wave' : this.hurtT > 0 ? 'fightIdle' : 'idle';
    else if (hs < 2.6) { name = 'walk'; ts = clamp(hs / CLIP_SPEED.walk, 0.7, 1.8); }
    else if (hs < 6.4) { name = 'run'; ts = clamp(hs / CLIP_SPEED.run, 0.7, 1.5); }
    else { name = 'sprint'; ts = clamp(hs / CLIP_SPEED.sprint, 0.8, 1.4); }
    if (name === 'jump') { opts.once = true; opts.at = 0.25; ts = 1.3; }
    opts.timeScale = ts;
    if (this.attackT > 0 && this.current !== name) {
      // restart even if the same punch is repeated
      this.current = null;
    }
    this.play(name, name.startsWith('punch') || name === 'kick' ? 0.08 : 0.18, opts);
    if (this.current === name && !opts.once) this.actions[name].setEffectiveTimeScale(ts);
  }

  updateGun(armed, cam) {
    const show = armed && !this.inCar && !this.dead;
    this.gun.visible = show;
    if (!show) return;
    this.model.updateMatrixWorld(true);
    const hp = this.hand.getWorldPosition(new THREE.Vector3());
    this.gun.position.copy(hp);
    const aimed = this.aiming || this.current === 'fire' || this.current === 'aim' || this.current === 'aimWalk';
    const pitch = aimed ? -cam.aimPitch() : 0.55;
    this.gun.rotation.set(0, this.facing, 0, 'YXZ');
    this.gun.rotateX(pitch);
  }

  muzzle(out = new THREE.Vector3()) {
    return out.set(0, 0.04, 0.55).applyMatrix4(this.gun.matrixWorld);
  }

  /* ------------------------------------------------------------ cars */
  beginEnter(car, jack) {
    this.carState = 'toCar'; this.inCar = car; this.carT = 0; this.jack = jack;
    this.attackT = 0; this.aiming = false;
  }

  updateCar(dt, input, cam, world) {
    const car = this.inCar;
    this.carT += dt;
    const door = car.doorPos(new THREE.Vector3());
    const seat = car.seatPos(new THREE.Vector3());
    if (this.carState === 'toCar') {
      const dx = door.x - this.pos.x, dz = door.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.35 || this.carT > 2.5) { this.carState = 'entering'; this.carT = 0; this.enterFrom = this.pos.clone(); world.onCarDoor?.(car); }
      else {
        const sp = Math.min(5, d * 4);
        this.pos.x += (dx / d) * sp * dt; this.pos.z += (dz / d) * sp * dt;
        this.pos.y = groundHeight(world.city, this.pos.x, this.pos.z);
        this.facing = angleLerp(this.facing, Math.atan2(dx, dz), damp(12, dt));
        this.play(d > 1.5 ? 'run' : 'walk');
      }
    } else if (this.carState === 'entering') {
      const T = 1.15;
      const t = Math.min(1, this.carT / T);
      const e = t * t * (3 - 2 * t);
      this.play('enterCar', 0.1, { once: true, timeScale: 3.4, at: 0.9 });
      // slide from the door into the seat during the second half
      const k = clamp((t - 0.35) / 0.65, 0, 1);
      this.pos.lerpVectors(door, seat, k);
      this.pos.y = car.pos.y + k * 0.1;
      this.facing = angleLerp(this.facing, car.heading - Math.PI / 2 * (1 - k), damp(14, dt));
      if (t >= 1) { this.carState = 'driving'; world.onEnteredCar?.(car); }
    } else if (this.carState === 'driving') {
      this.pos.copy(seat); this.pos.y = car.pos.y + 0.12;
      this.facing = car.heading;
      this.play('drive', 0.25);
      if (input && input.hit('KeyF')) {
        if (car.speed < 9) { this.carState = 'exiting'; this.carT = 0; world.onLeaveCar?.(car, false); }
        else { // bail out
          this.carState = null; this.inCar = null;
          this.pos.copy(door); this.vel.set(car.vx * 0.7 + Math.cos(car.heading) * 3, 2, car.vz * 0.7 - Math.sin(car.heading) * 3);
          this.onGround = false; this.facing = car.heading;
          world.onLeaveCar?.(car, true);
          world.damagePlayer(Math.min(30, car.speed * 0.8), null, true);
          this.play('roll', 0.1, { once: true });
          return null;
        }
      }
    } else if (this.carState === 'exiting') {
      const T = 1.0, t = Math.min(1, this.carT / T);
      this.play('exitCar', 0.1, { once: true, timeScale: 3.6, at: 1.2 });
      const k = clamp(t / 0.7, 0, 1);
      this.pos.lerpVectors(seat, door, k);
      this.pos.y = car.pos.y + (1 - k) * 0.12;
      this.facing = car.heading - (Math.PI / 2) * k;
      if (t >= 1) {
        this.carState = null; this.inCar = null;
        this.pos.y = groundHeight(world.city, this.pos.x, this.pos.z); this.vel.set(0, 0, 0); this.onGround = true;
      }
    }
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.facing, 0);
    if (this.carState === 'driving' || this.carState === 'entering' || this.carState === 'exiting') {
      // tilt with the car body
      this.root.rotation.set(car.group.rotation.x, this.facing, car.group.rotation.z, 'YXZ');
    }
    this.mixer.update(dt);
    this.jiggle.update(dt, 0);
    this.gun.visible = false;
    return null;
  }
}

function makeGun() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, metalness: 0.6, roughness: 0.4 });
  const add = (w, h, d, x, y, z, rx = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.rotation.x = rx; b.castShadow = true; g.add(b); };
  add(0.06, 0.09, 0.42, 0, 0.03, 0.12);   // receiver
  add(0.03, 0.03, 0.3, 0, 0.05, 0.45);    // barrel
  add(0.05, 0.14, 0.05, 0, -0.06, 0.02, 0.2); // grip
  add(0.05, 0.16, 0.06, 0, -0.07, 0.2, -0.15); // mag
  add(0.05, 0.08, 0.22, 0, 0.0, -0.18);   // stock
  return g;
}
