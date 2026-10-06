process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const buoy = require('../src/coin/buoy');
const { step, bojeParams, isStorm, initialState, mulberry32, BOJE_PARAMS, BOJE_WEATHER } = require('../src/coin/model');

const SAMPLE = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 10 05 21 40  40  6.0  8.0    MM    MM    MM  MM 1019.3  25.3  26.0  22.1   MM   MM    MM
2026 10 05 21 30  40   MM  8.0    MM    MM    MM  MM 1019.4  25.3  26.0  22.1   MM   MM    MM
2026 10 05 21 20  50  7.0  9.0    MM    MM    MM  MM 1019.5  25.4  26.0    MM   MM   MM    MM
`;

test('Boje: NOAA-Datei lesen, Zeilen ohne Wind/Böen/Druck auslassen, aufsteigend sortiert', () => {
  const list = buoy.parse(SAMPLE);
  assert.deepEqual(list, [
    { t: Date.UTC(2026, 9, 5, 21, 20), w: 7, g: 9, p: 1019.5 },
    { t: Date.UTC(2026, 9, 5, 21, 40), w: 6, g: 8, p: 1019.3 },
  ]);
  assert.deepEqual(buoy.parse('Fehlerseite\n<html>'), []);
});

test('Boje: letzte Messung zum Zeitpunkt, höchstens 2 Stunden alt', () => {
  const list = buoy.parse(SAMPLE);
  const t0 = Date.UTC(2026, 9, 5, 21, 20);
  assert.equal(buoy.at(t0 - 1, list), null); // vor der ersten Messung
  assert.equal(buoy.at(t0 + 5 * 60e3, list).w, 7);
  assert.equal(buoy.at(t0 + 20 * 60e3, list).w, 6);
  assert.equal(buoy.at(t0 + 20 * 60e3 + buoy.MAX_AGE, list).w, 6);
  assert.equal(buoy.at(t0 + 20 * 60e3 + buoy.MAX_AGE + 1, list), null); // Boje meldet nichts mehr
});

test('51101 Coin: mehr Wind = mehr Unruhe, Böen = mehr Sprünge, Sturm ab 13 m/s oder 1008 hPa', () => {
  const calm = bojeParams({ w: 3, g: 4, p: 1018 });
  const windy = bojeParams({ w: 15, g: 17, p: 1015 });
  const gusty = bojeParams({ w: 8, g: 16, p: 1015 });
  assert.ok(windy.baseVol > calm.baseVol);
  assert.equal(calm.big.rate, BOJE_PARAMS.big.rate);
  assert.equal(gusty.big.rate, BOJE_PARAMS.big.rate + BOJE_WEATHER.gustRate * 6);
  assert.equal(bojeParams(null).baseVol, BOJE_WEATHER.offlineVol);
  assert.equal(BOJE_PARAMS.big.rate, 1, 'Grundmodell bleibt unverändert');

  assert.ok(!isStorm(null));
  assert.ok(!isStorm({ w: 12.9, g: 15, p: 1012 }));
  assert.ok(isStorm({ w: 13, g: 15, p: 1012 }));
  assert.ok(isStorm({ w: 6, g: 8, p: 1008 }));
});

/** Log-Tagesrenditen bei gleichbleibendem Wetter c (5-Minuten-Schritte) */
function dailyLogs(c, days, seed) {
  const rng = mulberry32(seed);
  const params = bojeParams(c);
  let s = initialState(10, params);
  const logs = [];
  for (let d = 0; d < days; d++) {
    const open = s.price;
    for (let i = 0; i < 288; i++) s = step(s, 1 / 288, rng, params);
    logs.push(Math.log(s.price / open));
    s = { ...s, price: 10 }; // wie ein Split: immer im gleichen Bereich weiter
  }
  return logs;
}

test('51101 Coin: Wetter bestimmt die Unruhe, nicht die Richtung', () => {
  const sd = (a) => Math.sqrt(a.reduce((x, r) => x + r * r, 0) / a.length);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const calm = dailyLogs({ w: 3, g: 4, p: 1018 }, 400, 1);
  const storm = dailyLogs({ w: 18, g: 26, p: 1000 }, 400, 2);
  assert.ok(sd(storm) > 1.5 * sd(calm), `Flaute ${sd(calm)}, Sturm ${sd(storm)}`);
  // keine Richtung: Mittel der Log-Renditen nahe 0 (gemessen in Standardfehlern)
  for (const a of [calm, storm]) assert.ok(Math.abs(mean(a)) < 3 * (sd(a) / Math.sqrt(a.length)), `Mittel ${mean(a)}`);
});
