// Audio-only page: start button (browsers need a gesture), solo/mute per layer,
// meters for the nine controls. Mirrors what goes out over OSC.
import type { StateClient } from '../net/StateClient';
import { SoundEngine, LAYERS, type LayerName } from './SoundEngine';
import { fmt } from '../render/Labels';

export function mountSound(app: HTMLElement, client: StateClient) {
  document.body.classList.add('page');
  app.innerHTML = `
    <h1>Common Air · sound</h1>
    <p class="note">Web Audio prototype, stereo/binaural. The same nine controls are sent over OSC for the final mix. Use solo to hear one mapping on its own.</p>
    <div class="row"><button id="start">start audio</button> <span class="status" id="city"></span></div>
    <h2>Layers</h2>
    <div class="row" id="layers"></div>
    <h2>Controls</h2>
    <div id="meters"></div>
  `;
  const $ = (id: string) => document.getElementById(id)!;
  let engine: SoundEngine | null = null;
  const names: Record<LayerName, string> = { no2: 'NO₂ rumble', pm25: 'PM2.5 bed', pm10: 'PM10 grit', o3: 'O₃ partials' };
  $('layers').innerHTML = LAYERS.map(l => `<button data-solo="${l}">solo ${names[l]}</button><button data-mute="${l}">mute</button>`).join(' ');
  const refreshButtons = () => {
    $('layers').querySelectorAll('button').forEach(b => {
      if (b.dataset.solo) b.classList.toggle('on', engine?.solo === b.dataset.solo);
      if (b.dataset.mute) b.classList.toggle('on', !!engine?.muted.has(b.dataset.mute as LayerName));
    });
  };
  $('layers').querySelectorAll('button').forEach(b => b.onclick = () => {
    if (!engine) return;
    if (b.dataset.solo) engine.setSolo(engine.solo === b.dataset.solo ? null : b.dataset.solo as LayerName);
    if (b.dataset.mute) engine.toggleMute(b.dataset.mute as LayerName);
    if (engine.controls) engine.update(engine.controls);
    refreshButtons();
  });
  $('start').onclick = async () => {
    if (!engine) { engine = new SoundEngine(); await engine.start(); $('start').textContent = 'stop audio'; }
    else if (engine.running) { engine.stop(); $('start').textContent = 'start audio'; }
    else { await engine.start(); $('start').textContent = 'stop audio'; }
  };
  client.onHello((h) => {
    $('meters').innerHTML = Object.entries(h.mapping.sound.controls).map(([k, d]) => `<div class="meter"><span>${k}</span><div class="bar"><i id="m-${k}"></i></div><span id="mv-${k}"></span></div><div class="note" style="margin:-2px 0 6px 130px">${d}</div>`).join('');
  });
  client.onFrame((f) => {
    engine?.update(f.sound);
    $('city').textContent = `active city ${f.active} · ${f.mode}`;
    for (const [k, v] of Object.entries(f.sound)) { const m = document.getElementById(`m-${k}`); if (m) { m.style.width = `${v * 100}%`; $(`mv-${k}`).textContent = fmt(v, 2); } }
  });
}
