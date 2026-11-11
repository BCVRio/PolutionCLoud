// Pre-processes OpenStreetMap buildings and streets for each city centre into
// a compact binary file in public/data/cities/<slug>.bin. Run once:
//   npm run build:cities              all cities
//   node tools/build-cities.mjs milan one city
// Raw Overpass responses are cached in data/osm/ so re-runs are offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCity, ROAD_CLASSES } from './city-format.mjs';
import mapping from '../config/mapping.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/cities.json'), 'utf8'));
const OUT = path.join(ROOT, 'public/data/cities'); fs.mkdirSync(OUT, { recursive: true });
const RAW = path.join(ROOT, 'data/osm'); fs.mkdirSync(RAW, { recursive: true });
const EXTENT = mapping.city.extentM;
const ENDPOINTS = (process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []).concat(['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']);
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function bboxFor(c) {
  const half = EXTENT / 2 * 1.05;
  const dLat = half / 111320, dLon = half / (111320 * Math.cos(c.lat * Math.PI / 180));
  return [c.lat - dLat, c.lon - dLon, c.lat + dLat, c.lon + dLon].map(v => v.toFixed(5)).join(',');
}

async function overpass(query, slug) {
  const file = path.join(RAW, `${slug}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'user-agent': 'common-air-build/0.1' }, signal: AbortSignal.timeout(240e3) });
      if (res.status === 429 || res.status === 504) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      fs.writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (e) {
      lastErr = e; console.warn(`  ${url} failed (${e.message}), retrying…`);
      await sleep(5000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function parseHeight(tags, id) {
  const h = parseFloat(String(tags.height || '').replace(/[^\d.]/g, ''));
  if (h > 0 && h < 400) return h;
  const lv = parseFloat(tags['building:levels']);
  if (lv > 0 && lv < 120) return lv * 3.2 + 1.5;
  const t = tags.building;
  const base = { house: 7, detached: 7, garage: 3, garages: 3, shed: 3, hut: 3, roof: 4, church: 22, cathedral: 35, industrial: 10, warehouse: 10, retail: 9, school: 11, apartments: 18, office: 20, hotel: 24, commercial: 16, residential: 15 }[t] ?? 13;
  return base * (0.85 + ((id * 2654435761 >>> 0) % 1000) / 1000 * 0.3);
}

function roadClass(hw) {
  const c = String(hw).replace('_link', '');
  const i = ROAD_CLASSES.indexOf(c);
  if (i >= 0) return i;
  if (['unclassified', 'living_street', 'service', 'pedestrian', 'road'].includes(c)) return 6;
  return -1;        // footways, paths, etc. are not streets for our purpose
}

function processCity(c, json) {
  const k = 111320, kx = k * Math.cos(c.lat * Math.PI / 180);
  const nodes = new Map();
  for (const el of json.elements) if (el.type === 'node') nodes.set(el.id, [(el.lon - c.lon) * kx, (el.lat - c.lat) * k]);
  const inside = (p) => Math.abs(p[0]) <= EXTENT / 2 && Math.abs(p[1]) <= EXTENT / 2;
  const buildings = [], roads = [];
  const ways = new Map();
  for (const el of json.elements) if (el.type === 'way') ways.set(el.id, el);

  const addBuilding = (coords, tags, id) => {
    if (coords.length < 3) return;
    let cx = 0, cy = 0; for (const p of coords) { cx += p[0]; cy += p[1]; }
    if (!inside([cx / coords.length, cy / coords.length])) return;
    buildings.push({ height: parseHeight(tags || {}, id), verts: Float32Array.from(coords.flat()) });
  };
  for (const el of json.elements) {
    if (el.type === 'way' && el.tags?.building) {
      const pts = el.nodes.map(n => nodes.get(n)).filter(Boolean);
      if (pts.length > 1 && pts[0] === pts[pts.length - 1]) pts.pop();
      addBuilding(pts, el.tags, el.id);
    } else if (el.type === 'relation' && el.tags?.building && el.members) {
      // Multipolygon buildings: outer ways only, each as its own footprint.
      for (const m of el.members) if (m.type === 'way' && m.role === 'outer') {
        const w = ways.get(m.ref); if (!w || w.tags?.building) continue;
        const pts = w.nodes.map(n => nodes.get(n)).filter(Boolean);
        if (pts.length > 1 && pts[0] === pts[pts.length - 1]) pts.pop();
        addBuilding(pts, el.tags, el.id);
      }
    } else if (el.type === 'way' && el.tags?.highway) {
      const cls = roadClass(el.tags.highway); if (cls < 0) continue;
      let run = [];
      const flush = () => { if (run.length >= 2) roads.push({ cls, verts: Float32Array.from(run.flat()) }); run = []; };
      for (const n of el.nodes) { const p = nodes.get(n); if (p && inside(p)) run.push(p); else flush(); }
      flush();
    }
  }
  return { buildings, roads };
}

async function build(c) {
  console.log(`${c.name}: fetching…`);
  const bbox = bboxFor(c);
  const q = `[out:json][timeout:180];(way["building"](${bbox});relation["building"]["type"="multipolygon"](${bbox});way["highway"](${bbox}););(._;>;);out body;`;
  const json = await overpass(q, c.slug);
  const { buildings, roads } = processCity(c, json);
  const buf = encodeCity({ lat: c.lat, lon: c.lon, extentM: EXTENT, buildings, roads });
  fs.writeFileSync(path.join(OUT, `${c.slug}.bin`), Buffer.from(buf));
  console.log(`  ${buildings.length} buildings, ${roads.length} street segments, ${(buf.byteLength / 1024).toFixed(0)} kB`);
}

for (const c of cities) {
  if (only.length && !only.includes(c.slug)) continue;
  try { await build(c); } catch (e) { console.error(`  ${c.name} failed: ${e.message}`); }
  await sleep(3000);
}
