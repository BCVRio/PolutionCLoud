// The heart of the service: polls the APIs, keeps the last good data, runs the
// live / replay / simulated modes, eases every value, picks the active city and
// publishes frames to the render pages and OSC.
import { EventEmitter } from 'node:events';
import { app, cities, mapping } from './config.js';
import { fetchAirQuality, fetchWeather } from './openmeteo.js';
import * as cache from './cache.js';
import { hourIndex, stateAt, simulatedStates, soundControls, PRESETS } from './state.js';
import { Easer } from './easing.js';
import { OscSender } from './osc.js';

export class Engine extends EventEmitter {
  constructor() {
    super();
    this.aq = cache.load('airquality');
    this.wx = cache.load('weather');
    this.status = {
      lastSuccess: this.aq?.fetched || null, lastError: null, lastAttempt: null, attempts: 0, failures: 0,
      cachedFromDisk: !!(this.aq || this.wx),
    };
    this.mode = (this.aq || this.wx) ? 'live' : 'simulated';
    this.autoLive = !(this.aq || this.wx);   // switch to live once the first fetch succeeds
    this.preset = 'clear';
    this.manual = {};        // slider overrides applied to every city in simulated mode
    this.perCity = {};       // slug -> overrides
    this.replay = { speed: app.replayDefaultSpeed, playing: true, time: Date.now() - 24 * 3600e3 };
    this.activeCity = cities[0].slug;
    this.autoCycle = true;
    this.cycleOrder = [];
    this.cycleIndex = 0;
    this.cycleStarted = 0;
    this.visitor = null;     // { slug, at }
    this.easers = new Map(cities.map(c => [c.slug, new Easer()]));
    this.lastTargetKey = null;
    this.frame = null;
    this.osc = new OscSender({ host: app.osc.host, port: app.osc.port, enabled: app.osc.enabled });
    this.lastOsc = 0;
    this.lastTick = Date.now();
  }

