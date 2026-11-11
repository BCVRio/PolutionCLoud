import type { StateClient } from '../net/StateClient';

export function mountHome(app: HTMLElement, client: StateClient) {
  document.body.classList.add('page');
  app.innerHTML = `
    <h1>Common Air</h1>
    <p>Fourteen European cities as point clouds driven by live air quality and weather. Working title.</p>
    <h2>Outputs</h2>
    <div class="links">
      <a href="/floor">/floor</a> Europe map (floor projection)<br>
      <a href="/city">/city</a> City view, all strata on one screen<br>
      <a href="/scrim-no2">/scrim-no2</a> <a href="/scrim-pm">/scrim-pm</a> <a href="/scrim-o3">/scrim-o3</a> one stratum per gauze scrim<br>
      <a href="/sound">/sound</a> Web Audio prototype of the sound engine<br>
      <a href="/control">/control</a> modes, presets, sliders, status
    </div>
    <h2>Options</h2>
    <p class="mono">?q=0.5 &nbsp; particle quality (0.1 to 2, remembered per browser) &nbsp;·&nbsp; ?labels=0 &nbsp; hide labels &nbsp;·&nbsp; ?city=milan &nbsp; pin a city output</p>
    <h2>Status</h2>
    <div class="status" id="status">connecting…</div>
    <h2>Credits</h2>
    <p id="credits"></p>
  `;
  client.onHello((h) => { document.getElementById('credits')!.textContent = h.credits; });
  client.onFrame((f) => {
    document.getElementById('status')!.innerHTML = `mode <b>${f.mode}</b> · source <b>${f.source}</b> · data hour <b>${f.dataHour || '–'}</b> · active city <b>${f.active}</b><br>last fetch ${f.status.lastSuccess || 'never'} ${f.status.lastError ? '· last error ' + f.status.lastError : ''}`;
  });
}
