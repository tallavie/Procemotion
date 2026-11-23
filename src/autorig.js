// Rigging: add bone chains (ears, tentacles, tails...) to a rigged or unrigged model, skin them automatically,
// place template skeletons for models without bones, and find parts the existing skeleton does not move.
// Everything here runs with the creature in its BIND pose, where bone and vertex positions agree.
import * as THREE from 'three';
import { worldPos } from './ik.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _ab = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ geometry helpers

/** World positions (bind pose) of a mesh's vertices. */
export function meshVertices(mesh) {
  const pos = mesh.geometry.attributes.position;
  const out = new Float32Array(pos.count * 3);
  mesh.updateMatrixWorld(true);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
  }
  return out;
}

/** Distance from p to segment ab and the 0..1 position along it. */
function segDist(p, a, b) {
  _ab.subVectors(b, a);
  const l2 = _ab.lengthSq();
  let t = l2 > 0 ? _w.subVectors(p, a).dot(_ab) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  _w.copy(a).addScaledVector(_ab, t);
  return { d: p.distanceTo(_w), t };
}

/** Bone segments (joint -> mean of child joints) for distance tests. */
export function boneSegments(bones, keep = null) {
  const set = new Set(bones);
  const segs = [];
  for (const b of bones) {
    if (keep && !keep.has(b)) continue;
    const a = worldPos(b);
    const kids = b.children.filter((c) => set.has(c) && (!keep || keep.has(c)));
    let end;
    if (kids.length) {
      end = new THREE.Vector3();
      kids.forEach((k) => end.add(worldPos(k)));
      end.divideScalar(kids.length);
    } else if (b.parent && b.parent.isBone) {
      const pa = worldPos(b.parent);
      end = a.clone().add(a.clone().sub(pa).multiplyScalar(0.35));
    } else end = a.clone().add(new THREE.Vector3(0, 1e-3, 0));
    segs.push({ bone: b, a, b: end });
  }
  return segs;
}

/** Vertex neighbours, welding vertices that share a position (UV seams). */
export function adjacency(mesh) {
  const pos = mesh.geometry.attributes.position;
  const n = pos.count;
  const weld = new Int32Array(n);
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let id = map.get(k);
    if (id === undefined) { id = i; map.set(k, i); }
    weld[i] = id;
  }
  const nb = new Map();
  const link = (a, b) => {
    a = weld[a]; b = weld[b];
    if (a === b) return;
    if (!nb.has(a)) nb.set(a, new Set());
    if (!nb.has(b)) nb.set(b, new Set());
    nb.get(a).add(b); nb.get(b).add(a);
  };
  const idx = mesh.geometry.index;
  const tri = idx ? idx.count : n;
  for (let i = 0; i + 2 < tri; i += 3) {
    const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
    link(a, b); link(b, c); link(c, a);
  }
  return { weld, nb };
}

// ------------------------------------------------------------------ weights

/**
 * Inverse-distance weights to segments, 4 influences, then smoothed across the surface.
 * Returns { index: Uint16Array(n*4), weight: Float32Array(n*4) } with segment indices.
 */
function distanceWeights(verts, segs, adj, smooth = 3, power = 4) {
  const n = verts.length / 3;
  const S = segs.length;
  const dense = new Float32Array(n * S);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
    let best = Infinity;
    const ds = new Float32Array(S);
    for (let s = 0; s < S; s++) { ds[s] = segDist(p, segs[s].a, segs[s].b).d; if (ds[s] < best) best = ds[s]; }
    let sum = 0;
    for (let s = 0; s < S; s++) {
      // only bones nearly as close as the closest one count (keeps limbs from pulling each other)
      const r = ds[s] / Math.max(best, 1e-6);
      const w = r > 2.2 ? 0 : 1 / Math.pow(ds[s] + 1e-4, power);
      dense[i * S + s] = w; sum += w;
    }
    for (let s = 0; s < S; s++) dense[i * S + s] /= sum || 1;
  }
  smoothDense(dense, n, S, adj, smooth);
  return topFour(dense, n, S);
}

