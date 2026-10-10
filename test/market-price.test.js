process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { priceRefOf, stateKey, summary, stateText } = require('../src/trade/marketPrice');

const sale = (give, price, extra = {}) => ({ give, want: [], price, extraFrom: 'to', ...extra });

test('#204: Ø-Marktpreis – Zustand einer Position', () => {
  assert.equal(stateKey({ card: 'a' }), 'lose');
  assert.equal(stateKey({ card: 'a', damaged: true, creased: true }), 'beschaedigt');
  assert.equal(stateKey({ card: 'a', foiledAt: new Date() }), 'folie');
  assert.equal(stateKey({ card: 'a', foiledAt: new Date(), slab: { code: 'PSA', grade: 9 } }), 'slab-9');
  assert.equal(stateKey({ card: 'a', foiledAt: new Date(), grade: 7 }), 'slab-7'); // alte Folie mit Note = BfW-Slab
  assert.equal(stateText('slab-9'), 'Slab, Note 9');
  assert.equal(stateText('lose'), 'ohne Folie');
});

test('#204: Ø-Marktpreis – nur saubere Verkäufe zählen', () => {
  // 3 gleiche Karten für 10 € -> 3,33 € je Stück
  assert.deepEqual(priceRefOf(sale([{ card: 'a' }, { card: 'a' }, { card: 'a' }], 1000)), { key: 'a|lose', n: 3, unit: 333 });
  // Gesuch: der Anbieter zahlt, der Empfänger gibt die Karten
  assert.deepEqual(priceRefOf({ give: [], want: [{ card: 'a' }], price: 500, extraFrom: 'seller' }), { key: 'a|lose', n: 1, unit: 500 });
  // kein Geld, Tausch, gemischte Karten, gemischte Zustände, Gegenstände: kein Preis
  assert.equal(priceRefOf(sale([{ card: 'a' }], 0)), null);
  assert.equal(priceRefOf({ give: [{ card: 'a' }], want: [{ card: 'b' }], price: 100, extraFrom: 'to' }), null);
  assert.equal(priceRefOf(sale([{ card: 'a' }, { card: 'b' }], 1000)), null);
  assert.equal(priceRefOf(sale([{ card: 'a' }, { card: 'a', damaged: true }], 1000)), null);
  assert.equal(priceRefOf(sale([{ card: 'item:folie' }], 1000)), null);
  // wer die Karten gibt, zahlt nicht auch noch
  assert.equal(priceRefOf(sale([{ card: 'a' }], 1000, { extraFrom: 'seller' })), null);
  // Zustände getrennt
  assert.equal(priceRefOf(sale([{ card: 'a', foiledAt: new Date(), slab: { code: 'BfW', grade: 10 } }], 9000)).key, 'a|slab-10');
});

test('#204: Ø-Marktpreis – Zusammenfassung einer Seite', () => {
  const prices = new Map([['a|lose', { avg: 450, n: 4, deals: 3 }]]);
  const pick = (s) => ({ key: s.key, state: s.state, avg: s.avg, n: s.n, deals: s.deals, count: s.count, estimated: s.estimated });
  assert.deepEqual(pick(summary([{ card: 'a' }, { card: 'a' }], prices)), { key: 'a|lose', state: 'lose', avg: 450, n: 4, deals: 3, count: 2, estimated: false });
  assert.deepEqual(pick(summary([{ card: 'a', damaged: true }], prices)), { key: 'a|beschaedigt', state: 'beschaedigt', avg: null, n: 0, deals: 0, count: 1, estimated: false });
  assert.equal(summary([{ card: 'a' }, { card: 'b' }], prices), null);
  assert.equal(summary([{ card: 'item:folie' }], prices), null);
  assert.equal(summary([], prices), null);
});

test('#204 C: Kürzel bei Slab-Verkäufen und Ø je Shop', () => {
  const slab = (code, grade = 9) => ({ card: 'a', foiledAt: new Date(), slab: { code, grade } });
  assert.deepEqual(priceRefOf(sale([slab('TST'), slab('TST')], 2000)), { key: 'a|slab-9', n: 2, unit: 1000, code: 'TST' });
  assert.equal(priceRefOf(sale([slab('TST'), slab('ABC')], 2000)).code, undefined); // verschiedene Shops: kein Kürzel
  assert.equal(priceRefOf(sale([{ card: 'a', foiledAt: new Date(), grade: 8 }], 500)).code, 'BfW');
  const prices = new Map([['a|slab-9', { avg: 1200, n: 3, deals: 2 }], ['a|slab-9#TST', { avg: 1500, n: 1, deals: 1 }]]);
  const s = summary([slab('TST')], prices);
  assert.deepEqual([s.avg, s.code, s.codeAvg, s.codeN], [1200, 'TST', 1500, 1]);
  assert.equal(summary([slab('ABC')], prices).codeAvg, null);
});

