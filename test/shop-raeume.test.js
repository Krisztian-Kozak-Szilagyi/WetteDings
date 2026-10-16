const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const { CATALOG, GOODS } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const apply = (s, a) => L.apply(s, cat, goods, a);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);
const build = (s, id, x, y, rot) => {
  s = run(s, { type: 'orderMoebel', id });
  return run(s, { type: 'pick', bid: s.boxes[s.boxes.length - 1].bid }, { type: 'build', x, y, rot });
};

test('Lager: Wände kosten je Kante, Tür, nur Lagerregale, Wand blockiert', () => {
  let s = L.fresh();
  // 3×3 in der Ecke hinten links: zwei Seiten sind Außenwand (6 Kanten), 6 neue Wände + Tür
  const r = { x: 0, y: 0, w: 3, d: 3, kind: 'lager' };
  assert.strictEqual(L.roomCost(s, r), 6 * 20 + 50);
  assert.match(apply(s, { type: 'buildRoom', kind: 'lager', x: 0, y: 0, w: 3, d: 3, door: { side: 'n', i: 1 } }).error, /Außenwand/);
  const coins = s.coins;
  s = run(s, { type: 'buildRoom', kind: 'lager', x: 0, y: 0, w: 3, d: 3, door: { side: 's', i: 1 } });
  assert.strictEqual(s.coins, coins - 170);
  const walls = L.wallSet(s);
  assert.ok(L.wallBetween(walls, 0, 2, 0, 3), 'Südwand');
  assert.ok(!L.wallBetween(walls, 1, 2, 1, 3), 'Tür offen');
  assert.ok(L.wallBetween(walls, 2, 1, 3, 1), 'Ostwand');
  // nur Lagerregale drinnen, Lagerregale nur drinnen
  s = run(s, { type: 'orderMoebel', id: 'shelf_small' }, { type: 'pick', bid: 1 }); // Karton 1 = Regal
  assert.match(apply(s, { type: 'build', x: 0, y: 0 }).error, /nur Lagerregale/);
  s = run(s, { type: 'drop', x: 5.5, y: 5.5 });
  s = run(s, { type: 'orderMoebel', id: 'lager_regal_klein' }, { type: 'pick', bid: 2 }); // Karton 2 = Lagerregal
  assert.match(apply(s, { type: 'build', x: 5, y: 1 }).error, /ins Lager/);
  assert.match(apply(s, { type: 'build', x: 2, y: 1 }).error, /Wand/, 'halb drinnen, halb draußen');
  s = run(s, { type: 'build', x: 0, y: 0 });
  assert.strictEqual(s.items[s.items.length - 1].id, 'lager_regal_klein');
  assert.match(apply(s, { type: 'removeRoom', rid: s.rooms[0].rid }).error, /leer/);
  // Material und Ware passen ins Lagerregal
  assert.ok(cat.lager_regal_klein.holds.includes('mat_slab') && cat.lager_regal_klein.slots === 40);
});

test('Raum-Regeln: Mindestgröße, kein Überlappen, Platz muss leer sein, Eingang frei', () => {
  let s = build(L.fresh(), 'plant', 5, 5, 0);
  assert.match(apply(s, { type: 'buildRoom', kind: 'lager', x: 0, y: 0, w: 1, d: 3, door: { side: 'e', i: 0 } }).error, /mindestens/);
  assert.match(apply(s, { type: 'buildRoom', kind: 'lager', x: 4, y: 4, w: 2, d: 2, door: { side: 'n', i: 0 } }).error, /leer/);
  assert.match(apply(s, { type: 'buildRoom', kind: 'lager', x: 3, y: 6, w: 2, d: 2, door: { side: 'n', i: 0 } }).error, /Eingang/);
  s = run(s, { type: 'buildRoom', kind: 'lager', x: 0, y: 0, w: 2, d: 2, door: { side: 'e', i: 0 } });
  assert.match(apply(s, { type: 'buildRoom', kind: 'geheim', x: 1, y: 1, w: 2, d: 2, door: { side: 's', i: 0 } }).error, /schon ein Raum/);
});

test('Geheimraum: Schrank vor der Tür, E schiebt ihn, darin lagern, nicht frei bewegbar', () => {
  let s = L.fresh();
  s = run(s, { type: 'buildRoom', kind: 'geheim', x: 5, y: 0, w: 3, d: 3, door: { side: 's', i: 1 } });
  const cab = s.items.find((it) => it.id === 'geheimschrank');
  assert.deepStrictEqual([cab.x, cab.y, cab.rot], [6, 3, 0], 'vor der Tür, Front nach außen');
  assert.strictEqual(s.coins, L.START_COINS - (L.roomCost(s, s.rooms[0])));
  assert.ok(L.blocked(s, cat).has('6,3'), 'Schrank versperrt den Eingang');
  s = run(s, { type: 'slideCabinet', uid: cab.uid });
  const moved = s.items.find((it) => it.uid === cab.uid);
  assert.ok(moved.x !== 6 && moved.y === 3, 'zur Seite geschoben');
  assert.ok(!L.blocked(s, cat).has('6,3'), 'Eingang frei');
  s = run(s, { type: 'slideCabinet', uid: cab.uid });
  assert.deepStrictEqual([s.items.find((it) => it.uid === cab.uid).x], [6], 'wieder davor');
  assert.match(apply(s, { type: 'move', uid: cab.uid, x: 1, y: 1, rot: 0 }).error, /Geheimraum/);
  assert.match(apply(s, { type: 'remove', uid: cab.uid }).error, /Geheimraum/);
  // im Schrank lagern
  s = run(s, { type: 'orderWare', id: 'booster_pack', n: 1 });
  s = run(s, { type: 'pick', bid: s.boxes[0].bid }, { type: 'stock', uid: cab.uid });
  assert.strictEqual(L.used(s.items.find((it) => it.uid === cab.uid)), 20);
  assert.match(apply(s, { type: 'removeRoom', rid: s.rooms[0].rid }).error, /Schrank/);
  // Kunden-Zellen: der Raum gehört nicht dazu
  assert.ok(L.roomCells(s).has('6,1') && !L.roomCells(s).has('6,3'));
});
