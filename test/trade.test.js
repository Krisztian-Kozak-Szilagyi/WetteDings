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
  assert.deepEqual(trade.taxRates(), { markt: 0, privat: 0, tausch: 0 });
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
  assert.equal(f.to, null); // nur Markt-Angebote (auch Tausch und Gesuch) …
  assert.equal(f.listing, null); // … keine Gegenangebote darauf
  assert.equal(f.status, 'offen');
  assert.deepEqual(f.seller, { $ne: 'u1' });
  assert.equal(f.createdAt.$gt, created); // noch nie besucht -> seit Registrierung
  assert.equal(trade.marketNewFilter({ ...user, marketSeenAt: seen }).createdAt.$gt, seen);
});

test('Abzeichen: Angebote, bei denen ich am Zug bin oder Neues steht – egal welche Art', () => {
  const f = trade.incomingFilter('u1');
  assert.equal(f.status, 'offen');
  assert.ok(f.expiresAt.$gt instanceof Date);
  const [alsEmpfaenger, alsAnbieter] = f.$or;
  assert.equal(alsEmpfaenger.to, 'u1');
  assert.equal(alsEmpfaenger.kind, undefined); // Verkauf, Kaufanfrage und Tausch gleichermaßen
  assert.deepEqual(alsEmpfaenger.$or[0], { lastChangeBy: { $ne: 'to' } }); // auch alte Angebote ohne Feld
  assert.equal(alsAnbieter.seller, 'u1');
  assert.deepEqual(alsAnbieter.to, { $ne: null }); // das Markt-Angebot selbst zählt nicht, nur Gegenangebote darauf
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
  // Verkauf: nur der Empfänger – bis er ein Gegenangebot macht
  assert.equal(trade.canAccept({ kind: 'privat', seller: 's', to: 't' }, 'to'), true);
  assert.equal(trade.canAccept({ kind: 'privat', seller: 's', to: 't' }, 'seller'), false);
  assert.equal(trade.canAccept({ kind: 'privat', seller: 's', to: 't', lastChangeBy: 'to' }, 'seller'), true);
  // Markt-Angebot: wird gekauft, nicht angenommen
  assert.equal(trade.canAccept({ kind: 'markt', seller: 's', to: null }, 'to'), false);
  // Wer hat angelegt? Beim Gegenangebot auf dem Markt der Interessent
  assert.equal(trade.isCreator({ seller: 's', to: 't' }, 'seller'), true);
  assert.equal(trade.isCreator({ seller: 's', to: 't', listing: 'm' }, 'to'), true);
  assert.equal(trade.isCreator({ seller: 's', to: 't', listing: 'm' }, 'seller'), false);
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

  const { euro } = require('../src/lib/viewHelpers'); // setzt ein geschütztes Leerzeichen vor das €
  const t = { sellerName: 'anna', toName: 'ben', give: [{ card: A }], want: [{ card: B }], price: 0, extraFrom: null };
  const label = (id) => `${catalog.cardById[id].name} (${catalog.rarityByKey[catalog.cardById[id].rarity].label})`;
  const [a, b] = [label(A), label(B)];
  assert.equal(trade.termsText(t), `anna gibt ${a}, ben gibt ${b}`);
  assert.equal(trade.termsText({ ...t, price: 500, extraFrom: 'seller' }), `anna gibt ${a} + ${euro(500)}, ben gibt ${b}`);
  assert.equal(trade.termsText({ ...t, want: [], price: 1250, extraFrom: 'to' }), `anna gibt ${a}, ben gibt ${euro(1250)}`);
  assert.equal(trade.termsText({ ...t, toName: null, want: [], price: 100 }), `anna gibt ${a}, der Käufer gibt ${euro(100)}`);
});

const L = (...ids) => ids.map((card) => ({ card }));