function smoothDense(dense, n, S, adj, iterations) {
  if (!adj || iterations <= 0) return;
  const tmp = new Float32Array(dense.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const w = adj.weld[i];
      const nb = adj.nb.get(w);
      const base = i * S;
      if (!nb || !nb.size) { for (let s = 0; s < S; s++) tmp[base + s] = dense[base + s]; continue; }
      for (let s = 0; s < S; s++) {
        let acc = dense[w * S + s] * 0.5;
        const k = 0.5 / nb.size;
        for (const j of nb) acc += dense[j * S + s] * k;
        tmp[base + s] = acc;
      }
    }
    dense.set(tmp);
  }
}

function topFour(dense, n, S) {
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let s = 0; s < S; s++) if (dense[i * S + s] > 1e-4) row.push([s, dense[i * S + s]]);
    row.sort((a, b) => b[1] - a[1]);
    const top = row.slice(0, 4);
    const sum = top.reduce((a, r) => a + r[1], 0) || 1;
    top.forEach((r, k) => { index[i * 4 + k] = r[0]; weight[i * 4 + k] = r[1] / sum; });
    if (!top.length) weight[i * 4] = 1;
  }
  return { index, weight };
}

// ------------------------------------------------------------------ bones from points

/**
 * Bones along a polyline of world points. The first bone is parented to `parent` (or nothing).
 * Each bone's +Y points down the chain (the usual convention for chains). The last point is the tip (no bone).
 */
export function makeChainBones(points, parent, prefix) {
  const bones = [];
  let par = parent;
  for (let i = 0; i < points.length - 1; i++) {
    const b = new THREE.Bone();
    b.name = `${prefix}${i + 1}`;
    const dir = points[i + 1].clone().sub(points[i]).normalize();
    const qW = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    const worldM = new THREE.Matrix4().compose(points[i], qW, new THREE.Vector3(1, 1, 1));
    const parentM = par ? par.matrixWorld : new THREE.Matrix4();
    const local = parentM.clone().invert().multiply(worldM);
    local.decompose(b.position, b.quaternion, b.scale);
    if (par) par.add(b);
    b.updateMatrixWorld(true);
    bones.push(b);
    par = b;
  }
  // tip marker so the last bone has a length (kept unweighted, like an end bone)
  const tip = new THREE.Bone();
  tip.name = `${prefix}End`;
  const last = bones[bones.length - 1];
  tip.position.copy(last.worldToLocal(points[points.length - 1].clone()));
  last.add(tip);
  tip.updateMatrixWorld(true);
  bones.push(tip);
  return bones;
}

/** Re-sample a polyline into `count` equal pieces (count + 1 points). */
export function resample(points, count) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) { const l = points[i].distanceTo(points[i - 1]); seg.push(l); total += l; }
  const out = [points[0].clone()];
  for (let k = 1; k < count; k++) {
    let d = (total * k) / count;
    let i = 0;
    while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
    out.push(points[i].clone().lerp(points[i + 1], seg[i] ? d / seg[i] : 0));
  }
  out.push(points[points.length - 1].clone());
  return out;
}

/** Push a surface hit into the middle of the part: half way to the opposite wall along -normal. */
export function centreFromSurface(meshes, point, normal, maxDepth) {
  const ray = new THREE.Raycaster(point.clone().addScaledVector(normal, -1e-3 * maxDepth), normal.clone().negate(), 0, maxDepth);
  const saved = meshes.map((m) => { const s = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => x.side); setSide(m, THREE.DoubleSide); return s; });
  const hit = ray.intersectObjects(meshes, false)[0];
  meshes.forEach((m, i) => { const mats = Array.isArray(m.material) ? m.material : [m.material]; mats.forEach((x, k) => { x.side = saved[i][k]; }); });
  const depth = hit ? hit.distance : maxDepth * 0.25;
  return point.clone().addScaledVector(normal, -depth / 2);
}
function setSide(m, side) { (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { x.side = side; }); }

/** Mirror world points across the creature's mid plane (normal = its left axis, at `offset` along it, root-local). */
export function mirrorPoints(points, root, leftAxisLocal, offset = 0) {
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const n = leftAxisLocal.clone().normalize();
  return points.map((p) => {
    const l = p.clone().applyMatrix4(inv);
    l.addScaledVector(n, -2 * (l.dot(n) - offset));
    return l.applyMatrix4(root.matrixWorld);
  });
}

