// Collision volume from the mesh: one capsule per bone, sized from the vertices that bone moves.
// (The same idea as a Physics Asset in Unreal, built from the skin instead of by hand.)
import * as THREE from 'three';
import { meshVertices, boneSegments } from './autorig.js';

const _ab = new THREE.Vector3();
const _w = new THREE.Vector3();

function segDist(p, a, b) {
  _ab.subVectors(b, a);
  const l2 = _ab.lengthSq();
  let t = l2 > 0 ? _w.subVectors(p, a).dot(_ab) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return p.distanceTo(_w.copy(a).addScaledVector(_ab, t));
}

/**
 * @param creature Creature
 * @param bindSnap its bind-pose snapshot (vertices and bones agree there)
 * @returns Map<Bone, { radius, length }> in model units; bones that move almost nothing are left out
 */
export function computeCapsules(creature, bindSnap) {
  const pose = creature.snapshot();
  creature.applySnapshot(bindSnap);
  creature.root.updateMatrixWorld(true);
  const W = creature.weighted;
  const segs = boneSegments(creature.bones, W.size ? W : null);
  const segOf = new Map(segs.map((s) => [s.bone, s]));
  const dists = new Map();
  const p = new THREE.Vector3();
  for (const mesh of creature.meshes) {
    const geo = mesh.geometry;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (!si || !sw) continue;
    const verts = meshVertices(mesh);
    const bones = mesh.skeleton.bones;
    const step = Math.max(1, Math.floor(si.count / 20000));
    for (let i = 0; i < si.count; i += step) {
      // the bone that moves this vertex most
      let best = -1, bw = 0;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
      if (best < 0 || bw < 0.4) continue;
      const bone = bones[best];
      const s = segOf.get(bone);
      if (!s) continue;
      p.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
      if (!dists.has(bone)) dists.set(bone, []);
      dists.get(bone).push(segDist(p, s.a, s.b));
    }
  }
  const out = new Map();
  for (const [bone, d] of dists) {
    if (d.length < 6) continue;
    d.sort((x, y) => x - y);
    // 75th percentile: the body of the part, not stray spikes (fur tufts, horns)
    const radius = d[Math.floor(d.length * 0.75)];
    const s = segOf.get(bone);
    out.set(bone, { radius, length: s.a.distanceTo(s.b) });
  }
  creature.applySnapshot(pose);
  creature.root.updateMatrixWorld(true);
  return out;
}

/** Wireframe capsules that follow the bones (viewport display). */
export class CapsuleView {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Collision';
    this.group.visible = false;
    scene.add(this.group);
    this.items = [];
    this.mat = new THREE.MeshBasicMaterial({ color: 0x64d2ff, wireframe: true, transparent: true, opacity: 0.35, depthTest: false });
  }

  set(creature, capsules, scale = 1) {
    for (const it of this.items) { this.group.remove(it.mesh); it.mesh.geometry.dispose(); }
    this.items = [];
    if (!capsules) return;
    for (const [bone, c] of capsules) {
      const kids = bone.children.filter((x) => x.isBone && creature.bones.includes(x));
      const r = c.radius * scale;
      const g = new THREE.CapsuleGeometry(Math.max(r, 1e-4), Math.max(c.length, 1e-4), 3, 10);
      const mesh = new THREE.Mesh(g, this.mat);
      mesh.renderOrder = 9;
      this.group.add(mesh);
      this.items.push({ bone, kids, mesh, length: c.length });
    }
  }

  update() {
    if (!this.group.visible) return;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const it of this.items) {
      a.setFromMatrixPosition(it.bone.matrixWorld);
      if (it.kids.length) {
        b.set(0, 0, 0);
        it.kids.forEach((k) => b.add(new THREE.Vector3().setFromMatrixPosition(k.matrixWorld)));
        b.divideScalar(it.kids.length);
      } else if (it.bone.parent && it.bone.parent.isBone) {
        const pa = new THREE.Vector3().setFromMatrixPosition(it.bone.parent.matrixWorld);
        b.copy(a).add(a.clone().sub(pa).normalize().multiplyScalar(it.length));
      } else b.copy(a).add(new THREE.Vector3(0, it.length, 0));
      const dir = b.clone().sub(a);
      const len = dir.length();
      it.mesh.position.copy(a).add(b).multiplyScalar(0.5);
      if (len > 1e-9) it.mesh.quaternion.setFromUnitVectors(up, dir.divideScalar(len));
    }
  }
}
