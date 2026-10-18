const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const { CATALOG, GOODS, DUNGEON_CARDS, BOARD } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const more = { dungeonCards: DUNGEON_CARDS };
const apply = (s, a) => L.apply(s, cat, goods, a, more);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);

test('Spielautomat: nicht kaufbar, nicht zurückzugeben, Dungeon-Karte einlegen und herausnehmen', () => {
  let s = L.fresh();
  assert.match(apply(s, { type: 'orderMoebel', id: 'arcade_machine' }).error, /nur finden/);
  s = run(s, { type: 'devFind', id: 'arcade' }, { type: 'pick', bid: 1 }, { type: 'build', x: 3, y: 3, rot: 0 });
  const uid = s.items.find((it) => it.id === 'arcade_machine').uid;
  const coins = s.coins;
  assert.match(apply(s, { type: 'remove', uid }).error, /kaufen/);
  assert.match(apply(s, { type: 'insertCard', uid, key: 'dungeon:dk2' }).error, /nicht/);
  s = run(s, { type: 'devFind', id: 'dk2' });
  assert.deepStrictEqual(s.bag['dungeon:dk2'], { n: 1, name: 'Dungeon-Karte II', tier: 2 });
  assert.strictEqual(L.invUsed(s), 1);
  s = run(s, { type: 'insertCard', uid, key: 'dungeon:dk2' });
  const m = s.items.find((it) => it.uid === uid);
  assert.deepStrictEqual([m.card, m.cardName, s.bag['dungeon:dk2']], ['dungeon:dk2', 'Dungeon-Karte II', undefined]);
  s = run(s, { type: 'ejectCard', uid });
  assert.strictEqual(s.bag['dungeon:dk2'].n, 1);
  assert.strictEqual(s.coins, coins);
});

test('Schwarzes Brett: ab Stufe 3, Aushänge nur mit Brett, kaufen und verkaufen', () => {
  assert.strictEqual(cat.bulletin_board.level, 3);
  assert.match(apply(L.fresh(), { type: 'orderMoebel', id: 'bulletin_board' }).error, /Stufe 3/);
  const cards = [{ id: 'a', name: 'Karte A', label: 'Holo', rank: 3, value: 125, weight: 250 }, { id: 'b', name: 'Karte B', label: 'Glitch', rank: 5, value: 6250, weight: 8 }];
  let s = L.fresh();
  assert.strictEqual(L.refreshBoard(s, cards, BOARD, C.rngFrom(1)).board.length, 0, 'ohne Brett nichts');
  s.items.push({ uid: 80, id: 'bulletin_board', x: 2, y: 0, rot: 0, wall: 'n' });
  s = L.refreshBoard(s, cards, BOARD, C.rngFrom(1));
  const offers = s.board.filter((b) => b.kind === 'biete');
  const wanted = s.board.filter((b) => b.kind === 'suche');
  assert.ok(offers.length >= 2 && offers.length <= 3 && wanted.length >= 2 && wanted.length <= 3);
  assert.ok(s.board.every((b) => b.until >= s.day + 3 && b.until <= s.day + 5 && BOARD.npcs.includes(b.npc) && b.price > 0));
  const again = L.refreshBoard(s, cards, BOARD, C.rngFrom(9)).board;
  assert.ok(s.board.every((b) => again.some((x) => x.pid === b.pid)), 'alte Aushänge bleiben');
  assert.ok(['biete', 'suche'].every((k) => again.filter((b) => b.kind === k).length <= 3), 'höchstens 3 je Art');
  // kaufen → Inventar, dann an ein passendes Gesuch verkaufen
  const o = offers[0];
  const coins = s.coins;
  s = run(s, { type: 'boardBuy', pid: o.pid });
  assert.strictEqual(s.coins, coins - o.price);
  assert.strictEqual(s.bag['card:' + o.card].n, 1);
  assert.ok(!s.board.some((b) => b.pid === o.pid));
  s.board.push({ pid: 999, kind: 'suche', card: o.card, name: o.name, label: o.label, price: 500, npc: 'Mia', until: s.day + 2 });
  assert.match(apply(s, { type: 'boardSell', pid: wanted.find((w) => w.card !== o.card) ? wanted.find((w) => w.card !== o.card).pid : -1 }).error, /nicht/);
  s = run(s, { type: 'boardSell', pid: 999 });
  assert.strictEqual(s.coins, coins - o.price + 500);
  assert.strictEqual(s.bag['card:' + o.card], undefined);
  assert.match(apply(s, { type: 'boardBuy', pid: 999 }).error, /nicht mehr/);
  // abgelaufene Aushänge verschwinden am nächsten Tag
  s.day += 10;
  assert.ok(L.refreshBoard(s, cards, BOARD, C.rngFrom(2)).board.every((b) => b.until >= s.day));
});