test('Angebot prüfen: Markt-Angebot – Verkauf, Tausch gegen Wunschkarten und Gesuch', () => {
  assert.deepEqual(trade.validateOffer({ listing: true, give: L(A), price: 1, extraFrom: 'to' }), { extraFrom: 'to' });
  assert.deepEqual(trade.validateOffer({ listing: true, give: L(A, A, B), price: trade.MAX_PRICE, extraFrom: 'to' }), { extraFrom: 'to' });
  rejects(() => trade.validateOffer({ listing: true, give: L(A), price: 0 }), /Preis/);
  rejects(() => trade.validateOffer({ listing: true, give: L(A), price: 1.5 }), /Betrag/);
  rejects(() => trade.validateOffer({ listing: true, give: L(A), price: trade.MAX_PRICE + 1 }), /Betrag/);
  rejects(() => trade.validateOffer({ listing: true, give: L('gibt-es-nicht'), price: 100 }), /gibt es nicht/);
  // Tausch auf dem Markt: Wunschkarten, Geld optional in beide Richtungen
  assert.deepEqual(trade.validateOffer({ listing: true, give: L(A), want: L(B), price: 0 }), { extraFrom: null });
  assert.deepEqual(trade.validateOffer({ listing: true, give: L(A), want: L(B, B), price: 300, extraFrom: 'seller' }), { extraFrom: 'seller' });
  rejects(() => trade.validateOffer({ listing: true, give: L(A), want: [{ card: B, copy: 'x' }], price: 0 }), /kein bestimmtes/);
  // Gesuch: Geld für Wunschkarten – zahlen muss, wer keine Karte gibt
  assert.deepEqual(trade.validateOffer({ listing: true, want: L(B), price: 900, extraFrom: 'seller' }), { extraFrom: 'seller' });
  rejects(() => trade.validateOffer({ listing: true, want: L(B), price: 900, extraFrom: 'to' }), /keine Karte gibt/);
});

test('Angebot prüfen: Verkauf, Kaufanfrage, Tausch und Bündel', () => {
  // Verkauf: Karten gegen Geld vom Empfänger
  assert.deepEqual(trade.validateOffer({ give: L(A), price: 500, extraFrom: 'to' }), { extraFrom: 'to' });
  rejects(() => trade.validateOffer({ give: L(A), price: 500, extraFrom: 'seller' }), /keine Karte gibt/);
  rejects(() => trade.validateOffer({ give: L(A), price: 0 }), /Betrag an/); // verschenken geht nicht
  // Kaufanfrage: Geld gegen eine Karte des Empfängers
  assert.deepEqual(trade.validateOffer({ want: L(B), price: 500, extraFrom: 'seller' }), { extraFrom: 'seller' });
  rejects(() => trade.validateOffer({ want: L(B), price: 500, extraFrom: 'to' }), /keine Karte gibt/);
  // Tausch, auch 3 gegen 1 und ohne Geld; Geld in beide Richtungen möglich
  assert.deepEqual(trade.validateOffer({ give: L(A, A, B), want: L(B), price: 0, extraFrom: 'seller' }), { extraFrom: null });
  assert.deepEqual(trade.validateOffer({ give: L(A), want: L(B), price: 999, extraFrom: 'to' }), { extraFrom: 'to' });
  rejects(() => trade.validateOffer({ give: L(A), want: L(B), price: 500, extraFrom: null }), /wer das Geld/);
  rejects(() => trade.validateOffer({ give: L(A), want: L(B), price: -1 }), /Betrag/);
  // leer, zu viele, doppeltes Exemplar
  rejects(() => trade.validateOffer({ price: 500, extraFrom: 'to' }), /mindestens eine Karte/);
  rejects(() => trade.validateOffer({ give: L(...Array(trade.MAX_LINES + 1).fill(A)), price: 1, extraFrom: 'to' }), /Höchstens/);
  rejects(() => trade.validateOffer({ give: [{ card: A, doc: 'x' }], want: [{ card: A, copy: 'x' }], price: 0 }), /nur einmal/);
});

test('Formular des Handelsfensters lesen', () => {
  const f = trade.parseOfferForm({ [`gib:${A}`]: '2', gib: ['f:abc', B], [`will:${B}`]: '1', geld_gib: '5,50', geld_will: '' });
  assert.deepEqual(f.gives, [{ copy: 'abc' }, { card: A }, { card: A }, { card: B }]);
  assert.deepEqual(f.gets, [{ card: B }]);
  assert.equal(f.price, 550);
  assert.equal(f.iPay, true);
  assert.deepEqual(trade.parseOfferForm({ geld_will: '10' }), { gives: [], gets: [], price: 1000, iPay: false });
  assert.equal(trade.parseOfferForm({ [`gib:${A}`]: '0' }).gives.length, 0);
  assert.equal(trade.parseOfferForm({ [`gib:${A}`]: '999' }).gives.length, trade.MAX_LINES + 1); // gekappt, validateOffer meldet "Höchstens"
  rejects(() => trade.parseOfferForm({ geld_gib: '5', geld_will: '5' }), /eine Richtung/);
  // Karten-IDs wie "__proto__" sind nur Text – kein Eingriff in Objekt-Prototypen (CodeQL #77, #78)
  const odd = trade.parseOfferForm(JSON.parse('{"gib:__proto__":"2","gib":["__proto__","toString"]}'));
  assert.deepEqual(odd.gives, [{ card: '__proto__' }, { card: '__proto__' }, { card: '__proto__' }, { card: 'toString' }]);
  assert.equal({}.polluted, undefined);
  rejects(() => trade.parseOfferForm({ geld_gib: 'abc' }), /Betrag/);
});

