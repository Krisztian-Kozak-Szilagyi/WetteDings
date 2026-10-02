// ADMIN_USERNAMES muss vor dem ersten require stehen – config liest es beim Laden ein
process.env.ADMIN_USERNAMES = 'Szkep, zweitadmin';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { NAME_HINT, RESERVED_HINT, isReserved, assertUsernameAllowed } = require('../src/services/usernameRules');
const { UserError } = require('../src/lib/util');

const rejects = (name, re) => assert.throws(() => assertUsernameAllowed(name), (err) => err instanceof UserError && re.test(err.message));

test('Admin-Namen sind gesperrt – egal in welcher Schreibweise', () => {
  // An ADMIN_USERNAMES hängen die Admin-Rechte: wer sich so nennen darf, ist Admin
  for (const name of ['Szkep', 'szkep', 'SZKEP', 'sZkEp', '  Szkep  ']) {
    assert.equal(isReserved(name), true, name);
    rejects(name, /nicht verfügbar/);
  }
  // jeder Eintrag der Liste, nicht nur der erste
  assert.equal(isReserved('zweitadmin'), true);
  rejects('ZweitAdmin', /nicht verfügbar/);
});

test('Namen gelöschter Konten sind gesperrt', () => {
  assert.equal(isReserved('geloescht-a1b2c3d4'), true);
  rejects('geloescht-a1b2c3d4', /nicht verfügbar/);
  rejects('GELOESCHT-12345678', /nicht verfügbar/);
  // nur das Präfix ist gesperrt, das Wort im Namen nicht
  assert.equal(isReserved('geloescht'), false);
  assert.equal(isReserved('ungeloescht-1'), false);
});

test('Normale Namen gehen durch und kommen getrimmt zurück', () => {
  assert.equal(assertUsernameAllowed('anna'), 'anna');
  assert.equal(assertUsernameAllowed('  ben  '), 'ben');
  assert.equal(assertUsernameAllowed('Carla_1.2-3'), 'Carla_1.2-3');
  assert.equal(assertUsernameAllowed('abc'), 'abc'); // Mindestlänge
  assert.equal(assertUsernameAllowed('a'.repeat(20)), 'a'.repeat(20)); // Höchstlänge
  assert.equal(isReserved('anna'), false);
});

test('Mustergrenzen und fehlende Eingaben', () => {
  rejects('ab', new RegExp(NAME_HINT.slice(0, 20)));
  rejects('a'.repeat(21), /3–20 Zeichen/);
  rejects('mit leerzeichen', /3–20 Zeichen/);
  rejects('umlaut-ä', /3–20 Zeichen/);
  rejects('kein<script>', /3–20 Zeichen/);
  rejects('', /3–20 Zeichen/);
  rejects(null, /3–20 Zeichen/);
  rejects(undefined, /3–20 Zeichen/);
  rejects(['anna'], /3–20 Zeichen/); // doppeltes Formularfeld
  rejects({ toString: () => 'anna' }, /3–20 Zeichen/);
  // isReserved bleibt auch bei Unsinn beantwortbar
  assert.equal(isReserved(null), false);
  assert.equal(isReserved(undefined), false);
});

test('Das Muster wird vor der Sperrliste geprüft', () => {
  // ein zu langer Name nennt die Längenregel, nicht die Sperre
  rejects('szkep' + 'x'.repeat(20), /3–20 Zeichen/);
  assert.notEqual(NAME_HINT, RESERVED_HINT);
});
