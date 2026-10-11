process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const rep = require('../src/grading/reputation');
const orders = require('../src/grading/orderService');
const grading = require('../src/grading/gradingService');
const { LOCK_LABELS } = require('../src/tcg/locks');

test('#204 B: Arbeitsqualität – Ø aus Sauberkeit, Versiegelung und Glätte', () => {
  assert.equal(rep.qualityOf({ clean: 100, seal: 80 }), 90);
  assert.equal(rep.qualityOf({ clean: 100, seal: 80, iron: { smooth: 30 } }), 70);
  assert.equal(rep.qualityOf({ clean: 150, seal: -5 }), 50); // geklemmt
  assert.equal(rep.qualityOf({}), 0);
});

test('#204 B: Vitrine – Seltenheit × Note über 5, höchstens +100 %', () => {
  assert.equal(rep.showcaseBoost([]), 0);
  assert.equal(rep.showcaseBoost([{ rank: 5, grade: 10 }]), 0.3);
  assert.equal(rep.showcaseBoost([{ rank: 0, grade: 5 }]), 0); // Note 5 bringt nichts
  assert.equal(rep.showcaseBoost(Array(10).fill({ rank: 5, grade: 10 })), 1);
});

test('#204 B: Reputation je Auftrag, Sterne und Stufen', () => {
  assert.equal(rep.reputationGain({ quality: 50 }), 10);
  assert.equal(rep.reputationGain({ quality: 50, player: true }), 20);
  assert.equal(rep.reputationGain({ quality: 100, player: true, boost: 1 }), 60);
  assert.equal(rep.reputationGain({ quality: 0 }), 5);
  assert.deepEqual([1, 3, 5].map(rep.starGain), [-10, 0, 10]);
  assert.equal(rep.tierOf(0).label, 'Neuling');
  assert.equal(rep.tierOf(100).label, 'Bekannt');
  assert.equal(rep.tierOf(1999).next, 2000);
  assert.equal(rep.tierOf(5000).next, null);
  const r = rep.ratingOf({ stars: { sum: 9, n: 2 }, quality: { sum: 150, n: 2 }, hits: { exact: 1, n: 4 }, reputation: 120 });
  assert.deepEqual([r.stars, r.quality, r.hitRate, r.tier.label], [4.5, 75, 25, 'Bekannt']);
  assert.equal(rep.ratingOf({}).stars, null);
});

test('#204: Festpreise je Baustein im Rahmen, Summe der gebuchten Bausteine', () => {
  const r = (min, max, def) => ({ min, max, def });
  const s = { servicePrice: { base: r(1000, 5000, 2000), iron: r(1000, 9000, 3000), slab: r(2000, 50000, 6000), express: r(0, 9000, 3000), review: r(1000, 9000, 2500) } };
  assert.deepEqual(orders.shopPrices(null, s), { base: 2000, iron: 3000, slab: 6000, express: 3000, review: 2500 });
  assert.deepEqual(orders.shopPrices({ prices: { base: 100, iron: null, slab: 99999999, express: 0 } }, s), { base: 1000, iron: 3000, slab: 50000, express: 0, review: 2500 });
  const shop = { prices: { base: 2500, iron: 4000, slab: 7000, express: 1500, review: 3000 } };
  assert.deepEqual(orders.priceOf(shop, { slab: true }, s), { parts: { base: 2500, slab: 7000 }, total: 9500 });
  assert.deepEqual(orders.priceOf(shop, { iron: true, slab: true, express: true }, s).total, 15000);
  assert.deepEqual(orders.priceOf(shop, { iron: true }, s), { parts: { base: 2500, iron: 4000 }, total: 6500 });
  // Zweitprüfung steht allein: keine Reinigung, Bügeln und Slab fallen weg, Express geht
  assert.deepEqual(orders.priceOf(shop, { review: true, slab: true, express: true }, s), { parts: { review: 3000, express: 1500 }, total: 4500 });
  assert.equal(orders.validPrices({ base: 1000, iron: 9000, slab: 2000, express: 0, review: 1000 }, s), true);
  assert.equal(orders.validPrices({ base: 999, iron: 3000, slab: 6000, express: 0, review: 2500 }, s), false);
  assert.equal(orders.validPrices({ base: 2000, iron: 3000, slab: 6000.5, express: 0, review: 2500 }, s), false);
  assert.equal(orders.validPrices({ base: 2000, iron: 3000, slab: 6000, express: 0 }, s), false); // Zweitprüfung fehlt
});

