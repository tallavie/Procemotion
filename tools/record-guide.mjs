// Records the how-to GIFs of the guide (public/guide/) from the running app. Development only, not part of the site.
//
//   1. npm run dev                      (the app on http://localhost:5184)
//   2. node tools/record-guide.mjs      (all clips)   or   node tools/record-guide.mjs walk flight   (some)
//
// Headless Microsoft Edge shows the app; the DevTools protocol (Node's built-in WebSocket) takes a picture of the
// page several times a second while a script drives the app (loading a sample, clicking, dragging a box). Frames
// are reduced to one palette of up to 255 colours and written as an animated GIF that stores only what changed
// between frames. Nothing to install besides Node and Edge.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'guide');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP = process.env.APP || 'http://localhost:5184/app/';
const W = 1280, H = 800, SCALE = 0.5;          // page size and the size of the GIF relative to it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ PNG -> RGBA
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += bpp) { rgb[i * 3] = px[j]; rgb[i * 3 + 1] = px[j + 1]; rgb[i * 3 + 2] = px[j + 2]; }
  return { w, h, rgb };
}

// ------------------------------------------------------------------ palette (median cut over all frames)
function palette(frames) {
  const hist = new Map();
  for (const f of frames) for (let i = 0; i < f.rgb.length; i += 9) {   // every third pixel is plenty
    const k = ((f.rgb[i] >> 3) << 10) | ((f.rgb[i + 1] >> 3) << 5) | (f.rgb[i + 2] >> 3);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let boxes = [[...hist.entries()].map(([k, n]) => [(k >> 10) & 31, (k >> 5) & 31, k & 31, n])];
  while (boxes.length < 255) {
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes.shift();
    if (box.length < 2) { boxes.push(box); break; }
    const range = [0, 1, 2].map((c) => Math.max(...box.map((e) => e[c])) - Math.min(...box.map((e) => e[c])));
    const c = range.indexOf(Math.max(...range));
    box.sort((a, b) => a[c] - b[c]);
    let total = box.reduce((s, e) => s + e[3], 0), acc = 0, cut = 1;
    for (let i = 0; i < box.length; i++) { acc += box[i][3]; if (acc >= total / 2) { cut = Math.max(1, Math.min(box.length - 1, i)); break; } }
    boxes.push(box.slice(0, cut), box.slice(cut));
  }
  const pal = boxes.map((b) => {
    const n = b.reduce((s, e) => s + e[3], 0) || 1;
    return [0, 1, 2].map((c) => Math.round(b.reduce((s, e) => s + e[c] * e[3], 0) / n * 255 / 31));
  });
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (cache[k] >= 0) return cache[k];
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) { const d = (pal[i][0] - r) ** 2 + (pal[i][1] - g) ** 2 + (pal[i][2] - b) ** 2; if (d < bd) { bd = d; best = i; } }
    cache[k] = best;
    return best;
  };
  return { pal, nearest };
}

// ------------------------------------------------------------------ GIF writer
function lzw(indices, minCode) {
  const out = []; let cur = 0, bits = 0;
  const put = (code, size) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1, dict = new Map();
  put(clear, size);
  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = w * 4096 + k;
    if (dict.has(key)) { w = dict.get(key); continue; }
    put(w, size);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { put(clear, size); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    w = k;
  }
  put(w, size); put(eoi, size);
  if (bits) out.push(cur & 255);
  return Buffer.from(out);
}
function writeGIF(file, frames, delayCs) {
  const { w, h } = frames[0];
  const { pal, nearest } = palette(frames);
  const TRANSP = 255;
  const parts = [Buffer.from('GIF89a')];
  const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2); lsd[4] = 0xf7; parts.push(lsd);
  const ct = Buffer.alloc(256 * 3); pal.forEach((c, i) => { ct[i * 3] = c[0]; ct[i * 3 + 1] = c[1]; ct[i * 3 + 2] = c[2]; }); parts.push(ct);
  parts.push(Buffer.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0]));   // loop forever
  let prev = null;
  for (const f of frames) {
    const idx = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) idx[i] = nearest(f.rgb[i * 3], f.rgb[i * 3 + 1], f.rgb[i * 3 + 2]);
    // only the rectangle that changed, unchanged pixels inside it transparent
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    if (prev) {
      x0 = w; y0 = h; x1 = -1; y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (idx[y * w + x] !== prev[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) { x0 = y0 = 0; x1 = y1 = 0; }
    }
    const fw = x1 - x0 + 1, fh = y1 - y0 + 1, sub = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const i = (y + y0) * w + x + x0;
      sub[y * fw + x] = prev && idx[i] === prev[i] ? TRANSP : idx[i];
    }
    parts.push(Buffer.from([0x21, 0xf9, 4, prev ? 0x05 : 0x04, delayCs & 255, delayCs >> 8, TRANSP, 0]));
    const id = Buffer.alloc(10); id[0] = 0x2c; id.writeUInt16LE(x0, 1); id.writeUInt16LE(y0, 3); id.writeUInt16LE(fw, 5); id.writeUInt16LE(fh, 7); parts.push(id);
    const data = lzw(sub, 8);
    parts.push(Buffer.from([8]));
    for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); parts.push(Buffer.from([n]), data.subarray(i, i + n)); }
    parts.push(Buffer.from([0]));
    prev = idx;
  }
  parts.push(Buffer.from([0x3b]));
  fs.writeFileSync(file, Buffer.concat(parts));
  return fs.statSync(file).size;
}

