const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const { CATALOG, GOODS, LICENSES, SERVICES, UNIT_PRICE } = require('../src/shop/catalog');

// Läden in diesen Tests sind schon auf der höchsten Ruf-Stufe (Freischaltungen: test/shop-ruf.test.js)
const hoch = () => Object.assign(L.fresh(), { level: 5, ruf: 2500 });
const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const more = { licenses: Object.fromEntries(LICENSES.map((l) => [l.id, l])), services: Object.fromEntries(SERVICES.map((x) => [x.id, x])) };
const apply = (s, a) => L.apply(s, cat, goods, a, more);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);

/** Möbel bestellen, Karton nehmen, aufbauen */
const build = (s, id, x, y, rot, wall) => {
  s = run(s, { type: 'orderMoebel', id });
  const b = s.boxes[s.boxes.length - 1];
  return run(s, { type: 'pick', bid: b.bid }, { type: 'build', x, y, rot, wall });
};

test('Katalog: Möbel und Ware aus den Platzhalter-Daten', () => {
  assert.ok(CATALOG.length >= 25);
  assert.strictEqual(cat.shelf_big.w, 3);
  assert.strictEqual(cat.shelf_big.slots, 18);
  assert.strictEqual(cat.drink_refrigerator.slots, 12);
  assert.strictEqual(cat.bulletin_board.layer, 'wand');
  assert.strictEqual(cat.booster_display.layer, 'theke');
  assert.strictEqual(goods.booster_pack.buy, goods.booster_pack.market / 2);
  assert.strictEqual(UNIT_PRICE, 5000);
});

test('Möbel kommen im Karton auf den Gehweg und werden aufgebaut', () => {
  let s = run(hoch(), { type: 'orderMoebel', id: 'shelf_big' });
  assert.strictEqual(s.coins, L.START_COINS - cat.shelf_big.price);
  assert.strictEqual(s.items.length, 0);
  assert.ok(s.boxes[0].y >= L.UNIT_D, 'auf dem Gehweg');
  assert.match(apply(s, { type: 'build', x: 0, y: 0 }).error, /kein Möbel/);
  s = run(s, { type: 'pick', bid: s.boxes[0].bid });
  assert.match(apply(s, { type: 'build', x: 6, y: 3, rot: 0 }).error, /Außerhalb/);
  s = run(s, { type: 'build', x: 0, y: 0, rot: 0 });
  assert.strictEqual(s.items.length, 1);
  assert.deepStrictEqual([s.boxes.length, s.carry], [0, null]);
  s = run(s, { type: 'remove', uid: s.items[0].uid });
  assert.strictEqual(s.coins, L.START_COINS);
});

test('Kollision, Eingang, Wand, Theke', () => {
  let s = build(hoch(), 'shelf_medium', 0, 0, 0);
  s = run(s, { type: 'orderMoebel', id: 'chair' }, { type: 'pick', bid: s.nextBid });
  assert.match(apply(s, { type: 'build', x: 1, y: 0 }).error, /schon/);
  assert.match(apply(s, { type: 'build', x: 3, y: 7 }).error, /Eingang/);
  s = build(hoch(), 'poster', 2, 5, 0, 'n');
  assert.strictEqual(s.items[0].y, 0);
  s = run(s, { type: 'orderMoebel', id: 'booster_display' }, { type: 'pick', bid: s.nextBid });
  assert.match(apply(s, { type: 'build', x: 5, y: 5 }).error, /Theke/);
});

