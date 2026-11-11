// Web Audio prototype of the sound engine. Consumes the nine 0..1 controls the
// service computes (the same values it sends over OSC). Stereo/binaural via
// HRTF panners on a ring that the wind direction rotates. Final sound design
// is the owner's; this exists so each mapping can be heard in isolation.
import type { SoundControls } from '../types';

export type LayerName = 'no2' | 'pm25' | 'pm10' | 'o3';
export const LAYERS: LayerName[] = ['no2', 'pm25', 'pm10', 'o3'];

function noiseBuffer(ctx: AudioContext, seconds: number, kind: 'white' | 'pink' | 'brown') {
  const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11; }
  }
  return buf;
}

// Synthesised impulse response: exponentially decaying noise.
function impulse(ctx: AudioContext, seconds: number, decay: number) {
  const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
  return buf;
}

interface Layer { name: LayerName; input: GainNode; gain: GainNode; panner: PannerNode; baseAngle: number; }

export class SoundEngine {
  ctx: AudioContext;
  master: GainNode; dry: GainNode; wetSmall: GainNode; wetLarge: GainNode;
  layers = new Map<LayerName, Layer>();
  solo: LayerName | null = null;
  muted = new Set<LayerName>();
  controls: SoundControls | null = null;
  private lfo: OscillatorNode; private lfoDepth: GainNode;
  private no2Filter!: BiquadFilterNode; private no2Grain!: GainNode;
  private pmFilter!: BiquadFilterNode;
  private o3Oscs: OscillatorNode[] = []; private o3Shelf!: BiquadFilterNode; private o3Gain!: GainNode;
  private gritHP!: BiquadFilterNode; private white!: AudioBuffer;
  private nextGrain = 0; private nextGrit = 0;
  private timer = 0;
  running = false;

  constructor() {
    this.ctx = new AudioContext();
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = 0.8;
    this.dry = c.createGain(); this.wetSmall = c.createGain(); this.wetLarge = c.createGain();
    const small = c.createConvolver(); small.buffer = impulse(c, 0.5, 4);
    const large = c.createConvolver(); large.buffer = impulse(c, 4.5, 2.5);
    this.dry.connect(this.master);
    this.wetSmall.connect(small).connect(this.master);
    this.wetLarge.connect(large).connect(this.master);
    this.master.connect(c.destination);
    c.listener.positionX.value = 0; c.listener.positionY.value = 0; c.listener.positionZ.value = 0;

    this.lfo = c.createOscillator(); this.lfo.frequency.value = 0.1; this.lfoDepth = c.createGain(); this.lfoDepth.gain.value = 0;
    this.lfo.connect(this.lfoDepth); this.lfo.start();

    const angles: Record<LayerName, number> = { no2: -0.6, pm25: 0.6, pm10: 2.5, o3: -2.5 };
    for (const name of LAYERS) {
      const input = c.createGain(), gain = c.createGain(), panner = c.createPanner();
      panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 1;
      gain.gain.value = 1;
      this.lfoDepth.connect(gain.gain);           // wind movement: tremolo on every layer
      input.connect(gain).connect(panner);
      panner.connect(this.dry); panner.connect(this.wetSmall); panner.connect(this.wetLarge);
      this.layers.set(name, { name, input, gain, panner, baseAngle: angles[name] });
    }
    this.buildSources();
  }

