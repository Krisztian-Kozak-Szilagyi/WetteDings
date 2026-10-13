process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validSlogan, SHOP_SLOGAN_MAX } = require('../src/grading/gradingService');
const { TIP_STEPS } = require('../src/grading/orderService');

test('Shop-Slogan: Leerraum geglättet, leer = kein Slogan, zu lang wird abgelehnt', () => {
  assert.equal(validSlogan('  Jede   Karte\tverdient  mehr '), 'Jede Karte verdient mehr');
  assert.equal(validSlogan('   '), null);
  assert.equal(validSlogan(undefined), null);
  assert.throws(() => validSlogan('x'.repeat(SHOP_SLOGAN_MAX + 1)), /höchstens/);
  assert.equal(validSlogan('x'.repeat(SHOP_SLOGAN_MAX)).length, SHOP_SLOGAN_MAX);
});

test('Trinkgeld: feste Stufen, aufsteigend', () => {
  assert.deepEqual([...TIP_STEPS].sort((a, b) => a - b), TIP_STEPS);
  assert.ok(TIP_STEPS.every((c) => Number.isInteger(c) && c > 0));
});
