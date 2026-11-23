// Limb detection: reads any skeleton (2, 3, 4, 6... legs, wings, tails, ears, tentacles) from its geometry,
// with bone names only as hints. Works on the pose the creature is in when called (the reference pose).
import * as THREE from 'three';
import { wpos, poseBounds } from './skeleton.js';

export const TYPES = {
  leg:       { label: 'Leg',            color: '#30d158', gait: true },
  arm:       { label: 'Arm',            color: '#64d2ff' },
  wing:      { label: 'Wing',           color: '#bf5af2' },
  wingFolded:{ label: 'Folded wing',    color: '#8e6bb8' },
  tail:      { label: 'Tail',           color: '#ff9f0a', dyn: true },
  ear:       { label: 'Ear',            color: '#ff375f', dyn: true },
  tentacle:  { label: 'Tentacle',       color: '#7d7aff', dyn: true },
  appendage: { label: 'Hair / antenna', color: '#d4a373', dyn: true },
  jaw:       { label: 'Jaw',            color: '#ff6961' },
  detail:    { label: 'Toes / fingers', color: '#8e8e93' },
  ignore:    { label: 'Ignore',         color: '#48484a' },
};
export const TYPE_KEYS = Object.keys(TYPES);

const FORWARD = { '+Z': [0, 0, 1], '-Z': [0, 0, -1], '+X': [1, 0, 0], '-X': [-1, 0, 0] };

/** Frame of the creature inside its root: up is +Y, forward is chosen. left = up x forward. */
export function makeFrame(forwardKey = '+Z') {
  const f = new THREE.Vector3(...FORWARD[forwardKey] || FORWARD['+Z']);
  const u = new THREE.Vector3(0, 1, 0);
  const l = new THREE.Vector3().crossVectors(u, f);
  return { key: forwardKey, f, u, l };
}

/** Words of a bone name: "LForeArm2" -> l, fore, arm; "mixamorig:LeftUpLeg" -> mixamorig, left, up, leg. */
function words(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}
const WORDS = {
  wing: ['wing', 'wings'], tail: ['tail', 'sippo'], ear: ['ear', 'ears'], jaw: ['jaw', 'mouth', 'beak', 'mandible', 'tongue'],
  tentacle: ['tentacle', 'tendril', 'feeler', 'vine', 'whip'], hair: ['hair', 'antenna', 'horn', 'crest', 'mane', 'feather', 'plume', 'ponytail'],
  head: ['head'], skipFirst: ['shoulder', 'clavicle', 'collar', 'scapula'],
  arm: ['arm', 'forearm', 'hand', 'shoulder', 'elbow', 'wrist', 'finger', 'claw'],
  finger: ['finger', 'thumb', 'digit', 'claw'],
};
/** Bone-name test: whole words (camelCase aware), plus long words found inside run-together names. */
function nameHas(kind, names) {
  const list = WORDS[kind];
  for (const n of names) {
    const w = words(n);
    if (w.some((x) => list.includes(x))) return true;
    const flat = n.toLowerCase();
    if (list.some((x) => x.length >= 5 && flat.includes(x))) return true;
  }
  return false;
}
const RX = {
  wing: { test: (s) => nameHas('wing', s.split(' ')) }, tail: { test: (s) => nameHas('tail', s.split(' ')) },
  ear: { test: (s) => nameHas('ear', s.split(' ')) }, jaw: { test: (s) => nameHas('jaw', s.split(' ')) },
  tentacle: { test: (s) => nameHas('tentacle', s.split(' ')) }, hair: { test: (s) => nameHas('hair', s.split(' ')) },
  head: { test: (s) => { const w = words(s); return w.length > 0 && w[w.length - 1] === 'head'; } },
  skipFirst: { test: (s) => nameHas('skipFirst', [s]) },
  arm: { test: (s) => nameHas('arm', s.split(' ')) },
};

let uid = 1;

/**
 * The skeleton's own links, seen through plain nodes in between: some converted files keep a bone as a plain node
 * (a 3ds Max Biped's clavicle), and the arm hanging off it is still the neck's child.
 */
export function boneKids(b) {
  const out = [];
  const visit = (o) => { for (const c of o.children) { if (c.isBone) out.push(c); else if (!c.isMesh && c.isObject3D) visit(c); } };
  visit(b);
  return out;
}
export function boneParent(b) {
  let p = b.parent;
  while (p && !p.isBone) { if (p.isScene) return null; p = p.parent; }
  return p || null;
}