test('Gegenangebot: unveränderte Positionen behalten ihr gesperrtes Exemplar', () => {
  const prev = [{ card: A, doc: 'd1' }, { card: A, doc: 'd2' }, { card: B, copy: 'c1', doc: 'c1', foiledAt: new Date(1) }];
  const next = trade.carryLines([{ card: A }, { card: B, copy: 'c1' }, { card: B }], prev);
  assert.equal(next[0].doc, 'd1');
  assert.equal(next[1].doc, 'c1'); // dasselbe folierte Exemplar
  assert.equal(next[2].doc, null); // neue Position, wird erst belegt
  assert.equal(trade.sameLines([{ card: A, doc: 'd1' }, { card: B }], [{ card: B }, { card: A, doc: 'd1' }]), true);
  assert.equal(trade.sameLines([{ card: A }], [{ card: A }, { card: A }]), false);
});

test('Geldfluss: Verkauf zahlt der Käufer, Steuer trägt der Verkäufer', () => {
  const t = { kind: 'markt', seller: 's', price: 10000 };
  assert.deepEqual(trade.settlement(t, { buyer: 'b', taxPercent: 5 }), { payer: 'b', payee: 's', amount: 10000, tax: 500 });
  assert.deepEqual(trade.settlement(t, { buyer: 'b', taxPercent: 0 }), { payer: 'b', payee: 's', amount: 10000, tax: 0 });
});

test('Geldfluss: ohne Geld nichts, sonst je nach Richtung – auch bei der Kaufanfrage', () => {
  const base = { kind: 'tausch', seller: 's', to: 't' };
  assert.equal(trade.settlement({ ...base, price: 0, extraFrom: null }), null);
  assert.deepEqual(trade.settlement({ ...base, price: 999, extraFrom: 'seller' }, { taxPercent: 5 }), { payer: 's', payee: 't', amount: 999, tax: 49 });
  assert.deepEqual(trade.settlement({ ...base, price: 999, extraFrom: 'to' }, { taxPercent: 5 }), { payer: 't', payee: 's', amount: 999, tax: 49 });
  // Kaufanfrage: der Anbieter zahlt
  assert.deepEqual(trade.settlement({ kind: 'privat', seller: 's', to: 't', price: 1000, extraFrom: 'seller' }, { taxPercent: 10 }), { payer: 's', payee: 't', amount: 1000, tax: 100 });
});

test('Neue Geschäfte: nur von der anderen Seite abgeschlossene, seit dem letzten Besuch', () => {
  const seen = new Date('2026-03-01');
  const f = trade.newDealsFilter({ _id: 'u1', createdAt: new Date('2026-01-01'), dealsSeenAt: seen });
  assert.equal(f.status, 'verkauft');
  assert.deepEqual(f.$or, [{ seller: 'u1' }, { buyer: 'u1' }]);
  assert.deepEqual(f.closedBy, { $nin: [null, 'u1'] }); // eigene Käufe und alte Geschäfte ohne Angabe zählen nicht
  assert.equal(f.closedAt.$gt, seen);
});

