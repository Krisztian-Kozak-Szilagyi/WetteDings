process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { cleanReason, popupJson, popup, REASON_MIN, REASON_MAX } = require('../src/services/giftService');
const { euro } = require('../src/lib/viewHelpers');

test('Geschenk: Grund ist Pflicht, wird bereinigt und gekürzt', () => {
  for (const bad of [undefined, '', '   ', 'abc', ['Grund lang genug'], { a: 1 }]) assert.equal(cleanReason(bad), null, String(bad));
  assert.equal(REASON_MIN, 5);
  assert.equal(cleanReason('  Ausgleich \n  für   den Fehler '), 'Ausgleich für den Fehler');
  assert.equal(Array.from(cleanReason('x'.repeat(REASON_MAX + 50))).length, REASON_MAX);
});

test('Geschenk: Fenster-Daten je Art', () => {
  const base = { _id: '0123456789abcdef01234567', reason: 'Bugfix Packöffnen', byName: 'admin', left: 1 };
  const images = { pack: () => '/img/pack.webp', karte: (k) => `/img/${k}.webp`, item: () => '/img/items/folie.svg' };

  const pack = popupJson({ ...base, kind: 'pack', key: 'bfw-holdings', label: 'BfW Holdings Booster Pack', count: 3 }, { euro, images });
  assert.equal(pack.title, '3× BfW Holdings Booster Pack');
  assert.equal(pack.chip, '+3');
  assert.equal(pack.image, '/img/pack.webp');
  assert.equal(pack.reason, 'Bugfix Packöffnen');
  assert.equal(pack.byName, 'admin');

  const card = popupJson({ ...base, kind: 'karte', key: 'krisz-6-glitch', label: 'Krisz (Glitch)', count: 1 }, { euro, images });
  assert.equal(card.title, 'Krisz (Glitch)');
  assert.equal(card.image, '/img/krisz-6-glitch.webp');
  assert.equal(card.chipClass, 'is-card');

  const money = popupJson({ ...base, kind: 'geld', label: 'Spielgeld', count: 25000, left: 3 }, { euro, images });
  assert.equal(money.title, `${euro(25000)} Spielgeld`);
  assert.equal(money.chip, `+${euro(25000)}`);
  assert.equal(money.image, null);
  assert.equal(money.left, 3);

  assert.equal(popupJson(null, { euro }), null);
});

test('Geschenk: echte Bilder aus Katalog und Gegenständen', () => {
  const catalog = require('../src/tcg/catalog');
  const g = { _id: '0123456789abcdef01234567', kind: 'pack', key: catalog.DEFAULT_PACK, label: 'Pack', count: 1, reason: 'Testgrund', byName: 'admin' };
  assert.equal(popup(g).image, catalog.packTypeByKey[catalog.DEFAULT_PACK].image);
  assert.equal(popup({ ...g, kind: 'item', key: 'folie' }).image, '/img/items/folie.svg');
  assert.equal(popup({ ...g, kind: 'karte', key: 'gibt-es-nicht' }).image, null);
});