/**
 * @param {import('./skeleton.js').Creature} creature posed in the reference pose
 * @param {{forward?: string}} opts
 */
/**
 * Bone positions in the creature's frame (x = left, y = up, z = forward, root units) in the current pose, the
 * left/right coordinate from the symmetric bind pose, and the pose's bounds (ground, height).
 */
export function measure(creature, frame) {
  const root = creature.root;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const bones = creature.bones;
  const P = new Map();
  const tmp = new THREE.Vector3();
  for (const b of bones) {
    wpos(b, tmp).applyMatrix4(inv);
    P.set(b, new THREE.Vector3(tmp.dot(frame.l), tmp.dot(frame.u), tmp.dot(frame.f)));
  }
  // left/right comes from the bind pose, which is symmetric even when the reference pose is not
  const SX = new Map();
  if (creature.meshes.length) {
    const pose = creature.snapshot();
    creature.applySnapshot(creature.bindSnapshot());
    creature.root.updateMatrixWorld(true);
    for (const b of bones) SX.set(b, wpos(b, tmp).applyMatrix4(inv).dot(frame.l));
    creature.applySnapshot(pose);
    creature.root.updateMatrixWorld(true);
    // trust it only when it agrees with the pose about what is left and right: some converted files are bound
    // turned another way (Crystalwing), and then the pose itself says it better
    const mx = (vals) => vals.reduce((a, v) => a + v, 0) / vals.length;
    const sx = bones.map((b) => SX.get(b)), px = bones.map((b) => P.get(b).x);
    const ms = mx(sx), mp = mx(px);
    let num = 0, ds = 0, dp = 0;
    for (let i = 0; i < bones.length; i++) { num += (sx[i] - ms) * (px[i] - mp); ds += (sx[i] - ms) ** 2; dp += (px[i] - mp) ** 2; }
    if (!(num / Math.sqrt(ds * dp || 1) > 0.5)) SX.clear();
  }
  const sideX = (b) => (SX.has(b) ? SX.get(b) : P.get(b).x);
  const box = poseBounds(creature, root);
  const ground = box.min.y;
  const H = Math.max(1e-6, box.max.y - box.min.y);
  return { P, sideX, box, ground, H };
}

