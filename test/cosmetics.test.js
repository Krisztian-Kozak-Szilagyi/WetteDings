process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const catalog = require('../src/cosmetics/catalog');
const logic = require('../src/cosmetics/logic');
const avatars = require('../src/profile/avatars');
const { find, rewardOf, REWARD } = require('../src/achievements/list');
const tcgCatalog = require('../src/tcg/catalog');

test('Kosmetik: jeder Avatar hat eine Datei, eindeutige Schlüssel, Startpreis und keinen Effekt', () => {
  const keys = catalog.AVATARS.map((a) => a.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  assert.strictEqual(catalog.AVATARS.length, 22);
  for (const a of catalog.AVATARS) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', a.url)), a.url);
    assert.ok(logic.validPrice(a.price) && a.price > 0, a.key);
    assert.strictEqual(a.effect, '');
    // kein Zusammenstoß mit den Logos des Teams
    assert.ok(!avatars.has(a.key));
    assert.strictEqual(avatars.urlOf(a.key), a.url);
  }
});

test('Kosmetik: nur Einträge aus der festen Liste', () => {
  assert.ok(catalog.findItem('avatar', 'anna'));
  ['constructor', '__proto__', 'toString', '', null, ['anna']].forEach((k) => assert.strictEqual(catalog.findItem('avatar', k), null));
  assert.strictEqual(catalog.findItem('banner', 'anna'), null);
  assert.strictEqual(catalog.findEffect('glitch').key, 'glitch');
  assert.strictEqual(catalog.findEffect('constructor'), null);
});

test('Konfetti: Bankwert in ganzen Euro, auch Boss-Karten, nichts für wertlose Karten', () => {
  assert.strictEqual(logic.konfettiFor(300), 3);
  assert.strictEqual(logic.konfettiFor(1399), 13);
  assert.strictEqual(logic.konfettiFor(tcgCatalog.rarityByKey.boss.sell), Math.floor(tcgCatalog.rarityByKey.boss.sell / 100));
  [0, -100, 99, NaN, undefined, '500'].forEach((v) => assert.strictEqual(logic.konfettiFor(v), 0));
});

test('Kosmetik: Admin-Werte gelten nur, wenn sie gültig sind', () => {
  const base = catalog.findItem('avatar', 'goblin');
  assert.deepStrictEqual(logic.withSettings(base, undefined), base);
  const set = logic.withSettings(base, { price: 40, effect: 'gold', name: '  Grüner   Goblin ' });
  assert.strictEqual(set.price, 40);
  assert.strictEqual(set.effect, 'gold');
  assert.strictEqual(set.name, 'Grüner Goblin');
  const bad = logic.withSettings(base, { price: -1, effect: 'boom', name: '   ' });
  assert.strictEqual(bad.price, base.price);
  assert.strictEqual(bad.effect, '');
  assert.strictEqual(bad.name, base.name);
  assert.strictEqual(logic.withSettings(base, { price: 0 }).price, 0);
  assert.ok(!logic.validPrice(logic.MAX_PRICE + 1) && !logic.validPrice(1.5));
});

test('Kosmetik: Währungsname', () => {
  ['Konfetti', 'Kartenstaub', 'Papier-Fetzen', 'Ö2'].forEach((n) => assert.ok(logic.validCurrencyName(n), n));
  ['', 'K', ' ', '<b>x</b>', 'x'.repeat(21), '-Konfetti', null].forEach((n) => assert.ok(!logic.validCurrencyName(n), String(n)));
});

test('Kosmetik: Besitz zählt nur echte Shop-Avatare', () => {
  const owned = ['avatar:anna', 'avatar:goblin', 'avatar:gibt-es-nicht', 'banner:anna'];
  assert.ok(logic.ownsAvatar(owned, 'anna'));
  assert.ok(!logic.ownsAvatar(owned, 'sushi'));
  assert.ok(!logic.ownsAvatar(undefined, 'anna'));
  assert.strictEqual(logic.ownedAvatarCount(owned), 2);
});

test('Erfolge: Kosmetik-Erfolge, „Die ganze Galerie“ bringt 500 €', () => {
  ['erster-avatar', 'avatar-sammler', 'avatar-galerie', 'schredder'].forEach((k) => assert.ok(find(k), k));
  assert.strictEqual(rewardOf(find('avatar-galerie')), 50000);
  assert.strictEqual(rewardOf(find('schredder')), REWARD);
});
