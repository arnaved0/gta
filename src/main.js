import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';
import './style.css';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { GameCamera } from './camera.js';
import { Player } from './player.js';
import { Particles, Tracers } from './fx.js';
import { Retargeter } from './retarget.js';
import { PedFactory, Ped, ringCorner } from './peds.js';
import { Car, TRAFFIC_MIX, DIRS, signalState, chaseControl, collideCars, TYPES } from './vehicles.js';
import {
  buildCity, groundHeight, rayBuildings, districtAt, DISTRICTS, roadC, roadIndex, N, BLOCK, ROAD, LANE, BOUNDS, MAP_SCALE,
  BEACH_X, WATER_X, CURB, glowTex, SPECIAL,
} from './city.js';
import { clamp, damp, lerp } from './util.js';
import { Missions } from './missions.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;
const V = `?v=${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`;
const QUALITY = new URLSearchParams(location.search).get('q') || 'high'; // high | med | low

/* ================================================================== renderer */
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY === 'low' ? 1 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = QUALITY !== 'low';
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffb07a, 190, 700);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2500);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
let gtao = null;
if (QUALITY === 'high') {
  gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1.5, thickness: 2.5, scale: 1.2, samples: 12 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
}
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.3, 0.45, 1.05);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// film grade: split toning (warm highlights, cool shadows), contrast curve, saturation, vignette, grain, edge fringing
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uNight: { value: 0 }, uRes: { value: new THREE.Vector2(innerWidth, innerHeight) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uNight; uniform vec2 uRes; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; float r2 = dot(d, d);
      vec2 off = d * r2 * 0.006;
      vec3 c = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // split toning
      vec3 shadowTint = mix(vec3(0.94, 1.0, 1.08), vec3(0.88, 0.95, 1.15), uNight);
      vec3 highTint = mix(vec3(1.07, 1.0, 0.9), vec3(1.05, 0.98, 0.92), uNight);
      c *= mix(shadowTint, highTint, smoothstep(0.15, 0.75, l));
      // saturation & S-curve
      c = mix(vec3(l), c, 1.14);
      c = clamp(c, 0.0, 1.0);
      c = clamp((c - 0.45) * 1.08 + 0.45, 0.0, 1.0);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.25 * smoothstep(0.15, 0.5, l));
      // vignette + grain
      c *= 1.0 - smoothstep(0.18, 0.75, r2 * 1.6) * mix(0.38, 0.22, uNight);
      c += (hash(vUv * uRes + fract(uTime) * 100.0) - 0.5) * 0.025;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(grade);
const smaa = QUALITY !== 'low' ? new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio()) : null;
if (smaa) composer.addPass(smaa);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  grade.uniforms.uRes.value.set(innerWidth, innerHeight);
});

/* ================================================================== loading-screen slideshow */
const slideshow = (() => {
  const els = [...document.querySelectorAll('#slides .slide')];
  const cards = [0, 1, 2].map((i) => `${BASE}art/card${i}.jpg${V}`);
  cards.forEach((u) => { const im = new Image(); im.src = u; });
  let i = Math.floor(Math.random() * cards.length), layer = 0, timer = null;
  function next() {
    const el = els[layer], other = els[1 - layer];
    el.style.backgroundImage = `url("${cards[i]}")`;
    el.className = `slide on kb${i % 3}`;
    void el.offsetWidth;
    other.classList.remove('on');
    layer = 1 - layer; i = (i + 1) % cards.length;
  }
  return {
    start() { if (timer) return; $('slides').classList.remove('hidden'); next(); timer = setInterval(next, 7000); },
    stop() { clearInterval(timer); timer = null; $('slides').classList.add('hidden'); },
  };
})();
slideshow.start();

/* ================================================================== loading */
const manager = new THREE.LoadingManager();
let loaded = 0;
const setProgress = (k, msg) => { $('load-bar').style.width = `${k * 100}%`; if (msg) $('load-text').textContent = msg; };
const gltfLoader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
const loadGLTF = (u) => new Promise((res, rej) => gltfLoader.load(BASE + u + V, (g) => { setProgress(++loaded / 6); res(g); }, undefined, rej));
const loadJSON = (u) => fetch(BASE + u + V).then((r) => r.json()).then((j) => { setProgress(++loaded / 6); return j; });

const [playerGltf, extraJson, xbotGltf, michelleGltf, soldierGltf] = await Promise.all([
  loadGLTF('models/player.gltf.json'), loadJSON('anims/extra.json'),
  loadGLTF('models/xbot.gltf.json'), loadGLTF('models/michelle.gltf.json'), loadGLTF('models/soldier.gltf.json'),
]).catch((e) => { $('load-text').textContent = 'Failed to load: ' + e.message; throw e; });
setProgress(0.85, 'Building Port Isaac');
await new Promise((r) => setTimeout(r, 30));

const extraClips = extraJson.map((j) => THREE.AnimationClip.parse(j));
const playerRest = skClone(playerGltf.scene); // untouched T-pose copy for retargeting

/* ================================================================== sky & light */
const sky = new Sky(); sky.scale.setScalar(2000); scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 6; skyU.rayleigh.value = 1.6; skyU.mieCoefficient.value = 0.006; skyU.mieDirectionalG.value = 0.85;
const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x5a4a3a, 1.0); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(QUALITY === 'high' ? 4096 : 2048);
Object.assign(sun.shadow.camera, { left: -85, right: 85, top: 85, bottom: -85, near: 1, far: 450 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const pmrem = new THREE.PMREMGenerator(renderer);
const skyScene = new THREE.Scene(); const sky2 = new Sky(); sky2.scale.setScalar(100); skyScene.add(sky2);
sky2.material.uniforms = THREE.UniformsUtils.clone(skyU);
let envRT = null;
function refreshEnv() {
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) sky2.material.uniforms[k].value = skyU[k].value;
  sky2.material.uniforms.sunPosition.value.copy(skyU.sunPosition.value);
  const rt = pmrem.fromScene(skyScene, 0.04);
  if (envRT) envRT.dispose();
  envRT = rt; scene.environment = rt.texture;
}
// stars
{
  const n = 1500, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection(); v.y = Math.abs(v.y) + 0.05; v.normalize().multiplyScalar(900); v.toArray(p, i * 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  var stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(stars);
}
// ocean + distant hills
const ocean = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ color: 0x1f6f8f, roughness: 0.15, metalness: 0.1 }));
ocean.rotation.x = -Math.PI / 2; ocean.position.set(WATER_X - 1500 + 30, -0.35, 0); scene.add(ocean);
{
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x4a5a3a, roughness: 1, flatShading: true });
  const g = [];
  for (let i = 0; i < 40; i++) {
    const a = -Math.PI * 0.45 + (i / 39) * Math.PI * 0.9 + Math.PI / 2;
    const r = 520 + Math.random() * 120;
    const h = 60 + Math.random() * 110, w = 120 + Math.random() * 120;
    const c = new THREE.ConeGeometry(w, h, 5, 1); c.translate(Math.sin(a) * r * 0.9 + 120, h / 2 - 5, Math.cos(a) * r);
    g.push(c);
  }
  for (const c of g) { const m = new THREE.Mesh(c, hillMat); m.matrixAutoUpdate = false; scene.add(m); }
}

/* ================================================================== world */
const city = buildCity(scene, 7);
setProgress(0.95, 'Hiring pedestrians');
const sfx = new Sfx();
const input = new Input(canvas);
const cam = new GameCamera(camera);
const player = new Player(playerGltf, extraClips, scene);
const smoke = new Particles(scene, 1400, false);
const glow = new Particles(scene, 800, true);
const tracers = new Tracers(scene);

// ---- pedestrian models
const findClip = (name) => [...playerGltf.animations, ...extraClips].find((c) => c.name === name);
function retargetSet(gltf, names) {
  const tpose = gltf.animations.find((a) => a.name === 'TPose');
  const tgt = skClone(gltf.scene);
  if (tpose) { const m = new THREE.AnimationMixer(tgt); m.clipAction(tpose).play(); m.update(0); }
  const rt = new Retargeter(playerRest, tgt);
  const out = {};
  for (const [k, n] of Object.entries(names)) out[k] = rt.retarget(findClip(n));
  return out;
}
const xClip = (n) => xbotGltf.animations.find((a) => a.name === n);
const sClip = (n) => soldierGltf.animations.find((a) => a.name === n);
const xRet = retargetSet(xbotGltf, { punch: 'punchR', aim: 'fightIdle' });
const mRet = retargetSet(michelleGltf, { idle: 'idle', walk: 'walk', run: 'run', punch: 'punchR' });
const sRet = retargetSet(soldierGltf, { punch: 'punchR' });
const CLOTHES = [0x2c5e9e, 0xb8433b, 0x3d7a4a, 0xd9a93a, 0x6b4c9a, 0xe07a2f, 0x2f8f8f, 0x8a8a8a, 0xd0d0d0, 0x2b2b2b, 0xc85a8a];
const SKIN = [0xf1c7a5, 0xd9a57a, 0xa86e45, 0x6e4529, 0xe0b090];
const factory = new PedFactory({
  xbot: { gltf: xbotGltf, scale: 1, clips: { idle: xClip('idle'), walk: xClip('walk'), run: xClip('run'), punch: xRet.punch },
    tint: (m, r, o) => { if (/Joints/i.test(m.name)) m.color.setHex(SKIN[(r() * SKIN.length) | 0]); else m.color.setHex(CLOTHES[(r() * CLOTHES.length) | 0]); m.roughness = 0.7; m.metalness = 0.1; } },
  gang: { gltf: xbotGltf, scale: 1.04, clips: { idle: xClip('idle'), walk: xClip('walk'), run: xClip('run'), punch: xRet.punch },
    tint: (m) => { if (/Joints/i.test(m.name)) m.color.setHex(0x1a1a1a); else m.color.setHex(0x9e1b2f); m.roughness = 0.6; } },
  michelle: { gltf: michelleGltf, scale: 1.05, clips: mRet, tint: (m, r) => { m.color.setHSL(r(), 0.25, 0.75 + r() * 0.25); } },
  cop: { gltf: soldierGltf, scale: 1, clips: { idle: sClip('Idle'), walk: sClip('Walk'), run: sClip('Run'), punch: sRet.punch, aim: sClip('Idle') },
    tint: (m) => { m.color.setHex(0x7d95d6); } },
});
// small gun for cops
const copGunGeo = new THREE.BoxGeometry(0.06, 0.12, 0.34);
const copGunMat = new THREE.MeshStandardMaterial({ color: 0x111111 });

