// Procedural one-shot actions. Each writes an overlay (offsets for body, spine, head, jaw, limb targets)
// that the motion engine layers over locomotion — so feet stay planted on uneven ground during an attack.
import * as THREE from 'three';
import { worldPos } from './ik.js';

const D2R = Math.PI / 180;
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Anticipation -> strike -> hold -> recover. Returns { wind, strike } in 0..1. */
function attack(u, ant = 0.35, hit = 0.13, hold = 0.12) {
  if (u < ant) return { wind: ease(u / ant), strike: 0 };
  if (u < ant + hit) { const k = ease((u - ant) / hit); return { wind: 1 - k, strike: k }; }
  if (u < ant + hit + hold) return { wind: 0, strike: 1 };
  return { wind: 0, strike: 1 - ease((u - ant - hit - hold) / (1 - ant - hit - hold)) };
}

/** First limb of a type, front-most and on the given side when possible. */
function pick(m, types, side = 'L') {
  for (const t of types) {
    const list = m.info.limbs.filter((l) => l.type === t);
    if (!list.length) continue;
    const front = t === 'leg' ? list.filter((l) => m.legs.find((g) => g.limb === l)?.front) : list;
    const pool = front.length ? front : list;
    return pool.find((l) => l.side === side) || pool[0];
  }
  return null;
}

function bodyAxes(m) {
  const y = m.body.yaw;
  return { fwd: new THREE.Vector3(Math.sin(y), 0, Math.cos(y)), left: new THREE.Vector3(Math.cos(y), 0, -Math.sin(y)), up: new THREE.Vector3(0, 1, 0) };
}

/** Rest position (world) of a limb's effector, carried by the body. */
function limbRest(m, limb) {
  const leg = m.legs.find((g) => g.limb === limb);
  // an arm counts as a leg only while the creature runs on all fours
  if (leg && !(leg.armLeg && (m.quad || 0) < 0.5)) {
    const p = m.idealFoot(leg, m.body.pos, m.body.yaw, new THREE.Vector3());
    p.y = leg.groundY + leg.effHeight;
    return p;
  }
  return worldPos(limb.bones[Math.min(limb.effector, limb.bones.length - 1)]).clone();
}

