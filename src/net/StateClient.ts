// WebSocket client with reconnect. Frames arrive at ~10 Hz from the service;
// `sample()` interpolates linearly between the last two so values move
// smoothly at 60 fps. The service does the slow easing; this only smooths.
import type { Frame, Hello, CityState } from '../types';

type Listener = (f: Frame) => void;

export class StateClient {
  hello: Hello | null = null;
  frame: Frame | null = null;
  private prev: Frame | null = null;
  private prevAt = 0; private frameAt = 0;
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private helloListeners: ((h: Hello) => void)[] = [];
  connected = false;
  private sampled = new Map<string, CityState>();

  constructor(private url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`) { this.connect(); }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'hello') { this.hello = msg; this.helloListeners.forEach(l => l(msg)); }
      else if (msg.type === 'frame') {
        this.prev = this.frame; this.prevAt = this.frameAt;
        this.frame = msg; this.frameAt = performance.now();
        this.listeners.forEach(l => l(msg));
      }
    };
    ws.onclose = () => { this.connected = false; setTimeout(() => this.connect(), 1500); };
    ws.onerror = () => ws.close();
  }

  onFrame(l: Listener) { this.listeners.push(l); if (this.frame) l(this.frame); }
  onHello(l: (h: Hello) => void) { this.helloListeners.push(l); if (this.hello) l(this.hello); }

  send(msg: object) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  set(fields: object) { this.send({ type: 'set', ...fields }); }

  // Interpolated city states for the current render frame.
  sample(): Map<string, CityState> {
    const f = this.frame;
    if (!f) return this.sampled;
    const p = this.prev;
    const dt = this.frameAt - this.prevAt;
    let k = p && dt > 0 ? Math.min(1, (performance.now() - this.frameAt) / dt) : 1;
    for (let i = 0; i < f.cities.length; i++) {
      const b = f.cities[i], a = p?.cities[i];
      const out = this.sampled.get(b.slug) || ({ ...b } as CityState);
      for (const key in b) {
        const bv = (b as any)[key];
        if (typeof bv !== 'number' || !a) { (out as any)[key] = bv; continue; }
        const av = (a as any)[key];
        if (key === 'wind_dir') { const d = ((bv - av + 540) % 360) - 180; (out as any)[key] = ((av + d * k) % 360 + 360) % 360; }
        else (out as any)[key] = av + (bv - av) * k;
      }
      this.sampled.set(b.slug, out);
    }
    return this.sampled;
  }

  active(): CityState | null {
    const f = this.frame; if (!f) return null;
    return this.sample().get(f.active) || null;
  }
}
