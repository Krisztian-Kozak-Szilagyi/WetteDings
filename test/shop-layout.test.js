const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const { CATALOG, UNIT_PRICE } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = L.apply(s, cat, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);

test('Katalog: alle Möbel aus den Platzhalter-Daten, mit Preis und Größe', () => {
  assert.ok(CATALOG.length >= 25);
  assert.strictEqual(cat.shelf_big.w, 3);
  assert.strictEqual(cat.bulletin_board.layer, 'wand');
  assert.strictEqual(cat.booster_display.layer, 'theke');
  assert.strictEqual(cat.rug.layer, 'flach');
  assert.strictEqual(UNIT_PRICE, 5000);
});

test('Leerer Laden, Kaufen kostet, Entfernen gibt den Preis zurück', () => {
  const s0 = L.fresh();
  assert.deepStrictEqual(s0.items, []);
  const s1 = run(s0, { type: 'place', id: 'shelf_big', x: 0, y: 0, rot: 0 });
  assert.strictEqual(s1.coins, L.START_COINS - cat.shelf_big.price);
  const s2 = run(s1, { type: 'remove', uid: s1.items[0].uid });
  assert.strictEqual(s2.coins, L.START_COINS);
  assert.strictEqual(s0.items.length, 0, 'Original bleibt unverändert');
});

test('Kollision, Rand, Eingang, Drehen', () => {
  const s = run(L.fresh(), { type: 'place', id: 'shelf_medium', x: 0, y: 0, rot: 0 });
  assert.match(L.apply(s, cat, { type: 'place', id: 'chair', x: 1, y: 0 }).error, /schon/);
  assert.match(L.apply(s, cat, { type: 'place', id: 'shelf_big', x: 6, y: 3 }).error, /Außerhalb/);
  assert.ok(!L.apply(s, cat, { type: 'place', id: 'shelf_big', x: 7, y: 3, rot: 1 }).error, 'gedreht passt es');
  assert.match(L.apply(s, cat, { type: 'place', id: 'chair', x: 3, y: 7 }).error, /Eingang/);
  // Teppich darf unter Möbeln liegen
  assert.ok(!L.apply(s, cat, { type: 'place', id: 'rug', x: 0, y: 0 }).error);
});

test('Wand, Theke, Verschieben samt Auslage', () => {
  let s = run(L.fresh(), { type: 'place', id: 'poster', x: 2, y: 5, wall: 'n' });
  assert.strictEqual(s.items[0].y, 0);
  assert.match(L.apply(s, cat, { type: 'place', id: 'neon_sign', x: 2, wall: 'n' }).error, /hängt/);
  assert.ok(!L.apply(s, cat, { type: 'place', id: 'neon_sign', y: 2, x: 0, wall: 'w' }).error);
  assert.match(L.apply(s, cat, { type: 'place', id: 'booster_display', x: 5, y: 5 }).error, /Theke/);
  s = run(s, { type: 'place', id: 'cashier_counter', x: 4, y: 4, rot: 0 }, { type: 'place', id: 'booster_display', x: 5, y: 4 });
  const counter = s.items.find((i) => i.id === 'cashier_counter');
  s = run(s, { type: 'move', uid: counter.uid, x: 1, y: 2, rot: 0 });
  assert.deepStrictEqual(s.items.find((i) => i.id === 'booster_display').x, 2);
  assert.match(L.apply(s, cat, { type: 'move', uid: counter.uid, x: 1, y: 2, rot: 1 }).error, /Theke/);
  const before = s.coins;
  s = run(s, { type: 'remove', uid: counter.uid });
  assert.strictEqual(s.coins, before + cat.cashier_counter.price + cat.booster_display.price);
  assert.strictEqual(s.items.length, 1);
});

test('Nachbar-Einheit kaufen, Kanacoin setzen, Zurücksetzen', () => {
  let s = L.fresh();
  assert.match(L.apply(s, cat, { type: 'place', id: 'chair', x: 9, y: 1 }).error, /Außerhalb/);
  s = run(s, { type: 'buyUnit', price: UNIT_PRICE });
  assert.strictEqual(s.units, 2);
  assert.ok(!L.apply(s, cat, { type: 'place', id: 'chair', x: 9, y: 1 }).error);
  assert.match(L.apply(run(s, { type: 'setCoins', amount: 100 }), cat, { type: 'buyUnit', price: UNIT_PRICE }).error, /Kanacoin/);
  s = run(s, { type: 'setCoins', amount: 99999 }, { type: 'buyUnit', price: UNIT_PRICE });
  assert.match(L.apply(s, cat, { type: 'buyUnit', price: UNIT_PRICE }).error, /Mehr Platz/);
  assert.ok(L.apply(s, cat, { type: 'setCoins', amount: -1 }).error);
  assert.deepStrictEqual(run(s, { type: 'reset' }), L.fresh());
});
