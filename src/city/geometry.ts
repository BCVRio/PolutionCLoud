// Loads a pre-processed city file (see tools/city-format.mjs) or builds the
// placeholder grid city, then samples points for the lidar-style building
// cloud, the street emitters and a roof-height texture.
import * as THREE from 'three';

export interface Building { height: number; verts: Float32Array; }   // xy pairs, metres, x east, y north
export interface Road { cls: number; verts: Float32Array; }
export interface CityGeometry { lat: number; lon: number; extentM: number; buildings: Building[]; roads: Road[]; placeholder: boolean; }

export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'other'];

export function decodeCity(buf: ArrayBuffer): CityGeometry {
  const dv = new DataView(buf);
  let o = 0;
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)); o = 4;
  if (magic !== 'CAC1') throw new Error('not a city file');
  const nb = dv.getUint32(o, true); o += 4; const nr = dv.getUint32(o, true); o += 4;
  const lat = dv.getFloat32(o, true); o += 4; const lon = dv.getFloat32(o, true); o += 4; const extentM = dv.getFloat32(o, true); o += 4;
  const buildings: Building[] = [], roads: Road[] = [];
  for (let i = 0; i < nb; i++) {
    const n = dv.getUint16(o, true); o += 2; const height = dv.getFloat32(o, true); o += 4;
    const verts = new Float32Array(n * 2);
    for (let k = 0; k < n * 2; k++) { verts[k] = dv.getInt16(o, true) / 10; o += 2; }
    buildings.push({ height, verts });
  }
  for (let i = 0; i < nr; i++) {
    const cls = dv.getUint8(o++); const n = dv.getUint16(o, true); o += 2;
    const verts = new Float32Array(n * 2);
    for (let k = 0; k < n * 2; k++) { verts[k] = dv.getInt16(o, true) / 10; o += 2; }
    roads.push({ cls, verts });
  }
  return { lat, lon, extentM, buildings, roads, placeholder: false };
}

export async function loadCity(slug: string, lat: number, lon: number, extentM: number): Promise<CityGeometry> {
  try {
    const res = await fetch(`/data/cities/${slug}.bin`);
    if (!res.ok) throw new Error(String(res.status));
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 24) throw new Error('empty');
    return decodeCity(buf);
  } catch {
    return placeholderCity(lat, lon, extentM, slug);
  }
}

// Placeholder only: a generated grid city, as in the reference script.
export function placeholderCity(lat: number, lon: number, extentM: number, seedStr: string): CityGeometry {
  let s = 0; for (const ch of seedStr) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const buildings: Building[] = [], roads: Road[] = [];
  const block = 110, street = 18, half = extentM / 2;
  for (let bx = -half; bx < half; bx += block + street) {
    for (let by = -half; by < half; by += block + street) {
      const cols = 2 + Math.floor(rnd() * 2), rows = 2 + Math.floor(rnd() * 2);
      const w = block / cols, h = block / rows;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        if (rnd() < 0.12) continue;
        const x0 = bx + i * w + 2, y0 = by + j * h + 2, x1 = x0 + w - 4, y1 = y0 + h - 4;
        const d = Math.hypot((x0 + x1) / 2, (y0 + y1) / 2) / half;
        const height = 8 + rnd() * 14 + (1 - d) ** 2 * (rnd() < 0.08 ? 90 : 30);
        buildings.push({ height, verts: Float32Array.from([x0, y0, x1, y0, x1, y1, x0, y1]) });
      }
    }
    roads.push({ cls: Math.abs(Math.round(bx / (block + street))) % 4 === 0 ? 2 : 5, verts: Float32Array.from([bx - street / 2, -half, bx - street / 2, half]) });
    roads.push({ cls: Math.abs(Math.round(bx / (block + street))) % 3 === 0 ? 3 : 5, verts: Float32Array.from([-half, bx - street / 2, half, bx - street / 2]) });
  }
  return { lat, lon, extentM, buildings, roads, placeholder: true };
}