  start() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), app.api.pollMinutes * 60e3);
    this.tickTimer = setInterval(() => this.tick(), 1000 / app.frameRateHz);
  }

  stop() { clearInterval(this.pollTimer); clearInterval(this.tickTimer); this.osc.close(); }

  // ------------------------------------------------------------------ data
  async poll() {
    this.status.lastAttempt = new Date().toISOString();
    this.status.attempts++;
    try {
      const [aq, wx] = await Promise.all([fetchAirQuality(), fetchWeather()]);
      this.aq = aq; this.wx = wx;
      cache.save('airquality', aq); cache.save('weather', wx);
      this.status.lastSuccess = aq.fetched; this.status.lastError = null;
      if (this.mode === 'simulated' && this.autoLive) this.mode = 'live';
      this.emit('log', `data refreshed (${aq.hours.length} hours per city)`);
    } catch (e) {
      this.status.failures++;
      this.status.lastError = `${new Date().toISOString()} ${e.message}`;
      this.emit('log', `fetch failed: ${e.message} (showing ${this.aq ? 'cached' : 'simulated'} data)`);
      // Retry sooner than the next hourly poll, with a bounded backoff.
      clearTimeout(this.retryTimer);
      const wait = Math.min(15, 2 ** Math.min(this.status.failures, 4)) * 60e3;
      this.retryTimer = setTimeout(() => this.poll(), wait);
    }
  }

  hasData() { return !!(this.aq?.hours?.length || this.wx?.hours?.length); }

  // The series hours (air quality preferred, weather otherwise).
  hours() { return this.aq?.hours || this.wx?.hours || []; }

  // 'live' if the last successful fetch is recent enough, otherwise 'cached'.
  liveSource() {
    if (!this.status.lastSuccess) return 'cached';
    const age = Date.now() - Date.parse(this.status.lastSuccess);
    return age < app.api.pollMinutes * 60e3 * 2.5 ? 'live' : 'cached';
  }

  // Target states for the current moment, plus a key that changes when the
  // targets change so we only restart the glide when needed.
  targets(now) {
    const hours = this.hours();
    if (this.mode === 'simulated' || !this.hasData()) {
      const key = `sim:${this.preset}:${JSON.stringify(this.manual)}:${JSON.stringify(this.perCity)}`;
      return { key, states: simulatedStates(this.preset, this.manual, this.perCity), seconds: mapping.easing.simulatedSeconds };
    }
    const date = this.mode === 'replay' ? new Date(this.replay.time) : new Date(now);
    let i = hourIndex(hours, date);
    if (i < 0) i = 0;
    const source = this.mode === 'replay' ? 'replay' : this.liveSource();
    const key = `${this.mode}:${i}:${source}`;
    const seconds = this.mode === 'replay'
      ? Math.min(mapping.easing.seconds, 3600 / this.replay.speed * mapping.easing.replayFraction)
      : mapping.easing.seconds;
    const states = cities.map(c => stateAt(c, this.aq, this.wx, i, source, this.easers.get(c.slug).to));
    return { key, states, seconds, hour: hours[i] };
  }

  // ------------------------------------------------------------------ control
  set(msg) {
    if (msg.mode && ['live', 'replay', 'simulated'].includes(msg.mode)) {
      this.mode = msg.mode;
      if (msg.mode === 'replay') this.replay.time = this.replayWindow().start;
    }
    if (msg.preset && PRESETS[msg.preset]) { this.preset = msg.preset; this.manual = {}; this.perCity = {}; }
    if (msg.manual) this.manual = { ...this.manual, ...msg.manual };
    if (msg.clearManual) { this.manual = {}; this.perCity = {}; }
    if (msg.perCity) for (const [slug, v] of Object.entries(msg.perCity)) this.perCity[slug] = { ...(this.perCity[slug] || {}), ...v };
    if (typeof msg.replaySpeed === 'number') this.replay.speed = Math.max(1, Math.min(3600, msg.replaySpeed));
    if (typeof msg.replayPlaying === 'boolean') this.replay.playing = msg.replayPlaying;
    if (typeof msg.replayTime === 'number') this.replay.time = msg.replayTime;
    if (typeof msg.replayFraction === 'number') { const w = this.replayWindow(); this.replay.time = w.start + (w.end - w.start) * Math.min(1, Math.max(0, msg.replayFraction)); }
    if (msg.activeCity && cities.some(c => c.slug === msg.activeCity)) { this.activeCity = msg.activeCity; this.autoCycle = false; this.cycleStarted = Date.now(); }
    if (typeof msg.autoCycle === 'boolean') { this.autoCycle = msg.autoCycle; this.cycleOrder = []; }
    if (msg.refresh) this.poll();
    this.emit('log', `control: ${JSON.stringify(msg)}`);
  }

  // Tracking input: nearest city to a point. Accepts {lat, lon} or map
  // coordinates {u, v} in 0..1 over the Europe bbox (u east, v north).
  visitorAt(p) {
    let lat = p.lat, lon = p.lon;
    if (typeof p.u === 'number' && typeof p.v === 'number') {
      const b = mapping.europe.bbox;
      lon = b.lonMin + p.u * (b.lonMax - b.lonMin);
      lat = b.latMin + p.v * (b.latMax - b.latMin);
    }
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const k = Math.cos(lat * Math.PI / 180);
    let best = null, bd = Infinity;
    for (const c of cities) {
      const d = Math.hypot((c.lon - lon) * k, c.lat - lat);
      if (d < bd) { bd = d; best = c; }
    }
    this.visitor = { slug: best.slug, at: Date.now(), lat, lon };
  }

  replayWindow() {
    const hours = this.hours();
    const end = Math.min(Date.now(), Date.parse(hours[hours.length - 1] || 0));
    return { start: end - 24 * 3600e3, end };
  }

  // Cycle order: highest european_aqi first, recomputed every full pass.
  updateActiveCity(now, states) {
    if (this.visitor && now - this.visitor.at < mapping.visitorHoldSeconds * 1000) {
      this.activeCity = this.visitor.slug;
      this.cycleStarted = now;
      return 'visitor';
    }
    if (!this.autoCycle) return 'manual';
    const dwell = (mapping.cycleSeconds || app.cycleSeconds) * 1000;
    if (!this.cycleOrder.length || (now - this.cycleStarted > dwell && this.cycleIndex >= this.cycleOrder.length - 1)) {
      this.cycleOrder = [...states].sort((a, b) => (b.european_aqi || 0) - (a.european_aqi || 0)).map(s => s.slug);
      this.cycleIndex = 0; this.cycleStarted = now;
    } else if (now - this.cycleStarted > dwell) {
      this.cycleIndex++; this.cycleStarted = now;
    }
    this.activeCity = this.cycleOrder[this.cycleIndex];
    return 'cycle';
  }

  // ------------------------------------------------------------------ frames
  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000; this.lastTick = now;
    if (this.mode === 'replay' && this.replay.playing && this.hasData()) {
      const w = this.replayWindow();
      this.replay.time += dt * 1000 * this.replay.speed;
      if (this.replay.time > w.end) this.replay.time = w.start;      // loop the day
    }
    const t = this.targets(now);
    if (t.key !== this.lastTargetKey) {
      for (const s of t.states) this.easers.get(s.slug).setTarget(s, t.seconds, now);
      this.lastTargetKey = t.key;
    }
    const eased = t.states.map(s => {
      const e = this.easers.get(s.slug).update(now);
      // _n values are recomputed from the eased readings so they stay consistent.
      const r = mapping.reference;
      const c = (v, ref) => Math.min(r.maxN, Math.max(0, v / ref));
      e.no2_n = c(e.no2, r.no2); e.pm25_n = c(e.pm25, r.pm25); e.pm10_n = c(e.pm10, r.pm10); e.o3_n = c(e.o3, r.o3);
      e.max_n = Math.max(e.no2_n, e.pm25_n, e.pm10_n, e.o3_n);
      return e;
    });
    const selection = this.updateActiveCity(now, t.states);
    const active = eased.find(s => s.slug === this.activeCity) || eased[0];
    const sound = soundControls(active);
    const dwell = (mapping.cycleSeconds || app.cycleSeconds) * 1000;

    this.frame = {
      type: 'frame', t: now, mode: this.mode, hasData: this.hasData(),
      source: t.states[0]?.source, dataHour: t.hour || null,
      preset: this.preset, manual: this.manual,
      replay: { ...this.replay, ...this.replayWindow() },
      active: active.slug, selection, cycleRemaining: Math.max(0, dwell - (now - this.cycleStarted)) / 1000, autoCycle: this.autoCycle,
      cities: eased, sound,
      status: { ...this.status, osc: { enabled: app.osc.enabled, host: app.osc.host, port: app.osc.port, sent: this.osc.sent, lastError: this.osc.lastError } },
    };
    this.emit('frame', this.frame);

    if (app.osc.enabled && now - this.lastOsc >= 1000 / app.osc.rateHz) {
      this.lastOsc = now;
      const root = app.osc.addressRoot;
      const msgs = [[`${root}/active`, active.slug]];
      for (const [k, v] of Object.entries(sound)) msgs.push([`${root}/sound/${k}`, v]);
      for (const s of eased) for (const k of ['no2_n', 'pm25_n', 'pm10_n', 'o3_n', 'wind_speed', 'wind_dir', 'lid_m', 'rain']) msgs.push([`${root}/city/${s.slug}/${k}`, s[k]]);
      this.osc.send(msgs);
    }
  }

  hello() {
    return {
      type: 'hello', cities, mapping, presets: PRESETS,
      app: { frameRateHz: app.frameRateHz, osc: app.osc, pollMinutes: app.api.pollMinutes },
      credits: 'Air quality and weather data: Open-Meteo.com (CC BY 4.0), CAMS European air quality ensemble (Copernicus Atmosphere Monitoring Service). Map: Natural Earth. Buildings and streets: © OpenStreetMap contributors (ODbL).',
    };
  }
}
