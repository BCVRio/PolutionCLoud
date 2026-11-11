// Fetches hourly air quality and weather for every city in two requests.
// Variable names were verified against the live API on 2026-11-11.
import { app, cities, apiUrls } from './config.js';

export const AQ_VARS = ['pm10', 'pm2_5', 'nitrogen_dioxide', 'ozone', 'european_aqi'];
export const WX_VARS = ['wind_speed_10m', 'wind_direction_10m', 'precipitation', 'shortwave_radiation', 'relative_humidity_2m', 'boundary_layer_height'];

function params(extra) {
  const p = new URLSearchParams({
    latitude: cities.map(c => c.lat).join(','),
    longitude: cities.map(c => c.lon).join(','),
    past_days: String(app.api.pastDays),
    forecast_days: String(app.api.forecastDays),
    timezone: 'UTC',
    ...extra,
  });
  const { key } = apiUrls();
  if (key) p.set('apikey', key);
  return p;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), app.api.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'common-air/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// Open-Meteo returns one object for a single location and an array for many.
const asArray = (j) => Array.isArray(j) ? j : [j];

// Returns { fetched, hours: [iso...], cities: { slug: { pm10: [...], ... } } }
export async function fetchAirQuality() {
  const { aq } = apiUrls();
  const j = asArray(await getJson(`${aq}?${params({ hourly: AQ_VARS.join(','), domains: app.api.domains })}`));
  return pack(j, AQ_VARS);
}

export async function fetchWeather() {
  const { wx } = apiUrls();
  const j = asArray(await getJson(`${wx}?${params({ hourly: WX_VARS.join(',') })}`));
  return pack(j, WX_VARS);
}

function pack(results, vars) {
  if (results.length !== cities.length) throw new Error(`expected ${cities.length} locations, got ${results.length}`);
  const out = { fetched: new Date().toISOString(), hours: results[0].hourly.time.map(t => t + 'Z'), units: results[0].hourly_units, cities: {} };
  cities.forEach((c, i) => {
    const h = results[i].hourly;
    const rec = {};
    for (const v of vars) rec[v] = h[v];
    out.cities[c.slug] = rec;
  });
  return out;
}
