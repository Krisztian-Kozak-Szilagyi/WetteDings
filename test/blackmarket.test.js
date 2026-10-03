process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const bm = require('../src/tcg/blackMarket');
const catalog = require('../src/tcg/catalog');

test('Black Market: Chancen 62/30/6/2 – Gold und Holo zusammen 92 %', () => {
  assert.equal(bm.ODDS.reduce((s, o) => s + o.percent, 0), 100);
  const count = {};
  for (let roll = 0; roll < 100; roll++) count[bm.rarityForRoll(roll)] = (count[bm.rarityForRoll(roll)] || 0) + 1;
  assert.deepEqual(count, { gold: 62, holo: 30, bockhaber: 6, glitch: 2 });
});

test('Black Market: vier verschiedene Karten von Gold bis Glitch, Preis 170 % des Verkaufspreises', () => {
  const allowed = new Set(['gold', 'holo', 'bockhaber', 'glitch']);
  for (let n = 0; n < 300; n++) {
    const offers = bm.drawOffers();
    assert.equal(offers.length, 4);
    assert.equal(new Set(offers.map((o) => o.card)).size, 4, 'keine Karte doppelt');
    for (const o of offers) {
      assert.ok(allowed.has(o.rarity), o.rarity);
      assert.equal(catalog.cardById[o.card].rarity, o.rarity);
      assert.equal(o.price, Math.round(catalog.rarityByKey[o.rarity].sell * 1.7));
    }
  }
  assert.equal(bm.priceFor('gold'), Math.round(catalog.rarityByKey.gold.sell * 1.7));
});

test('Black Market: geöffnet täglich 16:30 bis 19:00 deutscher Zeit (auch bei Sommerzeit)', () => {
  const berlin = (iso) => new Date(iso).getTime();
  // Oktober = Sommerzeit (UTC+2): 16:30 Berlin = 14:30 UTC
  assert.equal(bm.windowAt(berlin('2026-10-03T14:29:59Z')).open, false);
  assert.equal(bm.windowAt(berlin('2026-10-03T14:30:00Z')).open, true);
  assert.equal(bm.windowAt(berlin('2026-10-03T16:59:59Z')).open, true);
  const after = bm.windowAt(berlin('2026-10-03T17:00:00Z'));
  assert.equal(after.open, false);
  assert.equal(after.opensAt.toISOString(), '2026-10-04T14:30:00.000Z', 'nach Schluss: nächste Öffnung am Folgetag');
  const before = bm.windowAt(berlin('2026-10-03T08:00:00Z'));
  assert.equal(before.opensAt.toISOString(), '2026-10-03T14:30:00.000Z', 'vormittags: Öffnung am selben Tag');
  // Dezember = Winterzeit (UTC+1): 16:30 Berlin = 15:30 UTC
  assert.equal(bm.windowAt(berlin('2026-12-01T15:29:00Z')).open, false);
  const w = bm.windowAt(berlin('2026-12-01T15:30:00Z'));
  assert.equal(w.open, true);
  assert.equal(w.day, '2026-12-01');
  assert.equal(w.closesAt.toISOString(), '2026-12-01T18:00:00.000Z');
});
