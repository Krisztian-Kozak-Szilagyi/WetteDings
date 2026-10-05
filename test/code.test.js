const test = require('node:test');
const assert = require('node:assert');
const { CODE_TTL_MINUTES, CODE_TTL_OPTIONS, parseTtl, ttlText, remainingText } = require('../src/services/codeService');

test('Einladungscode: nur erlaubte Gültigkeitsdauern, sonst der Standard', () => {
  assert.equal(CODE_TTL_MINUTES, 30);
  for (const m of CODE_TTL_OPTIONS) assert.equal(parseTtl(String(m)), m);
  for (const bad of [undefined, '', 'abc', '0', '-30', '45', '99999', ['60'], { a: 1 }]) assert.equal(parseTtl(bad), 30, String(bad));
});

test('Einladungscode: Dauer und Restlaufzeit als Text', () => {
  assert.deepEqual(CODE_TTL_OPTIONS.map(ttlText), ['30 Minuten', '1 Stunde', '6 Stunden', '1 Tag', '3 Tage', '7 Tage']);
  const now = Date.UTC(2026, 0, 1);
  const at = (min) => new Date(now + min * 60000);
  assert.equal(remainingText(at(12), now), 'noch 12 Min.');
  assert.equal(remainingText(at(-5), now), 'noch 0 Min.');
  assert.equal(remainingText(at(5 * 60), now), 'noch 5 Std.');
  assert.equal(remainingText(at(3 * 1440), now), 'noch 3 Tage');
});
