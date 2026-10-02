const test = require('node:test');
const assert = require('node:assert');
const { isLocalUrl, safeRedirect } = require('../src/lib/util');

test('Weiterleitung nur auf eigene Seiten', () => {
  for (const ok of ['/', '/admin#ban', '/wette/abc?x=1', '/profil/%C3%96mer']) {
    assert.equal(isLocalUrl(ok), true, ok);
    assert.equal(safeRedirect(ok), ok);
  }
  for (const bad of ['', 'konto', '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', undefined, null, ['/a'], { a: 1 }]) {
    assert.equal(isLocalUrl(bad), false, String(bad));
    assert.equal(safeRedirect(bad, '/x'), '/x');
  }
});