export function detectLimbs(creature, opts = {}) {
  const frame = makeFrame(opts.forward);
  const bones = creature.bones;
  const W = creature.weighted;
  const anyW = W.size > 0;
  const { P, sideX, box, ground, H } = measure(creature, frame);
  const size = box.getSize(new THREE.Vector3());
  const reach = Math.max(H, size.x, size.z);

  // significant bones: carry weight, or lead to a bone that does (drops effect / helper leaves)
  const sig = new Set();
  for (let i = bones.length - 1; i >= 0; i--) {
    const b = bones[i];
    if (!anyW || W.has(b) || boneKids(b).some((c) => sig.has(c))) sig.add(b);
  }
  const kids = (b) => boneKids(b).filter((c) => sig.has(c));

  // head: by name, else none (body is the head for blobs)
  let head = null;
  const named = [...sig].filter((b) => RX.head.test(b.name));
  if (named.length) head = named.sort((a, b) => a.name.length - b.name.length)[0];

  // split the tree into segments (runs of single-child bones); always break after the head
  const segs = [];
  const walk = (start, parentBone, parentSeg) => {
    const seg = { bones: [], parentBone, parentSeg, childSegs: [] };
    segs.push(seg);
    let b = start;
    for (;;) {
      seg.bones.push(b);
      const k = kids(b);
      if (k.length === 1 && b !== head) { b = k[0]; continue; }
      for (const c of k) seg.childSegs.push(walk(c, b, seg));
      break;
    }
    return seg;
  };
  const roots = [...sig].filter((b) => !boneParent(b) || !sig.has(boneParent(b)));
  roots.forEach((r) => walk(r, null, null));

  // trunk: root -> head, plus short centred hubs that branch (hips)
  const trunk = new Set();
  if (head) for (let b = head; b && sig.has(b); b = boneParent(b)) trunk.add(b);
  else for (const r of roots) { let b = r; for (;;) { trunk.add(b); const k = kids(b); if (k.length !== 1) break; b = k[0]; } }
  const segOnTrunk = (s) => s.bones.every((b) => trunk.has(b));
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of segs) {
      if (segOnTrunk(s) || !s.parentBone || !trunk.has(s.parentBone)) continue;
      const cx = Math.max(...s.bones.map((b) => Math.abs(P.get(b).x)));
      // a hub (hips) branches to both sides; a shoulder whose leg and a flame on it both go one way is not one (Ponyta)
      // (sides from the symmetric bind pose, relative to the hub itself: a reference pose can be lopsided)
      const ends = s.childSegs.map((c) => { const xs = []; const f = (x) => { x.bones.forEach((b) => xs.push(sideX(b))); x.childSegs.forEach(f); }; f(c); return xs; });
      const means = ends.map((xs) => xs.reduce((a, x) => a + x, 0) / xs.length);
      const hx = s.bones.reduce((a, b) => a + sideX(b), 0) / s.bones.length;
      const bothSides = means.some((x) => x > hx + 0.02 * H) && means.some((x) => x < hx - 0.02 * H);
      if (s.bones.length <= 2 && s.childSegs.length >= 2 && cx < 0.1 * H && bothSides && (!head || !isUnder(s.parentBone, head))) {
        s.bones.forEach((b) => trunk.add(b)); grew = true;
      }
    }
  }

  // limbs: segments hanging off the trunk; a limb continues through a branch into a clearly dominant child
  const depthOf = (s) => s.bones.length + Math.max(0, ...s.childSegs.map(depthOf));
  // lowest point of a segment and everything under it (helper end bones too: they mark toe tips)
  const lowestOf = (s) => {
    let m = Infinity;
    for (const b of s.bones) b.traverse((o) => { if (o.isBone && P.has(o)) m = Math.min(m, P.get(o).y); });
    return m;
  };
  const limbs = [];
  const queue = segs.filter((s) => !segOnTrunk(s) && s.parentBone && trunk.has(s.parentBone));
  while (queue.length) {
    const s = queue.shift();
    const chain = [...s.bones];
    const details = [];
    let cur = s;
    for (;;) {
      if (!cur.childSegs.length) break;
      const d = cur.childSegs.map(depthOf);
      let best = d.indexOf(Math.max(...d));
      const rest = d.filter((_, i) => i !== best);
      let dominant = cur.childSegs.length === 1 || (d[best] >= 2 && d[best] >= 2 * Math.max(...rest));
      // a leg continues into the one branch that reaches the ground, even when something longer grows off the
      // same joint (a flame or a fin on the leg: Ponyta)
      if (!dominant) {
        const low = cur.childSegs.map(lowestOf);
        const g = low.map((y) => y - ground < 0.12 * H);
        if (g.filter(Boolean).length === 1) {
          const gi = g.indexOf(true);
          if (low.every((y, i) => i === gi || y - low[gi] > 0.1 * H)) {
            best = gi; dominant = true;
            // the other branches are parts of their own (the flame gets its spring), not toes
            cur.childSegs.forEach((c, i) => { if (i !== gi && depthOf(c) >= 2) queue.push(c); else if (i !== gi) details.push(c); });
            chain.push(...cur.childSegs[best].bones);
            cur = cur.childSegs[best];
            continue;
          }
        }
      }
      if (!dominant) { details.push(...cur.childSegs); break; }
      cur.childSegs.forEach((c, i) => { if (i !== best) details.push(c); });
      chain.push(...cur.childSegs[best].bones);
      cur = cur.childSegs[best];
    }
    const detailBones = [];
    const collect = (x) => { detailBones.push(...x.bones); x.childSegs.forEach(collect); };
    details.forEach(collect);
    limbs.push({ chain, detailBones, parentBone: s.parentBone });
  }

  // the creature's mid plane (trunk bones are central), so sides work for models not centred on 0
  const trunkX = [...trunk].map((b) => sideX(b));
  const midX = trunkX.length ? trunkX.reduce((a, x) => a + x, 0) / trunkX.length : 0;
  const relX = (b) => sideX(b) - midX;

  // reference measures
  const legish = (L) => L.chain.some((b) => P.get(b).y - ground < 0.12 * H);
  const bodyZ = (() => {
    const t = [...trunk].map((b) => P.get(b).z);
    return t.length ? (Math.min(...t) + Math.max(...t)) / 2 : 0;
  })();

  const out = [];
  for (const L of limbs) {
    const pts = L.chain.map((b) => P.get(b));
    // end and helper joints hanging off the limb (toe tips, foot markers) count for touching the ground
    const tips = L.chain.flatMap((b) => boneKids(b).filter((c) => !sig.has(c)));
    const all = [...pts, ...L.detailBones.map((b) => P.get(b)), ...tips.map((b) => P.get(b))];
    const start = pts[0], tip = pts[pts.length - 1];
    const dir = tip.clone().sub(start);
    const len = pts.reduce((a, p, i) => (i ? a + p.distanceTo(pts[i - 1]) : 0), 0);
    if (dir.lengthSq() > 0) dir.normalize();
    const minY = Math.min(...all.map((p) => p.y)) - ground;
    // side from the symmetric bind pose, averaged over the limb (a wing starts near the middle but reaches out)
    const meanX = L.chain.reduce((a, b) => a + relX(b), 0) / L.chain.length;
    const side = meanX > 0.04 * H ? 'L' : meanX < -0.04 * H ? 'R' : 'C';
    const lateral = Math.max(...L.chain.map((b) => Math.abs(relX(b)))) - Math.abs(relX(L.chain[0]));
    const names = L.chain.map((b) => b.name).join(' ');
    const onHead = head && isUnder(L.parentBone, head);
    let grounded = minY < 0.12 * H;
    let descends = start.y - ground - minY > 0.1 * H;
    let skinFoot = false;
    // a side part whose bones stop short of the ground while its skin goes on down to it (a spider's legs end
    // in a long unboned tip): the skin it moves decides (side parts only - a tail lying on the ground is no leg)
    if (!grounded && side !== 'C') {
      const sy = skinLowest(creature, L.chain[L.chain.length - 1], frame);
      if (sy !== null && sy - ground < 0.08 * H) { grounded = true; descends = start.y - sy > 0.1 * H; skinFoot = true; }
    }

    // small wings on the back (Clefairy, fairies, bees): a left/right pair of short parts that start behind the
    // middle of the body and above half its height - ears sit on top of the head, tails at the back in the middle
    // - and they are flat: a round lump there (Paras's mushrooms) is not a wing
    const backWing = side !== 'C' && L.chain.length <= 3 && start.z < bodyZ - 0.15 * H && start.y - ground > 0.35 * H
      && !RX.ear.test(names) && !RX.tail.test(names) && !RX.jaw.test(names)
      && !(skinFlatness(creature, L.chain[0]) > 0.4);

    let type;
    if (RX.wing.test(names) || backWing) type = 'wing';
    else if (onHead) {
      // round creatures whose body bone is called "Head" carry their arms on it
      if (side !== 'C' && L.chain.length >= 2 && RX.arm.test(names)) type = grounded && descends ? 'leg' : 'arm';
      else if (RX.jaw.test(names)) type = 'jaw';
      else if (RX.ear.test(names)) type = 'ear';
      else if (RX.hair.test(names)) type = 'appendage';
      else if (RX.tentacle.test(names)) type = L.chain.length >= 4 ? 'tentacle' : 'appendage';
      else if (dir.y > 0.35 && L.chain.length <= 4) type = 'ear';
      else if (side === 'C' && dir.z > 0.3 && dir.y < 0.25) type = 'jaw';
      else type = 'appendage';
    } else if (RX.wing.test(names)) type = 'wing';
    else if (RX.tail.test(names)) type = 'tail';
    else if (RX.tentacle.test(names) && L.chain.length >= 3) type = 'tentacle';
    else if (grounded && descends) type = 'leg';
    // a long part reaching out sideways is a wing if its skin is a flat membrane, not a round tube (an outstretched
    // arm: Nidoking 0.82, Growlithe 0.81 vs wings 0.17-0.40, thinnest / middle spread in the bind pose). Without
    // skin to measure, by names: not a hand with short fingers on it - unless finger bones carry much of the
    // length (a bird's wing is built on its fingers: Moltres Hand > Finger1 > Finger2)
    else if (side !== 'C' && L.chain.length >= 2 && len > 0.3 * H && lateral > 0.75 * len && (() => {
      const sh = skinShape(creature, L.chain[0]);
      if (sh) return sh.thinMid < 0.55;
      return !nameHas('finger', L.detailBones.map((b) => b.name)) || fingerShare(L.chain, pts, len) > 0.3;
    })()) type = 'wing';
    // a wing built as a fan: many short finger chains from one root, spreading out sideways over a flat membrane
    // (Crystalwing) - the chain itself is short, the reach is in its fingers
    else if (side !== 'C' && L.detailBones.length >= 4
      && Math.max(...[...L.chain, ...L.detailBones].map((b) => Math.abs(relX(b)))) - Math.abs(relX(L.chain[0])) > 0.25 * H
      && (() => { const sh = skinShape(creature, L.chain[0]); return !!sh && sh.thinMid < 0.55; })()) type = 'wing';
    else if (side === 'C' && start.z <= bodyZ && dir.z < -0.2) type = 'tail';
    else if (RX.ear.test(names)) type = 'ear';
    else if (RX.hair.test(names)) type = 'appendage';
    else if (side !== 'C' && L.chain.length >= 2) type = 'arm';
    else if (L.chain.length >= 4) type = 'tentacle';
    else type = 'appendage';

    const limb = makeLimb({
      chain: L.chain, detailBones: L.detailBones, parentBone: L.parentBone, type, side,
      pts, ground, H, len, auto: true,
    });
    if (backWing && !RX.wing.test(names)) limb.backWingAt = { x: meanX, y: start.y, z: start.z };
    // the foot is the skin past the last bone: that bone is the effector, the whole chain bends
    if (skinFoot && type === 'leg') { limb.effector = L.chain.length - 1; limb.ikStart = 0; }
    out.push(limb);
  }
  // a long body lying along the ground with no head bone named (a snake): what branches off its front end is the
  // head's parts (jaw, tongue), not legs
  const trunkBones = bones.filter((b) => trunk.has(b));
  if (!head && trunkBones.length >= 7 && Math.max(...trunkBones.map((b) => P.get(b).y - ground)) < 0.6 * H) {
    const front = trunkBones[trunkBones.length - 1];
    for (const l of out) if ((l.type === 'leg' || l.type === 'arm') && boneParent(l.bones[0]) === front) { l.type = 'appendage'; l.effector = l.bones.length - 1; l.ikStart = 0; }
  }
  // back wings come in mirrored pairs: one flat plate without a twin on the other side (Rhyhorn's armour) isn't one
  for (const l of out) {
    const a = l.backWingAt;
    if (!a) continue;
    const twin = out.some((o) => o !== l && o.backWingAt && o.side !== l.side
      && Math.abs(o.backWingAt.x + a.x) < 0.12 * H && Math.abs(o.backWingAt.y - a.y) < 0.12 * H && Math.abs(o.backWingAt.z - a.z) < 0.12 * H);
    if (!twin) l.type = 'appendage';
  }
  for (const l of out) delete l.backWingAt;
  // legs come in mirrored pairs: the twin of a leg (same build, mirrored place) is a leg too, even when the
  // reference pose holds it up off the ground (Moltres hovers with one leg tucked higher)
  for (const l of out) {
    if (!['arm', 'appendage', 'tentacle'].includes(l.type) || l.side === 'C') continue;
    const twin = out.find((o) => o.type === 'leg' && o.side !== 'C' && o.side !== l.side
      && o.bones.length === l.bones.length && o.detailBones.length === l.detailBones.length
      && Math.abs(relX(o.bones[0]) + relX(l.bones[0])) < 0.06 * H
      && Math.abs(P.get(o.bones[0]).y - P.get(l.bones[0]).y) < 0.1 * H
      && Math.abs(P.get(o.bones[0]).z - P.get(l.bones[0]).z) < 0.15 * H);
    if (!twin) continue;
    l.type = 'leg';
    fitLegIK(l, l.bones.map((b) => P.get(b)), ground, H);
    // a foot that does not reach the ground here: same joints as its twin
    l.effector = Math.min(l.bones.length - 1, twin.effector);
    l.ikStart = Math.min(l.effector, twin.ikStart);
  }

  labelLimbs(out, P);
  const legs = out.filter((l) => l.type === 'leg');

  // pelvis = deepest common ancestor of every leg; else the first weighted trunk bone
  let pelvis = null;
  if (legs.length) pelvis = commonAncestor(legs.map((l) => l.bones[0].parent).filter(Boolean));
  if (!pelvis || !sig.has(pelvis)) {
    const tb = bones.filter((b) => trunk.has(b));
    pelvis = tb.find((b) => W.has(b) || !anyW) || tb[0] || bones[0] || null;
  }
  const trunkList = bones.filter((b) => trunk.has(b));
  // spine = the bones between pelvis and head (not side hubs such as the hips)
  const spine = [];
  if (head && pelvis && isUnder(head, pelvis)) {
    for (let b = boneParent(head); b && b !== pelvis; b = boneParent(b)) spine.unshift(b);
  }

  // locomotion style
  let style = 'hover';
  if (legs.length) style = 'walk';
  else {
    const longest = Math.max(trunkList.length, ...out.filter((l) => l.type === 'tail').map((l) => l.bones.length + trunkList.length));
    if (longest >= 7 && box.min.y - ground < 0.05 * H) style = 'slither';
  }

  const info = {
    frame, ground, H, reach, box, pelvis, head, spine, trunk: trunkList, limbs: out, style,
    hasWings: out.some((l) => l.type === 'wing'),
  };
  detectPartSwap(creature, info);
  return info;
}

