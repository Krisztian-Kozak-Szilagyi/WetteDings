process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const league = require('../src/esports/league');
const d = require('../src/dungeon/dungeonService');
const model = require('../src/coin/model');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('eSports: Punkte = Summe der zwei besten Läufe', () => {
  assert.deepEqual(league.scoreOf([3, 7, 5, 1]), { score: 12, best: [7, 5] });
  assert.deepEqual(league.scoreOf([4]), { score: 4, best: [4] });
  assert.deepEqual(league.scoreOf([]), { score: 0, best: [] });
});

test('eSports: Platz 1 +25 %, letzter −20 %, Mitte ±0', () => {
  const rows = league.rankWeek([
    { id: 'a', rounds: [10, 9], prevRank: null },
    { id: 'b', rounds: [5, 5], prevRank: null },
    { id: 'c', rounds: [1], prevRank: null },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.rank, r.of]), [['a', 1, 3], ['b', 2, 3], ['c', 3, 3]]);
  close(rows[0].change, 0.25);
  close(rows[1].change, 0);
  close(rows[2].change, -0.2);
});

test('eSports: Platz gehalten oder verbessert → +4,5 % dazu', () => {
  const rows = league.rankWeek([
    { id: 'a', rounds: [10], prevRank: 1 },
    { id: 'b', rounds: [5], prevRank: 3 },
    { id: 'c', rounds: [1], prevRank: 2 },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.held, true);
  close(by.a.change, 1.25 * 1.045 - 1);
  assert.equal(by.b.held, true); // von 3 auf 2
  close(by.b.change, 0.045);
  assert.equal(by.c.held, false); // von 2 auf 3
  close(by.c.change, -0.2);
});

test('eSports: Gleichstand teilt Platz und Sprung, ohne Punkte kein Bonus', () => {
  const rows = league.rankWeek([
    { id: 'a', rounds: [6], prevRank: null },
    { id: 'b', rounds: [6], prevRank: null },
    { id: 'c', rounds: [], prevRank: 3 },
  ]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 3]);
  close(rows[0].log, rows[1].log);
  close(rows[0].log, (Math.log(1.25) + 0) / 2);
  assert.equal(rows[2].held, false); // 0 Punkte: hält keinen Platz, auch wenn er gleich bleibt
  close(rows[2].change, -0.2);
});

test('eSports: ein einzelnes Team springt nicht von selbst', () => {
  const [row] = league.rankWeek([{ id: 'a', rounds: [3], prevRank: null }]);
  assert.equal(row.change, 0);
  const [again] = league.rankWeek([{ id: 'a', rounds: [3], prevRank: 1 }]);
  close(again.change, 0.045);
});

test('eSports: Kurswirkung minimal, gedeckelt, Hin und Her ohne Gewinn', () => {
  close(league.impactLog(10000, 'kauf'), 0.0005); // 100 € → 0,05 %
  close(league.impactLog(10000, 'verkauf'), -0.0005);
  assert.equal(league.impactLog(1e12, 'kauf'), 0.02);
  // Kaufen zum angehobenen, verkaufen zum gesenkten Kurs: man bekommt weniger zurück, als man bezahlt hat
  const price = 50;
  const cents = 100000;
  const buyPrice = price * Math.exp(league.impactLog(cents, 'kauf'));
  const units = cents / 100 / buyPrice;
  const sellPrice = buyPrice * Math.exp(league.impactLog(units * buyPrice * 100, 'verkauf'));
  assert.ok(units * sellPrice * 100 < cents);
});

test('eSports: Austrittsgebühr ohne Cent-Verlust verteilt', () => {
  assert.deepEqual(league.splitFee(25000, 2), [12500, 12500]);
  assert.deepEqual(league.splitFee(25000, 3), [8334, 8333, 8333]);
  assert.deepEqual(league.splitFee(25000, 0), []);
});

test('eSports: Name und Kürzel werden geprüft', () => {
  assert.equal(league.cleanName('  Die   Drei  '), 'Die Drei');
  assert.equal(league.cleanName('Ömer & Co.'), 'Ömer & Co.');
  assert.equal(league.cleanName('ab'), null);
  assert.equal(league.cleanName('<script>'), null);
  assert.equal(league.cleanTicker('drei'), 'DREI');
  assert.equal(league.cleanTicker('AB'), null);
  assert.equal(league.cleanTicker('A1C'), null);
});

test('eSports: Bericht nennt Platz und Kursbewegung', () => {
  const [row] = league.rankWeek([{ id: 'a', rounds: [7, 4], prevRank: null }, { id: 'b', rounds: [1], prevRank: null }]);
  const t = league.reportText({ ticker: 'DREI', name: 'Die Drei' }, row, '11.10.2026');
  assert.match(t.title, /Platz 1 von 2/);
  assert.match(t.body, /11 Punkte/);
  assert.match(t.body, /DREI.*\+25 %/);
});

test('eSports: Solo-Warteschlange bringt Teammitglieder zusammen', () => {
  const teamOf = (e) => (e.startsWith('a') ? 'A' : e.startsWith('b') ? 'B' : null);
  for (let seed = 1; seed <= 20; seed++) {
    const groups = d.makeTeams(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'x1', 'x2', 'x3'], model.mulberry32(seed), teamOf);
    assert.deepEqual(groups.flat().sort(), ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'x1', 'x2', 'x3']);
    assert.ok(groups.some((g) => g.filter((e) => e.startsWith('a')).length === 3), 'drei aus Team A zusammen');
    assert.ok(groups.some((g) => g.filter((e) => e.startsWith('b')).length === 2), 'Team B bleibt zusammen');
    assert.ok(groups.every((g) => g.length <= 3));
  }
});

test('eSports: Team-Kursmodell rauscht nur leicht (Tagesschwankung um 1–2 %)', () => {
  const rng = model.mulberry32(7);
  let state = model.initialState(50, model.TEAM_PARAMS);
  const daily = [];
  for (let day = 0; day < 200; day++) {
    const start = state.price;
    for (let i = 0; i < 288; i++) state = { ...state, ...model.step(state, 1 / 288, rng, model.TEAM_PARAMS) };
    daily.push(Math.abs(Math.log(state.price / start)));
  }
  const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
  assert.ok(mean > 0.005 && mean < 0.025, `mittlere Tagesbewegung ${mean}`);
});
