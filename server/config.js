// Loads config files once and resolves API URLs (free vs customer endpoints).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mapping from '../config/mapping.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

export const app = read('config/app.json');
export const cities = read('config/cities.json');
export { mapping };

export const DATA_DIR = path.join(ROOT, 'data', 'cache');
fs.mkdirSync(DATA_DIR, { recursive: true });

// An API key switches both hosts to the paid `customer-` prefix unless the
// base URLs were overridden explicitly. The key comes from the environment
// (OPEN_METEO_API_KEY) or from config/app.json.
export function apiUrls() {
  const key = process.env.OPEN_METEO_API_KEY || app.api.key || '';
  let aq = process.env.OPEN_METEO_AQ_BASE || app.api.airQualityBase;
  let wx = process.env.OPEN_METEO_WX_BASE || app.api.weatherBase;
  if (key) {
    aq = aq.replace('https://air-quality-api.', 'https://customer-air-quality-api.');
    wx = wx.replace('https://api.', 'https://customer-api.');
  }
  return { aq, wx, key };
}
