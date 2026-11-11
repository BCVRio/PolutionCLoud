// Pre-processes the Europe land point cloud from Natural Earth (via the
// world-atlas package). Run once: `npm run build:europe`.
//
// Outputs in public/data/:
//   europe.json        bbox, counts, mask dimensions
//   europe-land.bin    Uint16 pairs (x, y) normalised to the bbox, on lat scan rows
//   europe-coast.bin   Uint16 pairs along coastlines
//   europe-mask.bin    Uint8 land mask, row-major, maskW x maskH, row 0 = latMax
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import mapping from '../config/mapping.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'data');
fs.mkdirSync(out, { recursive: true });

const bbox = mapping.europe.bbox;
const LAT_STEP = 0.06;          // scan row spacing (degrees)
const LON_STEP = 0.06;          // sample spacing along a row
const COAST_STEP = 0.025;       // coast point spacing (degrees)
const MASK_W = 440, MASK_H = 280;

const topo = JSON.parse(fs.readFileSync(path.join(here, '..', 'node_modules', 'world-atlas', 'land-50m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);

// Collect every ring as an array of [lon, lat] that touches the bbox.
const rings = [];
for (const f of land.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) for (const ring of poly) {
    let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
    for (const [x, y] of ring) { if (x < minLon) minLon = x; if (x > maxLon) maxLon = x; if (y < minLat) minLat = y; if (y > maxLat) maxLat = y; }
    if (maxLon < bbox.lonMin || minLon > bbox.lonMax || maxLat < bbox.latMin || minLat > bbox.latMax) continue;
    rings.push(ring);
  }
}

// Deterministic jitter so the output is reproducible.
let seed = 1234567;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// Horizontal spans of land at a given latitude, from edge crossings (even-odd rule).
function spansAt(lat) {
  const xs = [];
  for (const ring of rings) {
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      if ((y0 <= lat) !== (y1 <= lat)) xs.push(x0 + (lat - y0) * (x1 - x0) / (y1 - y0));
    }
  }
  xs.sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const a = Math.max(xs[i], bbox.lonMin), b = Math.min(xs[i + 1], bbox.lonMax);
    if (b > a) spans.push([a, b]);
  }
  return spans;
}

const lonSpan = bbox.lonMax - bbox.lonMin, latSpan = bbox.latMax - bbox.latMin;
const norm = (lon, lat) => [Math.round((lon - bbox.lonMin) / lonSpan * 65535), Math.round((lat - bbox.latMin) / latSpan * 65535)];

// Land points on scan rows.
const landPts = [];
for (let lat = bbox.latMin + LAT_STEP / 2; lat < bbox.latMax; lat += LAT_STEP) {
  const spans = spansAt(lat);
  for (const [a, b] of spans) {
    for (let lon = a + rnd() * LON_STEP; lon < b; lon += LON_STEP) {
      const [x, y] = norm(lon, lat + (rnd() - 0.5) * LAT_STEP * 0.15);
      landPts.push(x, y);
    }
  }
}

// Coast points along ring edges inside the bbox.
const coastPts = [];
for (const ring of rings) {
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / COAST_STEP));
    for (let s = 0; s < steps; s++) {
      const t = (s + rnd()) / steps;
      const lon = x0 + (x1 - x0) * t, lat = y0 + (y1 - y0) * t;
      if (lon < bbox.lonMin || lon > bbox.lonMax || lat < bbox.latMin || lat > bbox.latMax) continue;
      const [x, y] = norm(lon, lat);
      coastPts.push(x, y);
    }
  }
}

// Land mask for streamline particles.
const mask = new Uint8Array(MASK_W * MASK_H);
for (let j = 0; j < MASK_H; j++) {
  const lat = bbox.latMax - (j + 0.5) / MASK_H * latSpan;
  for (const [a, b] of spansAt(lat)) {
    const i0 = Math.max(0, Math.floor((a - bbox.lonMin) / lonSpan * MASK_W));
    const i1 = Math.min(MASK_W - 1, Math.ceil((b - bbox.lonMin) / lonSpan * MASK_W));
    for (let i = i0; i <= i1; i++) mask[j * MASK_W + i] = 1;
  }
}

fs.writeFileSync(path.join(out, 'europe-land.bin'), Buffer.from(new Uint16Array(landPts).buffer));
fs.writeFileSync(path.join(out, 'europe-coast.bin'), Buffer.from(new Uint16Array(coastPts).buffer));
fs.writeFileSync(path.join(out, 'europe-mask.bin'), Buffer.from(mask.buffer));
fs.writeFileSync(path.join(out, 'europe.json'), JSON.stringify({
  bbox, land: landPts.length / 2, coast: coastPts.length / 2, maskW: MASK_W, maskH: MASK_H,
  source: 'Natural Earth 1:50m land via world-atlas',
}, null, 2));
console.log(`land ${landPts.length / 2} pts, coast ${coastPts.length / 2} pts, mask ${MASK_W}x${MASK_H}`);
