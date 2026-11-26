import * as THREE from 'three';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * World-space retargeting between two Mixamo skeletons whose bones have different local axes
 * (player.glb was re-rigged in Blender; the NPC models come straight from Mixamo exports).
 *
 * Both skeletons are put in the same reference pose (T-pose). For every frame, the source bone's
 * world rotation relative to its T-pose is applied on top of the target bone's T-pose world rotation:
 *   At(b) = As(b) · Rs(b)⁻¹ · Rt(b),   local(b) = At(parent)⁻¹ · At(b)
 */
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();

function bonesOf(root) {
  const m = new Map();
  root.traverse((o) => { if (o.isBone) m.set(o.name, o); });
  return m;
}

/** Apply a clip's first frame (e.g. a TPose clip) to a model. */
export function poseFromClip(root, clip) {
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.update(0);
  mixer.stopAllAction();
  root.updateMatrixWorld(true);
}

export class Retargeter {
  /**
   * @param srcRoot source model (in its reference pose)
   * @param tgtRoot target model (in its reference pose) – a clone is used internally
   */
  constructor(srcRoot, tgtRoot) {
    this.src = skClone(srcRoot);
    this.src.position.set(0, 0, 0); this.src.rotation.set(0, 0, 0); this.src.scale.set(1, 1, 1);
    this.src.updateMatrixWorld(true);
    this.tgt = tgtRoot;
    tgtRoot.updateMatrixWorld(true);
    this.sb = bonesOf(this.src);
    this.tb = bonesOf(this.tgt);
    this.names = [...this.tb.keys()].filter((n) => this.sb.has(n));
    this.Rs = new Map(); this.Rt = new Map(); this.tgtParentWorld = new Map();
    for (const n of this.names) {
      this.Rs.set(n, this.sb.get(n).getWorldQuaternion(new THREE.Quaternion()));
      this.Rt.set(n, this.tb.get(n).getWorldQuaternion(new THREE.Quaternion()));
    }
    // static parents (armature nodes above the first shared bone)
    for (const n of this.names) {
      const p = this.tb.get(n).parent;
      if (!this.names.includes(p.name)) this.tgtParentWorld.set(n, p.getWorldQuaternion(new THREE.Quaternion()));
    }
    const hipsS = this.sb.get('mixamorigHips'), hipsT = this.tb.get('mixamorigHips');
    this.hipsRestS = hipsS.getWorldPosition(new THREE.Vector3());
    this.hipsRestT = hipsT.getWorldPosition(new THREE.Vector3());
    this.hipsT = hipsT;
    this.scale = this.hipsRestT.y / this.hipsRestS.y;
    this.tgtRestLocal = new Map(this.names.map((n) => [n, this.tb.get(n).quaternion.clone()]));
    this.hipsRestLocal = hipsT.position.clone();
  }

  retarget(clip, fps = 30) {
    const mixer = new THREE.AnimationMixer(this.src);
    const action = mixer.clipAction(clip); action.play();
    const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = new Float32Array(frames);
    const qv = new Map(this.names.map((n) => [n, new Float32Array(frames * 4)]));
    const hp = new Float32Array(frames * 3);
    const At = new Map();
    const hasHips = clip.tracks.some((t) => t.name === 'mixamorigHips.position');
    const parentInv = new THREE.Matrix4();
    for (let f = 0; f < frames; f++) {
      const t = Math.min(clip.duration, (f / (frames - 1)) * clip.duration);
      times[f] = t;
      mixer.setTime(t);
      this.src.updateMatrixWorld(true);
      for (const n of this.names) {
        const As = this.sb.get(n).getWorldQuaternion(_q);
        const w = As.clone().multiply(_q2.copy(this.Rs.get(n)).invert()).multiply(this.Rt.get(n));
        At.set(n, w);
      }
      for (const n of this.names) {
        const b = this.tb.get(n);
        const pw = this.tgtParentWorld.get(n) ?? At.get(b.parent.name);
        const local = _q.copy(pw).invert().multiply(At.get(n)).normalize();
        local.toArray(qv.get(n), f * 4);
      }
      // hips height (keep in place horizontally)
      if (hasHips) {
        const hs = this.sb.get('mixamorigHips').getWorldPosition(_v);
        const wy = this.hipsRestT.y + (hs.y - this.hipsRestS.y) * this.scale;
        const wp = new THREE.Vector3(this.hipsRestT.x, wy, this.hipsRestT.z);
        parentInv.copy(this.hipsT.parent.matrixWorld).invert();
        wp.applyMatrix4(parentInv);
        wp.toArray(hp, f * 3);
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(this.src);
    const tracks = this.names.map((n) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, qv.get(n)));
    if (hasHips) tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', times, hp));
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  }
}
