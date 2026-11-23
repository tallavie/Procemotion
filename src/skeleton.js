// Skeleton access: the bones of a loaded model, which of them move vertices, rest / bind / clip poses.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

export class Creature {
  /** @param {THREE.Object3D} root the loaded model */
  constructor(root, animations, name) {
    this.root = root;
    this.name = name;
    this.animations = animations || [];
    this.meshes = [];
    root.traverse((o) => { if (o.isSkinnedMesh) this.meshes.push(o); });
    this.collectBones();
  }

  collectBones() {
    const set = new Set();
    this.root.traverse((o) => { if (o.isBone) set.add(o); });
    for (const m of this.meshes) for (const b of m.skeleton.bones) set.add(b);
    // tree order: parents before children
    this.bones = [];
    this.root.traverse((o) => { if (set.has(o)) this.bones.push(o); });
    this.byName = new Map(this.bones.map((b) => [b.name, b]));
    this.weighted = this.findWeighted();
    // keep the loaded rest pose of bones we already knew (this may run while the model is posed, e.g. in the bind
    // pose after adding bones); new bones take their current transform, which is their rest
    const prev = this.restOf || new Map();
    this.rest = this.bones.map((b) => prev.get(b) || { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() });
    this.restOf = new Map(this.bones.map((b, i) => [b, this.rest[i]]));
    this.restIndex = new Map(this.bones.map((b, i) => [b, i]));
  }

  get hasBones() { return this.bones.length > 0; }

  /** Bones that carry vertex weight (helper and effect bones usually carry none). */
  findWeighted() {
    const w = new Set();
    for (const m of this.meshes) {
      const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      if (!si || !sw) continue;
      const bones = m.skeleton.bones;
      for (let i = 0; i < si.count; i++) {
        for (let k = 0; k < 4; k++) {
          if (sw.getComponent(i, k) > 0.01) { const b = bones[si.getComponent(i, k)]; if (b) w.add(b); }
        }
      }
    }
    return w;
  }

  /** Put every bone back to its loaded (node) transform. */
  restore() {
    const { bones, rest } = this;
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i], r = rest[i];
      b.position.copy(r.p); b.quaternion.copy(r.q); b.scale.copy(r.s);
    }
  }

  /** Pose bones exactly as the mesh was bound (identity skinning), from the inverse bind matrices. */
  bindSnapshot() {
    this.root.updateMatrixWorld(true);
    const world = new Map();
    for (const m of this.meshes) {
      const sk = m.skeleton;
      // bone world in bind pose = meshWorld * bindMatrix^-1 * boneInverse^-1
      _m2.copy(m.bindMatrix).invert().premultiply(m.matrixWorld);
      sk.bones.forEach((b, i) => {
        if (world.has(b)) return;
        world.set(b, _m2.clone().multiply(_m.copy(sk.boneInverses[i]).invert()));
      });
    }
    // convert to local, parents first
    const snap = [];
    const solvedWorld = new Map();
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      let w = world.get(b);
      const parentW = b.parent ? (solvedWorld.get(b.parent) || b.parent.matrixWorld) : new THREE.Matrix4();
      if (!w) {
        // bone not in any skin: keep its rest local transform
        const r = this.rest[i];
        w = parentW.clone().multiply(new THREE.Matrix4().compose(r.p, r.q, r.s));
      }
      solvedWorld.set(b, w);
      const local = parentW.clone().invert().multiply(w);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      local.decompose(p, q, s);
      snap.push({ p, q, s });
    }
    return snap;
  }

  snapshot() { return this.bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() })); }

  applySnapshot(snap) {
    const bones = this.bones;
    for (let i = 0; i < bones.length && i < snap.length; i++) {
      const b = bones[i], s = snap[i];
      b.position.copy(s.p); b.quaternion.copy(s.q); b.scale.copy(s.s);
    }
  }

  /** A pose sampled from one of the model's clips (nothing changes outside the bones). */
  clipSnapshot(clip, t = 0) {
    const sampler = makeSampler(this.root, clip, this);
    this.restore();
    sampler(t);
    const snap = this.snapshot();
    this.restore();
    return snap;
  }

  /** Clip most likely to be a neutral standing pose. */
  idleClip() {
    const a = this.animations;
    // in priority order: a field/standing idle beats a battle idle (which may hover in the air)
    for (const rx of [/fi\d*_wait/i, /(^|[_\s|])idle/i, /stand/i, /wait0?1$/i, /wait/i, /idle/i]) {
      const c = a.find((x) => rx.test(x.name));
      if (c) return c;
    }
    return null;
  }

  update() {
    this.root.updateMatrixWorld(true);
    for (const m of this.meshes) m.skeleton.update();
  }
}

/** Fast clip evaluator bound to a model; returns (t) => applies the clip at time t. */
export function makeSampler(root, clip, creature) {
  const bindings = [];
  for (const track of clip.tracks) {
    let parsed;
    try { parsed = THREE.PropertyBinding.parseTrackName(track.name); } catch { continue; }
    let node = (creature && creature.byName.get(parsed.nodeName)) || THREE.PropertyBinding.findNode(root, parsed.nodeName);
    if (!node) continue;
    if (parsed.objectName === 'bones' && node.skeleton) node = node.skeleton.getBoneByName(parsed.objectIndex);
    if (!node || !node.isBone) continue;
    if (!['quaternion', 'position', 'scale'].includes(parsed.propertyName)) continue;
    bindings.push({ node, prop: parsed.propertyName, interp: track.createInterpolant() });
  }
  return (t) => {
    for (const b of bindings) {
      const v = b.interp.evaluate(t);
      if (b.prop === 'quaternion') b.node.quaternion.fromArray(v).normalize();
      else if (b.prop === 'position') b.node.position.fromArray(v);
      else b.node.scale.fromArray(v);
    }
  };
}

/** World position of an object (matrixWorld must be current). */
export function wpos(o, out = new THREE.Vector3()) { return out.setFromMatrixPosition(o.matrixWorld); }

/** Bounds of all meshes in the current pose, in the space of `space` (an ancestor). */
export function poseBounds(creature, space) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  creature.root.updateMatrixWorld(true);
  for (const m of creature.meshes) m.skeleton.update();
  creature.root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
      v.applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      box.expandByPoint(v);
    }
  });
  return box;
}