/** Order limbs (by type, then front to back) and name them; a name the user typed (customLabel) is kept. */
export function labelLimbs(out, P) {
  const legs = out.filter((l) => l.type === 'leg');
  for (const l of out) l.startZ = P.get(l.bones[0]).z;
  out.sort((a, b) => TYPE_KEYS.indexOf(a.type) - TYPE_KEYS.indexOf(b.type) || b.startZ - a.startZ || (a.side < b.side ? -1 : 1));
  const counts = {};
  for (const l of out) {
    const k = l.type + l.side;
    counts[k] = (counts[k] || 0) + 1;
  }
  const seen = {};
  for (const l of out) {
    const k = l.type + l.side;
    seen[k] = (seen[k] || 0) + 1;
    if (l.customLabel) { l.label = l.customLabel; continue; }
    const sideName = l.side === 'L' ? 'Left ' : l.side === 'R' ? 'Right ' : '';
    let pos = '';
    const perSide = legs.filter((x) => x.side === l.side).length;
    if (l.type === 'leg' && perSide > 3) {
      // many legs (a spider): numbered front to back on each side
      const mine = legs.filter((x) => x.side === l.side).sort((a, b) => b.startZ - a.startZ);
      l.label = `${sideName}leg ${mine.indexOf(l) + 1}`;
      l.label = l.label.charAt(0).toUpperCase() + l.label.slice(1);
      continue;
    }
    if (l.type === 'leg' && legs.length > 2) {
      const zs = legs.map((x) => x.startZ);
      const t = (l.startZ - Math.min(...zs)) / Math.max(1e-6, Math.max(...zs) - Math.min(...zs));
      pos = t > 0.66 ? 'front ' : t < 0.33 ? 'back ' : 'middle ';
    }
    l.label = `${sideName}${pos}${TYPES[l.type].label.toLowerCase()}${counts[k] > 1 && !pos ? ' ' + seen[k] : ''}`;
    l.label = l.label.charAt(0).toUpperCase() + l.label.slice(1);
  }
}

