process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { cleanBio, togglePin, countTier, profileList, shareText, BIO_MAX } = require('../src/achievements/logic');
const { ACHIEVEMENTS, SPECIAL, REWARD, find } = require('../src/achievements/list');
const icons = require('../src/achievements/icons');

test('Profiltext: Steuerzeichen raus, höchstens eine Leerzeile, 8 Zeilen und 300 Zeichen', () => {
  assert.equal(cleanBio(undefined), '');
  assert.equal(cleanBio({ x: 1 }), '');
  assert.equal(cleanBio('  Hallo\r\nWelt  '), 'Hallo\nWelt');
  assert.equal(cleanBio('a\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(cleanBio('a\u0000b‮c​d'), 'abcd');
  assert.equal(cleanBio(Array.from({ length: 12 }, (_, i) => `z${i}`).join('\n')).split('\n').length, 8);
  assert.equal(Array.from(cleanBio('x'.repeat(400))).length, BIO_MAX);
  // Emojis zählen als ein Zeichen und werden nicht halbiert
  const emo = cleanBio('😀'.repeat(310));
  assert.equal(Array.from(emo).length, BIO_MAX);
  assert.ok(!/[\ud800-\udbff]$/.test(emo));
});

test('Anheften: höchstens zwei, ältester fällt raus, nur eigene Erfolge, zweiter Klick löst', () => {
  const earned = ['a', 'b', 'c'];
  assert.deepEqual(togglePin([], 'a', earned), ['a']);
  assert.deepEqual(togglePin(['a'], 'b', earned), ['a', 'b']);
  assert.deepEqual(togglePin(['a', 'b'], 'c', earned), ['b', 'c']);
  assert.deepEqual(togglePin(['a', 'b'], 'a', earned), ['b']);
  assert.deepEqual(togglePin(['a'], 'fremd', earned), ['a']);
  assert.deepEqual(togglePin(['weg', 'a'], 'b', earned), ['a', 'b']);
  assert.deepEqual(togglePin(null, 'a', earned), ['a']);
});

test('Stufen des Erfolge-Abzeichens', () => {
  assert.equal(countTier(0), 'none');
  assert.equal(countTier(1), 'bronze');
  assert.equal(countTier(3), 'silver');
  assert.equal(countTier(6), 'gold');
  assert.equal(countTier(10), 'mythic');
  assert.equal(shareText(0), '0 %');
  assert.equal(shareText(0.004), '< 1 %');
  assert.equal(shareText(0.256), '26 %');
});

test('Profil-Liste: freigeschaltete zuerst, fremde Einzelstücke unsichtbar, geheime ohne Text', () => {
  const all = [
    { key: 'u', name: 'Unikat', text: 't', unique: true },
    { key: 'a', name: 'A', text: 'ta' },
    { key: 'b', name: 'B', text: 'tb' },
    { key: 's', name: 'Geheim', text: 'ts', secret: true },
  ];
  const rows = profileList(all, [{ key: 'b', earnedAt: new Date('2026-01-02') }, { key: 'a', earnedAt: new Date('2026-01-03') }], { a: 1, b: 2 }, 4);
  assert.deepEqual(rows.map((r) => r.key), ['a', 'b', 's']);
  assert.equal(rows[1].share, 0.5);
  assert.equal(rows[2].name, 'Geheimer Erfolg');
  assert.ok(rows[2].hidden);
  const withUnique = profileList(all, [{ key: 'u', earnedAt: new Date() }, { key: 's', earnedAt: new Date(0) }]);
  assert.equal(withUnique[0].key, 'u');
  assert.equal(withUnique.find((r) => r.key === 's').name, 'Geheim');
});

test('Erfolge-Liste: eindeutige Schlüssel, 100 € Belohnung, Einzelstücke für Hermann, Ömer und Aleks', () => {
  const keys = ACHIEVEMENTS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(REWARD, 10000);
  for (const a of ACHIEVEMENTS) {
    assert.match(a.key, /^[a-z0-9-]+$/);
    assert.ok(a.name && a.text, a.key);
    assert.ok(a.unique ? !a.holders : typeof a.holders === 'function', `${a.key}: Einzelstück ohne Prüfung, sonst mit`);
    assert.ok(icons.GLYPHS[a.icon.glyph], `${a.key}: Symbol fehlt`);
  }
  assert.deepEqual(SPECIAL, [['hermann', 'hermichu-sensei'], ['oemer', 'oemer'], ['aleks', 'kingdom']]);
  for (const [key] of SPECIAL) assert.ok(find(key) && find(key).unique);
  assert.equal(find('__proto__'), null);
  assert.equal(find('constructor'), null);
});

test('Symbole: gültiges SVG ohne Skript, ohne doppelte Attribute und ohne übrige Platzhalter', () => {
  for (const a of ACHIEVEMENTS) {
    const svg = icons.render(a.icon);
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
    assert.ok(!/<script|on\w+=/i.test(svg));
    assert.ok(!/="[FSD]"/.test(svg), a.key);
    for (const tag of svg.match(/<[a-zA-Z][^>]*>/g)) {
      const names = [...tag.matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1]);
      assert.equal(new Set(names).size, names.length, `${a.key}: ${tag}`);
    }
  }
});
