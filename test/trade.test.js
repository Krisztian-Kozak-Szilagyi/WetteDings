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

test('Abzeichen: private Angebote an mich und Tausch-Verhandlungen, bei denen ich dran bin oder Neues steht', () => {
  const f = trade.incomingFilter('u1');
  assert.equal(f.status, 'offen');
  assert.ok(f.expiresAt.$gt instanceof Date);
  const [privat, alsEmpfaenger, alsAnbieter] = f.$or;
  assert.deepEqual(privat, { to: 'u1', kind: 'privat' });
  assert.equal(alsEmpfaenger.to, 'u1');
  assert.equal(alsEmpfaenger.kind, 'tausch');
  assert.deepEqual(alsEmpfaenger.$or[0], { lastChangeBy: { $ne: 'to' } }); // auch alte Angebote ohne Feld
  assert.equal(alsAnbieter.seller, 'u1');
  assert.deepEqual(alsAnbieter.$or[0], { lastChangeBy: 'to' }); // Gegenvorschlag des Empfängers
});

test('Verhandlung: Rollen und wer annehmen darf', () => {
  const t = { kind: 'tausch', seller: 's', to: 't', lastChangeBy: 'seller' };
  assert.equal(trade.roleOf(t, 's'), 'seller');
  assert.equal(trade.roleOf(t, 't'), 'to');
  assert.equal(trade.roleOf(t, 'x'), null);
  // Wer den Vorschlag gemacht hat, wartet; die andere Seite nimmt an
  assert.equal(trade.canAccept(t, 'to'), true);
  assert.equal(trade.canAccept(t, 'seller'), false);
  assert.equal(trade.canAccept({ ...t, lastChangeBy: 'to' }, 'seller'), true);
  assert.equal(trade.canAccept({ ...t, lastChangeBy: 'to' }, 'to'), false);
  assert.equal(trade.canAccept({ ...t, lastChangeBy: undefined }, 'to'), true); // alte Angebote
  assert.equal(trade.canAccept(t, null), false);
  // Verkauf: nur der Empfänger
  assert.equal(trade.canAccept({ kind: 'privat', seller: 's', to: 't' }, 'to'), true);
  assert.equal(trade.canAccept({ kind: 'privat', seller: 's', to: 't' }, 'seller'), false);
});

test('Verhandlung: ungelesen, Nachrichten prüfen, Bedingungen als Text', () => {
  const now = new Date('2026-10-02T10:00:00Z');
  const before = new Date('2026-10-02T09:00:00Z');
  assert.equal(trade.isUnread({ activityAt: now, toSeenAt: null }, 'to'), true);
  assert.equal(trade.isUnread({ activityAt: now, toSeenAt: before }, 'to'), true);
  assert.equal(trade.isUnread({ activityAt: before, sellerSeenAt: now }, 'seller'), false);
  assert.equal(trade.isUnread({ activityAt: null }, 'to'), false);

  assert.equal(trade.cleanMessage('  hallo\r\n\r\n\r\n\r\nwelt  '), 'hallo\n\nwelt');
  rejects(() => trade.cleanMessage('   '), /leer/);
  rejects(() => trade.cleanMessage('x'.repeat(trade.MESSAGE_MAX + 1)), /höchstens/);
  assert.equal(trade.cleanMessage('x'.repeat(trade.MESSAGE_MAX)).length, trade.MESSAGE_MAX);

  const t = { sellerName: 'anna', toName: 'ben', price: 0, extraFrom: null };
  assert.equal(trade.termsText(t), 'ohne Aufpreis');
  const { euro } = require('../src/lib/viewHelpers'); // setzt ein geschütztes Leerzeichen vor das €
  assert.equal(trade.termsText({ ...t, price: 500, extraFrom: 'seller' }), `anna legt ${euro(500)} drauf`);
  assert.equal(trade.termsText(t, { price: 1250, extraFrom: 'to' }), `ben legt ${euro(1250)} drauf`);
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

test('Neue Geschäfte: nur von der anderen Seite abgeschlossene, seit dem letzten Besuch', () => {
  const seen = new Date('2026-03-01');
  const f = trade.newDealsFilter({ _id: 'u1', createdAt: new Date('2026-01-01'), dealsSeenAt: seen });
  assert.equal(f.status, 'verkauft');
  assert.deepEqual(f.$or, [{ seller: 'u1' }, { buyer: 'u1' }]);
  assert.deepEqual(f.closedBy, { $nin: [null, 'u1'] }); // eigene Käufe und alte Geschäfte ohne Angabe zählen nicht
  assert.equal(f.closedAt.$gt, seen);
});
