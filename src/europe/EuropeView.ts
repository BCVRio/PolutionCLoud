// Europe view (floor projection): point cloud map, a ring and a plume per city,
// wind streamlines across the land. Plume particles live entirely in the
// vertex shader; the streamlines are a small CPU simulation.
import * as THREE from 'three';
import { Stage, GLSL_COMMON, additiveMaterial, hexToVec3, seeds, alphaScale } from '../render/Stage';
import { LabelLayer, fmt, hhmm } from '../render/Labels';
import type { StateClient } from '../net/StateClient';
import type { City, CityState } from '../types';

interface EuropeData { bbox: { lonMin: number; lonMax: number; latMin: number; latMax: number }; land: number; coast: number; maskW: number; maskH: number; }

async function loadBin(url: string) { return new Uint16Array(await (await fetch(url)).arrayBuffer()); }

export async function mountEurope(container: HTMLElement, client: StateClient) {
  const hello = await new Promise<any>((r) => client.onHello(r));
  const M = hello.mapping, E = M.europe, cities: City[] = hello.cities;
  const stage = new Stage(container, { ...M.post, background: M.colours.background });
  const labels = new LabelLayer(container);
  const showLabels = new URLSearchParams(location.search).get('labels') !== '0';

  const meta: EuropeData = await (await fetch('/data/europe.json')).json();
  const [landRaw, coastRaw, maskRaw] = await Promise.all([
    loadBin('/data/europe-land.bin'), loadBin('/data/europe-coast.bin'),
    fetch('/data/europe-mask.bin').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
  ]);

  // Map projection: degrees, with longitude squeezed by cos(mid latitude).
  const bb = meta.bbox;
  const midLat = (bb.latMin + bb.latMax) / 2, midLon = (bb.lonMin + bb.lonMax) / 2;
  const kx = Math.cos(midLat * Math.PI / 180);
  const toXY = (lon: number, lat: number) => [(lon - midLon) * kx, lat - midLat] as const;
  const mapW = (bb.lonMax - bb.lonMin) * kx, mapH = bb.latMax - bb.latMin;

  // Camera: above the map centre, tilted so plumes read as rising.
  const cam = stage.camera;
  const tilt = E.cameraTiltDeg * Math.PI / 180;
  function frameCamera() {
    const fov = cam.fov * Math.PI / 180;
    const need = Math.max(mapH / 2 / Math.tan(fov / 2), mapW / 2 / Math.tan(fov / 2) / cam.aspect) * 1.06;
    cam.position.set(0, -Math.sin(tilt) * need, Math.cos(tilt) * need);
    cam.up.set(0, 0, 1);
    cam.lookAt(0, 0, 0);
  }
  stage.onResize = frameCamera; frameCamera();

  const scene = stage.scene;
  const ps = () => stage.pointScale();

  // ---------------------------------------------------------------- land
  const staticVert = `
    uniform float size; uniform float pscale; uniform float time;
    attribute float seed; varying float vAlpha; varying vec3 vColor;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = size * pscale * (0.75 + 0.5 * seed);
      vAlpha = 0.55 + 0.45 * fract(seed * 7.0 + time * 0.03);
      vColor = vec3(1.0);
    }`;
  function staticPoints(raw: Uint16Array, colour: string, size: number, opacity: number) {
    const n = raw.length / 2;
    const pos = new Float32Array(n * 3), sd = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lon = bb.lonMin + raw[i * 2] / 65535 * (bb.lonMax - bb.lonMin);
      const lat = bb.latMin + raw[i * 2 + 1] / 65535 * (bb.latMax - bb.latMin);
      const [x, y] = toXY(lon, lat); pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = 0;
      sd[i] = ((i * 2654435761) >>> 0) / 4294967296;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(sd, 1));
    const m = additiveMaterial(staticVert, { size: { value: size }, pscale: { value: 1 }, time: { value: 0 }, color: { value: hexToVec3(colour) }, opacity: { value: opacity } });
    const p = new THREE.Points(g, m); scene.add(p); return m;
  }
  const landMat = staticPoints(landRaw, M.colours.land, E.pointSize, 0.9);
  const coastMat = staticPoints(coastRaw, M.colours.coast, E.coastPointSize, 0.8);

  // Faint latitude scan lines every degree.
  {
    const verts: number[] = [];
    for (let lat = Math.ceil(bb.latMin); lat < bb.latMax; lat += 1) { const [x0, y] = toXY(bb.lonMin, lat); const [x1] = toXY(bb.lonMax, lat); verts.push(x0, y, 0, x1, y, 0); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(M.colours.scanline), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
  }

  // ---------------------------------------------------------------- rings
  const N = cities.length;
  const cityXY = cities.map(c => toXY(c.lon, c.lat));
  let ringMat!: THREE.ShaderMaterial;
  {
    const per = E.ringPoints, pos = new Float32Array(N * per * 3), idx = new Float32Array(N * per), sd = new Float32Array(N * per);
    for (let c = 0; c < N; c++) for (let i = 0; i < per; i++) {
      const a = i / per * Math.PI * 2, k = c * per + i;
      pos[k * 3] = cityXY[c][0] + Math.cos(a) * E.ringRadius; pos[k * 3 + 1] = cityXY[c][1] + Math.sin(a) * E.ringRadius * 0.92; pos[k * 3 + 2] = 0.005;
      idx[k] = c; sd[k] = (i * 0.618) % 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('city', new THREE.BufferAttribute(idx, 1));
    g.setAttribute('seed', new THREE.BufferAttribute(sd, 1));
    const vert = `
      #define NCITY ${N}
      uniform float pscale, time; uniform float uRing[NCITY];
      attribute float city, seed; varying float vAlpha; varying vec3 vColor;
      void main(){
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 1.5 * pscale;
        float k = uRing[int(city)];
        vAlpha = (0.45 + 0.55 * k) * (0.7 + 0.3 * sin(time * 0.8 + seed * 6.28318));
        vColor = vec3(1.0);
      }`;
    const m = additiveMaterial(vert, { pscale: { value: 1 }, time: { value: 0 }, uRing: { value: new Float32Array(N) }, color: { value: hexToVec3(M.colours.ring) }, opacity: { value: 0.9 } });
    scene.add(new THREE.Points(g, m));
    ringMat = m;
  }

  // ---------------------------------------------------------------- plumes
  const perCity = Math.max(500, Math.floor(M.counts.europe.plumePerCity * stage.quality));
  const plumeVert = `
    #define NCITY ${N}
    ${GLSL_COMMON}
    uniform float pscale, time;
    uniform vec2 uPos[NCITY];        // map xy
    uniform vec4 uN[NCITY];          // no2_n pm25_n pm10_n o3_n
    uniform vec4 uWind[NCITY];       // dir.x dir.y speedKmh lidCap
    uniform float uRain[NCITY];      // 0..1 thinning
    uniform float heightPerN, maxHeight, baseRadius, riseSeconds, leanPerKmh, stretchPerKmh, amberSharePerN, grainSharePerN, grainSize, size;
    uniform vec3 cNo2, cPm25, cPm10, cO3;
    attribute vec4 seed; attribute float city;
    varying float vAlpha; varying vec3 vColor;
    void main(){
      int ci = int(city);
      vec4 n = uN[ci]; vec4 w = uWind[ci];
      float maxN = max(max(n.x, n.y), max(n.z, n.w));
      float H = min(maxHeight, maxN * heightPerN) * w.w;
      float u = fract(seed.x + time / (riseSeconds * (0.75 + 0.5 * seed.y)));
      // Strata by seed.z: amber root in the lower third, blue cap on top, body between.
      float fNo2 = clamp(n.x * amberSharePerN, 0.0, 1.0) * 0.33;
      float fO3  = clamp(n.w * 0.33, 0.0, 1.0) * 0.30;
      float h; vec3 col; float a; float sz = size;
      if (seed.z < fNo2) {                 // NO2 root
        h = u * H * 0.34; col = cNo2; a = 0.9;
      } else if (seed.z > 1.0 - fO3) {     // O3 top sheet
        h = H * (0.78 + 0.22 * u); col = cO3; a = 0.75 * clamp(n.w, 0.0, 1.0);
      } else {                             // PM body with PM10 grains
        h = u * H;
        float grain = step(1.0 - clamp(n.z * grainSharePerN, 0.0, 0.6), hash11(seed.w * 91.7));
        col = mix(cPm25, cPm10, grain); sz = mix(size, grainSize, grain);
        a = (0.12 + 0.5 * clamp(n.y / 3.0, 0.0, 1.0)) * (1.0 - 0.35 * grain);
      }
      float hn = H > 0.0 ? h / max(H, 1e-4) : 0.0;
      float r = baseRadius * (0.25 + 0.75 * sqrt(seed.w)) * (0.6 + 0.9 * hn);
      float ang = seed.y * 6.28318 + time * (0.05 + 0.1 * seed.x);
      vec2 off = vec2(cos(ang), sin(ang)) * r;
      vec2 wd = w.xy; float sp = w.z;
      off += wd * (r * stretchPerKmh * sp * 4.0);          // stretch with speed
      off += wd * (h * leanPerKmh * sp);                    // lean with direction
      vec3 turb = curl(vec3(uPos[ci] * 3.0 + off * 4.0, h * 0.6 + time * 0.07)) * 0.12 * (0.3 + hn);
      vec3 p = vec3(uPos[ci] + off + turb.xy, h + turb.z * 0.3);
      a *= smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.7, 1.0, u));
      a *= (1.0 - uRain[ci]);
      a *= smoothstep(0.0, 0.2, maxN);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = sz * pscale * (0.7 + 0.6 * seed.w) * clamp(60.0 / -mv.z, 0.5, 2.5);
      vAlpha = a; vColor = col;
    }`;
  const plumeUniforms = {
    pscale: { value: 1 }, time: { value: 0 },
    uPos: { value: cityXY.map(([x, y]) => new THREE.Vector2(x, y)) },
    uN: { value: cities.map(() => new THREE.Vector4()) },
    uWind: { value: cities.map(() => new THREE.Vector4(0, 1, 0, 1)) },
    uRain: { value: new Float32Array(N) },
    heightPerN: { value: E.plumeHeightPerN }, maxHeight: { value: E.plumeMaxHeight }, baseRadius: { value: E.plumeBaseRadius },
    riseSeconds: { value: E.plumeRiseSeconds }, leanPerKmh: { value: E.leanPerKmh }, stretchPerKmh: { value: E.stretchPerKmh },
    amberSharePerN: { value: E.amberSharePerN }, grainSharePerN: { value: E.grainSharePerN }, grainSize: { value: E.grainSize }, size: { value: E.plumePointSize },
    cNo2: { value: hexToVec3(M.colours.no2) }, cPm25: { value: hexToVec3(M.colours.pm25) }, cPm10: { value: hexToVec3(M.colours.pm10) }, cO3: { value: hexToVec3(M.colours.o3) },
    color: { value: new THREE.Vector3(1, 1, 1) }, opacity: { value: E.plumeAlpha * alphaScale(stage.quality) },
  };
  {
    const total = N * perCity;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seeds(total, 4), 4));
    const idx = new Float32Array(total); for (let i = 0; i < total; i++) idx[i] = Math.floor(i / perCity);
    g.setAttribute('city', new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    const p = new THREE.Points(g, additiveMaterial(plumeVert, plumeUniforms)); p.frustumCulled = false; scene.add(p);
  }

  // ---------------------------------------------------------------- streamlines (CPU)
  const SN = Math.max(500, Math.floor(M.counts.europe.streamlines * stage.quality));
  const sPos = new Float32Array(SN * 3), sAge = new Float32Array(SN), sLife = new Float32Array(SN);
  const landCount = landRaw.length / 2;
  const onLand = (x: number, y: number) => {
    const lon = x / kx + midLon, lat = y + midLat;
    const i = Math.floor((lon - bb.lonMin) / (bb.lonMax - bb.lonMin) * meta.maskW), j = Math.floor((bb.latMax - lat) / (bb.latMax - bb.latMin) * meta.maskH);
    return i >= 0 && j >= 0 && i < meta.maskW && j < meta.maskH && maskRaw[j * meta.maskW + i] === 1;
  };
  const respawn = (i: number) => {
    const k = Math.floor(Math.random() * landCount);
    const lon = bb.lonMin + landRaw[k * 2] / 65535 * (bb.lonMax - bb.lonMin), lat = bb.latMin + landRaw[k * 2 + 1] / 65535 * (bb.latMax - bb.latMin);
    const [x, y] = toXY(lon, lat); sPos[i * 3] = x; sPos[i * 3 + 1] = y; sPos[i * 3 + 2] = 0.01;
    sAge[i] = 0; sLife[i] = E.streamLifeSeconds * (0.5 + Math.random());
  };
  for (let i = 0; i < SN; i++) { respawn(i); sAge[i] = Math.random() * sLife[i]; }
  const sGeo = new THREE.BufferGeometry();
  const sPosAttr = new THREE.BufferAttribute(sPos, 3).setUsage(THREE.DynamicDrawUsage);
  const sAgeAttr = new THREE.BufferAttribute(sAge, 1).setUsage(THREE.DynamicDrawUsage);
  sGeo.setAttribute('position', sPosAttr); sGeo.setAttribute('age', sAgeAttr); sGeo.setAttribute('life', new THREE.BufferAttribute(sLife, 1));
  sGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
  const sMat = additiveMaterial(`
    uniform float pscale, size; attribute float age, life; varying float vAlpha; varying vec3 vColor;
    void main(){
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * pscale;
      float u = age / life; vAlpha = smoothstep(0.0, 0.15, u) * (1.0 - smoothstep(0.6, 1.0, u)) * 0.7; vColor = vec3(1.0);
    }`, { pscale: { value: 1 }, size: { value: E.streamPointSize }, color: { value: hexToVec3(M.colours.coast).multiplyScalar(1.3) }, opacity: { value: 1 } });
  const sPts = new THREE.Points(sGeo, sMat); sPts.frustumCulled = false; scene.add(sPts);

  // Wind at a map point: inverse-distance weighting over the cities (degrees/s).
  const windVec = new Float32Array(N * 3); // vx, vy (unit*speed), speed
  function windAt(x: number, y: number, out: number[]) {
    let wx = 0, wy = 0, ws = 0;
    for (let c = 0; c < N; c++) {
      const dx = x - cityXY[c][0], dy = y - cityXY[c][1];
      const w = 1 / (dx * dx + dy * dy + 0.3);
      wx += windVec[c * 3] * w; wy += windVec[c * 3 + 1] * w; ws += w;
    }
    out[0] = wx / ws; out[1] = wy / ws;
  }

  // ---------------------------------------------------------------- frame loop
  const tmp = [0, 0];
  const lidCapRef = E.lidCapRefM;
  stage.start((dt, t) => {
    const states = client.sample();
    const frame = client.frame;
    const scale = ps();
    for (const m of [landMat, coastMat, ringMat, sMat]) { m.uniforms.pscale.value = scale; if (m.uniforms.time) m.uniforms.time.value = t; }
    plumeUniforms.pscale.value = scale; plumeUniforms.time.value = t;

    for (let c = 0; c < N; c++) {
      const s = states.get(cities[c].slug) as CityState | undefined;
      if (!s) continue;
      plumeUniforms.uN.value[c].set(s.no2_n, s.pm25_n, s.pm10_n, s.o3_n);
      // Meteorological direction is where the wind comes from; particles go the other way.
      const rad = s.wind_dir * Math.PI / 180;
      const dx = -Math.sin(rad), dy = -Math.cos(rad);
      const lidCap = Math.max(E.lidCapMin, Math.min(1, s.lid_m / lidCapRef));
      plumeUniforms.uWind.value[c].set(dx, dy, s.wind_speed, lidCap);
      plumeUniforms.uRain.value[c] = E.rainThin * Math.min(1, s.rain / E.rainRefMm);
      windVec[c * 3] = dx * s.wind_speed; windVec[c * 3 + 1] = dy * s.wind_speed; windVec[c * 3 + 2] = s.wind_speed;
      ringMat.uniforms.uRing.value[c] = Math.min(1, (s.european_aqi || 0) / 100) + (frame?.active === s.slug ? 0.5 : 0);
    }

    // Streamlines.
    const sp = E.streamSpeed * dt;
    for (let i = 0; i < SN; i++) {
      sAge[i] += dt;
      if (sAge[i] > sLife[i]) { respawn(i); continue; }
      windAt(sPos[i * 3], sPos[i * 3 + 1], tmp);
      sPos[i * 3] += tmp[0] * sp; sPos[i * 3 + 1] += tmp[1] * sp;
      if (!onLand(sPos[i * 3], sPos[i * 3 + 1])) respawn(i);
    }
    sPosAttr.needsUpdate = true; sAgeAttr.needsUpdate = true;

    // Labels.
    if (showLabels && frame) {
      const v = new THREE.Vector3();
      for (let c = 0; c < N; c++) {
        const s = states.get(cities[c].slug); if (!s) continue;
        v.set(cityXY[c][0], cityXY[c][1] - E.ringRadius * 1.25, 0);
        const dom = [['NO₂', s.no2, s.no2_n, 'k-no2'], ['PM2.5', s.pm25, s.pm25_n, 'k-pm25'], ['PM10', s.pm10, s.pm10_n, 'k-pm10'], ['O₃', s.o3, s.o3_n, 'k-o3']].sort((a, b) => (b[2] as number) - (a[2] as number))[0];
        labels.place(s.slug, v, cam, stage.width, stage.height,
          `<div class="name">${s.city}</div><div class="val"><span class="${dom[3]}">${dom[0]}</span> ${fmt(dom[1] as number)} µg/m³ · ${fmt(s.wind_speed)} km/h</div>`, frame.active === s.slug);
      }
      const any = frame.cities[0];
      labels.corner('bl', `<div class="title">Common Air</div>${frame.mode} · ${any.source}${frame.mode === 'replay' ? ' ' + new Date(frame.replay.time).toISOString().slice(0, 16) + 'Z' : ''} · data hour ${hhmm(frame.dataHour)}<br>CAMS Europe regional model estimates · Open-Meteo · © OpenStreetMap, Natural Earth`);
      labels.corner('br', `${Math.round(stage.fps)} fps · ${(N * perCity + SN + landRaw.length / 2).toLocaleString()} pts · q${stage.quality}`);
    }
  });
}
