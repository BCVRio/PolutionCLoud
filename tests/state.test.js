import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, lidFallback, hourIndex, stateAt, simulatedStates, soundControls, PRESETS } from '../server/state.js';
import { Easer } from '../server/easing.js';
import { encodeMessage, encodeBundle } from '../server/osc.js';
import { cities, mapping } from '../server/config.js';

test('normalise divides by the reference and clamps to maxN', () => {
  assert.equal(normalise(10, 10), 1);
  assert.equal(normalise(1000, 10), mapping.reference.maxN);
  assert.equal(normalise(null, 10), 0);
});

test('lid fallback is higher by day and with wind, within bounds', () => {
  const night = lidFallback(2, 0, 0), noon = lidFallback(12, 0, 0), windy = lidFallback(12, 0, 40);
  assert.ok(noon > night && windy > noon);
  assert.ok(night >= mapping.lidFallback.min && windy <= mapping.lidFallback.max);
});

test('hourIndex picks the hour at or before the date', () => {
  const hours = ['2026-11-11T06:00Z', '2026-11-11T07:00Z', '2026-11-11T08:00Z'];
  assert.equal(hourIndex(hours, new Date('2026-11-11T07:30Z')), 1);
  assert.equal(hourIndex(hours, new Date('2026-11-11T05:00Z')), -1);
});

test('stateAt holds the last good value and marks cached when a reading is missing', () => {
  const city = cities[0];
  const aq = { hours: ['2026-11-11T08:00Z'], cities: { [city.slug]: { nitrogen_dioxide: [null], pm2_5: [4], pm10: [8], ozone: [60], european_aqi: [20] } } };
  const wx = { hours: ['2026-11-11T08:00Z'], cities: { [city.slug]: { wind_speed_10m: [12], wind_direction_10m: [90], precipitation: [0], shortwave_radiation: [100], relative_humidity_2m: [60], boundary_layer_height: [null] } } };
  const prev = { no2: 30 };
  const s = stateAt(city, aq, wx, 0, 'live', prev);
  assert.equal(s.no2, 30);               // held
  assert.equal(s.source, 'cached');      // flagged
  assert.equal(s.lid_approx, true);      // lid derived
  assert.equal(s.pm25_n, 4 / mapping.reference.pm25);
});

test('the four presets exist and produce 14 normalised states', () => {
  for (const k of ['clear', 'rush', 'inversion', 'ozone']) assert.ok(PRESETS[k]);
  const states = simulatedStates('inversion');
  assert.equal(states.length, cities.length);
  assert.ok(states.every(s => s.source === 'simulated' && s.pm25_n > 2));
  const manual = simulatedStates('clear', { no2: 50 });
  assert.ok(manual.every(s => s.no2 === 50));
});

test('sound controls are named as in the mapping and bounded 0..1', () => {
  const c = soundControls(simulatedStates('ozone')[0]);
  assert.deepEqual(Object.keys(c).sort(), Object.keys(mapping.sound.controls).sort());
  for (const v of Object.values(c)) assert.ok(v >= 0 && v <= 1);
});

test('easer glides and takes the short way round for wind direction', () => {
  const e = new Easer();
  e.setTarget({ no2: 0, wind_dir: 350 }, 10, 0);
  e.setTarget({ no2: 10, wind_dir: 10 }, 10, 0);
  const mid = e.update(5000);
  assert.ok(mid.no2 > 4 && mid.no2 < 6);
  assert.ok(mid.wind_dir < 5 || mid.wind_dir > 355);   // crossed through north, not through 180
  assert.equal(e.update(20000).no2, 10);
});

test('OSC messages are 4-byte aligned with a float type tag', () => {
  const m = encodeMessage('/commonair/sound/no2_level', [0.5]);
  assert.equal(m.length % 4, 0);
  assert.equal(m.toString('latin1', 0, 27), '/commonair/sound/no2_level\0');
  assert.equal(m.readFloatBE(m.length - 4), 0.5);
  const b = encodeBundle([m]);
  assert.equal(b.toString('latin1', 0, 7), '#bundle');
});
