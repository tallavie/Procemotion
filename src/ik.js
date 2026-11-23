// Bone math in world space: rotate a bone by a world rotation, aim a bone at a point, FABRIK chains.
import * as THREE from 'three';

const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

export function worldPos(o, out = new THREE.Vector3()) { return out.setFromMatrixPosition(o.matrixWorld); }

export function worldQuat(o, out = new THREE.Quaternion()) {
  o.matrixWorld.decompose(_a, out, _b);
  return out;
}

/** Set a bone's world rotation (parent matrices must be current); updates the bone's subtree. */
export function setWorldQuat(bone, qWorld) {
  if (bone.parent) {
    bone.parent.matrixWorld.decompose(_a, _qp, _b);
    bone.quaternion.copy(_qp.invert().multiply(qWorld));
  } else bone.quaternion.copy(qWorld);
  bone.updateMatrixWorld(true);
}

/** Rotate a bone by a world-space rotation about its own pivot. */
export function rotateWorld(bone, qDelta) {
  worldQuat(bone, _q);
  setWorldQuat(bone, _q.premultiply(qDelta));
}

/** Rotate a bone by angle (radians) around a world axis. */
export function rotateAxis(bone, axis, angle) {
  if (!angle) return;
  rotateWorld(bone, new THREE.Quaternion().setFromAxisAngle(axis, angle));
}

/** Turn `bone` so that the point `childPos` (world, currently attached to it) moves onto `target`. */
export function aimBone(bone, childPos, target, weight = 1) {
  worldPos(bone, _a);
  _b.copy(childPos).sub(_a);
  _c.copy(target).sub(_a);
  if (_b.lengthSq() < 1e-12 || _c.lengthSq() < 1e-12) return;
  _b.normalize(); _c.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(_b, _c);
  if (weight < 1) q.slerp(_q.identity(), 1 - weight);
  rotateWorld(bone, q);
}

/** Move a bone (in world space) by a world offset. */
export function translateWorld(bone, delta) {
  if (bone.parent) {
    const inv = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
    worldPos(bone, _a).add(delta).applyMatrix4(inv);
    bone.position.copy(_a);
  } else bone.position.add(delta);
  bone.updateMatrixWorld(true);
}

/**
 * FABRIK on a contiguous parent->child chain. joints[0] stays; joints[n-1] reaches for target.
 * Starts from the current pose, so the knee keeps bending the way the reference pose bends it.
 * pole (optional world point) pulls the middle of the chain towards it.
 */
export function solveFABRIK(joints, target, { iterations = 12, pole = null, poleWeight = 0.5 } = {}) {
  const n = joints.length;
  if (n < 2) return;
  const pos = joints.map((j) => worldPos(j));
  const len = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) { len.push(pos[i + 1].distanceTo(pos[i])); total += len[i]; }
  if (total < 1e-9) return;
  const root = pos[0].clone();
  const t = target.clone();
  const d = t.distanceTo(root);
  if (d >= total * 0.9999) {
    const dir = t.sub(root).normalize();
    for (let i = 0; i < n - 1; i++) pos[i + 1].copy(pos[i]).addScaledVector(dir, len[i]);
  } else {
    if (pole && n > 2) {
      // nudge the middle joints towards the pole before solving (helps a straight start pick a side)
      for (let i = 1; i < n - 1; i++) pos[i].lerp(_a.copy(pole), poleWeight * 0.15);
    }
    for (let it = 0; it < iterations; it++) {
      pos[n - 1].copy(target);
      for (let i = n - 2; i >= 0; i--) {
        _a.copy(pos[i]).sub(pos[i + 1]);
        if (_a.lengthSq() < 1e-12) _a.set(0, 1, 0);
        pos[i].copy(pos[i + 1]).addScaledVector(_a.normalize(), len[i]);
      }
      pos[0].copy(root);
      for (let i = 0; i < n - 1; i++) {
        _a.copy(pos[i + 1]).sub(pos[i]);
        if (_a.lengthSq() < 1e-12) _a.set(0, -1, 0);
        pos[i + 1].copy(pos[i]).addScaledVector(_a.normalize(), len[i]);
      }
      if (pos[n - 1].distanceToSquared(target) < total * total * 1e-6) break;
    }
    if (pole && n > 2) bendTowards(pos, pole);
  }
  applyPositions(joints, pos);
}

/**
 * Turn the solved chain about its root->tip axis so its bend points at the pole.
 * Ends and bone lengths do not change; the knee or elbow can no longer flip from frame to frame.
 */
function bendTowards(pos, pole) {
  const n = pos.length;
  const root = pos[0];
  const axis = _a.copy(pos[n - 1]).sub(root);
  if (axis.lengthSq() < 1e-12) return;
  axis.normalize();
  const mid = _b.set(0, 0, 0);
  for (let i = 1; i < n - 1; i++) mid.add(pos[i]);
  mid.divideScalar(n - 2).sub(root);
  mid.addScaledVector(axis, -mid.dot(axis));
  const want = _c.copy(pole).sub(root);
  want.addScaledVector(axis, -want.dot(axis));
  if (mid.lengthSq() < 1e-12 || want.lengthSq() < 1e-12) return;
  mid.normalize(); want.normalize();
  const angle = Math.atan2(new THREE.Vector3().crossVectors(mid, want).dot(axis), mid.dot(want));
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  for (let i = 1; i < n - 1; i++) pos[i].sub(root).applyQuaternion(q).add(root);
}

/** Rotate each joint of the chain so that its child lands on the solved positions. */
export function applyPositions(joints, pos) {
  for (let i = 0; i < joints.length - 1; i++) {
    const child = worldPos(joints[i + 1]);
    aimBone(joints[i], child, pos[i + 1]);
  }
}

/** Critically damped spring towards a target (per axis), frame-rate independent. halfLife in seconds. */
export function damp(current, target, halfLife, dt) {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(0.5, dt / halfLife);
}

export function dampVec(current, target, halfLife, dt) {
  if (halfLife <= 0) return current.copy(target);
  const k = 1 - Math.pow(0.5, dt / halfLife);
  return current.lerp(target, k);
}

export const easeInOut = (x) => x * x * (3 - 2 * x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
