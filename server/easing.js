// Glides every numeric field of a per-city state toward its target over a
// fixed duration with a smoothstep ramp. Angles (wind_dir) take the short way round.
import { VALUE_KEYS } from './state.js';

const EASED = [...VALUE_KEYS, 'lid_m'];
const smooth = (t) => t * t * (3 - 2 * t);

export class Easer {
  constructor() { this.cur = null; this.from = null; this.to = null; this.t0 = 0; this.dur = 1; }

  // Set a new target. `seconds` is how long the glide takes.
  setTarget(target, seconds, now = Date.now()) {
    if (!this.cur) { this.cur = { ...target }; this.from = { ...target }; }
    else this.from = { ...this.cur };
    this.to = { ...target };
    this.t0 = now;
    this.dur = Math.max(0.001, seconds);
  }

  update(now = Date.now()) {
    if (!this.to) return null;
    const k = smooth(Math.min(1, (now - this.t0) / 1000 / this.dur));
    const out = { ...this.to };
    for (const key of EASED) {
      const a = this.from[key], b = this.to[key];
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      if (key === 'wind_dir') {
        let d = ((b - a + 540) % 360) - 180;
        out[key] = ((a + d * k) % 360 + 360) % 360;
      } else out[key] = a + (b - a) * k;
    }
    this.cur = out;
    return out;
  }
}