/**
 * The creature's mirror plane in the current pose, from bones whose names mirror each other (LEar/REar...).
 * Returns { normal, point } in world space, or null when the skeleton has no left/right pairs.
 */
export function mirrorPlane(creature) {
  const n = new THREE.Vector3(), c = new THREE.Vector3();
  let count = 0;
  for (const b of creature.bones) {
    const m = mirrorName(b.name);
    if (m === b.name + '_M' || !/^(L|Left)|_l\b|Left/.test(b.name)) continue;
    const o = creature.byName.get(m);
    if (!o) continue;
    const pl = worldPos(b), pr = worldPos(o);
    if (pl.distanceToSquared(pr) < 1e-10) continue;
    n.add(pl.clone().sub(pr).normalize());
    c.add(pl.add(pr).multiplyScalar(0.5));
    count++;
  }
  if (count < 2) return null;
  return { normal: n.normalize(), point: c.divideScalar(count) };
}

export function mirrorAcross(points, plane) {
  return points.map((p) => p.clone().addScaledVector(plane.normal, -2 * p.clone().sub(plane.point).dot(plane.normal)));
}

/** Mirror a bone name: Left/Right, L/R prefixes and suffixes. */
export function mirrorName(name) {
  const swaps = [[/^L(?=[A-Z_])/, 'R'], [/^R(?=[A-Z_])/, 'L'], [/Left/g, 'Right'], [/Right/g, 'Left'], [/_l(\b|_)/g, '_r$1'], [/_r(\b|_)/g, '_l$1']];
  for (const [rx, rep] of swaps) if (rx.test(name)) return name.replace(rx, rep);
  return name + '_M';
}

/** The bone whose segment passes closest to a point (candidate parent for a new chain). */
export function nearestBone(creature, point, only = null) {
  const keep = only ? new Set(only) : creature.weighted.size ? creature.weighted : null;
  const segs = boneSegments(creature.bones, keep);
  let best = null, bd = Infinity;
  for (const s of segs) { const { d } = segDist(point, s.a, s.b); if (d < bd) { bd = d; best = s.bone; } }
  return best;
}

// ------------------------------------------------------------------ adding chains to a skinned model

/**
 * Skin the new chain into every skinned mesh: vertices clearly closer to the chain than to the old skeleton
 * move over to it, blending at the border. Returns an undo record.
 * @param chain bones from makeChainBones (the last one is the unweighted tip)
 */
