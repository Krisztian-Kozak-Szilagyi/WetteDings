process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const up = require('../src/tcg/upgrade');
const catalog = require('../src/tcg/catalog');

const S = { ...up.DEFAULTS };
const sell = (r) => catalog.rarityByKey[r].sell;

test('Kartenaufwertung: Stufen von Crumpled bis Icon – Sith und Boss-Karten weder als Einsatz noch als Ergebnis', () => {
  assert.deepEqual(up.ladder(), ['crumpled', 'bfwler', 'gold', 'holo', 'bockhaber', 'glitch', 'icon']);
  assert.equal(up.nextRarity('crumpled'), 'bfwler');
  assert.equal(up.nextRarity('glitch'), 'icon');
  assert.equal(up.nextRarity('icon'), null, 'Icon ist die oberste Stufe (Sith kommt nie heraus)');
  assert.equal(up.nextRarity('sith'), null);
  assert.equal(up.nextRarity('boss'), null);
  for (const r of up.ladder()) {
    const pool = up.poolOf(r);
    assert.ok(pool.length, `${r}: Karten vorhanden`);
    assert.ok(pool.every((c) => c.rarity === r));
    assert.ok(!pool.some((c) => c.id === 'st-ivan-boss' || c.rarity === 'sith' || c.rarity === 'boss'));
  }
  assert.deepEqual(up.poolOf('sith'), []);
  assert.deepEqual(up.poolOf('boss'), []);
});

test('Kartenaufwertung: faire Chance – im Mittel höchstens 90 % des Einsatzwerts zurück, sonst 100 % wie in Counter-Strike', () => {
  // Standardpreise: jede Stufe gelingt sicher, nur Holo → Bockhaber (10 × 50 € gegen 500 €) liegt darunter
  for (const r of ['crumpled', 'bfwler', 'gold', 'bockhaber', 'glitch']) assert.equal(up.chanceFor(r, S), 1, r);
  const holo = up.chanceFor('holo', S);
  assert.ok(Math.abs(holo - (0.9 * 10 * 50 - 50) / (500 - 50)) < 1e-9 && holo < 0.9, `Holo: ${holo}`);
  assert.equal(up.chanceFor('icon', S), 0);
  // Wert erhalten: der erwartete Wert der neuen Karte ist nie höher als rueckgabe % des Einsatzes – eine
  // aufgewertete Karte ist so nie billiger zu haben als ihr Wert
  for (const s of [S, { ...S, rueckgabe: 50 }, { ...S, maxChance: 60 }, { ...S, count: 5 }]) {
    for (const r of up.ladder().filter((x) => up.nextRarity(x))) {
      const p = up.chanceFor(r, s);
      const ev = p * sell(up.nextRarity(r)) + (1 - p) * sell(r);
      assert.ok(ev <= (s.rueckgabe / 100) * s.count * sell(r) + 1e-6 || p === 0, `${r} mit ${JSON.stringify(s)}: ${ev}`);
      assert.ok(p >= 0 && p <= s.maxChance / 100);
    }
  }
  // Obergrenze greift
  assert.equal(up.chanceFor('crumpled', { ...S, maxChance: 80 }), 0.8);
});

test('Kartenaufwertung: fehlende Karten kommen fehlend-fach so oft', () => {
  const pool = up.poolOf('holo');
  const owned = new Set(pool.slice(1).map((c) => c.id)); // nur die erste fehlt
  const odds = up.oddsOf(pool, owned, 3);
  const missing = odds.find((o) => o.missing);
  const other = odds.find((o) => !o.missing);
  assert.ok(Math.abs(missing.p / other.p - 3) < 1e-9);
  assert.ok(Math.abs(odds.reduce((s, o) => s + o.p, 0) - 1) < 1e-9);
  // Ziehen folgt den Gewichten
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let hits = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (up.pickCard(pool, owned, 3, rand).missing) hits++;
  assert.ok(Math.abs(hits / N - missing.p) < 0.01, `fehlende Karte ${hits / N} statt ${missing.p}`);
  // ohne Fehlende: gleich verteilt
  assert.ok(up.oddsOf(pool, new Set(pool.map((c) => c.id)), 3).every((o) => Math.abs(o.p - 1 / pool.length) < 1e-9));
});

test('Kartenaufwertung: Einstellungen prüfen, ungültige Speicherstände fallen auf den Standard zurück', () => {
  assert.deepEqual(up.cleanSettings(S), S);
  assert.equal(S.open, false, 'erst nach Freigabe für alle');
  assert.equal(S.count, 10);
  assert.throws(() => up.cleanSettings({ ...S, count: 1 }), /Karten je Aufwertung/);
  assert.throws(() => up.cleanSettings({ ...S, maxChance: 101 }), /Erfolgschance/);
  assert.deepEqual(up.mergeSettings({ count: 'x' }), up.DEFAULTS);
  assert.equal(up.mergeSettings({ fehlend: 5 }).fehlend, 5);
  assert.equal(up.mayUse({ isAdmin: true }), true);
  assert.equal(up.mayUse({ isAdmin: false }), false);
});
