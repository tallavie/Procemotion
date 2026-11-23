// Procemotion — app wiring: viewport, model loading, rig editing, procedural preview, baking and export.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import '@fontsource-variable/inter';
import './styles.css';
import { loadModelFiles, modelStats } from './loaders.js';
import { Creature, poseBounds, makeSampler } from './skeleton.js';
import { detectLimbs, defaultFootSets, TYPES, TYPE_KEYS, fitLegIK, makeLimb, finishInfo } from './detect.js';
import * as Cls from './classify.js';
import { DEMOS, LICENSE } from './demos.js';
import { Motion, GAIT_PRESETS, defaultDynamics } from './motion.js';
import { Terrain } from './terrain.js';
import { ACTIONS, availableActions } from './actions.js';
import { bake, LOOPS, loopsFor } from './bake.js';
import { exportGLB, exportFBX, buildConfig, ueScript, download, saveToFolder } from './exporter.js';
import {
  makeChainBones, resample, centreFromSurface, mirrorPoints, mirrorName, nearestBone, skinChain, undoSkin,
  templateJoints, bindTemplate, TEMPLATE_NAMES, findUnrigged, mirrorPlane, mirrorAcross, subdivideChain,
} from './autorig.js';
import { computeCapsules, CapsuleView } from './collision.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------------------ viewport
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c1c1e);
scene.fog = new THREE.Fog(0x1c1c1e, 10, 40);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
camera.position.set(3, 2, 4);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;

scene.add(new THREE.HemisphereLight(0xf2f4ff, 0x3a3a40, 1.25));
const sun = new THREE.DirectionalLight(0xffffff, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

const mover = new THREE.Group(); mover.name = 'Mover';
const holder = new THREE.Group(); holder.name = 'Holder';
mover.add(holder);
scene.add(mover);
const terrain = new Terrain(scene);
terrain.build(1, 'course');

const helpers = new THREE.Group(); helpers.name = 'Helpers';
scene.add(helpers);
const tcontrols = new TransformControls(camera, canvas);
tcontrols.setSize(0.7);
tcontrols.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
scene.add(tcontrols.getHelper());

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const h = r.height - canvas.offsetTop;
  renderer.setSize(r.width, Math.max(50, h), false);
  canvas.style.height = `${Math.max(50, h)}px`;
  camera.aspect = r.width / Math.max(50, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

// ------------------------------------------------------------------ state
const S = {
  creature: null, info: null, motion: null, ref: null, bind: null, refKey: 'rest', facing: '+Z',
  footSets: [], mode: 'anim', ground: 'course', drive: 'course', selected: null, follow: true,
  added: [], undo: [], clips: [], playing: null, place: null, template: null, suggestions: [], bakeSel: new Set(['walk', 'run', 'idle']),
  weightsOn: false, savedMaterials: null,
};
const FACING_ROT = { '+Z': 0, '-Z': Math.PI, '+X': -Math.PI / 2, '-X': Math.PI / 2 };

// ------------------------------------------------------------------ skeleton overlay
const skel = (() => {
  const lineGeo = new THREE.BufferGeometry();
  const ptGeo = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
  const pts = new THREE.Points(ptGeo, new THREE.PointsMaterial({ vertexColors: true, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
  lines.renderOrder = pts.renderOrder = 10;
  lines.frustumCulled = pts.frustumCulled = false;
  helpers.add(lines, pts);
  let bones = [], pairs = [], colors = [];
  const v = new THREE.Vector3();
  return {
    group: [lines, pts],
    set(list, colorOf) {
      bones = list;
      const set = new Set(list);
      pairs = list.filter((b) => b.parent && set.has(b.parent)).map((b) => [b.parent, b]);
      colors = list.map((b) => new THREE.Color(colorOf(b)));
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pairs.length * 6), 3));
      const lc = new Float32Array(pairs.length * 6);
      pairs.forEach(([, c], i) => { const col = colors[list.indexOf(c)]; col.toArray(lc, i * 6); col.toArray(lc, i * 6 + 3); });
      lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
      ptGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(list.length * 3), 3));
      const pc = new Float32Array(list.length * 3);
      colors.forEach((c, i) => c.toArray(pc, i * 3));
      ptGeo.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
    },
    update() {
      const lp = lineGeo.attributes.position, pp = ptGeo.attributes.position;
      if (!lp || !pp) return;
      pairs.forEach(([a, b], i) => { v.setFromMatrixPosition(a.matrixWorld).toArray(lp.array, i * 6); v.setFromMatrixPosition(b.matrixWorld).toArray(lp.array, i * 6 + 3); });
      bones.forEach((b, i) => v.setFromMatrixPosition(b.matrixWorld).toArray(pp.array, i * 3));
      lp.needsUpdate = true; pp.needsUpdate = true;
    },
    bones: () => bones,
    visible(on) { lines.visible = pts.visible = on; },
  };
})();

// ------------------------------------------------------------------ collision volume view
const capView = new CapsuleView(scene);
function refreshCapsules() {
  const scale = S.motion ? S.motion.params.collision.scale : 1;
  capView.set(S.creature, S.info && S.info.capsules, scale);
  const n = S.info && S.info.capsules ? S.info.capsules.size : 0;
  const el = document.querySelector('#capInfo');
  if (el) el.textContent = n ? `${n} capsules detected from the mesh volume (blue in the viewport when “Collision” is on).` : 'No collision volume (the mesh has no skin weights).';
}

function visibleBones() {
  const cr = S.creature;
  if (!cr) return [];
  const W = cr.weighted;
  const keep = new Set();
  for (let i = cr.bones.length - 1; i >= 0; i--) {
    const b = cr.bones[i];
    if (!W.size || W.has(b) || b.children.some((c) => keep.has(c))) keep.add(b);
  }
  if (S.info) for (const l of S.info.limbs) l.bones.forEach((b) => keep.add(b));
  // unweighted bones above the first weighted one (e.g. "Origin" on the floor) only add a long, meaningless line
  const underWeighted = (b) => { for (let p = b.parent; p && p.isBone; p = p.parent) if (W.has(p)) return true; return false; };
  return cr.bones.filter((b) => keep.has(b) && !(W.size && !W.has(b) && !underWeighted(b)));
}

function refreshSkeleton() {
  const owner = new Map();
  if (S.info) {
    for (const l of S.info.limbs) {
      l.bones.forEach((b) => owner.set(b, l));
      l.detailBones.forEach((b) => owner.set(b, { type: 'detail', id: l.id }));
    }
  }
  skel.set(visibleBones(), (b) => {
    const l = owner.get(b);
    if (!l) return S.info && S.info.trunk.includes(b) ? '#e5e5ea' : '#8e8e93';
    const c = TYPES[l.type] ? TYPES[l.type].color : '#8e8e93';
    if (S.selected && l.id !== S.selected) return new THREE.Color(c).multiplyScalar(0.45).getStyle();
    return c;
  });
}

// ------------------------------------------------------------------ loading
async function openFiles(files) {
  if (!files.length) return;
  toast('Loading…');
  try {
    const { scene: model, animations, name } = await loadModelFiles(files);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    clearModel();
    holder.add(model);
    const cr = new Creature(model, animations, name);
    S.creature = cr;
    S.clips = [];
    S.added = []; S.undo = [];
    S.selected = null;
    const stats = modelStats(model);
    $('#modelHint').textContent = name;
    $('#modelInfo').innerHTML = `<b>${esc(name)}</b><br>${stats.meshes} mesh${stats.meshes === 1 ? '' : 'es'}, ${stats.tris.toLocaleString()} triangles, ${cr.bones.length} bones (${cr.weighted.size} move vertices), ${animations.length} clip${animations.length === 1 ? '' : 's'}`;
    fillRefPoses();
    $('#empty').hidden = true;
    if (!cr.hasBones || !cr.meshes.length) {
      S.info = null; S.motion = null;
      setMode('rig');
      startTemplateUI();
      toast(cr.hasBones ? 'This model has bones but no skinned mesh. Pick a body plan to rig it.' : 'No skeleton found. Pick a body plan and drag the joints into place.');
    } else {
      $('#noBones').hidden = true;
      analyse();
      toast(`${S.info.limbs.length} limbs found · ${describeBody()}`);
    }
    refreshAll();
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
  }
}

function clearModel() {
  stopPlacing(); stopTemplate(); clearSuggestions(); setWeights(false);
  for (const c of [...holder.children]) holder.remove(c);
  S.creature = null; S.info = null; S.motion = null; S.playing = null;
}

function fillRefPoses() {
  const cr = S.creature;
  const sel = $('#refPose');
  sel.innerHTML = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  add('rest', 'Loaded pose');
  if (cr.meshes.length) add('bind', 'Bind pose');
  cr.animations.forEach((c, i) => add(`clip:${i}`, `Clip: ${c.name}`));
  const idle = cr.idleClip();
  S.refKey = idle ? `clip:${cr.animations.indexOf(idle)}` : 'rest';
  sel.value = S.refKey;
}

function refSnapshot(key) {
  const cr = S.creature;
  if (key === 'bind') return cr.bindSnapshot();
  if (key.startsWith('clip:')) { const c = cr.animations[+key.slice(5)]; if (c) return cr.clipSnapshot(c, 0); }
  cr.restore();
  return cr.snapshot();
}

