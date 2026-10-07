process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { glideStep, glideFrom } = require('../src/coin/glide');
const markets = require('../src/coin/markets');

const H = 60 * 60 * 1000;

test('Gleitflug: endet genau auf dem Ziel, gleichmäßig im Log-Maß', () => {
  const glide = { target: 6.5, endAt: 8 * H };
  let price = 33.3;
  let prev = 0;
  const half = [];
  for (let t = 60 * 1000; t <= 8 * H; t += 60 * 1000) {
    const r = glideStep(price, glide, prev, t);
    price = r.price;
    prev = t;
    if (t === 4 * H) half.push(price);
    if (r.done) assert.strictEqual(t, 8 * H);
  }
  assert.strictEqual(price, 6.5);
  // nach der Hälfte der Zeit: geometrische Mitte von 33,30 und 6,50
  assert.ok(Math.abs(half[0] - Math.sqrt(33.3 * 6.5)) < 1e-9);
});

test('Gleitflug: Rauschen zwischendurch wird mit ausgeglichen, Neustart (Lücke) setzt fort', () => {
  const glide = { target: 6.5, endAt: 8 * H };
  let r = glideStep(30, glide, 0, 2 * H);
  const after = r.price * 1.2; // Zufallsschwankung
  r = glideStep(after, glide, 2 * H, 5 * H); // Server war 3 Stunden aus
  assert.ok(r.price < after && r.price > 6.5);
  assert.deepStrictEqual(glideStep(r.price, glide, 5 * H, 9 * H), { price: 6.5, done: true });
});

test('glideFrom: nur gültige Daten', () => {
  assert.strictEqual(glideFrom(null), null);
  assert.strictEqual(glideFrom({ target: 0, endAt: 5 }), null);
  assert.deepStrictEqual(glideFrom({ key: 'k', target: 6.5, endAt: 5 }), { key: 'k', target: 6.5, endAt: 5 });
});

test('Einmalige Aktionen: kein +75-%-Sprung mehr, jede hat eine Frist', () => {
  for (const a of markets.ONE_TIME_ACTIONS) {
    assert.ok(Number.isFinite(a.until), a.key);
    assert.ok(!('change' in a), `${a.key}: keine Sprünge mehr`);
  }
  assert.ok(!markets.ONE_TIME_ACTIONS.some((a) => a.key === 'mia-median-2026-10-07'));
});
