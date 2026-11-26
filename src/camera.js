import * as THREE from 'three';
import { clamp, damp, angleLerp } from './util.js';
import { rayBuildings } from './city.js';

/** Third-person camera: orbit on foot, over-the-shoulder when aiming, chase cam in cars. */
export class GameCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = Math.PI; this.pitch = 0.28;
    this.dist = 5; this.targetDist = 5;
    this.target = new THREE.Vector3();
    this.sensitivity = 0.0024;
    this.shake = 0; this.lastMouse = 10; this.aimK = 0; this.fovKick = 0;
    this.carDist = 7.5;
  }
  basis() {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    return { fx, fz, rx: -fz, rz: fx };
  }
  aimPitch() { return this.pitch - 0.12; }
  /** world-space ray through the screen centre */
  ray() {
    const d = new THREE.Vector3(); this.camera.getWorldDirection(d);
    return { o: this.camera.position.clone(), d };
  }

  snap(focus) { this.target.copy(focus); this.update(1, focus, null, { instant: true }); }

  update(dt, focus, input, { car = null, aiming = false, city = null, instant = false } = {}) {
    this.lastMouse += dt;
    if (input) {
      if (input.mouseDX || input.mouseDY) this.lastMouse = 0;
      const sens = this.sensitivity * (aiming ? 0.6 : 1);
      this.yaw -= input.mouseDX * sens;
      this.pitch = clamp(this.pitch + input.mouseDY * sens, -0.5, 1.2);
      if (input.down('ArrowLeft')) { this.yaw += 2.2 * dt; this.lastMouse = 0; }
      if (input.down('ArrowRight')) { this.yaw -= 2.2 * dt; this.lastMouse = 0; }
      if (input.down('ArrowUp')) this.pitch = clamp(this.pitch + 1.2 * dt, -0.5, 1.2);
      if (input.down('ArrowDown')) this.pitch = clamp(this.pitch - 1.2 * dt, -0.5, 1.2);
      if (input.hit('KeyV')) { const opts = car ? [6, 7.5, 10.5] : [3.5, 5, 7.5]; const cur = car ? this.carDist : this.targetDist; const i = (opts.findIndex((o) => Math.abs(o - cur) < 0.1) + 1) % opts.length; if (car) this.carDist = opts[i]; else this.targetDist = opts[i]; }
      if (!car) this.targetDist = clamp(this.targetDist + input.wheel * 0.6, 2.5, 10);
      else this.carDist = clamp(this.carDist + input.wheel * 0.8, 5, 14);
    }
    this.aimK += ((aiming ? 1 : 0) - this.aimK) * (instant ? 1 : damp(12, dt));
    let dist = car ? this.carDist + car.t.L * 0.25 : this.targetDist;
    if (car) {
      // swing behind the car when the player isn't steering the camera
      if (this.lastMouse > 1.4 && car.speed > 2) {
        const behind = car.heading + (car.fwdSpeed < -1 ? 0 : Math.PI);
        this.yaw = angleLerp(this.yaw, behind, damp(2.4, dt));
        this.pitch += (0.2 - this.pitch) * damp(1.5, dt);
      }
      dist += Math.min(3, car.speed * 0.05);
    }
    dist = dist * (1 - this.aimK) + 2.1 * this.aimK;
    const k = instant ? 1 : damp(car ? 9 : 14, dt);
    this.target.lerp(focus, k);
    this.dist += (dist - this.dist) * (instant ? 1 : damp(7, dt));

    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    // over-the-shoulder offset when aiming
    const side = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw)).multiplyScalar(-0.55 * this.aimK);
    const tgt = this.target.clone().add(side); tgt.y += 0.1 * this.aimK;
    let d = this.dist;
    if (city) {
      const hit = rayBuildings(city, tgt.x, tgt.y, tgt.z, dir.x, dir.y, dir.z, d + 0.3);
      if (hit < d + 0.3) d = Math.max(1.0, hit - 0.35);
    }
    const pos = tgt.clone().addScaledVector(dir, d);
    pos.y = Math.max(pos.y, (focus.y - 1.4) + 0.4);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const s = this.shake * 0.3;
      pos.x += (Math.random() - 0.5) * s; pos.y += (Math.random() - 0.5) * s; pos.z += (Math.random() - 0.5) * s;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(tgt);
    const fov = 60 - this.aimK * 12 + (car ? Math.min(14, car.speed * 0.25) : 0) + this.fovKick;
    this.fovKick *= 1 - damp(8, dt);
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov += (fov - this.camera.fov) * damp(5, dt); this.camera.updateProjectionMatrix(); }
  }
}
