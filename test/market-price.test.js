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
  assert.deepEqual(summary([{ card: 'a' }, { card: 'a' }], prices), { key: 'a|lose', state: 'lose', avg: 450, n: 4, deals: 3, count: 2 });
  assert.deepEqual(summary([{ card: 'a', damaged: true }], prices), { key: 'a|beschaedigt', state: 'beschaedigt', avg: null, n: 0, deals: 0, count: 1 });
  assert.equal(summary([{ card: 'a' }, { card: 'b' }], prices), null);
  assert.equal(summary([{ card: 'item:folie' }], prices), null);
  assert.equal(summary([], prices), null);
});
