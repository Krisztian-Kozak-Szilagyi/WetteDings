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
  assert.deepEqual(foil.DEFAULTS, { gradingChance: 100, bonusPercent: 10, dailyPercent: 0.9, sleevePrice: 1500, slabPrice: 4000, slabDropPercent: 30 });
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

test('#204: Wertsteigerung nur im Slab – eine Folie (Schutzhülle) steigert den Wert nicht', () => {
  const s = { bonusPercent: 10, dailyPercent: 0.9 };
  const at = new Date(NOW - DAY);
  assert.equal(foil.growthFrom({ foiledAt: at, slab: null }), null);
  assert.equal(foil.growthFrom({ foiledAt: null, slab: null }), null);
  assert.equal(foil.growthFrom(null), null);
  assert.equal(foil.growthFrom({ foiledAt: at, slab: { code: 'BfW', grade: 9 } }), at);
  assert.equal(foil.growthFrom({ foiledAt: at, slab: { code: 'TST', grade: 10 } }), null); // Slab aus einem Spieler-Shop: Wert macht der Markt
  assert.equal(foil.cardValue(15000, foil.growthFrom({ foiledAt: at, slab: null }), NOW, s), 15000);
  assert.equal(foil.cardValue(15000, foil.growthFrom({ foiledAt: at, slab: { code: 'BfW', grade: 9 } }), NOW, s), 16635);
});

test('Folie: Ranglisten-Ausdruck rechnet mit den aktuellen Einstellungen', () => {
  const expr = JSON.stringify(foil.factorExpr());
  assert.ok(expr.includes('$$NOW') && expr.includes('$foiledAt') && expr.includes('$slab.code') && expr.includes('"BfW"'));
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

test('Gegenstände im Handel: "item:folie" – wie Karten, auch im Tausch', () => {
  const { itemByCardId, itemCardId, itemCard } = require('../src/items/itemService');
  const { validateOffer } = require('../src/trade/tradeService');
  const catalog = require('../src/tcg/catalog');
  assert.equal(itemByCardId(itemCardId('folie')).key, 'folie');
  assert.equal(itemByCardId('item:gibtsnicht'), null);
  assert.equal(itemByCardId('folie'), null);
  const c = itemCard(itemByCardId('item:folie'));
  assert.equal(c.isItem, true);
  assert.equal(c.sell, 1000); // die Bank zahlt 10 € pro Folie
  assert.deepEqual(validateOffer({ listing: true, give: [{ card: 'item:folie' }], price: 500, extraFrom: 'to' }), { extraFrom: 'to' });
  assert.throws(() => validateOffer({ listing: true, give: [{ card: 'item:gibtsnicht' }], price: 500 }), /gibt es nicht/);
  const card = catalog.CARDS[0].id;
  assert.deepEqual(validateOffer({ give: [{ card: 'item:folie' }, { card: 'item:folie' }], want: [{ card }], price: 0 }), { extraFrom: null });
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
  for (const s of ['admin', 'grading', 'dungeon', 'handel', 'lotto', 'kampf', 'bank', 'folieren', 'blackmarket']) assert.ok(SOURCES.includes(s));
});

test('Gegenstände: Wegnehmen nur in einer Transaktion, unbekannte Quelle ist ein Programmfehler', async () => {
  const { takeItems, addItems } = require('../src/items/itemService');
  await assert.rejects(takeItems({ userId: null, type: 'folie', source: 'bank' }), /Transaktion/);
  await assert.rejects(addItems({ userIds: [], type: 'folie', source: 'irgendwo' }), /Quelle/);
  await assert.rejects(addItems({ userIds: [], type: 'gibtsnicht', source: 'admin' }), /gibt es nicht/);
  await assert.rejects(addItems({ userIds: [], type: 'folie', count: 0, source: 'admin' }), /Anzahl/);
});

test('Sleeve und leerer Slab: beide handelbar, Shop-Preis nie unter dem Ankauf (kein Geld drucken)', () => {
  const { ITEM_TYPES, validateTypes, itemTypeByKey } = require('../src/items/types');
  const { itemByCardId, itemCardId, buyPrice } = require('../src/items/itemService');
  assert.equal(itemTypeByKey.folie.label, 'TCG Sleeve');
  assert.equal(itemTypeByKey.slab.label, 'Leerer Slab');
  assert.equal(itemTypeByKey.slab.category, 'material');
  for (const t of ITEM_TYPES) {
    assert.equal(t.storage, 'stueck');
    assert.ok(t.tradable, t.key);
    assert.ok(t.buy >= t.sell, `${t.key}: Shop-Preis ≥ Ankauf`);
    assert.equal(itemByCardId(itemCardId(t.key)).key, t.key); // im Handel wie eine Karte
  }
  assert.throws(() => validateTypes([{ ...itemTypeByKey.slab, buy: itemTypeByKey.slab.sell - 1 }]), /Geld drucken/);
  assert.throws(() => validateTypes([{ ...itemTypeByKey.slab, via: 'markt' }]), /via/);
  // Wo man kauft: Sleeve im Bank-Shop (Inventar), leerer Slab nur in der Werkstatt eines Grading-Shops
  assert.equal(itemTypeByKey.folie.via, 'bank');
  assert.equal(itemTypeByKey.slab.via, 'grading');
  assert.equal(buyPrice(itemTypeByKey.folie), foil.settings.sleevePrice);
  assert.equal(buyPrice(itemTypeByKey.slab), foil.settings.slabPrice);
  assert.ok(foil.validPrice('slab', itemTypeByKey.slab.sell));
  assert.ok(!foil.validPrice('slab', itemTypeByKey.slab.sell - 1));
  assert.ok(!foil.validPrice('folie', 1500.5));
  assert.ok(!foil.validPrice('folie', null));
});

test('Dungeon/Turm: Funde teilen sich in Sleeves und leere Slabs nach dem eingestellten Anteil', () => {
  const { splitFoilDrops } = require('../src/items/itemService');
  const users = ['a', 'b', 'c', 'd'];
  const rolls = [10, 29.99, 30, 99.99]; // unter 30 % → Slab
  let i = 0;
  const out = splitFoilDrops(users, 30, () => rolls[i++]);
  assert.deepEqual(out, { slabs: ['a', 'b'], sleeves: ['c', 'd'] });
  assert.deepEqual(splitFoilDrops(users, 0, () => 0), { sleeves: users, slabs: [] }); // 0 % → nur Sleeves
  assert.deepEqual(splitFoilDrops(users, 100, () => 99.99), { sleeves: [], slabs: users }); // 100 % → nur Slabs
  assert.deepEqual(splitFoilDrops([], 30), { sleeves: [], slabs: [] });
});

test('Kaufen: jede Sorte nur an ihrem Ort, ohne Datenbankzugriff abgelehnt', async () => {
  const { buyItems } = require('../src/items/itemService');
  const user = { _id: '000000000000000000000001' };
  await assert.rejects(buyItems({ user, type: 'slab', via: 'bank' }), /nicht im Bank-Shop/); // Slabs gibt es nur in der Werkstatt
  await assert.rejects(buyItems({ user, type: 'folie', via: 'grading' }), /nicht in der Werkstatt/);
  await assert.rejects(buyItems({ user, type: 'gibtsnicht' }), /gibt es nicht/);
  await assert.rejects(buyItems({ user, type: 'folie', count: 0 }), /1 bis/);
  await assert.rejects(buyItems({ user, type: 'folie', count: 101 }), /1 bis/);
});
