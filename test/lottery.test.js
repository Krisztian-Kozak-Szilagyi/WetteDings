process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { drawTime, nextDrawAfter } = require('../src/services/lotteryService');

test('Ziehung 1 Minute vor dem Lotterie-Start', () => {
  assert.equal(drawTime(), '19:59');
});

test('Nächste Ziehung (deutsche Zeit, sommer- und winterzeitsicher)', () => {
  // Sommerzeit: Runde startet 20:00 Berlin (18:00 UTC) -> Ziehung am Folgetag 19:59 Berlin (17:59 UTC)
  assert.equal(nextDrawAfter(Date.parse('2026-09-29T18:00:00Z')).toISOString(), '2026-09-30T17:59:00.000Z');
  // Erste Runde am Nachmittag: Ziehung noch am selben Tag
  assert.equal(nextDrawAfter(Date.parse('2026-09-29T13:00:00Z')).toISOString(), '2026-09-29T17:59:00.000Z');
  // Winterzeit: 20:00 Berlin = 19:00 UTC -> 19:59 Berlin = 18:59 UTC am Folgetag
  assert.equal(nextDrawAfter(Date.parse('2026-12-01T19:00:00Z')).toISOString(), '2026-12-02T18:59:00.000Z');
  // Umstellung auf Winterzeit (25.10.2026): Ziehung trotzdem um 19:59 Ortszeit
  assert.equal(nextDrawAfter(Date.parse('2026-10-24T18:00:00Z')).toISOString(), '2026-10-25T18:59:00.000Z');
  // Monatswechsel
  assert.equal(nextDrawAfter(Date.parse('2026-10-31T19:00:00Z')).toISOString(), '2026-11-01T18:59:00.000Z');
});