test('Positionen: Kategorie, Sicht einer Rolle, Sperren und Texte', () => {
  const lines = require('../src/trade/lines');
  assert.equal(lines.kindOf({ give: L(A), want: L(B), to: 't' }), 'tausch');
  assert.equal(lines.kindOf({ give: L(A), want: [], to: 't' }), 'privat');
  assert.equal(lines.kindOf({ give: [], want: L(B), to: 't' }), 'privat'); // Kaufanfrage
  assert.equal(lines.kindOf({ give: L(A), want: [], to: null }), 'markt');
  assert.equal(lines.kindOf({ give: L(A), want: [], to: 't', listing: 'm' }), 'markt'); // Gegenangebot auf dem Markt
  assert.equal(lines.kindOf({ give: L(A), want: L(B), to: 't', listing: 'm' }), 'tausch');

  const t = { seller: 's', to: 't', give: [{ card: A, doc: 'd1' }, { card: A, doc: null }], want: [{ card: B, doc: 'd2' }], price: 500, extraFrom: 'seller', lockDocs: ['d1', 'd2'] };
  assert.deepEqual(lines.perspective(t, 'seller'), { gives: t.give, gets: t.want, pay: 500, receive: 0 });
  assert.deepEqual(lines.perspective(t, 'to'), { gives: t.want, gets: t.give, pay: 0, receive: 500 });
  assert.deepEqual(lines.lockDocsOf(t), ['d1', 'd2']);
  assert.deepEqual(lines.lockDocsOf({ ...t, listing: 'm' }), ['d2']); // die Karten des Verkäufers sperrt das Markt-Angebot
  assert.deepEqual(lines.lockedFor(t, 's'), ['d1']);
  assert.deepEqual(lines.lockedFor(t, 't'), ['d2']);
  assert.deepEqual(lines.lockedFor(t, 'x'), []);
  assert.deepEqual(lines.lockedFor({ ...t, lockDocs: undefined }, 's'), []);

  const a = catalog.cardById[A].name;
  const ra = catalog.rarityByKey[catalog.cardById[A].rarity].label;
  assert.equal(lines.lineLabel([{ card: A }, { card: A }, { card: A, foiledAt: new Date() }]), `2× ${a} (${ra}), ${a} (${ra}, foliert)`);
  assert.equal(lines.lineLabel([{ card: 'item:folie' }]), 'Folie');
  assert.equal(lines.sideText([], 0), 'nichts');
  assert.equal(lines.countText(L(A)), '1 Karte');
  assert.equal(lines.countText(L(A, B)), '2 Karten');
});

test('Migration: altes Angebot mit einer Karte wird zu Positionen', () => {
  const { migrateTradeDoc } = require('../src/trade/lines');
  const f = new Date('2026-09-01');
  const tausch = migrateTradeDoc({ kind: 'tausch', status: 'offen', card: A, cardDoc: 'd1', foiledAt: f, grade: 8, wantCard: B, wantCopy: 'c2', wantFoiledAt: f, wantGrade: 6, price: 500, extraFrom: 'seller' });
  assert.deepEqual(tausch.$set.give, [{ card: A, copy: null, doc: 'd1', foiledAt: f, grade: 8 }]);
  assert.deepEqual(tausch.$set.want, [{ card: B, copy: 'c2', doc: null, foiledAt: f, grade: 6 }]);
  assert.deepEqual(tausch.$set.lockDocs, ['d1']);
  assert.equal(tausch.$set.extraFrom, undefined); // bleibt, wie es war
  assert.equal(tausch.$unset.wantCard, 1);
  const verkauf = migrateTradeDoc({ kind: 'privat', status: 'verkauft', card: A, cardDoc: 'd1', price: 900, to: 'b', buyer: 'b' });
  assert.deepEqual(verkauf.$set.want, []);
  assert.equal(verkauf.$set.extraFrom, 'to');
  assert.equal(verkauf.$set.lockDocs, undefined); // abgeschlossen: sperrt nichts
  assert.equal(migrateTradeDoc({ give: [], want: [] }), null); // schon umgestellt (kein card mehr)
  // Tausch mit give/take aus der ersten Umsetzung von #76: nichts gesperrt, bewegte Exemplare in giveDocs/takeDocs
  const neu = migrateTradeDoc({ kind: 'tausch', status: 'offen', card: A, cardDoc: 'platzhalter', give: [{ card: A }, { card: A, copy: 'c1', foiledAt: f }], take: [{ card: B }], price: 0 });
  assert.deepEqual(neu.$set.give, [{ card: A, copy: null, doc: null, foiledAt: null, grade: null }, { card: A, copy: 'c1', doc: null, foiledAt: f, grade: null }]);
  assert.deepEqual(neu.$set.want, [{ card: B, copy: null, doc: null, foiledAt: null, grade: null }]);
  assert.equal(neu.$set.lockDocs, undefined);
  assert.equal(neu.$unset.take, 1);
  const zu = migrateTradeDoc({ kind: 'tausch', status: 'verkauft', card: A, cardDoc: 'p', give: [{ card: A }], take: [{ card: B }], giveDocs: ['g1'], takeDocs: ['t1'], to: 'b', buyer: 'b', price: 0 });
  assert.equal(zu.$set.give[0].doc, 'g1');
  assert.equal(zu.$set.want[0].doc, 't1');
});