/** Place the model, read its limbs and (re)build the motion engine. */
function analyse({ keepLimbs = false, fresh = false } = {}) {
  const cr = S.creature;
  mover.position.set(0, 0, 0); mover.rotation.set(0, 0, 0);
  holder.rotation.set(0, FACING_ROT[S.facing], 0);
  holder.position.set(0, 0, 0);
  scene.updateMatrixWorld(true);
  S.ref = refSnapshot(S.refKey);
  cr.applySnapshot(S.ref); cr.update();
  const box = poseBounds(cr, mover);
  const c = box.getCenter(new THREE.Vector3());
  holder.position.set(-c.x, -box.min.y, -c.z);
  cr.update();
  const old = S.info;
  S.info = detectLimbs(cr, { forward: S.facing });
  if (keepLimbs && old) {
    // carry over the user's type choices and spring settings by first bone
    for (const l of S.info.limbs) {
      const o = old.limbs.find((x) => x.bones[0] === l.bones[0]);
      if (o) { if (o.type !== l.type) retype(l, o.type); l.dyn = o.dyn; }
    }
    for (const o of old.limbs) if (!o.auto && !S.info.limbs.some((l) => l.bones[0] === o.bones[0])) S.info.limbs.push(o);
    S.info.style = old.style;
  }
  // classes the user set by hand for this model (right panel) replace the detected ones
  S.info.fromSaved = false;
  if (!fresh) {
    const saved = Cls.loadSaved(cr);
    if (saved && Cls.applyMapping(cr, S.info, saved)) { finishInfo(cr, S.info); S.info.fromSaved = true; }
  }
  S.footSets = defaultFootSets(S.info);
  S.bind = cr.bindSnapshot();
  S.info.capsules = computeCapsules(cr, S.bind);
  cr.applySnapshot(S.ref); cr.update();
  if (!S.motion) S.motion = new Motion({ creature: cr, holder, mover, terrain });
  S.motion.creature = cr;
  S.motion.mode = S.drive;
  S.motion.setup(S.info, S.ref, S.footSets);
  refreshCapsules();
  // walking creatures need the standing pose as the reference pose in UE (Locomotor); others keep their own
  $('#rebindRef').checked = S.motion.legs.length > 0;
  terrain.build(S.info.H, S.ground);
  if (S.mode === 'rig') terrain.group.children.forEach((c) => { c.visible = c.name === 'Floor'; });
  S.motion.reset();
  fitCamera();
  if (S.mode === 'rig') enterRigPose();
  refreshSkeleton();
}

function describeBody() {
  const L = S.info.limbs;
  const n = (t) => L.filter((l) => l.type === t).length;
  const parts = [];
  if (n('leg')) parts.push(`${n('leg')} leg${n('leg') > 1 ? 's' : ''}`);
  for (const t of ['arm', 'wing', 'tail', 'ear', 'tentacle', 'appendage']) if (n(t)) parts.push(`${n(t)} ${TYPES[t].label.toLowerCase()}${n(t) > 1 && !t.endsWith('l') ? 's' : n(t) > 1 ? 's' : ''}`);
  return parts.join(', ') || 'no limbs';
}

function retype(limb, type) {
  limb.type = type;
  if (type === 'wingFolded') { limb.showIn = 'ground'; limb.hideBone = limb.bones[0].name; }
  else if (limb.showIn === 'ground') { limb.showIn = undefined; limb.hideBone = undefined; }
  if (type === 'leg' && limb.fit) fitLegIK(limb, limb.fit.pts, limb.fit.ground, limb.fit.H);
  else if (type === 'leg') { limb.effector = limb.bones.length - 1; limb.ikStart = Math.max(0, limb.effector - 2); }
  else { limb.effector = limb.bones.length - 1; limb.ikStart = 0; }
  limb.dyn = defaultDynamics(type);
}

function rebuildMotion({ resetSets = false } = {}) {
  if (!S.motion || !S.info) return;
  if (resetSets) S.footSets = defaultFootSets(S.info);
  S.motion.setup(S.info, S.ref, S.footSets);
  if (S.mode === 'rig') enterRigPose();
  refreshSkeleton();
}

function fitCamera() {
  const H = S.info ? S.info.H : 1;
  // frame by the creature's size: its height, or most of its length when it lies low (a snake)
  const D = S.info ? Math.max(H, 0.6 * (S.info.reach || H)) : 1;
  camera.near = D * 0.01; camera.far = D * 300; camera.updateProjectionMatrix();
  scene.fog.near = D * 9; scene.fog.far = D * 34;
  const t = mover.position.clone().add(new THREE.Vector3(0, H * 0.5, 0));
  orbit.target.copy(t);
  camera.position.copy(t).add(new THREE.Vector3(D * 1.9, D * 0.9, D * 2.6));
  sun.shadow.camera.left = sun.shadow.camera.bottom = -H * 3;
  sun.shadow.camera.right = sun.shadow.camera.top = H * 3;
  sun.shadow.camera.near = H * 0.1; sun.shadow.camera.far = H * 20;
  sun.shadow.camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ modes
function setMode(mode) {
  if (mode === 'anim' && !S.motion) return;
  S.mode = mode;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  // obstacles only matter while animating; in the Rig view they would hide parts of the model
  terrain.group.children.forEach((c) => { c.visible = mode === 'anim' || c.name === 'Floor'; });
  if (mode === 'rig') { S.playing = null; enterRigPose(); }
  else { stopPlacing(); stopTemplate(); clearSuggestions(); if (S.motion) S.motion.reset(); }
  updateHint();
  refreshAll();
}

/** Rig view shows the reference pose (natural to work on); edits are converted to the bind pose internally. */
function enterRigPose() {
  if (!S.creature) return;
  mover.position.set(0, 0, 0); mover.rotation.set(0, 0, 0);
  scene.updateMatrixWorld(true);
  if (S.ref) S.creature.applySnapshot(S.ref);
  S.creature.update();
  const H = S.info ? S.info.H : 1;
  orbit.target.set(0, H * 0.5, 0);
}

function updateHint() {
  let h = '';
  const armed = CLS.armed;
  if (armed === 'head' || armed === 'pelvis') h = `Click the ${armed === 'head' ? 'head' : 'pelvis (the joint the legs hang from)'} joint. Esc = cancel.`;
  else if (armed) {
    const how = CLS.pick === 'single' ? 'Click a joint' : 'Drag a box over joints (or click one)';
    if (armed === 'remove') h = `${how} to take them out of their part. Right-drag turns the view. Esc = done.`;
    else if (armed === 'add') {
      const t = S.info && S.selected && S.info.limbs.find((l) => l.id === S.selected);
      h = `${how} to add to ${t ? t.label : 'the part they join onto (or pick one in the list)'}. Right-drag turns the view. Esc = done.`;
    } else h = `${how} of a ${TYPES[armed].label.toLowerCase()}. Shift = add to the selected part, Alt = take out. Right-drag turns the view. Esc = done.`;
  }
  else if (S.place) h = 'Click the base of the part, then along it to the tip. Drag a white dot to adjust. Enter = create, Esc = cancel.';
  else if (S.template) h = 'Click a joint and drag the arrows to fit it inside the body. Then press “Bind skeleton”.';
  else if (S.mode === 'rig') h = 'Rig view (reference pose). Click a joint to see which limb it belongs to.';
  else if (S.drive === 'drive') h = 'W A S D or arrows to move · Shift to run';
  $('#viewHint').textContent = h;
}

// ------------------------------------------------------------------ UI: limbs
function refreshLimbs() {
  const list = $('#limbList');
  list.innerHTML = '';
  const limbs = S.info ? S.info.limbs : [];
  $('#limbCount').textContent = limbs.length;
  for (const l of limbs) {
    const row = document.createElement('div');
    row.className = 'item' + (S.selected === l.id ? ' on' : '');
    row.innerHTML = `<span class="dot" style="background:${TYPES[l.type].color}"></span><span class="name">${esc(l.label)}<small>${l.bones.length} bone${l.bones.length > 1 ? 's' : ''}${l.auto ? '' : ' · added'}</small></span>`;
    const sel = document.createElement('select');
    for (const k of TYPE_KEYS) { const o = document.createElement('option'); o.value = k; o.textContent = TYPES[k].label; sel.appendChild(o); }
    sel.value = l.type;
    sel.title = 'Limb type';
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      const wasLegs = S.info.limbs.filter((x) => x.type === 'leg').length;
      retype(l, sel.value);
      const legs = S.info.limbs.filter((x) => x.type === 'leg').length;
      if (legs && !wasLegs) S.info.style = 'walk';
      if (!legs && S.info.style === 'walk') S.info.style = 'hover';
      rebuildMotion({ resetSets: true });
      Cls.save(S.creature, S.info); S.info.fromSaved = true;
      refreshAll();
    });
    row.appendChild(sel);
    row.addEventListener('click', () => { S.selected = S.selected === l.id ? null : l.id; refreshLimbs(); refreshSkeleton(); if (S.weightsOn) setWeights(true); syncDynSelect(l); });
    row.title = l.bones.map((b) => b.name).join(' › ');
    list.appendChild(row);
  }
  const st = S.info ? S.info.style : 'walk';
  $$('#styleSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.s === st); b.disabled = b.dataset.s === 'walk' && !(S.info && S.info.limbs.some((x) => x.type === 'leg')); });
  $('#styleRow').hidden = !S.info;
}

$('#styleSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.info || b.disabled) return;
  S.info.style = b.dataset.s;
  S.info.styleManual = true;
  rebuildMotion();
  Cls.save(S.creature, S.info); S.info.fromSaved = true;
  refreshAll();
});