/**
 * After the limbs were edited by hand: legs refit their IK, the body (trunk, pelvis, spine) follows from the head,
 * the pelvis and what is no longer a limb, limbs are ordered and named, and the way of moving is kept if it still
 * fits. info.pelvisManual / headManual keep a picked pelvis / head.
 */
export function finishInfo(creature, info) {
  const { P, ground, H, box } = measure(creature, info.frame);
  const limbs = info.limbs;
  const inLimb = new Set();
  for (const l of limbs) { l.bones.forEach((b) => inLimb.add(b)); l.detailBones.forEach((b) => inLimb.add(b)); }
  for (const l of limbs) {
    if (l.type !== 'leg') { l.effector = l.bones.length - 1; l.ikStart = 0; continue; }
    const pts = l.bones.map((b) => P.get(b));
    l.fit = { pts, ground, H };
    fitLegIK(l, pts, ground, H);
  }
  const legs = limbs.filter((l) => l.type === 'leg');
  if (info.head && inLimb.has(info.head) && !info.headManual) info.head = null;
  if (!info.pelvisManual && (legs.length || !info.pelvis || inLimb.has(info.pelvis))) {
    let pelvis = legs.length ? commonAncestor(legs.map((l) => l.bones[0].parent).filter(Boolean)) : null;
    if (!pelvis || inLimb.has(pelvis)) pelvis = info.trunk.find((b) => !inLimb.has(b)) || pelvis || info.pelvis;
    info.pelvis = pelvis;
  }
  // trunk: what it was minus new limb bones, plus the way from the root to the head and to the pelvis
  const trunk = new Set(info.trunk.filter((b) => !inLimb.has(b)));
  for (const end of [info.head, info.pelvis]) for (let b = end; b; b = boneParent(b)) if (!inLimb.has(b)) trunk.add(b);
  info.trunk = creature.bones.filter((b) => trunk.has(b));
  info.spine = [];
  if (info.head && info.pelvis && isUnder(info.head, info.pelvis)) for (let b = boneParent(info.head); b && b !== info.pelvis; b = boneParent(b)) info.spine.unshift(b);
  labelLimbs(limbs, P);
  if (legs.length && info.style !== 'walk' && !info.styleManual) info.style = 'walk';
  if (!legs.length && info.style === 'walk') info.style = 'hover';
  info.hasWings = limbs.some((l) => l.type === 'wing');
  info.ground = ground; info.H = H; info.box = box;
  for (const l of limbs) if (l.showIn === 'air') { l.showIn = undefined; l.hideBone = undefined; }
  detectPartSwap(creature, info);
  return info;
}