// ------------------------------------------------------------------ the browser
const port = 9334, prof = path.join(os.tmpdir(), 'procemotion_guide_edge');
const edge = spawn(EDGE, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
let ver;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let mid = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++mid; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

async function record(name, { url, steps, fps = 7, delayCs }) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  const run = (expr) => send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true }, sessionId);
  await send('Page.navigate', { url: APP + (url || '') }, sessionId);
  await sleep(1500);
  await run('try { localStorage.clear(); } catch {}');
  const frames = [];
  const grab = async () => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: SCALE } }, sessionId);
    const png = Buffer.from(r.result.data, 'base64');
    frames.push(decodePNG(png));
    if (process.env.KEEP_LAST) fs.writeFileSync(path.join(os.tmpdir(), name + '-last.png'), png);
  };
  for (const s of steps) {
    if (s.js) await run(s.js);
    if (s.wait) await sleep(s.wait * 1000);
    const n = Math.round((s.frames || 0));
    for (let i = 0; i < n; i++) { const t = Date.now(); await grab(); await sleep(Math.max(0, 1000 / fps - (Date.now() - t))); }
  }
  await send('Target.closeTarget', { targetId });
  const size = writeGIF(path.join(OUT, `${name}.gif`), frames, delayCs || Math.round(100 / fps));
  console.log(`${name}.gif  ${frames.length} frames  ${(size / 1048576).toFixed(2)} MB`);
}

// helpers run inside the page
const pageHelpers = `
  window.__arm = (t) => document.querySelector('#clsTypes [data-type="' + t + '"], [data-pick="' + t + '"], #clsAdd[data-type="' + t + '"]').click();
  window.__scr = (name) => { const b = LF.S.creature.bones.find((x) => x.name.startsWith(name)); const v = b.getWorldPosition(new b.position.constructor()).project(LF.camera); const r = document.querySelector('#view').getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; };
  window.__rect = (re) => { const ps = LF.S.creature.bones.filter((b) => re.test(b.name)).map((b) => __scr(b.name)); return [Math.min(...ps.map((p) => p[0])) - 8, Math.min(...ps.map((p) => p[1])) - 8, Math.max(...ps.map((p) => p[0])) + 8, Math.max(...ps.map((p) => p[1])) + 8]; };
  window.__dragStart = ([x0, y0, x1, y1]) => { const cv = document.querySelector('#view'); window.__d = { cv, x0, y0, x1, y1 }; cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, buttons: 1, clientX: x0, clientY: y0 })); };
  window.__dragTo = (t) => { const d = window.__d; d.cv.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, button: 0, buttons: 1, clientX: d.x0 + (d.x1 - d.x0) * t, clientY: d.y0 + (d.y1 - d.y0) * t })); };
  window.__dragEnd = () => { const d = window.__d; d.cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0, clientX: d.x1, clientY: d.y1 })); };
`;
const drag = (re, steps = 6) => [
  { js: `${pageHelpers} __dragStart(__rect(${re}));`, frames: 1 },
  ...Array.from({ length: steps }, (_, i) => ({ js: `__dragTo(${(i + 1) / steps});`, frames: 1 })),
  { js: '__dragEnd();', frames: 10 },
];

const CLIPS = {
  // 1. a sample from the empty screen
  open: { url: '', steps: [
    { wait: 1, frames: 6 },
    { js: `[...document.querySelectorAll('#demoChips .chip')][0].click();`, frames: 40 },
  ] },
  // 2. the limbs it found (Rig view), clicking through the list
  limbs: { url: '?demo=spider&mode=rig', steps: [
    { wait: 4, frames: 6 },
    ...[0, 1, 2, 3, 8].map((i) => ({ js: `[...document.querySelectorAll('#limbList .item')][${i}].click();`, frames: 6 })),
    { js: `[...document.querySelectorAll('#limbList .item')][8].click();`, frames: 6 },
  ] },
  // 3. classifying bones by hand: clear the wolf's parts, then box its legs, tail and ears in the Bone classes panel
  classes: { url: '?demo=wolf&mode=rig', fps: 6, steps: [
    { wait: 4, frames: 5 },
    { js: `document.querySelector('#clsClear').click();`, frames: 6 },
    { js: `${pageHelpers} __arm('leg');`, frames: 3 },
    ...drag('/^front_paw/'),
    ...drag('/^hind_paw/'),
    { js: `${pageHelpers} __arm('tail');`, frames: 3 },
    ...drag('/^tail/'),
    { js: `${pageHelpers} __arm('ear');`, frames: 3 },
    ...drag('/^ear/'),
    { js: `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`, frames: 14 },
  ] },
  // 4. walking into a gallop
  gallop: { url: '?demo=wolf&mode=anim', steps: [
    { wait: 3, frames: 16 },
    { js: `const s = document.querySelector('#p_movement_speed'); s.value = 0.95; s.dispatchEvent(new Event('input', { bubbles: true }));`, frames: 40 },
  ] },
  // 5. eight legs on the obstacle course
  spider: { url: '?demo=spider&mode=anim', steps: [{ wait: 3, frames: 40 }] },
  // 6. flight: take-off
  flight: { url: '?demo=dragon&mode=anim', fps: 7, steps: [
    { wait: 6, frames: 8 },
    { js: `LF.S.motion.params.flight.on = true; LF.refreshAll();`, frames: 42 },
  ] },
  // 7. slithering
  slither: { url: '?demo=snake&mode=anim', steps: [{ wait: 3, frames: 40 }] },
};

const pick = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
for (const [name, clip] of Object.entries(CLIPS)) {
  if (pick.length && !pick.includes(name)) continue;
  try { await record(name, clip); } catch (e) { console.error(name, 'failed:', e.message); }
}
ws.close();
edge.kill();
process.exit(0);
