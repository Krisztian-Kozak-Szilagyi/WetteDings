const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const { CATALOG, GOODS } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const apply = (s, a) => L.apply(s, cat, goods, a);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);

test('Flecken: entstehen, nur mit Wischmopp wegwischen, Mopp kostet', () => {
  let s = run(L.fresh(), { type: 'dirt', x: 3.4, y: 2.2, at: 1000 }, { type: 'dirt', x: 1, y: 1, at: 2000 });
  assert.strictEqual(s.dirt.length, 2);
  assert.ok(apply(s, { type: 'dirt', x: 3, y: 9 }).error, 'nicht auf dem Gehweg');
  assert.match(apply(s, { type: 'mop', did: s.dirt[0].did }).error, /Wischmopp/);
  const coins = s.coins;
  s = run(s, { type: 'buyTool', id: 'mop' });
  assert.strictEqual(s.coins, coins - L.TOOLS.find((t) => t.id === 'mop').price);
  assert.match(apply(s, { type: 'buyTool', id: 'mop' }).error, /schon/);
  s = run(s, { type: 'mop', did: s.dirt[0].did });
  assert.deepStrictEqual(s.dirt.map((d) => d.x), [1]);
});

test('Schmutz-Bewertung: ab 3 Flecken höchstens 3★, frische Flecken (< 30 s) zählen nicht', () => {
  const now = 100000;
  const old = [{ at: 0 }, { at: 0 }, { at: 0 }];
  assert.deepStrictEqual(C.dirtCap({ stars: 5, why: '5' }, old, now), { stars: 3, why: 'dirty' });
  assert.deepStrictEqual(C.dirtCap({ stars: 5, why: '5' }, old.slice(0, 2), now), { stars: 5, why: '5' }, '2 Flecken: nichts');
  assert.deepStrictEqual(C.dirtCap({ stars: 5, why: '5' }, [{ at: 0 }, { at: 0 }, { at: now - 5000 }], now), { stars: 5, why: '5' }, 'der dritte ist frisch');
  assert.deepStrictEqual(C.dirtCap({ stars: 2, why: 'waited' }, old, now), { stars: 2, why: 'waited' }, 'schlechter bleibt schlechter');
  assert.strictEqual(C.dirtCap(null, old, now), null);
  assert.ok(L.REVIEW_TEXTS.dirty);
});

test('Booster-Display auf der Theke: drehbar, Kunden nur von seiner Vorderseite', () => {
  const s = L.fresh();
  s.items.push({ uid: 1, id: 'cashier_counter', x: 2, y: 2, rot: 0 }, { uid: 2, id: 'booster_display', x: 2, y: 2, rot: 0 });
  assert.deepStrictEqual(Array.from(C.approach(s, cat, s.items[1])), ['2,3']);
  s.items[1].rot = 1; // zeigt in die Theke (Zelle 3,2 gehört zur Theke)
  assert.deepStrictEqual(Array.from(C.approach(s, cat, s.items[1])), [], 'kommt man nicht heran');
  const r = apply(s, { type: 'move', uid: 2, x: 2, y: 2, rot: 2 });
  assert.ok(!r.error && r.state.items[1].rot === 2, 'drehen geht');
});
