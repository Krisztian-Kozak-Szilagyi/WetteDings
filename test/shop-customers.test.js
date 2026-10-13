const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const { CATALOG, GOODS } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = L.apply(s, cat, goods, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);
const fixed = (v) => () => v;

test('Preis-Urteil: bis +15 % 5★, bis +35 % 4★/3★, darüber nicht', () => {
  assert.deepStrictEqual(C.judge(10, 10), { buy: true, stars: 5 });
  assert.deepStrictEqual(C.judge(11.5, 10), { buy: true, stars: 5 });
  assert.deepStrictEqual(C.judge(12, 10), { buy: true, stars: 4 });
  assert.deepStrictEqual(C.judge(13.4, 10), { buy: true, stars: 3 });
  assert.strictEqual(C.judge(13.6, 10).buy, false);
  assert.strictEqual(C.judge(13.6, 10, 0.05).buy, true, 'toleranter Kunde');
  assert.strictEqual(C.judge(5, 10).stars, 5, 'billig ist immer gut');
});

test('Sterne → Kunden pro Tag, neuer Laden 3★, nur die letzten 30 zählen', () => {
  assert.strictEqual(C.rating([]), 3);
  assert.strictEqual(C.customersPerDay(1), C.MIN_CUSTOMERS);
  assert.strictEqual(C.customersPerDay(5), C.MAX_CUSTOMERS);
  assert.ok(C.customersPerDay(4) > C.customersPerDay(3));
  const old = Array(50).fill({ stars: 1 });
  const fresh = Array(30).fill({ stars: 5 });
  assert.strictEqual(C.rating(old.concat(fresh)), 5);
  assert.strictEqual(C.clock(0), '7:45');
  assert.strictEqual(C.clock(1), '16:45');
});

test('Einkauf: Wunsch, zu teuer, Wunsch fehlt', () => {
  const offers = [{ uid: 1, ware: 'booster_pack', qty: 10, price: 10 }, { uid: 2, ware: 'coffee', qty: 3, price: 30 }];
  const r1 = C.shop({ tol: 0, wish: 'booster_pack' }, offers, goods, fixed(0.99));
  assert.deepStrictEqual(r1.basket.map((b) => b.ware), ['booster_pack']);
  assert.strictEqual(r1.stars, 5);
  const r2 = C.shop({ tol: 0, wish: 'coffee' }, offers, goods, fixed(0.99));
  assert.deepStrictEqual(r2.basket, []);
  assert.deepStrictEqual(r2.tooExpensive, ['coffee']);
  const r3 = C.shop({ tol: 0, wish: 'graded_slab' }, offers, goods, fixed(0.99));
  assert.strictEqual(r3.missWish, true);
  // Wünsche nur aus dem Pool der eigenen Stufe
  assert.ok(C.wishPool([{ id: 'a', tier: 1 }, { id: 'b', tier: 3 }], 1).every((g) => g.id === 'a'));
});

test('Bewertungen beim Gehen', () => {
  assert.deepStrictEqual(C.review({ basket: [{}], stars: 4 }, 50, fixed(0.1)), { stars: 4, why: '4' });
  assert.deepStrictEqual(C.review({ basket: [] }, 2, fixed(0.99)), { stars: 1, why: 'empty' });
  assert.strictEqual(C.review({ basket: [] }, 50, fixed(0.99)), null, 'meist keine Bewertung');
  assert.deepStrictEqual(C.review({ basket: [] }, 50, fixed(0.01)), { stars: 2, why: 'nothing' });
  assert.ok(L.REVIEW_TEXTS[C.angryReview().why]);
});

test('Wege: nur durch die Tür, um Möbel herum, Platz neben dem Regal', () => {
  let s = L.fresh();
  s.items.push({ uid: 1, id: 'shelf_big', x: 2, y: 3, rot: 0 });
  const p = C.path(s, cat, { x: 4, y: 9 }, new Set(['3,2']));
  assert.ok(p && p.length, 'Weg gefunden');
  const fromStreet = p.findIndex((c) => c.y < L.UNIT_D);
  assert.ok(L.DOOR.some((d) => d.x === p[fromStreet].x), 'betritt den Laden durch die Tür');
  assert.ok(!p.some((c) => c.y === 3 && c.x >= 2 && c.x <= 4), 'nicht durchs Regal');
  const near = C.approach(s, cat, s.items[0]);
  assert.ok(near.has('2,2') && near.has('3,4') && !near.has('3,3'));
  // Gehweg links neben der Tür → nicht durch die Wand
  const q = C.path(s, cat, { x: 0, y: 8 }, new Set(['0,7']));
  assert.ok(q.some((c) => L.DOOR.some((d) => d.x === c.x && d.y === c.y)));
});

test('Ein Tag: öffnen, kassieren, gehen, schließen → Bericht', () => {
  let s = L.fresh();
  s.items.push({ uid: 1, id: 'shelf_small', x: 0, y: 0, rot: 0, stock: { board_game_box: 4 } });
  s = run(s, { type: 'setPrice', ware: 'board_game_box', price: 60 }, { type: 'openDay' });
  const coins = s.coins;
  s = run(s,
    { type: 'checkout', lines: [{ uid: 1, ware: 'board_game_box', qty: 3 }], stars: 4, why: '4' },
    { type: 'leave', stars: 2, why: 'nothing', miss: 'coffee' },
    { type: 'leave' });
  assert.strictEqual(s.coins, coins + 180);
  assert.deepStrictEqual(s.items[0].stock, { board_game_box: 1 });
  assert.strictEqual(s.reviews.length, 2);
  assert.ok(L.apply(s, cat, goods, { type: 'leave', stars: 5, why: 'erfunden' }).state.reviews.length === 2, 'nur bekannte Texte');
  s = run(s, { type: 'closeDay' });
  const rep = s.reports[0];
  assert.deepStrictEqual([rep.day, rep.revenue, rep.visitors, rep.buyers, rep.stars], [1, 180, 3, 1, 3]);
  assert.deepStrictEqual(rep.misses, { coffee: 1 });
  assert.deepStrictEqual([s.day, s.open], [2, false]);
  assert.ok(L.apply(s, cat, goods, { type: 'checkout', lines: [] }).error, 'zu = keine Kunden');
  // Mehr verlangt als da ist → nur das Vorhandene
  s = run(s, { type: 'openDay' }, { type: 'checkout', lines: [{ uid: 1, ware: 'board_game_box', qty: 9 }] });
  assert.strictEqual(s.today.revenue, 60);
});