// ------------------------------------------------------------------ UI: parameter sliders
const DEG = /lean|bank|tilt|flapAmp|dihedral|flight_sweep|flight_twist|pelvis_flex|pelvis_rock/;
function fmt(id, v) {
  if (typeof v === 'boolean') return '';
  const s = Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(2);
  return DEG.test(id) ? `${s}°` : s;
}
function bindParams() {
  for (const el of $$('[id^="p_"]')) {
    const [, group, key] = el.id.split('_');
    const out = el.nextElementSibling && el.nextElementSibling.tagName === 'OUTPUT' ? el.nextElementSibling : null;
    el.addEventListener('input', () => {
      if (!S.motion) return;
      const P = S.motion.params[group];
      P[key] = el.type === 'checkbox' ? el.checked : +el.value;
      if (out) out.textContent = fmt(el.id, P[key]);
      if (key === 'on' && group === 'flight') refreshAll();
      if (group === 'collision' && key === 'scale') refreshCapsules();
    });
  }
}
function syncParams() {
  if (!S.motion) return;
  for (const el of $$('[id^="p_"]')) {
    const [, group, key] = el.id.split('_');
    const v = S.motion.params[group] && S.motion.params[group][key];
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    const out = el.nextElementSibling && el.nextElementSibling.tagName === 'OUTPUT' ? el.nextElementSibling : null;
    if (out) out.textContent = fmt(el.id, v);
  }
  $$('#flyMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === S.motion.params.flight.mode));
  $$('#earFly button').forEach((b) => b.classList.toggle('on', b.dataset.e === S.motion.params.flight.ears));
  $$('#runStyle button').forEach((b) => b.classList.toggle('on', b.dataset.r === S.motion.params.movement.runStyle));
}
$('#modelFormat').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('#modelFormat button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#runStyle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.motion) return;
  S.motion.params.movement.runStyle = b.dataset.r;
  syncParams();
});
$('#earFly').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.motion) return;
  S.motion.params.flight.ears = b.dataset.e;
  syncParams();
  refreshAll();
});
bindParams();
$('#flyMode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.motion) return;
  S.motion.params.flight.mode = b.dataset.m;
  syncParams();
});

// gait presets and foot sets
function refreshGait() {
  const box = $('#footSets');
  box.innerHTML = '';
  const m = S.motion;
  const chips = $('#gaitChips');
  chips.innerHTML = '';
  if (!m || !m.legs.length) return;
  for (const [k, g] of Object.entries(GAIT_PRESETS)) {
    const offs = g.offsets(S.footSets.length);
    if (!offs) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = g.label;
    b.addEventListener('click', () => {
      S.footSets.forEach((s, i) => { s.offset = offs[i] ?? s.offset; });
      m.params.stepping.air = g.air;
      m.applyFootSets(S.footSets);
      syncParams(); refreshGait();
    });
    chips.appendChild(b);
  }
  S.footSets.forEach((set, i) => {
    const d = document.createElement('div');
    d.className = 'footset';
    const names = set.feet.map((id) => S.info.limbs.find((l) => l.id === id)).filter(Boolean).map((l) => `<i>${esc(l.label)}</i>`).join('');
    d.innerHTML = `<div class="feet">${names}</div><div class="row"><span>Set ${i + 1} timing</span><input type="range" min="0" max="1" step="0.01" value="${set.offset}"><output>${set.offset.toFixed(2)}</output></div>`;
    const r = d.querySelector('input'), o = d.querySelector('output');
    r.addEventListener('input', () => { set.offset = +r.value; o.textContent = set.offset.toFixed(2); m.applyFootSets(S.footSets); });
    box.appendChild(d);
  });
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = S.footSets.length > 1 ? 'Feet in a set take turns; the timing shifts a whole set against the others.' : 'These feet take turns.';
  box.appendChild(note);
}

// ------------------------------------------------------------------ UI: springs
const DYN_TYPES = ['ear', 'tail', 'tentacle', 'appendage', 'wing'];
function refreshDyn() {
  const sel = $('#dynLimb');
  const limbs = S.info ? S.info.limbs.filter((l) => DYN_TYPES.includes(l.type)) : [];
  const cur = sel.value;
  sel.innerHTML = '';
  for (const l of limbs) { const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.label} (${TYPES[l.type].label})`; sel.appendChild(o); }
  if (limbs.some((l) => String(l.id) === cur)) sel.value = cur;
  $('#dynBox').hidden = !limbs.length;
  $('#dynEmpty').hidden = !!limbs.length;
  syncDyn();
}
function dynLimb() { return S.info && S.info.limbs.find((l) => String(l.id) === $('#dynLimb').value); }
function syncDynSelect(l) { if (DYN_TYPES.includes(l.type)) { $('#dynLimb').value = l.id; syncDyn(); } }
function syncDyn() {
  const l = dynLimb();
  if (!l) return;
  if (!l.dyn) l.dyn = defaultDynamics(l.type);
  for (const el of $$('[id^="d_"]')) {
    const key = el.id.slice(2);
    if (el.classList.contains('seg')) { el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.a === l.dyn[key])); continue; }
    if (el.type === 'checkbox') el.checked = !!l.dyn[key];
    else { el.value = l.dyn[key]; const o = el.nextElementSibling; if (o && o.tagName === 'OUTPUT') o.textContent = (+l.dyn[key]).toFixed(2); }
  }
}
for (const el of $$('[id^="d_"]')) {
  const key = el.id.slice(2);
  if (el.classList.contains('seg')) {
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); const l = dynLimb(); if (!b || !l) return; l.dyn[key] = b.dataset.a; syncDyn(); });
    continue;
  }
  el.addEventListener('input', () => {
    const l = dynLimb(); if (!l) return;
    l.dyn[key] = el.type === 'checkbox' ? el.checked : +el.value;
    const o = el.nextElementSibling; if (o && o.tagName === 'OUTPUT') o.textContent = (+el.value).toFixed(2);
  });
}
$('#dynLimb').addEventListener('change', () => { syncDyn(); const l = dynLimb(); if (l) { S.selected = l.id; refreshLimbs(); refreshSkeleton(); } });
$('#dynAll').addEventListener('click', () => {
  const l = dynLimb(); if (!l) return;
  for (const x of S.info.limbs) if (x.type === l.type && x !== l) x.dyn = { ...l.dyn };
  toast(`Applied to every ${TYPES[l.type].label.toLowerCase()}`);
});

// ------------------------------------------------------------------ UI: actions
function refreshActions() {
  const box = $('#actionGroups');
  box.innerHTML = '';
  if (!S.info) return;
  const groups = {};
  for (const [k, a] of availableActions(S.info)) (groups[a.group] = groups[a.group] || []).push([k, a]);
  for (const [g, list] of Object.entries(groups)) {
    const d = document.createElement('div');
    d.className = 'actgroup';
    d.innerHTML = `<span>${g}</span>`;
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const [k, a] of list) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = a.label;
      b.addEventListener('click', () => playAction(k));
      chips.appendChild(b);
    }
    d.appendChild(chips);
    box.appendChild(d);
  }
}
function actionParams() {
  const side = $('#a_side .on').dataset.v;
  return { intensity: +$('#a_intensity').value, speed: +$('#a_speed').value, side: side === 'front' ? 'L' : side, from: side === 'L' ? 'left' : side === 'R' ? 'right' : 'front' };
}
function playAction(key) {
  if (!S.motion) return;
  if (S.mode !== 'anim') setMode('anim');
  S.playing = null;
  S.motion.play(ACTIONS[key], actionParams());
}
for (const id of ['a_intensity', 'a_speed']) $(`#${id}`).addEventListener('input', (e) => { e.target.nextElementSibling.textContent = (+e.target.value).toFixed(2); });
$('#a_side').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('#a_side button').forEach((x) => x.classList.toggle('on', x === b)); });
$('#stopAction').addEventListener('click', () => { if (S.motion) S.motion.stopAction(); S.playing = null; });

// ------------------------------------------------------------------ UI: bake + clips
function refreshBake() {
  const box = $('#bakeChips');
  box.innerHTML = '';
  if (!S.motion) return;
  const jobs = [...loopsFor(S.motion).map((k) => [k, LOOPS[k].label, 'loop']), ...availableActions(S.info).map(([k, a]) => [`a:${k}`, a.label, 'once'])];
  for (const [k, label, kind] of jobs) {
    const b = document.createElement('button');
    b.className = 'chip' + (S.bakeSel.has(k) ? ' on' : '');
    b.innerHTML = `${esc(label)}<small>${kind === 'loop' ? 'loop' : 'one shot'}</small>`;
    b.addEventListener('click', () => { S.bakeSel.has(k) ? S.bakeSel.delete(k) : S.bakeSel.add(k); refreshBake(); });
    box.appendChild(b);
  }
  $('#bakeBtn').disabled = !S.bakeSel.size;
}
$('#bakeBtn').addEventListener('click', async () => {
  if (!S.motion) return;
  const jobs = [...S.bakeSel].filter((k) => k.startsWith('a:') ? ACTIONS[k.slice(2)] : loopsFor(S.motion).includes(k));
  const wasRig = S.mode === 'rig';
  if (wasRig) setMode('anim');
  for (let i = 0; i < jobs.length; i++) {
    const k = jobs[i];
    toast(`Baking ${i + 1} / ${jobs.length}…`);
    await new Promise((r) => setTimeout(r, 30));
    const clip = k.startsWith('a:') ? bake(S.motion, { action: ACTIONS[k.slice(2)], params: actionParams() }) : bake(S.motion, { loop: k });
    S.clips = S.clips.filter((c) => c.name !== clip.name);
    S.clips.push(clip);
  }
  if (wasRig) setMode('rig');
  toast(`${jobs.length} clip${jobs.length > 1 ? 's' : ''} baked`);
  refreshClips();
});

function refreshClips() {
  const list = $('#clipList');
  list.innerHTML = '';
  $('#bakedCount').textContent = S.clips.length;
  const all = [...S.clips.map((c) => [c, 'LF']), ...(S.creature ? S.creature.animations.map((c) => [c, 'model']) : [])];
  for (const [clip, tag] of all) {
    const row = document.createElement('div');
    const on = S.playing && S.playing.clip === clip;
    row.className = 'item' + (on ? ' on' : '');
    row.innerHTML = `<span class="tag">${tag}</span><span class="name">${esc(clip.name)}<small>${clip.duration.toFixed(2)} s</small></span><button class="play">${on ? 'Stop' : 'Play'}</button>`;
    row.querySelector('.play').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(clip); });
    if (tag === 'LF') {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = 'Remove';
      x.addEventListener('click', (e) => { e.stopPropagation(); S.clips = S.clips.filter((c) => c !== clip); if (on) S.playing = null; refreshClips(); });
      row.appendChild(x);
    }
    list.appendChild(row);
  }
}
function togglePlay(clip) {
  if (S.playing && S.playing.clip === clip) { S.playing = null; if (S.motion) S.motion.reset(); }
  else {
    if (S.mode !== 'anim' && S.motion) setMode('anim');
    S.playing = { clip, sampler: makeSampler(S.creature.root, clip, S.creature), t: 0 };
  }
  refreshClips();
}