export function skinChain(creature, chain, { falloff = 0.6, smooth = 2 } = {}) {
  creature.root.updateMatrixWorld(true);
  const undo = [];
  const weightBones = chain.slice(0, -1);
  const chainSegs = weightBones.map((b, i) => ({ bone: b, a: worldPos(b), b: worldPos(chain[i + 1]) }));
  const skeletons = new Map();
  for (const mesh of creature.meshes) {
    const old = mesh.skeleton;
    const geo = mesh.geometry;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    undo.push({ mesh, skeleton: old, bindMatrix: mesh.bindMatrix.clone(), skinIndex: si.array.slice(), skinWeight: sw.array.slice() });

    // new skeleton (shared between meshes that shared the old one)
    let sk = skeletons.get(old);
    if (!sk) {
      const inv = chain.map((b) => boneInverseFor(b, mesh));
      sk = new THREE.Skeleton([...old.bones, ...chain], [...old.boneInverses, ...inv]);
      skeletons.set(old, sk);
    }
    const base = old.bones.length;

    const verts = meshVertices(mesh);
    const oldWeighted = new Set();
    for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.01) oldWeighted.add(old.bones[si.getComponent(i, k)]);
    const oldSegs = boneSegments(old.bones, oldWeighted);
    const n = si.count;
    const f = new Float32Array(n);
    const near = new Int32Array(n).fill(-1);
    const p = new THREE.Vector3();
    let any = false;
    for (let i = 0; i < n; i++) {
      p.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
      let dNew = Infinity, which = -1;
      chainSegs.forEach((s, k) => { const r = segDist(p, s.a, s.b); if (r.d < dNew) { dNew = r.d; which = k; } });
      let dOld = Infinity;
      for (const s of oldSegs) { const r = segDist(p, s.a, s.b); if (r.d < dOld) dOld = r.d; }
      if (dNew >= dOld) continue;
      const x = (dOld - dNew) / Math.max(falloff * dOld, 1e-6);
      f[i] = x >= 1 ? 1 : x * x * (3 - 2 * x);
      near[i] = which;
      any = true;
    }
    if (any) {
      // smooth the blend factor over the surface so the border is soft
      const adj = adjacency(mesh);
      for (let it = 0; it < smooth; it++) {
        const g = f.slice();
        for (let i = 0; i < n; i++) {
          const nb = adj.nb.get(adj.weld[i]);
          if (!nb || !nb.size) continue;
          let acc = 0; for (const j of nb) acc += f[j];
          g[i] = 0.5 * f[adj.weld[i]] + 0.5 * (acc / nb.size);
        }
        f.set(g);
      }
      for (let i = 0; i < n; i++) {
        if (f[i] <= 1e-3) continue;
        p.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        // weights among the chain bones (closest two)
        const ds = chainSegs.map((s) => segDist(p, s.a, s.b).d);
        const order = ds.map((d, k) => [k, d]).sort((a, b) => a[1] - b[1]).slice(0, 2);
        const raw = order.map(([k, d]) => [base + k, 1 / Math.pow(d + 1e-4, 4)]);
        const rs = raw.reduce((a, r) => a + r[1], 0);
        const merged = new Map();
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k) * (1 - f[i]);
          if (w > 0) merged.set(si.getComponent(i, k), (merged.get(si.getComponent(i, k)) || 0) + w);
        }
        for (const [bi, w] of raw) merged.set(bi, (merged.get(bi) || 0) + (w / rs) * f[i]);
        const top = [...merged].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const sum = top.reduce((a, r) => a + r[1], 0) || 1;
        for (let k = 0; k < 4; k++) {
          si.setComponent(i, k, top[k] ? top[k][0] : 0);
          sw.setComponent(i, k, top[k] ? top[k][1] / sum : 0);
        }
      }
      si.needsUpdate = true; sw.needsUpdate = true;
    }
    mesh.bind(sk, mesh.bindMatrix);
  }
  for (const old of skeletons.keys()) old.dispose();
  creature.collectBones();
  return undo;
}

/** Inverse bind matrix for a bone posed in the bind pose: Bw^-1 * meshWorld * bindMatrix^-1. */
function boneInverseFor(bone, mesh) {
  bone.updateMatrixWorld(true);
  return new THREE.Matrix4().copy(bone.matrixWorld).invert().multiply(mesh.matrixWorld).multiply(new THREE.Matrix4().copy(mesh.bindMatrix).invert());
}

export function undoSkin(creature, undo, chainRoots) {
  for (const u of undo) {
    const geo = u.mesh.geometry;
    geo.attributes.skinIndex.array.set(u.skinIndex); geo.attributes.skinIndex.needsUpdate = true;
    geo.attributes.skinWeight.array.set(u.skinWeight); geo.attributes.skinWeight.needsUpdate = true;
    const cur = u.mesh.skeleton;
    u.mesh.bind(u.skeleton, u.bindMatrix);
    if (cur !== u.skeleton) cur.dispose();
  }
  for (const b of chainRoots) b.parent && b.parent.remove(b);
  creature.collectBones();
}

// ------------------------------------------------------------------ more bones along a chain (smoother bends)

/**
 * Insert `parts - 1` bones inside every segment of a chain (bone -> its child), for smoother bending.
 * Run in the BIND pose. The inserted bones have no rotation of their own and sit on the segment, so:
 *  - the model's own clips still play the same (each child's position keys are shifted by the inserted offset),
 *  - each vertex the old bone moved is shared by the sub-bones according to where it lies along the segment.
 * @param chain bones from parent to child (consecutive pairs that are parent/child are split)
 * @returns the new bones
 */
