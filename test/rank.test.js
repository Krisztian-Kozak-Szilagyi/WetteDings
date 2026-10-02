process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { top1Text } = require('../src/services/rankService');

test('Zeit auf Platz 1: Tage erst ab 24 Stunden, Stunden erst ab 60 Minuten, nichts unter einer Minute', () => {
  const MIN = 60;
  const H = 60 * MIN;
  const D = 24 * H;
  for (const none of [0, 59, undefined, null, -5, 'x']) assert.equal(top1Text(none), '');
  assert.equal(top1Text(MIN), '1 Minute');
  assert.equal(top1Text(59 * MIN + 59), '59 Minuten');
  assert.equal(top1Text(H), '1 Stunde 0 Minuten');
  assert.equal(top1Text(14 * H + 5 * MIN), '14 Stunden 5 Minuten');
  assert.equal(top1Text(23 * H + 59 * MIN), '23 Stunden 59 Minuten');
  assert.equal(top1Text(D), '1 Tag 0 Stunden 0 Minuten');
  assert.equal(top1Text(2 * D + H + MIN), '2 Tage 1 Stunde 1 Minute');
  assert.equal(top1Text(40 * D + 3 * H + 12 * MIN + 30), '40 Tage 3 Stunden 12 Minuten');
});