/* ================================================================== game state */
const game = {
  state: 'loading', time: 18 * 60 + 40, money: 250, weapon: 'fists', ammo: 0, hasGun: false,
  stats: { kills: 0, cars: 0, jobs: 0, cash: 0 },
  deathT: 0, deathKind: null, areaName: '', slowmo: 1,
};
const world = {
  city, sfx, player, scene, dt: 0, time: 0,
  cars: [], peds: [], obstacles: [], pickups: [], markers: [],
  wanted: null,
  get weapon() { return game.weapon; }, get ammo() { return game.ammo; },
};

/* ------------------------------------------------------------------ wanted level */
const wanted = (world.wanted = {
  level: 0, unseen: 0, lastSeen: 0,
  set(n, why) {
    n = clamp(Math.round(n), 0, 5);
    if (n > this.level) { sfx.star(); this.unseen = 0; if (this.level === 0) feed('The police are looking for you.', 'cop', 4); }
    this.level = n; updateStars();
  },
  bump(min, add = 0) { this.set(Math.max(min, this.level + add)); },
  seen(pos, d) { if (d < 75) this.unseen = 0; },
  clear() { this.level = 0; this.unseen = 0; updateStars(); },
});

/* ------------------------------------------------------------------ helpers */
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
world.lineOfSight = (a, b) => {
  const dx = b.x - a.x, dy = (b.y + 1.4) - (a.y + 1.5), dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
  return rayBuildings(city, a.x, a.y + 1.5, a.z, dx / d, dy / d, dz / d, d) >= d - 0.5;
};
function copsNear(pos, r) {
  for (const p of world.peds) if (p.role === 'cop' && !p.dead && p.pos.distanceTo(pos) < r) return true;
  for (const c of world.cars) if (c.type === 'police' && c.cops > 0 && c.pos.distanceTo(pos) < r) return true;
  return false;
}
function panic(pos, r) {
  for (const p of world.peds) if (p.role === 'civ' && !p.dead && p.state !== 'down' && p.pos.distanceTo(pos) < r) { p.state = 'flee'; p.flee = pos.clone(); p.timer = 6 + Math.random() * 6; }
}
function addMoney(n, at) {
  game.money = Math.max(0, game.money + n);
  if (n > 0) game.stats.cash += n;
  $('money').classList.add('flash'); setTimeout(() => $('money').classList.remove('flash'), 150);
  if (at && n) popup(`${n > 0 ? '+' : '-'}$${Math.abs(n)}`, at);
  updateMoney();
}

/* ------------------------------------------------------------------ damage */
world.damagePlayer = (n, from, ignoreArmor = false, cause = 'hit') => {
  if (player.dead || game.state !== 'playing') return;
  if (game.god) return;
  if (!ignoreArmor && player.armor > 0) { const a = Math.min(player.armor, n * 0.7); player.armor -= a; n -= a; }
  player.health -= n; player.hurtT = 3;
  $('vignette').style.opacity = String(clamp(n / 25, 0.25, 0.9));
  setTimeout(() => ($('vignette').style.opacity = player.health < 25 ? '0.35' : '0'), 160);
  sfx.hurt();
  if (player.health <= 0) { player.health = 0; die(cause); }
  updateBars();
};

/* ================================================================== spawning */
const MAX_TRAFFIC = QUALITY === 'low' ? 14 : 22;
const MAX_PEDS = QUALITY === 'low' ? 14 : 24;
const MAX_PARKED = 10;
const pools = { xbot: [], michelle: [], cop: [], gang: [] };

function makePed(kind, role = 'civ') {
  const pool = pools[kind];
  let ped = pool.pop();
  if (ped) { ped.role = role; ped.reset(); ped.root.visible = true; scene.add(ped.root); }
  else {
    ped = new Ped(factory.make(kind, scene), role);
    ped.kind = kind;
    if (kind === 'cop') {
      const hand = ped.model.getObjectByName('mixamorigRightHand');
      ped.gunProp = new THREE.Mesh(copGunGeo, copGunMat); scene.add(ped.gunProp);
      ped.hand = hand;
    }
  }
  world.peds.push(ped);
  return ped;
}
function removePed(ped) {
  const i = world.peds.indexOf(ped); if (i >= 0) world.peds.splice(i, 1);
  scene.remove(ped.root); ped.mixer.stopAllAction(); ped.cur = null;
  if (ped.gunProp) ped.gunProp.visible = false;
  pools[ped.kind].push(ped);
}

function onScreen(x, z, margin = 1.2) {
  tmpV.set(x, 1.5, z).project(camera);
  return tmpV.z < 1 && Math.abs(tmpV.x) < margin && Math.abs(tmpV.y) < margin;
}

function spawnPeds() {
  let civ = 0; for (const p of world.peds) if (p.role === 'civ') civ++;
  let tries = 0;
  while (civ < MAX_PEDS && tries++ < 6) {
    const bx = clamp(Math.floor((player.pos.x - roadC(0)) / BLOCK) + Math.floor(Math.random() * 5) - 2, 0, N - 2);
    const bz = clamp(Math.floor((player.pos.z - roadC(0)) / BLOCK) + Math.floor(Math.random() * 5) - 2, 0, N - 2);
    const c = (Math.random() * 4) | 0;
    const p0 = ringCorner(bx, bz, c), p1 = ringCorner(bx, bz, (c + 1) % 4);
    const t = Math.random();
    const x = lerp(p0[0], p1[0], t), z = lerp(p0[1], p1[1], t);
    const d = Math.hypot(x - player.pos.x, z - player.pos.z);
    if (d < 30 || d > 120 || (d < 70 && onScreen(x, z))) continue;
    const ped = makePed(Math.random() < 0.4 ? 'michelle' : 'xbot');
    ped.setRing(bx, bz, c, Math.random() < 0.5 ? 1 : -1);
    ped.pos.set(x, CURB, z);
    ped.target = ringCorner(bx, bz, (c + 1) % 4); ped.ring.c = (c + 1) % 4; ped.ring.dir = 1;
    ped.heading = Math.atan2(ped.target[0] - x, ped.target[1] - z);
    civ++;
  }
  // despawn
  for (const p of [...world.peds]) {
    const d = Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z);
    if (p.mission) continue;
    if (d > 150 || (p.dead && p.deadT > 25 && !onScreen(p.pos.x, p.pos.z))) removePed(p);
    else if (p.role === 'cop' && wanted.level === 0 && d > 60 && !onScreen(p.pos.x, p.pos.z)) removePed(p);
  }
}

function spawnTraffic() {
  let n = 0; for (const c of world.cars) if (c.mode === 'traffic') n++;
  let tries = 0;
  const pi = roadIndex(player.pos.x), pj = roadIndex(player.pos.z);
  while (n < MAX_TRAFFIC && tries++ < 6) {
    const i = clamp(pi + Math.floor(Math.random() * 7) - 3, 0, N - 1), j = clamp(pj + Math.floor(Math.random() * 7) - 3, 0, N - 1);
    const d = (Math.random() * 4) | 0;
    if (i + DIRS[d][0] < 0 || i + DIRS[d][0] >= N || j + DIRS[d][1] < 0 || j + DIRS[d][1] >= N) continue;
    const s = 5 + Math.random() * 40;
    const x = roadC(i) + DIRS[d][0] * (ROAD / 2 + 1.5 + s) - DIRS[d][1] * LANE, z = roadC(j) + DIRS[d][1] * (ROAD / 2 + 1.5 + s) + DIRS[d][0] * LANE;
    const dist = Math.hypot(x - player.pos.x, z - player.pos.z);
    if (dist < 55 || dist > 190 || (dist < 110 && onScreen(x, z, 1.1))) continue;
    if (world.cars.some((c) => Math.hypot(c.pos.x - x, c.pos.z - z) < 12)) continue;
    const car = new Car(TRAFFIC_MIX[(Math.random() * TRAFFIC_MIX.length) | 0], scene);
    car.startTraffic(i, j, d, s);
    world.cars.push(car); n++;
  }
  // parked cars on curbs near the player
  let parked = 0; for (const c of world.cars) if (c.mode === 'parked' && c.spawnedParked) parked++;
  tries = 0;
  while (parked < MAX_PARKED && tries++ < 4) {
    let x, z, h;
    if (Math.random() < 0.3 && city.parkingSpots.length) {
      const s = city.parkingSpots[(Math.random() * city.parkingSpots.length) | 0]; x = s.x; z = s.z; h = s.h;
    } else {
      const i = clamp(pi + Math.floor(Math.random() * 5) - 2, 0, N - 1), j = clamp(pj + Math.floor(Math.random() * 5) - 2, 0, N - 2);
      const side = Math.random() < 0.5 ? 1 : -1;
      x = roadC(i) + side * (ROAD / 2 - 1.3); z = roadC(j) + ROAD / 2 + 6 + Math.random() * (BLOCK - ROAD - 12);
      h = side > 0 ? 0 : Math.PI;
      if (Math.random() < 0.5) { [x, z] = [z, x]; h = side > 0 ? Math.PI / 2 : -Math.PI / 2; }
    }
    const dist = Math.hypot(x - player.pos.x, z - player.pos.z);
    if (dist < 40 || dist > 130 || onScreen(x, z, 1.1)) continue;
    if (world.cars.some((c) => Math.hypot(c.pos.x - x, c.pos.z - z) < 7)) continue;
    const car = new Car(['sedan', 'sedan', 'pickup', 'van', 'sports'][(Math.random() * 5) | 0], scene);
    car.place(x, z, h); car.spawnedParked = true; car.mode = 'parked'; car.pos.y = groundHeight(city, x, z);
    world.cars.push(car); parked++;
  }
  // despawn
  for (const c of [...world.cars]) {
    if (c === player.inCar || c.mission || c.keep) continue;
    const d = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z);
    const limit = c.mode === 'wreck' ? 120 : c.type === 'police' ? 240 : 210;
    if ((d > limit && !onScreen(c.pos.x, c.pos.z)) || d > 320) removeCar(c);
    else if (c.type === 'police' && wanted.level === 0 && d > 90 && !onScreen(c.pos.x, c.pos.z)) removeCar(c);
  }
}
function removeCar(c) {
  const i = world.cars.indexOf(c); if (i >= 0) world.cars.splice(i, 1);
  c.dispose();
}

