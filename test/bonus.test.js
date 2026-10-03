process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { today, settings } = require('../src/services/bonusService');

test('Bonustag beginnt um 07:45 deutscher Zeit', () => {
  // Sommerzeit (UTC+2): 07:44 Berlin = 05:44 UTC -> noch Vortag
  assert.equal(today(new Date('2026-10-01T05:44:00Z')), '2026-09-30');
  assert.equal(today(new Date('2026-10-01T05:45:00Z')), '2026-10-01');
  // Winterzeit (UTC+1): 07:45 Berlin = 06:45 UTC
  assert.equal(today(new Date('2026-12-01T06:44:00Z')), '2026-11-30');
  assert.equal(today(new Date('2026-12-01T06:45:00Z')), '2026-12-01');
  // Monats-/Jahreswechsel vor 07:45
  assert.equal(today(new Date('2027-01-01T05:00:00Z')), '2026-12-31');
  assert.equal(today(new Date('2026-03-01T05:00:00Z')), '2026-02-28');
});

test('Tagesbonus: 100 € für alle als Standard', () => {
  assert.equal(settings.amount, 10000);
});
