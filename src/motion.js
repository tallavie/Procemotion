// The procedural motion engine. Every frame starts from the reference pose and layers:
// body movement -> footsteps on the terrain (any number of legs) -> pelvis / spine / head -> action overlay
// -> leg IK -> wings -> spring chains (ears, tails, tentacles, hair). Parameters mirror UE's Locomotor node.
import * as THREE from 'three';
import { worldPos, worldQuat, setWorldQuat, rotateAxis, aimBone, translateWorld, solveFABRIK, damp, clamp01 } from './ik.js';

const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _d = V();
const _vt = [];
// how far (degrees) each segment of a springy part may swing away from where the pose puts it
const MAX_SWING = { ear: 50, tail: 75, tentacle: 110, appendage: 45, wing: 40, hair: 60 };
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;

export function defaultParams() {
  return {
    // runStyle: gallop = at running speed the legs of each pair move (almost) together, front pairs and hind pairs
    // half a stride apart, with a moment in the air (bound/gallop of crocodiles, dogs; a seal's two flippers together)
    // allFours: a creature with two legs and two arms drops onto its hands when it gallops (a bear)
    movement: { speed: 0.35, maxSpeed: 2.4, accel: 3, decel: 3.5, turnRate: 120, phaseMin: 1.1, phaseMax: 2.8, minStep: 0.08, timeScale: 1, runStyle: 'gallop', allFours: true },
    stepping: { air: 0.35, airExt: 0.2, stepHeight: 0.2, easeIn: 0.5, easeOut: 0.2, groundCollision: true, maxCollision: 0.6, footRadius: 0.06, footPitch: 0.8, footRoll: 0.5 },
    // flex / rock (deg) = up-down bending of the back and rocking of the body while galloping;
    // hump (x height) = the wave that lifts the chest and runs back along a body lying on the ground (seal)
    pelvis: { halfLife: 0.1, bob: 0.05, lead: 0.03, pitch: 0.7, roll: 0.5, lean: 10, bank: 8, flex: 14, rock: 7, hump: 0.06 },
    head: { stabilize: 0.6, lookAhead: 0.5 },
    // collision volume detected from the mesh (one capsule per bone); scale grows or shrinks every capsule
    collision: { on: true, scale: 1 },
    // serpent body (fractions of the body length): wave width, wave length, raised neck; flyAmp = up-down wave in the air
    slither: { amp: 0.07, wavelength: 0.55, idleAmp: 0.025, headRaise: 1, neck: -1, flyAmp: 0.06 },
    hover: { height: 0.12, bob: 0.04, bobFreq: 0.6, tilt: 14 },
    // ears: what ears do in flight (spring = as on the ground, flap = beat like wings, spread = held open to the sides)
    // mode: flap | flapglide (bursts of beats, then glides) | glide | hover. downstroke = share of the beat;
    // sweep = tip forward on the downstroke / back on the upstroke (deg); foldUp = elbow+wrist folding on the upstroke;
    // twist = pronation/supination (deg); burst = beats per burst, glideTime = s; bob = body rise per beat (x height)
    flight: {
      on: false, mode: 'flapglide', altitude: 1.3, flapAmp: 45, flapFreq: 2.2, lag: 0.35, dihedral: 6, tuck: 0.8, ears: 'auto',
      downstroke: 0.55, sweep: 12, foldUp: 0.75, twist: 18, burst: 3, glideTime: 1.2, bob: 0.02,
    },
  };
}

export const GAIT_PRESETS = {
  walk: { label: 'Walk', offsets: (n) => (n === 2 ? [0, 0.25] : null), air: 0.35 },
  trot: { label: 'Trot', offsets: (n) => (n === 2 ? [0, 0.5] : null), air: 0.45 },
  pace: { label: 'Pace', offsets: (n) => (n === 2 ? [0, 0] : null), air: 0.45 },
  gallop: { label: 'Gallop', offsets: (n) => (n === 2 ? [0, 0.12] : null), air: 0.6 },
  tripod: { label: 'Tripod', offsets: (n) => Array.from({ length: n }, (_, i) => (i % 2) * 0.5), air: 0.45 },
  wave: { label: 'Wave', offsets: (n) => Array.from({ length: n }, (_, i) => i / n), air: 0.25 },
};

/** Spring settings for chain types (UE: ChainHarmonics wave + pendulum, SpringInterp). */
export function defaultDynamics(type) {
  const base = { on: true, stiffness: 0.5, damping: 0.5, gravity: 0, waveAmp: 0, waveFreq: 0.8, waveShift: 0.6, waveAxis: 'side', twitch: 0, collide: false };
  switch (type) {
    case 'ear': return { ...base, stiffness: 0.55, damping: 0.35, twitch: 0.25 };
    case 'tail': return { ...base, stiffness: 0.35, damping: 0.45, gravity: 0.1, waveAmp: 10, waveFreq: 0.7, waveShift: 0.6 };
    case 'tentacle': return { ...base, stiffness: 0.22, damping: 0.4, gravity: 0.35, waveAmp: 12, waveFreq: 0.45, waveShift: 0.8, waveAxis: 'both', collide: true };
    case 'appendage': return { ...base, stiffness: 0.35, damping: 0.4, gravity: 0.2 };
    case 'wing': return { ...base, stiffness: 0.8, damping: 0.6 };
    default: return { ...base, on: false };
  }
}

export class Motion {
  constructor({ creature, holder, mover, terrain }) {
    this.creature = creature;
    this.holder = holder;
    this.mover = mover;
    this.terrain = terrain;
    this.params = defaultParams();
    this.mode = 'course';         // course | drive | inplace | stand
    this.keys = new Set();
    this.paused = false;
    this.t = 0;
    this.action = null;           // { def, t, params }
    this.overlay = emptyOverlay();
    this.flatGround = false;      // bake mode: flat floor, lift goes into the pelvis
    this.flightBlend = 0;
  }

