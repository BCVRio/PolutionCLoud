// City view (scrims): lidar-style building cloud with three pollutant strata.
// `layer` selects what this output renders: 'all' for a single screen,
// 'no2' / 'pm' / 'o3' for the three gauze scrims (buildings ride on 'pm').
import * as THREE from 'three';
import { Stage, GLSL_COMMON, additiveMaterial, hexToVec3, seeds, alphaScale } from '../render/Stage';
import { LabelLayer, fmt, hhmm } from '../render/Labels';
import { loadCity, sampleBuildings, sampleRoads, heightTexture, type CityGeometry } from './geometry';
import type { StateClient } from '../net/StateClient';
import type { City, CityState } from '../types';

export type Layer = 'all' | 'no2' | 'pm' | 'o3';

export async function mountCity(container: HTMLElement, client: StateClient, layer: Layer) {
  const hello = await new Promise<any>((r) => client.onHello(r));
  const M = hello.mapping, C = M.city, cities: City[] = hello.cities;
  const stage = new Stage(container, { ...M.post, background: M.colours.background });
  const labels = new LabelLayer(container);
  const showLabels = new URLSearchParams(location.search).get('labels') !== '0';
  const pinned = new URLSearchParams(location.search).get('city');     // ?city=milan pins this output to one city
  const scene = stage.scene, cam = stage.camera;
  const ext = C.extentM;

  // Camera shared by every scrim output so the strata line up.
  cam.fov = C.camera.fov; cam.near = 1; cam.far = 20000; cam.updateProjectionMatrix();
  let orbit = 0;
  function placeCamera(t: number) {
    const a = (C.camera.orbitDeg + (C.camera.orbitSeconds ? (t / C.camera.orbitSeconds) * 360 : 0)) * Math.PI / 180;
    orbit = a;
    cam.position.set(Math.sin(a) * C.camera.distance, C.camera.height, Math.cos(a) * C.camera.distance);
    cam.up.set(0, 1, 0); cam.lookAt(0, 120, 0);
  }
  placeCamera(0);

  const q = stage.quality, aScale = alphaScale(q);
  const counts = { buildings: Math.floor(M.counts.city.buildings * q), no2: Math.floor(M.counts.city.no2 * q), pm25: Math.floor(M.counts.city.pm25 * q), pm10: Math.floor(M.counts.city.pm10 * q), o3: Math.floor(M.counts.city.o3 * q) };
  const show = { buildings: layer === 'all' || layer === 'pm', no2: layer === 'all' || layer === 'no2', pm: layer === 'all' || layer === 'pm', o3: layer === 'all' || layer === 'o3' };

  // ------------------------------------------------------------ shared uniforms
  const U = {
    pscale: { value: 1 }, time: { value: 0 },
    uN: { value: new THREE.Vector4() },                 // no2_n pm25_n pm10_n o3_n
    uWind: { value: new THREE.Vector4(0, 0, 0, 0) },    // vx vz speedKmh unused   (scene m/s)
    uEnv: { value: new THREE.Vector4(800, 0, 0, 50) },  // lid_m rain01 solar01 humidity
    uRoof: { value: 20 },                               // mean roof height
    uExt: { value: ext },
    tHeight: { value: null as THREE.Texture | null }, uMaxH: { value: 300 },
    cNo2: { value: hexToVec3(M.colours.no2) }, cPm25: { value: hexToVec3(M.colours.pm25) }, cPm10: { value: hexToVec3(M.colours.pm10) }, cO3: { value: hexToVec3(M.colours.o3) },
  };
  const own = (extra: Record<string, THREE.IUniform>) => ({ ...U, color: { value: new THREE.Vector3(1, 1, 1) }, opacity: { value: 1 }, alpha: { value: 1 }, ...extra });
  const layerAlpha: Record<string, number> = { no2: C.no2.alpha, pm25: C.pm25.alpha, pm10: C.pm10.alpha, o3: C.o3.alpha };

  // Wind drift shared by the strata: metres of displacement, wrapped in the box.
  const WIND_GLSL = `
    uniform vec4 uWind; uniform float uExt;
    vec3 advect(vec3 p, float t, float shearPerM){
      float shear = 1.0 + p.y * shearPerM;
      vec2 d = uWind.xy * t * shear;
      vec2 xz = p.xz + d + uExt * 0.5;
      xz = mod(xz, uExt) - uExt * 0.5;        // wrap so the box stays full
      return vec3(xz.x, p.y, xz.y);
    }`;

  // ------------------------------------------------------------ buildings
  let buildingMat: THREE.ShaderMaterial | null = null;
  let buildingGeo: THREE.BufferGeometry | null = null;
  const buildingVert = `
    uniform float pscale, size, time; attribute float kind, seed; varying float vAlpha; varying vec3 vColor;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = size * pscale * clamp(1800.0 / -mv.z, 0.6, 1.6);
      // Walls a touch brighter at scan rows; roofs dimmer. Slow shimmer like a live scan.
      float base = kind > 0.5 ? 0.9 : 0.6;
      vAlpha = base * (0.8 + 0.2 * sin(time * 0.4 + seed * 6.2831 + position.y * 0.05));
      vColor = vec3(1.0);
    }`;

  // ------------------------------------------------------------ NO2 along streets
  let no2Geo: THREE.BufferGeometry | null = null;
  const no2Mat = additiveMaterial(`
    ${GLSL_COMMON} ${WIND_GLSL}
    uniform float pscale, time, size, alpha, maxH, riseSeconds, shearPerM; uniform vec4 uN, uEnv; uniform vec3 cNo2;
    attribute vec2 road; attribute float rcls; attribute vec4 seed; varying float vAlpha; varying vec3 vColor;
    void main(){
      float n = uN.x;
      // Count follows no2_n: particles whose seed is above the share are hidden.
      float share = clamp(n / 3.0, 0.0, 1.0);
      float alive = step(seed.x, share);
      float u = fract(seed.y + time / (riseSeconds * (0.7 + 0.6 * seed.z)));
      float h = u * maxH * (0.5 + 0.5 * share);
      vec3 p = vec3(road.x, h, road.y);
      vec3 turb = curl(vec3(p.xz * 0.02, time * 0.08 + seed.w * 10.0)) * (6.0 + 20.0 * u);
      p += turb;
      p = advect(p, time * (0.6 + 0.4 * seed.w), shearPerM);
      // Rain: streak down and wash out.
      p.y -= uEnv.y * 180.0 * fract(time * 0.5 + seed.x) ;
      float a = alive * smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.55, 1.0, u)) * (0.35 + 0.65 * share) * (1.0 - 0.9 * uEnv.y);
      a *= (rcls < 2.5 ? 1.0 : 0.7);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = size * pscale * (0.7 + 0.6 * seed.w) * clamp(1800.0 / -mv.z, 0.6, 1.8);
      vAlpha = a * alpha; vColor = cNo2;
    }`, own({ alpha: { value: C.no2.alpha * aScale }, size: { value: C.no2.pointSize }, maxH: { value: C.no2.maxHeightM }, riseSeconds: { value: C.no2.riseSeconds }, shearPerM: { value: C.wind.shearPerM } }));

  // ------------------------------------------------------------ PM2.5 grain between roofs and lid
  const pm25Mat = additiveMaterial(`
    ${GLSL_COMMON} ${WIND_GLSL}
    uniform float pscale, time, size, alpha, driftSeconds, shearPerM, lidBrightRef, lidBrightMax, noiseDry, noiseWet, uRoof; uniform vec4 uN, uEnv; uniform vec3 cPm25;
    attribute vec4 seed; varying float vAlpha; varying vec3 vColor;
    void main(){
      float n = uN.y;
      float share = clamp(n / 3.0, 0.0, 1.0);
      float alive = step(seed.x, 0.15 + 0.85 * share);
      float lid = uEnv.x;
      // Same particles compressed into a lower box when the lid is low.
      float y = uRoof * 0.5 + (lid - uRoof * 0.5) * seed.y;
      vec3 p = vec3((seed.z - 0.5) * uExt, y, (seed.w - 0.5) * uExt);
      float ns = mix(noiseDry, noiseWet, uEnv.w / 100.0);          // humidity sets the noise scale
      vec3 turb = curl(vec3(p.xz / ns, p.y / ns + time / driftSeconds)) * ns * 0.6;
      p += turb;
      p = advect(p, time, shearPerM);
      p.y -= uEnv.y * 180.0 * fract(time * 0.4 + seed.x);          // rain streaks
      p.y = max(p.y, 1.0);
      float bright = clamp(lidBrightRef / max(lid, 50.0), 1.0, lidBrightMax);
      float a = alive * (0.08 + 0.3 * share) * bright * (1.0 - 0.9 * uEnv.y);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = size * pscale * (0.6 + 0.8 * seed.x) * clamp(1800.0 / -mv.z, 0.5, 1.6);
      vAlpha = a * alpha; vColor = cPm25;
    }`, own({ alpha: { value: C.pm25.alpha * aScale }, size: { value: C.pm25.pointSize }, driftSeconds: { value: C.pm25.driftSeconds }, shearPerM: { value: C.wind.shearPerM }, lidBrightRef: { value: C.pm25.lidBrightRefM }, lidBrightMax: { value: C.pm25.lidBrightMax }, noiseDry: { value: C.pm25.noiseScaleHumidity.dry }, noiseWet: { value: C.pm25.noiseScaleHumidity.wet } }));

  // ------------------------------------------------------------ PM10 falling grit
  const pm10Mat = additiveMaterial(`
    ${GLSL_COMMON} ${WIND_GLSL}
    uniform float pscale, time, size, alpha, fallSeconds, restSeconds, shearPerM, uMaxH; uniform sampler2D tHeight; uniform vec4 uN, uEnv; uniform vec3 cPm10;
    attribute vec4 seed; varying float vAlpha; varying vec3 vColor;
    void main(){
      float n = uN.z;
      float share = clamp(n / 3.0, 0.0, 1.0);
      float alive = step(seed.x, 0.1 + 0.9 * share);
      float cycle = fallSeconds + restSeconds;
      float ph = fract(seed.y + time / cycle) * cycle;              // seconds into this grain's life
      float lid = uEnv.x;
      vec3 p0 = vec3((seed.z - 0.5) * uExt, lid, (seed.w - 0.5) * uExt);
      float fallT = min(ph, fallSeconds) * (1.0 + uEnv.y * 2.0);   // rain speeds the fall
      vec3 p = advect(p0, fallT, shearPerM);
      p.y = lid - (lid / fallSeconds) * fallT;
      p.xz += curl(vec3(p.xz * 0.01, time * 0.05 + seed.x * 7.0)).xz * 10.0;
      // Land on buildings: look up the roof height under this grain.
      vec2 uv = (p.xz + uExt * 0.5) / uExt;
      float roof = texture2D(tHeight, uv).r * uMaxH;
      float landed = step(p.y, roof + 0.5);
      p.y = max(p.y, roof + 0.4);
      float rest = ph > fallSeconds ? (ph - fallSeconds) / restSeconds : 0.0;
      float a = alive * (0.45 + 0.4 * share) * (1.0 - rest) * (1.0 - 0.6 * landed * rest) * (1.0 - 0.8 * uEnv.y);
      if (ph > fallSeconds && landed < 0.5) a *= 0.0;                 // reached the ground away from a roof
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = size * pscale * (0.7 + 0.8 * seed.z) * clamp(1800.0 / -mv.z, 0.6, 1.8);
      vAlpha = a * alpha; vColor = cPm10;
    }`, own({ alpha: { value: C.pm10.alpha * aScale }, size: { value: C.pm10.pointSize }, fallSeconds: { value: C.pm10.fallSeconds }, restSeconds: { value: C.pm10.restSeconds }, shearPerM: { value: C.wind.shearPerM } }));

  // ------------------------------------------------------------ O3 sheet above the lid
  const o3Mat = additiveMaterial(`
    ${GLSL_COMMON} ${WIND_GLSL}
    uniform float pscale, time, size, alpha, thicknessPerN, rippleAmp, rippleNight, rippleNoon, shearPerM; uniform vec4 uN, uEnv; uniform vec3 cO3;
    attribute vec4 seed; varying float vAlpha; varying vec3 vColor;
    void main(){
      float n = uN.w;
      float share = clamp(n / 3.0, 0.0, 1.0);
      float alive = step(seed.x, 0.12 + 0.88 * share);
      float lid = uEnv.x;
      float thick = max(6.0, thicknessPerN * n);
      vec3 p = vec3((seed.y - 0.5) * uExt, lid + 20.0 + seed.z * thick, (seed.w - 0.5) * uExt);
      float speed = mix(rippleNight, rippleNoon, uEnv.z);
      float ph = time * speed * 6.2831;
      p.y += sin(p.x * 0.012 + ph) * rippleAmp + sin(p.z * 0.017 - ph * 0.8 + seed.x) * rippleAmp * 0.7;
      p.y += vnoise(vec3(p.xz * 0.004, time * 0.1)) * rippleAmp;
      p = advect(p, time * 0.5, shearPerM);
      float a = alive * (0.25 + 0.6 * share) * (1.0 - 0.7 * uEnv.y);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = size * pscale * (0.7 + 0.6 * seed.z) * clamp(1800.0 / -mv.z, 0.5, 1.6);
      vAlpha = a * alpha; vColor = cO3;
    }`, own({ alpha: { value: C.o3.alpha * aScale }, size: { value: C.o3.pointSize }, thicknessPerN: { value: C.o3.thicknessPerN }, rippleAmp: { value: C.o3.rippleAmpM }, rippleNight: { value: C.o3.rippleSpeedSolar.night }, rippleNoon: { value: C.o3.rippleSpeedSolar.noon }, shearPerM: { value: C.wind.shearPerM } }));

  // Volume strata share one seed geometry each.
  function cloud(n: number, mat: THREE.ShaderMaterial) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seeds(n, 4), 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const p = new THREE.Points(g, mat); p.frustumCulled = false; return p;
  }
  const pm25Pts = cloud(counts.pm25, pm25Mat), pm10Pts = cloud(counts.pm10, pm10Mat), o3Pts = cloud(counts.o3, o3Mat);
  pm25Pts.visible = pm10Pts.visible = show.pm; o3Pts.visible = show.o3;
  scene.add(pm25Pts, pm10Pts, o3Pts);
  const no2Pts = new THREE.Points(new THREE.BufferGeometry(), no2Mat); no2Pts.frustumCulled = false; no2Pts.visible = show.no2; scene.add(no2Pts);
  const buildingPts = new THREE.Points(new THREE.BufferGeometry(), additiveMaterial(buildingVert, { pscale: { value: 1 }, size: { value: C.buildingPointSize }, time: { value: 0 }, color: { value: hexToVec3(M.colours.coast).multiplyScalar(1.3) }, opacity: { value: C.buildingAlpha * aScale } }));
  buildingPts.frustumCulled = false; buildingPts.visible = show.buildings; scene.add(buildingPts);
  buildingMat = buildingPts.material as THREE.ShaderMaterial;

  // Ground scan rows: faint lines across the footprint so the cloud sits on a stage.
  {
    const verts: number[] = [];
    for (let z = -ext / 2; z <= ext / 2; z += 50) verts.push(-ext / 2, 0.2, z, ext / 2, 0.2, z);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(M.colours.scanline), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.visible = show.buildings; scene.add(l);
  }

  // ------------------------------------------------------------ city switching
  let current: string | null = null, loading: string | null = null, geometry: CityGeometry | null = null;
  const cache = new Map<string, CityGeometry>();
  let fade = 0;             // 0..1 brightness while a new city fades in
  async function switchTo(slug: string) {
    if (slug === current || slug === loading) return;
    loading = slug;
    const c = cities.find(x => x.slug === slug)!;
    let geo = cache.get(slug);
    if (!geo) { geo = await loadCity(slug, c.lat, c.lon, ext); cache.set(slug, geo); if (cache.size > 4) cache.delete(cache.keys().next().value!); }
    if (loading !== slug) return;
    geometry = geo; current = slug; loading = null; fade = 0;

    const b = sampleBuildings(geo, counts.buildings, C.scanRowM);
    buildingGeo?.dispose();
    buildingGeo = new THREE.BufferGeometry();
    buildingGeo.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
    buildingGeo.setAttribute('kind', new THREE.BufferAttribute(b.kind, 1));
    buildingGeo.setAttribute('seed', new THREE.BufferAttribute(seeds(counts.buildings, 1), 1));
    buildingGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    buildingPts.geometry = buildingGeo;

    const r = sampleRoads(geo, counts.no2, C.no2.roadWeights);
    no2Geo?.dispose();
    no2Geo = new THREE.BufferGeometry();
    no2Geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(counts.no2 * 3), 3));
    no2Geo.setAttribute('road', new THREE.BufferAttribute(r.pos, 2));
    no2Geo.setAttribute('rcls', new THREE.BufferAttribute(r.cls, 1));
    no2Geo.setAttribute('seed', new THREE.BufferAttribute(seeds(counts.no2, 4), 4));
    no2Geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    no2Pts.geometry = no2Geo;

    const h = heightTexture(geo);
    (U.tHeight.value as THREE.Texture | null)?.dispose();
    U.tHeight.value = h.tex; U.uMaxH.value = h.maxH; U.uRoof.value = h.meanRoof;
  }

  // ------------------------------------------------------------ frame loop
  stage.start((dt, t) => {
    const frame = client.frame;
    if (!frame) return;
    const slug = pinned || frame.active;
    if (slug !== current) switchTo(slug);
    const s = client.sample().get(slug) as CityState | undefined;
    if (!s) return;
    fade = Math.min(1, fade + dt / 2.5);
    placeCamera(t);

    U.pscale.value = stage.pointScale(); U.time.value = t;
    U.uN.value.set(s.no2_n, s.pm25_n, s.pm10_n, s.o3_n);
    const rad = s.wind_dir * Math.PI / 180;
    const v = s.wind_speed * C.wind.mPerSecPerKmh;
    U.uWind.value.set(-Math.sin(rad) * v, Math.cos(rad) * v, s.wind_speed, 0);     // z = -north
    const lid = Math.max(C.lidMinM, Math.min(C.lidMaxM, s.lid_m));
    U.uEnv.value.set(lid, Math.min(1, s.rain / C.rain.rainRefMm), Math.min(1, s.solar / C.o3.solarRefWm2), s.humidity);
    for (const m of [no2Mat, pm25Mat, pm10Mat, o3Mat]) { m.uniforms.opacity.value = fade; }
    if (buildingMat) { buildingMat.uniforms.pscale.value = U.pscale.value; buildingMat.uniforms.time.value = t; buildingMat.uniforms.opacity.value = fade * C.buildingAlpha * aScale; }
    void layerAlpha;

    if (showLabels) {
      const srcNote = s.source === 'simulated' ? 'simulated' : `${frame.mode === 'replay' ? 'replay' : s.source} · data hour ${hhmm(s.updated)}`;
      labels.corner('tl', `<div class="title">${s.city}</div>${srcNote}${geometry?.placeholder ? ' · placeholder grid city (run npm run build:cities)' : ' · buildings © OpenStreetMap'}`);
      labels.corner('tr',
        `<span class="k-no2">NO₂</span> <span class="big">${fmt(s.no2)}</span> µg/m³<br>` +
        `<span class="k-pm25">PM2.5</span> <span class="big">${fmt(s.pm25)}</span> µg/m³<br>` +
        `<span class="k-pm10">PM10</span> <span class="big">${fmt(s.pm10)}</span> µg/m³<br>` +
        `<span class="k-o3">O₃</span> <span class="big">${fmt(s.o3)}</span> µg/m³`);
      labels.corner('bl', `wind ${fmt(s.wind_speed)} km/h from ${fmt(s.wind_dir)}° · lid ${fmt(s.lid_m)} m${s.lid_approx ? ' (approx.)' : ''} · rain ${fmt(s.rain, 1)} mm · rh ${fmt(s.humidity)}%<br>CAMS Europe regional model estimate, not a street-level measurement · Open-Meteo`);
      labels.corner('br', `${layer === 'all' ? 'city' : 'scrim ' + layer} · ${Math.round(stage.fps)} fps · ${(counts.buildings + counts.no2 + counts.pm25 + counts.pm10 + counts.o3).toLocaleString()} pts · q${stage.quality}${frame.selection === 'cycle' ? ` · next in ${Math.ceil(frame.cycleRemaining)}s` : ''}`);
    }
    void orbit;
  });
}
