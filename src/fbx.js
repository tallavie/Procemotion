// Binary FBX 7.4 writer: skinned meshes, skeleton, bind pose, diffuse materials with embedded textures, and every
// clip as its own take (UE makes one Anim Sequence per take). Written in centimetres, Y up (UE converts to Z up).
import * as THREE from 'three';

const TICKS = 46186158000; // FBX time units per second
const FPS = 30;

// ---------------------------------------------------------------- binary encoding

const enc = new TextEncoder();
const p = {
  I: (v) => ({ t: 'I', v }), L: (v) => ({ t: 'L', v }), D: (v) => ({ t: 'D', v }), C: (v) => ({ t: 'C', v }),
  S: (v) => ({ t: 'S', v }), R: (v) => ({ t: 'R', v }),
  d: (v) => ({ t: 'd', v }), f: (v) => ({ t: 'f', v }), i: (v) => ({ t: 'i', v }), l: (v) => ({ t: 'l', v }),
};
class N {
  constructor(name, props = [], kids = []) { this.name = name; this.props = props; this.kids = kids; }
  add(name, props = [], kids = []) { const n = new N(name, props, kids); this.kids.push(n); return n; }
}
// these need a closing null record even without children (as Blender's exporter notes)
const ALWAYS_SENTINEL = new Set(['AnimationStack', 'AnimationLayer']);

async function zlib(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Turn every property into its final bytes (arrays get zlib-compressed when that helps). */
async function encodeProps(node) {
  node.bytes = [];
  for (const pr of node.props) {
    let b;
    switch (pr.t) {
      case 'I': b = new Uint8Array(5); b[0] = 73; new DataView(b.buffer).setInt32(1, pr.v, true); break;
      case 'C': b = new Uint8Array([67, pr.v ? 1 : 0]); break;
      case 'D': b = new Uint8Array(9); b[0] = 68; new DataView(b.buffer).setFloat64(1, pr.v, true); break;
      case 'L': b = new Uint8Array(9); b[0] = 76; new DataView(b.buffer).setBigInt64(1, BigInt(pr.v), true); break;
      case 'S': case 'R': {
        const s = pr.t === 'S' ? enc.encode(pr.v) : pr.v;
        b = new Uint8Array(5 + s.length); b[0] = pr.t.charCodeAt(0);
        new DataView(b.buffer).setUint32(1, s.length, true); b.set(s, 5); break;
      }
      default: { // arrays
        const T = { d: Float64Array, f: Float32Array, i: Int32Array, l: BigInt64Array }[pr.t];
        const arr = pr.v instanceof T ? pr.v : T.from(pr.t === 'l' ? pr.v.map((x) => BigInt(x)) : pr.v);
        let raw = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), encoding = 0;
        if (raw.length > 512) { const z = await zlib(raw); if (z && z.length < raw.length) { raw = z; encoding = 1; } }
        b = new Uint8Array(13 + raw.length); b[0] = pr.t.charCodeAt(0);
        const dv = new DataView(b.buffer);
        dv.setUint32(1, arr.length, true); dv.setUint32(5, encoding, true); dv.setUint32(9, raw.length, true);
        b.set(raw, 13);
      }
    }
    node.bytes.push(b);
  }
  for (const k of node.kids) await encodeProps(k);
}
function sizeOf(node) {
  node.nameBytes = enc.encode(node.name);
  node.propLen = node.bytes.reduce((a, b) => a + b.length, 0);
  node.sentinel = node.kids.length > 0 || node.props.length === 0 || ALWAYS_SENTINEL.has(node.name);
  node.size = 13 + node.nameBytes.length + node.propLen + node.kids.reduce((a, k) => a + sizeOf(k), 0) + (node.sentinel ? 13 : 0);
  return node.size;
}
function writeNode(node, out, at) {
  const dv = new DataView(out.buffer);
  dv.setUint32(at, at + node.size, true);
  dv.setUint32(at + 4, node.props.length, true);
  dv.setUint32(at + 8, node.propLen, true);
  out[at + 12] = node.nameBytes.length;
  let o = at + 13;
  out.set(node.nameBytes, o); o += node.nameBytes.length;
  for (const b of node.bytes) { out.set(b, o); o += b.length; }
  for (const k of node.kids) o = writeNode(k, out, o);
  if (node.sentinel) o += 13; // zeros
  return o;
}
// fixed creation time + matching file id / footer: the FBX SDK checks them against each other (same as Blender)
const FILE_ID = new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]);
const TIME_ID = '1970-01-01 10:00:00:000';
const FOOT_ID = new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
const FOOT_END = new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);

