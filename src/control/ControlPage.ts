// Control page: mode, presets, manual sliders, replay, active city, status.
// Plain HTML, no artwork. Everything here talks to the service over WebSocket.
import type { StateClient } from '../net/StateClient';
import type { Frame, Hello } from '../types';
import { fmt, hhmm } from '../render/Labels';

const SLIDERS: Array<[string, string, number, number, number]> = [
  // key, label, min, max, step
  ['no2', 'NO₂ µg/m³', 0, 120, 1], ['pm25', 'PM2.5 µg/m³', 0, 150, 1], ['pm10', 'PM10 µg/m³', 0, 250, 1], ['o3', 'O₃ µg/m³', 0, 250, 1],
  ['wind_speed', 'wind km/h', 0, 80, 1], ['wind_dir', 'wind from °', 0, 359, 1], ['lid_m', 'lid m', 80, 2500, 10],
  ['rain', 'rain mm/h', 0, 6, 0.1], ['solar', 'solar W/m²', 0, 900, 10], ['humidity', 'humidity %', 0, 100, 1], ['european_aqi', 'EAQI', 0, 150, 1],
];

export function mountControl(app: HTMLElement, client: StateClient) {
  document.body.classList.add('page');
  app.innerHTML = `
    <h1>Common Air · control</h1>
    <p class="note">Nothing here is shown in the room. Changes glide in over the easing time set in <code>config/mapping.js</code>.</p>

    <h2>Mode</h2>
    <div class="row" id="modes"></div>
    <div class="status" id="modeNote"></div>

    <h2>Replay</h2>
    <div class="row">
      <button id="rpPlay">pause</button>
      speed <input type="number" id="rpSpeed" min="1" max="3600" step="1" style="width:90px"> × realtime
      <input type="range" id="rpPos" min="0" max="1000" step="1" style="width:360px">
      <span class="mono" id="rpTime"></span>
    </div>

    <h2>Simulated presets</h2>
    <div class="row" id="presets"></div>
    <div id="sliders"></div>
    <div class="row"><button id="clearManual">reset sliders to preset</button></div>

    <h2>Active city</h2>
    <div class="row" id="cityBtns"></div>
    <div class="status" id="cycleNote"></div>

    <h2>Cities</h2>
    <table class="cities"><thead><tr><th>city</th><th>source</th><th>NO₂</th><th>PM2.5</th><th>PM10</th><th>O₃</th><th>max n</th><th>wind</th><th>from</th><th>lid m</th><th>rain</th><th>solar</th><th>rh</th><th>EAQI</th></tr></thead><tbody id="cityRows"></tbody></table>
    <p class="note">µg/m³. CAMS Europe regional model estimates, not street-level measurements. Lid marked ~ is approximated from time of day and wind.</p>

    <h2>Sound controls (active city, 0 to 1, sent over OSC)</h2>
    <div id="meters"></div>
    <div class="status" id="oscNote"></div>

    <h2>Data</h2>
    <div class="status" id="data"></div>
    <div class="row"><button id="refresh">fetch now</button></div>

    <h2>Credits</h2>
    <p class="note" id="credits"></p>
  `;
  const $ = (id: string) => document.getElementById(id)!;
  let hello: Hello | null = null;
  let frame: Frame | null = null;
  let dragging = false;

  client.onHello((h) => {
    hello = h;
    $('credits').textContent = h.credits;
    $('modes').innerHTML = ['live', 'replay', 'simulated'].map(m => `<button data-mode="${m}">${m}</button>`).join('');
    $('modes').querySelectorAll('button').forEach(b => b.onclick = () => client.set({ mode: b.dataset.mode }));
    $('presets').innerHTML = Object.entries(h.presets).map(([k, p]: any) => `<button data-preset="${k}">${p.label}</button>`).join('');
    $('presets').querySelectorAll('button').forEach(b => b.onclick = () => client.set({ mode: 'simulated', preset: b.dataset.preset }));
    $('sliders').innerHTML = SLIDERS.map(([k, label, min, max, step]) => `<div class="slider"><span>${label}</span><input type="range" data-key="${k}" min="${min}" max="${max}" step="${step}"><span class="v" id="v-${k}"></span></div>`).join('');
    $('sliders').querySelectorAll('input').forEach(inp => {
      inp.oninput = () => { client.set({ mode: 'simulated', manual: { [inp.dataset.key!]: parseFloat(inp.value) } }); $(`v-${inp.dataset.key}`).textContent = inp.value; };
    });
    $('cityBtns').innerHTML = `<button id="auto">auto cycle</button>` + h.cities.map(c => `<button data-city="${c.slug}">${c.name}</button>`).join('');
    $('auto').onclick = () => client.set({ autoCycle: true });
    $('cityBtns').querySelectorAll('button[data-city]').forEach(b => (b as HTMLButtonElement).onclick = () => client.set({ activeCity: (b as HTMLElement).dataset.city }));
    $('meters').innerHTML = Object.entries(h.mapping.sound.controls).map(([k, d]) => `<div class="meter"><span title="${d}">${k}</span><div class="bar"><i id="m-${k}"></i></div><span id="mv-${k}"></span></div>`).join('');
  });
  $('clearManual').onclick = () => client.set({ clearManual: true });
  $('refresh').onclick = () => client.set({ refresh: true });
  $('rpPlay').onclick = () => client.set({ replayPlaying: !frame?.replay.playing });
  ($('rpSpeed') as HTMLInputElement).onchange = (e) => client.set({ replaySpeed: parseFloat((e.target as HTMLInputElement).value) });
  const pos = $('rpPos') as HTMLInputElement;
  pos.onpointerdown = () => { dragging = true; };
  pos.onpointerup = () => { dragging = false; client.set({ mode: 'replay', replayFraction: parseFloat(pos.value) / 1000 }); };

  client.onFrame((f) => {
    frame = f;
    if (!hello) return;
    $('modes').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === f.mode));
    $('modeNote').innerHTML = `source <b>${f.source}</b> · data hour <b>${f.dataHour || '–'}</b>${f.hasData ? '' : ' · <b>no data yet: showing simulated values until the first fetch succeeds</b>'}`;
    $('presets').querySelectorAll('button').forEach(b => b.classList.toggle('on', f.mode === 'simulated' && b.dataset.preset === f.preset));
    $('rpPlay').textContent = f.replay.playing ? 'pause' : 'play';
    const sp = $('rpSpeed') as HTMLInputElement; if (document.activeElement !== sp) sp.value = String(f.replay.speed);
    if (!dragging) pos.value = String(Math.round((f.replay.time - f.replay.start) / Math.max(1, f.replay.end - f.replay.start) * 1000));
    $('rpTime').textContent = f.mode === 'replay' ? new Date(f.replay.time).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : `window ${new Date(f.replay.start).toISOString().slice(5, 16)} → ${new Date(f.replay.end).toISOString().slice(5, 16)}Z`;
    const active = f.cities.find(c => c.slug === f.active)!;
    for (const [k] of SLIDERS) {
      const inp = $('sliders').querySelector(`input[data-key="${k}"]`) as HTMLInputElement | null;
      if (inp && document.activeElement !== inp) { const v = f.manual[k] ?? (active as any)[k]; inp.value = String(v); $(`v-${k}`).textContent = fmt(v, k === 'rain' ? 1 : 0); }
    }
    $('cityBtns').querySelectorAll('button[data-city]').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.city === f.active));
    $('auto').classList.toggle('on', f.autoCycle);
    $('cycleNote').innerHTML = `selected by <b>${f.selection}</b>${f.selection === 'cycle' ? ` · next city in ${Math.ceil(f.cycleRemaining)} s · order by EAQI, ${hello.mapping.cycleSeconds} s each` : ''}`;
    $('cityRows').innerHTML = f.cities.map(c => `<tr class="${c.slug === f.active ? 'active' : ''}"><td>${c.city}</td><td>${c.source}</td><td>${fmt(c.no2)}</td><td>${fmt(c.pm25)}</td><td>${fmt(c.pm10)}</td><td>${fmt(c.o3)}</td><td>${fmt(c.max_n, 2)}</td><td>${fmt(c.wind_speed)}</td><td>${fmt(c.wind_dir)}°</td><td>${fmt(c.lid_m)}${c.lid_approx ? '~' : ''}</td><td>${fmt(c.rain, 1)}</td><td>${fmt(c.solar)}</td><td>${fmt(c.humidity)}</td><td>${fmt(c.european_aqi)}</td></tr>`).join('');
    for (const [k, v] of Object.entries(f.sound)) { const m = document.getElementById(`m-${k}`); if (m) { m.style.width = `${v * 100}%`; $(`mv-${k}`).textContent = fmt(v, 2); } }
    const o = f.status.osc;
    $('oscNote').innerHTML = `OSC ${o.enabled ? `on → udp://${o.host}:${o.port}, ${o.sent} bundles sent` : 'off'}${o.lastError ? ' · ' + o.lastError : ''} · addresses <code>${hello.app.osc.addressRoot}/sound/&lt;name&gt;</code>, <code>${hello.app.osc.addressRoot}/city/&lt;slug&gt;/&lt;key&gt;</code>, <code>${hello.app.osc.addressRoot}/active</code>`;
    $('data').innerHTML = `last successful fetch <b>${f.status.lastSuccess || 'never'}</b> · attempts ${f.status.attempts}, failures ${f.status.failures} · poll every ${hello.app.pollMinutes} min${f.status.cachedFromDisk ? ' · started from disk cache' : ''}<br>${f.status.lastError ? 'last error: ' + f.status.lastError : 'no errors'}`;
    void hhmm;
  });
}