// ------------------------------------------------------------------ UI: export
function cmPerUnit() { return 100 * Math.max(1e-6, +$('#ueScale').value || 1); }
function refreshExport() {
  const ok = !!(S.creature && S.creature.meshes.length);
  for (const id of ['#exportAll', '#exportFolder', '#exportTop']) $(id).disabled = !ok;
  $('#exportFolder').hidden = !window.showDirectoryPicker;
  $('#ueSize').textContent = S.info ? `In Unreal the creature will be about ${(S.info.H * cmPerUnit()).toFixed(0)} cm tall (glTF is in metres; UE uses cm). Change the scale if you import with a different one.` : '—';
}
$('#ueScale').addEventListener('input', refreshExport);
async function exportFiles() {
  const cr = S.creature;
  const clips = [...($('#incOriginal').checked ? cr.animations : []), ...S.clips];
  toast('Exporting…');
  try {
    if (S.motion) S.motion.paused = true;
    const fmt = ($('#modelFormat .on') || { dataset: { f: 'glb' } }).dataset.f;
    const ref = $('#rebindRef').checked ? S.ref : null;
    const base = (cr.name || 'creature').replace(/[^\w-]+/g, '_');
    const files = [];
    if (fmt !== 'fbx') files.push([`${base}.glb`, await exportGLB(cr, clips, ref)]);
    if (fmt !== 'glb') files.push([`${base}.fbx`, (await exportFBX(cr, clips, ref, cmPerUnit())).blob]);
    if (S.info && S.motion) {
      const cfg = buildConfig({ creature: cr, info: S.info, motion: S.motion, footSets: S.footSets, clips: S.clips, scale: cmPerUnit(), addedChains: S.added });
      cfg.model = base;
      files.push([`${base}.procemotion.json`, JSON.stringify(cfg, null, 2)]);
      files.push([`${base}_Procemotion_UE.py`, ueScript(cfg)]);
    }
    return files;
  } finally { if (S.motion) S.motion.paused = $('#pauseBtn').dataset.paused === '1'; }
}
async function exportDownload() {
  try {
    const files = await exportFiles();
    for (const [name, data] of files) download(data, name);
    toast(`Saved ${files.map((f) => f[0]).join(', ')}`);
    morphWarning();
  } catch (err) { console.error(err); toast('Export failed: ' + (err.message || err), true); }
}
/** The export re-binds the mesh in the reference pose; shape keys (morph targets) are not carried over yet. */
function morphWarning() {
  const n = S.creature ? S.creature.meshes.reduce((a, m) => a + ((m.morphTargetInfluences || []).length), 0) : 0;
  if (n) setTimeout(() => toast(`Note: this model has ${n} morph targets (shape keys). They are not included in the export.`, true), 2900);
}
$('#exportAll').addEventListener('click', exportDownload);
$('#exportTop').addEventListener('click', () => { $('#secExport').open = true; $('#secExport').scrollIntoView({ behavior: 'smooth' }); exportDownload(); });
$('#exportFolder').addEventListener('click', async () => {
  try {
    const files = await exportFiles();
    if (await saveToFolder(files)) { toast(`Saved ${files.length} files to the folder`); morphWarning(); }
  } catch (err) { console.error(err); toast('Export failed: ' + (err.message || err), true); }
});

// ------------------------------------------------------------------ rig: adding bone chains
const preview = new THREE.Group();
helpers.add(preview);
const handleGeo = new THREE.SphereGeometry(1, 12, 8);
const handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 });
const lineMat = new THREE.LineBasicMaterial({ color: 0xffd60a, depthTest: false, transparent: true });

function startPlacing() {
  if (!S.creature || !S.info) return;
  if (S.mode !== 'rig') setMode('rig');
  stopTemplate(); clearSuggestions();
  S.place = { raw: [], pts: [], handles: [] };
  $('#placePanel').hidden = false;
  $('#placeDone').disabled = true;
  $('#placeMsg').textContent = 'Click the base of the part, then along it to its tip.';
  updateHint();
}
function stopPlacing() {
  S.place = null;
  tcontrols.detach();
  clearGroup(preview);
  $('#placePanel').hidden = true;
  updateHint();
}
function placePoints() {
  const P = S.place;
  if (!P) return;
  const n = +$('#addCount').value;
  P.pts = P.raw.length >= 2 ? resample(P.raw, n) : P.raw.map((p) => p.clone());
  drawPlacePreview();
  $('#placeDone').disabled = P.raw.length < 2;
  $('#placeMsg').textContent = P.raw.length < 2 ? 'Now click further along the part, ending at its tip.' : `${n} bone${n > 1 ? 's' : ''} along ${P.raw.length} clicks. Click more to extend, drag a dot to adjust, then create.`;
}
function drawPlacePreview() {
  clearGroup(preview);
  const P = S.place;
  if (!P) return;
  const H = S.info.H;
  P.handles = P.pts.map((p, i) => {
    const m = new THREE.Mesh(handleGeo, handleMat);
    m.scale.setScalar(H * (i === 0 ? 0.016 : 0.012));
    m.position.copy(p);
    m.renderOrder = 12;
    m.userData.index = i;
    preview.add(m);
    return m;
  });
  if (P.pts.length >= 2) {
    const g = new THREE.BufferGeometry().setFromPoints(P.pts);
    const l = new THREE.Line(g, lineMat); l.renderOrder = 11;
    preview.add(l);
  }
  if ($('#addMirror').checked && P.pts.length >= 2) {
    const m = mirrorPoints(P.pts, S.creature.root, S.info.frame.l, midOffset());
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(m), new THREE.LineDashedMaterial({ color: 0xffd60a, dashSize: H * 0.02, gapSize: H * 0.015, depthTest: false, transparent: true, opacity: 0.6 }));
    l.computeLineDistances(); l.renderOrder = 11;
    preview.add(l);
  }
}
function midOffset() {
  const box = S.info.box;
  const c = box.getCenter(new THREE.Vector3());
  return c.dot(S.info.frame.l);
}
tcontrols.addEventListener('objectChange', () => {
  const o = tcontrols.object;
  if (!o) return;
  if (S.place && o.userData.index !== undefined) {
    S.place.pts[o.userData.index].copy(o.position);
    const keep = S.place.pts;
    drawPlacePreview();
    S.place.pts = keep;
    tcontrols.attach(S.place.handles[o.userData.index]);
  } else if (S.template && o.userData.joint !== undefined) {
    S.template.joints[o.userData.joint].world.copy(o.position);
    drawTemplate(o.userData.joint);
  }
});

function sideOf(point) {
  const inv = new THREE.Matrix4().copy(S.creature.root.matrixWorld).invert();
  const x = point.clone().applyMatrix4(inv).dot(S.info.frame.l) - midOffset();
  return x > 0.04 * S.info.H ? 'L' : x < -0.04 * S.info.H ? 'R' : 'C';
}
function uniquePrefix(base) {
  const cr = S.creature;
  let p = base, i = 2;
  while (cr.byName.has(`${p}1`)) p = `${base}${i++}_`;
  return p;
}

/** Map points that ride on `bone` from the current pose into the bind pose (and back with `inverse`). */
function poseToBindMatrix(bone) {
  const cr = S.creature;
  const ref = bone || cr.root;
  cr.applySnapshot(S.ref); cr.update();
  const Pp = ref.matrixWorld.clone();
  cr.applySnapshot(S.bind); cr.update();
  const Pb = ref.matrixWorld.clone();
  return Pb.multiply(Pp.invert());
}

/** Build, skin and register one chain (+ its mirror). `points` are in the reference (Rig view) pose. */
function addChain(points, type, { mirror = true, parentName = '', falloff = 0.6 } = {}) {
  const cr = S.creature;
  enterRigPose();
  const parent = (parentName && cr.byName.get(parentName)) || nearestBone(cr, points[0]);
  const side = sideOf(points[0]);
  // into the bind pose, carried by the parent bone; the rest of the work happens there
  const toBind = poseToBindMatrix(parent);
  points = points.map((p) => p.clone().applyMatrix4(toBind));
  const cap = type.charAt(0).toUpperCase() + type.slice(1);
  const rec = { undos: [], roots: [], limbIds: [] };
  const make = (pts, par, s) => {
    const prefix = uniquePrefix(`${s === 'C' ? '' : s}${cap}_LF`);
    const chain = makeChainBones(pts, par, prefix);
    rec.undos.push(skinChain(cr, chain, { falloff }));
    rec.roots.push(chain[0]);
    const limb = makeLimb({ chain: chain.slice(0, -1), detailBones: [chain[chain.length - 1]], parentBone: par, type, side: s, label: `${s === 'L' ? 'Left ' : s === 'R' ? 'Right ' : ''}${TYPES[type].label.toLowerCase()} (added)` });
    limb.label = limb.label.charAt(0).toUpperCase() + limb.label.slice(1);
    limb.dyn = defaultDynamics(type);
    if (type === 'leg') { limb.effector = limb.bones.length - 1; limb.ikStart = Math.max(0, limb.effector - 2); }
    S.info.limbs.push(limb);
    rec.limbIds.push(limb.id);
    S.added.push({ type, parent: par ? par.name : null, bones: chain.map((b) => b.name), limbId: limb.id });
    return limb;
  };
  const plane = mirror && side !== 'C' ? mirrorPlane(cr) : null;
  make(points, parent, side);
  if (mirror && side !== 'C') {
    const mp = plane ? mirrorAcross(points, plane) : mirrorPoints(points, cr.root, S.info.frame.l, midOffset());
    const mparent = (parent && cr.byName.get(mirrorName(parent.name))) || nearestBone(cr, mp[0]);
    make(mp, mparent, side === 'L' ? 'R' : 'L');
  }
  S.undo.push(rec);
  // the new bones change the reference and bind poses, and get their own collision capsules
  S.ref = refSnapshot(S.refKey);
  S.bind = cr.bindSnapshot();
  S.info.capsules = computeCapsules(cr, S.bind);
  rebuildMotion({ resetSets: type === 'leg' });
  refreshCapsules();
  enterRigPose();
  refreshAll();
  toast(`Added ${rec.roots.length === 2 ? 'two' : 'a'} ${TYPES[type].label.toLowerCase()} chain${rec.roots.length === 2 ? 's' : ''} of ${points.length - 1} bones`);
}

