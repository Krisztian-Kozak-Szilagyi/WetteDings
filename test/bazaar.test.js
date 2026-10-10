process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const bazaar = require('../src/esports/bazaar');
const catalog = require('../src/tcg/catalog');
const L = require('../src/dungeon/liveTower');

test('Bazaar: Pool = genau das, was im eSports-Live-Turm nutzbar ist, alles im Katalog', () => {
  assert.deepStrictEqual([...bazaar.POOL].sort(), [...Object.keys(L.COFFEE), L.ENERGY_CARD].sort());
  assert.strictEqual(bazaar.poolCards().length, bazaar.POOL.length);
});

test('Bazaar: Preis = 150 % des Bank-Verkaufspreises', () => {
  for (const c of bazaar.poolCards()) assert.strictEqual(bazaar.priceFor(c.rarity), Math.round(catalog.rarityByKey[c.rarity].sell * 1.5));
});

test('Bazaar: vier Plätze, jeder unabhängig gewürfelt – Wiederholungen erlaubt', () => {
  const same = bazaar.drawOffers(() => 3);
  assert.strictEqual(same.length, bazaar.OFFER_COUNT);
  assert.ok(same.every((o) => o.card === 'bfw-energy-gold' && o.price === bazaar.priceFor(o.rarity)));
  let k = 0;
  const mixed = bazaar.drawOffers((n) => k++ % n);
  assert.deepStrictEqual(mixed.map((o) => o.card), bazaar.POOL);
  assert.deepStrictEqual(bazaar.drawOffers(() => 0, []), []);
});
