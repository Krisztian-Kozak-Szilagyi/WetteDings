process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const foil = require('../src/items/foil');
const { ITEM_TYPES, rollGradingFoil } = require('../src/items/itemService');
const { keepsFlash } = require('../src/middleware');

const DAY = 864e5;
const NOW = Date.UTC(2026, 9, 4, 12);

test('Folie: Standardwerte – 1 % Fundchance, +10 % sofort, +0,9 % pro Tag', () => {
  assert.deepEqual(foil.DEFAULTS, { gradingChance: 100, bonusPercent: 10, dailyPercent: 0.9 });
  assert.ok(ITEM_TYPES.some((t) => t.key === 'folie'));
});

test('Folie: Wert steigt linear mit vollen Tagen', () => {
  const s = { bonusPercent: 10, dailyPercent: 0.9 };
  assert.equal(foil.cardValue(15000, null, NOW, s), 15000); // ohne Folie: Verkaufswert
  assert.equal(foil.cardValue(15000, new Date(NOW), NOW, s), 16500); // am ersten Tag +10 %
  assert.equal(foil.cardValue(15000, new Date(NOW - DAY + 1000), NOW, s), 16500); // noch kein voller Tag
  assert.equal(foil.cardValue(15000, new Date(NOW - DAY), NOW, s), 16635); // +10,9 %
  assert.equal(foil.cardValue(15000, new Date(NOW - 100 * DAY), NOW, s), 30000); // +100 %
  assert.equal(foil.foilDays(new Date(NOW + DAY), NOW), 0); // Uhrzeit-Abweichung: nie negativ
  assert.equal(foil.foilPercent(null, NOW, s), 0);
});

test('Folie: Ranglisten-Ausdruck rechnet mit den aktuellen Einstellungen', () => {
  const expr = JSON.stringify(foil.factorExpr());
  assert.ok(expr.includes('$$NOW') && expr.includes('$foiledAt'));
  assert.ok(expr.includes(`${foil.settings.bonusPercent}`) && expr.includes(`${foil.settings.dailyPercent}`));
});

test('Grading: ohne Glück keine Folie (und kein Datenbankzugriff)', async () => {
  assert.equal(await rollGradingFoil({ userId: null, roll: () => foil.settings.gradingChance }), false);
  assert.equal(await rollGradingFoil({ userId: null, roll: () => 9999 }), false);
});

test('Erfolgsmeldungen nur bei Admin- und Moderationsaktionen', () => {
  assert.equal(keepsFlash('success', '/tcg/kaufen'), false);
  assert.equal(keepsFlash('success', '/handel/angebot'), false);
  assert.equal(keepsFlash('success', '/administrator'), false);
  assert.equal(keepsFlash('success', '/admin/bonus'), true);
  assert.equal(keepsFlash('success', '/admin'), true);
  assert.equal(keepsFlash('success', '/forum/bereiche/abc'), true);
  assert.equal(keepsFlash('success', '/forum/t/abc/verschieben'), true);
  assert.equal(keepsFlash('success', '/forum/t/abc/antwort'), false);
  assert.equal(keepsFlash('error', '/tcg/kaufen'), true);
  assert.equal(keepsFlash('info', '/login'), true);
});

test('Gegenstände im Handel: "item:folie", nur gegen Geld, nicht im Tausch', () => {
  const { itemByCardId, itemCardId, itemCard } = require('../src/items/itemService');
  const { validateOffer } = require('../src/trade/tradeService');
  const catalog = require('../src/tcg/catalog');
  assert.equal(itemByCardId(itemCardId('folie')).key, 'folie');
  assert.equal(itemByCardId('item:gibtsnicht'), null);
  assert.equal(itemByCardId('folie'), null);
  const c = itemCard(itemByCardId('item:folie'));
  assert.equal(c.isItem, true);
  assert.equal(c.sell, 1000); // die Bank zahlt 10 € pro Folie
  assert.deepEqual(validateOffer({ kind: 'markt', price: 500, cardId: 'item:folie' }), { extraFrom: null });
  assert.throws(() => validateOffer({ kind: 'markt', price: 500, cardId: 'item:gibtsnicht' }), /Karte/);
  const card = catalog.CARDS[0].id;
  assert.throws(() => validateOffer({ kind: 'tausch', price: 0, cardId: 'item:folie', wantCardId: card }), /nicht tauschen/);
  assert.throws(() => validateOffer({ kind: 'tausch', price: 0, cardId: card, wantCardId: 'item:folie' }), /nicht tauschen/);
});

test('Gegenstands-Arten: Liste ist gültig, Fehler fallen beim Laden auf', () => {
  const { ITEM_TYPES, validateTypes, itemType, SOURCES } = require('../src/items/types');
  assert.equal(validateTypes(ITEM_TYPES), true);
  const ok = { key: 'tuch', label: 'Tuch', category: 'material', storage: 'stapel', sell: 0 };
  assert.equal(validateTypes([ok]), true);
  assert.throws(() => validateTypes([ok, ok]), /doppelt/);
  assert.throws(() => validateTypes([{ ...ok, key: 'Tuch!' }]), /Schlüssel/);
  assert.throws(() => validateTypes([{ ...ok, category: 'xyz' }]), /Kategorie/);
  assert.throws(() => validateTypes([{ ...ok, storage: 'sack' }]), /storage/);
  assert.throws(() => validateTypes([{ ...ok, tradable: true }]), /Handel/); // Stapel sind (noch) nicht handelbar
  assert.throws(() => validateTypes([{ ...ok, sell: 1.5 }]), /Cent/);
  assert.equal(itemType('folie').storage, 'stueck');
  assert.equal(itemType('__proto__'), null);
  for (const s of ['admin', 'grading', 'dungeon', 'handel', 'lotto', 'kampf', 'bank', 'folieren']) assert.ok(SOURCES.includes(s));
});

test('Gegenstände: Wegnehmen nur in einer Transaktion, unbekannte Quelle ist ein Programmfehler', async () => {
  const { takeItems, addItems } = require('../src/items/itemService');
  await assert.rejects(takeItems({ userId: null, type: 'folie', source: 'bank' }), /Transaktion/);
  await assert.rejects(addItems({ userIds: [], type: 'folie', source: 'irgendwo' }), /Quelle/);
  await assert.rejects(addItems({ userIds: [], type: 'gibtsnicht', source: 'admin' }), /gibt es nicht/);
  await assert.rejects(addItems({ userIds: [], type: 'folie', count: 0, source: 'admin' }), /Anzahl/);
});
