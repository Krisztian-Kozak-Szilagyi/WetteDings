const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const T = require('../src/shop/turnier');
const { CATALOG, GOODS } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const more = { turnier: T.TURNIER };
const apply = (s, a) => L.apply(s, cat, goods, a, more);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);
const shopWithTable = (level) => {
  const s = L.fresh();
  s.level = level;
  s.ruf = 99999;
  s.items.push({ uid: 60, id: 'playmat_table', x: 2, y: 2, rot: 0 }, { uid: 61, id: 'chair', x: 1, y: 2, rot: 0 }, { uid: 63, id: 'chair', x: 4, y: 3, rot: 0 });
  return s;
};

test('Anziehung: Preisgeld lockt, Startgeld schreckt ab; Müdigkeit bei zu vielen Turnieren', () => {
  const ctx = (o) => Object.assign({ level: 4, prize: 100, fee: 10, board: false, daysSinceLast: null }, o);
  assert.ok(T.signups(ctx({ prize: 300 })).expected > T.signups(ctx()).expected);
  assert.ok(T.signups(ctx({ fee: 50 })).expected < T.signups(ctx()).expected);
  assert.ok(T.signups(ctx({ board: true })).expected > T.signups(ctx()).expected);
  assert.ok(T.signups(ctx({ daysSinceLast: 2 })).expected < T.signups(ctx({ daysSinceLast: 10 })).expected, 'Müdigkeit');
  assert.ok(T.signups(ctx({ prize: 10000, fee: 0, level: 6, board: true })).expected <= T.TURNIER.maxPlayers);
  const r = C.rngFrom(5);
  for (let i = 0; i < 50; i++) { const n = T.signups(ctx(), r).n; assert.ok(n >= 0 && n <= T.TURNIER.maxPlayers); }
});

test('Paarungen: jeder genau einmal, bei ungerader Zahl einer kampflos weiter; Bewertung nach Komfort und Ärger', () => {
  const r = T.pairRound([1, 2, 3, 4, 5], C.rngFrom(3));
  const seen = r.matches.flat().concat(r.bye);
  assert.deepStrictEqual(seen.slice().sort(), [1, 2, 3, 4, 5]);
  assert.strictEqual(r.matches.length, 2);
  assert.strictEqual(T.pairRound([1, 2, 3, 4], C.rngFrom(1)).bye, null);
  assert.deepStrictEqual([T.reviewStars({}), T.reviewStars({ chair: true }), T.reviewStars({ chair: true, drink: true }), T.reviewStars({ chair: true, drink: true, annoy: 2 }), T.reviewStars({ annoy: 9 })], [3, 4, 5, 3, 1]);
});

test('Turnier ansetzen: ab Stufe 4, Tisch mit 2 Stühlen, 2 Tage vorher, Preisgeld wird zurückgelegt', () => {
  assert.strictEqual(cat.playmat_table.level, 3);
  assert.match(apply(shopWithTable(3), { type: 'planTurnier', day: 3, fee: 10, prize: 100 }).error, /Stufe 4/);
  const noChairs = shopWithTable(4);
  noChairs.items = noChairs.items.filter((it) => it.id !== 'chair');
  assert.match(apply(noChairs, { type: 'planTurnier', day: 3, fee: 10, prize: 100 }).error, /Stühlen/);
  let s = shopWithTable(4);
  assert.match(apply(s, { type: 'planTurnier', day: 2, fee: 10, prize: 100 }).error, /frühestens/);
  const coins = s.coins;
  s = run(s, { type: 'planTurnier', day: 3, fee: 10, prize: 100 });
  assert.strictEqual(s.coins, coins - 100);
  assert.match(apply(s, { type: 'planTurnier', day: 5, fee: 0, prize: 0 }).error, /schon/);
  assert.strictEqual(run(s, { type: 'cancelTurnier' }).coins, coins, 'Absage: Geld zurück');
});

test('Turniertag: Anmeldungen bringen Startgeld, Ende zahlt den Preis aus, Abbruch gibt ihn zurück', () => {
  let s = run(shopWithTable(4), { type: 'planTurnier', day: 3, fee: 10, prize: 100 });
  s.turnier.plan.n = 3; // würfelt sonst der Server
  s.day = 3;
  const coins = s.coins;
  s = run(s, { type: 'openDay' });
  assert.deepStrictEqual(s.turnier.active, { fee: 10, prize: 100, n: 3, checked: 0, fees: 0 });
  s = run(s, { type: 'turnierCheckin' }, { type: 'turnierCheckin' }, { type: 'turnierCheckin' });
  assert.match(apply(s, { type: 'turnierCheckin' }).error, /alle/i);
  assert.strictEqual(s.coins, coins + 30);
  s = run(s, { type: 'turnierEnd' });
  assert.strictEqual(s.coins, coins + 30, 'Preis war schon zurückgelegt');
  assert.deepStrictEqual([s.turnier.active, s.turnier.last, s.turnier.history[0].players], [null, 3, 3]);
  // Abbruch beim Ladenschluss: Preisgeld zurück
  let a = run(shopWithTable(4), { type: 'planTurnier', day: 3, fee: 0, prize: 200 });
  a.turnier.plan.n = 4;
  a.day = 3;
  const before = a.coins;
  a = run(a, { type: 'openDay' }, { type: 'closeDay' });
  assert.strictEqual(a.coins, before + 200);
  assert.ok(a.turnier.history[0].aborted);
});

test('Laden-Merch ab Stufe 2 im Regal, ohne Lizenz', () => {
  ['deckbox', 'playmat', 'sleeves_te', 'deckbox_te', 'playmat_te'].forEach((id) => {
    assert.ok(goods[id] && goods[id].level === 2 && !goods[id].license && goods[id].merch, id);
    assert.ok(cat.shelf_small.holds.includes(id));
  });
});