/**
 * Some models carry two sets of wings: open ones for flying and folded ones for standing, and their clips hide
 * one set by shrinking its bone (Pidgeot's ground clips scale LArm to 0.02). Wings shrunk that way are "air only";
 * other limbs that start right next to such a wing, on the same side, are its folded "ground only" counterpart.
 */
export function detectPartSwap(creature, info) {
  const wings = info.limbs.filter((l) => l.type === 'wing');
  if (!wings.length || !creature.animations.length) return;
  const shrunk = new Set();
  for (const clip of creature.animations) {
    for (const t of clip.tracks) {
      if (!t.name.endsWith('.scale')) continue;
      let min = Infinity;
      for (let i = 0; i < t.values.length; i++) min = Math.min(min, Math.abs(t.values[i]));
      if (min < 0.1) shrunk.add(t.name.slice(0, -'.scale'.length));
    }
  }
  const airWings = [];
  for (const w of wings) {
    const hb = w.bones.find((b) => shrunk.has(b.name));
    if (hb) { w.showIn = 'air'; w.hideBone = hb.name; airWings.push(w); }
  }
  for (const l of info.limbs) {
    if (['leg', 'wing', 'ear', 'tail', 'jaw', 'tentacle'].includes(l.type)) continue;
    const near = airWings.find((w) => w.side === l.side && wpos(l.bones[0]).distanceTo(wpos(w.bones[0])) < 0.2 * info.H);
    if (!near) continue;
    l.type = 'wingFolded';
    l.showIn = 'ground';
    l.hideBone = l.bones[0].name;
    l.label = `${l.side === 'L' ? 'Left' : l.side === 'R' ? 'Right' : ''} folded wing`.trim();
  }
}

