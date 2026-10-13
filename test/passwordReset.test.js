const test = require('node:test');
const assert = require('node:assert');
const pr = require('../src/services/passwordReset');

test('Code: 12 Zeichen ohne verwechselbare Zeichen', () => {
  for (let i = 0; i < 50; i++) {
    const code = pr.makeCode();
    assert.strictEqual(code.length, pr.CODE_LENGTH);
    assert.match(code, /^[A-HJKMNP-Z2-9]+$/);
  }
  assert.strictEqual(pr.makeCode(() => 0), 'AAAAAAAAAAAA');
});

test('Code: Schreibweise egal, Format mit Bindestrichen', () => {
  assert.strictEqual(pr.formatCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
  assert.strictEqual(pr.normalizeCode(' abcd-efgh jkmn '), 'ABCDEFGHJKMN');
  assert.ok(pr.looksLikeCode('abcd-efgh-jkmn'));
  assert.ok(!pr.looksLikeCode('passwort123'));
});

test('Code gilt nur, solange er nicht abgelaufen ist', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  assert.ok(pr.hasValidCode({ resetHash: 'x', resetExpires: new Date('2026-10-09T11:00:00Z') }, now));
  assert.ok(!pr.hasValidCode({ resetHash: 'x', resetExpires: new Date('2026-10-08T11:00:00Z') }, now));
  assert.ok(!pr.hasValidCode({ resetHash: null, resetExpires: new Date('2026-10-09T11:00:00Z') }, now));
  assert.ok(!pr.hasValidCode(null, now));
});

test('Ohne neues Passwort nur die Passwort-Seite und Abmelden', () => {
  assert.ok(pr.allowedWhileForced('/passwort-neu'));
  assert.ok(pr.allowedWhileForced('/abmelden'));
  assert.ok(!pr.allowedWhileForced('/'));
  assert.ok(!pr.allowedWhileForced('/konto/passwort'));
});