export const ACTIONS = {
  bite: {
    label: 'Bite', group: 'Attack', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 0.9 / p.speed,
    apply(m, u, o, p) {
      const { wind, strike } = attack(u, 0.38, 0.12, 0.1);
      const I = p.intensity;
      o.body.z += (-0.05 * wind + 0.12 * strike) * I;
      o.body.y += (0.02 * wind - 0.03 * strike) * I;
      o.spinePitch += (-8 * wind + 12 * strike) * D2R * I;
      o.headPitch += (-18 * wind + 10 * strike) * D2R * I;
      o.jaw = Math.max(o.jaw, Math.sin(Math.PI * Math.min(1, u / 0.5)) * I);
      o.wave.tail = 1 + 1.5 * wind;
      o.hold = true;
    },
  },
  headbutt: {
    label: 'Charge / headbutt', group: 'Attack', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.1 / p.speed,
    apply(m, u, o, p) {
      const { wind, strike } = attack(u, 0.42, 0.12, 0.12);
      const I = p.intensity;
      o.body.z += (-0.12 * wind + 0.28 * strike) * I;
      o.body.y += -0.06 * (wind + strike) * I;
      o.pitch += (-4 * wind + -6 * strike) * D2R * I;
      o.spinePitch += 8 * (wind + strike) * D2R * I;
      o.headPitch += 22 * (wind + strike) * D2R * I;
      o.hold = true; o.stepAnyway = true;
    },
  },
  swipe: {
    label: 'Claw swipe', group: 'Attack', defaults: { intensity: 1, speed: 1, side: 'L' },
    duration: (p) => 1.0 / p.speed,
    apply(m, u, o, p) {
      const limb = pick(m, ['arm', 'leg', 'wing'], p.side);
      const { wind, strike } = attack(u, 0.4, 0.14, 0.1);
      const I = p.intensity;
      const { fwd, left, up } = bodyAxes(m);
      const s = p.side === 'R' ? -1 : 1;
      o.body.x += -0.04 * s * (wind + strike) * I;
      o.roll += -6 * s * wind * D2R * I;
      o.spineYaw += (10 * s * wind - 14 * s * strike) * D2R * I;
      if (limb) {
        const rest = limbRest(m, limb);
        const L = limb.len || m.H * 0.4;
        const raised = rest.clone().addScaledVector(up, 0.7 * L * I).addScaledVector(fwd, 0.1 * L).addScaledVector(left, 0.15 * L * s);
        const struck = rest.clone().addScaledVector(up, 0.08 * L).addScaledVector(fwd, 0.55 * L * I).addScaledVector(left, -0.25 * L * s);
        const pos = rest.clone().lerp(raised, wind).lerp(struck, strike);
        o.targets.set(limb.id, { pos, w: Math.max(wind, strike) });
      }
      o.hold = true;
    },
  },
  stomp: {
    label: 'Stomp', group: 'Attack', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.1 / p.speed,
    apply(m, u, o, p) {
      const { wind, strike } = attack(u, 0.45, 0.08, 0.15);
      const I = p.intensity;
      const { up } = bodyAxes(m);
      o.pitch += (12 * wind - 3 * strike) * D2R * I;
      o.body.y += (0.06 * wind - 0.05 * strike) * I;
      for (const side of ['L', 'R']) {
        const limb = pick(m, ['leg', 'arm'], side);
        if (!limb) continue;
        const rest = limbRest(m, limb);
        o.targets.set(limb.id, { pos: rest.clone().addScaledVector(up, 0.45 * (limb.len || m.H * 0.4) * I * wind), w: wind });
      }
      o.shake = strike > 0.9 ? 3 * I * (1 - (u - 0.53) / 0.2) : 0;
      o.hold = true;
    },
  },
  tailwhip: {
    label: 'Tail whip', group: 'Attack', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.2 / p.speed,
    apply(m, u, o, p) {
      const { wind, strike } = attack(u, 0.35, 0.18, 0.1);
      const I = p.intensity;
      o.yaw += (-25 * wind + 40 * strike) * D2R * I;
      o.spineYaw += (-10 * wind + 15 * strike) * D2R * I;
      o.headYaw += (25 * wind - 30 * strike) * D2R * I;
      o.wave.tail = 1 + 3 * Math.max(wind, strike) * I;
      o.hold = true; o.stepAnyway = true;
    },
  },
  roar: {
    label: 'Roar', group: 'Attack', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.8 / p.speed,
    apply(m, u, o, p) {
      const { wind, strike } = attack(u, 0.25, 0.1, 0.45);
      const I = p.intensity;
      o.body.z += (-0.04 * wind + 0.03 * strike) * I;
      o.spinePitch += (6 * wind - 10 * strike) * D2R * I;
      o.headPitch += (10 * wind - 26 * strike) * D2R * I;
      o.jaw = Math.max(o.jaw, strike * I);
      o.shake = strike * 1.5 * I;
      o.wave.ear = 0.2; o.wave.tail = 1 + strike;
      o.hold = true;
    },
  },
  gust: {
    label: 'Wing gust', group: 'Attack', needs: 'wing', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.2 / p.speed,
    apply(m, u, o, p) {
      const { wind, strike } = attack(u, 0.4, 0.12, 0.12);
      const I = p.intensity;
      o.wing = (60 * wind - 25 * strike) * D2R * I;
      o.body.y += (0.06 * wind - 0.02 * strike) * I;
      o.pitch += 6 * wind * D2R * I;
      o.hold = true;
    },
  },
  hit: {
    label: 'Hit reaction', group: 'React', defaults: { intensity: 1, speed: 1, from: 'front' },
    duration: (p) => 0.75 / p.speed,
    apply(m, u, o, p) {
      const I = p.intensity;
      const k = u < 0.12 ? ease(u / 0.12) : 1 - ease((u - 0.12) / 0.88);
      const dir = p.from === 'left' ? [1, 0] : p.from === 'right' ? [-1, 0] : [0, 1];
      o.body.z += -0.07 * dir[1] * k * I; o.body.x += -0.07 * dir[0] * k * I;
      o.spinePitch += -12 * dir[1] * k * D2R * I;
      o.spineRoll += 10 * dir[0] * k * D2R * I;
      o.headPitch += -20 * dir[1] * k * D2R * I;
      o.headYaw += 15 * dir[0] * k * D2R * I;
      o.jaw = Math.max(o.jaw, 0.4 * k);
      o.wave.tail = 1 + k; o.wave.ear = 1 + k;
      o.hold = true; o.stepAnyway = true;
    },
  },
  death: {
    label: 'Faint / death', group: 'React', hold: true, defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.6 / p.speed,
    apply(m, u, o) {
      const k = ease(Math.min(1, u / 0.85));
      o.body.y += -0.32 * k + 0.05 * Math.sin(Math.min(1, u / 0.3) * Math.PI);
      o.roll += 75 * k * D2R;
      o.headPitch += 20 * k * D2R;
      o.spineRoll += 10 * k * D2R;
      o.ik = 1 - 0.85 * k;
      o.jaw = 0.25 * k;
      o.wave.tail = 1 - k; o.wave.tentacle = 1 - 0.8 * k;
      o.hold = true;
    },
  },
  jump: {
    label: 'Jump', group: 'Move', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.25 / p.speed,
    apply(m, u, o, p) {
      const I = p.intensity;
      const crouch = u < 0.25 ? ease(u / 0.25) : u < 0.32 ? 1 - ease((u - 0.25) / 0.07) : u > 0.82 ? Math.sin(((u - 0.82) / 0.18) * Math.PI) : 0;
      const air = u >= 0.3 && u <= 0.84 ? Math.sin(((u - 0.3) / 0.54) * Math.PI) : 0;
      o.body.y += -0.12 * crouch * I;
      o.lift += 0.6 * air * I;
      o.pitch += (-6 * crouch + 8 * (u > 0.3 && u < 0.55 ? air : -air * 0.5)) * D2R;
      o.ik = 1 - 0.9 * (air > 0.05 ? Math.min(1, air * 3) : 0);
      o.wave.tail = 1 + air; o.wave.ear = 1 + air;
      o.hold = true;
    },
  },
  happy: {
    label: 'Happy', group: 'Move', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 1.6 / p.speed,
    apply(m, u, o, p) {
      const I = p.intensity;
      const env = Math.sin(Math.PI * u);
      const hop = Math.abs(Math.sin(u * Math.PI * 3));
      o.lift += 0.12 * hop * env * I;
      o.body.y += -0.03 * (1 - hop) * env;
      o.headRoll += 12 * Math.sin(u * Math.PI * 2) * env * D2R * I;
      o.headPitch += -8 * env * D2R;
      o.wave.tail = 1 + 4 * env * I; o.wave.ear = 1 + env;
      o.ik = 1 - 0.7 * hop * env;
      o.jaw = 0.3 * env;
      o.hold = true;
    },
  },
  look: {
    label: 'Look around', group: 'Move', defaults: { intensity: 1, speed: 1 },
    duration: (p) => 2.6 / p.speed,
    apply(m, u, o, p) {
      const I = p.intensity;
      const y = Math.sin(u * Math.PI * 2) * ease(Math.min(1, u * 4)) * ease(Math.min(1, (1 - u) * 4));
      o.headYaw += 45 * y * D2R * I;
      o.spineYaw += 10 * y * D2R * I;
      o.headPitch += -6 * Math.sin(u * Math.PI) * D2R;
    },
  },
};

/** Which actions make sense for a creature. */
export function availableActions(info) {
  const has = (t) => info.limbs.some((l) => l.type === t);
  return Object.entries(ACTIONS).filter(([, a]) => !a.needs || has(a.needs));
}
