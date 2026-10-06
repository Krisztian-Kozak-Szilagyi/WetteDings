process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { step, rollSurge, upChanceOf, initialState, mulberry32, COW_PARAMS, ETF_PARAMS } = require('../src/coin/model');
const etf = require('../src/coin/etfTrend');
const markets = require('../src/coin/markets');

test('Broker: vier Werte, Symbole nur aus der festen Liste', () => {
  assert.deepEqual(markets.SYMBOLS, ['SAM', 'COW', 'BOJE', 'MIA', 'BTCG']);
  assert.equal(markets.get('COW').NAME, 'Coinye West');
  assert.equal(markets.get('BOJE').NAME, '51101 Coin');
  assert.equal(markets.get('BTCG').kind, 'etf');
  assert.equal(markets.get('constructor'), null);
  assert.equal(markets.get('cow'), null); // Groß-/Kleinschreibung regelt die Route
});

test('COW: großer Sprung mit 35 % Chance, +15 … +60 % bzw. −12 … −50 %', () => {
  const rng = mulberry32(11);
  const n = 20000;
  let hits = 0;
  let ups = 0;
  let min = 0;
  let max = 0;
  let minUp = Infinity;
  let minDown = Infinity;
  for (let i = 0; i < n; i++) {
    const s = rollSurge(rng, COW_PARAMS.surge);
    if (!s) continue;
    hits++;
    if (s.change > 0) {
      ups++;
      minUp = Math.min(minUp, s.change);
    } else minDown = Math.min(minDown, -s.change);
    min = Math.min(min, s.change);
    max = Math.max(max, s.change);
  }
  assert.ok(Math.abs(hits / n - 0.35) < 0.02, `Trefferquote ${hits / n}`);
  assert.ok(Math.abs(ups / hits - upChanceOf(COW_PARAMS.surge)) < 0.03, `Anteil nach oben ${ups / hits}`);
  assert.ok(minUp >= 0.15 - 1e-9 && minDown >= 0.12 - 1e-9, `kleinste Sprünge ${minUp} / ${minDown}`);
  assert.ok(min >= -0.5 - 1e-9 && min < -0.47, `größter Einbruch ${min}`);
  assert.ok(max <= 0.6 + 1e-9 && max > 0.56, `größter Anstieg ${max}`);
});

function etfDailyLogs(mu, days, seed) {
  const rng = mulberry32(seed);
  let s = { ...initialState(100, ETF_PARAMS), mu };
  const logs = [];
  for (let d = 0; d < days; d++) {
    const open = s.price;
    for (let i = 0; i < 288; i++) s = { ...step(s, 1 / 288, rng, ETF_PARAMS), mu }; // 5-Minuten-Schritte
    logs.push(Math.log(s.price / open));
  }
  return logs;
}

test('ETF: ohne Trend ~4–8 % Tagesbewegung, mit Trend klar in eine Richtung', () => {
  const flat = etfDailyLogs(0, 400, 3);
  const sd = Math.sqrt(flat.reduce((a, r) => a + r * r, 0) / flat.length);
  assert.ok(sd > 0.035 && sd < 0.09, `Tagesvolatilität ${sd}`);
  const bull = etfDailyLogs(0.09, 60, 4);
  const bear = etfDailyLogs(-0.09, 60, 5);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(bull) > 0.06, `bullisch ${mean(bull)}`);
  assert.ok(mean(bear) < -0.06, `bärisch ${mean(bear)}`);
});

test('ETF-Aktivität: nur echte Aktionen zählen', () => {
  assert.ok(etf.countsAsAction('POST', '/wetten/abc/setzen'));
  assert.ok(etf.countsAsAction('POST', '/tcg/oeffnen'));
  assert.ok(etf.countsAsAction('POST', '/broker/kaufen'));
  assert.ok(etf.countsAsAction('POST', '/handel/angebot'));
  assert.ok(!etf.countsAsAction('GET', '/wetten'));
  assert.ok(!etf.countsAsAction('POST', '/benachrichtigungen/alle-gelesen'));
  assert.ok(!etf.countsAsAction('POST', '/admin/tcg'));
  assert.ok(!etf.countsAsAction('POST', '/konto/passwort'));
  assert.ok(!etf.countsAsAction('POST', '/geraet'));
  assert.ok(!etf.countsAsAction('POST', '/dungeon/beute-gesehen'));
});

test('Profil-Depot: Bestand mit zwei Nachkommastellen, abgerundet', () => {
  const { unitsText, UNITS } = require('../src/coin/tradeService');
  assert.strictEqual(unitsText(0), '0,00');
  assert.strictEqual(unitsText(null), '0,00');
  assert.strictEqual(unitsText(12.349 * UNITS), '12,34');
  assert.strictEqual(unitsText(0.29 * UNITS), '0,29');
  assert.strictEqual(unitsText(1234.5 * UNITS), '1.234,50');
});
