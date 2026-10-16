const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const { CATALOG, GOODS, LICENSES, SERVICES, CLOTHES } = require('../src/shop/catalog');

const cat = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const more = { licenses: Object.fromEntries(LICENSES.map((l) => [l.id, l])), services: Object.fromEntries(SERVICES.map((x) => [x.id, x])), clothes: CLOTHES };
const apply = (s, a) => L.apply(s, cat, goods, a, more);
const run = (state, ...actions) => actions.reduce((s, a) => {
  const r = apply(s, a);
  assert.ok(!r.error, r.error);
  return r.state;
}, state);

test('Ruf: Umsatz und Bewertungen, Stufe fällt nie zurück', () => {
  let s = L.fresh();
  s.items.push({ uid: 1, id: 'shelf_small', x: 0, y: 0, rot: 0, stock: { booster_box: 4 } });
  s = run(s, { type: 'openDay' }, { type: 'checkout', lines: [{ uid: 1, ware: 'booster_box', qty: 2 }], stars: 5, why: '5' });
  assert.strictEqual(s.ruf, 20 + 5, '200 Umsatz = 20, 5★ = 5');
  s = run(s, { type: 'leave', stars: 1, why: 'empty' });
  assert.strictEqual(s.ruf, 20);
  assert.strictEqual(s.level, 1);
  s = run(s, { type: 'devRuf', amount: 200 });
  assert.strictEqual(s.level, 2);
  s = run(s, { type: 'leave', stars: 1, why: 'empty' }, { type: 'leave', stars: 1, why: 'empty' }, { type: 'leave', stars: 1, why: 'empty' });
  assert.strictEqual(s.level, 2, 'Stufe bleibt');
  assert.ok(s.ruf >= L.RUF.levels[1], 'Ruf nicht unter die Schwelle der Stufe');
  assert.strictEqual(L.nextLevelAt(s), L.RUF.levels[2]);
});

test('Freischaltungen nach Stufe', () => {
  let s = L.fresh();
  assert.match(apply(s, { type: 'orderMoebel', id: 'lager_regal_klein' }).error, /Stufe 2/);
  assert.match(apply(s, { type: 'buildRoom', kind: 'lager', x: 0, y: 0, w: 2, d: 2, door: { side: 'e', i: 0 } }).error, /Stufe 2/);
  assert.match(apply(s, { type: 'buyLicense', id: 'sammler' }).error, /Stufe 2/);
  assert.match(apply(s, { type: 'orderMoebel', id: 'cd_dvd_holder' }).error, /Stufe 3/);
  assert.match(apply(s, { type: 'orderWare', id: 'retro_cd', n: 1 }).error, /Stufe 3/);
  assert.match(apply(s, { type: 'buyUnit', price: 5000 }).error, /Stufe 5/);
  s = run(s, { type: 'devRuf', amount: 150 });
  assert.ok(!apply(s, { type: 'buildRoom', kind: 'lager', x: 0, y: 0, w: 2, d: 2, door: { side: 'e', i: 0 } }).error);
  assert.match(apply(s, { type: 'buildRoom', kind: 'geheim', x: 0, y: 0, w: 2, d: 2, door: { side: 'e', i: 0 } }).error, /Stufe 4/);
  // Kunden wünschen sich nur, was auf der Stufe schon geht
  const ids = C.wishPool(GOODS, { level: 1, licenses: [], coins: 99999, prices: { sammler: 1, brettspiele: 1 } }).map((g) => g.id);
  assert.ok(!ids.includes('retro_cd'));
});

test('CD/DVD-Ständer nimmt alte Spiele', () => {
  assert.deepStrictEqual(cat.cd_dvd_holder.holds, ['retro_cd', 'retro_dvd']);
  assert.strictEqual(cat.cd_dvd_holder.slots, 12);
  let s = Object.assign(L.fresh(), { level: 3, ruf: 500 });
  s.items.push({ uid: 1, id: 'cd_dvd_holder', x: 0, y: 0, rot: 0 });
  s = run(s, { type: 'orderWare', id: 'retro_dvd', n: 1 }, { type: 'pick', bid: 1 }, { type: 'stock', uid: 1 });
  assert.deepStrictEqual(s.items[0].stock, { retro_dvd: 10 });
});

test('Kleidung: kaufen = gleich anziehen, nochmal = ausziehen', () => {
  let s = run(L.fresh(), { type: 'buyClothes', id: 'kappe_rot' });
  assert.deepStrictEqual([s.wardrobe, s.outfit.kopf], [['kappe_rot'], 'kappe_rot']);
  assert.strictEqual(s.coins, L.START_COINS - 40);
  assert.match(apply(s, { type: 'buyClothes', id: 'kappe_rot' }).error, /schon/);
  assert.match(apply(s, { type: 'wear', id: 'jeans' }).error, /nicht/);
  s = run(s, { type: 'buyClothes', id: 'muetze_grau' });
  assert.strictEqual(s.outfit.kopf, 'muetze_grau', 'gleicher Platz: wird getauscht');
  s = run(s, { type: 'wear', id: 'muetze_grau' });
  assert.strictEqual(s.outfit.kopf, undefined);
  assert.ok(CLOTHES.every((c) => 'suspicion' in c), 'Feld für den späteren Verdacht');
});

test('Folieren am Tisch verbraucht einen Sleeve und zählt die Qualität', () => {
  let s = L.fresh();
  s.items.push({ uid: 1, id: 'pack_opening_counter', x: 0, y: 0, rot: 0, stock: { mat_sleeve: 1 } }, { uid: 2, id: 'card_cleaning_table', x: 0, y: 2, rot: 0 });
  s = run(s, { type: 'openDay' }, { type: 'takeJob', job: { services: ['clean', 'foil'], card: 'x', defects: {}, spots: [], seed: 'aa' } });
  const jid = s.jobs[0].jid;
  s = run(s, { type: 'benchDone', jid, steps: ['clean'], results: { clean: 100 } }, { type: 'benchDone', jid, steps: ['foil'], results: { foil: 75 } });
  assert.deepStrictEqual(s.items[0].stock, {});
  assert.strictEqual(C.workStars(['clean', 'foil'], s.jobs[0].results), 4);
});