export function subdivideChain(creature, chain, parts = 2) {
  if (parts < 2) return [];
  creature.root.updateMatrixWorld(true);
  const segs = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], c = chain[i + 1];
    if (c.parent !== a) continue;
    const A = worldPos(a), C = worldPos(c);
    const ri = creature.bones.indexOf(c);
    const restLocal = (ri >= 0 ? creature.rest[ri].p : c.position).clone();
    if (A.distanceTo(C) < 1e-6 || restLocal.lengthSq() < 1e-12) continue; // joints on top of each other: nothing to split
    segs.push({ a, c, A, C, restLocal, subs: [a] });
  }
  if (!segs.length) return [];
  const taken = new Set(creature.bones.map((b) => b.name));
  const unique = (base) => { let n = base, i = 2; while (taken.has(n)) n = `${base}_${i++}`; taken.add(n); return n; };

  // 1. hierarchy: a -> s1 -> s2 ... -> c, every step 1/parts of the old offset, no rotation
  const created = [];
  for (const s of segs) {
    const step = s.restLocal.clone().multiplyScalar(1 / parts);
    let prev = s.a;
    for (let k = 1; k < parts; k++) {
      const nb = new THREE.Bone();
      nb.name = unique(`${s.a.name}_LF${k}`);
      nb.position.copy(step);
      prev.add(nb);
      prev = nb;
      s.subs.push(nb);
      created.push(nb);
    }
    s.shift = step.clone().multiplyScalar(parts - 1); // what now lies between a and c
    const keepQ = s.c.quaternion.clone(), keepS = s.c.scale.clone();
    prev.add(s.c);
    s.c.position.sub(s.shift);
    s.c.quaternion.copy(keepQ); s.c.scale.copy(keepS);
    const ri = creature.bones.indexOf(s.c);
    if (ri >= 0) creature.rest[ri].p.sub(s.shift); // its rest position is now relative to the last new bone
  }
  creature.root.updateMatrixWorld(true);

  // 2. the model's clips: the child's position keys were relative to `a`
  for (const clip of creature.animations) {
    for (const t of clip.tracks) {
      if (!t.name.endsWith('.position')) continue;
      const s = segs.find((x) => t.name === `${x.c.name}.position`);
      if (!s) continue;
      for (let i = 0; i < t.values.length; i += 3) { t.values[i] -= s.shift.x; t.values[i + 1] -= s.shift.y; t.values[i + 2] -= s.shift.z; }
    }
  }

  // 3. skins: new bones join every skeleton; weights of `a` are shared along the segment
  const skeletons = new Map();
  for (const mesh of creature.meshes) {
    const old = mesh.skeleton;
    let sk = skeletons.get(old);
    if (!sk) {
      sk = new THREE.Skeleton([...old.bones, ...created], [...old.boneInverses, ...created.map((b) => boneInverseFor(b, mesh))]);
      skeletons.set(old, sk);
    }
    const geo = mesh.geometry;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const index = new Map(sk.bones.map((b, i) => [b, i]));
    const verts = meshVertices(mesh);
    const p = new THREE.Vector3();
    for (let i = 0; i < si.count; i++) {
      const merged = new Map();
      let touched = false;
      // a vertex already at 4 influences has no room for a split: give the whole weight to the nearest sub-bone
      // (still exact for the model's own clips, since the sub-bones move with their bone there)
      let used = 0;
      for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0) used++;
      const room = used < 4;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0) continue;
        const bone = sk.bones[si.getComponent(i, k)];
        const s = segs.find((x) => x.a === bone);
        if (!s) { merged.set(si.getComponent(i, k), (merged.get(si.getComponent(i, k)) || 0) + w); continue; }
        touched = true;
        p.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        _ab.subVectors(s.C, s.A);
        const t = THREE.MathUtils.clamp(_w.subVectors(p, s.A).dot(_ab) / _ab.lengthSq(), 0, 1);
        const x = t * parts - 0.5;
        const k0 = THREE.MathUtils.clamp(Math.floor(x), 0, parts - 1);
        const k1 = Math.min(k0 + 1, parts - 1);
        let f = THREE.MathUtils.clamp(x - k0, 0, 1);
        if (!room) f = f < 0.5 ? 0 : 1;
        const b0 = index.get(s.subs[k0]), b1 = index.get(s.subs[k1]);
        merged.set(b0, (merged.get(b0) || 0) + w * (1 - f));
        if (f > 0) merged.set(b1, (merged.get(b1) || 0) + w * f);
      }
      if (!touched) continue;
      const top = [...merged].sort((u, v) => v[1] - u[1]).slice(0, 4);
      const sum = top.reduce((a, r) => a + r[1], 0) || 1;
      for (let k = 0; k < 4; k++) {
        si.setComponent(i, k, top[k] ? top[k][0] : 0);
        sw.setComponent(i, k, top[k] ? top[k][1] / sum : 0);
      }
    }
    si.needsUpdate = true; sw.needsUpdate = true;
    mesh.bind(sk, mesh.bindMatrix);
  }
  for (const old of skeletons.keys()) old.dispose();
  creature.collectBones();
  return created;
}

