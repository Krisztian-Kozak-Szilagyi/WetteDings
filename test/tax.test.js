process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const tax = require('../src/services/taxService');
const trade = require('../src/trade/tradeService');

test('Steuern: fünf Bereiche, standardmäßig 0 %', () => {
  assert.deepEqual(tax.KEYS, ['markt', 'privat', 'tausch', 'coin', 'etf']);
  for (const k of tax.KEYS) assert.equal(tax.rate(k), 0);
  assert.equal(tax.rate('unbekannt'), 0);
});

test('Steuern: Gewinnsteuer im Broker nur auf den Gewinn, abgerundet', () => {
  assert.equal(tax.gainTax(15000, 10000, 10), 500); // 50 € Gewinn -> 5 €
  assert.equal(tax.gainTax(9000, 10000, 10), 0); // Verlust -> keine Steuer
  assert.equal(tax.gainTax(10000, 10000, 10), 0);
  assert.equal(tax.gainTax(10999, 10000, 10), 99); // 99,9 Cent -> abgerundet
  assert.equal(tax.gainTax(20000, 10000, 0), 0);
});

test('Steuern: Admin-Eingabe wird geprüft und gerundet', () => {
  const ok = tax.parseRates({ markt: '5', privat: '2,55', tausch: '0', coin: '12.5', etf: ' 50 ' });
  assert.deepEqual(ok, { rates: { markt: 5, privat: 2.6, tausch: 0, coin: 12.5, etf: 50 } });
  assert.match(tax.parseRates({ markt: '5', privat: '5', tausch: '5', coin: '51', etf: '0' }).error, /Coins/);
  assert.match(tax.parseRates({ markt: '', privat: '5', tausch: '5', coin: '5', etf: '5' }).error, /Markt/);
  assert.match(tax.parseRates({ markt: '5', privat: '5', tausch: '5', coin: '5' }).error, /ETFs/);
  assert.match(tax.parseRates({ markt: '-1', privat: '5', tausch: '5', coin: '5', etf: '5' }).error, /Markt/);
});

test('Steuern: Handel nimmt den Satz der jeweiligen Angebotsart', () => {
  const saved = { ...tax.rates };
  Object.assign(tax.rates, { markt: 5, privat: 10, tausch: 20 });
  try {
    assert.equal(trade.settlement({ kind: 'markt', seller: 's', price: 10000 }, { buyer: 'b' }).tax, 500);
    assert.equal(trade.settlement({ kind: 'privat', seller: 's', to: 'b', price: 10000 }, { buyer: 'b' }).tax, 1000);
    assert.equal(trade.settlement({ kind: 'tausch', seller: 's', to: 't', price: 10000, extraFrom: 'to' }).tax, 2000);
    assert.equal(trade.taxOf(10000, 'privat'), 1000);
    assert.deepEqual(trade.taxRates(), { markt: 5, privat: 10, tausch: 20 });
  } finally {
    Object.assign(tax.rates, saved);
  }
});