async function serialize(top) {
  for (const n of top) await encodeProps(n);
  const head = 27;
  let body = 0;
  for (const n of top) body += sizeOf(n);
  const afterNodes = head + body + 13;
  const footStart = afterNodes + 16 + 4;
  let pad = ((footStart + 15) & ~15) - footStart; if (pad === 0) pad = 16;
  const total = footStart + pad + 4 + 120 + 16;
  const out = new Uint8Array(total);
  out.set(enc.encode('Kaydara FBX Binary  '), 0); out[20] = 0; out[21] = 0x1a; out[22] = 0;
  new DataView(out.buffer).setUint32(23, 7400, true);
  let o = head;
  for (const n of top) o = writeNode(n, out, o);
  o += 13;
  out.set(FOOT_ID, o); o += 16 + 4 + pad;
  new DataView(out.buffer).setUint32(o, 7400, true); o += 4 + 120;
  out.set(FOOT_END, o);
  return out;
}

// ---------------------------------------------------------------- scene helpers

/** Properties70 entry. Values are typed from the property type. */
function P(name, type, label, flags, ...vals) {
  const intTypes = new Set(['int', 'enum', 'bool', 'Integer', 'Bool']);
  const v = vals.map((x) => type === 'KTime' ? p.L(x) : typeof x === 'string' ? p.S(x) : intTypes.has(type) ? p.I(x) : p.D(x));
  return new N('P', [p.S(name), p.S(type), p.S(label), p.S(flags), ...v]);
}
const objName = (name, cls) => `${name}\u0000\u0001${cls}`;
const D2 = 180 / Math.PI;

/** Euler degrees in FBX's default XYZ order (= three's 'ZYX'), the variant closest to `prev` (no 360 jumps). */
function fbxEuler(q, prev) {
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  const a = [e.x * D2, e.y * D2, e.z * D2];
  const b = [a[0] + 180, 180 - a[1], a[2] + 180]; // the same rotation
  if (!prev) return a;
  const fit = (v) => v.map((x, i) => x + 360 * Math.round((prev[i] - x) / 360));
  const fa = fit(a), fb = fit(b);
  const dist = (v) => v.reduce((s, x, i) => s + (x - prev[i]) ** 2, 0);
  return dist(fa) <= dist(fb) ? fa : fb;
}

async function pngBytes(image) {
  const w = image.width || image.videoWidth, h = image.height || image.videoHeight;
  if (!w || !h) return null;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  cv.getContext('2d').drawImage(image, 0, 0);
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r) => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------- export

/**
 * root: the model (already in the pose to export as the skeleton's bind/reference pose, matrices up to date).
 * clips: THREE.AnimationClip[] whose tracks are "<bone name>.<quaternion|position|scale>".
 * cm: centimetres per model unit.
 */
