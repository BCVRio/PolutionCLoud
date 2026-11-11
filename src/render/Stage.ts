// Renderer + post chain shared by both views: additive points, soft bloom,
// grain and a gentle vignette. Handles resize and the quality setting.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const GrainShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, grain: { value: 0.06 }, vignette: { value: 0.25 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, grain, vignette; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      // Runs after the sRGB output pass, so the grain sits on display values and does not lift the blacks.
      float g = hash(vUv * vec2(1920.0, 1080.0) + vec2(fract(time * 7.31) * 13.0, fract(time * 3.17) * 7.0)) - 0.5;
      c.rgb += g * grain * (0.12 + c.rgb * 1.6);      // grain shows mostly in the glow
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - vignette * smoothstep(0.35, 0.85, d);
      gl_FragColor = c;
    }`,
};

export interface StageOptions { quality?: number; bloomStrength?: number; bloomRadius?: number; bloomThreshold?: number; grain?: number; vignette?: number; background?: string; }

// Quality from the URL (?q=0.5) or local storage, default 1.
export function readQuality(): number {
  const q = new URLSearchParams(location.search).get('q');
  if (q) { localStorage.setItem('commonair.quality', q); return Math.max(0.1, Math.min(2, parseFloat(q) || 1)); }
  return Math.max(0.1, Math.min(2, parseFloat(localStorage.getItem('commonair.quality') || '1') || 1));
}

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  grainPass: ShaderPass;
  private last = performance.now(); private elapsed = 0;
  quality: number;
  width = 1; height = 1;
  onResize: ((w: number, h: number) => void) | null = null;
  private frameCb: ((dt: number, t: number) => void) | null = null;
  private raf = 0;
  fps = 60;

  constructor(public container: HTMLElement, opts: StageOptions = {}) {
    this.quality = opts.quality ?? readQuality();
    const canvas = document.createElement('canvas');
    canvas.className = 'stage';
    container.appendChild(canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false, depth: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // The composer renders into a linear target and the clear colour is written as given, so
    // convert it from sRGB here or the background comes out several times too bright.
    this.renderer.setClearColor(new THREE.Color(opts.background ?? '#06080B').convertSRGBToLinear(), 1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), opts.bloomStrength ?? 0.9, opts.bloomRadius ?? 0.6, opts.bloomThreshold ?? 0.05);
    this.composer.addPass(this.bloom);
    this.grainPass = new ShaderPass(GrainShader);
    this.grainPass.uniforms.grain.value = opts.grain ?? 0.06;
    this.grainPass.uniforms.vignette.value = opts.vignette ?? 0.25;
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.grainPass);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.onResize?.(w, h);
  }

  // Pixel ratio scaled point size so 1 px at 1080p looks the same on other outputs.
  pointScale() { return this.renderer.getPixelRatio() * (this.height / 1080); }

  start(cb: (dt: number, t: number) => void) {
    this.frameCb = cb;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now; this.elapsed += dt;
      this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
      const t = this.elapsed;
      this.grainPass.uniforms.time.value = t;
      this.frameCb?.(dt, t);
      this.composer.render();
    };
    loop();
  }
  stop() { cancelAnimationFrame(this.raf); }
}

// GLSL helpers shared by the point shaders.
export const GLSL_COMMON = `
  float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  vec3 hash31(float p){ vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
  // Cheap value noise, enough for drift and ripple.
  float vnoise(vec3 x){
    vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
    float n = i.x + i.y*57.0 + i.z*113.0;
    return mix(mix(mix(hash11(n), hash11(n+1.0), f.x), mix(hash11(n+57.0), hash11(n+58.0), f.x), f.y),
               mix(mix(hash11(n+113.0), hash11(n+114.0), f.x), mix(hash11(n+170.0), hash11(n+171.0), f.x), f.y), f.z);
  }
  vec3 curl(vec3 p){
    float e = 0.35;
    float a = vnoise(p + vec3(0, e, 0)) - vnoise(p - vec3(0, e, 0));
    float b = vnoise(p + vec3(0, 0, e)) - vnoise(p - vec3(0, 0, e));
    float c = vnoise(p + vec3(e, 0, 0)) - vnoise(p - vec3(e, 0, 0));
    return vec3(a - b, b - c, c - a);
  }
`;

// Soft round point with additive glow falloff.
export const GLSL_POINT_FRAG = `
  uniform vec3 color; uniform float opacity;
  varying float vAlpha; varying vec3 vColor;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d) * 4.0;
    if (r > 1.0) discard;
    float a = (1.0 - r) * (1.0 - r);
    gl_FragColor = vec4(vColor * color * a * vAlpha * opacity, 1.0);
  }
`;

export function additiveMaterial(vertexShader: string, uniforms: Record<string, THREE.IUniform>, fragmentShader = GLSL_POINT_FRAG) {
  return new THREE.ShaderMaterial({
    vertexShader, fragmentShader, uniforms,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
}

// Per-particle alpha compensation so lower quality (fewer particles) keeps the same overall brightness.
export function alphaScale(quality: number) { return Math.min(3, Math.max(0.33, 1 / quality)); }

export function hexToVec3(hex: string) { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); }

// Attribute helper: a Float32 array of per-particle random seeds.
export function seeds(n: number, components = 4): Float32Array {
  const a = new Float32Array(n * components);
  let s = 123456789;
  for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s / 4294967296; }
  return a;
}
