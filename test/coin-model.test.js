const test = require('node:test');
const assert = require('node:assert');
const { step, initialState, mulberry32, PARAMS } = require('../src/coin/model');

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
  // bewusst lebhafter Spiel-Coin: typische Tagesschwankung zwischen 8 % und 35 %
  assert.ok(sd > 0.08 && sd < 0.35, `Tagesvolatilität ${sd}`);
  // deutlich fettere Ränder als die Normalverteilung (Kurtosis 3)
  assert.ok(kurtosis > 5, `Kurtosis ${kurtosis}`);
  // es gibt große Tagesbewegungen (> 20 %)
  assert.ok(maxMove > Math.log(1.2), `größte Tagesbewegung ${maxMove}`);
});

test('Erwartungswert bleibt kontrolliert (kein sicherer Gewinn durch Halten)', () => {
  // Mittelwert der Kursänderung über 30 Tage, viele Pfade
  const rng = mulberry32(99);
  let sum = 0;
  const paths = 400;
  for (let p = 0; p < paths; p++) {
    let s = initialState(10);
    for (let i = 0; i < 30 * 288; i++) s = step(s, 1 / 288, rng); // 5-Minuten-Schritte
    sum += s.price / 10;
  }
  const avg = sum / paths;
  // erwartet ≈ 1,015 (+0,05 %/Tag); großzügige Toleranz wegen fetter Ränder
  assert.ok(avg > 0.75 && avg < 1.35, `durchschnittlicher Faktor nach 30 Tagen: ${avg}`);
});

test('Extremereignisse sind möglich', () => {
  // Mit stark erhöhter Rate prüfen, dass Pump und Crash tatsächlich eintreten können
  const rng = mulberry32(5);
  const types = new Set();
  let s = initialState(10);
  for (let i = 0; i < 2000; i++) {
    const next = step(s, 5, rng); // große Schritte -> Ereignisse häufig
    next.events.forEach((e) => types.add(e.type));
    s = next;
  }
  assert.ok(types.has('pump') && types.has('crash'), [...types].join(','));
});
