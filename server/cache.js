// Disk cache for the last good API responses. Written atomically.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export function save(name, obj) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

export function load(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8')); }
  catch { return null; }
}
