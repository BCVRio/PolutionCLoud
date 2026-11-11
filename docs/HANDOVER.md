# Common Air: build handover

A data art installation. Each of 14 European cities is a generative point cloud whose shape, colour, motion and sound are driven by live air quality and weather data. "Common Air" is a working title.

This file is the brief for building the real-time software. The design canvas and `pollution_cloud_render.py` (offline Python still renderer) are the visual reference. Match their look; do not port the Python.

## 1. What to build

A real-time particle application with two views, fed by one shared data layer:

1. **Europe view** (floor projection). A point cloud map of Europe. Each city has a ground ring and a plume of particles rising from it. Wind streamlines drift across the land between cities.
2. **City view** (three layered gauze scrims). One city as a lidar-style building point cloud with three pollutant strata above it. The active city is chosen by where a visitor stands on the floor map, or cycles automatically when the room is empty.

Plus a **sound engine** driven by the same values (section 7).

No charts, gauges or dashboards in the artwork. Numbers appear only as small mono labels.

## 2. Build order

Build and confirm each phase before starting the next.

| Phase | Deliverable | Done when |
|---|---|---|
| 1 | Data layer with live, cached and simulated modes | One JSON state object per city updates hourly and survives a network outage |
| 2 | Europe view on a single screen | 14 plumes respond to live values and lean with real wind |
| 3 | City view on a single screen | Four states in section 6 are reproducible from the simulated mode |
| 4 | Value easing and day replay | No visible jump when new data arrives; a 24 hour replay can run at speed |
| 5 | Sound engine | Each mapping in section 7 is audible in isolation |
| 6 | Multi-output and tracking | Floor blend, three scrim outputs, visitor position selects a city |

Phases 1 to 4 need only a laptop. Do not start phase 6 until the open questions in section 10 are answered.

## 3. Suggested stack

Suggestion, not a requirement. Say so before changing it.

- Browser app: TypeScript, Vite, Three.js with a GPU particle system (WebGPU where available, WebGL2 fallback).
- One page per output (`/floor`, `/scrim-no2`, `/scrim-pm`, `/scrim-o3`, `/control`), kept in sync over a local WebSocket or BroadcastChannel.
- A small local Node service that polls the APIs, caches to disk and serves the state object. The render pages never call the APIs directly.
- Sound: Web Audio for the prototype. Expose all sound parameters over OSC as well so the final mix can run in a dedicated audio tool.

The owner is not a programmer. Keep setup to one install command and one run command, and document both in a README.

## 4. Data

### Air quality

- Endpoint: `https://air-quality-api.open-meteo.com/v1/air-quality`
- Hourly variables: `pm10`, `pm2_5`, `nitrogen_dioxide`, `ozone`, `european_aqi`
- Use `domains=cams_europe` (0.1 degree, about 11 km grid)
- Units are µg/m³ for the four pollutants

### Weather

- Endpoint: `https://api.open-meteo.com/v1/forecast`
- Variables: `wind_speed_10m`, `wind_direction_10m`, `precipitation`, `shortwave_radiation`, `relative_humidity_2m`
- Boundary layer height: the docs list it as available but the exact parameter name was not confirmed. Look it up in the Open-Meteo parameter reference before using it. If it is unavailable, derive the lid from time of day and wind speed and flag that it is approximated.

### Rules

- Verify every variable name against the live docs with a test call before building on it.
- The model data updates once or twice a day and is hourly in resolution. Poll hourly at most. Smoothness comes from easing (section 8), not from faster polling.
- Cache every successful response to disk. On failure, keep showing the last good data and show a small "last updated" time. Never show an error state in the artwork.
- Free access is for non-commercial use. A ticketed or sponsored installation may count as commercial, which needs an API key and the `customer-` URL prefix. Make the base URL and key configurable.
- Attribution is required: credit Open-Meteo and the CAMS ensemble data provider. Add a credits line to the control page and README.
- Model data is a regional estimate, not a street-level measurement. Label it that way anywhere a number is shown.
- Optional later: station measurements (OpenAQ or the European Environment Agency) as ground truth. Not needed for phases 1 to 5.

### Cities

| City | Lat | Lon |
|---|---|---|
| London | 51.51 | -0.13 |
| Paris | 48.86 | 2.35 |
| Madrid | 40.42 | -3.70 |
| Lisbon | 38.72 | -9.14 |
| Barcelona | 41.39 | 2.17 |
| Milan | 45.46 | 9.19 |
| Amsterdam | 52.37 | 4.90 |
| Berlin | 52.52 | 13.40 |
| Stockholm | 59.33 | 18.07 |
| Warsaw | 52.23 | 21.01 |
| Kraków | 50.06 | 19.94 |
| Bucharest | 44.43 | 26.10 |
| Sofia | 42.70 | 23.32 |
| Athens | 37.98 | 23.73 |

Keep the list in a config file so cities can be added or removed.

### State object (per city)

```json
{
  "city": "Milan",
  "updated": "2026-11-11T08:00Z",
  "source": "live | cached | simulated",
  "no2": 0, "pm25": 0, "pm10": 0, "o3": 0,
  "no2_n": 0, "pm25_n": 0, "pm10_n": 0, "o3_n": 0,
  "wind_speed": 0, "wind_dir": 0,
  "lid_m": 0, "rain": 0, "solar": 0, "humidity": 0
}
```

