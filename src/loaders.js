// Model loading: GLB / GLTF (+bin, textures), FBX, OBJ. Files never leave the browser.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj'];
const ext = (name) => name.split('.').pop().toLowerCase();

export function pickModelFile(files) {
  return files.find((f) => MODEL_EXT.includes(ext(f.name))) || null;
}

/**
 * Load a model from a list of dropped/selected files (the model plus any side files).
 * Returns { scene, animations, name }.
 */
export async function loadModelFiles(files) {
  const main = pickModelFile(files);
  if (!main) throw new Error('No supported model file found. Use GLB, GLTF, FBX or OBJ.');

  // side files (textures, .bin) are resolved by file name
  const urls = new Map();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]).toLowerCase();
    return urls.get(base) || url;
  });
  const mainUrl = urls.get(main.name.toLowerCase());
  const kind = ext(main.name);

  try {
    let scene, animations;
    if (kind === 'glb' || kind === 'gltf') {
      const loader = new GLTFLoader(manager);
      const draco = new DRACOLoader(manager);
      // the decoder is served at the site's root, in draco/ (the app page is app/index.html)
      draco.setDecoderPath(new URL('../draco/', location.href).href);
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(mainUrl);
      scene = gltf.scene || gltf.scenes[0];
      animations = gltf.animations || [];
      draco.dispose();
    } else if (kind === 'fbx') {
      scene = await new FBXLoader(manager).loadAsync(mainUrl);
      animations = scene.animations || [];
    } else {
      scene = await new OBJLoader(manager).loadAsync(mainUrl);
      animations = [];
      scene.traverse((o) => {
        if (o.isMesh && (!o.material || !o.material.map)) o.material = new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.8 });
      });
    }
    if (!scene) throw new Error('The file does not contain a scene.');
    fixFalseTransparency(scene);
    const base = main.name.replace(/\.[^.]+$/, '');
    // exporters often leave generic clip names; make them readable
    animations.forEach((clip, i) => {
      if (!clip.name || /^(mixamo\.com|take ?0*1|scene|animation|armature\|?.*mixamo.*)$/i.test(clip.name)) {
        clip.name = animations.length > 1 ? `${base} ${i + 1}` : base;
      }
    });
    // game-ripped clips carry a model-id prefix on every name (pm0025_00_ba10_waitA01): drop the shared part
    if (animations.length > 1) {
      const m = /^([a-z]{2}\d{3,5}_\d{2}_)/i.exec(animations[0].name || '');
      if (m && animations.every((c) => c.name.startsWith(m[1]))) animations.forEach((c) => { c.name = c.name.slice(m[1].length); });
    }
    return { scene, animations, name: base };
  } finally {
    // textures are decoded by now for GLB/FBX; keep URLs alive briefly for late image loads
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
}

/** How much of a texture's alpha is not fully opaque: { holes: share of pixels below 250, soft: share in between }. */
function textureAlpha(image) {
  const w = image && (image.width || image.naturalWidth), h = image && (image.height || image.naturalHeight);
  if (!w || !h || (image.complete === false)) return null;
  const s = Math.min(1, 256 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  try {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(image, 0, 0, cw, ch);
    const d = cx.getImageData(0, 0, cw, ch).data;
    let holes = 0, soft = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] < 250) holes++; if (d[i] > 10 && d[i] < 245) soft++; }
    return { holes: holes / (cw * ch), soft: soft / (cw * ch) };
  } catch { return null; }
}

/**
 * Many ripped models mark every material as alpha-blended although nothing in them is see-through. Blended
 * materials don't write depth, so the body's far side shows through its near side (the tail drawn over the
 * belly). Materials whose texture and vertex colours are fully opaque become solid; cut-outs (alpha that is
 * either 0 or 1: feathers, hair cards) use alpha testing; only real translucency stays blended.
 */
export function fixFalseTransparency(root) {
  const seen = new Map(); // material -> verdict
  root.traverse((o) => {
    if (!o.isMesh) return;
    const col = o.geometry && o.geometry.attributes.color;
    let vAlpha = false;
    if (col && col.itemSize === 4) for (let i = 0; i < col.count; i++) if (col.getW(i) < 0.99) { vAlpha = true; break; }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.transparent || seen.has(m)) continue;
      if (m.opacity < 0.99 || m.alphaMap || (vAlpha && m.vertexColors)) { seen.set(m, 'blend'); continue; }
      const a = m.map ? textureAlpha(m.map.image) : { holes: 0, soft: 0 };
      if (!a) { seen.set(m, 'unknown'); continue; }
      if (a.holes < 0.001) { m.transparent = false; m.depthWrite = true; seen.set(m, 'opaque'); }
      else if (a.soft < 0.1 * a.holes) { m.transparent = false; m.depthWrite = true; m.alphaTest = 0.5; seen.set(m, 'cutout'); }
      else { seen.set(m, 'blend'); continue; }
      m.needsUpdate = true;
    }
  });
  return seen;
}

export function modelStats(root) {
  let tris = 0, meshes = 0, bones = 0;
  root.traverse((o) => {
    if (o.isBone) bones++;
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      tris += g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
    }
  });
  return { tris: Math.round(tris), meshes, bones };
}