export async function buildFBX(root, clips, cm, name = 'creature', { refTake = true } = {}) {
  root.updateMatrixWorld(true);
  let nextId = 1000000;
  const id = () => nextId++;
  const objects = new N('Objects');
  const conns = new N('Connections');
  const link = (child, parent, prop) => conns.add('C', prop ? [p.S('OP'), p.L(child), p.L(parent), p.S(prop)] : [p.S('OO'), p.L(child), p.L(parent)]);
  const count = {};
  const counted = (type) => { count[type] = (count[type] || 0) + 1; };

  const Sk = new THREE.Matrix4().makeScale(cm, cm, cm), SkI = new THREE.Matrix4().makeScale(1 / cm, 1 / cm, 1 / cm);
  const toCm = (m) => new THREE.Matrix4().multiplyMatrices(Sk, m).multiply(SkI); // same transform, in cm
  const arr16 = (m) => Array.from(m.elements);

  // ---- skeleton
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const bindWorld = new Map(); // bone -> world matrix at bind (from the first skeleton that has it)
  for (const m of meshes) {
    if (!m.isSkinnedMesh) continue;
    m.skeleton.bones.forEach((b, i) => { if (!bindWorld.has(b)) bindWorld.set(b, new THREE.Matrix4().copy(m.skeleton.boneInverses[i]).invert()); });
  }
  for (const b of bones) if (!bindWorld.has(b)) bindWorld.set(b, b.matrixWorld.clone());
  const roots = bones.filter((b) => !(b.parent && b.parent.isBone));
  // UE wants one root bone
  let virtualRoot = null;
  if (roots.length > 1) {
    virtualRoot = { id: id(), name: 'Root' };
  }
  const boneId = new Map();
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
  // local transform of a bone as written in the file (roots carry their non-bone parents' transform)
  const parentWorld = new Map(bones.map((b) => [b, !(b.parent && b.parent.isBone) && b.parent ? b.parent.matrixWorld.clone() : null]));
  const localOf = (b, pos, quat, scl, out) => {
    const pw = parentWorld.get(b);
    if (!pw) { out.p.copy(pos); out.q.copy(quat); out.s.copy(scl); return out; }
    _m.compose(pos, quat, scl).premultiply(pw).decompose(out.p, out.q, out.s);
    return out;
  };
  const addModel = (mid, nm, type, pos, quat, scl, isLimb) => {
    const e = fbxEuler(quat);
    const model = objects.add('Model', [p.L(mid), p.S(objName(nm, 'Model')), p.S(type)]);
    model.add('Version', [p.I(232)]);
    model.add('Properties70', [], [
      P('Lcl Translation', 'Lcl Translation', '', 'A', pos.x * cm, pos.y * cm, pos.z * cm),
      P('Lcl Rotation', 'Lcl Rotation', '', 'A', e[0], e[1], e[2]),
      P('Lcl Scaling', 'Lcl Scaling', '', 'A', scl.x, scl.y, scl.z),
      P('InheritType', 'enum', '', '', 1),
      P('DefaultAttributeIndex', 'int', 'Integer', '', 0),
    ]);
    model.add('Shading', [p.C(true)]);
    model.add('Culling', [p.S('CullingOff')]);
    counted('Model');
    if (isLimb) {
      const aid = id();
      const at = objects.add('NodeAttribute', [p.L(aid), p.S(objName(nm, 'NodeAttribute')), p.S('LimbNode')]);
      at.add('Properties70', [], [P('Size', 'double', 'Number', '', 1)]);
      at.add('TypeFlags', [p.S('Skeleton')]);
      counted('NodeAttribute');
      link(aid, mid);
    }
  };
  if (virtualRoot) {
    addModel(virtualRoot.id, virtualRoot.name, 'LimbNode', new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1), true);
    link(virtualRoot.id, 0);
  }
  const tmp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
  for (const b of bones) {
    const bid = id();
    boneId.set(b, bid);
    localOf(b, b.position, b.quaternion, b.scale, tmp);
    addModel(bid, b.name, 'LimbNode', tmp.p, tmp.q, tmp.s, true);
  }
  for (const b of bones) {
    const parent = b.parent && b.parent.isBone ? boneId.get(b.parent) : virtualRoot ? virtualRoot.id : 0;
    link(boneId.get(b), parent);
  }

  // ---- materials (deduplicated), embedded textures
  const matId = new Map();
  const images = new Map();
  let texCount = 0;
  async function material(mat) {
    if (matId.has(mat)) return matId.get(mat);
    const mid = id();
    matId.set(mat, mid);
    const c = mat.color || new THREE.Color(1, 1, 1);
    const m = objects.add('Material', [p.L(mid), p.S(objName(mat.name || `Material${matId.size}`, 'Material')), p.S('')]);
    m.add('Version', [p.I(102)]);
    m.add('ShadingModel', [p.S('lambert')]);
    m.add('MultiLayer', [p.I(0)]);
    const props = [
      P('DiffuseColor', 'Color', '', 'A', c.r, c.g, c.b),
      P('DiffuseFactor', 'Number', '', 'A', 1),
    ];
    if (mat.transparent && mat.opacity < 1) props.push(P('TransparencyFactor', 'Number', '', 'A', 1 - mat.opacity));
    m.add('Properties70', [], props);
    counted('Material');
    const map = mat.map;
    if (map && map.image) {
      let vid = images.get(map.image);
      if (vid === undefined) {
        const bytes = await pngBytes(map.image).catch(() => null);
        if (bytes) {
          vid = { id: id(), file: `${name}_tex${images.size}.png` };
          const v = objects.add('Video', [p.L(vid.id), p.S(objName(vid.file, 'Video')), p.S('Clip')]);
          v.add('Type', [p.S('Clip')]);
          v.add('Properties70', [], [P('Path', 'KString', 'XRefUrl', '', vid.file)]);
          v.add('UseMipMap', [p.I(0)]);
          v.add('Filename', [p.S(vid.file)]);
          v.add('RelativeFilename', [p.S(vid.file)]);
          v.add('Content', [p.R(bytes)]);
          counted('Video');
        } else vid = null;
        images.set(map.image, vid);
      }
      if (vid) {
        const tid = id();
        const tn = `${name}_tex${texCount++}`;
        const t = objects.add('Texture', [p.L(tid), p.S(objName(tn, 'Texture')), p.S('')]);
        t.add('Type', [p.S('TextureVideoClip')]);
        t.add('Version', [p.I(202)]);
        t.add('TextureName', [p.S(objName(tn, 'Texture'))]);
        t.add('Properties70', [], [P('UseMaterial', 'bool', '', '', 1)]);
        t.add('Media', [p.S(objName(vid.file, 'Video'))]);
        t.add('FileName', [p.S(vid.file)]);
        t.add('RelativeFilename', [p.S(vid.file)]);
        t.add('ModelUVTranslation', [p.D(0), p.D(0)]);
        t.add('ModelUVScaling', [p.D(1), p.D(1)]);
        t.add('Texture_Alpha_Source', [p.S('None')]);
        t.add('Cropping', [p.I(0), p.I(0), p.I(0), p.I(0)]);
        counted('Texture');
        link(vid.id, tid);
        link(tid, mid, 'DiffuseColor');
      }
    }
    return mid;
  }

  // ---- meshes, skins, bind pose
  const poseNodes = [];
  for (const b of bones) poseNodes.push([boneId.get(b), toCm(bindWorld.get(b))]);
  if (virtualRoot) poseNodes.push([virtualRoot.id, new THREE.Matrix4()]);
  let meshIndex = 0;
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    if (!pos || !pos.count) continue;
    // bind: the mesh's space at binding; rigid meshes ride on the bone above them (or the first root)
    let bindM, skin = [];
    if (mesh.isSkinnedMesh) {
      bindM = mesh.bindMatrix.clone();
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      const per = new Map();
      for (let v = 0; v < pos.count; v++) for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w <= 0) continue;
        const bi = si.getComponent(v, k);
        if (!per.has(bi)) per.set(bi, { idx: [], w: [] });
        per.get(bi).idx.push(v); per.get(bi).w.push(w);
      }
      for (const [bi, d] of per) skin.push({ bone: mesh.skeleton.bones[bi], inv: mesh.skeleton.boneInverses[bi], ...d });
    } else {
      bindM = mesh.matrixWorld.clone();
      let b = mesh.parent;
      while (b && !b.isBone) b = b.parent;
      b = b || roots[0];
      if (b) skin.push({ bone: b, inv: b.matrixWorld.clone().invert(), idx: [...Array(pos.count).keys()], w: new Array(pos.count).fill(1) });
    }
    const mname = mesh.name || `${name}_mesh${meshIndex}`;
    meshIndex++;
    const gid = id(), mid = id();
    // geometry: control points = vertices (cm), triangles, per-corner normals and UVs
    const verts = new Float64Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) { verts[v * 3] = pos.getX(v) * cm; verts[v * 3 + 1] = pos.getY(v) * cm; verts[v * 3 + 2] = pos.getZ(v) * cm; }
    const index = g.index ? g.index.array : null;
    const nTri = Math.floor((index ? index.length : pos.count) / 3);
    const corner = (i) => (index ? index[i] : i);
    const pvi = new Int32Array(nTri * 3);
    for (let t = 0; t < nTri; t++) { pvi[t * 3] = corner(t * 3); pvi[t * 3 + 1] = corner(t * 3 + 1); pvi[t * 3 + 2] = ~corner(t * 3 + 2); }
    const geo = objects.add('Geometry', [p.L(gid), p.S(objName(mname, 'Geometry')), p.S('Mesh')]);
    geo.add('Properties70');
    geo.add('GeometryVersion', [p.I(124)]);
    geo.add('Vertices', [p.d(verts)]);
    geo.add('PolygonVertexIndex', [p.i(pvi)]);
    const layer = new N('Layer', [p.I(0)], [new N('Version', [p.I(100)])]);
    const nrm = g.attributes.normal;
    if (nrm) {
      const nn = new Float64Array(nTri * 9);
      for (let c = 0; c < nTri * 3; c++) { const v = corner(c); nn[c * 3] = nrm.getX(v); nn[c * 3 + 1] = nrm.getY(v); nn[c * 3 + 2] = nrm.getZ(v); }
      geo.add('LayerElementNormal', [p.I(0)], [new N('Version', [p.I(101)]), new N('Name', [p.S('')]),
        new N('MappingInformationType', [p.S('ByPolygonVertex')]), new N('ReferenceInformationType', [p.S('Direct')]), new N('Normals', [p.d(nn)])]);
      layer.add('LayerElement', [], [new N('Type', [p.S('LayerElementNormal')]), new N('TypedIndex', [p.I(0)])]);
    }
    geo.add('LayerElementSmoothing', [p.I(0)], [new N('Version', [p.I(102)]), new N('Name', [p.S('')]),
      new N('MappingInformationType', [p.S('ByPolygon')]), new N('ReferenceInformationType', [p.S('Direct')]), new N('Smoothing', [p.i(new Int32Array(nTri).fill(1))])]);
    layer.add('LayerElement', [], [new N('Type', [p.S('LayerElementSmoothing')]), new N('TypedIndex', [p.I(0)])]);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const uv = g.attributes.uv;
    if (uv) {
      // glTF's V runs down the image, FBX's up (unless the texture was loaded flipped already)
      const map = mats[0] && mats[0].map;
      const flip = !(map && map.flipY);
      const uvs = new Float64Array(uv.count * 2);
      for (let v = 0; v < uv.count; v++) { uvs[v * 2] = uv.getX(v); uvs[v * 2 + 1] = flip ? 1 - uv.getY(v) : uv.getY(v); }
      const uvi = new Int32Array(nTri * 3);
      for (let c = 0; c < nTri * 3; c++) uvi[c] = corner(c);
      geo.add('LayerElementUV', [p.I(0)], [new N('Version', [p.I(101)]), new N('Name', [p.S('UVMap')]),
        new N('MappingInformationType', [p.S('ByPolygonVertex')]), new N('ReferenceInformationType', [p.S('IndexToDirect')]),
        new N('UV', [p.d(uvs)]), new N('UVIndex', [p.i(uvi)])]);
      layer.add('LayerElement', [], [new N('Type', [p.S('LayerElementUV')]), new N('TypedIndex', [p.I(0)])]);
    }
    // materials per triangle (geometry groups) - FBX wants the material slots in connection order
    const triMat = new Int32Array(nTri);
    if (Array.isArray(mesh.material) && g.groups.length) {
      for (const gr of g.groups) for (let t = Math.floor(gr.start / 3); t < Math.min(nTri, Math.floor((gr.start + gr.count) / 3)); t++) triMat[t] = gr.materialIndex || 0;
    }
    geo.add('LayerElementMaterial', [p.I(0)], [new N('Version', [p.I(101)]), new N('Name', [p.S('')]),
      new N('MappingInformationType', [p.S('ByPolygon')]), new N('ReferenceInformationType', [p.S('IndexToDirect')]), new N('Materials', [p.i(triMat)])]);
    layer.add('LayerElement', [], [new N('Type', [p.S('LayerElementMaterial')]), new N('TypedIndex', [p.I(0)])]);
    geo.kids.push(layer);
    counted('Geometry');

    // the mesh node sits at the scene root, at its bind transform
    bindM.decompose(_p, _q, _s);
    addModel(mid, mname, 'Mesh', _p, _q, _s, false);
    link(mid, 0);
    link(gid, mid);
    for (const mat of mats) link(await material(mat || new THREE.MeshStandardMaterial()), mid);
    const bindCm = toCm(bindM);
    poseNodes.push([mid, bindCm]);

    if (skin.length) {
      const sid = id();
      const sk = objects.add('Deformer', [p.L(sid), p.S(objName(mname, 'Deformer')), p.S('Skin')]);
      sk.add('Version', [p.I(101)]);
      sk.add('Link_DeformAcuracy', [p.D(50)]);
      counted('Deformer');
      link(sid, gid);
      for (const c of skin) {
        if (!boneId.has(c.bone)) continue;
        const cid = id();
        const link_ = toCm(new THREE.Matrix4().copy(c.inv).invert()); // bone at bind
        // Transform is stored relative to the bone (link^-1 * mesh), as Blender and the FBX SDK write it
        const tr = new THREE.Matrix4().copy(link_).invert().multiply(bindCm);
        const cl = objects.add('Deformer', [p.L(cid), p.S(objName(c.bone.name, 'SubDeformer')), p.S('Cluster')]);
        cl.add('Version', [p.I(100)]);
        cl.add('UserData', [p.S(''), p.S('')]);
        cl.add('Indexes', [p.i(Int32Array.from(c.idx))]);
        cl.add('Weights', [p.d(Float64Array.from(c.w))]);
        cl.add('Transform', [p.d(arr16(tr))]);
        cl.add('TransformLink', [p.d(arr16(link_))]);
        counted('Deformer');
        link(cid, sid);
        link(boneId.get(c.bone), cid);
      }
    }
  }
  const pid = id();
  const pose = objects.add('Pose', [p.L(pid), p.S(objName('BindPose', 'Pose')), p.S('BindPose')]);
  pose.add('Type', [p.S('BindPose')]);
  pose.add('Version', [p.I(100)]);
  pose.add('NbPoseNodes', [p.I(poseNodes.length)]);
  for (const [nid, m] of poseNodes) pose.add('PoseNode', [], [new N('Node', [p.L(nid)]), new N('Matrix', [p.d(arr16(m))])]);
  counted('Pose');

  // ---- animation: one take per clip, sampled at 30 fps
  const byName = new Map(bones.map((b) => [b.name, b]));
  const takes = [];
  const usedNames = new Set();
  let maxStop = 0;
  // UE (Interchange) takes the skeleton's reference pose from time 0 of the first take, not from the bind pose:
  // so the first take holds the bind pose itself (a two-key clip of every bone where it is now)
  if (refTake && clips.length) {
    const ref = new THREE.AnimationClip('ReferencePose', 1 / FPS, bones.flatMap((b) => [
      new THREE.VectorKeyframeTrack(`${b.name}.position`, [0, 1 / FPS], [...b.position.toArray(), ...b.position.toArray()]),
      new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, [0, 1 / FPS], [...b.quaternion.toArray(), ...b.quaternion.toArray()]),
      new THREE.VectorKeyframeTrack(`${b.name}.scale`, [0, 1 / FPS], [...b.scale.toArray(), ...b.scale.toArray()]),
    ]));
    clips = [ref, ...clips];
  }
  for (const clip of clips) {
    const tracks = new Map(); // bone -> {quaternion, position, scale}
    for (const tr of clip.tracks) {
      let parsed;
      try { parsed = THREE.PropertyBinding.parseTrackName(tr.name); } catch { continue; }
      const b = byName.get(parsed.nodeName);
      if (!b || !['quaternion', 'position', 'scale'].includes(parsed.propertyName)) continue;
      if (!tracks.has(b)) tracks.set(b, {});
      tracks.get(b)[parsed.propertyName] = tr;
    }
    if (!tracks.size) continue;
    let cname = (clip.name || 'Take').replace(/[^\w-]+/g, '_');
    for (let k = 2; usedNames.has(cname); k++) cname = `${clip.name}_${k}`;
    usedNames.add(cname);
    // sample at the clip's own key rate (30-60 fps), so nothing between its keys is lost
    let step = 1 / FPS;
    for (const tr of clip.tracks) {
      const t = tr.times;
      if (t.length < 3) continue;
      const d = []; for (let k = 1; k < t.length; k++) d.push(t[k] - t[k - 1]);
      d.sort((x, y) => x - y);
      step = Math.min(step, Math.max(1 / 60, d[d.length >> 1]));
    }
    const fps = Math.min(60, Math.max(FPS, Math.round(1 / step)));
    const dur = Math.max(clip.duration, 1 / fps);
    const nF = Math.max(2, Math.round(dur * fps) + 1);
    const times = Array.from({ length: nF }, (_, i) => Math.min(dur, i / fps));
    const keyTime = new BigInt64Array(times.map((t) => BigInt(Math.round(t * TICKS))));
    const stop = Math.round(dur * TICKS);
    maxStop = Math.max(maxStop, stop);

    const stackId = id(), layerId = id();
    objects.add('AnimationStack', [p.L(stackId), p.S(objName(cname, 'AnimStack')), p.S('')], [new N('Properties70', [], [
      P('LocalStart', 'KTime', 'Time', '', 0), P('LocalStop', 'KTime', 'Time', '', stop),
      P('ReferenceStart', 'KTime', 'Time', '', 0), P('ReferenceStop', 'KTime', 'Time', '', stop),
    ])]);
    objects.add('AnimationLayer', [p.L(layerId), p.S(objName('BaseLayer', 'AnimLayer')), p.S('')]);
    counted('AnimationStack'); counted('AnimationLayer');
    link(layerId, stackId);
    takes.push({ name: cname, stop });

    for (const [b, tr] of tracks) {
      const ev = (track, t, out) => {
        if (!track) return null;
        const it = track.createInterpolant();
        return times.map((tt) => out.fromArray(it.evaluate(tt)).clone());
      };
      const Q = ev(tr.quaternion, 0, new THREE.Quaternion()), Pp = ev(tr.position, 0, new THREE.Vector3()), Sc = ev(tr.scale, 0, new THREE.Vector3());
      const hasParent = !!parentWorld.get(b);
      const want = { T: !!Pp || hasParent, R: !!Q || hasParent, S: !!Sc || hasParent };
      const T = [], R = [], Sv = [];
      let prev = null;
      for (let f = 0; f < nF; f++) {
        localOf(b, Pp ? Pp[f] : b.position, Q ? Q[f] : b.quaternion, Sc ? Sc[f] : b.scale, tmp);
        T.push([tmp.p.x * cm, tmp.p.y * cm, tmp.p.z * cm]);
        prev = fbxEuler(tmp.q, prev); R.push(prev);
        Sv.push([tmp.s.x, tmp.s.y, tmp.s.z]);
      }
      for (const [key, prop, vals] of [['T', 'Lcl Translation', T], ['R', 'Lcl Rotation', R], ['S', 'Lcl Scaling', Sv]]) {
        if (!want[key]) continue;
        const cnId = id();
        objects.add('AnimationCurveNode', [p.L(cnId), p.S(objName(key, 'AnimCurveNode')), p.S('')], [new N('Properties70', [],
          ['X', 'Y', 'Z'].map((ax, i) => P(`d|${ax}`, 'Number', '', 'A', vals[0][i])))]);
        counted('AnimationCurveNode');
        link(cnId, layerId);
        link(cnId, boneId.get(b), prop);
        ['X', 'Y', 'Z'].forEach((ax, i) => {
          const cid = id();
          const v = new Float32Array(vals.map((x) => x[i]));
          objects.add('AnimationCurve', [p.L(cid), p.S(objName('', 'AnimCurve')), p.S('')], [
            new N('Default', [p.D(v[0])]), new N('KeyVer', [p.I(4009)]),
            new N('KeyTime', [p.l(keyTime)]), new N('KeyValueFloat', [p.f(v)]),
            new N('KeyAttrFlags', [p.i(new Int32Array([24836]))]),
            new N('KeyAttrDataFloat', [p.f(new Float32Array([0, 0, 9.419963346924634e-30, 0]))]),
            new N('KeyAttrRefCount', [p.i(new Int32Array([nF]))]),
          ]);
          counted('AnimationCurve');
          link(cid, cnId, `d|${ax}`);
        });
      }
    }
  }

  // ---- file
  const top = [];
  const hdr = new N('FBXHeaderExtension');
  hdr.add('FBXHeaderVersion', [p.I(1003)]);
  hdr.add('FBXVersion', [p.I(7400)]);
  hdr.add('EncryptionType', [p.I(0)]);
  const ts = hdr.add('CreationTimeStamp');
  for (const [k, v] of [['Version', 1000], ['Year', 1970], ['Month', 1], ['Day', 1], ['Hour', 10], ['Minute', 0], ['Second', 0], ['Millisecond', 0]]) ts.add(k, [p.I(v)]);
  hdr.add('Creator', [p.S('Procemotion')]);
  top.push(hdr);
  top.push(new N('FileId', [p.R(FILE_ID)]));
  top.push(new N('CreationTime', [p.S(TIME_ID)]));
  top.push(new N('Creator', [p.S('Procemotion')]));
  top.push(new N('GlobalSettings', [], [new N('Version', [p.I(1000)]), new N('Properties70', [], [
    P('UpAxis', 'int', 'Integer', '', 1), P('UpAxisSign', 'int', 'Integer', '', 1),
    P('FrontAxis', 'int', 'Integer', '', 2), P('FrontAxisSign', 'int', 'Integer', '', 1),
    P('CoordAxis', 'int', 'Integer', '', 0), P('CoordAxisSign', 'int', 'Integer', '', 1),
    P('OriginalUpAxis', 'int', 'Integer', '', 1), P('OriginalUpAxisSign', 'int', 'Integer', '', 1),
    P('UnitScaleFactor', 'double', 'Number', '', 1), P('OriginalUnitScaleFactor', 'double', 'Number', '', 1),
    P('TimeMode', 'enum', '', '', 6), P('TimeSpanStart', 'KTime', 'Time', '', 0), P('TimeSpanStop', 'KTime', 'Time', '', maxStop || TICKS),
    P('CustomFrameRate', 'double', 'Number', '', -1),
  ])]));
  const docId = id();
  top.push(new N('Documents', [], [new N('Count', [p.I(1)]), new N('Document', [p.L(docId), p.S(''), p.S('Scene')], [
    new N('Properties70', [], [P('SourceObject', 'object', '', ''), P('ActiveAnimStackName', 'KString', '', '', refTake && takes[0] ? takes[0].name : '')]),
    new N('RootNode', [p.L(0)]),
  ])]));
  top.push(new N('References'));
  count.GlobalSettings = 1;
  const defs = new N('Definitions', [], [new N('Version', [p.I(100)]), new N('Count', [p.I(Object.values(count).reduce((a, b) => a + b, 0))])]);
  for (const [type, n] of Object.entries(count)) defs.add('ObjectType', [p.S(type)], [new N('Count', [p.I(n)])]);
  top.push(defs);
  top.push(objects);
  top.push(conns);
  const tk = new N('Takes', [], [new N('Current', [p.S(refTake && takes[0] ? takes[0].name : '')])]);
  for (const t of takes) tk.add('Take', [p.S(t.name)], [new N('FileName', [p.S(`${t.name}.tak`)]),
    new N('LocalTime', [p.L(0), p.L(t.stop)]), new N('ReferenceTime', [p.L(0), p.L(t.stop)])]);
  top.push(tk);
  const bytes = await serialize(top);
  return { bytes, stats: { bones: bones.length + (virtualRoot ? 1 : 0), meshes: meshIndex, takes: takes.length, textures: images.size, materials: matId.size } };
}
