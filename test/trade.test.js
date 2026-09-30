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
