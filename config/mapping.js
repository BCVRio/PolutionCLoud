// Common Air: every data-to-visual and data-to-sound mapping lives here.
// Tune this file, not the code. Both the Node service and the browser import it.
//
// Vocabulary
//   *_n   a normalised reading: value / reference, clamped to 0..4.
//         1.0 means "at the reference level", 4.0 means "four times over it".
//   0..1  a control that has been squashed into the unit range for sound/OSC.

export default {
  // ---------------------------------------------------------------------------
  // Data normalisation
  // ---------------------------------------------------------------------------
  reference: {
    // µg/m³. Starting points to be checked against current WHO guidance
    // before public use (WHO 2021 AQG 24h means: NO2 25, PM2.5 15, PM10 45; O3 8h 100.
    // The brief asks for stricter annual-style levels, kept here as requested).
    no2: 10,
    pm25: 5,
    pm10: 15,
    o3: 100,
    // _n values are clamped to this maximum.
    maxN: 4,
  },

  // Boundary layer height (m) used when the API returns none.
  // lid = base + dayBoost * daylight + windGain * windSpeedKmh
  lidFallback: { base: 300, dayBoost: 900, windGain: 25, min: 100, max: 2500 },

  // ---------------------------------------------------------------------------
  // Behaviour over time
  // ---------------------------------------------------------------------------
  easing: {
    // Seconds to glide from the old reading to a new one in live mode.
    seconds: 180,
    // In replay the glide is capped at this fraction of one replayed hour,
    // so a fast replay still reaches each hour's value.
    replayFraction: 0.8,
    // Glide used when switching presets or moving sliders in simulated mode.
    simulatedSeconds: 6,
  },

  // Seconds a tracked visitor keeps a city active after the last position update.
  visitorHoldSeconds: 20,

  // Seconds to dwell on each city when nobody is tracked.
  cycleSeconds: 90,

  // ---------------------------------------------------------------------------
  // Visual language
  // ---------------------------------------------------------------------------
  colours: {
    background: '#06080B',
    land: '#2C3A4A',
    coast: '#4A6076',
    scanline: '#1A2430',
    ring: '#5F7488',
    no2: '#FF8A3D',
    pm25: '#EDE6D6',
    pm10: '#B8AE98',
    o3: '#4DA3FF',
    label: '#C9D1DA',
    labelSecondary: '#9AA6B2',
  },

  post: {
    bloomStrength: 0.45,    // soft glow amount
    bloomRadius: 0.35,
    bloomThreshold: 0.25,
    grain: 0.06,            // visible grain amount, 0..0.2
    vignette: 0.25,
  },

  // Particle counts at quality 1.0. The quality setting scales these.
  counts: {
    europe: {
      plumePerCity: 24000,
      streamlines: 24000,
    },
    city: {
      buildings: 350000,
      no2: 220000,
      pm25: 420000,
      pm10: 40000,
      o3: 180000,
    },
  },

  // ---------------------------------------------------------------------------
  // Europe view (floor)
  // ---------------------------------------------------------------------------
  europe: {
    // Map window in degrees.
    bbox: { lonMin: -12, lonMax: 32, latMin: 34, latMax: 62 },
    cameraTiltDeg: 32,             // 0 = straight down. Plumes need a little tilt to read.
    pointSize: 1.4,                // px at 1080p for land points
    coastPointSize: 1.8,
    plumePointSize: 1.6,
    plumeAlpha: 0.07,              // per-particle brightness at quality 1
    // Plume height for n = 1 (map units where 1 unit = 1 degree of latitude).
    plumeHeightPerN: 2.0,
    plumeMaxHeight: 6.5,
    plumeBaseRadius: 0.35,         // degrees
    plumeRiseSeconds: 14,          // one particle's trip from ring to top
    // Lean per unit height per km/h of wind, in degrees of map.
    leanPerKmh: 0.012,
    stretchPerKmh: 0.01,           // extra radius along the wind per km/h
    // Fraction of the plume height removed by a low lid (lid in m).
    lidCapRefM: 1500,
    lidCapMin: 0.45,
    // Rain thins the plume. alpha *= 1 - rainThin * clamp(rain_mm / rainRefMm)
    rainRefMm: 2.0,
    rainThin: 0.75,
    // Share of the plume's lower third that is NO2 amber at n = 1.
    amberSharePerN: 0.33,
    // PM10 grains mixed into the body: share of body particles at pm10_n = 1.
    grainSharePerN: 0.18,
    grainSize: 2.6,
    // Streamlines across the land.
    streamSpeed: 0.09,             // degrees per second per km/h, times wind speed
    streamLifeSeconds: 18,
    streamPointSize: 1.2,
    ringRadius: 0.45,              // degrees
    ringPoints: 400,
  },

  // ---------------------------------------------------------------------------
  // City view (scrims)
  // ---------------------------------------------------------------------------
  city: {
    extentM: 2000,                 // side of the square around the city centre
    // Camera (shared by all three scrim outputs so the strata line up).
    camera: { distance: 2600, height: 950, fov: 42, orbitSeconds: 0, orbitDeg: 0 },
    buildingPointSize: 1.6,
    buildingAlpha: 1.0,            // the stage: visible, never the brightest thing
    scanRowM: 3.0,                 // wall point rows every N metres (lidar look)
    // Vertical scale: metres in the data to scene units.
    heightScale: 1.0,
    // NO2: emitted along the street network
    no2: {
      pointSize: 1.5,
      alpha: 0.45,
      maxHeightM: 60,              // amber points hover in this band above the street
      riseSeconds: 20,
      roadWeights: { motorway: 1, trunk: 1, primary: 0.85, secondary: 0.6, tertiary: 0.4, residential: 0.15, other: 0.08 },
    },
    // PM2.5: fine grain between roofs and lid
    pm25: {
      pointSize: 1.2,
      alpha: 0.10,
      noiseScaleHumidity: { dry: 90, wet: 25 },   // metres; humidity 0% -> dry, 100% -> wet
      driftSeconds: 60,
      // Low lid compresses the same particles into a denser, brighter mass.
      lidBrightRefM: 1200,
      lidBrightMax: 2.2,
    },
    // PM10: fewer, larger, heavier points that fall, land on buildings and fade
    pm10: {
      pointSize: 3.0,
      alpha: 0.6,
      fallSeconds: 26,
      restSeconds: 8,
    },
    // O3: thin rippling sheet above the lid
    o3: {
      pointSize: 1.3,
      alpha: 0.35,
      thicknessPerN: 40,           // metres at o3_n = 1
      rippleAmpM: 14,
      rippleSpeedSolar: { night: 0.12, noon: 1.1 },  // cycles/s at 0 and 800 W/m²
      solarRefWm2: 800,
    },
    // Wind: velocity field advects every particle; shear increases with height
    wind: {
      mPerSecPerKmh: 0.28,         // horizontal drift at ground, scene m/s per km/h
      shearPerM: 0.0012,           // extra drift per metre of height
    },
    // Rain: points streak down and wash out
    rain: {
      rainRefMm: 2.0,
      fallBoost: 180,              // m/s added downward at full rain
      washout: 0.9,                // alpha removed at full rain
    },
    lidMinM: 80,
    lidMaxM: 2500,
  },

  // ---------------------------------------------------------------------------
  // Sound. Every control below is sent as a 0..1 float over OSC and drives the
  // Web Audio prototype. Names are the OSC address suffixes.
  // ---------------------------------------------------------------------------
  sound: {
    // n value that maps to control 1.0 for the four pollutants.
    fullScaleN: 3.0,
    windSpeedFullKmh: 50,
    lidFullM: 2000,
    rainFullMm: 3.0,
    controls: {
      no2_level:     'Low granular rumble level, from no2_n',
      no2_density:   'Grain density of the rumble, from no2_n',
      pm25_bed:      'Filtered noise bed thickness, from pm25_n',
      pm10_rate:     'Sparse grit and tick event rate, from pm10_n',
      o3_bright:     'High glassy partials brightness, from o3_n',
      wind_angle:    'Rotation of the sound field, wind_dir / 360',
      wind_rate:     'Movement rate and modulation depth, from wind_speed',
      lid_size:      'Reverb size: 0 = low lid close room, 1 = high lid open',
      rain_clear:    'Bed clears toward silence, from rain',
    },
  },
};
