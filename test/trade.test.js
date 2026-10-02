process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const trade = require('../src/trade/tradeService');
const catalog = require('../src/tcg/catalog');
const { UserError } = require('../src/lib/util');

const [A, B] = catalog.CARDS.map((c) => c.id);
const rejects = (fn, re) => assert.throws(fn, (err) => err instanceof UserError && re.test(err.message));

test('Handelssteuer: standardmäßig 0 %, wird abgerundet und begrenzt', () => {
  assert.equal(trade.settings.taxPercent, 0);
  assert.equal(trade.taxFor(10000), 0);
  assert.equal(trade.taxFor(10000, 5), 500);
  assert.equal(trade.taxFor(999, 5), 49); // 49,95 Cent -> abgerundet
  assert.equal(trade.taxFor(10000, 150), 10000); // nie mehr als der Preis
  assert.equal(trade.taxFor(10000, -3), 0);
});

test('Markt-Abzeichen: nur fremde, offene Markt-Angebote seit dem letzten Besuch', () => {
  const created = new Date('2026-01-01');
  const seen = new Date('2026-02-01');
  const user = { _id: 'u1', createdAt: created, marketSeenAt: null };
  const f = trade.marketNewFilter(user);
  assert.equal(f.kind, 'markt');
  assert.equal(f.status, 'offen');
  assert.deepEqual(f.seller, { $ne: 'u1' });
  assert.equal(f.createdAt.$gt, created); // noch nie besucht -> seit Registrierung
  assert.equal(trade.marketNewFilter({ ...user, marketSeenAt: seen }).createdAt.$gt, seen);
});

test('Abzeichen "Angebote an dich": privat und Tausch, nur offene', () => {
  const f = trade.incomingFilter('u1');
  assert.equal(f.to, 'u1');
  assert.equal(f.status, 'offen');
  assert.ok(f.expiresAt.$gt instanceof Date);
  assert.equal(f.kind, undefined); // keine Einschränkung auf "privat"
});

test('Angebot prüfen: Verkauf', () => {
  assert.deepEqual(trade.validateOffer({ kind: 'markt', price: 1, cardId: A }), { extraFrom: null });
  assert.deepEqual(trade.validateOffer({ kind: 'privat', price: trade.MAX_PRICE, cardId: A, extraFrom: 'to' }), { extraFrom: null });
  rejects(() => trade.validateOffer({ kind: 'markt', price: 0, cardId: A }), /Preis/);
  rejects(() => trade.validateOffer({ kind: 'markt', price: null, cardId: A }), /Preis/);
  rejects(() => trade.validateOffer({ kind: 'markt', price: 1.5, cardId: A }), /Preis/);
  rejects(() => trade.validateOffer({ kind: 'markt', price: trade.MAX_PRICE + 1, cardId: A }), /Preis/);
  rejects(() => trade.validateOffer({ kind: 'markt', price: 100, cardId: 'gibt-es-nicht' }), /Karte/);
  rejects(() => trade.validateOffer({ kind: 'geschenk', price: 100, cardId: A }), /Angebotsart/);
});

test('Angebot prüfen: Tausch', () => {
  // ohne Aufpreis: 0 € erlaubt, wer zahlt ist egal
  assert.deepEqual(trade.validateOffer({ kind: 'tausch', price: 0, cardId: A, wantCardId: B, extraFrom: 'seller' }), { extraFrom: null });
  assert.deepEqual(trade.validateOffer({ kind: 'tausch', price: 500, cardId: A, wantCardId: B, extraFrom: 'to' }), { extraFrom: 'to' });
  rejects(() => trade.validateOffer({ kind: 'tausch', price: 500, cardId: A, wantCardId: B, extraFrom: null }), /Aufpreis/);
  rejects(() => trade.validateOffer({ kind: 'tausch', price: -1, cardId: A, wantCardId: B }), /Aufpreis/);
  rejects(() => trade.validateOffer({ kind: 'tausch', price: null, cardId: A, wantCardId: B }), /Aufpreis/);
  rejects(() => trade.validateOffer({ kind: 'tausch', price: 0, cardId: A, wantCardId: A }), /dieselbe Karte/);
  rejects(() => trade.validateOffer({ kind: 'tausch', price: 0, cardId: A, wantCardId: 'gibt-es-nicht' }), /haben möchtest/);
});

test('Geldfluss: Verkauf zahlt der Käufer, Steuer trägt der Verkäufer', () => {
  const t = { kind: 'markt', seller: 's', price: 10000 };
  assert.deepEqual(trade.settlement(t, { buyer: 'b', taxPercent: 5 }), { payer: 'b', payee: 's', amount: 10000, tax: 500 });
  assert.deepEqual(trade.settlement(t, { buyer: 'b', taxPercent: 0 }), { payer: 'b', payee: 's', amount: 10000, tax: 0 });
});

test('Geldfluss: Tausch ohne Aufpreis bewegt kein Geld, mit Aufpreis je nach Richtung', () => {
  const base = { kind: 'tausch', seller: 's', to: 't' };
  assert.equal(trade.settlement({ ...base, price: 0, extraFrom: null }), null);
  assert.deepEqual(trade.settlement({ ...base, price: 999, extraFrom: 'seller' }, { taxPercent: 5 }), { payer: 's', payee: 't', amount: 999, tax: 49 });
  assert.deepEqual(trade.settlement({ ...base, price: 999, extraFrom: 'to' }, { taxPercent: 5 }), { payer: 't', payee: 's', amount: 999, tax: 49 });
});
