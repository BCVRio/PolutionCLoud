// Pure functions: hourly series -> per-city state objects, normalisation,
// lid fallback, simulated presets and the 0..1 sound controls.
import { cities, mapping } from './config.js';

export const VALUE_KEYS = ['no2', 'pm25', 'pm10', 'o3', 'wind_speed', 'wind_dir', 'lid_m', 'rain', 'solar', 'humidity', 'european_aqi'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

export function normalise(value, ref) {
  if (value == null) return 0;
  return clamp(value / ref, 0, mapping.reference.maxN);
}

// Boundary layer height when the API has none: time of day and wind.
export function lidFallback(hourUtc, lon, windKmh) {
  const f = mapping.lidFallback;
  const localHour = ((hourUtc + lon / 15) % 24 + 24) % 24;
  const daylight = Math.max(0, Math.sin((localHour - 6) / 12 * Math.PI)); // 0 at 06/18, 1 at noon
  return clamp(f.base + f.dayBoost * daylight + f.windGain * (windKmh || 0), f.min, f.max);
}

export function withNormalised(s) {
  const r = mapping.reference;
  s.no2_n = normalise(s.no2, r.no2);
  s.pm25_n = normalise(s.pm25, r.pm25);
  s.pm10_n = normalise(s.pm10, r.pm10);
  s.o3_n = normalise(s.o3, r.o3);
  s.max_n = Math.max(s.no2_n, s.pm25_n, s.pm10_n, s.o3_n);
  return s;
}

// Index of the hour in a series at or before `date`, or -1.
export function hourIndex(hours, date) {
  const t = date.getTime();
  let best = -1;
  for (let i = 0; i < hours.length; i++) if (Date.parse(hours[i]) <= t) best = i; else break;
  return best;
}

// Builds one city's state from the two series at hour index i.
// Missing values hold `prev` (the last good state) and the source becomes 'cached'.
export function stateAt(city, aq, wx, i, source, prev) {
  const a = aq?.cities[city.slug], w = wx?.cities[city.slug];
  const pick = (rec, key) => rec ? num(rec[key]?.[i]) : null;
  const hold = (key, v) => v != null ? v : (prev ? prev[key] : 0);
  let missing = false;
  const take = (key, v) => { if (v == null) missing = true; return hold(key, v); };

  const s = { city: city.name, slug: city.slug, lat: city.lat, lon: city.lon };
  s.no2 = take('no2', pick(a, 'nitrogen_dioxide'));
  s.pm25 = take('pm25', pick(a, 'pm2_5'));
  s.pm10 = take('pm10', pick(a, 'pm10'));
  s.o3 = take('o3', pick(a, 'ozone'));
  s.european_aqi = take('european_aqi', pick(a, 'european_aqi'));
  s.wind_speed = take('wind_speed', pick(w, 'wind_speed_10m'));
  s.wind_dir = take('wind_dir', pick(w, 'wind_direction_10m'));
  s.rain = take('rain', pick(w, 'precipitation'));
  s.solar = take('solar', pick(w, 'shortwave_radiation'));
  s.humidity = take('humidity', pick(w, 'relative_humidity_2m'));
  const lid = pick(w, 'boundary_layer_height');
  if (lid != null) { s.lid_m = lid; s.lid_approx = false; }
  else {
    const hour = aq?.hours?.[i] || wx?.hours?.[i];
    s.lid_m = lidFallback(hour ? new Date(hour).getUTCHours() : 12, city.lon, s.wind_speed);
    s.lid_approx = true;
  }
  s.updated = (aq?.hours?.[i] || wx?.hours?.[i] || null);
  s.source = missing && source === 'live' ? 'cached' : source;
  return withNormalised(s);
}

// ---------------------------------------------------------------------------
// Simulated mode: the four reference states from the brief.
// ---------------------------------------------------------------------------
export const PRESETS = {
  clear:     { label: 'Clear air after rain',     no2: 4,   pm25: 2,  pm10: 6,  o3: 45,  wind_speed: 38, wind_dir: 250, lid_m: 1900, rain: 0.4, solar: 350, humidity: 70, european_aqi: 12 },
  rush:      { label: 'Rush hour',                no2: 42,  pm25: 6,  pm10: 16, o3: 30,  wind_speed: 6,  wind_dir: 120, lid_m: 800,  rain: 0,   solar: 150, humidity: 55, european_aqi: 48 },
  inversion: { label: 'Winter inversion',         no2: 22,  pm25: 70, pm10: 95, o3: 8,   wind_speed: 1,  wind_dir: 0,   lid_m: 150,  rain: 0,   solar: 40,  humidity: 88, european_aqi: 92 },
  ozone:     { label: 'Summer ozone afternoon',   no2: 8,   pm25: 7,  pm10: 14, o3: 165, wind_speed: 16, wind_dir: 200, lid_m: 2100, rain: 0,   solar: 820, humidity: 30, european_aqi: 70 },
};

// A full set of simulated states. `manual` overrides the preset for every
// city; `perCity` is a slug-keyed map of further overrides.
export function simulatedStates(presetKey, manual = {}, perCity = {}, seedSpread = 0.25) {
  const base = PRESETS[presetKey] || PRESETS.clear;
  return cities.map((c, i) => {
    const s = { city: c.name, slug: c.slug, lat: c.lat, lon: c.lon, source: 'simulated', updated: null, lid_approx: false };
    // A small deterministic spread per city so the map is not 14 identical plumes.
    const spread = 1 + seedSpread * Math.sin(i * 2.3 + 0.7);
    for (const k of VALUE_KEYS) {
      let v = base[k];
      if (['no2', 'pm25', 'pm10', 'o3', 'european_aqi'].includes(k)) v *= spread;
      if (manual[k] != null) v = manual[k];
      if (perCity[c.slug]?.[k] != null) v = perCity[c.slug][k];
      s[k] = v;
    }
    return withNormalised(s);
  });
}

// ---------------------------------------------------------------------------
// Sound controls: every value squashed to 0..1 with the names in mapping.sound.
// ---------------------------------------------------------------------------
export function soundControls(s) {
  const m = mapping.sound;
  const u = (v) => clamp(v, 0, 1);
  const n = (v) => u(v / m.fullScaleN);
  return {
    no2_level: n(s.no2_n),
    no2_density: n(s.no2_n) ** 0.7,
    pm25_bed: n(s.pm25_n),
    pm10_rate: n(s.pm10_n),
    o3_bright: n(s.o3_n),
    wind_angle: ((s.wind_dir % 360) + 360) % 360 / 360,
    wind_rate: u(s.wind_speed / m.windSpeedFullKmh),
    lid_size: u(s.lid_m / m.lidFullM),
    rain_clear: u(s.rain / m.rainFullMm),
  };
}