// ------------------------------------------------------------------ template rigs for models without bones

/** Joint layouts in bounding-box fractions: x = left (-.5..5), y = up (0..1), z = forward (-.5..5). */
const T = {
  biped: [
    ['Pelvis', -1, [0, 0.5, 0]], ['Spine1', 0, [0, 0.62, 0]], ['Spine2', 1, [0, 0.74, 0]], ['Neck', 2, [0, 0.84, 0]],
    ['Head', 3, [0, 0.9, 0.02]], ['HeadEnd', 4, [0, 1, 0.02]],
    ['LThigh', 0, [0.11, 0.47, 0]], ['LLeg', 6, [0.11, 0.26, 0.03]], ['LFoot', 7, [0.11, 0.05, 0]], ['LToe', 8, [0.11, 0.01, 0.12]],
    ['RThigh', 0, [-0.11, 0.47, 0]], ['RLeg', 10, [-0.11, 0.26, 0.03]], ['RFoot', 11, [-0.11, 0.05, 0]], ['RToe', 12, [-0.11, 0.01, 0.12]],
    ['LArm', 2, [0.14, 0.8, 0]], ['LForeArm', 14, [0.28, 0.68, 0]], ['LHand', 15, [0.38, 0.56, 0.02]], ['LHandEnd', 16, [0.44, 0.5, 0.03]],
    ['RArm', 2, [-0.14, 0.8, 0]], ['RForeArm', 18, [-0.28, 0.68, 0]], ['RHand', 19, [-0.38, 0.56, 0.02]], ['RHandEnd', 20, [-0.44, 0.5, 0.03]],
  ],
  quadruped: [
    ['Pelvis', -1, [0, 0.62, -0.3]], ['Spine1', 0, [0, 0.64, -0.05]], ['Chest', 1, [0, 0.64, 0.2]], ['Neck', 2, [0, 0.76, 0.34]],
    ['Head', 3, [0, 0.86, 0.42]], ['HeadEnd', 4, [0, 0.84, 0.5]],
    ['LThigh', 0, [0.2, 0.56, -0.3]], ['LLeg', 6, [0.2, 0.32, -0.24]], ['LFoot', 7, [0.2, 0.13, -0.33]], ['LToe', 8, [0.2, 0.01, -0.3]],
    ['RThigh', 0, [-0.2, 0.56, -0.3]], ['RLeg', 10, [-0.2, 0.32, -0.24]], ['RFoot', 11, [-0.2, 0.13, -0.33]], ['RToe', 12, [-0.2, 0.01, -0.3]],
    ['LArm', 2, [0.2, 0.56, 0.24]], ['LForeArm', 14, [0.2, 0.33, 0.27]], ['LHand', 15, [0.2, 0.1, 0.26]], ['LFinger', 16, [0.2, 0.01, 0.3]],
    ['RArm', 2, [-0.2, 0.56, 0.24]], ['RForeArm', 18, [-0.2, 0.33, 0.27]], ['RHand', 19, [-0.2, 0.1, 0.26]], ['RFinger', 20, [-0.2, 0.01, 0.3]],
    ['Tail1', 0, [0, 0.64, -0.4]], ['Tail2', 22, [0, 0.62, -0.46]], ['Tail3', 23, [0, 0.6, -0.5]],
  ],
  bird: [
    ['Pelvis', -1, [0, 0.42, -0.05]], ['Chest', 0, [0, 0.56, 0.12]], ['Neck', 1, [0, 0.72, 0.22]], ['Head', 2, [0, 0.86, 0.28]], ['HeadEnd', 3, [0, 0.9, 0.42]],
    ['LThigh', 0, [0.1, 0.4, 0]], ['LLeg', 5, [0.1, 0.22, 0.05]], ['LFoot', 6, [0.1, 0.06, 0]], ['LToe', 7, [0.1, 0, 0.1]],
    ['RThigh', 0, [-0.1, 0.4, 0]], ['RLeg', 9, [-0.1, 0.22, 0.05]], ['RFoot', 10, [-0.1, 0.06, 0]], ['RToe', 11, [-0.1, 0, 0.1]],
    ['LWing1', 1, [0.1, 0.6, 0.1]], ['LWing2', 13, [0.26, 0.62, 0.05]], ['LWing3', 14, [0.4, 0.62, 0]], ['LWingEnd', 15, [0.5, 0.62, -0.05]],
    ['RWing1', 1, [-0.1, 0.6, 0.1]], ['RWing2', 17, [-0.26, 0.62, 0.05]], ['RWing3', 18, [-0.4, 0.62, 0]], ['RWingEnd', 19, [-0.5, 0.62, -0.05]],
    ['Tail1', 0, [0, 0.42, -0.22]], ['Tail2', 21, [0, 0.4, -0.4]], ['TailEnd', 22, [0, 0.38, -0.5]],
  ],
  snake: Array.from({ length: 11 }, (_, i) => [i === 0 ? 'Head' : i === 10 ? 'TailEnd' : `Spine${i}`, i - 1, [0, 0.5, 0.45 - i * 0.09]]),
  floater: [
    ['Body', -1, [0, 0.55, 0]], ['Top', 0, [0, 0.85, 0]], ['TopEnd', 1, [0, 1, 0]],
  ],
};
export const TEMPLATE_NAMES = { biped: 'Two legs', quadruped: 'Four legs', bird: 'Bird / winged', snake: 'Snake / worm', floater: 'Floating body' };

