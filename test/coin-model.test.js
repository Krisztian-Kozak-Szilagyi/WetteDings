process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { step, rollSurge, SURGE_UP_CHANCE, initialState, mulberry32, PARAMS } = require('../src/coin/model');

const DT_MIN = 1 / 1440; // 1 Minute in Tagen

function simulateDays(days, seed) {
  const rng = mulberry32(seed);
  let s = initialState(10);
  const dailyCloses = [10];
  const events = [];
  for (let d = 0; d < days; d++) {
    for (let m = 0; m < 1440; m++) {
      const next = step(s, DT_MIN, rng);
      events.push(...next.events);
      s = next;
      assert.ok(Number.isFinite(s.price) && s.price >= PARAMS.floor, 'Kurs muss endlich und >= Mindestkurs sein');
    }
    dailyCloses.push(s.price);
  }
  return { dailyCloses, events };
}

test('Kurs bleibt endlich und über dem Mindestkurs (1 Jahr, Minutentakt)', () => {
  simulateDays(365, 7);
});

test('Realistische Tagesvolatilität und fette Ränder', () => {
  const returns = [];
  for (const seed of [1, 2, 3, 4]) {
    const { dailyCloses } = simulateDays(180, seed);
    for (let i = 1; i < dailyCloses.length; i++) returns.push(Math.log(dailyCloses[i] / dailyCloses[i - 1]));
  }
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const kurtosis = returns.reduce((a, r) => a + (r - mean) ** 4, 0) / n / variance ** 2;
  const maxMove = Math.max(...returns.map(Math.abs));
  // bewusst wilder Spiel-Coin (ohne die großen Sprünge): typische Tagesschwankung zwischen 15 % und 60 %
  assert.ok(sd > 0.15 && sd < 0.6, `Tagesvolatilität ${sd}`);
  // fettere Ränder als die Normalverteilung (Kurtosis 3); die großen Sprünge kommen erst in der Engine dazu
  assert.ok(kurtosis > 3.2, `Kurtosis ${kurtosis}`);
  // es gibt große Tagesbewegungen (> 20 %)
  assert.ok(maxMove > Math.log(1.2), `größte Tagesbewegung ${maxMove}`);
});

test('Typischer Kurs bleibt gleich (kein Trend nach oben oder unten)', () => {
  // Median der Kursänderung über 30 Tage inkl. großer Sprünge, viele Pfade
  const rng = mulberry32(99);
  const logs = [];
  for (let p = 0; p < 600; p++) {
    let s = initialState(10);
    for (let w = 0; w < 60; w++) {
      const surge = rollSurge(rng);
      for (let i = 0; i < 36; i++) s = step(s, 1 / 72, rng); // 20-Minuten-Schritte
      if (surge) s = { ...s, price: s.price * Math.exp(surge.log) };
    }
    logs.push(Math.log(s.price / 10));
  }
  logs.sort((a, b) => a - b);
  const median = Math.exp(logs[300]);
  assert.ok(median > 0.6 && median < 1.6, `medianer Faktor nach 30 Tagen: ${median}`);
});

test('Großer Sprung: 50 % Chance pro Fenster, höchstens −70 % bzw. +100 %', () => {
  const rng = mulberry32(5);
  const n = 20000;
  let hits = 0;
  let ups = 0;
  let min = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const s = rollSurge(rng);
    if (!s) continue;
    hits++;
    if (s.change > 0) ups++;
    assert.equal(s.type, s.change > 0 ? 'pump' : 'crash');
    assert.ok(Math.abs(s.change) >= 0.16, `Sprung zu klein: ${s.change}`);
    min = Math.min(min, s.change);
    max = Math.max(max, s.change);
  }
  assert.ok(Math.abs(hits / n - 0.5) < 0.02, `Trefferquote ${hits / n}`);
  assert.ok(Math.abs(ups / hits - SURGE_UP_CHANCE) < 0.03, `Anteil nach oben ${ups / hits}`);
  assert.ok(min >= -0.7 - 1e-9 && min < -0.67, `größter Einbruch ${min}`);
  assert.ok(max <= 1 + 1e-9 && max > 0.9, `größter Anstieg ${max}`);
});

test('Mindestkauf: 10 % des Kurses, mindestens 1 €', () => {
  const { minBuyCents } = require('../src/coin/tradeService');
  assert.equal(minBuyCents(300), 3000);
  assert.equal(minBuyCents(5), 100);
  assert.equal(minBuyCents(12.345), 124); // aufgerundet
  assert.equal(minBuyCents(10000), 100000);
});
