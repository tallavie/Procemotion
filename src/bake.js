// Bake procedural motion into ordinary keyframed clips: in place, on flat ground, seamless loops.
import * as THREE from 'three';

export const LOOPS = {
  idle: { label: 'Idle', style: null },
  walk: { label: 'Walk', style: 'walk', speed: 0.3 },
  run: { label: 'Run', style: 'walk', speed: 0.9 },
  slither: { label: 'Slither', style: 'slither', speed: 0.4 },
  hover: { label: 'Hover move', style: 'hover', speed: 0.4 },
  flap: { label: 'Fly (flap)', fly: 'flap', speed: 0.5 },
  flapglide: { label: 'Fly (flap and glide)', fly: 'flapglide', speed: 0.5 },
  glide: { label: 'Fly (glide)', fly: 'glide', speed: 0.7 },
  hoverfly: { label: 'Fly (hover)', fly: 'hover', speed: 0 },
  serpentfly: { label: 'Fly (serpent)', fly: 'flap', speed: 0.5 },
};

export function loopsFor(motion) {
  const keys = ['idle'];
  if (motion.style === 'walk' && motion.legs.length) keys.push('walk', 'run');
  if (motion.style === 'slither') keys.push('slither');
  if (motion.snake) keys.push('serpentfly');
  if (motion.style === 'hover') keys.push('hover');
  if (motion.wings.length) keys.push('flapglide', 'flap', 'glide', 'hoverfly');
  return keys;
}

/**
 * @param motion the Motion engine (its state is saved and restored)
 * @param job { loop: key } or { action: def, params }
 */
export function bake(motion, job, { fps = 30, prefix = 'PM_' } = {}) {
  const cr = motion.creature;
  const P = motion.params;
  const saved = {
    mode: motion.mode, flat: motion.flatGround, speed: P.movement.speed, flight: { ...P.flight }, action: motion.action,
    paused: motion.paused, t: motion.t,
  };
  motion.flatGround = true;
  motion.paused = false;
  motion.action = null;
  const dt = 1 / fps;
  let duration, name, loop = true;

  if (job.loop) {
    const L = LOOPS[job.loop];
    name = prefix + L.label.replace(/[^A-Za-z]+/g, '_').replace(/_+$/, '');
    motion.mode = L.speed ? 'inplace' : 'stand';
    P.movement.speed = L.speed || 0;
    P.flight.on = !!L.fly;
    if (L.fly) P.flight.mode = L.fly;
    motion.reset();
    motion.flightBlend = L.fly ? 1 : 0;
    for (let i = 0; i < fps * 3; i++) motion.update(dt);
    if (motion.snake) {
      // one wave period: the wave is fixed to the ground, so it passes at body speed (plus the idle drift)
      const lam = P.slither.wavelength * motion.snake.L;
      const sp01 = Math.min(1, Math.abs(motion.body.speed) / (P.movement.maxSpeed * motion.unit));
      duration = lam / (Math.abs(motion.body.speed) + 0.1 * lam * (1 - sp01));
    } else if (L.fly === 'flapglide') {
      // one burst + one glide; start the recording at the beginning of a burst
      duration = P.flight.burst / P.flight.flapFreq + P.flight.glideTime;
      const W = motion.flightState;
      if (W) { W.gliding = false; W.count = 0; W.timer = 0; W.phase = 0; W.env = 1; }
    } else if (L.fly) duration = 1 / P.flight.flapFreq / (L.fly === 'hover' ? 1.4 : 1) * (L.fly === 'glide' ? 4 : 1);
    else if (motion.style === 'walk' && motion.legs.length && motion.phaseSpeed > 0) duration = 1 / motion.phaseSpeed;
    else duration = 2.5;
  } else {
    name = prefix + job.action.label.replace(/[^A-Za-z]+/g, '_').replace(/_+$/, '');
    motion.mode = 'stand';
    P.movement.speed = 0;
    P.flight.on = false;
    motion.reset();
    for (let i = 0; i < fps; i++) motion.update(dt);
    motion.play(job.action, job.params);
    duration = job.action.duration(motion.action.params);
    loop = false;
  }

  // record one cycle (frames 0..N-1); loops also record the M frames that follow it
  const N = Math.max(2, Math.round(duration * fps));
  const M = loop ? Math.max(2, Math.round(N * 0.25)) : 0;
  const bones = cr.bones;
  const grab = () => bones.map((b) => ({ q: b.quaternion.clone(), p: b.position.clone(), s: b.scale.clone() }));
  const frames = [];
  const total = loop ? N : N + 1;
  for (let i = 0; i < total; i++) {
    if (i > 0) motion.update(dt);
    frames.push(grab());
  }
  if (loop) {
    // crossfade the start with the natural continuation of the end, so frame N-1 -> frame 0 is seamless
    const after = [];
    for (let i = 0; i < M; i++) { motion.update(dt); after.push(grab()); }
    for (let i = 0; i < M; i++) {
      const w = (i + 1) / (M + 1); // 0 = continuation, 1 = original
      frames[i].forEach((f, bi) => {
        const c = after[i][bi];
        const q = c.q.clone();
        if (q.dot(f.q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        f.q.copy(q.slerp(f.q, w));
        f.p.copy(c.p.clone().lerp(f.p, w));
        f.s.copy(w < 0.5 ? c.s : f.s); // scale switches (hidden parts) are not blended
      });
    }
    // close the loop: the last key repeats the first (what UE expects of a looping sequence)
    frames.push(frames[0].map((f) => ({ q: f.q.clone(), p: f.p.clone(), s: f.s.clone() })));
  }

  const times = new Float32Array(frames.length).map((_, i) => i * dt);
  const tracks = [];
  bones.forEach((b, bi) => {
    const q = new Float32Array(frames.length * 4);
    let moved = false;
    const p = new Float32Array(frames.length * 3);
    const p0 = frames[0][bi].p;
    let prevQ = null;
    frames.forEach((f, i) => {
      const qq = f[bi].q.clone();
      if (prevQ && prevQ.dot(qq) < 0) qq.set(-qq.x, -qq.y, -qq.z, -qq.w);
      prevQ = qq;
      qq.toArray(q, i * 4);
      f[bi].p.toArray(p, i * 3);
      if (f[bi].p.distanceToSquared(p0) > 1e-10 || f[bi].p.distanceToSquared(cr.rest[bi].p) > 1e-10) moved = true;
    });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, q));
    if (moved) tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, times, p));
    // scale only where it changes (parts hidden on the ground or in the air)
    if (frames.some((f) => f[bi].s.distanceToSquared(cr.rest[bi].s) > 1e-8)) {
      const s = new Float32Array(frames.length * 3);
      frames.forEach((f, i) => f[bi].s.toArray(s, i * 3));
      tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.scale`, times, s));
    }
  });
  const clip = new THREE.AnimationClip(name, (frames.length - 1) * dt, tracks);
  clip.userData = { procemotion: true, loop };

  // restore
  motion.mode = saved.mode; motion.flatGround = saved.flat; P.movement.speed = saved.speed; Object.assign(P.flight, saved.flight);
  motion.action = saved.action; motion.paused = saved.paused;
  motion.reset();
  return clip;
}
