const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
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

test('Inventar: Plakate belegen Plätze, voll = kein Druck mehr', () => {
  let s = L.fresh();
  s.coins = 100000;
  s = run(s, { type: 'printPoster', id: 'sammler', n: 10 }, { type: 'printPoster', id: 'gamer', n: 10 });
  assert.strictEqual(L.invUsed(s), L.INVENTORY.slots);
  assert.match(apply(s, { type: 'printPoster', id: 'allgemein', n: 1 }).error, /Inventar voll/);
});

test('Safe lagert Plakate (zählen als Plätze), zurück ins Inventar', () => {
  let s = L.fresh();
  s.items.push({ uid: 50, id: 'safe', x: 0, y: 0, rot: 0, stock: { booster_box: 15 } });
  s = run(s, { type: 'printPoster', id: 'brettspiel', n: 8 });
  assert.match(apply(s, { type: 'storePoster', uid: 50, key: 'brettspiel', n: 8 }).error, /Kein Platz/);
  s = run(s, { type: 'storePoster', uid: 50, key: 'brettspiel', n: 5 });
  assert.deepStrictEqual([s.items.find((i) => i.uid === 50).posters, s.posters], [{ brettspiel: 5 }, { brettspiel: 3 }]);
  assert.strictEqual(L.used(s.items.find((i) => i.uid === 50)), 20);
  assert.match(apply(s, { type: 'remove', uid: 50 }).error, /herausnehmen/);
  s = run(s, { type: 'takePoster', uid: 50, key: 'brettspiel', n: 5 });
  assert.strictEqual(s.items.find((i) => i.uid === 50).posters, undefined);
  assert.strictEqual(s.posters.brettspiel, 8);
  s.items.push({ uid: 51, id: 'shelf_small', x: 4, y: 0, rot: 0 });
  assert.match(apply(s, { type: 'storePoster', uid: 51, key: 'brettspiel', n: 1 }).error, /keine Plakate/);
  assert.match(apply(s, { type: 'storePoster', uid: 50, key: '$bad', n: 1 }).error, /Unbekannt/);
});

test('Spieltisch: bereit erst mit 2 Stühlen direkt daneben', () => {
  const s = L.fresh();
  s.items.push({ uid: 60, id: 'playmat_table', x: 2, y: 2, rot: 0 }, { uid: 61, id: 'chair', x: 1, y: 2, rot: 0 }, { uid: 62, id: 'chair', x: 6, y: 6, rot: 0 });
  assert.deepStrictEqual(L.gameTables(s, cat), [{ uid: 60, chairs: 1, ready: false }]);
  s.items.push({ uid: 63, id: 'chair', x: 4, y: 3, rot: 0 });
  assert.deepStrictEqual(L.gameTables(s, cat), [{ uid: 60, chairs: 2, ready: true }]);
});