test('#204 C: Schätzung – Seltenheit, Verbreitung, Note, Population, Vertrauen', () => {
  const { estimate, ratiosFrom, trustOf, GRADE_FACTOR, RARITY_RATIO } = require('../src/trade/marketPrice');
  const catalog = require('../src/tcg/catalog');
  const card = catalog.cardsByRarity.holo[0];
  const sell = catalog.rarityByKey.holo.sell;
  const h = RARITY_RATIO.holo; // Startwert ohne eigene Daten (aus dem Protokoll: Holo ≈ 3 × Händlerpreis)
  // Verhältnis Markt/Händler erst ab 3 verkauften Stück
  assert.equal(ratiosFrom(new Map([[`${card.id}|lose`, { avg: sell * 2, n: 2 }]])).size, 0);
  const ratios = ratiosFrom(new Map([[`${card.id}|lose`, { avg: sell * 2, n: 3 }], [`${card.id}|lose#X`, { avg: 1, n: 99 }]]));
  assert.equal(ratios.get('holo|lose'), 2);
  // ohne Daten: Händlerpreis × Startwert der Seltenheit; mit Daten das gemessene Verhältnis
  assert.equal(estimate({ card: card.id }), Math.round(sell * h));
  assert.equal(estimate({ card: card.id }, { ratios }), sell * 2);
  assert.equal(estimate({ card: card.id, damaged: true }), Math.round(sell * h * 0.75));
  // Verbreitung: niemand besitzt sie → ×1,5; alle → ×1
  const population = (share, slabs = {}) => ({ active: 10, spread: new Map([[card.id, { owners: 1, share }]]), pop: new Map([[card.id, { copies: 5, slabs, byCode: {} }]]) });
  assert.equal(estimate({ card: card.id }, { population: population(0) }), Math.round(sell * h * 1.5));
  assert.equal(estimate({ card: card.id }, { population: population(1) }), Math.round(sell * h));
  // Slab Note 10, keiner da: × 3 (Note) × 1,75 (Pop) × Vertrauen
  const slab = { card: card.id, foiledAt: new Date(), slab: { code: 'TST', grade: 10 } };
  assert.equal(estimate(slab, { population: population(1) }), Math.round(sell * h * GRADE_FACTOR[10] * 1.75));
  assert.equal(estimate(slab, { population: population(1, { 10: 3 }) }), Math.round(sell * h * 3));
  assert.equal(estimate(slab, { population: population(1, { 10: 3 }), trust: new Map([['TST', 1.2]]) }), Math.round(sell * h * 3 * 1.2));
  assert.equal(estimate({ card: 'item:folie' }), null);
  assert.equal(trustOf({ exact: 5, n: 5 }), 1.2);
  assert.equal(trustOf({ exact: 0, n: 10 }), 0.8);
  assert.equal(trustOf({ exact: 0, n: 2 }), 1); // zu wenige Noten
});

test('#204 C: Marktpreis robust – Geschenke, Mehrfach-Konten, Ausreißer, mindestens zwei Handelspaare', () => {
  const { aggregate, measured } = require('../src/trade/marketPrice');
  const catalog = require('../src/tcg/catalog');
  const card = catalog.cardsByRarity.glitch[0];
  const sell = catalog.rarityByKey.glitch.sell;
  const key = `${card.id}|lose`;
  const row = (unit, pair, n = 1) => ({ key, n, unit, pair });
  // drei Glitch-Karten für je 1 € (wie im Protokoll) sind Geschenke und zählen nicht
  assert.equal(aggregate([row(100, 'a:b'), row(101, 'a:c'), row(100, 'a:d')]).get(key), undefined);
  // ein Verkauf zwischen erkannten Mehrfach-Konten zählt nicht
  const flagged = new Set(['a:x']);
  const m = aggregate([row(sell * 2, 'a:x'), row(sell, 'a:b'), row(sell * 1.2, 'c:d')], flagged).get(key);
  assert.deepEqual([m.avg, m.n, m.pairs], [sell * 1.1, 2, 2]);
  // Ausreißer über dem 5-fachen Median fällt raus
  assert.equal(aggregate([row(sell, 'a:b'), row(sell, 'c:d'), row(sell * 20, 'e:f')]).get(key).avg, sell);
  // gemessen erst ab zwei Handelspaaren
  const one = aggregate([row(sell, 'a:b'), row(sell, 'a:b')]).get(key);
  assert.equal(measured(one), false);
  assert.equal(measured(m), true);
  const prices = new Map([[key, one]]);
  const s = summary([{ card: card.id }], prices, {});
  assert.equal(s.avg, null);
  assert.equal(s.estimated, true);
});
