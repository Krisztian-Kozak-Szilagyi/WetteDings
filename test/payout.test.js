const test = require('node:test');
const assert = require('node:assert');
const { computePayouts, quote } = require('../src/lib/payout');
const { parseEuro } = require('../src/lib/util');

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

test('Beispiel aus den Regeln', () => {
  const positions = [
    { id: 'anna', side: 'ja', amount: 10000 },
    { id: 'ben', side: 'ja', amount: 5000 },
    { id: 'clara', side: 'nein', amount: 15000 },
  ];
  const { payouts, refunded } = computePayouts(positions, 'ja');
  assert.equal(refunded, false);
  assert.equal(payouts.get('anna'), 20000);
  assert.equal(payouts.get('ben'), 10000);
  assert.equal(payouts.get('clara'), 0);
  assert.equal(sum(payouts), 30000);
});

test('Rundungscents gehen nicht verloren', () => {
  const positions = [
    { id: 'a', side: 'nein', amount: 100 },
    { id: 'b', side: 'nein', amount: 100 },
    { id: 'c', side: 'nein', amount: 100 },
    { id: 'x', side: 'ja', amount: 100 },
  ];
  const { payouts } = computePayouts(positions, 'nein');
  assert.equal(sum(payouts), 400);
  assert.deepEqual([payouts.get('a'), payouts.get('b'), payouts.get('c')], [134, 133, 133]);
});

test('Ohne Gegenseite: alle bekommen ihren Einsatz zurück', () => {
  const positions = [
    { id: 'a', side: 'ja', amount: 500 },
    { id: 'b', side: 'ja', amount: 300 },
  ];
  for (const outcome of ['ja', 'nein', 'annulliert']) {
    const { payouts, refunded } = computePayouts(positions, outcome);
    assert.equal(refunded, true);
    assert.equal(payouts.get('a'), 500);
    assert.equal(payouts.get('b'), 300);
  }
});

test('Zufallstest: Summe der Auszahlungen = Topf', () => {
  for (let run = 0; run < 500; run++) {
    const positions = Array.from({ length: 2 + Math.floor(Math.random() * 30) }, (_, i) => ({
      id: String(i),
      side: Math.random() < 0.5 ? 'ja' : 'nein',
      amount: 1 + Math.floor(Math.random() * 1e8),
    }));
    const pot = positions.reduce((s, p) => s + p.amount, 0);
    const { payouts } = computePayouts(positions, Math.random() < 0.5 ? 'ja' : 'nein');
    assert.equal(sum(payouts), pot);
    for (const v of payouts.values()) assert.ok(Number.isInteger(v) && v >= 0);
  }
});

test('Quote', () => {
  assert.equal(quote(100, 150), 2.5);
  assert.equal(quote(0, 150), null);
});

test('Euro-Eingaben', () => {
  assert.equal(parseEuro('10'), 1000);
  assert.equal(parseEuro('12,5'), 1250);
  assert.equal(parseEuro('12.50'), 1250);
  assert.equal(parseEuro('1.000'), 100000);
  assert.equal(parseEuro('1.000,99'), 100099);
  assert.equal(parseEuro('-5'), null);
  assert.equal(parseEuro('abc'), null);
  assert.equal(parseEuro('1,234'), null);
});
