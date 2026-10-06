const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const avatars = require('../src/profile/avatars');

test('Profilbilder: vier Logo-Varianten, jede Datei vorhanden', () => {
  assert.strictEqual(avatars.AVATARS.length, 4);
  avatars.AVATARS.forEach((a) => assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', a.url)), a.url));
});

test('Profilbilder: unbekannte oder fehlende ID zeigt den Platzhalter', () => {
  assert.strictEqual(avatars.urlOf('logo-silber'), '/img/avatars/logo-silber.svg');
  [null, undefined, '', 'gibt-es-nicht', 'constructor', '__proto__', ['logo-silber']].forEach((id) => assert.strictEqual(avatars.urlOf(id), avatars.PLACEHOLDER));
  assert.ok(!avatars.has('toString'));
});
