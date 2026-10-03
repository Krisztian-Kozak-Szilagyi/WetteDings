process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { createLimiter } = require('../src/middleware/reauth');

test('Passwortabfrage: nach 5 Fehlversuchen 15 Minuten gesperrt', () => {
  const l = createLimiter({ max: 5, lockMs: 15 * 60 * 1000 });
  const t0 = Date.parse('2026-10-03T12:00:00Z');
  assert.deepEqual([1, 2, 3, 4].map((i) => l.fail('dev', t0 + i)), [4, 3, 2, 1]);
  assert.equal(l.lockedFor('dev', t0 + 10), 0);
  assert.equal(l.fail('dev', t0 + 10), 0); // fünfter Fehlversuch: gesperrt
  assert.equal(l.lockedFor('dev', t0 + 10), 15 * 60 * 1000);
  assert.ok(l.lockedFor('dev', t0 + 14 * 60 * 1000) > 0);
  assert.equal(l.lockedFor('dev', t0 + 16 * 60 * 1000), 0);
  // nach Ablauf der Sperre wird neu gezählt
  assert.equal(l.fail('dev', t0 + 16 * 60 * 1000), 4);
  assert.equal(l.lockedFor('other', t0), 0); // je Mitglied getrennt
});

test('Passwortabfrage: richtiges Passwort setzt die Fehlversuche zurück', () => {
  const l = createLimiter({ max: 3 });
  l.fail('dev');
  l.fail('dev');
  l.reset('dev');
  assert.equal(l.fail('dev'), 2);
});
