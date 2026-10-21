process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const cardSvg = require('../src/tcg/cardSvg');
const FRAMES = require('../src/tcg/frames');
const { KLASSEN, klasseByKey } = require('../src/tcg/klassen');

// Neues Design = Vollbild-Rahmen des Overhauls (rar-<seltenheit>) oder das Vorbild St. Ivan (gilded); Spells (ohne
// Wertefenster) behalten ihre Plakette. Jede dieser Karten MUSS eine Klasse und die neuen Werte haben.
const NEW_DESIGN = (c) => !!c.frame && (c.frame === 'gilded' || (c.frame.startsWith('rar-') && !c.frame.endsWith('-spell')));
const all = Object.values(catalog.cardById);
const strip = (svg) => svg.replace(/<image[^>]*\/>/, '');

test('Meta-Patch: drei Klassen – Tank, Schaden, Heiler', () => {
  assert.deepEqual(KLASSEN.map((k) => k.key), ['tank', 'schaden', 'heiler']);
  for (const k of KLASSEN) assert.ok(k.name && k.icon, k.key);
});

test('Meta-Patch: jede Karte im neuen Design hat eine Klasse und Angriff / Leben / Kosten', () => {
  const cards = all.filter(NEW_DESIGN);
  assert.ok(cards.length >= 25, 'Overhaul-Karten fehlen');
  for (const c of cards) {
    assert.ok(klasseByKey[c.klasse], `${c.id}: Klasse fehlt oder unbekannt (${c.klasse})`);
    assert.ok(c.werte, `${c.id}: werte fehlen`);
    for (const k of ['ang', 'leb', 'kosten']) assert.ok(Number.isInteger(c.werte[k]) && c.werte[k] >= 0, `${c.id}: werte.${k}`);
  }
});

test('Meta-Patch: Kosten in der Plakette, Klasse im dritten Fenster, keine FIA / FIS / BWL und kein Speed', () => {
  const c = catalog.cardById['aleks-5-bockhaber'];
  const svg = strip(cardSvg.render(c));
  assert.ok(svg.includes(`>${klasseByKey[c.klasse].name.toUpperCase()}<`), 'Klassen-Name im dritten Fenster');
  assert.ok(!/>FIA<|>FIS<|>BWL</.test(svg), 'keine alten Bezeichnungen');
  assert.ok(!svg.includes('M13 2 3 14h7l-1 8 10-12h-7l1-8z'), 'kein Speed-Blitz');
  for (const v of [c.werte.ang, c.werte.leb, c.werte.kosten]) assert.ok(svg.includes(`>${v}</text>`), `Wert ${v}`);
  // Farben der Seltenheit (Bockhaber): Plakette und Symbole
  const col = FRAMES['rar-bockhaber'].colors;
  assert.ok(svg.includes(`fill="${col.plate}" stroke="${col.plateBorder}"`) && svg.includes(`fill="${col.label}"`));
  // jede Klasse lässt sich zeichnen
  for (const k of KLASSEN) assert.ok(strip(cardSvg.render({ ...c, klasse: k.key })).includes(`>${k.name.toUpperCase()}<`), k.key);
});