  /** (Re)build from limb info and the reference pose snapshot. */
  setup(info, refSnap, footSets) {
    this.info = info;
    this.ref = refSnap;
    this.footSets = footSets;
    const H = info.H;
    this.H = H;
    const cr = this.creature;

    // measure the reference pose with the mover at the origin
    const saved = { p: this.mover.position.clone(), r: this.mover.rotation.y };
    this.mover.position.set(0, 0, 0); this.mover.rotation.set(0, 0, 0);
    cr.applySnapshot(refSnap);
    this.mover.updateMatrixWorld(true);

    this.legs = [];
    const legLimbs = info.limbs.filter((l) => l.type === 'leg');
    for (const limb of legLimbs) {
      const joints = limb.bones.slice(limb.ikStart, limb.effector + 1);
      if (joints.length < 2) continue;
      const eff = joints[joints.length - 1];
      const e = worldPos(eff);
      let len = 0;
      for (let i = 1; i < joints.length; i++) len += worldPos(joints[i]).distanceTo(worldPos(joints[i - 1]));
      // which way the knee/elbow bends, from the reference pose (mover space); straight legs get a default later
      const jp = joints.map((j) => worldPos(j).clone());
      // legs with 4+ joints are solved as hip-knee-ankle plus a rigid foot (solveLeg), so the knee's bend is
      // measured against the hip-ankle line only: a hind leg's heel points back while its knee points forward
      // and averaging both flipped the knee
      const upperEnd = jp.length > 3 ? 2 : jp.length - 1;
      const ax = jp[upperEnd].clone().sub(jp[0]).normalize();
      const mid = V();
      if (jp.length > 3) mid.copy(jp[1]).sub(jp[0]);
      else {
        for (let i = 1; i < jp.length - 1; i++) mid.add(jp[i]);
        if (jp.length > 2) mid.divideScalar(jp.length - 2).sub(jp[0]);
      }
      mid.addScaledVector(ax, -mid.dot(ax));
      this.legs.push({
        limb, joints, eff, bend: mid.length() > 0.04 * len ? mid.normalize() : null,
        lowerOffset: jp.length > 3 ? jp[jp.length - 1].clone().sub(jp[2]) : V(),
        restXZ: new THREE.Vector3(e.x, 0, e.z), effHeight: Math.max(0, e.y), legLen: len,
        effQuat: worldQuat(eff).clone(),
        offset: 0, pos: V(), from: V(), to: V(), swing: false, groundY: 0, normal: UP.clone(), s: 0,
      });
    }
    // mirrored pairs stand alike: a foot held up in the reference pose (Crystalwing lifts a front paw in its idle)
    // is a detail of that pose, not where the foot rests - it takes the height and the mirrored spot of its twin
    // (mirrored about the body's own middle - the pelvis - not the bounding box, which raised wings can shift)
    const cx = info.pelvis ? worldPos(info.pelvis).x : 0;
    for (const a of this.legs) {
      if (a.limb.side === 'C') continue;
      const ha = worldPos(a.joints[0]).clone();
      for (const b of this.legs) {
        if (b === a || b.limb.side === 'C' || b.limb.side === a.limb.side) continue;
        const hb = worldPos(b.joints[0]).clone();
        if (Math.abs(ha.x + hb.x - 2 * cx) > 0.15 * H || Math.abs(ha.z - hb.z) > 0.15 * H || Math.abs(ha.y - hb.y) > 0.15 * H) continue;
        if (a.effHeight > b.effHeight + 0.03 * H) {
          a.effHeight = b.effHeight;
          a.restXZ.set(ha.x - (b.restXZ.x - hb.x), 0, ha.z + (b.restXZ.z - hb.z));
          a.liftedInRef = true;
        }
      }
    }
    this.legLen = this.legs.length ? this.legs.reduce((a, l) => a + l.legLen, 0) / this.legs.length : H * 0.4;
    // sprawled legs (an insect's or spider's: the foot far out from the hip, not under it) can't gain reach by the
    // body lowering, so they limit the stride: a planted foot travels only as far as the leg reaches without
    // stretching past its length (upright legs keep the general limit; there the body drops to reach)
    this.sweep = Infinity;
    for (const leg of this.legs) {
      const hip = worldPos(leg.joints[0]);
      const dx = leg.restXZ.x - hip.x, dz = hip.z - leg.restXZ.z, dy = leg.effHeight - hip.y;
      leg.sprawl = Math.hypot(dx, dz) / leg.legLen;
      if (leg.sprawl < 0.6) continue;
      const room = leg.legLen * leg.legLen - dx * dx - dy * dy;
      if (room <= 0) continue;
      const s = Math.sqrt(room);
      const half = Math.min(dz + s, s - dz);
      if (half > 0) { leg.sweep = 2 * half; this.sweep = Math.min(this.sweep, leg.sweep); }
    }
    // speeds are measured in this unit per second: leg-based for walkers (short legs walk slower), height otherwise
    // (a snake lying low is measured by its length, not its height: a quarter of its reach)
    this.unit = this.legs.length && info.style === 'walk' ? this.legLen * 2.5
      : info.style === 'slither' ? Math.max(H, 0.25 * (info.reach || H)) : H;
    const zs = this.legs.map((l) => l.restXZ.z);
    const cz = zs.length ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0;
    const spanZ = zs.length ? Math.max(...zs) - Math.min(...zs) : 0;
    this.quadLike = spanZ > 0.25 * H;
    for (const l of this.legs) {
      l.front = l.restXZ.z > cz;
      l.lr = l.restXZ.x;
      // straight in the reference pose: elbows of front legs bend back, knees (biped or hind) forward
      if (!l.bend) l.bend = new THREE.Vector3(0, 0, this.quadLike && l.front ? -1 : 1);
    }
    this.setupAllFours(info);
    this.applyFootSets(footSets);

    this.pelvis = info.pelvis;
    this.pelvisRest = this.pelvis ? worldPos(this.pelvis).clone() : V();
    this.spine = info.spine.filter((b) => !info.limbs.some((l) => l.bones.includes(b)));
    this.head = info.head;
    this.jaws = info.limbs.filter((l) => l.type === 'jaw');
    this.wings = info.limbs.filter((l) => l.type === 'wing');
    this.arms = info.limbs.filter((l) => l.type === 'arm');
    // a serpent's body (head .. tail tip) is posed as one chain lying along its path
    this.snake = info.style === 'slither' ? this.buildSnake(info) : null;
    // body parts whose volume must stay above the ground (serpents follow the terrain on their own)
    // (the first bone of a tail sits on the body - the rump - so it counts as body too)
    this.bodyBones = this.snake ? [] : [this.pelvis, ...info.spine, info.head, ...info.limbs.filter((l) => l.type === 'tail').map((l) => l.bones[0])].filter(Boolean);
    // lift from the bone that carries all of them (the "pelvis" may sit above the rump, e.g. a seal's flippers)
    this.liftRoot = commonAncestorBone(this.bodyBones) || this.pelvis;
    // each body bone's height over the ground in the reference pose (mover at the origin, ground at 0): a capsule
    // that already reaches into the ground there (a wide pelvis capsule) is not a collision
    this.bodyRefY = new Map(this.bodyBones.map((b) => [b, worldPos(b).y]));
    if (this.snake && this.params.slither.neck < 0) this.params.slither.neck = +(this.snake.neck / this.snake.L).toFixed(2);

    // chain springs
    this.chains = [];
    for (const limb of info.limbs) {
      if (!limb.dyn) limb.dyn = defaultDynamics(limb.type);
      if (!['ear', 'tail', 'tentacle', 'appendage', 'wing'].includes(limb.type)) continue;
      if (this.snake && limb.bones.some((b) => this.snake.set.has(b))) continue;
      const bones = limb.bones;
      if (bones.length < 1) continue;
      const last = bones[bones.length - 1];
      const lp = worldPos(last);
      const prev = bones.length > 1 ? worldPos(bones[bones.length - 2]) : (last.parent ? worldPos(last.parent) : lp.clone().sub(UP));
      const dir = lp.clone().sub(prev);
      if (dir.lengthSq() < 1e-10) dir.set(0, 1e-3, 0);
      const ext = lp.clone().addScaledVector(dir, bones.length > 1 ? 1 : 0.5);
      const tipLocal = last.worldToLocal(ext.clone());
      // height of every joint (and the tip) above the floor in the reference pose. A chain that lies along the
      // ground (a seal's tail) keeps these heights over the local terrain, so it follows slopes and steps.
      const clear = [...bones.map((b) => Math.max(0, worldPos(b).y)), Math.max(0, ext.y)];
      const minC = Math.min(...clear);
      const hug = clear.map((c) => (minC < 0.25 * H && c < minC + 0.15 * H ? 1 - THREE.MathUtils.smoothstep(c, minC + 0.08 * H, minC + 0.15 * H) : 0));
      // chains that lie on the ground start with "follow the ground" on
      if (hug.some((w) => w > 0.5) && limb.dyn.autoGround === undefined) { limb.dyn.collide = true; limb.dyn.autoGround = true; }
      this.chains.push({ limb, bones, tipLocal, clear, hug, X: [], Vv: [], init: false, twitchT: Math.random() * 3 });
    }

    cr.applySnapshot(refSnap);
    this.mover.position.copy(saved.p); this.mover.rotation.y = saved.r;
    this.mover.updateMatrixWorld(true);
    this.style = info.style;
    this.reset();
  }

  /**
   * Two legs + two arms (a bear): when galloping it drops onto all fours. The upper body pitches forward
   * about the bone that carries it until the hands can reach the ground, and the arms join the gait as front legs.
   * Measured in the reference pose (mover at the origin). Arm "legs" are added to this.legs with armLeg = true.
   */
  setupAllFours(info) {
    this.allFours = null;
    const arms = info.limbs.filter((l) => l.type === 'arm' && l.side !== 'C');
    if (this.legs.length !== 2 || arms.length !== 2 || !info.head || !info.pelvis) return;
    // the bone that carries the upper body: first bone on the way from (pelvis ^ head) to the head
    const path = (b) => { const p = []; for (let x = b; x; x = x.parent) p.unshift(x); return p; };
    const ph = path(info.head), pp = path(info.pelvis);
    let i = 0;
    while (i < ph.length && i < pp.length && ph[i] === pp[i]) i++;
    const upper = ph[Math.min(i, ph.length - 1)];
    if (!upper || !upper.isBone) return;
    const pivot = worldPos(upper).clone();
    const armData = [];
    for (const arm of arms) {
      // shoulder/clavicle is not part of the "leg"; trailing joints sitting on the hand are dropped
      let start = 0;
      if (arm.bones.length >= 4 && /shoulder|clavicle|collar|scapula/i.test(arm.bones[0].name)) start = 1;
      const joints = arm.bones.slice(start);
      while (joints.length > 2 && worldPos(joints[joints.length - 1]).distanceTo(worldPos(joints[joints.length - 2])) < 1e-3 * this.H) joints.pop();
      if (joints.length < 2) return;
      let len = 0;
      for (let k = 1; k < joints.length; k++) len += worldPos(joints[k]).distanceTo(worldPos(joints[k - 1]));
      armData.push({ arm, joints, len, shoulder: worldPos(joints[0]).clone() });
    }
    const armLen = Math.min(...armData.map((a) => a.len));
    // smallest forward pitch (about `upper`, nose down) that brings the shoulders within reach of the ground
    const pitched = (p, th) => {
      const f = p.z - pivot.z, u = p.y - pivot.y;
      return new THREE.Vector3(p.x, pivot.y + u * Math.cos(th) - f * Math.sin(th), pivot.z + f * Math.cos(th) + u * Math.sin(th));
    };
    let theta = -1;
    for (let d = 0; d <= 80; d++) {
      const sy = armData.reduce((a, x) => a + pitched(x.shoulder, d * D2R).y, 0) / armData.length;
      if (sy <= armLen * 0.9) { theta = d * D2R; break; }
    }
    // arms too short to reach the ground even bent far forward (a round, upright body): it keeps running upright
    if (theta < 0) return;
    const caps = info.capsules;
    for (const a of armData) {
      const s = pitched(a.shoulder, theta);
      const eff = a.joints[a.joints.length - 1];
      const cap = caps && caps.get(eff);
      // hands land under the shoulders, a little ahead, slightly wider than the shoulders
      this.legs.push({
        limb: a.arm, joints: a.joints, eff, armLeg: true,
        bend: new THREE.Vector3(0, 0, -1),                 // elbows bend back, like a front leg
        lowerOffset: V(),
        restXZ: new THREE.Vector3(s.x * 1.15, 0, s.z + 0.12 * a.len),
        effHeight: cap ? Math.min(cap.radius, 0.12 * a.len) : 0.05 * a.len, legLen: a.len,
        effQuat: worldQuat(eff).clone(),
        offset: 0, pos: V(), from: V(), to: V(), swing: false, groundY: 0, normal: UP.clone(), s: 0,
        front: true, lr: s.x,
      });
    }
    this.allFours = { upper, theta, armLen };
  }

