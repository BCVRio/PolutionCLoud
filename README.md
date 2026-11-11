# Common Air

A data art installation. Fourteen European cities are generative point clouds whose shape, colour, motion and sound follow live air quality and weather. "Common Air" is a working title.

This repository is the real-time software: a small local service that polls the data, and browser pages that render the Europe floor map, the city scrims and the sound prototype.

## Setup and run

You need [Node.js](https://nodejs.org) 20 or newer. Then, in this folder:

```bash
npm install
```

```bash
npm start
```

Open <http://localhost:8080>. That page links to every output:

| Page | What it is |
|---|---|
| `/floor` | Europe view, for the floor projection |
| `/city` | City view with all strata on one screen |
| `/scrim-no2`, `/scrim-pm`, `/scrim-o3` | One stratum per gauze scrim (buildings ride on the PM layer) |
| `/sound` | Web Audio prototype of the sound engine, with solo and mute per layer |
| `/control` | Modes, presets, sliders, active city, data status, OSC status |

`npm run dev` runs the same thing with live reload for editing. Both commands use one process and one port.

Page options: `?q=0.5` scales the particle count (0.1 to 2, remembered per browser), `?labels=0` hides the labels, `?city=milan` pins a city output to one city.

The service keeps running through network loss: it shows the last good data, marks it `cached`, and retries. If it has never fetched anything it shows the simulated presets until the first fetch succeeds. Nothing in the artwork ever shows an error.

Auto-start on boot: see `deploy/` for a systemd unit (Linux), a launchd plist (macOS) and kiosk-mode browser commands.

## Modes

Set from `/control`, or with `curl -X POST localhost:8080/api/set -d '{"mode":"replay"}'`.

- **live**: the current hour from the CAMS Europe model, polled every hour.
- **replay**: the last 24 hours played at an adjustable speed, looping. The easing time shrinks so each hour is reached.
- **simulated**: four presets from the brief (clear air after rain, rush hour, winter inversion, summer ozone afternoon) plus manual sliders. Works with no network.

Every value glides toward its new target over the easing time in `config/mapping.js`. Nothing snaps, including when data arrives, when modes change, or when a visitor changes the city.

## City selection

With nobody tracked, the city view cycles through the cities in order of European AQI, about 90 seconds each. A tracking system selects a city by posting a position:

```bash
curl -X POST localhost:8080/api/visitor -d '{"u":0.52,"v":0.41}'
```

`u`,`v` are 0 to 1 across the Europe map window (east, north), or send `{"lat":..,"lon":..}`. The same message works over the WebSocket as `{"type":"visitor",...}`. The nearest city stays active for `visitorHoldSeconds` after the last update, then cycling resumes. The depth camera bridge itself is phase 6 work.

## Configuration

- `config/cities.json`: the city list. Add or remove cities here.
- `config/mapping.js`: every data-to-visual and data-to-sound mapping, with comments. Reference levels, easing times, colours, particle counts, plume shape, strata behaviour, sound control scaling.
- `config/app.json`: port, API base URLs and key, poll interval, OSC host and port.

Open-Meteo's free tier is for non-commercial use. For a ticketed or sponsored showing, set `OPEN_METEO_API_KEY` in the environment (or `api.key` in `config/app.json`); the service then uses the `customer-` endpoints automatically. On a venue network with an HTTP proxy, run Node with `NODE_USE_ENV_PROXY=1`.

## Data

Air quality: `https://air-quality-api.open-meteo.com/v1/air-quality`, hourly `pm10`, `pm2_5`, `nitrogen_dioxide`, `ozone`, `european_aqi`, `domains=cams_europe`. Weather: `https://api.open-meteo.com/v1/forecast`, hourly `wind_speed_10m`, `wind_direction_10m`, `precipitation`, `shortwave_radiation`, `relative_humidity_2m`, `boundary_layer_height`. All variable names were verified with live calls on 2026-11-11; the boundary layer height is available directly (metres). If it is missing for an hour, the lid is derived from time of day and wind and the state is marked `lid_approx`.

All fourteen cities are fetched in two requests per hour. Every successful response is cached in `data/cache/` and reloaded at start.

State object per city, as published over the WebSocket at 10 Hz and on `GET /api/state`:

```json
{ "city": "Milan", "slug": "milan", "updated": "2026-11-11T08:00Z", "source": "live",
  "no2": 0, "pm25": 0, "pm10": 0, "o3": 0, "no2_n": 0, "pm25_n": 0, "pm10_n": 0, "o3_n": 0, "max_n": 0,
  "wind_speed": 0, "wind_dir": 0, "lid_m": 0, "lid_approx": false, "rain": 0, "solar": 0, "humidity": 0, "european_aqi": 0 }
```

`_n` values are reading divided by the reference level in `config/mapping.js`, clamped 0 to 4. The starting references (NO₂ 10, PM2.5 5, PM10 15, O₃ 100 µg/m³) need checking against current WHO guidance before public use.

Everything shown is a CAMS regional model estimate on an 11 km grid, not a street-level measurement, and is labelled that way wherever a number appears.

## Sound

The service computes nine named controls, each 0 to 1, from the active city and sends them over OSC (UDP, default `127.0.0.1:9000`) at 10 Hz as a bundle:

| Address | Meaning |
|---|---|
| `/commonair/sound/no2_level`, `/no2_density` | Low granular rumble level and grain density |
| `/commonair/sound/pm25_bed` | Filtered noise bed thickness |
| `/commonair/sound/pm10_rate` | Sparse grit and tick event rate |
| `/commonair/sound/o3_bright` | High glassy partials brightness |
| `/commonair/sound/wind_angle` | Rotation of the sound field, wind direction / 360 |
| `/commonair/sound/wind_rate` | Movement rate and modulation depth |
| `/commonair/sound/lid_size` | Reverb size, 0 = low lid close room, 1 = open |
| `/commonair/sound/rain_clear` | Bed clears toward silence |
| `/commonair/active` | Active city slug (string) |
| `/commonair/city/<slug>/<key>` | Raw eased values for every city |

`/sound` is a Web Audio prototype of the same mappings, stereo/binaural, with solo buttons so each mapping can be heard alone. The final mix is expected to run in a dedicated audio tool over OSC.

## City geometry

City buildings and streets come from OpenStreetMap, pre-processed once into `public/data/cities/<slug>.bin`:

```bash
npm run build:cities
```

This queries the Overpass API for a 2 km square around each centre, caches the raw response in `data/osm/`, and writes compact footprints with heights and classified street polylines. The browser samples roof and wall points from the footprints at load (walls snapped to scan rows for the lidar look), so the quality setting can scale the count. Until the files exist, the city view shows a generated placeholder grid city and says so in its corner label.

The Overpass hosts could not be reached from the environment this was built in, so the city files are not yet in the repository. Run the command above once on a normal connection; it takes a few minutes for the fourteen cities. `OVERPASS_URL` overrides the endpoint.

The Europe land points come from Natural Earth via the `world-atlas` package and are already built (`npm run build:europe` regenerates them).

## Decisions worth knowing

- Rendering is Three.js on WebGL2 with the particles computed in vertex shaders from per-particle seeds and uniforms, so no CPU work per particle and no simulation state. The brief suggested WebGPU where available; WebGL2 runs everywhere today and the shader approach already scales to a million points. A WebGPU compute path can be added later behind the same config.
- The service does the slow easing and publishes eased values, so every output shows the same numbers at the same moment. The pages only smooth between 10 Hz frames.
- The city files store footprints rather than finished points so one file serves every quality setting. Points are still never fetched or computed from the network at runtime.

## Status against the build order

| Phase | State |
|---|---|
| 1 Data layer | Done: live, cached, simulated, hourly polling, disk cache, outage recovery |
| 2 Europe view | Done |
| 3 City view | Done with the placeholder city; OSM files need one run of `npm run build:cities` |
| 4 Easing and replay | Done |
| 5 Sound engine | Done as a Web Audio prototype plus OSC |
| 6 Multi-output and tracking | Not started, per the brief: needs the open questions answered. The per-scrim pages and the visitor position endpoint exist so the room integration has something to plug into. Corner pin, edge blending and the depth camera bridge remain. |

## Checks

```bash
npm test
```

```bash
npm run typecheck
```

## Credits

Air quality and weather data: [Open-Meteo](https://open-meteo.com) (CC BY 4.0), using the CAMS European air quality ensemble from the Copernicus Atmosphere Monitoring Service. Map: Natural Earth. Buildings and streets: © OpenStreetMap contributors (ODbL). Type: Space Grotesk and JetBrains Mono.
