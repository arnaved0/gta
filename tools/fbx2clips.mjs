// Convert Mixamo FBX animation files into one compact JSON of three.js AnimationClips.
// Usage: node tools/fbx2clips.mjs <dir-with-fbx> <out.json> name=File.fbx ...
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

globalThis.window = globalThis;
globalThis.self = globalThis;
const [dir, out, ...pairs] = process.argv.slice(2);
const loader = new FBXLoader();
const clips = [];
for (const pair of pairs) {
  const [name, file] = pair.split('=');
  const buf = fs.readFileSync(path.join(dir, file));
  const obj = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const clip = obj.animations[0];
  clip.name = name;
  // Keep only rotations, plus hips position (FBX is in cm -> convert to m). Round to shrink JSON.
  clip.tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'mixamorigHips.position');
  for (const t of clip.tracks) {
    const isPos = t.name.endsWith('.position');
    t.values = Float32Array.from(t.values, (v) => Math.round((isPos ? v / 100 : v) * 1e3) / 1e3);
    t.times = Float32Array.from(t.times, (v) => Math.round(v * 1e3) / 1e3);
  }
  clip.optimize();
  clips.push(THREE.AnimationClip.toJSON(clip));
  console.log(name, clip.duration.toFixed(2), clip.tracks.length);
}
fs.writeFileSync(out, JSON.stringify(clips));
console.log('wrote', out, fs.statSync(out).size);
