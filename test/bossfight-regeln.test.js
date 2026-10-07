const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/js/bossfight-regeln.js');

// Feste Zufallszahl: keine Krits, Mischen und Ankündigung vorhersagbar
const rng = () => 0.999;
const held = (id, kosten, ang = 0, sch = 0, hei = 0, effekt = null) => ({ id, name: id, kampf: { typ: 'held', kosten, ang, sch, hei, effekt, fx: 'hieb' } });
const item = (id, kampf) => ({ id, name: id, kampf });

/** Kampf mit genau diesen Karten auf der Hand (Deck sonst leer) */
function kampf(hand, opt = {}) {
  const { s } = R.neu([], { rng, ...opt });
  hand.forEach((c, i) => s.hand.push({ uid: 100 + i, card: c, buffs: [] }));
  s.absicht = { key: 'biss', name: 'Biss', schaden: 20, gift: null, netz: 0, schwer: false, wut: false };
  return s;
}

test('Helden: Energie, Schaden, Block und Heilung', () => {
  const s = kampf([held('a', 2, 10, 6, 5)]);
  s.spieler.hp = 50;
  R.spielen(s, 100);
  assert.strictEqual(s.energie, 1);
  assert.strictEqual(s.boss.hp, 190);
  assert.strictEqual(s.spieler.hp, 55);
  assert.strictEqual(R.vorschau(s).wert, 14); // 20 − 6 Block
  assert.strictEqual(R.spielen(s, 999)[0].t, 'nein');
});

test('Zu wenig Energie: Karte bleibt in der Hand', () => {
  const s = kampf([held('teuer', 4, 50)]);
  const ev = R.spielen(s, 100);
  assert.strictEqual(ev[0].t, 'nein');
  assert.strictEqual(s.hand.length, 1);
  assert.strictEqual(s.boss.hp, s.boss.max);
});

test('Gleiche Karte frischt ihren Effekt auf, statt zu stapeln', () => {
  const fluch = { dot: { name: 'Fluch', schaden: 5, runden: 3 } };
  const s = kampf([held('n', 1, 0, 0, 0, fluch), held('n', 1, 0, 0, 0, fluch), held('b', 0, 0, 8), held('b', 0, 0, 8)]);
  R.spielen(s, 100);
  R.rundeEnde(s); // Fluch tickt: 2 Runden übrig
  assert.strictEqual(s.effekte.find((e) => e.art === 'dot').runden, 2);
  R.spielen(s, 101);
  const dots = s.effekte.filter((e) => e.art === 'dot');
  assert.strictEqual(dots.length, 1);
  assert.strictEqual(dots[0].runden, 3); // wieder volle Dauer, nicht 5
  R.spielen(s, 102);
  R.spielen(s, 103);
  assert.strictEqual(s.effekte.filter((e) => e.art === 'block').length, 1);
  assert.strictEqual(R.vorschau(s).wert, s.absicht.schaden - 8); // Block 8, nicht 16
});

test('Abwehr: erst Schwächung, dann Schild-Prozent, dann Block', () => {
  const s = kampf([held('frost', 0, 0, 0, 0, { schwaechen: 50 }), held('block', 0, 0, 3), item('schild', { typ: 'schild', haende: 1, schutz: 20, haltbarkeit: 2 })]);
  s.absicht.schaden = 40;
  R.spielen(s, 100);
  R.spielen(s, 101);
  R.spielen(s, 102);
  assert.strictEqual(R.vorschau(s).wert, 13); // 40 → 20 → 16 → 13
  const ev = R.rundeEnde(s);
  assert.strictEqual(s.spieler.hp, 87);
  assert.ok(!ev.some((e) => e.t === 'zerbrochen'));
  assert.strictEqual(s.effekte.filter((e) => e.art === 'block' || e.art === 'schwach').length, 0); // nur für einen Angriff
  R.rundeEnde(s);
  assert.strictEqual(s.gear.length, 0); // Holzschild nach 2 Treffern zerbrochen
});

test('Druide stärkt eine gewählte Karte (gleicher Druide stapelt nicht)', () => {
  const druide = held('druide', 1, 0, 0, 0, { staerken: { ang: 5, kosten: 1 } });
  const s = kampf([druide, druide, held('ziel', 2, 10)]);
  assert.strictEqual(R.spielbar(s, 100).ziel, true);
  assert.strictEqual(R.spielen(s, 100)[0].t, 'nein'); // ohne Ziel geht es nicht
  R.spielen(s, 100, 102);
  R.spielen(s, 101, 102);
  const ziel = s.hand.find((i) => i.uid === 102);
  assert.strictEqual(R.buffSumme(ziel, 'ang'), 5);
  assert.strictEqual(R.kosten(s, ziel), 1);
  R.spielen(s, 102);
  assert.strictEqual(s.boss.hp, s.boss.max - 15);
});

test('Waffen: einmal pro Runde, Tauschen bringt keinen zweiten Angriff', () => {
  const schwert = item('schwert', { typ: 'waffe', haende: 1, schaden: 5 });
  const s = kampf([schwert, item('schwert2', { typ: 'waffe', haende: 1, schaden: 5 }), item('axt', { typ: 'waffe', haende: 2, schaden: 9 })]);
  R.spielen(s, 100);
  R.einsetzen(s, 100);
  assert.deepStrictEqual(R.einsetzen(s, 100), []); // schon benutzt
  R.spielen(s, 102); // Axt verdrängt das benutzte Schwert → erbt "benutzt"
  assert.strictEqual(s.gear.length, 1);
  assert.strictEqual(s.gear[0].used, true);
  assert.strictEqual(s.boss.hp, s.boss.max - 5);
  assert.strictEqual(s.energie, 0);
});

test('Nachladen und Fluch treffen zu Rundenbeginn, Gift trifft den Spieler', () => {
  const s = kampf([held('ballista', 0, 30, 0, 0, { verzoegert: true })]);
  s.absicht = { key: 'giftbiss', name: 'Giftbiss', schaden: 5, gift: { schaden: 3, runden: 2 }, netz: 0, schwer: false, wut: false };
  R.spielen(s, 100);
  assert.strictEqual(s.boss.hp, s.boss.max);
  R.rundeEnde(s);
  assert.strictEqual(s.boss.hp, s.boss.max - 30);
  assert.strictEqual(s.spieler.hp, 100 - 5 - 3); // Biss + erste Runde Gift
});

test('Sieg und Niederlage beenden den Kampf', () => {
  const s = kampf([held('riesig', 0, 999)]);
  const ev = R.spielen(s, 100);
  assert.strictEqual(s.vorbei, 'sieg');
  assert.ok(ev.some((e) => e.t === 'ende' && e.sieg));
  const t = kampf([]);
  t.spieler.hp = 5;
  R.rundeEnde(t);
  assert.strictEqual(t.vorbei, 'niederlage');
});

test('Alle Test-Karten haben gültige Kampfwerte', () => {
  const CD = require('../src/tcg/cardData.js');
  const karten = Object.entries(CD).filter(([, d]) => d.kampf);
  assert.ok(karten.length >= 23);
  for (const [id, d] of karten) {
    const k = d.kampf;
    assert.ok(['held', 'waffe', 'zauber', 'schild'].includes(k.typ), id);
    if (k.typ === 'held') assert.ok(k.kosten >= 0 && k.kosten <= R.SPIELER.energie, `${id}: Kosten`);
    assert.ok(d.ability && !/undefined|NaN/.test(d.ability), `${id}: Kartentext`);
  }
});