$('#placeBtn').addEventListener('click', startPlacing);
$('#placeCancel').addEventListener('click', stopPlacing);
$('#placeDone').addEventListener('click', finishPlacing);
function finishPlacing() {
  const P = S.place;
  if (!P || P.pts.length < 2) return;
  const pts = P.pts.map((p) => p.clone());
  stopPlacing();
  addChain(pts, $('#addType').value, { mirror: $('#addMirror').checked, parentName: $('#addParent').value, falloff: +$('#addFalloff').value });
}
$('#addCount').addEventListener('input', () => { $('#addCountOut').textContent = $('#addCount').value; placePoints(); });
$('#addFalloff').addEventListener('input', () => { $('#addFalloffOut').textContent = $('#addFalloff').value; });
$('#addMirror').addEventListener('change', drawPlacePreview);
$('#undoAdd').addEventListener('click', () => {
  const rec = S.undo.pop();
  if (!rec) return;
  enterRigPose();
  for (let i = rec.undos.length - 1; i >= 0; i--) undoSkin(S.creature, rec.undos[i], [rec.roots[i]]);
  S.info.limbs = S.info.limbs.filter((l) => !rec.limbIds.includes(l.id));
  S.added = S.added.filter((a) => !rec.limbIds.includes(a.limbId));
  S.ref = refSnapshot(S.refKey);
  S.bind = S.creature.bindSnapshot();
  S.info.capsules = computeCapsules(S.creature, S.bind);
  rebuildMotion({ resetSets: true });
  refreshCapsules();
  enterRigPose();
  refreshAll();
  toast('Removed the last added bones');
});

