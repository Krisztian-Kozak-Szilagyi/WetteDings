const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const { CATALOG, GOODS, POSTER, POSTER_TYPES, POSTER_SPOTS } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const more = { poster: POSTER, posterTypes: POSTER_TYPES, posterSpots: POSTER_SPOTS };
const apply = (s, a) => L.apply(s, cat, goods, a, more);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

test('Bar: Kunde gibt genug, Wechselgeld prüfen', () => {
  for (const total of [3.5, 18, 47.9, 120, 260]) {
    const given = C.cashGiven(total, Math.random);
    assert.ok(given.reduce((a, b) => a + b, 0) >= total, 'genug für ' + total);
  }
  assert.deepStrictEqual(C.changeResult(37.5, [50], [10, 2, 0.5]), { due: 12.5, gave: 12.5, short: 0, over: 0 });
  assert.deepStrictEqual(C.changeResult(37.5, [50], [10, 2]), { due: 12.5, gave: 12, short: 0.5, over: 0 });
  assert.deepStrictEqual(C.changeResult(37.5, [50], [20]), { due: 12.5, gave: 20, short: 0, over: 7.5 });
  assert.ok(['card', 'cash'].includes(C.payMethod(Math.random)));
});

test('Falschgeld nur bei Kunden mit Illegalem', () => {
  assert.strictEqual(C.fakeBill({ illegal: false }, [50], seq(0)), -1);
  assert.strictEqual(C.fakeBill({ illegal: true }, [50, 20], seq(0.05, 0.6)), 1);
  assert.strictEqual(C.fakeBill({ illegal: true }, [50], seq(0.5)), -1, '90 % ehrlich');
});

test('Feilschen: nur bei großen Einkäufen, Gegenangebot unter der Grenze klappt, sonst gehen oder voll zahlen', () => {
  assert.strictEqual(C.haggle(80, seq(0)), null, 'zu klein');
  assert.strictEqual(C.haggle(200, seq(0.9)), null, 'meist nicht');
  const h = C.haggle(200, seq(0.1, 0.5, 0.5));
  assert.ok(h.offer >= 150 && h.offer <= 180 && h.max >= h.offer && h.max <= 200);
  assert.deepStrictEqual(C.haggleAnswer(h, h.offer, 200, seq(0)), { deal: h.offer });
  assert.deepStrictEqual(C.haggleAnswer(h, 200, 200, seq(0.1)), { walk: true });
  assert.deepStrictEqual(C.haggleAnswer(h, null, 200, seq(0.9)), { full: true, deal: 200 });
});

test('Kasse bucht Nachlass, Bar/Karte und Verluste', () => {
  let s = L.fresh();
  s.items.push({ uid: 1, id: 'shelf_small', x: 0, y: 0, rot: 0, stock: { booster_box: 4 } });
  s = run(s, { type: 'openDay' });
  const coins = s.coins;
  s = run(s, { type: 'checkout', lines: [{ uid: 1, ware: 'booster_box', qty: 2 }], method: 'cash', deal: 170, lost: 20 });
  assert.strictEqual(s.coins, coins + 150, '170 abzüglich 20 Falschgeld');
  assert.deepStrictEqual([s.today.cash, s.today.lost], [170, 20]);
  s = run(s, { type: 'checkout', lines: [{ uid: 1, ware: 'booster_box', qty: 1 }], method: 'card', deal: 10 });
  assert.strictEqual(s.today.card, 70, 'höchstens 30 % Nachlass');
  s = run(s, { type: 'closeDay' });
  assert.deepStrictEqual([s.reports[0].cash, s.reports[0].card, s.reports[0].lost], [170, 70, 20]);
});

test('Plakate: drucken, an Orten aufhängen (bleiben), mehr Kunden, gezielte Wünsche', () => {
  let s = run(L.fresh(), { type: 'printPoster', id: 'brettspiel', n: 2 }, { type: 'printPoster', id: 'allgemein', secret: true });
  assert.strictEqual(s.coins, L.START_COINS - 3 * POSTER.price);
  assert.deepStrictEqual(s.posters, { brettspiel: 2, 'allgemein:geheim': 1 });
  s = run(s, { type: 'hangPoster', spot: 'uni', key: 'brettspiel' }, { type: 'hangPoster', spot: 'park', key: 'allgemein:geheim' });
  assert.match(apply(s, { type: 'hangPoster', spot: 'bahnhof', key: 'gamer' }).error, /kein Plakat/);
  const eff = L.posterEffect(s, more);
  assert.deepStrictEqual(eff, { customers: 4, boost: { board_game_box: 2 }, secret: 1 });
  assert.strictEqual(C.customersPerDay(3, eff.customers), C.customersPerDay(3) + 4);
  // Wunsch-Gewicht: mit Plakat wird das Brettspiel öfter gewünscht
  const ctx = { level: 5, licenses: ['brettspiele', 'sammler'], coins: 0, prices: {} };
  const count = (boost) => { let n = 0; const r = C.rngFrom(3); for (let i = 0; i < 2000; i++) if (C.newCustomer(r, GOODS, Object.assign({ boost }, ctx)).wish === 'board_game_box') n++; return n; };
  assert.ok(count(eff.boost) > count({}) * 1.8);
});

test('Safe nimmt Wertsachen auf', () => {
  assert.deepStrictEqual(cat.safe.holds, ['single_card', 'graded_slab', 'booster_box']);
  assert.ok(cat.safe.raidSafe && cat.safe.slots === 20);
});