test('Ware bestellen, tragen, gemischt einräumen, Platz begrenzt', () => {
  let s = build(hoch(), 'shelf_small', 0, 0, 0); // 6 Plätze
  assert.match(apply(s, { type: 'orderWare', id: 'board_game_box', n: 1 }).error, /Brettspiel-Lizenz/);
  s = run(s, { type: 'buyLicense', id: 'brettspiele' });
  assert.match(apply(s, { type: 'buyLicense', id: 'brettspiele' }).error, /schon/);
  const before = s.coins;
  s = run(s, { type: 'orderWare', id: 'board_game_box', n: 2 });
  assert.strictEqual(s.coins, before - 2 * goods.board_game_box.perBox * goods.board_game_box.buy);
  assert.strictEqual(s.boxes.length, 2);
  const shelf = s.items[0].uid;
  s = run(s, { type: 'pick', bid: s.boxes[0].bid }, { type: 'stock', uid: shelf });
  assert.deepStrictEqual(s.items[0].stock, { board_game_box: 4 });
  assert.strictEqual(s.carry, null, 'leerer Karton verschwindet');
  s = run(s, { type: 'orderWare', id: 'sleeve_pack', n: 1 });
  const sleeves = s.boxes[s.boxes.length - 1].bid;
  s = run(s, { type: 'pick', bid: sleeves }, { type: 'stock', uid: shelf });
  assert.deepStrictEqual(s.items[0].stock, { board_game_box: 4, sleeve_pack: 2 });
  assert.strictEqual(s.boxes.find((b) => b.bid === sleeves).qty, 8, 'Rest bleibt im Karton');
  assert.match(apply(s, { type: 'stock', uid: shelf }).error, /Kein Platz/);
  // Getränke passen nicht ins Regal
  s = run(s, { type: 'drop', x: 5.5, y: 5.5 }, { type: 'orderWare', id: 'coffee', n: 1 });
  s = run(s, { type: 'pick', bid: s.boxes[s.boxes.length - 1].bid });
  assert.match(apply(s, { type: 'stock', uid: shelf }).error, /passt hier nicht/);
  assert.match(apply(s, { type: 'remove', uid: shelf }).error, /Ware/);
});

test('Ware herausnehmen, Abstellen nur auf freiem Boden', () => {
  let s = build(hoch(), 'shelf_small', 0, 0, 0);
  s = run(s, { type: 'orderWare', id: 'toploader', n: 1 });
  s = run(s, { type: 'pick', bid: s.boxes[0].bid }, { type: 'stock', uid: 1 });
  assert.match(apply(s, { type: 'drop', x: 0.5, y: 0.5 }).error, /nicht stehen/);
  s = run(s, { type: 'drop', x: 4.2, y: 4.2 }, { type: 'unstock', uid: 1, ware: 'toploader' });
  assert.deepStrictEqual(s.items[0].stock, {});
  const b = s.boxes.find((x) => x.bid === s.carry);
  assert.strictEqual(b.qty, 6);
  assert.match(apply(s, { type: 'pick', bid: s.boxes[0].bid }).error, /schon einen/);
});

test('Preise, Nachbar-Einheit, Kanacoin, Zurücksetzen', () => {
  let s = run(hoch(), { type: 'setPrice', ware: 'booster_pack', price: 12.5 });
  assert.strictEqual(L.price(s, goods, 'booster_pack'), 12.5);
  assert.strictEqual(L.price(s, goods, 'coffee'), goods.coffee.market);
  assert.ok(apply(s, { type: 'setPrice', ware: 'booster_pack', price: -1 }).error);
  s = run(s, { type: 'buyUnit', price: UNIT_PRICE });
  assert.strictEqual(s.units, 2);
  assert.match(apply(run(s, { type: 'setCoins', amount: 100 }), { type: 'buyUnit', price: UNIT_PRICE }).error, /Kanacoin/);
  const r = run(s, { type: 'reset' });
  assert.deepStrictEqual(r.items.map((i) => i.id), ['cashier_counter'], 'neu = leer bis auf die Kasse');
  assert.strictEqual(r.coins, L.START_COINS);
  assert.match(apply(r, { type: 'remove', uid: r.items[0].uid }).error, /Kasse/);
  // Kasse wird auch neben vorhandenen Möbeln untergebracht
  const busy = build(hoch(), 'shelf_big', 1, 5, 0);
  assert.ok(L.ensureCounter(busy, cat).items.some((i) => i.id === 'cashier_counter'));
  assert.deepStrictEqual(L.normalize({ coins: 5, units: 1, nextUid: 1, items: [] }).boxes, [], 'alter Stand ohne Kartons');
});