  applyFootSets(sets) {
    this.footSets = sets;
    for (const leg of this.legs) leg.offset = 0;
    for (const set of sets) {
      const feet = set.feet.map((id) => this.legs.find((l) => l.limb.id === id)).filter(Boolean);
      feet.forEach((f, j) => { f.offset = (set.offset + j / feet.length) % 1; });
    }
    this.stepsPerCycle = Math.max(1, ...sets.map((s) => s.feet.length));
    // gallop pattern: legs grouped front-to-back by where they stand; groups alternate half a stride,
    // and inside a group the left leg leads the right by a little (0 would be a bound)
    const groups = [];
    for (const leg of [...this.legs].sort((a, b) => b.restXZ.z - a.restXZ.z)) {
      const g = groups.find((x) => Math.abs(x.z - leg.restXZ.z) < 0.15 * this.H);
      if (g) g.legs.push(leg); else groups.push({ z: leg.restXZ.z, legs: [leg] });
    }
    groups.forEach((g, gi) => {
      g.legs.sort((a, b) => b.lr - a.lr);
      g.legs.forEach((leg, j) => { leg.gallopOffset = ((groups.length > 1 && gi % 2 ? 0.5 : 0) + j * 0.08) % 1; });
    });
    this.gallopGroups = groups.length;
    const offs = this.legs.map((l) => l.offset).sort((a, b) => a - b);
    this.minGap = offs.length > 1 ? Math.min(...offs.map((o, i) => (i ? o - offs[i - 1] : o + 1 - offs[offs.length - 1]))) : 1;
    if (this.minGap <= 0) this.minGap = 1 / Math.max(1, offs.length);
  }

  reset() {
    this.body = { s: 0, pos: V(), yaw: 0, speed: 0, yawRate: 0, accel: 0, vel: V() };
    if (this.mode === 'course') { this.terrain.pathPoint(0, this.body.pos); const n = this.terrain.pathPoint(0.01); this.body.yaw = Math.atan2(n.x - this.body.pos.x, n.z - this.body.pos.z); }
    this.phase = 0;
    this.groundY = this.ground(this.body.pos.x, this.body.pos.z);
    this.liftY = 0;
    this.pitch = 0; this.roll = 0; this.lean = 0; this.bank = 0; this.travel = 0;
    this.placeMover();
    for (const leg of this.legs) {
      this.idealFoot(leg, this.body.pos, this.body.yaw, leg.pos);
      leg.groundY = leg.pos.y = this.ground(leg.pos.x, leg.pos.z);
      leg.swing = false;
    }
    for (const c of this.chains) c.init = false;
    this.resetSnake();
  }

  ground(x, z, r = 0, from = Infinity) {
    if (this.flatGround) return 0;
    return this.terrain.heightAt(x, z, r, from);
  }

