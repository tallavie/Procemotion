// Manual bone classification: turn a set of selected bones into limbs, take bones out of limbs, and save the
// whole mapping by bone names (per model) so it comes back the next time the model is opened.
import { makeLimb, measure, TYPES } from './detect.js';
import { defaultDynamics } from './motion.js';

const SPLIT = new Set(['tail', 'ear', 'tentacle', 'appendage']);

/** Connected pieces of a bone set: each is { root, bones } with bones in tree order. */
function components(set, order) {
  const roots = order.filter((b) => set.has(b) && !(b.parent && set.has(b.parent)));
  return roots.map((root) => {
    const bones = [];
    const walk = (b) => { bones.push(b); for (const c of b.children) if (c.isBone && set.has(c)) walk(c); };
    walk(root);
    return { root, bones };
  });
}

/**
 * A piece's main chain, the way the detection builds it: down from the root, through a fork only into a clearly
 * dominant branch (at least twice as deep as the others); several equal branches (toes, fingers) end the chain
 * and hang off it as details.
 */
function mainChain(piece, P, deepest = false) {
  const set = new Set(piece.bones);
  const kidsOf = (b) => b.children.filter((c) => c.isBone && set.has(c));
  const depth = (b) => 1 + Math.max(0, ...kidsOf(b).map(depth));
  const chain = [piece.root];
  for (let b = piece.root; ;) {
    const kids = kidsOf(b);
    if (!kids.length) break;
    let next = kids[0];
    if (kids.length > 1) {
      const d = kids.map(depth);
      const best = d.indexOf(Math.max(...d));
      const rest = d.filter((_, i) => i !== best);
      if (deepest) {
        // a springy part always goes on, into the branch that carries on straightest (a tail's own line); the
        // branches splitting off become parts of their own
        const prev = chain.length > 1 ? chain[chain.length - 2] : null;
        if (prev) {
          const inDir = P.get(b).clone().sub(P.get(prev)).normalize();
          const score = kids.map((c) => P.get(c).clone().sub(P.get(b)).normalize().dot(inDir));
          next = kids[score.indexOf(Math.max(...score))];
        } else next = kids[best];
      } else {
        if (!(d[best] >= 2 && d[best] >= 2 * Math.max(...rest))) break;
        next = kids[best];
      }
    }
    chain.push(next);
    b = next;
  }
  const inChain = new Set(chain);
  let len = 0;
  for (let i = 1; i < chain.length; i++) len += P.get(chain[i]).distanceTo(P.get(chain[i - 1]));
  return { chain, details: piece.bones.filter((b) => !inChain.has(b)), len };
}

function sideOf(chain, sideX, midX, H) {
  const m = chain.reduce((a, b) => a + sideX(b), 0) / chain.length - midX;
  return m > 0.04 * H ? 'L' : m < -0.04 * H ? 'R' : 'C';
}

function newLimb(chain, details, type, M, midX, side) {
  const pts = chain.map((b) => M.P.get(b));
  const len = pts.reduce((a, p, i) => (i ? a + p.distanceTo(pts[i - 1]) : 0), 0);
  const limb = makeLimb({
    chain, detailBones: details, parentBone: chain[0].parent, type,
    side: side || sideOf(chain, M.sideX, midX, M.H), pts, ground: M.ground, H: M.H, len, auto: false,
  });
  limb.manual = true;
  limb.dyn = defaultDynamics(type);
  if (type === 'wingFolded') { limb.showIn = 'ground'; limb.hideBone = chain[0].name; }
  return limb;
}

/** Context for building limbs: measurements and the body's mid line. */
export function context(creature, info) {
  const M = measure(creature, info.frame);
  const tx = info.trunk.map((b) => M.sideX(b));
  const midX = tx.length ? tx.reduce((a, x) => a + x, 0) / tx.length : 0;
  return { M, midX };
}

/**
 * Make limbs of `type` from the selected bones. Body bones (head - pelvis line) are left out; small gaps along a
 * chain (an unselected bone between two selected ones) are filled; each connected piece becomes one limb, so a box
 * over both legs makes two. Returns { limbs, skipped }.
 */
export function limbsFromSelection(creature, info, selected, type, ctx = context(creature, info)) {
  const trunk = new Set(info.trunk);
  const set = new Set([...selected].filter((b) => !trunk.has(b)));
  const skipped = [...selected].filter((b) => trunk.has(b));
  // fill gaps of up to 3 bones between selected ones
  for (const b of [...set]) {
    const way = [];
    for (let p = b.parent, k = 0; p && p.isBone && k < 4; p = p.parent, k++) {
      if (set.has(p)) { way.forEach((x) => set.add(x)); break; }
      if (trunk.has(p)) break;
      way.push(p);
    }
  }
  let pieces = components(set, creature.bones);
  // single joints caught in a box next to real parts (a jaw, a tail tip) are strays; one joint boxed alone is meant
  const stray = pieces.some((p) => p.bones.length >= 2) ? pieces.filter((p) => p.bones.length === 1) : [];
  pieces = pieces.filter((p) => !stray.includes(p));
  const limbs = [];
  const build = (piece) => {
    const { chain, details } = mainChain(piece, ctx.M.P, SPLIT.has(type));
    // springy parts that fork (three tails from one root) become one part per branch; a limb's
    // branches (toes, fingers, feathers) stay details
    if (SPLIT.has(type) && details.length) {
      const sub = components(new Set(details), creature.bones);
      const keep = sub.filter((p) => p.bones.length < 2).flatMap((p) => p.bones);
      limbs.push(newLimb(chain, keep, type, ctx.M, ctx.midX));
      sub.filter((p) => p.bones.length >= 2).forEach(build);
      return;
    }
    limbs.push(newLimb(chain, details, type, ctx.M, ctx.midX));
  };
  pieces.forEach(build);
  return { limbs, skipped, stray: stray.map((p) => p.root) };
}