  private buildSources() {
    const c = this.ctx;
    // NO2: brown noise through a low-pass, chopped into grains by a gain envelope.
    const brown = c.createBufferSource(); brown.buffer = noiseBuffer(c, 3, 'brown'); brown.loop = true;
    this.no2Filter = c.createBiquadFilter(); this.no2Filter.type = 'lowpass'; this.no2Filter.frequency.value = 120; this.no2Filter.Q.value = 1.2;
    this.no2Grain = c.createGain(); this.no2Grain.gain.value = 0;
    brown.connect(this.no2Filter).connect(this.no2Grain).connect(this.layers.get('no2')!.input); brown.start();
    // PM2.5: pink noise bed through a band-pass that widens as it thickens.
    const pink = c.createBufferSource(); pink.buffer = noiseBuffer(c, 4, 'pink'); pink.loop = true;
    this.pmFilter = c.createBiquadFilter(); this.pmFilter.type = 'bandpass'; this.pmFilter.frequency.value = 700; this.pmFilter.Q.value = 2;
    pink.connect(this.pmFilter).connect(this.layers.get('pm25')!.input); pink.start();
    // PM10: ticks are scheduled from white noise bursts.
    this.white = noiseBuffer(c, 1, 'white');
    this.gritHP = c.createBiquadFilter(); this.gritHP.type = 'highpass'; this.gritHP.frequency.value = 2500;
    this.gritHP.connect(this.layers.get('pm10')!.input);
    // O3: glassy partials, slightly detuned, through a high shelf for brightness.
    this.o3Shelf = c.createBiquadFilter(); this.o3Shelf.type = 'highshelf'; this.o3Shelf.frequency.value = 3000;
    this.o3Gain = c.createGain(); this.o3Gain.gain.value = 0;
    this.o3Shelf.connect(this.o3Gain).connect(this.layers.get('o3')!.input);
    const ratios = [1, 1.5, 2.02, 2.71, 3.39, 4.53];
    for (const r of ratios) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 1760 * r; o.detune.value = (Math.random() - 0.5) * 12;
      const g = c.createGain(); g.gain.value = 0.12 / r;
      o.connect(g).connect(this.o3Shelf); o.start(); this.o3Oscs.push(o);
    }
  }

  async start() { await this.ctx.resume(); this.running = true; this.timer = window.setInterval(() => this.schedule(), 50); }
  stop() { this.running = false; clearInterval(this.timer); this.ctx.suspend(); }

  setSolo(l: LayerName | null) { this.solo = l; }
  toggleMute(l: LayerName) { if (this.muted.has(l)) this.muted.delete(l); else this.muted.add(l); }
  private audible(l: LayerName) { return this.solo ? this.solo === l : !this.muted.has(l); }

  // Called at the service frame rate with the nine controls.
  update(s: SoundControls) {
    this.controls = s;
    const c = this.ctx, t = c.currentTime, T = 0.4;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, T);
    // Wind direction rotates the whole field; wind speed sets movement rate and depth.
    const rot = s.wind_angle * Math.PI * 2;
    for (const L of this.layers.values()) {
      const a = L.baseAngle + rot;
      set(L.panner.positionX, Math.sin(a) * 1.5); set(L.panner.positionZ, -Math.cos(a) * 1.5); set(L.panner.positionY, 0);
      set(L.gain.gain, this.audible(L.name) ? 1 : 0);
    }
    set(this.lfo.frequency, 0.05 + s.wind_rate * 1.2);
    set(this.lfoDepth.gain, s.wind_rate * 0.35);
    // Layer levels.
    set(this.no2Filter.frequency, 80 + 140 * s.no2_level);
    set(this.pmFilter.Q, 3.5 - 3.2 * s.pm25_bed);
    set(this.pmFilter.gain, 0);
    set(this.layers.get('pm25')!.input.gain, s.pm25_bed * 0.9);
    set(this.o3Gain.gain, s.o3_bright * 0.9);
    set(this.o3Shelf.gain, -12 + 18 * s.o3_bright);
    // Lid: reverb size. Low lid = close room, high lid = open.
    set(this.wetSmall.gain, 0.4 * (1 - s.lid_size));
    set(this.wetLarge.gain, 0.5 * s.lid_size);
    set(this.dry.gain, 0.8);
    // Rain clears the bed toward near silence.
    set(this.master.gain, 0.8 * (1 - 0.95 * s.rain_clear));
  }

  // Grain and tick scheduler with a short look-ahead.
  private schedule() {
    const s = this.controls; if (!s) return;
    const c = this.ctx, now = c.currentTime, ahead = now + 0.15;
    // NO2 grains: density sets the rate, level the amplitude.
    const grainRate = 2 + 28 * s.no2_density;
    if (this.nextGrain < now) this.nextGrain = now;
    while (this.nextGrain < ahead) {
      const g = this.no2Grain.gain, t0 = this.nextGrain, len = 0.06 + 0.12 * Math.random(), amp = s.no2_level * (0.5 + 0.5 * Math.random());
      g.setValueAtTime(0, t0); g.linearRampToValueAtTime(amp, t0 + len * 0.3); g.linearRampToValueAtTime(0, t0 + len);
      this.nextGrain += (1 / grainRate) * (0.6 + 0.8 * Math.random());
    }
    // PM10 ticks: Poisson events.
    const rate = s.pm10_rate * 14;
    if (this.nextGrit < now) this.nextGrit = now;
    while (rate > 0.01 && this.nextGrit < ahead) {
      const src = c.createBufferSource(); src.buffer = this.white;
      const g = c.createGain(); const t0 = this.nextGrit, len = 0.004 + 0.012 * Math.random();
      g.gain.setValueAtTime(0.5 + 0.5 * Math.random(), t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
      src.connect(g).connect(this.gritHP); src.start(t0, Math.random() * 0.9, len + 0.01);
      src.onended = () => { src.disconnect(); g.disconnect(); };
      this.nextGrit += -Math.log(1 - Math.random()) / rate;
    }
  }
}