// Scene coordinates are Y-up: (x east, y height, z = -north).
// Returns positions (xyz) and a 'kind' attribute: 0 roof, 1 wall.
export function sampleBuildings(city: CityGeometry, count: number, scanRowM: number): { pos: Float32Array; kind: Float32Array } {
  const pos = new Float32Array(count * 3), kind = new Float32Array(count);
  let s = 99991; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  // Weights: roofs by area, walls by perimeter x height (so tall facades get rows).
  const roofW: number[] = [], wallW: number[] = [];
  const tris: Array<Array<[number, number, number]>> = [];
  let roofTotal = 0, wallTotal = 0;
  for (const b of city.buildings) {
    const n = b.verts.length / 2;
    const pts: THREE.Vector2[] = []; for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(b.verts[i * 2], b.verts[i * 2 + 1]));
    let tri: number[][] = [];
    try { tri = THREE.ShapeUtils.triangulateShape(pts, []); } catch { tri = []; }
    const tl: Array<[number, number, number]> = [];
    let area = 0;
    for (const t of tri) { const a = pts[t[0]], bb = pts[t[1]], c = pts[t[2]]; const ar = Math.abs((bb.x - a.x) * (c.y - a.y) - (c.x - a.x) * (bb.y - a.y)) / 2; tl.push([t[0], t[1], t[2]]); area += ar; }
    tris.push(tl); roofW.push(area); roofTotal += area;
    let per = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; per += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y); }
    const w = per * b.height; wallW.push(w); wallTotal += w;
  }
  const roofCount = Math.floor(count * 0.32), wallCount = count - roofCount;
  const pick = (weights: number[], total: number) => { let r = rnd() * total; for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; } return weights.length - 1; };
  // Cumulative tables for faster picking.
  const cum = (w: number[]) => { const c = new Float64Array(w.length); let a = 0; for (let i = 0; i < w.length; i++) { a += w[i]; c[i] = a; } return c; };
  const roofC = cum(roofW), wallC = cum(wallW);
  const pickC = (c: Float64Array, total: number) => { const r = rnd() * total; let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < r) lo = m + 1; else hi = m; } return lo; };
  void pick;

  let k = 0;
  for (let i = 0; i < roofCount && city.buildings.length; i++, k++) {
    const bi = pickC(roofC, roofTotal); const b = city.buildings[bi]; const tl = tris[bi];
    if (!tl.length) { const x = b.verts[0], y = b.verts[1]; pos[k * 3] = x; pos[k * 3 + 1] = b.height; pos[k * 3 + 2] = -y; kind[k] = 0; continue; }
    const t = tl[Math.floor(rnd() * tl.length)];
    let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const ax = b.verts[t[0] * 2], ay = b.verts[t[0] * 2 + 1], bx = b.verts[t[1] * 2], by = b.verts[t[1] * 2 + 1], cx = b.verts[t[2] * 2], cy = b.verts[t[2] * 2 + 1];
    pos[k * 3] = ax + (bx - ax) * u + (cx - ax) * v; pos[k * 3 + 1] = b.height + rnd() * 0.3; pos[k * 3 + 2] = -(ay + (by - ay) * u + (cy - ay) * v); kind[k] = 0;
  }
  for (let i = 0; i < wallCount && city.buildings.length; i++, k++) {
    const bi = pickC(wallC, wallTotal); const b = city.buildings[bi]; const n = b.verts.length / 2;
    const e = Math.floor(rnd() * n), j = (e + 1) % n;
    const t = rnd();
    const rows = Math.max(1, Math.floor(b.height / scanRowM));
    const row = Math.floor(rnd() * rows) * scanRowM + scanRowM * 0.5;      // snapped to a scan row
    pos[k * 3] = b.verts[e * 2] + (b.verts[j * 2] - b.verts[e * 2]) * t;
    pos[k * 3 + 1] = Math.min(b.height, row);
    pos[k * 3 + 2] = -(b.verts[e * 2 + 1] + (b.verts[j * 2 + 1] - b.verts[e * 2 + 1]) * t); kind[k] = 1;
  }
  return { pos, kind };
}

// Points along the street network, weighted by road class. Returns xz pairs + class.
export function sampleRoads(city: CityGeometry, count: number, weights: Record<string, number>): { pos: Float32Array; cls: Float32Array } {
  const pos = new Float32Array(count * 2), cls = new Float32Array(count);
  let s = 4242; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const segW: number[] = [], segs: Array<[number, number, number, number, number]> = [];
  let total = 0;
  for (const r of city.roads) {
    const w = weights[ROAD_CLASSES[r.cls]] ?? weights.other ?? 0.1;
    for (let i = 0; i + 1 < r.verts.length / 2; i++) {
      const x0 = r.verts[i * 2], y0 = r.verts[i * 2 + 1], x1 = r.verts[i * 2 + 2], y1 = r.verts[i * 2 + 3];
      const len = Math.hypot(x1 - x0, y1 - y0) * w; if (!(len > 0)) continue;
      segs.push([x0, y0, x1, y1, r.cls]); segW.push(len); total += len;
    }
  }
  const c = new Float64Array(segW.length); let acc = 0; for (let i = 0; i < segW.length; i++) { acc += segW[i]; c[i] = acc; }
  for (let k = 0; k < count; k++) {
    if (!segs.length) { pos[k * 2] = (rnd() - 0.5) * city.extentM; pos[k * 2 + 1] = (rnd() - 0.5) * city.extentM; cls[k] = 6; continue; }
    const r = rnd() * total; let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < r) lo = m + 1; else hi = m; }
    const sg = segs[lo], t = rnd();
    pos[k * 2] = sg[0] + (sg[2] - sg[0]) * t; pos[k * 2 + 1] = -(sg[1] + (sg[3] - sg[1]) * t); cls[k] = sg[4];
  }
  return { pos, cls };
}

// Roof-height texture over the extent (metres encoded 0..255 over maxH), for PM10 landing.
export function heightTexture(city: CityGeometry, size = 512, maxH = 300): { tex: THREE.Texture; maxH: number; meanRoof: number } {
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  const k = size / city.extentM;
  let sum = 0, n = 0;
  for (const b of city.buildings) {
    const g = Math.min(255, Math.round(b.height / maxH * 255));
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.beginPath();
    for (let i = 0; i < b.verts.length / 2; i++) {
      const x = (b.verts[i * 2] + city.extentM / 2) * k, y = (city.extentM / 2 - b.verts[i * 2 + 1]) * k;   // row 0 = north
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
    sum += b.height; n++;
  }
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.flipY = false;
  return { tex, maxH, meanRoof: n ? sum / n : 15 };
}