/** Template joints placed in the model's bounds (root-local box, creature frame vectors). */
export function templateJoints(kind, box, frame) {
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  // extents along the creature frame
  const wx = Math.abs(size.dot(frame.l)) || size.x, wz = Math.abs(size.dot(frame.f)) || size.z;
  return T[kind].map(([name, parent, [x, y, z]]) => ({
    name, parent,
    pos: new THREE.Vector3(c.x, box.min.y + y * size.y, c.z).addScaledVector(frame.l, x * wx).addScaledVector(frame.f, z * wz),
  }));
}

/**
 * Build bones from joints (root-local positions) under creature.root, turn every mesh into a skinned mesh
 * and give it automatic weights. Joints without children become unweighted end bones.
 */
export function bindTemplate(creature, joints) {
  const root = creature.root;
  root.updateMatrixWorld(true);
  const bones = joints.map((j) => { const b = new THREE.Bone(); b.name = j.name; return b; });
  const world = joints.map((j) => j.pos.clone().applyMatrix4(root.matrixWorld));
  joints.forEach((j, i) => {
    const b = bones[i];
    const parent = j.parent >= 0 ? bones[j.parent] : root;
    parent.add(b);
    parent.updateMatrixWorld(true);
    b.position.copy(parent.worldToLocal(world[i].clone()));
    b.updateMatrixWorld(true);
  });
  const hasKids = new Set(joints.filter((j) => j.parent >= 0).map((j) => j.parent));
  const weightBones = bones.filter((_, i) => hasKids.has(i));
  const segs = weightBones.map((b) => {
    const i = bones.indexOf(b);
    const kids = joints.map((j, k) => (j.parent === i ? k : -1)).filter((k) => k >= 0);
    const end = new THREE.Vector3(); kids.forEach((k) => end.add(world[k])); end.divideScalar(kids.length);
    return { bone: b, a: world[i].clone(), b: end };
  });

  const meshes = [];
  root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
  const skeleton = new THREE.Skeleton(bones);
  for (const mesh of meshes) {
    const verts = meshVertices(mesh);
    const adj = adjacency(mesh);
    const { index, weight } = distanceWeights(verts, segs, adj, 3);
    // segment index -> bone index
    const map = segs.map((s) => bones.indexOf(s.bone));
    for (let i = 0; i < index.length; i++) index[i] = map[index[i]];
    const geo = mesh.geometry;
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    const sm = new THREE.SkinnedMesh(geo, mesh.material);
    sm.name = mesh.name || 'Body';
    sm.position.copy(mesh.position); sm.quaternion.copy(mesh.quaternion); sm.scale.copy(mesh.scale);
    sm.castShadow = mesh.castShadow; sm.receiveShadow = mesh.receiveShadow;
    const parent = mesh.parent;
    parent.add(sm);
    parent.remove(mesh);
    sm.updateMatrixWorld(true);
    sm.bind(skeleton, sm.matrixWorld);
  }
  creature.meshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) creature.meshes.push(o); });
  creature.collectBones();
  return bones;
}

