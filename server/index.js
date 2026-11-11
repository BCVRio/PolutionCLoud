// Common Air local service: polls the APIs, serves the render pages and
// publishes state over WebSocket. One process, one port.
//
//   node server/index.js               dev: Vite middleware with hot reload
//   node server/index.js --serve-dist  production: serves the built dist/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { app, ROOT } from './config.js';
import { Engine } from './engine.js';

const serveDist = process.argv.includes('--serve-dist');
const port = Number(process.env.PORT || app.port);
const engine = new Engine();
engine.on('log', (m) => console.log(new Date().toISOString(), m));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Small JSON API for anything that is not a render page (tracking bridges, tests).
async function api(req, res, url) {
  if (url.pathname === '/api/state') return sendJson(res, engine.frame || { type: 'frame', waiting: true });
  if (url.pathname === '/api/hello') return sendJson(res, engine.hello());
  if (url.pathname === '/api/series') return sendJson(res, { airquality: engine.aq, weather: engine.wx });
  if (url.pathname === '/api/health') return sendJson(res, { ok: true, mode: engine.mode, hasData: engine.hasData(), status: engine.status });
  if (url.pathname === '/api/set' && req.method === 'POST') {
    const body = await readBody(req); engine.set(JSON.parse(body || '{}')); return sendJson(res, { ok: true });
  }
  if (url.pathname === '/api/visitor' && req.method === 'POST') {
    const body = await readBody(req); engine.visitorAt(JSON.parse(body || '{}')); return sendJson(res, { ok: true, active: engine.visitor });
  }
  res.writeHead(404); res.end('not found');
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => resolve(b)); });
}

function serveStatic(req, res, url) {
  const dist = path.join(ROOT, 'dist');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');   // SPA fallback
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

let vite = null;
if (!serveDist) {
  const { createServer } = await import('vite');
  vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: { port: port + 1 } }, appType: 'spa' });
} else if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ not found. Run `npm run build` first, or use `npm run dev`.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch((e) => { res.writeHead(500); res.end(e.message); });
  if (vite) return vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
  return serveStatic(req, res, url);
});

// WebSocket: every render page and the control page connect here.
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(engine.hello()));
  if (engine.frame) ws.send(JSON.stringify(engine.frame));
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'set') engine.set(msg);
    else if (msg.type === 'visitor') engine.visitorAt(msg);
  });
  ws.on('error', () => {});
});
engine.on('frame', (f) => {
  if (!wss.clients.size) return;
  const s = JSON.stringify(f);
  for (const c of wss.clients) if (c.readyState === 1 && c.bufferedAmount < 1e6) c.send(s);
});

engine.start();
server.listen(port, () => {
  console.log(`Common Air  http://localhost:${port}/   (${serveDist ? 'serving dist/' : 'dev mode'})`);
  console.log(`  floor  http://localhost:${port}/floor      city  http://localhost:${port}/city`);
  console.log(`  scrims /scrim-no2 /scrim-pm /scrim-o3      control  http://localhost:${port}/control`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { engine.stop(); server.close(); process.exit(0); });