/* ------------------------------------------------------------------ police dispatch */
function spawnPolice(dt) {
  if (wanted.level === 0) return;
  const want = [0, 1, 2, 3, 4, 5][wanted.level];
  let have = 0; for (const c of world.cars) if (c.type === 'police' && c.mode === 'police') have++;
  if (have >= want) return;
  world.copSpawnT = (world.copSpawnT ?? 0) - dt;
  if (world.copSpawnT > 0) return;
  world.copSpawnT = 2.5;
  const pi = roadIndex(player.pos.x), pj = roadIndex(player.pos.z);
  for (let k = 0; k < 10; k++) {
    const i = clamp(pi + Math.floor(Math.random() * 5) - 2, 0, N - 1), j = clamp(pj + Math.floor(Math.random() * 5) - 2, 0, N - 1);
    const x = roadC(i), z = roadC(j);
    const d = Math.hypot(x - player.pos.x, z - player.pos.z);
    if (d < 70 || d > 180 || onScreen(x, z, 1.05)) continue;
    const car = new Car('police', scene);
    car.place(x, z, Math.atan2(player.pos.x - x, player.pos.z - z));
    car.mode = 'police'; car.driver = 'cop'; car.siren = true; car.cops = 2;
    world.cars.push(car);
    return;
  }
}
function deployCops(car) {
  const n = car.cops; car.cops = 0; car.mode = 'parked'; car.driver = null;
  for (let k = 0; k < n; k++) {
    const p = makePed('cop', 'cop');
    const side = k === 0 ? 1 : -1;
    car.local(side * (car.t.W / 2 + 0.8), 0, 0.3, p.pos); p.pos.y = groundHeight(city, p.pos.x, p.pos.z);
    p.heading = car.heading; p.state = 'chase';
  }
}

/* ------------------------------------------------------------------ pickups */
const pickupGeo = {
  cash: new THREE.BoxGeometry(0.45, 0.12, 0.25),
  health: new THREE.OctahedronGeometry(0.32, 0),
  armor: new THREE.CylinderGeometry(0.3, 0.3, 0.12, 6).rotateX(Math.PI / 2),
  gun: new THREE.BoxGeometry(0.12, 0.18, 0.7),
};
const pickupMat = {
  cash: new THREE.MeshStandardMaterial({ color: 0x5fd35a, emissive: 0x2a8a20, emissiveIntensity: 0.6 }),
  health: new THREE.MeshStandardMaterial({ color: 0xff4a5a, emissive: 0xaa1020, emissiveIntensity: 0.8 }),
  armor: new THREE.MeshStandardMaterial({ color: 0x4a9aff, emissive: 0x1040a0, emissiveIntensity: 0.8 }),
  gun: new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffaa22, emissiveIntensity: 0.25 }),
};
const glowSpriteMat = new THREE.SpriteMaterial({ map: glowTex(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 });
function addPickup(type, x, z, { amount = 0, respawn = 0, y = null } = {}) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(pickupGeo[type], pickupMat[type]); g.add(m);
  const s = new THREE.Sprite(glowSpriteMat.clone()); s.material.color.set(pickupMat[type].color); s.scale.setScalar(1.6); g.add(s);
  const gy = y ?? groundHeight(city, x, z);
  g.position.set(x, gy + 0.7, z); scene.add(g);
  const p = { type, x, z, y: gy, amount, respawn, group: g, active: true, t: 0 };
  world.pickups.push(p); return p;
}
// fixed pickups
const hospital = city.blocks.find((b) => b.special === 'hospital');
const police = city.blocks.find((b) => b.special === 'police');
const HOSPITAL_SPAWN = new THREE.Vector3(hospital.door[0], CURB, hospital.door[1] - 3);
const POLICE_SPAWN = new THREE.Vector3(police.door[0], CURB, police.door[1] - 3);
const START = new THREE.Vector3(BEACH_X - 14, 0, 30);
addPickup('gun', BEACH_X - 20, -60, { amount: 90, respawn: 60 });
addPickup('gun', roadC(6) + 12, roadC(6) + 12, { amount: 90, respawn: 60 });
addPickup('health', hospital.door[0] + 6, hospital.door[1] - 2, { respawn: 30 });
addPickup('armor', police.door[0] - 8, police.door[1] - 2, { respawn: 45 });
addPickup('armor', roadC(2) + 14, roadC(7) - 12, { respawn: 45 });
addPickup('health', roadC(4) + 30, roadC(2) + 30, { respawn: 30 });
for (let i = 0; i < 6; i++) addPickup('cash', BEACH_X - 10 - Math.random() * 30, -200 + i * 70, { amount: 100, respawn: 120 });

function updatePickups(dt) {
  for (let i = world.pickups.length - 1; i >= 0; i--) {
    const p = world.pickups[i];
    p.t += dt;
    if (!p.active) { if (p.respawn && p.t > p.respawn) { p.active = true; p.group.visible = true; } continue; }
    p.group.rotation.y += dt * 2;
    p.group.position.y = p.y + 0.7 + Math.sin(p.t * 3) * 0.1;
    const d = Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
    const inCar = !!player.inCar;
    if (d < (inCar ? 2.6 : 1.3) && !player.dead && (p.type === 'cash' || !inCar)) {
      if (p.type === 'health' && player.health >= 100) continue;
      if (p.type === 'armor' && player.armor >= 100) continue;
      if (p.type === 'cash') { addMoney(p.amount, p.group.position); sfx.cash(); }
      if (p.type === 'health') { player.health = 100; sfx.pickup(); feed('Health restored.', 'health', 3); }
      if (p.type === 'armor') { player.armor = 100; sfx.pickup(); feed('Body armor equipped.', 'cop', 3); }
      if (p.type === 'gun') {
        game.ammo = Math.min(999, game.ammo + p.amount); sfx.pickup();
        if (!game.hasGun) { game.hasGun = true; game.weapon = 'gun'; help('You picked up a carbine. Hold <kbd>RMB</kbd> to aim and <kbd>LMB</kbd> to fire. <kbd>1</kbd>/<kbd>2</kbd> switch weapons.', 7); }
        updateWeapon();
      }
      updateBars();
      if (p.respawn) { p.active = false; p.t = 0; p.group.visible = false; }
      else { scene.remove(p.group); world.pickups.splice(i, 1); }
    } else if (!p.respawn && p.t > 40) { scene.remove(p.group); world.pickups.splice(i, 1); }
  }
}

/* ------------------------------------------------------------------ markers (job coronas) */
const markerTex = (() => {
  const c = document.createElement('canvas'); c.width = 4; c.height = 64;
  const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 64, 0, 0);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(c);
})();
export function makeMarker(x, z, { color = 0xffd23a, r = 1.4, h = 1.6, arrow = true } = {}) {
  const g = new THREE.Group();
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24, 1, true), new THREE.MeshBasicMaterial({ color, map: markerTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
  cyl.position.y = h / 2; g.add(cyl);
  if (arrow) {
    const a = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.8, 4), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    a.rotation.x = Math.PI; a.position.y = h + 1.4; g.add(a); g.userData.arrow = a;
  }
  g.position.set(x, groundHeight(city, x, z) + 0.02, z);
  scene.add(g);
  return g;
}

/* ================================================================== combat */
function meleeHit(kick) {
  const fx = Math.sin(player.facing), fz = Math.cos(player.facing);
  let hitAny = false;
  for (const p of world.peds) {
    if (p.state === 'down' && p.dead) continue;
    const dx = p.pos.x - player.pos.x, dz = p.pos.z - player.pos.z, d = Math.hypot(dx, dz);
    if (d > 1.9 || (dx * fx + dz * fz) / (d || 1) < 0.4) continue;
    hitAny = true;
    const dmg = kick ? 38 : 22;
    const wasCop = p.role === 'cop';
    if (p.health - dmg <= 0 || kick || Math.random() < 0.35) p.knock(fx * (kick ? 5 : 3), fz * (kick ? 5 : 3), 1.5, dmg, world, 'melee');
    else { p.health -= dmg; p.vel.x += fx * 2; p.vel.z += fz * 2; }
    if (p.role === 'civ') {
      if (Math.random() < 0.25 && !p.dead) { p.hostile = true; if (p.state !== 'down') p.state = 'fight'; }
      else if (!p.dead && p.state !== 'down') { p.state = 'flee'; p.flee = player.pos.clone(); p.timer = 8; }
      if (copsNear(player.pos, 35)) wanted.bump(1);
    }
    if (p.role === 'gang' && !p.dead && p.state !== 'down') p.state = 'fight';
    if (wasCop) wanted.bump(1);
    sfx.punch(p.pos);
    glow.emit(p.pos.x, p.pos.y + 1.4, p.pos.z, { size: 0.5, life: 0.15, color: [1, 0.9, 0.6] });
  }
  // punching cars dents them a little
  if (!hitAny) for (const c of world.cars) if (c.contains(player.pos.x + fx * 1.1, player.pos.z + fz * 1.1, 0.2)) { sfx.thud(c.pos); c.damage(1, world); }
  panic(player.pos, 14);
}

