import * as THREE from 'three';

/** Pooled point-sprite particles with per-particle colour, size and fade. */
export class Particles {
  constructor(scene, max = 1500, additive = false) {
    this.max = max;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute vec4 color; attribute float size; varying vec4 vC;
        void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=size*300./-mv.z; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying vec4 vC; void main(){ vec2 p=gl_PointCoord-.5; float d=length(p); if(d>.5)discard; gl_FragColor=vec4(vC.rgb, vC.a*smoothstep(.5,.15,d)); }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.p = [];
  }
  emit(x, y, z, { vx = 0, vy = 0, vz = 0, life = 1, size = 1, grow = 0, color = [1, 1, 1], alpha = 1, gravity = 0, drag = 0 } = {}) {
    if (this.p.length >= this.max) this.p.shift();
    this.p.push({ x, y, z, vx, vy, vz, life, max: life, size, grow, color, alpha, gravity, drag });
  }
  update(dt) {
    const { pos, col, size } = this;
    let n = 0;
    for (let i = this.p.length - 1; i >= 0; i--) {
      const q = this.p[i];
      q.life -= dt;
      if (q.life <= 0) { this.p.splice(i, 1); continue; }
      q.vy -= q.gravity * dt; const d = 1 - q.drag * dt;
      q.vx *= d; q.vy *= d; q.vz *= d;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      q.size += q.grow * dt;
    }
    for (const q of this.p) {
      pos[n * 3] = q.x; pos[n * 3 + 1] = q.y; pos[n * 3 + 2] = q.z;
      const t = q.life / q.max;
      col[n * 4] = q.color[0]; col[n * 4 + 1] = q.color[1]; col[n * 4 + 2] = q.color[2]; col[n * 4 + 3] = q.alpha * Math.min(1, t * 2);
      size[n] = q.size; n++;
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.color.needsUpdate = true; this.geo.attributes.size.needsUpdate = true;
  }
}

/** Short-lived line tracers. */
export class Tracers {
  constructor(scene) {
    this.max = 64;
    this.geo = new THREE.BufferGeometry();
    this.arr = new Float32Array(this.max * 6);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.arr, 3));
    this.lines = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    this.list = [];
  }
  add(a, b) { this.list.push({ a: a.clone(), b: b.clone(), life: 0.06 }); if (this.list.length > this.max) this.list.shift(); }
  update(dt) {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) { this.list[i].life -= dt; if (this.list[i].life <= 0) this.list.splice(i, 1); }
    for (const t of this.list) { t.a.toArray(this.arr, n * 6); t.b.toArray(this.arr, n * 6 + 3); n++; }
    this.geo.setDrawRange(0, n * 2);
    this.geo.attributes.position.needsUpdate = true;
  }
}