/** Limb record shared by detection, the editor and added chains. */
export function makeLimb({ chain, detailBones = [], parentBone, type, side = 'C', pts, ground = 0, H = 1, len = 0, auto = false, label }) {
  const limb = {
    id: uid++, type, side, bones: chain, detailBones, parentBone, auto, label: label || type, len,
    effector: chain.length - 1, ikStart: 0, fit: pts ? { pts, ground, H } : null,
  };
  if (pts && type === 'leg') fitLegIK(limb, pts, ground, H);
  return limb;
}

/** Effector = first joint near the ground (ball of the foot); skip a shoulder/clavicle at the start. */
/** Lowest point (creature frame, current pose) of the skin a bone and the bones under it move; null if none. */
function skinLowest(creature, bone, frame) {
  const set = new Set();
  bone.traverse((o) => { if (o.isBone) set.add(o); });
  const inv = new THREE.Matrix4().copy(creature.root.matrixWorld).invert();
  const v = new THREE.Vector3();
  let low = Infinity;
  for (const m of creature.meshes) {
    if (!m.isSkinnedMesh) continue;
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!si || !sw) continue;
    for (let i = 0; i < si.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (set.has(m.skeleton.bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
      if (w < 0.5) continue;
      m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld).applyMatrix4(inv);
      low = Math.min(low, v.dot(frame.u));
    }
  }
  return low === Infinity ? null : low;
}

/** Share of a chain's length carried by bones named as fingers (a bird's wing: most of the span). */
function fingerShare(chain, pts, len) {
  if (!(len > 0)) return 0;
  let f = 0;
  for (let i = 1; i < chain.length; i++) if (nameHas('finger', [chain[i - 1].name])) f += pts[i].distanceTo(pts[i - 1]);
  return f / len;
}

/**
 * The shape of the skin driven by a bone (and the bones under it), from the spread of its vertices along their
 * principal axes (wide >= mid >= thin), measured in the bind pose (the mesh as modelled: a pose can fold a wing
 * up or scale it away). thin/mid: a wing or fin is 0.17-0.40, an arm or leg (a round tube) 0.70-0.82.
 * thin/wide: a small flat wing about 0.2, a round lump 0.7. null when it moves too few vertices.
 */