const raycaster = new THREE.Raycaster();
function shoot() {
  if (game.ammo <= 0) { sfx.dryFire(); return; }
  game.ammo--; updateWeapon();
  const { o, d } = cam.ray();
  // spread
  const spread = (player.aiming ? 0.008 : 0.035) + (player.speedH > 2 ? 0.015 : 0);
  d.x += (Math.random() - 0.5) * spread; d.y += (Math.random() - 0.5) * spread; d.z += (Math.random() - 0.5) * spread; d.normalize();
  // start the ray at the player's depth so we don't hit things between camera and player
  const startT = Math.max(0, tmpV.copy(player.pos).sub(o).dot(d));
  let best = { t: 220, kind: null };
  const bt = rayBuildings(city, o.x, o.y, o.z, d.x, d.y, d.z, 220);
  if (bt < best.t) best = { t: bt, kind: 'wall' };
  if (d.y < 0) { const gt = (o.y - 0.05) / -d.y; if (gt < best.t) best = { t: gt, kind: 'ground' }; }
  for (const p of world.peds) {
    if (p.dead && p.state === 'down') continue;
    // capsule approx: closest approach of ray to vertical segment
    for (const hy of [0.4, 0.9, 1.4]) {
      const cx = p.pos.x, cy = p.pos.y + hy, cz = p.pos.z;
      const t = (cx - o.x) * d.x + (cy - o.y) * d.y + (cz - o.z) * d.z;
      if (t < startT || t > best.t) continue;
      const px = o.x + d.x * t - cx, py = o.y + d.y * t - cy, pz = o.z + d.z * t - cz;
      if (px * px + py * py + pz * pz < 0.33 * 0.33) { best = { t, kind: 'ped', ped: p, head: hy > 1.3 }; break; }
    }
  }
  for (const c of world.cars) {
    if (c === player.inCar) continue;
    for (const cc of c.circles()) {
      const t = (cc.x - o.x) * d.x + (c.pos.y + 0.8 - o.y) * d.y + (cc.z - o.z) * d.z;
      if (t < startT || t > best.t) continue;
      const px = o.x + d.x * t - cc.x, py = o.y + d.y * t - (c.pos.y + 0.8), pz = o.z + d.z * t - cc.z;
      if (px * px + pz * pz < cc.r * cc.r && Math.abs(py) < 0.75) { best = { t, kind: 'car', car: c }; break; }
    }
  }
  const hit = o.clone().addScaledVector(d, best.t);
  const muzzle = player.muzzle(new THREE.Vector3());
  tracers.add(muzzle, hit);
  glow.emit(muzzle.x, muzzle.y, muzzle.z, { size: 0.9, life: 0.05, color: [1, 0.8, 0.4] });
  sfx.gun(player.pos);
  cam.fovKick = 0.6; cam.pitch += 0.004;
  if (best.kind === 'ped') {
    const p = best.ped;
    const dmg = best.head ? 100 : 34;
    p.health -= dmg;
    $('crosshair').classList.add('hit'); setTimeout(() => $('crosshair').classList.remove('hit'), 90);
    if (p.health <= 0 || Math.random() < 0.3) { p.health += dmg; p.knock(d.x * 2, d.z * 2, 0.5, dmg, world, 'shot'); }
    if (p.role === 'cop') wanted.bump(2);
    else if (p.role === 'gang' && !p.dead) p.state = 'fight';
  } else if (best.kind === 'car') {
    best.car.damage(6, world);
    for (let i = 0; i < 4; i++) glow.emit(hit.x, hit.y, hit.z, { vx: (Math.random() - 0.5) * 6, vy: Math.random() * 4, vz: (Math.random() - 0.5) * 6, size: 0.12, life: 0.3, gravity: 12, color: [1, 0.8, 0.3] });
    sfx.ricochet(hit);
    if (best.car.type === 'police') wanted.bump(2);
  } else if (best.kind) {
    for (let i = 0; i < 3; i++) smoke.emit(hit.x, hit.y, hit.z, { vx: (Math.random() - 0.5), vy: Math.random() * 1.5, vz: (Math.random() - 0.5), size: 0.35, grow: 1, life: 0.6, color: [0.7, 0.68, 0.62], alpha: 0.7 });
    glow.emit(hit.x, hit.y, hit.z, { size: 0.25, life: 0.08, color: [1, 0.8, 0.4] });
  }
  panic(player.pos, 45);
  if (copsNear(player.pos, 60) || Math.random() < 0.04) wanted.bump(1);
}

world.copShoot = (cop, d) => {
  const target = player.inCar ? player.inCar.pos : player.pos;
  const from = cop.pos.clone(); from.y += 1.35;
  from.x += Math.sin(cop.heading) * 0.5; from.z += Math.cos(cop.heading) * 0.5;
  const moving = player.inCar ? player.inCar.speed / 20 : player.speedH / 8;
  const acc = clamp(0.6 - d * 0.012 - moving * 0.25, 0.12, 0.65);
  const hit = Math.random() < acc;
  const to = new THREE.Vector3(target.x + (hit ? 0 : (Math.random() - 0.5) * 3), target.y + 1.1 + (hit ? 0 : Math.random()), target.z + (hit ? 0 : (Math.random() - 0.5) * 3));
  tracers.add(from, to);
  glow.emit(from.x, from.y, from.z, { size: 0.8, life: 0.05, color: [1, 0.8, 0.4] });
  sfx.gun(cop.pos, true);
  if (hit) {
    if (player.inCar) { player.inCar.damage(4, world); world.damagePlayer(2); }
    else world.damagePlayer(6 + Math.random() * 5, cop.pos);
  } else sfx.ricochet(to);
};

world.onPedDown = (p, cause) => {
  if (p.role === 'civ' || p.role === 'gang') {
    game.stats.kills++;
    if (cause !== 'car-npc') {
      if (copsNear(p.pos, 50)) wanted.bump(1);
      else if (Math.random() < 0.3 && p.role === 'civ') wanted.bump(1);
    }
  }
  if (p.role === 'cop' && cause !== 'car-npc') wanted.set(Math.max(2, Math.min(5, wanted.level + 1)));
  // drop cash
  if (!p.lootDropped) { p.lootDropped = true; addPickup('cash', p.pos.x + 0.5, p.pos.z, { amount: p.role === 'cop' ? 40 : 5 + Math.floor(Math.random() * 55) }); }
  if (p.role === 'cop' && Math.random() < 0.6) addPickup('gun', p.pos.x - 0.5, p.pos.z, { amount: 30 });
  missions.onPedDown?.(p);
  panic(p.pos, 30);
};

world.onCarImpact = (car, k, other) => {
  const now = world.time;
  if (k > 3) {
    if (now - (car.lastImpactSfx || 0) > 0.25) { sfx.crash(car.pos, k); car.lastImpactSfx = now; }
    if (k > 5) { car.damage((k - 5) * 2.2, world); other?.damage((k - 5) * 2.2, world); }
    for (let i = 0; i < Math.min(10, k); i++) glow.emit(car.pos.x, car.pos.y + 0.6, car.pos.z, { vx: (Math.random() - 0.5) * 8, vy: Math.random() * 5, vz: (Math.random() - 0.5) * 8, size: 0.1, life: 0.4, gravity: 14, color: [1, 0.75, 0.3] });
  }
  if (car === player.inCar || other === player.inCar) {
    cam.shake = Math.min(0.5, k * 0.03);
    if (k > 22) world.damagePlayer((k - 22) * 1.5, null, true);
    const o = car === player.inCar ? other : car;
    if (o && o.mode === 'traffic') { o.mode = 'physics'; o.recover = 0; }
    if (o && o.type === 'police' && k > 6) wanted.bump(1);
  }
  if (other && other.mode === 'traffic' && car.mode !== 'traffic' && k > 2) { other.mode = 'physics'; other.recover = 0; }
  if (car.mode === 'traffic' && other && other.mode !== 'traffic' && k > 2) { car.mode = 'physics'; car.recover = 0; }
};

world.onExplosion = (pos) => {
  sfx.explosion(pos);
  cam.shake = clamp(1.2 - pos.distanceTo(player.pos) / 60, 0, 1);
  for (let i = 0; i < 40; i++) glow.emit(pos.x, pos.y + 1, pos.z, { vx: (Math.random() - 0.5) * 14, vy: Math.random() * 12, vz: (Math.random() - 0.5) * 14, size: 2 + Math.random() * 2, grow: -2, life: 0.7, drag: 2, color: [1, 0.55, 0.15] });
  for (let i = 0; i < 30; i++) smoke.emit(pos.x, pos.y + 1, pos.z, { vx: (Math.random() - 0.5) * 6, vy: 2 + Math.random() * 5, vz: (Math.random() - 0.5) * 6, size: 2, grow: 3, life: 3, drag: 1, color: [0.12, 0.11, 0.1], alpha: 0.8 });
  for (const p of world.peds) { const d = p.pos.distanceTo(pos); if (d < 9) { const k = 1 - d / 9; p.knock((p.pos.x - pos.x) * k * 2, (p.pos.z - pos.z) * k * 2, 6 * k, 120 * k, world, 'explosion'); } }
  for (const c of world.cars) { const d = c.pos.distanceTo(pos); if (d < 9 && d > 0.1 && !c.dead) { c.damage(80 * (1 - d / 9), world); c.vx += (c.pos.x - pos.x) / d * 6; c.vz += (c.pos.z - pos.z) / d * 6; if (c.mode === 'traffic') c.mode = 'physics'; } }
  const d = (player.inCar?.pos ?? player.pos).distanceTo(pos);
  if (player.inCar && player.inCar.dead && player.inCar.pos.distanceTo(pos) < 0.1) world.damagePlayer(999, null, true, 'explosion');
  else if (d < 9) world.damagePlayer(90 * (1 - d / 9), null, false, 'explosion');
  panic(pos, 60);
};

