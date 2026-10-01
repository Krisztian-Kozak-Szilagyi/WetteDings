process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const trade = require('../src/trade/tradeService');

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
