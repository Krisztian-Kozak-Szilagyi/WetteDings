process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const dm = require('../src/services/devMessageService');
const { UserError } = require('../src/lib/util');

const now = new Date('2026-10-08T12:00:00Z');

test('Pop-up: Titel einzeilig, Text behält Zeilenumbrüche (höchstens eine Leerzeile)', () => {
  assert.equal(dm.cleanTitle('  Wartung\n am   Samstag '), 'Wartung am Samstag');
  assert.equal(dm.cleanText('  Hallo   zusammen \r\n\r\n\r\n\nZeile  2\n'), 'Hallo zusammen\n\nZeile 2');
  assert.equal(dm.cleanTitle(undefined), '');
  assert.equal(dm.cleanText(42), '');
});

test('Pop-up: Prüfung von Titel, Text und Ablaufdatum', () => {
  const ok = dm.validate({ title: ' Hallo ', text: 'Ein Text.' }, now);
  assert.deepEqual(ok, { title: 'Hallo', text: 'Ein Text.', expiresAt: null });
  assert.throws(() => dm.validate({ title: ' ', text: 'Ein Text.' }, now), UserError);
  assert.throws(() => dm.validate({ title: 'x'.repeat(dm.TITLE_MAX + 1), text: 'Ein Text.' }, now), UserError);
  assert.throws(() => dm.validate({ title: 'Hallo', text: 'kurz'.slice(0, dm.TEXT_MIN - 1) }, now), UserError);
  assert.throws(() => dm.validate({ title: 'Hallo', text: 'x'.repeat(dm.TEXT_MAX + 1) }, now), UserError);
  // Ablaufdatum: gültig und in der Zukunft
  const later = new Date(now.getTime() + 3600000);
  assert.equal(dm.validate({ title: 'Hallo', text: 'Ein Text.', expiresAt: later }, now).expiresAt, later);
  assert.throws(() => dm.validate({ title: 'Hallo', text: 'Ein Text.', expiresAt: new Date(now.getTime() - 1000) }, now), UserError);
  assert.throws(() => dm.validate({ title: 'Hallo', text: 'Ein Text.', expiresAt: new Date(NaN) }, now), UserError);
});

test('Pop-up: Emojis zählen als ein Zeichen', () => {
  const title = '🎉'.repeat(dm.TITLE_MAX);
  assert.equal(dm.validate({ title, text: 'Ein Text.' }, now).title, title);
});

test('Pop-up: aktiv bis beendet bzw. bis zum Ablauf, ohne Ablauf bis gelesen', () => {
  assert.equal(dm.isActive({ endedAt: null, expiresAt: null }, now), true);
  assert.equal(dm.isActive({ endedAt: null, expiresAt: new Date(now.getTime() + 1) }, now), true);
  assert.equal(dm.isActive({ endedAt: null, expiresAt: now }, now), false);
  assert.equal(dm.isActive({ endedAt: new Date(now.getTime() - 1), expiresAt: null }, now), false);
});

test('Pop-up: Daten fürs Fenster', () => {
  assert.equal(dm.popup(null), null);
  const p = dm.popup({ _id: 'abc', title: 'T', text: 'Zeile 1\nZeile 2', byName: 'dev', createdAt: now, left: 3 });
  assert.equal(p.id, 'abc');
  assert.equal(p.text, 'Zeile 1\nZeile 2');
  assert.equal(p.byName, 'dev');
  assert.equal(p.left, 3);
  assert.ok(p.at);
  assert.equal(dm.popup({ _id: 'x', title: 'T', text: 'Text', byName: 'd', createdAt: now }).left, 1);
});