/* ================================================================== car interaction */
function nearestEnterableCar() {
  let best = null, bd = 4.2;
  for (const c of world.cars) {
    if (c.dead || c.mode === 'wreck') continue;
    const door = c.doorPos(tmpV2);
    const d = Math.min(Math.hypot(door.x - player.pos.x, door.z - player.pos.z), Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) - 1);
    if (d < bd && c.speed < 6) { bd = d; best = c; }
  }
  return best;
}
world.onCarDoor = (car) => {
  sfx.door();
  // carjacking: pull out the driver
  if (car.mode === 'traffic' || car.mode === 'physics' && car.driver === 'npc') {
    const ped = makePed(Math.random() < 0.5 ? 'michelle' : 'xbot');
    car.doorPos(ped.pos); ped.pos.y = groundHeight(city, ped.pos.x, ped.pos.z);
    ped.knock(Math.cos(car.heading) * 3, -Math.sin(car.heading) * 3, 2, 5, world);
    ped.downT = 1.2; ped.hostile = Math.random() < 0.2;
    if (copsNear(player.pos, 40)) wanted.bump(1);
  } else if (car.type === 'police' && car.cops > 0) { deployCops(car); wanted.bump(1); }
  else if (car.type === 'police') wanted.bump(1);
  car.mode = 'player'; car.driver = 'player'; car.path = [];
  car.vx *= 0.2; car.vz *= 0.2;
};
world.onEnteredCar = (car) => {
  if (!car.stolen) { car.stolen = true; game.stats.cars++; }
  car.keep = true;
  showArea(DISTRICTS[districtAt(car.pos.x, car.pos.z)].name, car.t.name);
  sfx.radio.start(); showRadio();
  missions.onEnteredCar?.(car);
};
world.onLeaveCar = (car, bail) => {
  car.mode = 'physics'; car.driver = null; car.keep = false; car.siren = car.type === 'police' && car.siren;
  sfx.radio.stop(); sfx.door();
};

/* ================================================================== flow */
function die(cause) {
  if (player.dead) return;
  player.dead = true; player.downT = 0;
  if (player.inCar) {
    const car = player.inCar; player.inCar = null; player.carState = null;
    car.mode = car.dead ? 'wreck' : 'physics'; car.driver = null;
    car.doorPos(player.pos); player.pos.y = groundHeight(city, player.pos.x, player.pos.z);
    sfx.radio.stop();
  }
  game.deathKind = 'dead'; game.deathT = 0;
  flash(); letterbox(4.8);
  big('WASTED', '', 'red', 4.5);
  sfx.stingerLose();
  canvas.style.filter = 'grayscale(1) contrast(1.15) brightness(0.85)';
  game.slowmo = 0.35;
  missions.fail('You died.');
}
world.bust = () => {
  if (player.dead || game.deathKind) return;
  game.deathKind = 'busted'; game.deathT = 0;
  if (player.inCar) {
    const car = player.inCar; car.mode = 'physics'; car.driver = null;
    player.inCar = null; player.carState = null; car.doorPos(player.pos); sfx.radio.stop();
  }
  player.vel.set(0, 0, 0);
  flash(); letterbox(4.8);
  big('BUSTED', '', 'blue', 4.5);
  sfx.stingerLose();
  canvas.style.filter = 'saturate(0.3) brightness(0.9)';
  game.slowmo = 0.5;
  missions.fail('You got arrested.');
};
function respawn() {
  const busted = game.deathKind === 'busted';
  const p = busted ? POLICE_SPAWN : HOSPITAL_SPAWN;
  for (const c of [...world.cars]) if (c.type === 'police') removeCar(c);
  for (const ped of [...world.peds]) if (ped.role === 'cop') removePed(ped);
  player.reset(p, 0);
  wanted.clear();
  const fee = Math.min(game.money, busted ? 150 : 100);
  game.money -= fee; updateMoney();
  if (busted) { game.ammo = 0; game.hasGun = false; game.weapon = 'fists'; updateWeapon(); }
  game.deathKind = null; game.slowmo = 1;
  canvas.style.filter = '';
  game.time = (game.time + 2 * 60) % 1440;
  cam.yaw = Math.PI; cam.snap(player.focus);
  help(busted ? `Officers confiscated your weapons. Bail: <b>$${fee}</b>.` : `Hospital bill: <b>$${fee}</b>. Try not to do that again.`, 5);
  updateBars();
}