test('#204: Bausteine – ältere Aufträge sind Bügeln + Slab, Express verkürzt die Frist', () => {
  assert.deepEqual(orders.servicesOf({}), { iron: true, slab: true, express: false, review: false });
  assert.deepEqual(orders.servicesOf({ services: { slab: true } }), { iron: false, slab: true, express: false, review: false });
  assert.deepEqual(orders.servicesOf({ services: { review: true, iron: true, express: true } }), { iron: false, slab: false, express: true, review: true });
  const s = { orderDays: 3, expressDays: 1 };
  assert.equal(orders.deadline(0, s).getTime(), 3 * 864e5);
  assert.equal(orders.deadline(0, s, { express: true }).getTime(), 864e5);
  assert.deepEqual(orders.QUEUE_SORT, { 'services.express': -1, createdAt: 1 });
});

test('#204: Schritte nach gebuchten Bausteinen', () => {
  const crease = { crease: true };
  const steps = (services, defects = crease, level = 3) => grading.stepsFor({ level, defects, services });
  assert.deepEqual(steps(null), ['clean', 'iron', 'grade', 'slab']); // NPC: nach Stufe
  assert.deepEqual(steps({ iron: true, slab: true }), ['clean', 'iron', 'grade', 'slab']);
  assert.deepEqual(steps({ iron: false, slab: true }), ['clean', 'grade', 'slab']); // Knick bleibt, nicht gebucht
  assert.deepEqual(steps({ iron: true, slab: false }), ['clean', 'iron']); // nur bügeln, ohne Slab zurück
  assert.deepEqual(steps({ iron: true, slab: true }, { crease: true, ironed: true }), ['clean', 'grade', 'slab']);
  assert.deepEqual(steps({ review: true }), ['grade']); // Zweitprüfung: nur benoten, die Karte bleibt im Slab
  assert.ok(grading.validRange({ min: 0, max: 10, def: 5 }) && !grading.validRange({ min: 6, max: 10, def: 5 }));
});

test('#204 B: Annahme ab Stufe 3', () => {
  assert.equal(orders.acceptsOrders({ active: true, level: 3, code: 'AB' }), true);
  assert.equal(orders.acceptsOrders({ active: true, level: 2, code: 'AB' }), false);
  assert.equal(orders.acceptsOrders({ active: false, level: 4, code: 'AB' }), false);
  assert.equal(orders.acceptsOrders({ active: true, level: 4, code: null }), false);
});

test('#204 B: Tageslimits getrennt nach NPC und Spieler, Bügeln nur ungebügelt', () => {
  const day = '2026-10-10';
  const done = [{ level: 3, source: 'spieler' }, { level: 3 }, { level: 3, source: 'npc' }, { level: 2 }];
  assert.equal(grading.usedToday({ done, open: null, level: 3, day }), 2);
  assert.equal(grading.usedToday({ done, open: { day, level: 3, source: 'spieler' }, level: 3, day, source: 'spieler' }), 2);
  assert.equal(grading.stepsFor({ level: 3, defects: { crease: true } }).includes('iron'), true);
  assert.equal(grading.stepsFor({ level: 3, defects: { crease: true, ironed: true } }).includes('iron'), false);
  assert.equal(orders.canRate({ status: 'fertig', stars: null, doneAt: new Date() }), true);
  assert.equal(orders.canRate({ status: 'fertig', stars: 4, doneAt: new Date() }), false);
  assert.equal(orders.canRate({ status: 'fertig', stars: null, doneAt: new Date(Date.now() - 8 * 864e5) }), false);
  assert.equal(LOCK_LABELS.grading && LOCK_LABELS.vitrine ? 'ok' : 'fehlt', 'ok');
});

test('#204: Lohn nach Posten ergibt dieselbe Summe wie payFor', () => {
  const cases = [
    { level: 1, clean: 80, rarity: 'holo' },
    { level: 2, clean: 100, grade: 7, guess: 6, iron: 55, rarity: 'glitch' },
    { level: 3, clean: 93, grade: 9, guess: 9, seal: 71, rarity: 'sith' },
    { level: 4, clean: 100, grade: 5, guess: 8, seal: 100, iron: 100, rarity: 'boss' },
  ];
  for (const c of cases) {
    const p = grading.payParts(c);
    assert.equal(p.total, grading.payFor(c));
    assert.equal(Object.values(p.parts).reduce((a, b) => a + b, 0) + p.extra, p.total);
  }
  assert.deepEqual(Object.keys(grading.payParts({ level: 3, clean: 100, grade: 5, guess: 5, seal: 50 }).parts), ['clean', 'grade', 'slab']);
});

test('#204: Werkzeuge – ab ihrer Stufe kaufbar, gekaufte markiert', () => {
  const list = grading.toolsFor({ level: 1, tools: ['tuch'] });
  assert.deepEqual(list.map((t) => [t.key, t.owned, t.available]), [['tuch', true, true], ['schablone', false, false], ['eisen', false, false], ['uv', false, false]]);
  assert.ok(grading.toolsFor({ level: 2 }).every((t) => t.available && !t.owned && t.cost > 0));
});