function refreshAdd() {
  const has = !!(S.creature && S.info);
  $('#placeBtn').disabled = !has;
  $('#findBtn').disabled = !has;
  $('#undoAdd').disabled = !S.undo.length;
  $('#addedCount').textContent = S.added.length;
  const list = $('#addedList');
  list.innerHTML = '';
  for (const a of S.added) {
    const l = S.info && S.info.limbs.find((x) => x.id === a.limbId);
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<span class="dot" style="background:${TYPES[a.type].color}"></span><span class="name">${esc(l ? l.label : a.type)}<small>${a.bones.length - 1} bones on ${esc(a.parent || 'root')}</small></span>`;
    list.appendChild(row);
  }
  const sel = $('#addParent');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Nearest bone</option>';
  if (S.creature) for (const b of visibleBones()) { const o = document.createElement('option'); o.value = b.name; o.textContent = b.name; sel.appendChild(o); }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}

// ------------------------------------------------------------------ smoother bends: more bones along a chain
/** Bones from `from` down to `to` (parent -> child order), or null if `to` is not below `from`. */
function pathDown(from, to) {
  const p = [];
  for (let b = to; b; b = b.parent) { p.unshift(b); if (b === from) return p; }
  return null;
}
function subdivideTargets() {
  const out = [];
  if (!S.info) return out;
  const I = S.info;
  const tails = I.limbs.filter((l) => l.type === 'tail').sort((a, b) => b.bones.length - a.bones.length);
  const body = I.head && I.pelvis ? pathDown(I.pelvis, I.head) : null;
  if (body && body.length > 1) out.push({ key: 'body', label: 'Body (pelvis to head)', chains: () => [pathDown(S.info.pelvis, S.info.head)] });
  if (body && tails[0]) out.push({ key: 'whole', label: 'Whole body + longest tail', chains: () => [pathDown(S.info.pelvis, S.info.head), S.info.limbs.find((l) => l.id === tails[0].id).bones] });
  for (const l of I.limbs) {
    if (l.bones.length < 2 || ['leg', 'jaw', 'detail', 'ignore'].includes(l.type)) continue;
    out.push({ key: `limb:${l.id}`, label: `${l.label} (${l.bones.length} bones)`, chains: () => [S.info.limbs.find((x) => x.bones[0] === l.bones[0]).bones] });
  }
  return out;
}
function refreshSubdivide() {
  const sel = $('#subChain');
  const cur = sel.value;
  const list = subdivideTargets();
  sel.innerHTML = '';
  for (const t of list) { const o = document.createElement('option'); o.value = t.key; o.textContent = t.label; sel.appendChild(o); }
  if (list.some((t) => t.key === cur)) sel.value = cur;
  else if (S.info && S.info.style === 'slither' && list.some((t) => t.key === 'whole')) sel.value = 'whole';
  $('#subBtn').disabled = !list.length;
}
$('#subParts').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('#subParts button').forEach((x) => x.classList.toggle('on', x === b)); });
$('#subBtn').addEventListener('click', () => {
  const t = subdivideTargets().find((x) => x.key === $('#subChain').value);
  if (!t || !S.creature) return;
  const parts = +$('#subParts .on').dataset.n;
  const cr = S.creature;
  const wasMode = S.mode;
  cr.applySnapshot(S.bind); cr.update();
  let added = 0;
  for (const chain of t.chains()) if (chain && chain.length > 1) added += subdivideChain(cr, chain, parts).length;
  analyse({ keepLimbs: true });
  if (wasMode === 'rig') enterRigPose();
  refreshAll();
  toast(added ? `Added ${added} bones to ${t.label.replace(/ \(.*/, '').toLowerCase()}` : 'Nothing to split there (the joints sit on top of each other)');
});

// find unrigged parts
$('#findBtn').addEventListener('click', () => {
  if (!S.creature || !S.info) return;
  if (S.mode !== 'rig') setMode('rig');
  stopPlacing();
  const cr = S.creature;
  // search in the bind pose (where vertices and bones agree), then carry the results to the Rig view pose
  cr.applySnapshot(S.bind); cr.update();
  const found = findUnrigged(cr, S.info);
  for (const s of found) {
    const parent = nearestBone(cr, s.points[0]);
    const toPose = poseToBindMatrix(parent).invert();
    s.points = s.points.map((p) => p.clone().applyMatrix4(toPose));
  }
  enterRigPose();
  S.suggestions = found;
  const list = $('#suggestList');
  list.hidden = false;
  list.innerHTML = '';
  clearGroup(preview);
  if (!found.length) {
    list.innerHTML = '<div class="item"><span class="name">Every part of the surface already follows a bone.</span></div>';
    return;
  }
  found.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'item';
    const sel = document.createElement('select');
    for (const k of ['ear', 'tentacle', 'tail', 'appendage', 'wing', 'leg', 'arm']) { const o = document.createElement('option'); o.value = k; o.textContent = TYPES[k].label; sel.appendChild(o); }
    sel.value = s.guess;
    row.innerHTML = `<span class="dot" style="background:#ffd60a"></span><span class="name">Part ${i + 1}<small>${s.verts.length} vertices</small></span>`;
    row.appendChild(sel);
    const add = document.createElement('button');
    add.className = 'play'; add.textContent = 'Add';
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = Math.max(1, +$('#addCount').value);
      const pts = resample(s.points, n);
      clearSuggestions();
      addChain(pts, sel.value, { mirror: false, falloff: +$('#addFalloff').value });
    });
    row.appendChild(add);
    list.appendChild(row);
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(s.points), new THREE.LineBasicMaterial({ color: 0xffd60a, depthTest: false }));
    l.renderOrder = 11;
    preview.add(l);
  });
  toast(`${found.length} part${found.length > 1 ? 's' : ''} without bones found`);
});
function clearSuggestions() { S.suggestions = []; $('#suggestList').hidden = true; if (!S.place) clearGroup(preview); }

// ------------------------------------------------------------------ rig: templates for models without bones
function startTemplateUI() {
  $('#noBones').hidden = false;
  const chips = $('#templateChips');
  chips.innerHTML = '';
  for (const [k, label] of Object.entries(TEMPLATE_NAMES)) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = label;
    b.addEventListener('click', () => startTemplate(k));
    chips.appendChild(b);
  }
}
const tplGroup = new THREE.Group();
helpers.add(tplGroup);
function startTemplate(kind) {
  const cr = S.creature;
  holder.rotation.set(0, FACING_ROT[S.facing], 0);
  holder.position.set(0, 0, 0);
  scene.updateMatrixWorld(true);
  const box = poseBounds(cr, cr.root);
  // place on the ground first so the camera frames it
  const wbox = poseBounds(cr, mover);
  const c = wbox.getCenter(new THREE.Vector3());
  holder.position.set(-c.x, -wbox.min.y, -c.z);
  scene.updateMatrixWorld(true);
  const frame = { l: new THREE.Vector3(1, 0, 0), f: new THREE.Vector3(0, 0, 1) };
  if (S.facing === '-Z') { frame.l.set(-1, 0, 0); frame.f.set(0, 0, -1); }
  if (S.facing === '+X') { frame.l.set(0, 0, -1); frame.f.set(1, 0, 0); }
  if (S.facing === '-X') { frame.l.set(0, 0, 1); frame.f.set(-1, 0, 0); }
  const joints = templateJoints(kind, box, frame).map((j) => ({ ...j, world: j.pos.clone().applyMatrix4(cr.root.matrixWorld) }));
  S.template = { kind, joints };
  $$('#templateChips .chip').forEach((b) => b.classList.toggle('on', b.textContent === TEMPLATE_NAMES[kind]));
  $('#bindTemplate').disabled = false; $('#cancelTemplate').disabled = false;
  const H = wbox.max.y - wbox.min.y;
  S.info = null;
  fitCameraH(H);
  drawTemplate();
  updateHint();
}
function fitCameraH(H) {
  S._H = H;
  camera.near = H * 0.01; camera.far = H * 300; camera.updateProjectionMatrix();
  orbit.target.set(0, H * 0.5, 0);
  camera.position.set(H * 1.9, H * 0.9, H * 2.6);
  terrain.build(H, S.ground);
}
function drawTemplate(keepSel) {
  clearGroup(tplGroup);
  const T = S.template;
  if (!T) return;
  const H = S._H || 1;
  T.joints.forEach((j, i) => {
    const m = new THREE.Mesh(handleGeo, new THREE.MeshBasicMaterial({ color: /^L/.test(j.name) ? 0x30d158 : /^R/.test(j.name) ? 0xff9f0a : 0xffffff, depthTest: false, transparent: true }));
    m.scale.setScalar(H * 0.014);
    m.position.copy(j.world);
    m.userData.joint = i;
    m.renderOrder = 12;
    tplGroup.add(m);
    if (j.parent >= 0) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([T.joints[j.parent].world, j.world]), new THREE.LineBasicMaterial({ color: 0xd1d1d6, depthTest: false, transparent: true }));
      l.renderOrder = 11;
      tplGroup.add(l);
    }
  });
  if (keepSel !== undefined) { const h = tplGroup.children.find((c) => c.userData.joint === keepSel); if (h) tcontrols.attach(h); }
}
function stopTemplate() {
  if (!S.template) return;
  S.template = null;
  tcontrols.detach();
  clearGroup(tplGroup);
  $('#bindTemplate').disabled = true; $('#cancelTemplate').disabled = true;
  $$('#templateChips .chip').forEach((b) => b.classList.remove('on'));
  updateHint();
}
$('#cancelTemplate').addEventListener('click', stopTemplate);
$('#bindTemplate').addEventListener('click', () => {
  const T = S.template;
  if (!T) return;
  const cr = S.creature;
  const inv = new THREE.Matrix4().copy(cr.root.matrixWorld).invert();
  const joints = T.joints.map((j) => ({ name: j.name, parent: j.parent, pos: j.world.clone().applyMatrix4(inv) }));
  stopTemplate();
  toast('Binding…');
  setTimeout(() => {
    try {
      bindTemplate(cr, joints);
      $('#noBones').hidden = true;
      fillRefPoses();
      S.refKey = 'rest';
      $('#refPose').value = 'rest';
      analyse();
      setMode('anim');
      toast(`Skeleton bound · ${describeBody()}`);
    } catch (err) { console.error(err); toast('Binding failed: ' + err.message, true); }
    refreshAll();
  }, 30);
});

// ------------------------------------------------------------------ weights view
function setWeights(on) {
  const cr = S.creature;
  S.weightsOn = on && !!cr;
  $('#showWeights').checked = S.weightsOn;
  if (S.savedMaterials) {
    for (const [mesh, mat, col] of S.savedMaterials) {
      mesh.material = mat;
      if (col) mesh.geometry.setAttribute('color', col); else mesh.geometry.deleteAttribute('color');
    }
    S.savedMaterials = null;
  }
  if (!S.weightsOn) return;
  S.savedMaterials = [];
  const limb = S.selected && S.info && S.info.limbs.find((l) => l.id === S.selected);
  const pick = limb ? new Set([...limb.bones, ...limb.detailBones]) : null;
  const tmp = new THREE.Color();
  for (const mesh of cr.meshes) {
    const g = mesh.geometry;
    S.savedMaterials.push([mesh, mesh.material, g.attributes.color || null]);
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const col = new Float32Array(si.count * 3);
    const bones = mesh.skeleton.bones;
    for (let i = 0; i < si.count; i++) {
      if (pick) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (pick.has(bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
        tmp.setHSL(0.66 * (1 - w), 0.85, 0.22 + 0.35 * w);
      } else {
        let best = 0, bi = 0;
        for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > best) { best = sw.getComponent(i, k); bi = si.getComponent(i, k); }
        tmp.setHSL(((bi * 0.618034) % 1), 0.55, 0.5);
      }
      tmp.toArray(col, i * 3);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true });
  }
}
$('#showWeights').addEventListener('change', (e) => setWeights(e.target.checked));

// ------------------------------------------------------------------ pointer: picking, placing
const ray = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (CLS.armed) { downAt = null; return; } // the bone-class panel handles the click
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5 || tcontrols.dragging) { downAt = null; return; }
  downAt = null;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  // handles first
  const handles = S.place ? S.place.handles : S.template ? tplGroup.children.filter((c) => c.isMesh) : [];
  const hh = ray.intersectObjects(handles, false)[0];
  if (hh) { tcontrols.attach(hh.object); return; }
  if (S.template) { tcontrols.detach(); return; }
  if (S.place) {
    const hit = ray.intersectObjects(S.creature.meshes, false)[0];
    if (!hit) return;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : ray.ray.direction.clone().negate();
    if (n.dot(ray.ray.direction) > 0) n.negate();
    const p = centreFromSurface(S.creature.meshes, hit.point, n, S.info.H * 0.6);
    S.place.raw.push(p);
    tcontrols.detach();
    placePoints();
    return;
  }
  if (S.mode === 'rig' && S.info) {
    // nearest joint on screen
    let best = null, bd = 16;
    const v = new THREE.Vector3();
    for (const b of skel.bones()) {
      v.setFromMatrixPosition(b.matrixWorld).project(camera);
      const x = (v.x + 1) / 2 * r.width, y = (1 - v.y) / 2 * r.height;
      const d = Math.hypot(x - (e.clientX - r.left), y - (e.clientY - r.top));
      if (d < bd) { bd = d; best = b; }
    }
    if (best) {
      const l = S.info.limbs.find((x) => x.bones.includes(best) || x.detailBones.includes(best));
      S.selected = l ? l.id : null;
      toast(`${best.name}${l ? ' · ' + l.label : S.info.trunk.includes(best) ? ' · body' : ''}`);
      refreshLimbs(); refreshSkeleton();
      if (S.weightsOn) setWeights(true);
      if (l) syncDynSelect(l);
    }
  }
});

// keys
window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (S.place && k === 'enter') { finishPlacing(); e.preventDefault(); return; }
  if (k === 'escape') { if (CLS.armed) clsArm(null); else if (S.place) stopPlacing(); else tcontrols.detach(); return; }
  if (k === 'z' && (e.ctrlKey || e.metaKey) && !S.place && !$('#classPanel').hidden) { clsUndo(); e.preventDefault(); return; }
  if (S.place && (k === 'backspace' || (k === 'z' && (e.ctrlKey || e.metaKey)))) { S.place.raw.pop(); placePoints(); e.preventDefault(); return; }
  if (S.template && ['w', 'e', 'r'].includes(k) && tcontrols.object) return;
  if (S.motion) S.motion.keys.add(k === 'shift' ? 'shift' : k);
  if (k === ' ' && S.mode === 'anim') { togglePause(); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => { if (S.motion) S.motion.keys.delete(e.key.toLowerCase()); });
window.addEventListener('blur', () => { if (S.motion) S.motion.keys.clear(); });

// ------------------------------------------------------------------ toolbar + top bar
$('#modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) setMode(b.dataset.mode); });
$('#driveSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.drive = b.dataset.d;
  $$('#driveSeg button').forEach((x) => x.classList.toggle('on', x === b));
  if (S.motion) { S.motion.mode = S.drive; S.motion.reset(); }
  if (S.mode !== 'anim') setMode('anim');
  updateHint();
  canvas.focus();
});
$('#groundSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.ground = b.dataset.g;
  $$('#groundSeg button').forEach((x) => x.classList.toggle('on', x === b));
  terrain.build(S.info ? S.info.H : S._H || 1, S.ground);
  if (S.motion) S.motion.reset();
});
$('#showSkel').addEventListener('change', (e) => skel.visible(e.target.checked));
$('#showCollision').addEventListener('change', (e) => { capView.group.visible = e.target.checked; });
$('#follow').addEventListener('change', (e) => { S.follow = e.target.checked; });
function togglePause() {
  const b = $('#pauseBtn');
  const p = b.dataset.paused !== '1';
  b.dataset.paused = p ? '1' : '0';
  b.textContent = p ? 'Play' : 'Pause';
  if (S.motion) S.motion.paused = p;
}
$('#pauseBtn').addEventListener('click', togglePause);
$('#refPose').addEventListener('change', (e) => { S.refKey = e.target.value; if (S.info) { analyse({ keepLimbs: true }); refreshAll(); } });
$('#facingSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.facing = b.dataset.f;
  $$('#facingSeg button').forEach((x) => x.classList.toggle('on', x === b));
  if (S.info) { analyse(); refreshAll(); toast(`${S.info.limbs.length} limbs found · ${describeBody()}`); }
  else if (S.template) startTemplate(S.template.kind);
});
$('#redetect').addEventListener('click', () => { if (!S.creature || !S.info) return; analyse(); refreshAll(); toast(`${S.info.limbs.length} limbs found · ${describeBody()}`); });

const fileInput = $('#fileInput');
$('#openBtn').addEventListener('click', () => fileInput.click());
$('#openBtn2').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { openFiles([...fileInput.files]); fileInput.value = ''; });
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragging'); openFiles([...e.dataTransfer.files]); });

// ------------------------------------------------------------------ right panel: classify bones by hand
const CLS_TYPES = ['leg', 'arm', 'wing', 'wingFolded', 'tail', 'ear', 'tentacle', 'appendage', 'jaw'];
const CLS = { armed: null, drag: null, undo: [], pick: 'multi' };
const selBox = $('#selBox');

(function buildClsButtons() {
  const grid = $('#clsTypes');
  for (const t of [...CLS_TYPES, 'remove']) {
    const b = document.createElement('button');
    b.className = 'clsbtn';
    b.dataset.type = t;
    const color = t === 'remove' ? '#48484a' : TYPES[t].color;
    b.innerHTML = `<span class="dot" style="background:${color}"></span>${t === 'remove' ? 'Remove' : esc(TYPES[t].label)}`;
    b.title = t === 'remove' ? 'Take the joints you box out of their part' : `Box the joints of a ${TYPES[t].label.toLowerCase()}`;
    grid.appendChild(b);
  }
})();

function clsArm(kind) {
  CLS.armed = CLS.armed === kind ? null : kind;
  // while armed the left button draws the box; right / middle still turn and pan the view
  orbit.mouseButtons.LEFT = CLS.armed ? null : THREE.MOUSE.ROTATE;
  if (CLS.armed) { skel.visible(true); $('#showSkel').checked = true; canvas.style.cursor = 'crosshair'; }
  else canvas.style.cursor = '';
  refreshClassPanel();
  updateHint();
}
$('#clsTypes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && S.info) clsArm(b.dataset.type); });
$('#clsAdd').addEventListener('click', () => { if (S.info) clsArm('add'); });
$('#clsPick').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  CLS.pick = b.dataset.p;
  $$('#clsPick button').forEach((x) => x.classList.toggle('on', x === b));
  updateHint();
});

/** The part joints are added to: the one selected in the list, else the part they join onto (parent or child). */
function clsAddTarget(sel) {
  const limbs = S.info.limbs;
  const chosen = S.selected && limbs.find((l) => l.id === S.selected);
  if (chosen) return chosen;
  const votes = new Map();
  for (const b of sel) {
    const near = [b.parent, ...b.children].filter((x) => x && x.isBone);
    for (const l of limbs) if (near.some((x) => l.bones.includes(x) || l.detailBones.includes(x))) votes.set(l, (votes.get(l) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [l, v] of votes) if (v > n) { n = v; best = l; }
  return best;
}
$$('[data-pick]').forEach((b) => b.addEventListener('click', () => { if (S.info) clsArm(b.dataset.pick); }));

/** Joints whose screen position falls inside a rectangle (canvas pixels); hidden ones too. */
function bonesInRect(x0, y0, x1, y1) {
  const r = canvas.getBoundingClientRect();
  const v = new THREE.Vector3();
  const out = new Set();
  for (const b of skel.bones()) {
    v.setFromMatrixPosition(b.matrixWorld).project(camera);
    if (v.z > 1) continue;
    const x = (v.x + 1) / 2 * r.width, y = (1 - v.y) / 2 * r.height;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.add(b);
  }
  return out;
}
function boneAt(px, py, radius = 14) {
  const r = canvas.getBoundingClientRect();
  const v = new THREE.Vector3();
  let best = null, bd = radius;
  for (const b of skel.bones()) {
    v.setFromMatrixPosition(b.matrixWorld).project(camera);
    if (v.z > 1) continue;
    const d = Math.hypot((v.x + 1) / 2 * r.width - px, (1 - v.y) / 2 * r.height - py);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

/** Apply one change to the classes: undo point first, then refresh everything and save. */
function clsEdit(fn) {
  const cr = S.creature;
  CLS.undo.push(Cls.serialize(S.info));
  if (CLS.undo.length > 60) CLS.undo.shift();
  if (S.ref) cr.applySnapshot(S.ref);
  cr.update();
  const msg = fn();
  finishInfo(cr, S.info);
  S.footSets = defaultFootSets(S.info);
  rebuildMotion();
  Cls.save(cr, S.info);
  S.info.fromSaved = true;
  refreshAll();
  if (msg) toast(msg);
}

function clsApplySelection(sel, mods) {
  if (!sel.size) return;
  const cr = S.creature;
  const kind = CLS.armed;
  if (kind === 'head' || kind === 'pelvis') {
    const b = [...sel][0];
    clsEdit(() => {
      const ctx = Cls.context(cr, S.info);
      Cls.removeBones(cr, S.info, new Set([b]), ctx);
      S.info[kind] = b; S.info[kind + 'Manual'] = true;
      return `${kind === 'head' ? 'Head' : 'Pelvis'}: ${b.name}`;
    });
    clsArm(null);
    return;
  }
  if (kind === 'remove' || mods.alt) {
    clsEdit(() => { Cls.removeBones(cr, S.info, sel); return `${sel.size} joint${sel.size > 1 ? 's' : ''} taken out`; });
    return;
  }
  let addTo = null;
  if (kind === 'add') {
    addTo = clsAddTarget(sel);
    if (!addTo) { toast('Pick the part to add to in the list (or box joints next to an existing part)', true); return; }
    const all = [...addTo.bones, ...addTo.detailBones];
    if ([...sel].every((b) => all.includes(b))) { toast(`Already in ${addTo.label}`); return; }
  }
  clsEdit(() => {
    const ctx = Cls.context(cr, S.info);
    let type = kind, keep = null;
    const target = addTo || (mods.shift && S.selected ? S.info.limbs.find((l) => l.id === S.selected) : null);
    if (target) {
      // Shift / Add to existing class: grow that part (it keeps its type, name and springs)
      const had = new Set([...target.bones, ...target.detailBones]);
      had.forEach((b) => sel.add(b));
      // pieces of the same type that the added joints join up with come back in (a wing split by taking a joint
      // out of its middle is whole again when that joint is added back)
      for (let grew = true; grew;) {
        grew = false;
        for (const l of S.info.limbs) {
          if (l === target || l.type !== target.type) continue;
          const lb = [...l.bones, ...l.detailBones];
          if (lb.some((b) => sel.has(b))) continue;
          if (lb.some((b) => (b.parent && sel.has(b.parent)) || b.children.some((c) => sel.has(c)))) { lb.forEach((b) => sel.add(b)); grew = true; }
        }
      }
      type = target.type;
      keep = { dyn: target.dyn, customLabel: target.customLabel, sideManual: target.sideManual, side: target.side, had, label: target.label };
    }
    const { limbs, skipped, stray } = Cls.limbsFromSelection(cr, S.info, sel, type, ctx);
    // the joints that went into the new parts leave their old parts (strays and body joints stay where they were)
    const used = new Set(limbs.flatMap((l) => [...l.bones, ...l.detailBones]));
    if (target) [...target.bones, ...target.detailBones].forEach((b) => used.add(b));
    Cls.removeBones(cr, S.info, used, ctx);
    if (keep && limbs[0]) {
      // the piece holding the part's old joints carries its name and springs on
      const main = limbs.find((l) => [...l.bones, ...l.detailBones].some((b) => keep.had.has(b))) || limbs[0];
      main.dyn = keep.dyn; main.customLabel = keep.customLabel;
      if (keep.sideManual) { main.side = keep.side; main.sideManual = true; }
      limbs.splice(limbs.indexOf(main), 1); limbs.unshift(main);
    }
    S.info.limbs.push(...limbs);
    S.selected = limbs[0] ? limbs[0].id : null;
    let what = limbs.length ? `${limbs.length} ${TYPES[type].label.toLowerCase()}${limbs.length > 1 ? 's' : ''}` : 'nothing';
    if (target) {
      const added = limbs.flatMap((l) => [...l.bones, ...l.detailBones]).filter((b) => !keep.had.has(b)).length;
      if (!added) return `Nothing added: those joints are not joined to ${keep.label}`;
      what = `${added} joint${added === 1 ? '' : 's'} added to ${keep.label}${limbs.length > 1 ? ` (${limbs.length - 1} piece${limbs.length > 2 ? 's' : ''} not joined to it became a part of ${limbs.length > 2 ? 'their' : 'its'} own)` : ''}`;
      return what;
    }
    const notes = [];
    if (stray.length) notes.push(`${stray.length} stray joint${stray.length > 1 ? 's' : ''} in the box left as they were`);
    if (skipped.length) notes.push(`${skipped.length} body joint${skipped.length > 1 ? 's' : ''} skipped (set Head / Pelvis to change the body)`);
    return `Made ${what}${notes.length ? ' · ' + notes.join(' · ') : ''}`;
  });
}

canvas.addEventListener('pointerdown', (e) => {
  if (!CLS.armed || e.button !== 0 || S.mode !== 'rig') return;
  const r = canvas.getBoundingClientRect();
  CLS.drag = { x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, shift: e.shiftKey, alt: e.altKey };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  const d = CLS.drag;
  if (!d) return;
  const r = canvas.getBoundingClientRect();
  d.x1 = e.clientX - r.left; d.y1 = e.clientY - r.top;
  if (CLS.pick === 'single') return; // single: no box, the joint under the pointer on release
  const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
  if (w + h < 4) return;
  Object.assign(selBox.style, { left: `${x + canvas.offsetLeft}px`, top: `${y + canvas.offsetTop}px`, width: `${w}px`, height: `${h}px` });
  selBox.classList.toggle('sub', d.alt || CLS.armed === 'remove');
  selBox.hidden = false;
});
canvas.addEventListener('pointerup', (e) => {
  const d = CLS.drag;
  if (!d) return;
  CLS.drag = null;
  selBox.hidden = true;
  const small = Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0) < 6;
  let sel;
  if (small || CLS.pick === 'single' || CLS.armed === 'head' || CLS.armed === 'pelvis') {
    const b = boneAt(d.x1, d.y1, small ? 14 : 30);
    sel = new Set(b ? [b] : []);
  } else sel = bonesInRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
  clsApplySelection(sel, { shift: d.shift || e.shiftKey, alt: d.alt || e.altKey });
});

function clsUndo() {
  const prev = CLS.undo.pop();
  if (!prev || !S.info) return;
  const cr = S.creature;
  if (S.ref) cr.applySnapshot(S.ref);
  cr.update();
  S.info.headManual = S.info.pelvisManual = false;
  Cls.applyMapping(cr, S.info, prev);
  finishInfo(cr, S.info);
  S.footSets = defaultFootSets(S.info);
  rebuildMotion();
  Cls.save(cr, S.info);
  refreshAll();
  toast('Undone');
}
$('#clsUndo').addEventListener('click', clsUndo);
$('#clsClear').addEventListener('click', () => { if (S.info) clsEdit(() => { S.info.limbs = []; S.selected = null; return 'Every part cleared: box the joints of each part'; }); });
$('#clsAuto').addEventListener('click', () => {
  if (!S.info) return;
  CLS.undo.push(Cls.serialize(S.info));
  Cls.forget(S.creature);
  analyse({ fresh: true });
  refreshAll();
  toast(`Detected again: ${S.info.limbs.length} parts · ${describeBody()}`);
});
$('#clsExport').addEventListener('click', () => {
  if (!S.info) return;
  const name = (S.creature.name || 'creature').replace(/[^\w-]+/g, '_');
  download(JSON.stringify(Cls.serialize(S.info), null, 2), `${name}.bones.json`, 'application/json');
});
$('#clsImport').addEventListener('click', () => $('#clsFile').click());
$('#clsFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !S.info) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast('That file is not JSON', true); return; }
  if (!data || data.kind !== 'bone-map') { toast('That file is not a Procemotion bone map', true); return; }
  applyBoneMap(data, `Loaded ${f.name}`);
});
/** Use a bone classification (an imported file, or the one that comes with a sample creature). */
function applyBoneMap(data, msg) {
  clsEdit(() => { S.info.headManual = S.info.pelvisManual = false; Cls.applyMapping(S.creature, S.info, data); return msg ? `${msg}: ${S.info.limbs.length} parts` : null; });
}

// ------------------------------------------------------------------ sample creatures (public/demo, CC BY 4.0)
(function buildDemos() {
  const sel = $('#demoSel'), chips = $('#demoChips');
  for (const d of DEMOS) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = `${d.title} (${d.author})`;
    sel.appendChild(o);
    const c = document.createElement('button');
    c.className = 'chip'; c.innerHTML = `${esc(d.title)}<small>${esc(d.shows.split(';')[0])}</small>`;
    c.addEventListener('click', () => loadDemo(d.id));
    chips.appendChild(c);
  }
  sel.addEventListener('change', () => { if (sel.value) loadDemo(sel.value); sel.value = ''; });
})();
async function loadDemo(id, { mode, fly } = {}) {
  const d = DEMOS.find((x) => x.id === id);
  if (!d) return;
  toast(`Loading ${d.title}…`);
  try {
    const res = await fetch(new URL(`../demo/${d.file}`, location.href));
    if (!res.ok) throw new Error(`${d.file}: ${res.status}`);
    await openFiles([new File([await res.blob()], d.file)]);
    if (!S.creature) return;
    if (d.bones && S.info) {
      const map = await (await fetch(new URL(`../demo/${d.bones}`, location.href))).json();
      applyBoneMap(map);
    }
    // the credit the licence asks for, under the model's details
    $('#modelInfo').insertAdjacentHTML('beforeend', `<br><span class="credit">“${esc(d.title)}” by ${esc(d.author)}, <a href="${d.url}" target="_blank" rel="noopener">Fab</a>, <a href="${LICENSE.url}" target="_blank" rel="noopener">${LICENSE.name}</a></span>`);
    if (mode === 'rig' || mode === 'anim') setMode(mode);
    if (fly && S.motion && S.info.hasWings) { S.motion.params.flight.on = true; refreshAll(); }
  } catch (err) { console.error(err); toast(`Could not load the sample: ${err.message || err}`, true); }
}

function refreshClassPanel() {
  const show = S.mode === 'rig' && !!S.info && !S.template;
  $('#classPanel').hidden = !show;
  if (!show) { if (CLS.armed) { CLS.armed = null; orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE; canvas.style.cursor = ''; } return; }
  $$('#classPanel .clsbtn').forEach((b) => b.classList.toggle('on', (b.dataset.type || b.dataset.pick) === CLS.armed));
  $('#clsUndo').disabled = !CLS.undo.length;
  const head = $('[data-pick="head"]'), pel = $('[data-pick="pelvis"]');
  head.title = `Click the head joint${S.info.head ? ` (now ${S.info.head.name})` : ''}`;
  pel.title = `Click the joint the legs hang from${S.info.pelvis ? ` (now ${S.info.pelvis.name})` : ''}`;
  $('#clsSaved').textContent = S.info.fromSaved ? 'Your classes are saved in this browser for this model.' : 'Auto-detected. Changes are saved in this browser for this model.';
  const list = $('#clsList');
  list.innerHTML = '';
  if (!S.info.limbs.length) { list.innerHTML = '<div class="empty-note">No parts. Pick a type and box its joints.</div>'; return; }
  for (const l of S.info.limbs) {
    const row = document.createElement('div');
    row.className = 'item' + (S.selected === l.id ? ' on' : '');
    row.title = l.bones.map((b) => b.name).join(' › ');
    row.innerHTML = `<span class="dot" style="background:${TYPES[l.type].color}"></span>`;
    const name = document.createElement('input');
    name.value = l.label;
    name.title = 'Name (empty = automatic)';
    name.addEventListener('click', (e) => e.stopPropagation());
    name.addEventListener('change', () => clsEdit(() => { l.customLabel = name.value.trim() || undefined; }));
    row.appendChild(name);
    const seg = document.createElement('div');
    seg.className = 'seg mini';
    for (const s of ['L', 'C', 'R']) {
      const b = document.createElement('button');
      b.textContent = s;
      b.title = { L: 'Left', C: 'Centre', R: 'Right' }[s];
      if (l.side === s) b.classList.add('on');
      b.addEventListener('click', (e) => { e.stopPropagation(); clsEdit(() => { l.side = s; l.sideManual = true; }); });
      seg.appendChild(b);
    }
    row.appendChild(seg);
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Remove this part (its joints become unclassified)';
    x.addEventListener('click', (e) => { e.stopPropagation(); clsEdit(() => { S.info.limbs = S.info.limbs.filter((o) => o !== l); if (S.selected === l.id) S.selected = null; }); });
    row.appendChild(x);
    row.addEventListener('click', () => { S.selected = S.selected === l.id ? null : l.id; refreshLimbs(); refreshSkeleton(); refreshClassPanel(); updateHint(); });
    list.appendChild(row);
  }
}

// ------------------------------------------------------------------ refresh
function refreshAll() {
  const has = !!S.info;
  $('#redetect').disabled = !has;
  $$('#modeSeg button')[1].disabled = !S.motion;
  refreshLimbs();
  refreshGait();
  refreshDyn();
  refreshActions();
  refreshBake();
  refreshClips();
  refreshAdd();
  refreshSubdivide();
  refreshExport();
  refreshClassPanel();
  syncParams();
  const st = S.info ? S.info.style : 'walk';
  $('#gaitBox').hidden = st !== 'walk';
  $('#slitherBox').hidden = st !== 'slither';
  $('#hoverBox').hidden = st !== 'hover';
  const hasEars = !!(S.info && S.info.limbs.some((l) => l.type === 'ear' && l.side !== 'C'));
  $('#secFly').hidden = !(S.info && (S.info.limbs.some((l) => l.type === 'wing') || S.info.style === 'slither' || hasEars));
  $('#earFlyRow').hidden = !hasEars;
  $('#allFoursRow').hidden = !(S.motion && S.motion.allFours);
  $$('#secActions .chip, #stopAction').forEach((b) => { b.disabled = !S.motion; });
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
const followPrev = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  const cr = S.creature;
  if (cr && S.mode === 'anim' && S.motion) {
    if (S.playing) {
      S.playing.t = (S.playing.t + (S.motion.paused ? 0 : dt)) % Math.max(1e-3, S.playing.clip.duration);
      mover.position.set(S.motion.body.pos.x, S.motion.flatGround ? 0 : S.motion.groundY, S.motion.body.pos.z);
      cr.restore();
      S.playing.sampler(S.playing.t);
      cr.update();
    } else S.motion.update(dt);
  }
  // camera follow
  const H = S.info ? S.info.H : S._H || 1;
  const target = new THREE.Vector3().copy(mover.position).add(new THREE.Vector3(0, H * 0.45, 0));
  if (S.follow && S.mode === 'anim' && S.motion) {
    const delta = target.clone().sub(orbit.target).multiplyScalar(Math.min(1, dt * 4));
    orbit.target.add(delta);
    camera.position.add(delta);
  }
  followPrev.copy(target);
  sun.position.copy(mover.position).add(new THREE.Vector3(H * 2.5, H * 5, H * 2));
  sun.target.position.copy(mover.position);
  skel.update();
  capView.update();
  orbit.update();
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ helpers
function clearGroup(g) {
  for (const c of [...g.children]) {
    g.remove(c);
    if (c.geometry && c.geometry !== handleGeo) c.geometry.dispose();
  }
}
let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2800);
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

resize();
refreshAll();
updateHint();
frame();
// links straight to a sample: app/?demo=spider (&mode=rig)
{
  const q = new URLSearchParams(location.search);
  if (q.get('demo')) loadDemo(q.get('demo'), { mode: q.get('mode'), fly: q.get('fly') === '1' });
}
// debugging handle (also used by automated checks)
window.LF = { S, openFiles, analyse, setMode, ACTIONS, bake, addChain, exportFiles, startTemplate, refreshAll, camera, orbit };