/* ================================================================== HUD */
const starSvg = '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.2 6.6.7-5 4.5 1.4 6.6L12 17.3l-5.9 3.2 1.4-6.6-5-4.5 6.6-.7z"/></svg>';
$('stars').innerHTML = starSvg.repeat(5);
function updateStars() {
  [...$('stars').children].forEach((s, i) => s.classList.toggle('on', i < wanted.level));
  $('mm-wrap').classList.toggle('wanted', wanted.level > 0);
}
function updateMoney() { $('money').textContent = '$' + String(game.money).padStart(8, '0'); }
function updateBars() {
  $('hp').style.width = `${clamp(player.health, 0, 100)}%`;
  $('ar').style.width = `${clamp(player.armor, 0, 100)}%`;
  $('hp').parentElement.classList.toggle('low', player.health < 25);
}
const ICONS = {
  fists: '<svg viewBox="0 0 64 32"><path d="M18 9h22c3 0 5 2 5 5v6c0 4-3 7-7 7H22c-4 0-7-3-7-7v-8c0-2 1-3 3-3z M22 9v6 M28 9v6 M34 9v6 M40 9v6" fill="#fff" stroke="#000" stroke-width="2"/></svg>',
  gun: '<svg viewBox="0 0 64 32"><path d="M4 12h42l4-3h8v5h-6v3H40l-4 4h-6l-2 8h-7l2-9H12l-3 3H4z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>',
};
function updateWeapon() {
  $('weapon-icon').innerHTML = ICONS[game.weapon];
  $('ammo').textContent = game.weapon === 'gun' ? String(game.ammo) : '';
  $('crosshair').classList.toggle('show', game.weapon === 'gun' && !player.inCar);
}
const feedIcons = { cash: ['$', '#8ef08a'], job: ['D', '#ffd23a'], cop: ['★', '#7aa8ff'], info: ['i', '#ffffff'], health: ['+', '#ff6a7a'] };
function feed(html, kind = 'info', secs = 6) {
  const [t, c] = feedIcons[kind] || feedIcons.info;
  const el = document.createElement('div'); el.className = 'n';
  el.innerHTML = `<span class="ic" style="background:${c}">${t}</span><span>${html}</span>`;
  const f = $('feed'); f.prepend(el);
  while (f.children.length > 4) f.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 600); }, secs * 1000);
}
function letterbox(secs = 3) { $('letterbox').classList.add('on'); clearTimeout(letterbox.t); letterbox.t = setTimeout(() => $('letterbox').classList.remove('on'), secs * 1000); }
function flash() { const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
let helpT = 0;
function help(html, secs = 4) { $('help').innerHTML = html; $('help').classList.add('show'); helpT = secs; }
let subT = 0;
function subtitle(html, secs = 4) { $('subtitle').innerHTML = html; subT = secs; }
let bigT = 0;
function big(main, sub = '', cls = '', secs = 3) { $('big-main').textContent = main; $('big-sub').innerHTML = sub; $('big').className = `show ${cls}`; bigT = secs; }
let areaT = 0;
function showArea(name, veh = '') { $('area-name').textContent = name; $('veh-name').textContent = veh; $('area').classList.add('show'); areaT = 3.5; }
let radioT = 0;
function showRadio() { const s = sfx.radio.station; $('radio').innerHTML = `${s.name}<small>${s.tag}</small>`; $('radio').classList.add('show'); radioT = 3; }
function popup(text, worldPos) {
  tmpV.copy(worldPos).project(camera);
  if (tmpV.z > 1) return;
  const el = document.createElement('div'); el.className = 'popup'; el.textContent = text;
  el.style.left = `${(tmpV.x * 0.5 + 0.5) * innerWidth}px`; el.style.top = `${(-tmpV.y * 0.5 + 0.5) * innerHeight}px`;
  $('hud').appendChild(el); setTimeout(() => el.remove(), 1100);
}
const ui = { help, subtitle, big, showArea, popup, addMoney, updateBars, feed, letterbox };

/* ---------------- minimap */
const mm = $('minimap').getContext('2d');
const MW = 300, MH = 190;
function mapBlips() {
  const list = [];
  list.push({ x: HOSPITAL_SPAWN.x, z: HOSPITAL_SPAWN.z, c: '#5ad1ff', t: 'H' });
  list.push({ x: POLICE_SPAWN.x, z: POLICE_SPAWN.z, c: '#7aa8ff', t: '★' });
  for (const p of world.pickups) if (p.active && p.type !== 'cash') list.push({ x: p.x, z: p.z, c: '#9cff9c', s: 3, small: true });
  for (const c of world.cars) if (c.type === 'police' && (c.mode === 'police' || c.siren)) list.push({ x: c.pos.x, z: c.pos.z, c: Math.floor(world.time * 4) % 2 ? '#ff3030' : '#3060ff', s: 4 });
  for (const p of world.peds) if (p.role === 'cop' && !p.dead) list.push({ x: p.pos.x, z: p.pos.z, c: Math.floor(world.time * 4) % 2 ? '#ff3030' : '#3060ff', s: 3 });
  for (const p of world.peds) if (p.role === 'gang' && !p.dead && p.mission) list.push({ x: p.pos.x, z: p.pos.z, c: '#ff4a4a', s: 4 });
  for (const b of missions.blips()) list.push(b);
  return list;
}
function drawMinimap() {
  const inCar = player.inCar;
  const zoom = inCar ? clamp(0.85 - inCar.speed * 0.008, 0.45, 0.85) : 1.0;
  const s = zoom / MAP_SCALE;
  const { fx, fz } = cam.basis();
  const rot = -Math.PI / 2 - Math.atan2(fz, fx);
  const px = player.pos.x, pz = player.pos.z;
  const cx = MW / 2, cy = MH * 0.62;
  mm.save();
  mm.fillStyle = '#2c4b5e'; mm.fillRect(0, 0, MW, MH);
  mm.translate(cx, cy); mm.rotate(rot); mm.scale(s * MAP_SCALE, s * MAP_SCALE);
  mm.drawImage(city.mapCanvas, -(px - BOUNDS.x0) * MAP_SCALE / MAP_SCALE, -(pz - BOUNDS.z0) * MAP_SCALE / MAP_SCALE, city.mapCanvas.width / MAP_SCALE, city.mapCanvas.height / MAP_SCALE);
  // GPS route
  const route = missions.route();
  if (route) {
    const pts = gpsPath(px, pz, route.x, route.z);
    mm.strokeStyle = route.color || '#ffd23a'; mm.lineWidth = 5 / zoom; mm.lineJoin = 'round'; mm.globalAlpha = 0.85;
    mm.beginPath(); mm.moveTo(px - px, pz - pz);
    for (const [x, z] of pts) mm.lineTo(x - px, z - pz);
    mm.stroke(); mm.globalAlpha = 1;
  }
  mm.restore();
  // blips (upright)
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const toScreen = (x, z) => { const dx = (x - px) * zoom, dz = (z - pz) * zoom; return [cx + dx * cos - dz * sin, cy + dx * sin + dz * cos]; };
  for (const b of mapBlips()) {
    let [sx, sy] = toScreen(b.x, b.z);
    const out = sx < 6 || sy < 6 || sx > MW - 6 || sy > MH - 6;
    if (out) { if (!b.edge) continue; sx = clamp(sx, 8, MW - 8); sy = clamp(sy, 8, MH - 8); }
    mm.fillStyle = b.c; mm.strokeStyle = '#000'; mm.lineWidth = 2;
    if (b.t) {
      mm.beginPath(); mm.arc(sx, sy, 8, 0, Math.PI * 2); mm.fill(); mm.stroke();
      mm.fillStyle = '#000'; mm.font = '900 11px Arial'; mm.textAlign = 'center'; mm.textBaseline = 'middle'; mm.fillText(b.t, sx, sy + 0.5);
    } else { mm.beginPath(); mm.arc(sx, sy, b.s || 4, 0, Math.PI * 2); mm.fill(); mm.stroke(); }
  }
  // player arrow
  const pf = (inCar ? inCar.heading : player.facing);
  const ang = Math.atan2(Math.cos(pf), Math.sin(pf)) + rot;
  mm.save(); mm.translate(cx, cy); mm.rotate(ang + Math.PI / 2);
  mm.fillStyle = '#fff'; mm.strokeStyle = '#000'; mm.lineWidth = 2;
  mm.beginPath(); mm.moveTo(0, -9); mm.lineTo(6, 7); mm.lineTo(0, 3); mm.lineTo(-6, 7); mm.closePath(); mm.fill(); mm.stroke();
  mm.restore();
  // north marker
  const [nx, ny] = toScreen(px, pz - 400);
  const nxC = clamp(nx, 10, MW - 10), nyC = clamp(ny, 10, MH - 10);
  mm.fillStyle = '#fff'; mm.font = '900 12px Arial'; mm.textAlign = 'center'; mm.textBaseline = 'middle';
  mm.strokeStyle = '#000'; mm.lineWidth = 3; mm.strokeText('N', nxC, nyC); mm.fillText('N', nxC, nyC);
}
function gpsPath(x0, z0, x1, z1) {
  const i0 = roadIndex(x0), j0 = roadIndex(z0), i1 = roadIndex(x1), j1 = roadIndex(z1);
  const pts = [];
  // first get onto the nearest road
  const onX = Math.abs(z0 - roadC(j0)) < Math.abs(x0 - roadC(i0));
  if (onX) pts.push([roadC(i0), roadC(j0)]); else pts.push([roadC(i0), roadC(j0)]);
  pts.push([roadC(i1), roadC(j0)]);
  pts.push([roadC(i1), roadC(j1)]);
  pts.push([x1, z1]);
  return pts;
}
function drawBigMap() {
  const c = $('bigmap-c'), g = c.getContext('2d');
  const W = c.width, sc = W / Math.max(city.mapCanvas.width, city.mapCanvas.height);
  g.fillStyle = '#2c4b5e'; g.fillRect(0, 0, W, W);
  const oy = (W - city.mapCanvas.height * sc) / 2;
  g.drawImage(city.mapCanvas, 0, oy, city.mapCanvas.width * sc, city.mapCanvas.height * sc);
  const to = (x, z) => [(x - BOUNDS.x0) * MAP_SCALE * sc, oy + (z - BOUNDS.z0) * MAP_SCALE * sc];
  g.font = 'italic 900 16px Georgia'; g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.75)';
  const labels = [['ISAAC BEACH', WATER_X + 20, -200], ['DOWNTOWN', 0, 0], ['MIDTOWN', -80, 110], ['EASTSIDE', 200, -60], ['PALM HILLS', 140, 250], ['LAKESIDE PARK', 36, -110], ['THE PIER', WATER_X - 50, 18]];
  for (const [t, x, z] of labels) { const [sx, sy] = to(x, z); g.fillText(t, sx, sy); }
  for (const b of mapBlips()) {
    const [sx, sy] = to(b.x, b.z);
    g.fillStyle = b.c; g.strokeStyle = '#000'; g.lineWidth = 2;
    g.beginPath(); g.arc(sx, sy, b.t ? 9 : (b.s || 4) + 1, 0, Math.PI * 2); g.fill(); g.stroke();
    if (b.t) { g.fillStyle = '#000'; g.font = '900 12px Arial'; g.textBaseline = 'middle'; g.fillText(b.t, sx, sy + 1); }
  }
  const [px, py] = to(player.pos.x, player.pos.z);
  g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.beginPath(); g.arc(px, py, 7, 0, Math.PI * 2); g.fill(); g.stroke();
}

/* ================================================================== missions */
const missions = new Missions({ world, game, player, city, scene, ui, sfx, wanted, makePed, removePed, makeMarker, Car, addMoney, cam, removeCar });

/* ================================================================== day / night */
let envT = 0, lastNight = -1;
function updateSky(dt) {
  const t = game.time;
  const a = ((t - 330) / 870) * Math.PI; // sunrise 05:30, sunset 20:00
  const sunDir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0.28).normalize();
  const elev = sunDir.y;
  const day = clamp((elev + 0.08) / 0.3, 0, 1);
  const golden = clamp(1 - Math.abs(elev - 0.08) / 0.22, 0, 1);
  const night = 1 - clamp((elev + 0.02) / 0.14, 0, 1);
  skyU.sunPosition.value.copy(sunDir);
  skyU.rayleigh.value = lerp(0.4, 1.6 + golden * 1.2, day);
  skyU.turbidity.value = 3 + golden * 3; skyU.mieCoefficient.value = 0.0025; skyU.mieDirectionalG.value = 0.78;
  renderer.toneMappingExposure = lerp(0.85, 0.55, day);
  // directional light: sun by day, moon by night
  const lightDir = elev > -0.05 ? sunDir : new THREE.Vector3(-0.4, 0.8, 0.3).normalize();
  sun.position.copy(player.pos).addScaledVector(lightDir, 200);
  sun.target.position.copy(player.pos);
  sun.intensity = elev > -0.05 ? lerp(0.0, 2.0, clamp(elev / 0.25, 0, 1)) + 0.05 : 0.6;
  grade.uniforms.uNight.value = night; grade.uniforms.uTime.value = world.time;
  bloom.strength = lerp(0.08, 0.55, night); bloom.threshold = lerp(1.6, 0.95, night);
  sun.color.setRGB(1, lerp(0.55, 0.96, clamp(elev / 0.4, 0, 1)), lerp(0.35, 0.9, clamp(elev / 0.4, 0, 1)));
  if (elev <= -0.05) sun.color.setRGB(0.6, 0.7, 1);
  hemi.intensity = lerp(0.65, 1.0, day);
  hemi.color.setRGB(lerp(0.35, 0.75, day), lerp(0.42, 0.84, day), lerp(0.75, 1, day));
  const fogDay = new THREE.Color(0xc9d8e6), fogGold = new THREE.Color(0xf0a070), fogNight = new THREE.Color(0x0b1020);
  scene.fog.color.copy(fogDay).lerp(fogGold, golden * 0.85).lerp(fogNight, night);
  stars.material.opacity = night * 0.9;
  ocean.material.color.setRGB(lerp(0.03, 0.12, day), lerp(0.06, 0.42, day), lerp(0.12, 0.55, day));
  // city lights
  if (Math.abs(night - lastNight) > 0.01) {
    lastNight = night;
    for (const m of city.nightMats) m.emissiveIntensity = night * 1.6;
    city.lampHeads.emissiveIntensity = night * 3;
    city.lampGlow.material.opacity = night * 0.8;
    city.lampPool.opacity = night * 0.55;
    city.group.traverse((o) => { if (o.userData.signMat) o.userData.signMat.emissiveIntensity = o.userData.signMat.userData.night ? 0.25 + night * 1.6 : 0; });
  }
  game.night = night;
  envT -= dt;
  if (envT <= 0 || Math.abs(night - (game.envNight ?? -1)) > 0.08) { envT = 20; game.envNight = night; refreshEnv(); }
  scene.environmentIntensity = lerp(0.03, 0.22, day);
}
// traffic signals
const sigCol = { red: new THREE.Color(4, 0.1, 0.05), yellow: new THREE.Color(4, 2.4, 0.1), green: new THREE.Color(0.1, 4, 0.6) };
let sigT = 0;
function updateSignals(dt) {
  sigT -= dt; if (sigT > 0) return; sigT = 0.25;
  const m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), q = new THREE.Quaternion();
  city.signalList.forEach((l, k) => {
    const st = signalState(l.i, l.j, l.axis, world.time);
    city.signalBulbs.setColorAt(k, sigCol[st]);
    const yOff = st === 'red' ? 0.32 : st === 'yellow' ? 0 : -0.32;
    m.compose(tmpV.copy(l.bulb).setY(l.bulb.y + yOff), q, one);
    city.signalBulbs.setMatrixAt(k, m);
  });
  city.signalBulbs.instanceMatrix.needsUpdate = true;
  city.signalBulbs.instanceColor.needsUpdate = true;
}

