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

test('#204 B: Preis eines Shops im Rahmen, Annahme ab Stufe 3', () => {
  const s = { orderPrice: { min: 2000, max: 50000, def: 8000 } };
  assert.equal(orders.priceOf({ price: null }, s), 8000);
  assert.equal(orders.priceOf({ price: 100 }, s), 2000);
  assert.equal(orders.priceOf({ price: 99999999 }, s), 50000);
  assert.equal(orders.validPrice(2000, s) && !orders.validPrice(1999, s) && !orders.validPrice(10.5, s), true);
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