// ------------------------------------------------------------------ parts the skeleton does not move

/**
 * Find surface regions far from every weighted bone (e.g. ears with no bones) and propose a chain for each.
 * @returns [{ mesh, verts: index[], points: Vector3[], length, guess }]
 */
export function findUnrigged(creature, info, { threshold = 0.1, minVerts = 25 } = {}) {
  const out = [];
  const H = info.H;
  for (const mesh of creature.meshes) {
    const geo = mesh.geometry;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (!si || !sw) continue;
    const bones = mesh.skeleton.bones;
    const weighted = new Set();
    for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.01) weighted.add(bones[si.getComponent(i, k)]);
    const segs = boneSegments(bones, weighted);
    if (!segs.length) continue;
    const verts = meshVertices(mesh);
    const n = si.count;
    const dist = new Float32Array(n);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
      let d = Infinity;
      for (const s of segs) { const r = segDist(p, s.a, s.b).d; if (r < d) d = r; }
      dist[i] = d;
    }
    const adj = adjacency(mesh);
    const far = new Set();
    for (let i = 0; i < n; i++) if (dist[i] > threshold * H) far.add(adj.weld[i]);
    const seen = new Set();
    for (const s of far) {
      if (seen.has(s)) continue;
      const cluster = [];
      const queue = [s]; seen.add(s);
      while (queue.length) {
        const v = queue.pop(); cluster.push(v);
        for (const w of adj.nb.get(v) || []) if (far.has(w) && !seen.has(w)) { seen.add(w); queue.push(w); }
      }
      if (cluster.length < minVerts) continue;
      const P = (i) => new THREE.Vector3(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
      // base = the ring where the region meets the rigged surface; tip = farthest from it
      const inC = new Set(cluster);
      const ring = cluster.filter((v) => [...(adj.nb.get(v) || [])].some((w) => !inC.has(w)));
      const base = new THREE.Vector3();
      (ring.length ? ring : cluster).forEach((v) => base.add(P(v)));
      base.divideScalar((ring.length || cluster.length));
      let tipV = cluster[0], td = -1;
      for (const v of cluster) { const d = P(v).distanceTo(base); if (d > td) { td = d; tipV = v; } }
      if (td < 0.12 * H) continue;
      const tip = P(tipV);
      // spine of the part: centroids of slices from base to tip
      const axis = tip.clone().sub(base).normalize();
      const N = 6;
      const pts = [];
      for (let k = 0; k <= N; k++) {
        const c = base.clone().lerp(tip, k / N);
        const acc = new THREE.Vector3(); let cnt = 0;
        const half = td / N * 0.6;
        for (const v of cluster) { const q = P(v); if (Math.abs(q.clone().sub(c).dot(axis)) < half) { acc.add(q); cnt++; } }
        pts.push(cnt ? acc.divideScalar(cnt) : c);
      }
      pts[pts.length - 1] = tip.clone().lerp(pts[pts.length - 1], 0.3);
      const nearHead = info.head && worldPos(info.head).distanceTo(base) < 0.35 * H;
      const up = axis.y > 0.35;
      const thin = td > 2.5 * (Math.sqrt(cluster.length) * 0.02 * H + 1e-6);
      const guess = nearHead && up ? 'ear' : thin ? 'tentacle' : 'appendage';
      out.push({ mesh, verts: cluster, points: pts, length: td, guess });
    }
  }
  return out;
}