export function skinShape(creature, bone) {
  const set = new Set();
  bone.traverse((o) => { if (o.isBone) set.add(o); });
  const pts = [];
  for (const m of creature.meshes) {
    if (!m.isSkinnedMesh) continue;
    const pos = m.geometry.attributes.position;
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!si || !sw || !pos) continue;
    for (let i = 0; i < si.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (set.has(m.skeleton.bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
      if (w > 0.5) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i));
    }
  }
  if (pts.length < 12) return null;
  const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a][b] += d[a] * d[b];
  }
  // eigenvalues of the symmetric 3x3 covariance (Jacobi rotations)
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(A[i][j]) > Math.abs(A[p][q])) { p = i; q = j; }
    if (Math.abs(A[p][q]) < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), cs = Math.cos(th), sn = Math.sin(th);
    for (let k = 0; k < 3; k++) { const kp = A[k][p], kq = A[k][q]; A[k][p] = cs * kp - sn * kq; A[k][q] = sn * kp + cs * kq; }
    for (let k = 0; k < 3; k++) { const pk = A[p][k], qk = A[q][k]; A[p][k] = cs * pk - sn * qk; A[q][k] = sn * pk + cs * qk; }
  }
  const ev = [A[0][0], A[1][1], A[2][2]].map((x) => Math.sqrt(Math.max(0, x))).sort((a, b) => b - a);
  if (!(ev[1] > 0)) return null;
  return { thinMid: ev[2] / ev[1], midWide: ev[1] / ev[0], thinWide: ev[2] / ev[0] };
}

/** thin / widest spread of a part's skin (see skinShape), or null. */
export function skinFlatness(creature, bone) {
  const s = skinShape(creature, bone);
  return s ? s.thinWide : null;
}

export function fitLegIK(limb, pts, ground, H) {
  const n = limb.bones.length;
  let eff = -1;
  for (let i = 1; i < n; i++) if (pts[i].y - ground < 0.12 * H) { eff = i; break; }
  // no joint near the ground (high-set feet, e.g. an insect's legs arching over): the lowest joint after the hip,
  // preferring the one furthest down the chain when they are about as low (an arched leg's hip can sit below its knee)
  if (eff < 0) {
    let m = Infinity;
    for (let i = 1; i < n; i++) if (pts[i].y < m) { m = pts[i].y; eff = i; }
    for (let i = n - 1; i > eff; i--) if (pts[i].y - m < 0.03 * H) { eff = i; break; }
    if (eff < 0) eff = n - 1;
  }
  let start = 0;
  if (eff >= 3) {
    const seg = []; for (let i = 1; i <= eff; i++) seg.push(pts[i].distanceTo(pts[i - 1]));
    const avg = seg.reduce((a, b) => a + b, 0) / seg.length;
    if (RX.skipFirst.test(limb.bones[0].name) || seg[0] < 0.45 * avg) start = 1;
  }
  if (eff - start < 2) start = Math.max(0, eff - 2);
  limb.effector = eff;
  limb.ikStart = start;
}

export function isUnder(b, ancestor) {
  for (let x = b; x; x = x.parent) if (x === ancestor) return true;
  return false;
}

function commonAncestor(list) {
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

/**
 * Default foot sets: legs paired left/right from front to back; unpaired legs get their own set.
 * Feet inside a set alternate; each set has a phase offset (walk: 0, .25 / tripod: 0, .5, 0 ...).
 */
export function defaultFootSets(info) {
  const legs = info.limbs.filter((l) => l.type === 'leg');
  if (legs.length === 3) {
    // three legs: each steps on its own, a third of a cycle apart, going round (front-left, back, front-right)
    const byZ = [...legs].sort((a, b) => b.startZ - a.startZ);
    const front = byZ.slice(0, 2);
    if (front[1].side === 'L') front.reverse();
    const order = [front[0], byZ[2], front[1]];
    return order.map((l, i) => ({ feet: [l.id], offset: i / 3 }));
  }
  const tol = 0.15 * info.H;
  const left = [...legs].sort((a, b) => b.startZ - a.startZ);
  const sets = [];
  const used = new Set();
  for (const l of left) {
    if (used.has(l)) continue;
    used.add(l);
    const mate = left.find((m) => !used.has(m) && m.side !== l.side && m.side !== 'C' && l.side !== 'C' && Math.abs(m.startZ - l.startZ) < tol);
    const feet = mate ? (l.side === 'L' ? [l, mate] : [mate, l]) : [l];
    if (mate) used.add(mate);
    sets.push({ feet: feet.map((f) => f.id), offset: 0 });
  }
  sets.forEach((s, i) => { s.offset = sets.length === 2 ? (i ? 0.25 : 0) : (i % 2) * 0.5; });
  if (sets.length === 2 && sets[1].feet.length === 1) sets[1].offset = 0.25;
  return sets;
}
