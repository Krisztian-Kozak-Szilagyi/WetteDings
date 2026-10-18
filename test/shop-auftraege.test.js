const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const { CATALOG, GOODS, LICENSES, SERVICES, SERVICE_PACKS } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const more = { licenses: Object.fromEntries(LICENSES.map((l) => [l.id, l])), services: Object.fromEntries(SERVICES.map((x) => [x.id, x])) };
const apply = (s, a) => L.apply(s, cat, goods, a, more);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);
const fixed = (v) => () => v;
const prices = Object.fromEntries(LICENSES.map((l) => [l.id, l.price]));

test('Lizenzen: Preise, Wünsche nur aus dem, was der Spieler haben kann', () => {
  assert.deepStrictEqual(LICENSES.map((l) => [l.id, l.price]), [['sammler', 2500], ['brettspiele', 1500]]);
  const ids = (ctx) => C.wishPool(GOODS, ctx).map((g) => g.id);
  const poor = ids({ licenses: [], coins: 100, prices });
  assert.ok(poor.includes('booster_pack') && !poor.includes('booster_box') && !poor.includes('board_game_box'));
  assert.ok(!poor.includes('mat_slab'), 'Material wünscht sich niemand');
  const canAfford = ids({ licenses: [], coins: 2000, prices });
  assert.ok(canAfford.includes('board_game_box') && !canAfford.includes('booster_box'), 'leistbare Lizenz zählt');
  assert.ok(ids({ licenses: ['sammler'], coins: 0, prices }).includes('graded_slab'));
});

test('Großeinkäufer nimmt deutlich mehr', () => {
  const offers = [{ uid: 1, ware: 'booster_pack', qty: 100, price: 10 }];
  const normal = C.shop({ tol: 0, wish: 'booster_pack' }, offers, goods, fixed(0.99)).basket[0].qty;
  const big = C.shop({ tol: 0, wish: 'booster_pack', big: true }, offers, goods, fixed(0.99)).basket[0].qty;
  assert.ok(normal <= 3 && big >= normal * 3);
  // Material im Regal kauft kein Kunde
  assert.deepStrictEqual(C.shop({ tol: 0, wish: null }, [{ uid: 2, ware: 'mat_slab', qty: 5, price: 40 }], goods, fixed(0.1)).basket, []);
});

test('Auftrag nur mit passenden Tischen, höchstens 2, Arbeit → Sterne', () => {
  const all = new Set(['card_cleaning_table', 'card_grading_table', 'pack_opening_counter']);
  assert.strictEqual(C.serviceWish(fixed(0.5), all, 0, SERVICE_PACKS, SERVICES), null, '90 % bringen nichts');
  assert.ok(C.serviceWish(fixed(0.05), all, 0, SERVICE_PACKS, SERVICES));
  assert.strictEqual(C.serviceWish(fixed(0.05), all, 2, SERVICE_PACKS, SERVICES), null);
  assert.strictEqual(C.serviceWish(fixed(0.05), new Set(), 0, SERVICE_PACKS, SERVICES), null);
  const onlyClean = C.serviceWish(fixed(0.05), new Set(['card_cleaning_table']), 0, SERVICE_PACKS, SERVICES);
  assert.deepStrictEqual(onlyClean, ['clean']);
  assert.strictEqual(C.workStars(['clean', 'grade', 'slab'], { clean: 100, guess: 8, grade: 8, seal: 95 }), 5);
  assert.strictEqual(C.workStars(['clean', 'grade', 'slab'], { clean: 100, guess: 7, grade: 8, seal: 95 }), 4);
  assert.strictEqual(C.workStars(['clean'], { clean: 65 }), 3);
  assert.strictEqual(C.workStars(['clean'], { clean: 50 }), 2, 'schlechte Arbeit: unter 3');
  assert.strictEqual(C.workStars(['grade'], { guess: 4, grade: 9 }), 1);
  assert.deepStrictEqual([C.comfortStars(false, false), C.comfortStars(true, false), C.comfortStars(true, true), C.comfortStars(false, true)], [3, 4, 5, 3]);
});

test('Auftrag: annehmen, Tische, Slab/Sleeve verbrauchen, kassieren', () => {
  let s = L.fresh();
  s.items.push(
    { uid: 1, id: 'card_cleaning_table', x: 0, y: 0, rot: 0 },
    { uid: 2, id: 'card_grading_table', x: 0, y: 2, rot: 0, stock: { mat_slab: 1 } },
    { uid: 3, id: 'pack_opening_counter', x: 0, y: 4, rot: 0 }
  );
  s.nextUid = 4;
  const job = (services) => ({ type: 'takeJob', job: { services, card: 'x', defects: {}, spots: [], seed: 'ab12' } });
  assert.match(apply(s, job(['clean'])).error, /zu/, 'nur bei offenem Laden');
  s = run(s, { type: 'openDay' }, job(['slab', 'clean', 'grade']));
  assert.deepStrictEqual(s.jobs[0].services, ['clean', 'grade', 'slab'], 'feste Reihenfolge');
  assert.strictEqual(L.nextService(s.jobs[0]), 'clean');
  s = run(s, job(['clean', 'foil']));
  assert.match(apply(s, job(['clean'])).error, /offenen Aufträge/);
  const jid = s.jobs[0].jid;
  assert.match(apply(s, { type: 'serviceCheckout', jid }).error, /nicht fertig/);
  s = run(s, { type: 'benchDone', jid, steps: ['clean'], results: { clean: 98 } }, { type: 'benchDone', jid, steps: ['grade', 'slab'], results: { guess: 8, grade: 8, seal: 92 } });
  assert.deepStrictEqual(s.items[1].stock, {}, 'Slab verbraucht');
  // zweiter Auftrag: Sleeve fehlt → erst nach Nachschub
  const jid2 = s.jobs[1].jid;
  s = run(s, { type: 'benchDone', jid: jid2, steps: ['clean'], results: { clean: 90 } });
  assert.match(apply(s, { type: 'foil', jid: jid2 }).error, /Sleeve/);
  s.items[2].stock = { mat_sleeve: 3 };
  s = run(s, { type: 'foil', jid: jid2 });
  assert.deepStrictEqual(s.items[2].stock, { mat_sleeve: 2 });
  // Preise: Standard = Marktpreis, eigener Preis zählt
  s = run(s, { type: 'setServicePrice', service: 'slab', price: 70 });
  const coins = s.coins;
  s = run(s, { type: 'serviceCheckout', jid, stars: 5, why: 'job5' });
  assert.strictEqual(s.coins, coins + 25 + 30 + 70);
  assert.deepStrictEqual(s.today.services, { clean: 1, grade: 1, slab: 1 });
  s = run(s, { type: 'jobCancel', jid: jid2, stars: 2, why: 'jobwait' });
  assert.deepStrictEqual([s.jobs.length, s.reviews.map((r) => r.stars)], [0, [5, 2]]);
  // fehlender Tisch
  s.items = s.items.filter((it) => it.id !== 'pack_opening_counter');
  assert.match(apply(s, job(['clean', 'foil'])).error, /Öffnungstheke/);
  s = run(s, job(['clean']), { type: 'closeDay' });
  assert.strictEqual(s.jobs.length, 0, 'offene Aufträge verfallen bei Ladenschluss');
  assert.deepStrictEqual(s.reports[0].services, { clean: 1, grade: 1, slab: 1 });
});