  idealFoot(leg, pos, yaw, out) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return out.set(pos.x + leg.restXZ.x * c + leg.restXZ.z * s, 0, pos.z - leg.restXZ.x * s + leg.restXZ.z * c);
  }

  placeMover() {
    const b = this.body;
    this.mover.position.set(b.pos.x, this.flatGround ? 0 : this.groundY + this.liftY, b.pos.z);
    this.mover.rotation.set(0, b.yaw, 0);
    this.mover.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------ body movement

  updateBody(dt) {
    const P = this.params.movement;
    const b = this.body;
    const max = P.maxSpeed * this.unit;
    let want = P.speed * max;
    let turn = 0;
    if (this.mode === 'stand') want = 0;
    if (this.mode === 'drive') {
      const k = this.keys;
      const fwd = k.has('w') || k.has('arrowup');
      const back = k.has('s') || k.has('arrowdown');
      want = fwd ? Math.max(want, 0.25 * max) * (k.has('shift') ? 1.6 : 1) : back ? -0.3 * max : 0;
      turn = (k.has('a') || k.has('arrowleft') ? 1 : 0) - (k.has('d') || k.has('arrowright') ? 1 : 0);
    }
    if (this.overlay.hold) want = 0;
    const prev = b.speed;
    const rate = (Math.abs(want) > Math.abs(b.speed) ? P.accel : P.decel) * this.unit;
    b.speed += THREE.MathUtils.clamp(want - b.speed, -rate * dt, rate * dt);
    b.accel = dt > 0 ? (b.speed - prev) / dt : 0;

    const yaw0 = b.yaw;
    if (this.mode === 'course') {
      b.s += b.speed * dt;
      this.terrain.pathPoint(b.s, b.pos);
      const n = this.terrain.pathPoint(b.s + 0.05 * this.H);
      const target = Math.atan2(n.x - b.pos.x, n.z - b.pos.z);
      b.yaw = yaw0 + wrap(target - yaw0) * Math.min(1, dt * 8);
    } else if (this.mode === 'drive') {
      b.yaw += turn * P.turnRate * D2R * dt * (0.4 + 0.6 * clamp01(Math.abs(b.speed) / max + 0.3));
      b.pos.x += Math.sin(b.yaw) * b.speed * dt;
      b.pos.z += Math.cos(b.yaw) * b.speed * dt;
    } else {
      b.pos.set(0, 0, 0); b.yaw = 0;
    }
    b.yawRate = dt > 0 ? wrap(b.yaw - yaw0) / dt : 0;
    b.vel.set(Math.sin(b.yaw) * b.speed, 0, Math.cos(b.yaw) * b.speed);
    this.travel += Math.abs(b.speed) * dt;
  }

  // ------------------------------------------------------------------ footsteps

  updateFeet(dt) {
    const P = this.params, M = P.movement, S = P.stepping;
    const b = this.body;
    const speed01 = clamp01(Math.abs(b.speed) / (M.maxSpeed * this.unit));
    let air = THREE.MathUtils.clamp(S.air + S.airExt * speed01, 0.1, 0.95);
    // running: blend from the walking pattern into a gallop (more time in the air, a moment with no foot down)
    // (six legs or more never gallop: insects run in the same alternating tripods, only faster)
    const wantGallop = M.runStyle === 'gallop' && this.legs.length >= 2 && this.legs.length <= 4 ? THREE.MathUtils.smoothstep(speed01, 0.45, 0.8) : 0;
    this.gallop = damp(this.gallop || 0, wantGallop, 0.3, dt);
    const gl = this.gallop;
    air = THREE.MathUtils.lerp(air, Math.max(air, 0.5 + 0.15 * speed01), gl);
    // three legs walking: never lift two at once (always two feet on the ground)
    if (this.legs.length === 3 && gl < 0.5) air = Math.min(air, this.minGap * 0.97);
    for (const leg of this.legs) leg.effOffset = THREE.MathUtils.lerp(leg.offset, leg.gallopOffset ?? leg.offset, gl);
    // all fours: the arms carry the front of the body as much as the creature gallops
    this.quad = this.allFours && M.allFours !== false ? gl : 0;
    const L = this.legLen;
    let phaseSpeed = THREE.MathUtils.lerp(M.phaseMin, M.phaseMax, speed01) * M.timeScale;
    // never let a planted foot sweep further than the leg can reach: step faster instead of longer
    phaseSpeed = Math.max(phaseSpeed, (Math.abs(b.speed) * (1 - air)) / Math.min(0.75 * L, Math.max(0.25 * L, this.sweep)));
    const inplace = this.mode === 'inplace' || this.mode === 'stand';

    // standing still: only step while a foot is out of place
    if (Math.abs(b.speed) < 0.02 * this.H && !this.overlay.stepAnyway) {
      const swinging = this.legs.some((l) => l.swing);
      let worst = 0;
      for (const leg of this.legs) { if (leg.armLeg && (this.quad || 0) < 0.5) continue; this.idealFoot(leg, b.pos, b.yaw, _a); worst = Math.max(worst, Math.hypot(_a.x - leg.pos.x, _a.z - leg.pos.z)); }
      if (!swinging && worst < M.minStep * L) phaseSpeed = 0;
      else phaseSpeed = M.phaseMin * M.timeScale;
    }
    if (this.flightBlend > 0.5) {
      // airborne: keep the footholds under the body so the landing starts from a sensible place
      phaseSpeed = 0;
      for (const leg of this.legs) {
        this.idealFoot(leg, b.pos, b.yaw, leg.pos);
        leg.groundY = leg.pos.y = this.ground(leg.pos.x, leg.pos.z);
        leg.swing = false;
      }
    }
    this.phaseSpeed = phaseSpeed;
    this.phase += phaseSpeed * dt;
    const stance = phaseSpeed > 0 ? (1 - air) / phaseSpeed : 0;

    for (const leg of this.legs) {
      if (inplace) { leg.pos.x -= b.vel.x * dt; leg.pos.z -= b.vel.z * dt; leg.from.x -= b.vel.x * dt; leg.from.z -= b.vel.z * dt; }
      const psi = frac(this.phase + leg.effOffset);
      const inSwing = phaseSpeed > 0 && psi < air;
      if (inSwing) {
        if (!leg.swing) { leg.swing = true; leg.from.copy(leg.pos); leg.fromY = leg.groundY; }
        const remain = (air - psi) / phaseSpeed;
        // where the body will be when this foot lands, plus half a stance so the foot is centred under it
        const fut = inplace ? b.pos : _b.copy(b.pos).addScaledVector(b.vel, remain);
        const yawF = b.yaw + b.yawRate * (remain + stance / 2);
        this.idealFoot(leg, fut, yawF, leg.to);
        if (!this.overlay.noReach) leg.to.addScaledVector(b.vel, stance / 2);
        const from = this.groundY + S.maxCollision * L;
        leg.toY = S.groundCollision ? this.ground(leg.to.x, leg.to.z, S.footRadius * L, from) : this.groundY;
        const s = clamp01(psi / air);
        leg.s = s;
        const e = THREE.MathUtils.lerp(s, s * s * (3 - 2 * s), (S.easeIn + S.easeOut) / 2);
        leg.pos.x = THREE.MathUtils.lerp(leg.from.x, leg.to.x, e);
        leg.pos.z = THREE.MathUtils.lerp(leg.from.z, leg.to.z, e);
        const rise = leg.toY > leg.fromY ? Math.min(1, e * 1.7) : Math.max(0, (e - 0.35) / 0.65);
        const baseY = leg.fromY + (leg.toY - leg.fromY) * rise;
        const stepH = S.stepHeight * L * (0.55 + 0.45 * speed01) * (this.overlay.stepScale ?? 1);
        leg.pos.y = baseY + Math.pow(Math.sin(Math.PI * s), 0.8) * stepH;
        leg.groundY = THREE.MathUtils.lerp(leg.fromY, leg.toY, e);
      } else {
        if (leg.swing) {
          leg.swing = false;
          leg.pos.set(leg.to.x, leg.toY ?? leg.groundY, leg.to.z);
          leg.groundY = leg.pos.y;
          if (S.groundCollision && !this.flatGround) this.terrain.normalAt(leg.pos.x, leg.pos.z, S.footRadius * L + 1e-3 * this.H, leg.normal);
          else leg.normal.copy(UP);
          leg.s = 0;
        }
      }
    }
  }

  // ------------------------------------------------------------------ main update

  update(dt) {
    if (!this.info) return;
    dt = Math.min(dt, 1 / 20);
    if (this.paused) dt = 0;
    this.t += dt;
    const cr = this.creature;
    const P = this.params;
    const ov = this.overlay = emptyOverlay();
    if (this.action) {
      this.action.t += dt;
      const u = this.action.t / this.action.def.duration(this.action.params);
      this.action.def.apply(this, Math.min(u, 1), ov, this.action.params);
      if (u >= 1 && !this.action.def.hold) this.action = null;
    }

    this.updateBody(dt);
    const fl = P.flight;
    // winged creatures fly; serpents fly too, like a Chinese dragon (ears or fins set as wings flap)
    const flying = fl.on && (this.wings.length > 0 || !!this.snake || (fl.ears !== 'spring' && this.info.limbs.some((l) => l.type === 'ear' && l.side !== 'C')));
    this.flightBlend = damp(this.flightBlend, flying ? 1 : 0, 0.35, dt);

    const style = this.style;
    if (style === 'walk' && this.legs.length) this.updateFeet(dt);
    else this.phase += dt * THREE.MathUtils.lerp(P.movement.phaseMin, P.movement.phaseMax, clamp01(Math.abs(this.body.speed) / (P.movement.maxSpeed * this.unit)));

    // ground height under the body
    const b = this.body;
    let gTarget;
    if (style === 'walk' && this.legs.length) {
      // arms count as feet only while the creature is on all fours
      let sw = 0, sy = 0;
      for (const l of this.legs) { const w = l.armLeg ? (this.quad || 0) : 1; sw += w; sy += w * l.groundY; }
      gTarget = sy / Math.max(1e-6, sw);
    } else gTarget = this.ground(b.pos.x, b.pos.z, 0.15 * this.H);
    this.groundY = damp(this.groundY, gTarget, P.pelvis.halfLife * 1.5, dt);
    let lift = 0;
    if (style === 'hover') lift += P.hover.height * this.H + Math.sin(this.t * Math.PI * 2 * P.hover.bobFreq) * P.hover.bob * this.H;
    const W = this.advanceFlight(dt);
    lift += this.flightBlend * (fl.altitude * this.H + W.bob);
    lift += ov.lift * this.H;
    this.liftY = lift;
    this.placeMover();

    cr.applySnapshot(this.ref);
    cr.root.updateMatrixWorld(true);

    const fwd = _fwd.set(Math.sin(b.yaw), 0, Math.cos(b.yaw));
    const left = _left.set(Math.cos(b.yaw), 0, -Math.sin(b.yaw));
    const speed01 = clamp01(Math.abs(b.speed) / (P.movement.maxSpeed * this.unit));

    // pelvis: height bob, ground pitch/roll, lean, overlay
    if (this.pelvis) {
      let pitch = 0, roll = 0;
      if (style === 'walk' && this.legs.length) {
        const fr = this.legs.filter((l) => l.front), bk = this.legs.filter((l) => !l.front);
        const avg = (a) => a.reduce((s, l) => s + l.groundY, 0) / a.length;
        if (this.quadLike && fr.length && bk.length) {
          const dz = Math.max(1e-4, avg(fr.map((l) => ({ groundY: l.restXZ.z }))) - avg(bk.map((l) => ({ groundY: l.restXZ.z }))));
          pitch = Math.atan2(avg(fr) - avg(bk), dz) * P.pelvis.pitch;
        } else {
          const d = 0.3 * this.H;
          const hf = this.ground(b.pos.x + fwd.x * d, b.pos.z + fwd.z * d), hb = this.ground(b.pos.x - fwd.x * d, b.pos.z - fwd.z * d);
          pitch = Math.atan2(hf - hb, 2 * d) * P.pelvis.pitch * 0.35;
        }
        const onGround = this.legs.filter((l) => !l.armLeg || (this.quad || 0) > 0.5);
        const ls = onGround.filter((l) => l.lr > 0.02 * this.H), rs = onGround.filter((l) => l.lr < -0.02 * this.H);
        if (ls.length && rs.length) {
          const dx = Math.max(1e-4, ls.reduce((s, l) => s + l.lr, 0) / ls.length - rs.reduce((s, l) => s + l.lr, 0) / rs.length);
          roll = Math.atan2(avg(ls) - avg(rs), dx) * P.pelvis.roll;
        }
      } else if (style !== 'walk') {
        pitch = -speed01 * P.hover.tilt * D2R * (style === 'hover' ? 1 : 0);
      }
      // flight: nose down with speed, up when taking off or flaring to land
      if (this.flightBlend > 0) pitch = THREE.MathUtils.lerp(pitch, (-speed01 * 12 + W.takeoff * 18 + W.landing * 22) * D2R, this.flightBlend);
      this.pitch = damp(this.pitch, pitch, 0.12, dt);
      this.roll = damp(this.roll, roll, 0.12, dt);
      const lean = THREE.MathUtils.clamp(b.accel / (P.movement.accel * this.unit), -1, 1) * P.pelvis.lean * D2R;
      this.lean = damp(this.lean, lean, 0.2, dt);
      // birds bank hard into turns
      this.bank = damp(this.bank, -THREE.MathUtils.clamp(b.yawRate, -3, 3) * speed01 * P.pelvis.bank * D2R * (1 + 3 * this.flightBlend), 0.2, dt);

      const off = _a.set(0, 0, 0);
      if (style === 'walk' && this.legs.length) {
        const gl = this.gallop || 0;
        // walking dips with every step; a gallop rises and falls once per stride, much more (the moment in the air)
        const walkWave = 0.5 - 0.5 * Math.cos(Math.PI * 2 * this.stepsPerCycle * this.phase);
        const gallopWave = 0.5 - 0.5 * Math.cos(Math.PI * 2 * (this.phase - 0.15));
        const bob = P.pelvis.bob * this.legLen * (0.3 + 0.7 * speed01) * THREE.MathUtils.lerp(walkWave, gallopWave * 2.5, gl);
        off.y -= bob * (this.phaseSpeed > 0 ? 1 : 0);
        off.addScaledVector(fwd, P.pelvis.lead * this.legLen * speed01);
      }
      if (this.flatGround) off.y += this.liftY;
      off.addScaledVector(fwd, ov.body.z * this.H).addScaledVector(left, ov.body.x * this.H).addScaledVector(UP, ov.body.y * this.H);
      if (ov.shake) off.addScaledVector(left, Math.sin(this.t * 61) * ov.shake * 0.01 * this.H).addScaledVector(fwd, Math.sin(this.t * 47) * ov.shake * 0.008 * this.H);
      translateWorld(this.pelvis, off);
      rotateAxis(this.pelvis, UP, ov.yaw);
      // galloping body rocks nose-up / nose-down once per stride
      this.gallopRock = (this.gallop || 0) * P.pelvis.rock * D2R * Math.sin(Math.PI * 2 * (this.phase - 0.1));
      rotateAxis(this.pelvis, left, -(this.pitch + ov.pitch + this.gallopRock));
      rotateAxis(this.pelvis, fwd, this.roll + this.bank + ov.roll);
    }

    // on all fours: the upper body pitches forward so the hands reach the ground
    const quadPitch = this.allFours ? (this.quad || 0) * this.allFours.theta : 0;
    if (quadPitch > 1e-4) rotateAxis(this.allFours.upper, left, quadPitch);
    // spine lean and overlay curl, spread over the first spine bones (or the upper body's root if there is no spine)
    const sp = (this.spine.length ? this.spine : this.allFours ? [this.allFours.upper] : []).slice(0, 4);
    // galloping back bends up and down (gathers when the hind legs land under the body, stretches when reaching)
    this.gallopFlex = (this.gallop || 0) * P.pelvis.flex * D2R * Math.sin(Math.PI * 2 * (this.phase - 0.35));
    if (sp.length) {
      const pitch = (this.lean + ov.spinePitch + this.gallopFlex) / sp.length, yaw = ov.spineYaw / sp.length, roll = ov.spineRoll / sp.length;
      for (const s of sp) { rotateAxis(s, left, pitch); rotateAxis(s, UP, yaw); rotateAxis(s, fwd, roll); }
    }
    // serpent: the whole body lies along its path (on the ground, or floating in flight)
    if (this.snake) this.updateSnake(dt, fwd, left, speed01, ov);
    // head: steady against body pitch, look into turns, overlay
    if (this.head) {
      // (on all fours the head turns up to look ahead, not at the ground)
      rotateAxis(this.head, left, (this.pitch + ov.pitch + (this.gallopRock || 0) - this.lean - (this.gallopFlex || 0) - ov.spinePitch * 0.5) * P.head.stabilize + ov.headPitch - quadPitch * 0.85);
      rotateAxis(this.head, UP, THREE.MathUtils.clamp(b.yawRate, -2, 2) * 0.25 * P.head.lookAhead + ov.headYaw);
      rotateAxis(this.head, fwd, ov.headRoll);
    }
    for (const j of this.jaws) {
      const up = /upper/i.test(j.bones[0].name);
      rotateAxis(j.bones[0], left, (up ? -0.35 : 1) * ov.jaw * 28 * D2R);
    }

    // legs: IK to the footsteps (or tucked in flight / overlay targets)
    const ikW = ov.ik * (1 - this.flightBlend * P.flight.tuck);
    // if a planted foot is out of reach (stepping down, uneven ground) lower the pelvis a little
    if (this.pelvis && this.legs.length && ikW > 0.5) {
      let need = 0;
      for (const leg of this.legs) {
        if (ov.targets.has(leg.limb.id) || (leg.armLeg && (this.quad || 0) < 0.6)) continue;
        worldPos(leg.joints[0], _a);
        _b.copy(leg.pos); _b.y += leg.effHeight;
        const over = (_a.distanceTo(_b) - leg.legLen * 0.97) * (leg.swing ? 0.5 : 1);
        if (over > need) need = over;
      }
      this.reachDrop = damp(this.reachDrop || 0, Math.min(need, 0.35 * this.legLen), 0.05, dt);
      if (this.reachDrop > 1e-5) translateWorld(this.pelvis, _a.set(0, -this.reachDrop, 0));
    }
    // ...but never push the body's own volume into the ground (the body wins over a leg that cannot reach)
    this.liftBodyOutOfGround(dt);
    for (const leg of this.legs) {
      // arms used as front legs: only as much as the creature is on all fours, otherwise they stay free
      const armW = leg.armLeg ? (this.quad || 0) : 1;
      if (armW < 0.01 && !ov.targets.has(leg.limb.id)) continue;
      const target = _c.copy(leg.pos);
      target.y += leg.effHeight;
      const custom = ov.targets.get(leg.limb.id);
      if (leg.armLeg && armW < 1) target.lerp(worldPos(leg.eff), 1 - armW);
      if (this.flightBlend > 0 || ikW < 1 || custom) {
        // the leg's own pose carried by the body, used for tucking and blending
        const free = worldPos(leg.eff, _b).clone();
        const hip = worldPos(leg.joints[0]);
        const tuck = hip.clone().addScaledVector(UP, -0.5 * leg.legLen).addScaledVector(fwd, -0.3 * leg.legLen);
        free.lerp(tuck, this.flightBlend * P.flight.tuck);
        target.lerp(free, 1 - ikW);
        if (custom) target.lerp(custom.pos, custom.w);
      }
      const pole = worldPos(leg.joints[0]).clone().addScaledVector(_q2.copy(leg.bend).applyQuaternion(this.mover.quaternion), leg.legLen);
      this.solveLeg(leg, target, pole);
      // foot: keep its reference orientation relative to the body, tilted to the ground (hands keep their own)
      if (ikW > 0.5 && !custom && !leg.armLeg) {
        const q = _q.copy(this.mover.quaternion).multiply(leg.effQuat);
        if (!leg.normal.equals(UP)) {
          const tilt = new THREE.Quaternion().setFromUnitVectors(UP, leg.normal);
          q.premultiply(new THREE.Quaternion().slerp(tilt, (P.stepping.footPitch + P.stepping.footRoll) / 2));
        }
        setWorldQuat(leg.eff, q);
      }
    }
    // arms / non-gait limbs with overlay targets (swipes)
    for (const [id, tgt] of ov.targets) {
      if (this.legs.some((l) => l.limb.id === id)) continue;
      const limb = this.info.limbs.find((l) => l.id === id);
      if (!limb) continue;
      const joints = limb.bones.slice(limb.ikStart, Math.max(limb.ikStart + 2, limb.effector) + 1).slice(0, limb.bones.length);
      if (joints.length >= 2) {
        const cur = worldPos(joints[joints.length - 1]).clone();
        solveFABRIK(joints, cur.lerp(tgt.pos, tgt.w));
      }
    }

    this.updateWings(dt, fwd, left);
    this.updateChains(dt, fwd, left);
    this.applyPartSwap();
    cr.update();
  }

  // ------------------------------------------------------------------ collision volume

  /** Collision radius at each joint of a spring chain (+ its tip), from the mesh capsules. */
  jointRadii(c) {
    const caps = this.info.capsules;
    const k = this.params.collision.scale;
    const fallback = 0.015 * this.H;
    const r = c.bones.map((b) => {
      const cap = caps && (caps.get(b) || (b.parent && caps.get(b.parent)));
      return cap ? cap.radius * k : fallback;
    });
    r.push(r[r.length - 1] * 0.7);
    return r;
  }

  /**
   * Keep the body's volume out of the ground: if a capsule of the pelvis, spine, neck or head dips below the
   * terrain under it (a slope, a step, a rock), the whole body is lifted by that much (smoothed).
   */
  liftBodyOutOfGround(dt) {
    const caps = this.info.capsules;
    if (!this.params.collision.on || !caps || !this.liftRoot || this.flightBlend > 0.5) { this.bodyLift = 0; return; }
    const k = this.params.collision.scale;
    let need = 0;
    for (const b of this.bodyBones) {
      const cap = caps.get(b);
      if (!cap) continue;
      const p = worldPos(b);
      // only what goes deeper than the standing pose already does (Crystalwing's pelvis capsule spans its wings'
      // base and reaches the floor even standing; without this the body was lifted by half its height)
      const y0 = this.bodyRefY && this.bodyRefY.get(b);
      const allow = y0 === undefined ? 0 : Math.max(0, cap.radius * k * 0.85 - y0);
      const pen = this.ground(p.x, p.z) + cap.radius * k * 0.85 - allow - p.y;
      if (pen > need) need = pen;
    }
    // up fast (never sink in), down slowly (slide off an obstacle instead of dropping)
    const target = Math.min(need, 0.5 * this.H);
    this.bodyLift = damp(this.bodyLift || 0, target, target > (this.bodyLift || 0) ? 0.012 : 0.12, dt);
    if (this.bodyLift > 1e-5) translateWorld(this.liftRoot, _a.set(0, this.bodyLift, 0));
  }

  // ------------------------------------------------------------------ ground / air parts

  /**
   * Parts that exist only in the air or only on the ground (open vs folded wings). Hidden the way game models do it:
   * the part's root bone shrinks to 2 %. If any folded wing exists, the open wings become air-only.
   */
  swapList() {
    const L = this.info.limbs;
    const folded = L.filter((l) => l.type === 'wingFolded');
    const list = [];
    for (const l of L) {
      let show = l.showIn;
      if (l.type === 'wingFolded') show = 'ground';
      else if (l.type === 'wing' && folded.length) show = 'air';
      if (show !== 'air' && show !== 'ground') continue;
      const name = l.hideBone || (l.type === 'wing' && l.bones.length > 2 ? l.bones[1].name : l.bones[0].name);
      const bone = this.creature.byName.get(name);
      if (bone) list.push({ bone, show });
    }
    return list;
  }

  applyPartSwap() {
    const list = this.swapList();
    if (!list.length) return;
    const air = this.flightBlend > 0.15;
    for (const { bone, show } of list) {
      if ((show === 'air') === air) continue;
      bone.scale.multiplyScalar(0.02);
      bone.updateMatrixWorld(true);
    }
  }

  // ------------------------------------------------------------------ serpents

  /**
   * Body chain of a serpent: from the head down to the common ancestor with the longest tail, then out to its tip.
   * Measured in the reference pose (mover at the origin): bone lengths, how high the head is, which part is the neck.
   */
  buildSnake(info) {
    const tails = info.limbs.filter((l) => l.type === 'tail').sort((a, b) => b.bones.length - a.bones.length);
    const head = info.head || info.trunk[info.trunk.length - 1];
    if (!head) return null;
    const tail = tails[0] ? tails[0].bones : [];
    const pathFrom = (b) => { const p = []; for (let x = b; x; x = x.parent) p.unshift(x); return p; };
    const hp = pathFrom(head);
    let up, down, root;
    if (tail.length) {
      const tp = pathFrom(tail[tail.length - 1]);
      let i = 0;
      while (i < hp.length && i < tp.length && hp[i] === tp[i]) i++;
      root = hp[i - 1];
      up = hp.slice(i - 1);
      down = tp.slice(i - 1);
    } else {
      root = info.trunk.find((b) => info.creature?.weighted?.has?.(b)) || info.pelvis || hp[0];
      up = hp.slice(hp.indexOf(root));
      down = [root];
    }
    if (!root || !root.isBone) return null;
    const order = [...up].reverse().concat(down.slice(1)); // head ... root ... tail tip
    const ri = order.indexOf(root);
    const P = order.map((b) => worldPos(b).clone());
    const last = order[order.length - 1];
    const prev = P[P.length - 2] || P[P.length - 1].clone().sub(UP);
    const ext = P[P.length - 1].clone().add(P[P.length - 1].clone().sub(prev).multiplyScalar(0.6));
    const tipLocal = last.worldToLocal(ext.clone());
    const pts = [...P, ext];
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const L = s[s.length - 1] || 1;
    const r0 = Math.max(0.004 * L, Math.min(...pts.map((p) => p.y)));
    const headH = Math.max(r0, P[0].y);
    // neck = from the head down to where the body reaches the ground
    let ni = pts.findIndex((p) => p.y < r0 + 0.15 * (headH - r0));
    if (ni < 0) ni = Math.round(pts.length * 0.3);
    const neck = THREE.MathUtils.clamp(s[ni], 0.05 * L, 0.6 * L);
    return {
      order, ri, root, s, L, r0, headH, neck, tipLocal, set: new Set(order), head,
      headQuat: worldQuat(head).clone(), lead: 0.3 * L, trail: [], targets: pts.map(() => V()),
    };
  }

  /** Point at distance `d` behind the newest trail point (extrapolated straight past the end). */
  trailAt(d, out) {
    const T = this.snake.trail;
    let acc = 0;
    for (let i = 1; i < T.length; i++) {
      const seg = T[i].distanceTo(T[i - 1]);
      if (acc + seg >= d) return out.copy(T[i - 1]).lerp(T[i], seg > 0 ? (d - acc) / seg : 0);
      acc += seg;
    }
    const a = T[T.length - 1], b = T.length > 1 ? T[T.length - 2] : a.clone().add(_q2.set(0, 0, 1));
    const dir = _a.copy(a).sub(b).normalize();
    return out.copy(a).addScaledVector(dir, d - acc);
  }

  resetSnake() {
    const K = this.snake;
    if (!K) return;
    const b = this.body;
    // on the course the body starts lying along the path (the head leads along it, not along its tangent)
    if (this.mode === 'course') {
      K.trail = [];
      for (let d = 0; d <= K.L * 1.3; d += 0.02 * K.L) K.trail.push(this.terrain.pathPoint(b.s + K.lead - d, V()));
      return;
    }
    const f = V().set(Math.sin(b.yaw), 0, Math.cos(b.yaw));
    const head = V().copy(b.pos).addScaledVector(f, K.lead);
    K.trail = [head, head.clone().addScaledVector(f, -K.L * 1.3)];
  }

  updateSnake(dt, fwd, left, speed01, ov) {
    const K = this.snake, P = this.params.slither, b = this.body;
    const L = K.L, fb = this.flightBlend;
    const inplace = this.mode === 'inplace' || this.mode === 'stand';
    // the head leads the body; the trail records where it has been
    // (on the course the head stays on the path, so the body crosses the obstacles instead of cutting the loop)
    const head = this.mode === 'course' ? this.terrain.pathPoint(b.s + K.lead, _c) : _c.copy(b.pos).addScaledVector(fwd, K.lead);
    head.y = 0;
    if (inplace) K.trail = [head.clone(), head.clone().addScaledVector(fwd, -L * 1.3)];
    else {
      K.trail[0] = head.clone();
      if (K.trail.length < 2 || K.trail[0].distanceTo(K.trail[1]) > 0.02 * L) K.trail.unshift(head.clone());
      let acc = 0;
      for (let i = 1; i < K.trail.length; i++) { acc += K.trail[i].distanceTo(K.trail[i - 1]); if (acc > L * 1.4) { K.trail.length = i + 1; break; } }
    }
    // the wave stays fixed to the ground (so it runs back along the body); idle bodies drift slowly
    K.idle = (K.idle || 0) + dt * (1 - speed01) * 0.1 * P.wavelength * L;
    const ground0 = this.travel + K.idle;
    const amp = THREE.MathUtils.lerp(P.idleAmp, P.amp, Math.min(1, speed01 * 2.5)) * L;
    const lam = Math.max(0.05, P.wavelength) * L;
    const neck = P.neck > 0 ? P.neck * L : K.neck;
    const raise = K.headH * P.headRaise - K.r0;
    const moverY = this.mover.position.y;
    const off = _b.set(0, 0, 0).addScaledVector(fwd, ov.body.z * this.H).addScaledVector(left, ov.body.x * this.H).addScaledVector(UP, ov.body.y * this.H);
    const base = V(), next = V(), nrm = V();
    K.s.forEach((s, i) => {
      this.trailAt(s, base);
      this.trailAt(s + 0.01 * L, next);
      const tan = next.sub(base);
      tan.y = 0;
      if (tan.lengthSq() < 1e-12) tan.copy(fwd).negate();
      tan.normalize();
      nrm.set(-tan.z, 0, tan.x);
      const ph = ((ground0 - s) / lam) * Math.PI * 2;
      // lateral wave: none at the head, full along the body, easing at the tail tip
      const env = THREE.MathUtils.smoothstep(s, neck * 0.5, neck * 1.25) * (1 - 0.35 * (s / L));
      const lateral = Math.sin(ph) * amp * env * (1 - 0.5 * fb);
      const u = s / Math.max(1e-6, neck);
      const neckUp = u < 1 ? (0.5 + 0.5 * Math.cos(Math.PI * u)) * raise : 0;
      const t = K.targets[i].copy(base).addScaledVector(nrm, lateral);
      // the ground under where this joint actually lies (after the sideways wave), across the body's width,
      // so the body rides over rocks and edges instead of cutting into them
      const groundY = (this.flatGround || fb > 0.999 ? 0 : this.ground(t.x, t.z, K.r0 * 0.8)) + K.r0 + neckUp;
      // in the air: float at the flight height with an up-down wave (Chinese dragon)
      const airY = (this.flatGround ? this.liftY : moverY) + K.r0 + neckUp * 0.5
        + Math.sin(ph + Math.PI / 2) * P.flyAmp * L * THREE.MathUtils.smoothstep(s, 0, 0.3 * L);
      t.y = THREE.MathUtils.lerp(groundY, airY, fb);
      t.add(off);
    });
    // pose: put the root on its target, then turn each bone towards the next target, outwards both ways
    const O = K.order, T = K.targets, ri = K.ri, S = K.s;
    // joints sitting on top of each other (Waist/Hips/Spine1 often do) have no direction to aim: skip them,
    // otherwise rounding noise would spin the root and undo the other half of the body
    const real = (a, b) => Math.abs(S[a] - S[b]) > 0.002 * L;
    translateWorld(O[ri], _a.copy(T[ri]).sub(worldPos(O[ri])));
    let rootAimed = false;
    for (let j = ri; j >= 1; j--) {
      if (!real(j, j - 1)) continue;
      aimBone(O[j], worldPos(O[j - 1]), T[j - 1]);
      if (j === ri) rootAimed = true;
    }
    for (let j = ri; j < O.length - 1; j++) {
      if (!real(j, j + 1) || (j === ri && rootAimed)) continue;
      aimBone(O[j], worldPos(O[j + 1]), T[j + 1]);
    }
    // the tail tip: aim the last bone at it, unless that bone is the root already aimed at the body (a chain with
    // no tail past the root) - turning it again would swing the whole body about the tail end
    const last = O[O.length - 1];
    if (!(ri === O.length - 1 && rootAimed)) aimBone(last, last.localToWorld(K.tipLocal.clone()), T[T.length - 1]);
    // head: its reference orientation, turned to face along the path
    const dir = _a.copy(T[0]).sub(T[Math.min(2, T.length - 1)]);
    dir.y = 0;
    if (dir.lengthSq() > 1e-12) {
      const yaw = Math.atan2(dir.x, dir.z);
      setWorldQuat(K.head, _q.setFromAxisAngle(UP, yaw).multiply(K.headQuat));
    }
  }

  /**
   * Leg IK. Two segments: exact solve with a bend direction. Three or more (thigh, shin, hock...): the lower
   * part keeps its reference shape (like a digitigrade foot), thigh + shin solve for where it must start,
   * then the lower part turns onto the target. Stable near full extension — no zig-zag flips.
   */
  solveLeg(leg, target, pole) {
    const J = leg.joints;
    if (J.length <= 3 || leg.armLeg) { solveFABRIK(J, target, { pole }); return; }
    const lower = _a.copy(leg.lowerOffset).applyQuaternion(this.mover.quaternion);
    const upperTarget = _b.copy(target).sub(lower);
    solveFABRIK(J.slice(0, 3), upperTarget, { pole });
    aimBone(J[2], worldPos(J[J.length - 1]), target);
  }

  // ------------------------------------------------------------------ wings

  /** Ears used as wings while flying (Flight → "Ears in flight"). */
  earWings() {
    const mode = this.params.flight.ears;
    if (mode === 'spring' || this.flightBlend <= 0) return [];
    // auto: ears beat only for a creature without wings (a creature with wings flies with its wings)
    if (mode === 'auto' && this.wings.length) return [];
    return this.info.limbs.filter((l) => l.type === 'ear' && l.side !== 'C');
  }

  /**
   * The wingbeat clock, run before the body is placed (the body bob depends on it).
   * Flap-glide: a burst of beats, then a glide with the wings held out. Take-off beats harder and faster;
   * landing flares (wings forward and up, body pitched back).
   */
  advanceFlight(dt) {
    const fl = this.params.flight;
    const fb = this.flightBlend;
    const W = this.flightState || (this.flightState = { phase: 0, env: 1, count: 0, gliding: false, timer: 0, takeoff: 0, landing: 0 });
    W.takeoff = fl.on && fb < 0.98 ? 1 - fb : 0;
    W.landing = !fl.on && fb > 0.02 ? Math.min(1, fb * 1.5) : 0;
    let flapping = fl.mode !== 'glide';
    if (fl.mode === 'flapglide' && !W.takeoff) {
      W.timer += dt;
      if (!W.gliding && W.count >= fl.burst) { W.gliding = true; W.timer = 0; }
      else if (W.gliding && W.timer >= fl.glideTime) { W.gliding = false; W.count = 0; W.timer = 0; }
      flapping = !W.gliding;
    }
    if (W.takeoff > 0.05) flapping = true;
    if (W.landing > 0.05) flapping = false;
    W.env = damp(W.env, flapping ? 1 : 0, 0.12, dt);
    const freq = fl.flapFreq * (fl.mode === 'hover' ? 1.4 : 1) * (1 + 0.35 * W.takeoff);
    // keep the clock running while the beat fades out so the wings settle smoothly; stop it when gliding
    if (flapping || W.env > 0.02) {
      const before = W.phase;
      W.phase = (W.phase + freq * dt) % 1;
      if (W.phase < before) W.count++;
    }
    W.s = strokeValue(W.phase, fl.downstroke);
    // body rises during the downstroke: highest at its end (s = -1), lowest at the end of the upstroke
    W.bob = -W.s * fl.bob * this.H * W.env * (1 + 0.5 * W.takeoff);
    return W;
  }

  /**
   * Bird wing model. Each wing segment (upper arm, forearm, hand) gets an absolute direction in the body frame:
   * elevation from a down/up stroke with unequal timing, outer segments lagging (a whip, not a plank),
   * forward sweep on the downstroke and back sweep on the upstroke (the tip draws a loop),
   * elbow and wrist folding on the upstroke (span shrinks, then re-extends), and a twist of the wing
   * (leading edge down on the downstroke, up on the upstroke). Gliding holds the wings out; landing flares.
   */
  updateWings(dt, fwd, left) {
    const list = [...this.wings, ...this.earWings()];
    if (!list.length) return;
    const fl = this.params.flight;
    const fb = this.flightBlend;
    const ov = this.overlay;
    const W = this.flightState || this.advanceFlight(0);
    const D = fl.downstroke;
    const A = fl.flapAmp * D2R * (1 + 0.3 * W.takeoff);
    const dir = (out, elev, sweep) => _c.copy(out).multiplyScalar(Math.cos(elev) * Math.cos(sweep))
      .addScaledVector(UP, Math.sin(elev)).addScaledVector(fwd, Math.cos(elev) * Math.sin(sweep)).normalize();

    for (const wing of list) {
      const side = wing.side === 'R' ? -1 : 1;
      const out = _a.copy(left).multiplyScalar(side);
      const isEar = wing.type === 'ear';
      const earSpread = isEar && fl.ears === 'spread';
      // joints of the wing + the tip point
      const chain = this.chains.find((c) => c.limb === wing);
      const J = wing.bones;
      const n = J.length;
      const lens = [];
      for (let k = 0; k < n; k++) {
        const a = worldPos(J[k]);
        const b = k < n - 1 ? worldPos(J[k + 1]) : chain ? J[n - 1].localToWorld(chain.tipLocal.clone()) : null;
        lens.push(b ? a.distanceTo(b) : 0);
      }
      // a short first bone near the body is the shoulder/clavicle: it only follows the stroke a little
      const avg = lens.reduce((s, x) => s + x, 0) / Math.max(1, n);
      const clav = n >= 3 && lens[0] < 0.45 * avg ? 1 : 0;
      const segs = n - clav;
      if (fb <= 0 && !ov.wing) continue;

      if (clav) rotateAxis(J[0], fwd, side * 0.25 * A * W.s * W.env * fb);
      for (let k = clav; k < n; k++) {
        const m = k - clav;                                    // 0 = upper arm, 1 = forearm, 2+ = hand
        const role = segs === 1 ? 2 : Math.min(2, Math.round((m / Math.max(1, segs - 1)) * 2));
        const lag = [0, 0.07, 0.14][role] * fl.lag / 0.35;   // outer parts follow later
        const ph = (W.phase - lag + 1) % 1;
        const s = strokeValue(ph, D);
        const up = ph >= D ? Math.sin(Math.PI * (ph - D) / (1 - D)) : 0;            // 0..1 during the upstroke
        const down = ph < D ? Math.sin(Math.PI * ph / D) : 0;                         // 0..1 during the downstroke
        const reach = [1, 1.12, 1.25][role];                                          // the tip travels furthest
        // flapping pose
        let elev = fl.dihedral * D2R + A * s * reach;
        let sweep = (down * fl.sweep - up * fl.sweep * 0.8) * D2R * [0.6, 0.8, 1][role];
        sweep -= up * fl.foldUp * [12, 70, 115][role] * D2R;                          // elbow and wrist fold back
        elev -= up * fl.foldUp * [0, 10, 24][role] * D2R;                             // ...and the hand drops a little
        // gliding pose: held out, slight dihedral, hand swept back and its tip turned up
        const breathe = Math.sin(this.t * 1.1 + role * 0.4) * 1.5 * D2R;
        const gElev = fl.dihedral * D2R + [0, 2, 6][role] * D2R + breathe;
        const gSweep = -[2, 6, 14][role] * D2R;
        const env = earSpread ? 0.15 : W.env;
        elev = gElev + (elev - gElev) * env;
        sweep = gSweep + (sweep - gSweep) * env;
        // landing flare: wings forward and up, catching the air
        if (W.landing > 0) { elev += W.landing * [18, 22, 26][role] * D2R; sweep += W.landing * [14, 10, 4][role] * D2R; }
        // actions on the ground (gust) still drive the wings when not flying
        if (fb < 1 && ov.wing) elev = elev * fb + ov.wing * (1 - fb);
        const wantDir = dir(out, elev, sweep);
        const a = worldPos(J[k]);
        const childPos = k < n - 1 ? worldPos(J[k + 1]) : chain ? J[n - 1].localToWorld(chain.tipLocal.clone()) : null;
        if (!childPos || lens[k] < 1e-9) continue;
        const groundW = Math.min(1, Math.abs(ov.wing || 0) / (15 * D2R)) * (1 - fb);
        aimBone(J[k], childPos, _b.copy(a).addScaledVector(wantDir, lens[k]), Math.max(fb, groundW));
        // twist about the span: leading edge down on the downstroke (pronation), up on the upstroke
        const twist = (down - 0.6 * up) * fl.twist * D2R * [0.4, 0.7, 1][role] * env;
        if (twist) rotateAxis(J[k], _b.copy(wantDir).multiplyScalar(side), twist * fb);
      }
    }
    // the tail pitches gently against the stroke and spreads down when landing
    for (const t of this.info.limbs.filter((l) => l.type === 'tail' && !(this.snake && this.snake.set.has(l.bones[0])))) {
      const ph = (W.phase - 0.2 + 1) % 1;
      rotateAxis(t.bones[0], left, (-0.12 * A * strokeValue(ph, D) * W.env + W.landing * 25 * D2R) * fb);
    }
  }

  // ------------------------------------------------------------------ spring chains

  updateChains(dt, fwd, left) {
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / sub;
    for (const c of this.chains) {
      const D = c.limb.dyn;
      if (!D || !D.on) continue;
      if (c.limb.type === 'wing' && this.flightBlend > 0.2) continue;
      if (c.limb.type === 'ear' && this.flightBlend > 0.2 && this.earWings().includes(c.limb)) continue;
      const n = c.bones.length;
      const boost = this.overlay.wave[c.limb.type] ?? 1;
      // wave first (adds to the animated pose that the spring follows)
      if (D.waveAmp > 0) {
        const amp = D.waveAmp * D2R * boost;
        c.bones.forEach((bone, i) => {
          if (i >= n - 1 && n > 1) return;
          const ph = this.t * Math.PI * 2 * D.waveFreq * (boost > 1 ? 1.8 : 1) - i * D.waveShift;
          const s = Math.sin(ph) * amp * (0.6 + 0.4 * i / n);
          if (D.waveAxis !== 'up') rotateAxis(bone, UP, s);
          if (D.waveAxis !== 'side') rotateAxis(bone, left, (D.waveAxis === 'both' ? Math.cos(ph * 0.83) : Math.sin(ph)) * amp * 0.7);
        });
      }
      // animated targets: joints + tip
      const T = c.bones.map((b) => worldPos(b));
      T.push(c.bones[n - 1].localToWorld(c.tipLocal.clone()));
      // ground: a chain lying on the ground keeps its reference height over the local terrain (it bends over slopes
      // and steps); every joint keeps its collision volume above the ground
      const ground = D.collide && this.params.collision.on;
      const floor = [];
      if (ground) {
        const R = this.jointRadii(c);
        for (let i = 0; i <= n; i++) {
          const w = c.hug[i] || 0;
          // a flat part lying on the ground (a tail fin) reaches down only as far as it did in the reference pose;
          // a round capsule would overestimate that
          const reach = w > 0.5 ? Math.min(R[i], c.clear[i]) : R[i];
          const gy = this.ground(T[i].x, T[i].z, reach * 0.8);
          floor.push(gy + reach * 0.95);
          // galloping body on the ground (seal): a hump runs back along it once per stride
          const hump = (this.gallop || 0) * this.params.pelvis.hump * this.H * Math.max(0, Math.sin(Math.PI * 2 * this.phase - i * 0.55));
          if (i > 0 && w > 0) T[i].y = THREE.MathUtils.lerp(T[i].y, gy + c.clear[i] + hump, w);
        }
      }
      if (!c.init || dt === 0) {
        c.X = T.map((p) => p.clone());
        c.Vv = T.map(() => V());
        c.len = T.map((p, i) => (i ? p.distanceTo(T[i - 1]) : 0));
        c.Tprev = T.map((p) => p.clone());
        c.init = true;
        if (dt === 0) continue;
      }
      // the target's own velocity: damping acts on motion relative to it, so moving at a steady speed leaves the
      // part where the pose puts it (only speeding up, slowing down and turning swing it) - damping the absolute
      // velocity made parts trail behind like in a wind that grows with speed (plates flipping over at a gallop)
      const VT = T.map((p, i) => _vt[i] ? _vt[i].copy(p).sub(c.Tprev[i]).divideScalar(dt) : (_vt[i] = p.clone().sub(c.Tprev[i]).divideScalar(dt)));
      // teleports (a new course lap, a reset) would fling the parts: treat as no motion
      for (const v of VT) if (v.length() > 40 * this.H) v.set(0, 0, 0);
      c.Tprev.forEach((p, i) => p.copy(T[i]));
      // short parts are stiff (a plate or a horn barely moves; a pendulum's frequency goes with 1/sqrt(length))
      if (c.short === undefined) {
        const total = c.len.reduce((a, b) => a + b, 0);
        c.short = THREE.MathUtils.clamp(total / (0.3 * this.H), 0.15, 1);
      }
      const maxDev = (MAX_SWING[c.limb.type] ?? 60) * Math.max(0.35, c.short);
      const cosMax = Math.cos(maxDev * D2R);
      const omega0 = THREE.MathUtils.lerp(3, 38, Math.pow(D.stiffness, 1.4)) / Math.sqrt(c.short);
      const zeta = THREE.MathUtils.lerp(0.08, 1, D.damping);
      const g = D.gravity * 6 * this.H;
      // ear twitch
      if (D.twitch > 0) {
        c.twitchT -= dt;
        if (c.twitchT <= 0) {
          c.twitchT = 1.5 + Math.random() * (6 - 5 * D.twitch);
          const kick = V().randomDirection().multiplyScalar(this.H * 2.5 * D.twitch);
          c.Vv[c.Vv.length - 1].add(kick);
        }
      }
      for (let s = 0; s < sub; s++) {
        c.X[0].copy(T[0]);
        for (let i = 1; i <= n; i++) {
          const om = omega0 * (1 - 0.45 * (i - 1) / Math.max(1, n));
          const x = c.X[i], v = c.Vv[i];
          _a.copy(T[i]).sub(x).multiplyScalar(om * om);
          _a.addScaledVector(_b.copy(v).sub(VT[i]), -2 * zeta * om);
          _a.y -= g;
          v.addScaledVector(_a, h);
          x.addScaledVector(v, h);
          // keep bone lengths
          _b.copy(x).sub(c.X[i - 1]);
          const l = _b.length() || 1e-6;
          _b.divideScalar(l);
          // never swing further than the part's type allows away from where the pose puts it
          _c.copy(T[i]).sub(T[i - 1]);
          const tl = _c.length();
          if (tl > 1e-9) {
            _c.divideScalar(tl);
            const d = _b.dot(_c);
            if (d < cosMax) {
              // rotate the direction towards the posed one until it is maxDev away
              _d.copy(_b).addScaledVector(_c, -d);
              if (_d.lengthSq() < 1e-12) _d.copy(left);
              _d.normalize();
              _b.copy(_c).multiplyScalar(cosMax).addScaledVector(_d, Math.sin(maxDev * D2R));
              v.copy(VT[i]);
            }
          }
          x.copy(c.X[i - 1]).addScaledVector(_b, c.len[i]);
          if (ground && x.y < floor[i]) { x.y = floor[i]; v.y = Math.max(0, v.y); }
        }
      }
      // pose the chain onto the simulated points
      for (let i = 0; i < n; i++) {
        const childPos = i < n - 1 ? worldPos(c.bones[i + 1]) : c.bones[n - 1].localToWorld(c.tipLocal.clone());
        aimBone(c.bones[i], childPos, c.X[i + 1]);
      }
    }
  }

  // ------------------------------------------------------------------ actions

  play(def, params) {
    this.action = { def, t: 0, params: { ...def.defaults, ...params } };
  }
  stopAction() { this.action = null; }
}

