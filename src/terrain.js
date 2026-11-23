// Test ground for the preview: flat floor, or a course with rocks, a step, a ramp and stairs, sized to the creature.
import * as THREE from 'three';

const _ray = new THREE.Raycaster();
const _o = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

export class Terrain {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    scene.add(this.group);
    this.solids = [];
    this.H = 1;
    this.kind = 'course';
    this.seed = 7;
  }

  /** Path the creature follows in "Course" mode: a rounded loop through the obstacles. */
  pathPoint(s, out = new THREE.Vector3()) {
    const R = this.H * 5.5;
    const a = s / R;
    return out.set(Math.sin(a) * R * 1.25, 0, Math.cos(a) * R - R);
  }

  build(H, kind = this.kind) {
    this.H = H;
    this.kind = kind;
    for (const c of [...this.group.children]) { this.group.remove(c); c.geometry?.dispose(); }
    this.solids = [];

    // the grid texture carries the colour (material colour multiplies it)
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    floorMat.map = gridTexture();
    floorMat.map.repeat.set(40, 40);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(H * 60, H * 60), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'Floor';
    this.group.add(floor);
    this.solids.push(floor);
    if (kind === 'flat') return;

    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8e8a84, roughness: 0.9, flatShading: true });
    const propMat = new THREE.MeshStandardMaterial({ color: 0xa4a6ad, roughness: 0.8 });
    const rand = mulberry(this.seed);
    const add = (mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; this.group.add(mesh); this.solids.push(mesh); };
    const L = 2 * Math.PI * H * 5.5;

    // rocks scattered along and beside the path
    for (let i = 0; i < 26; i++) {
      const s = (i / 26) * L + rand() * H;
      const p = this.pathPoint(s);
      const side = (rand() - 0.5) * H * 1.1;
      const tangent = this.pathPoint(s + 0.01).sub(p).normalize();
      const nrm = new THREE.Vector3(tangent.z, 0, -tangent.x);
      p.addScaledVector(nrm, side);
      if (i % 6 === 2) continue; // gaps for the props
      const r = H * (0.12 + rand() * 0.22);
      const g = new THREE.IcosahedronGeometry(r, 1);
      const pos = g.attributes.position;
      // the same bump for every copy of a vertex (the geometry is not indexed), so faces stay closed
      const seed = rand() * 100;
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
        const h = Math.sin((x * 12.9898 + y * 78.233 + z * 37.719) / r + seed) * 43758.5453;
        const f = 0.82 + (h - Math.floor(h)) * 0.3;
        pos.setXYZ(k, x * f, y * f * 0.55, z * f);
      }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, rockMat);
      m.position.set(p.x, r * 0.12, p.z);
      m.rotation.y = rand() * Math.PI;
      add(m);
    }

    const placeOnPath = (s, mesh, yOff) => {
      const p = this.pathPoint(s);
      const q = this.pathPoint(s + 0.01).sub(p);
      mesh.position.set(p.x, yOff, p.z);
      mesh.rotation.y = Math.atan2(q.x, q.z);
      add(mesh);
    };
    // a step up and down
    placeOnPath(L * 0.12, new THREE.Mesh(new THREE.BoxGeometry(H * 2.2, H * 0.14, H * 1.6), propMat), H * 0.07);
    // a ramp (wedge) — a thin, tilted box lying on the path
    {
      const len = H * 3, rise = H * 0.45;
      const g = new THREE.BoxGeometry(H * 2.4, H * 0.06, Math.hypot(len, rise));
      const m = new THREE.Mesh(g, propMat);
      const s = L * 0.35;
      const p = this.pathPoint(s), q = this.pathPoint(s + 0.01).sub(p);
      const yaw = Math.atan2(q.x, q.z);
      m.position.set(p.x, rise / 2, p.z);
      m.rotation.set(0, 0, 0);
      m.rotateY(yaw);
      m.rotateX(-Math.atan2(rise, len));
      add(m);
      // top platform, then a ramp back down
      const top = new THREE.Mesh(new THREE.BoxGeometry(H * 2.4, rise, H * 1.4), propMat);
      const p2 = this.pathPoint(s + len / 2 + H * 0.7);
      top.position.set(p2.x, rise / 2, p2.z);
      top.rotation.y = yaw;
      add(top);
      const down = new THREE.Mesh(g.clone(), propMat);
      const s3 = s + len + H * 1.4;
      const p3 = this.pathPoint(s3), q3 = this.pathPoint(s3 + 0.01).sub(p3);
      down.position.set(p3.x, rise / 2, p3.z);
      down.rotateY(Math.atan2(q3.x, q3.z));
      down.rotateX(Math.atan2(rise, len));
      add(down);
    }
    // stairs
    {
      const s0 = L * 0.62;
      for (let k = 0; k < 4; k++) {
        const h = H * 0.08 * (k + 1);
        placeOnPath(s0 + k * H * 0.45, new THREE.Mesh(new THREE.BoxGeometry(H * 2.4, h, H * 0.45), propMat), h / 2);
      }
      for (let k = 3; k >= 0; k--) {
        const h = H * 0.08 * (k + 1);
        placeOnPath(s0 + (7 - k) * H * 0.45, new THREE.Mesh(new THREE.BoxGeometry(H * 2.4, h, H * 0.45), propMat), h / 2);
      }
    }
    // a low hill
    {
      const g = new THREE.SphereGeometry(H * 2.2, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(1, 0.16, 1);
      const m = new THREE.Mesh(g, rockMat);
      placeOnPath(L * 0.85, m, 0);
    }
  }

  /** Ground height under (x, z): the highest hit among a small ring of rays (a cheap sphere cast). */
  heightAt(x, z, radius = 0, from = Infinity) {
    let best = -Infinity;
    const top = Math.min(from, this.H * 4);
    const pts = radius > 0 ? [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]] : [[0, 0]];
    for (const [dx, dz] of pts) {
      _o.set(x + dx, top, z + dz);
      _ray.set(_o, DOWN);
      _ray.far = this.H * 8;
      const hit = _ray.intersectObjects(this.solids, false)[0];
      const y = hit ? hit.point.y : 0;
      if (y > best) best = y;
    }
    return best === -Infinity ? 0 : best;
  }

  /** Surface normal under (x, z) from three height samples. */
  normalAt(x, z, d, out = new THREE.Vector3()) {
    const h0 = this.heightAt(x, z), hx = this.heightAt(x + d, z), hz = this.heightAt(x, z + d);
    return out.set(h0 - hx, d, h0 - hz).normalize();
  }
}

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#5a5a5f'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#525257'; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 2; g.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