/* ================================================================== input flow */
async function lockAndPlay() {
  sfx.init(); sfx.click();
  if ($('opt-fullscreen').checked && !document.fullscreenElement) {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); await navigator.keyboard?.lock?.(['Escape']).catch(() => {}); } catch { /* fine */ }
  }
  try { await canvas.requestPointerLock({ unadjustedMovement: true }); }
  catch { try { await canvas.requestPointerLock(); } catch { input.dragLook = true; startPlaying(); } }
  // some embedded browsers never fire pointerlockchange
  setTimeout(() => { if (game.state !== 'playing' && document.pointerLockElement !== canvas) { input.dragLook = true; startPlaying(); } }, 600);
}
function startPlaying() {
  if (game.state === 'menu') newGame();
  game.state = 'playing';
  input.enabled = true;
  slideshow.stop();
  showScreen(null);
  if (player.inCar) sfx.radio.start();
}
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) { input.dragLook = false; startPlaying(); }
  else if (game.state === 'playing' && !input.dragLook) pause();
});
addEventListener('keydown', (e) => { if (e.code === 'Escape' && game.state === 'playing' && input.dragLook) pause(); if (e.code === 'Escape' && game.state === 'paused' && input.dragLook) { /* stay */ } });
function pause() {
  game.state = 'paused'; input.enabled = false; input.reset();
  sfx.radio.stop();
  const h = Math.floor(game.time / 60), m = Math.floor(game.time % 60);
  $('pause-stats').innerHTML = `Jobs done <b>${game.stats.jobs}/4</b> · Cars stolen <b>${game.stats.cars}</b> · Cash earned <b>$${game.stats.cash}</b>`;
  showScreen('pause');
}
$('btn-play').addEventListener('click', lockAndPlay);
$('btn-resume').addEventListener('click', lockAndPlay);
canvas.addEventListener('click', () => { if (game.state === 'paused') lockAndPlay(); });
function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('show', s.id === id);
  $('hud').classList.toggle('show', id === null);
}

function newGame() {
  player.reset(START, Math.PI / 2);
  cam.yaw = Math.PI / 2 + Math.PI; cam.pitch = 0.2; cam.snap(player.focus);
  game.time = 17 * 60 + 30;
  updateMoney(); updateBars(); updateWeapon(); updateStars();
  showArea(DISTRICTS.beach.name);
  setTimeout(() => help('Welcome to <b>Port Isaac</b>. A yellow <b style="color:#ffd23a">D</b> on your map means someone has work for you. Walk into the marker.', 7), 1200);
  setTimeout(() => feed('<b>Dre:</b> yo you made it. come find me on the beach, got work', 'job', 8), 4000);
}

/* ---------------- cheats (typed while playing) */
const CHEATS = {
  TOPUP: () => { player.health = 100; player.armor = 100; updateBars(); },
  PAYDAY: () => addMoney(5000, player.pos),
  COOLDOWN: () => wanted.clear(),
  HEATWAVE: () => wanted.set(wanted.level + 2),
  ARSENAL: () => { game.hasGun = true; game.weapon = 'gun'; game.ammo = 500; updateWeapon(); },
  SUPERCAR: () => { const c = new Car('sports', scene); c.place(player.pos.x + Math.sin(player.facing) * 6, player.pos.z + Math.cos(player.facing) * 6, player.facing + Math.PI / 2); c.mode = 'parked'; c.pos.y = groundHeight(city, c.pos.x, c.pos.z); world.cars.push(c); },
  SUNSET: () => { game.time = 19 * 60; },
  NIGHTOWL: () => { game.time = 23 * 60; },
  HIGHNOON: () => { game.time = 12 * 60; },
};
function checkCheats() {
  for (const [code, fn] of Object.entries(CHEATS)) if (input.typed.endsWith(code)) { fn(); input.typed = ''; feed(`Cheat activated: <b>${code}</b>`, 'info', 4); sfx.pickup(); }
}

/* ================================================================== main loop */
const timer = new THREE.Timer(); timer.connect(document);
let spawnT = 0, lastArea = '', bigmapT = 0, heartbeatT = 0;