const _fwd = V(), _left = V(), _q2 = V();

export function emptyOverlay() {
  return {
    body: V(), lift: 0, pitch: 0, roll: 0, yaw: 0, spinePitch: 0, spineYaw: 0, spineRoll: 0,
    headPitch: 0, headYaw: 0, headRoll: 0, jaw: 0, ik: 1, targets: new Map(), wave: {}, shake: 0, wing: 0,
    hold: false, stepAnyway: false, noReach: false, stepScale: 1,
  };
}

function frac(x) { return x - Math.floor(x); }

/** Deepest bone that is an ancestor of (or equal to) every bone in the list. */
function commonAncestorBone(list) {
  if (!list.length) return null;
  const path = (b) => { const p = []; for (let x = b; x; x = x.parent) p.unshift(x); return p; };
  let common = path(list[0]);
  for (const b of list.slice(1)) {
    const p = path(b);
    let i = 0;
    while (i < common.length && i < p.length && common[i] === p[i]) i++;
    common = common.slice(0, i);
  }
  for (let i = common.length - 1; i >= 0; i--) if (common[i].isBone) return common[i];
  return null;
}

/** Wing stroke over one beat: +1 (top) -> -1 (bottom) during the downstroke (share D), back up during the upstroke. */
function strokeValue(ph, D) {
  return ph < D ? Math.cos(Math.PI * ph / D) : -Math.cos(Math.PI * (ph - D) / (1 - D));
}
function wrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