/** Take bones out of every limb; a limb broken in two becomes two limbs of its type, an emptied one goes away. */
export function removeBones(creature, info, bones, ctx = context(creature, info)) {
  const out = [];
  for (const l of info.limbs) {
    const all = [...l.bones, ...l.detailBones];
    if (!all.some((b) => bones.has(b))) { out.push(l); continue; }
    const left = new Set(all.filter((b) => !bones.has(b)));
    components(left, creature.bones).forEach((piece, i) => {
      const { chain, details } = mainChain(piece, ctx.M.P);
      const nl = newLimb(chain, details, l.type, ctx.M, ctx.midX, l.sideManual ? l.side : null);
      if (i === 0) { nl.dyn = l.dyn; nl.customLabel = l.customLabel; nl.sideManual = l.sideManual; }
      out.push(nl);
    });
  }
  info.limbs = out;
}

// ------------------------------------------------------------------ saving

/** A short, stable key for a model: its name and its bone names. */
export function modelKey(creature) {
  const names = creature.bones.map((b) => b.name).sort().join('|');
  let h = 2166136261;
  for (let i = 0; i < names.length; i++) { h ^= names.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `procemotion.map.${creature.name}.${(h >>> 0).toString(36)}`;
}

/** The mapping by bone names (what the panel saves and exports). */
export function serialize(info) {
  return {
    tool: 'Procemotion', kind: 'bone-map', version: 1,
    head: info.head ? info.head.name : null, headManual: !!info.headManual,
    pelvis: info.pelvis ? info.pelvis.name : null, pelvisManual: !!info.pelvisManual,
    style: info.style, styleManual: !!info.styleManual,
    limbs: info.limbs.map((l) => ({
      type: l.type, side: l.side, sideManual: !!l.sideManual, label: l.customLabel || undefined,
      bones: l.bones.map((b) => b.name), details: l.detailBones.map((b) => b.name),
      dyn: l.dyn ? { ...l.dyn } : undefined,
    })),
  };
}

/** Rebuild the limbs from a saved mapping (bones the model no longer has are skipped). Returns false if unusable. */
export function applyMapping(creature, info, data) {
  if (!data || data.kind !== 'bone-map' || !Array.isArray(data.limbs)) return false;
  const byName = new Map(creature.bones.map((b) => [b.name, b]));
  const ctx = context(creature, info);
  const limbs = [];
  for (const s of data.limbs) {
    if (!TYPES[s.type]) continue;
    const named = (s.bones || []).map((n) => byName.get(n)).filter(Boolean);
    if (!named.length) continue;
    // bones inserted into the chain since it was saved (Smoother bends) join it
    const chain = [named[0]];
    for (let i = 1; i < named.length; i++) {
      const way = [];
      for (let p = named[i].parent; p && p !== named[i - 1] && way.length < 8; p = p.parent) way.unshift(p);
      if (named[i].parent && way.length < 8 && (way.length ? way[0].parent === named[i - 1] : named[i].parent === named[i - 1])) chain.push(...way);
      chain.push(named[i]);
    }
    const details = (s.details || []).map((n) => byName.get(n)).filter(Boolean);
    const l = newLimb(chain, details, s.type, ctx.M, ctx.midX, s.sideManual ? s.side : null);
    l.sideManual = !!s.sideManual;
    if (s.label) l.customLabel = s.label;
    if (s.dyn) l.dyn = { ...l.dyn, ...s.dyn };
    limbs.push(l);
  }
  info.limbs = limbs;
  if (data.headManual && byName.has(data.head)) { info.head = byName.get(data.head); info.headManual = true; }
  if (data.pelvisManual && byName.has(data.pelvis)) { info.pelvis = byName.get(data.pelvis); info.pelvisManual = true; }
  if (data.styleManual && data.style) { info.style = data.style; info.styleManual = true; }
  return true;
}

export function loadSaved(creature) {
  try {
    const key = modelKey(creature);
    let s = localStorage.getItem(key);
    // saved before the app was renamed (LimbForge -> Procemotion): move it over
    const old = key.replace(/^procemotion\./, 'limbforge.');
    if (!s && (s = localStorage.getItem(old))) { localStorage.setItem(key, s); localStorage.removeItem(old); }
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
export function save(creature, info) {
  try { localStorage.setItem(modelKey(creature), JSON.stringify(serialize(info))); return true; } catch { return false; }
}
export function forget(creature) {
  try { localStorage.removeItem(modelKey(creature)); } catch { /* storage unavailable */ }
}