`_n` values are normalised: reading divided by a reference level, clamped to 0 to 4. Starting reference levels, in µg/m³, to be checked against current WHO guidance before public use: NO₂ 10, PM2.5 5, PM10 15, O₃ 100. Keep them in config.

## 5. Visual language

- Background `#06080B`. Additive blending, soft glow, visible grain. Points are small (1 to 2 px at 1080p) and numerous, not large sprites.
- Land and buildings: cool blue grey, dim. They are the stage, never the brightest thing.
- NO₂: amber `#FF8A3D`
- PM2.5: bone white `#EDE6D6`
- PM10: darker bone `#B8AE98`, larger and fewer
- O₃: blue `#4DA3FF`
- Type: Space Grotesk for titles, JetBrains Mono for labels and values. Label colour `#C9D1DA`, secondary `#9AA6B2`.
- Land points sit on faint latitude scan lines. Coastlines are a slightly brighter line of points.

## 6. Mapping: data to point behaviour

| Signal | Europe view | City view |
|---|---|---|
| NO₂ | Amber root of the plume; share of the plume's lower third | Amber points emitted along the street network, densest on main roads. Count follows `no2_n` |
| PM2.5 | White body of the plume | Fine grain filling the volume between roofs and the lid. Density follows `pm25_n`; noise scale follows humidity |
| PM10 | Mixed into the body as larger grains | Fewer, larger, heavier points that fall, land on buildings and fade |
| O₃ | Blue top of the plume | Thin rippling sheet above the lid. Thickness follows `o3_n`; ripple speed follows solar radiation |
| Wind | Plume leans with direction, stretches with speed; streamlines flow across the map | A velocity field advects every particle; shear increases with height |
| Boundary layer height | Caps plume height | The lid. A low lid compresses the same particles into a denser, brighter mass |
| Rain | Plume thins | Points streak down and wash out, briefly leaving the bare building cloud |

Plume height on the Europe view = the largest of the four `_n` values, so the tallest plume is always the city furthest over its reference level.

### Four reference states (use as test presets in simulated mode)

| State | NO₂ | PM | O₃ | Wind | Lid |
|---|---|---|---|---|---|
| Clear air after rain | very low | very low | low | strong | high |
| Rush hour | very high | low | low | light | medium |
| Winter inversion | medium | very high | very low | still | very low |
| Summer ozone afternoon | low | low | very high | moderate | high |

### City geometry

- Buildings from OpenStreetMap footprints and heights for each city centre (roughly a 2 km square), converted to points sampled on roofs and walls, with wall points snapped to horizontal scan rows for a lidar look.
- Street network from OpenStreetMap, classified so main roads can emit more NO₂.
- Pre-process once per city into a binary point file. Do not fetch geometry at runtime.
- Open lidar can replace this later where a city publishes it.
- The reference script uses a generated grid city. That is a placeholder only.

## 7. Sound

Every parameter below must be exposed as a named, normalised 0 to 1 control, and sent over OSC.

| Signal | Sound |
|---|---|
| NO₂ | Low granular rumble; level and grain density |
| PM2.5 | Filtered noise bed that thickens |
| PM10 | Sparse grit and ticks; event rate |
| O₃ | High glassy partials; brightness |
| Wind direction | Rotates the whole sound field around the speaker ring |
| Wind speed | Movement rate and modulation depth |
| Boundary layer height | Reverb size: low lid, close room |
| Rain | Bed clears toward near silence |

Target playback is an eight-speaker ring with ambisonic decoding. The prototype can be stereo or binaural. Final sound design and mix will be done by the owner; the software's job is clean, well-named control data.

## 8. Behaviour over time

- Ease every value toward its new reading over several minutes. Nothing snaps.
- Europe view runs continuously.
- City view: a tracked visitor standing on a city promotes it. With nobody tracked, cycle through cities starting with the highest `european_aqi`, about 90 seconds each.
- Replay mode: play the last 24 hours at an adjustable speed, for demos and for quiet periods.
- Simulated mode: the four presets above plus manual sliders on the control page, so the piece can be shown and tested with no network.

## 9. Room (for phase 6)

- Blackout room. Floor map projected from overhead by two blended projectors.
- Three translucent gauze scrims in parallel at one end, about 60 cm apart: NO₂ nearest the viewer, PM in the middle, O₃ at the back. Each scrim gets its own render output containing only its stratum, with the building cloud on the middle layer.
- One overhead depth camera tracks standing positions on the floor map and maps them to the nearest city.
- Eight speakers at ear height around the perimeter.
- Build the calibration tools in software: per-output corner pin, blend edges, and a floor-to-map alignment mode that shows city rings and names only.

## 10. Open questions to ask before phase 6

1. Room dimensions and ceiling height.
2. Projector count, model, resolution and throw.
3. Scrim size and whether front or rear projection.
4. Depth camera model.
5. Playback machine and GPU.
6. Audio interface, speaker count, and whether sound runs in the browser or in a separate tool over OSC.
7. Whether the venue has reliable internet, and whether the showing is commercial (affects API licensing).

Ask these rather than guessing. Phases 1 to 5 do not depend on them.

## 11. Quality bar

- 60 fps at 1080p per output on the target machine, with at least one million particles in the city view. Add a quality setting that scales particle count.
- Runs unattended for a full day: no memory growth, automatic recovery from network loss, auto-start on boot.
- Every data-to-visual and data-to-sound mapping lives in one config file with comments, so it can be tuned without touching code.
- Never invent readings. If a value is missing, hold the last good value and mark the state as cached.
