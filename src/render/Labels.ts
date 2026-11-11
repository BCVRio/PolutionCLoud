// HTML labels positioned by projecting 3D points. Small mono type only.
import * as THREE from 'three';
import type { CityState } from '../types';

export const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');

export function hhmm(iso: string | null | undefined) {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

export function sourceLine(s: CityState | undefined, mode: string) {
  if (!s) return '';
  const src = mode === 'replay' ? 'replay' : s.source;
  const when = s.updated ? `data hour ${hhmm(s.updated)}` : 'no data hour';
  return `${src} · ${when} · CAMS regional model estimate, not a street measurement`;
}

export class LabelLayer {
  root: HTMLDivElement;
  items = new Map<string, HTMLDivElement>();
  private v = new THREE.Vector3();
  constructor(container: HTMLElement) {
    this.root = document.createElement('div'); this.root.className = 'labels'; container.appendChild(this.root);
  }
  get(key: string) {
    let el = this.items.get(key);
    if (!el) { el = document.createElement('div'); el.className = 'label'; this.root.appendChild(el); this.items.set(key, el); }
    return el;
  }
  place(key: string, world: THREE.Vector3, camera: THREE.Camera, w: number, h: number, html: string, active = false) {
    const el = this.get(key);
    this.v.copy(world).project(camera);
    const x = (this.v.x * 0.5 + 0.5) * w, y = (-this.v.y * 0.5 + 0.5) * h;
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    el.style.display = this.v.z < 1 ? '' : 'none';
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('active', active);
  }
  corner(pos: 'tl' | 'tr' | 'bl' | 'br', html: string) {
    const key = `corner-${pos}`;
    let el = this.items.get(key);
    if (!el) { el = document.createElement('div'); el.className = `corner ${pos}`; this.root.appendChild(el); this.items.set(key, el); }
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}
