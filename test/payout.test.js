const test = require('node:test');
const assert = require('node:assert');
const { computePayouts, quote } = require('../src/lib/payout');
const { parseEuro } = require('../src/lib/util');

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

test('Ohne Provision: Beispiel Ja/Nein', () => {
  const positions = [
    { id: 'anna', side: 'ja', amount: 10000 },
    { id: 'ben', side: 'ja', amount: 5000 },
    { id: 'clara', side: 'nein', amount: 15000 },
  ];
  const { payouts, refunded, fee } = computePayouts(positions, 'ja');
  assert.equal(refunded, false);
  assert.equal(fee, 0);
  assert.equal(payouts.get('anna'), 20000);
  assert.equal(payouts.get('ben'), 10000);
  assert.equal(payouts.get('clara'), 0);
});

test('10 % Provision: Beispiel aus den Regeln', () => {
  const positions = [
    { id: 'anna', side: 'o1', amount: 10000 },
    { id: 'ben', side: 'o1', amount: 5000 },
    { id: 'clara', side: 'o2', amount: 6000 },
    { id: 'david', side: 'o3', amount: 9000 },
  ];
  const { payouts, refunded, fee } = computePayouts(positions, 'o1', 10);
  assert.equal(refunded, false);
  assert.equal(fee, 3000); // 10 % von 300 €
  assert.equal(payouts.get('anna'), 18000); // ⅔ von 270 €
  assert.equal(payouts.get('ben'), 9000); // ⅓ von 270 €
  assert.equal(payouts.get('clara'), 0);
  assert.equal(payouts.get('david'), 0);
  assert.equal(sum(payouts) + fee, 30000);
});

test('Keine Provision bei Erstattung', () => {
  const positions = [
    { id: 'a', side: 'o1', amount: 500 },
    { id: 'b', side: 'o1', amount: 300 },
  ];
  for (const outcome of ['o1', 'o2', 'annulliert']) {
    const { payouts, refunded, fee } = computePayouts(positions, outcome, 10);
    assert.equal(refunded, true);
    assert.equal(fee, 0);
    assert.equal(payouts.get('a'), 500);
    assert.equal(payouts.get('b'), 300);
  }
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

test('Zufallstest: Auszahlungen + Provision = Topf', () => {
  for (let run = 0; run < 500; run++) {
    const positions = Array.from({ length: 2 + Math.floor(Math.random() * 30) }, (_, i) => ({
      id: String(i),
      side: `o${1 + Math.floor(Math.random() * 4)}`,
      amount: 1 + Math.floor(Math.random() * 1e8),
    }));
    const pot = positions.reduce((s, p) => s + p.amount, 0);
    const feePercent = run % 2 ? 10 : 0;
    const { payouts, fee } = computePayouts(positions, `o${1 + Math.floor(Math.random() * 4)}`, feePercent);
    assert.equal(sum(payouts) + fee, pot);
    for (const v of payouts.values()) assert.ok(Number.isInteger(v) && v >= 0);
  }
});

test('Quote', () => {
  assert.equal(quote(100, 150), 2.5);
  assert.equal(quote(100, 150, 10), 2.25);
  assert.equal(quote(100, 0, 10), 1);
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