let frozen = false;
function frame(ts) {
  if (frozen) { requestAnimationFrame(frame); return; }
  timer.update(ts);
  const d = timer.getDelta();
  tick(clamp(d, 0, 1 / 25));
  composer.render();
  requestAnimationFrame(frame);
}
function tick(rawDt) {
  const dt = rawDt * game.slowmo;
  world.dt = dt;
  const playing = game.state === 'playing';
  const menu = game.state === 'menu';
  if (playing || menu) world.time += dt;
  if (playing) game.time = (game.time + dt * 1.0) % 1440; // 1 real second = 1 game minute
  if (menu) game.time = 19 * 60 + 24;

  if (playing && input.hit('KeyM')) sfx.setMuted(!sfx.muted);
  if (playing) checkCheats();

  // ---- weapon switching
  if (playing && !player.inCar) {
    if (input.hit('Digit1')) game.weapon = 'fists';
    if (input.hit('Digit2') && game.hasGun) game.weapon = 'gun';
    if (input.hit('KeyQ') && game.hasGun) game.weapon = game.weapon === 'gun' ? 'fists' : 'gun';
    if (input.hit('Digit1', 'Digit2', 'KeyQ')) updateWeapon();
  }

  // ---- obstacles list for traffic AI
  world.obstacles.length = 0;
  for (const c of world.cars) world.obstacles.push(c);
  for (const p of world.peds) if (!p.dead && p.state !== 'down' && Math.abs(p.pos.y) < 0.1) world.obstacles.push(p);
  if (!player.inCar && !player.dead) { player.isPed = true; player.isPlayerThing = true; world.obstacles.push(player); }
  if (player.inCar) player.inCar.isPlayerThing = true;

  if (playing || menu) {
    // ---- player
    const ev = player.update(dt, playing && !game.deathKind ? input : null, cam, world);
    if (ev?.type === 'melee') meleeHit(ev.kick);
    if (ev?.type === 'shoot') shoot();
    if (playing && input.hit('KeyF') && !player.inCar && !player.dead && !game.deathKind) {
      const car = nearestEnterableCar();
      if (car) player.beginEnter(car);
    }

    // ---- player-driven car
    const pc = player.inCar;
    for (const c of world.cars) c.isPlayerThing = c === pc;
    if (pc && player.carState === 'driving') {
      const ctl = { throttle: 0, steer: 0, handbrake: false };
      if (playing && !game.deathKind) {
        if (input.down('KeyW')) ctl.throttle += 1;
        if (input.down('KeyS')) ctl.throttle -= 1;
        if (input.down('KeyD')) ctl.steer += 1;
        if (input.down('KeyA')) ctl.steer -= 1;
        ctl.handbrake = input.down('Space');
        if (input.hit('KeyE', 'KeyH')) sfx.horn(pc.pos);
        if (input.hit('KeyR')) { sfx.radio.cycle(); showRadio(); }
        if (pc.type === 'police' && input.hit('KeyC')) pc.siren = !pc.siren;
      }
      pc.updatePhysics(dt, ctl, world);
      pc.ctl = ctl;
      if (pc.land > 0) { if (pc.land > 0.4) { sfx.land(true); cam.shake = 0.3; } if (pc.land > 1.1) stunt(pc.land); pc.land = 0; }
    } else if (pc) { pc.updatePhysics(dt, { throttle: 0, steer: 0, handbrake: true }, world); }

    // ---- other cars
    for (const c of world.cars) {
      if (c === pc) continue;
      if (c.mode === 'traffic') c.updateTraffic(dt, world);
      else if (c.mode === 'police') {
        const tgt = player.inCar ? player.inCar.pos : player.pos;
        const ctl = player.dead || game.deathKind ? { throttle: 0, steer: 0, handbrake: true } : chaseControl(c, tgt.x, tgt.z, world, true);
        c.updatePhysics(dt, ctl, world);
        const d = Math.hypot(tgt.x - c.pos.x, tgt.z - c.pos.z);
        if (d < 70) wanted.seen(c.pos, d);
        if (c.cops > 0 && d < 16 && c.speed < 5 && (!player.inCar || player.inCar.speed < 4)) deployCops(c);
      } else if (c.mode === 'physics' || c.mode === 'parked' || c.mode === 'wreck') {
        if (c.mode === 'parked' && c.speed < 0.05) { c.vx = c.vz = 0; }
        else c.updatePhysics(dt, { throttle: 0, steer: 0, handbrake: c.mode !== 'physics' || !c.driver }, world);
        if (c.mode === 'physics' && c.driver === 'npc') {
          c.recover = (c.recover || 0) + dt;
          if (c.speed < 0.6 && c.recover > 2.5) c.rejoin();
        }
        if (c.mode === 'parked' && c.speed > 0.5) c.mode = 'physics';
      }
      // burning
    }
    for (const c of world.cars) {
      if (c.health <= 0 && !c.dead) {
        c.burnTimer -= dt;
        if (Math.random() < 0.6) glow.emit(c.pos.x + (Math.random() - 0.5), c.pos.y + 1.1, c.pos.z + (Math.random() - 0.5), { vy: 2 + Math.random() * 2, size: 0.9, grow: -0.6, life: 0.6, color: [1, 0.45, 0.1] });
        if (c.burnTimer <= 0) { c.explode(world); if (c.type === 'police' && c.isPlayerThing === false) wanted.bump(1); }
      } else if (c.health < 40 && !c.dead && Math.random() < 0.3) {
        const f = c.local(0, c.t.top + 0.1, c.t.L / 2 - 0.8);
        smoke.emit(f.x, f.y, f.z, { vy: 1.5, vx: (Math.random() - 0.5) * 0.5, vz: (Math.random() - 0.5) * 0.5, size: 0.6, grow: 1.5, life: 1.5, color: c.health < 20 ? [0.15, 0.15, 0.15] : [0.7, 0.7, 0.7], alpha: 0.5 });
      }
      if (c.dead && Math.random() < 0.2) smoke.emit(c.pos.x, c.pos.y + 1, c.pos.z, { vy: 2, size: 1, grow: 2, life: 3, color: [0.1, 0.1, 0.1], alpha: 0.6 });
      if (c.skid && c.speed > 6 && Math.random() < 0.5) for (const w of c.wheels.slice(2)) { const p = w.pivot.getWorldPosition(tmpV); smoke.emit(p.x, 0.15, p.z, { vy: 0.5, size: 0.5, grow: 1.4, life: 0.8, color: [0.85, 0.85, 0.85], alpha: 0.35 }); }
    }
    // car-car collisions
    for (let a = 0; a < world.cars.length; a++) for (let b = a + 1; b < world.cars.length; b++) {
      const A = world.cars[a], B = world.cars[b];
      if (A.mode === 'traffic' && B.mode === 'traffic') continue;
      collideCars(A, B, world);
    }

    // ---- peds
    for (const p of world.peds) {
      p.update(dt, world);
      if (p.gunProp) {
        p.gunProp.visible = !p.dead && p.root.visible;
        if (p.gunProp.visible) { p.hand.getWorldPosition(p.gunProp.position); p.gunProp.rotation.set(0, p.heading, 0); }
      }
      if (p.state === 'down' && p.dead) continue;
      for (const c of world.cars) {
        if (c.speed < 3.5 || Math.abs(c.pos.x - p.pos.x) > 5 || Math.abs(c.pos.z - p.pos.z) > 5) continue;
        if (c.contains(p.pos.x, p.pos.z, 0.35)) {
          const sp = c.speed;
          const byPlayer = c === player.inCar;
          if (p.state !== 'down') sfx.thud(p.pos);
          p.knock(c.vx * 0.9, c.vz * 0.9, 2 + sp * 0.18, sp * (byPlayer ? 5 : 2.5), world, byPlayer ? 'car' : 'car-npc');
          if (byPlayer && p.role === 'cop') wanted.bump(2);
          c.vx *= 0.93; c.vz *= 0.93;
        }
      }
    }
    // player on foot hit by cars
    if (!player.inCar && !player.dead) for (const c of world.cars) {
      if (c.speed < 4 || !c.contains(player.pos.x, player.pos.z, 0.3) || Math.abs(c.pos.y - player.pos.y) > 1) continue;
      if ((c.hitPlayerT || 0) > world.time) continue;
      c.hitPlayerT = world.time + 1;
      world.damagePlayer(c.speed * 2.2, c.pos, false);
      player.vel.set(c.vx * 0.9, 4, c.vz * 0.9); player.onGround = false;
      sfx.thud(player.pos);
    }

    // ---- wanted
    if (playing && wanted.level > 0) {
      wanted.unseen += dt;
      const limit = 8 + wanted.level * 5;
      $('stars').classList.toggle('flash', wanted.unseen > 3);
      if (wanted.unseen > limit) { wanted.clear(); feed('You lost the cops.', 'cop', 4); }
    } else $('stars').classList.remove('flash');
    if (playing) spawnPolice(dt);

    // ---- spawning (throttled)
    spawnT -= rawDt;
    if (spawnT <= 0) { spawnT = 0.4; spawnPeds(); spawnTraffic(); }
    updatePickups(dt);
    if (playing) missions.update(dt);
  }

  // ---- death / arrest sequence
  if (game.deathKind) {
    game.deathT += rawDt;
    // camera slowly pulls up and away, like a news chopper
    cam.pitch += (0.85 - cam.pitch) * damp(0.6, rawDt);
    cam.targetDist = Math.min(14, cam.targetDist + rawDt * 1.6);
    cam.yaw += rawDt * 0.12;
    if (game.deathT > 5) { respawn(); cam.targetDist = 5; cam.pitch = 0.28; }
  }

  // ---- camera
  const inCarCam = player.inCar && player.carState === 'driving' ? player.inCar : null;
  if (menu) {
    cam.yaw = -Math.PI / 2 - 0.55 + Math.sin(world.time * 0.06) * 0.35; cam.pitch = 0.06; cam.targetDist = 3.6;
    player.facing = -Math.PI / 2 + 0.9; player.root.rotation.y = player.facing;
    cam.update(rawDt, player.focus, null, { city });
  } else cam.update(rawDt, player.focus, playing ? input : null, { car: inCarCam, aiming: player.aiming && !player.inCar, city });

  // ---- visuals
  updateSky(rawDt);
  updateSignals(rawDt);
  for (const c of world.cars) c.sync(dt, world.time, game.night);
  for (const m of missions.markers()) { m.rotation.y += rawDt; if (m.userData.arrow) m.userData.arrow.position.y = 3 + Math.sin(world.time * 3) * 0.25; }
  smoke.update(dt); glow.update(dt); tracers.update(dt);

  // ---- audio
  sfx.listener.x = camera.position.x; sfx.listener.z = camera.position.z;
  let sirenV = 0;
  for (const c of world.cars) if (c.siren) sirenV = Math.max(sirenV, 1 - c.pos.distanceTo(player.pos) / 150);
  const pc = player.inCar && player.carState === 'driving' ? player.inCar : null;
  sfx.update(dt, {
    engine: pc && !pc.dead ? { rpm: clamp(Math.abs(pc.fwdSpeed) / pc.t.max, 0, 1) * 0.85 + ((pc.ctl?.throttle ?? 0) !== 0 ? 0.12 : 0), throttle: Math.abs(pc.ctl?.throttle ?? 0), type: pc.type } : null,
    skid: pc && pc.skid && pc.speed > 5 ? 1 : 0,
    siren: playing ? sirenV : 0,
    beach: clamp(1 - (player.pos.x - WATER_X) / 90, 0, 1),
    city: clamp((player.pos.x - BEACH_X) / 80, 0, 1),
  });

  // ---- HUD
  if (playing) {
    const h = Math.floor(game.time / 60), m = Math.floor(game.time % 60);
    $('clock').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    updateBars();
    $('crosshair').classList.toggle('show', game.weapon === 'gun' && !player.inCar && !player.dead);
    if (helpT > 0) { helpT -= rawDt; if (helpT <= 0) $('help').classList.remove('show'); }
    if (subT > 0) { subT -= rawDt; if (subT <= 0) $('subtitle').innerHTML = ''; }
    if (bigT > 0) { bigT -= rawDt; if (bigT <= 0) $('big').classList.remove('show'); }
    if (areaT > 0) { areaT -= rawDt; if (areaT <= 0) $('area').classList.remove('show'); }
    if (radioT > 0) { radioT -= rawDt; if (radioT <= 0) $('radio').classList.remove('show'); }
    const area = DISTRICTS[districtAt(player.pos.x, player.pos.z)].name;
    if (area !== lastArea) { lastArea = area; showArea(area, player.inCar ? player.inCar.t.name : ''); }
    // context help
    if (!player.inCar && !player.dead && helpT <= 0) {
      const c = nearestEnterableCar();
      if (c) { help(`Press <kbd>F</kbd> to ${c.mode === 'traffic' || (c.type === 'police' && c.cops) ? 'jack' : 'enter'} the ${c.t.name}.`, 0.3); }
    }
    if (player.health < 25 && !player.dead) { heartbeatT -= rawDt; if (heartbeatT <= 0) { heartbeatT = 0.9; sfx.heartbeat(); } }
    // map
    if (input.down('Tab')) { $('bigmap').classList.add('show'); bigmapT -= rawDt; if (bigmapT <= 0) { bigmapT = 0.25; drawBigMap(); } }
    else $('bigmap').classList.remove('show');
    drawMinimap();
  }

  input.endFrame();
}

function stunt(air) {
  const bonus = Math.round(air * 120 / 10) * 10;
  big('STUNT!', `+$${bonus}`, 'gold', 2.2);
  addMoney(bonus);
  sfx.checkpoint();
}

/* ================================================================== boot */
player.reset(START, Math.PI / 2);
// menu pose: on the beach, facing the camera, sunset behind
cam.yaw = 0; cam.snap(player.focus);
for (let i = 0; i < 12; i++) { spawnTraffic(); spawnPeds(); }
updateSky(0); refreshEnv();
updateMoney(); updateBars(); updateWeapon(); updateStars();
game.state = 'menu';
$('loading').classList.add('hidden');
showScreen('menu');
window.__game = {
  game, world, player, cam, input, missions, wanted, sfx, camera,
  play() { sfx.init(); game.state = 'menu'; startPlaying(); input.dragLook = true; },
  info() { return renderer.info.render; },
  freeze(v) { frozen = v; },
  render() { composer.render(); },
  tick: (dt) => tick(dt),
  Car, scene, city, makePed, deployCops, removeCar, game,
  sim(secs) { const keys = new Set(input.keys); for (let t = 0; t < secs; t += 1 / 30) { for (const k of keys) input.keys.add(k); tick(1 / 30); } },
  key(code, frames = 1) { input.keys.add(code); input.pressed.add(code); setTimeout(() => input.keys.delete(code), frames * 16); },
};
requestAnimationFrame(frame);
