process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const up = require('../src/tcg/upgrade');
const catalog = require('../src/tcg/catalog');

const S = { ...up.DEFAULTS };
// guter Zufall mit festem Startwert (mulberry32) – einfache LCGs liefern sehr kleine Werte zu oft
const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
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
  // Standardpreise: jede volle Stufe gelingt sicher, nur Holo → Bockhaber (10 × 50 € gegen 500 €) liegt darunter
  for (const r of ['crumpled', 'bfwler', 'gold', 'bockhaber', 'glitch']) assert.equal(up.chanceFor(r, S), 1, r);
  const holo = up.contract(Array.from({ length: 10 }, () => 'holo'), S);
  assert.ok(holo.chance > 0.4 && holo.chance < 0.6, `Holo: ${holo.chance} (der sichere Ausgleich von 400 € kostet Chance)`);
  assert.ok(Math.abs(holo.ev - 0.9 * holo.value) < 1e-6, 'Holo liegt genau an der Wertgrenze (Karte + Ausgleich, Glückstreffer und Jackpot eingerechnet)');
  assert.equal(up.chanceFor('icon', S), 0);
  // Obergrenze greift
  assert.equal(up.chanceFor('crumpled', { ...S, maxChance: 80 }), 0.8);
});

test('Kartenaufwertung: gemischte Seltenheiten – Ziel über der seltensten Karte, deutlich kleinere Chance', () => {
  const n = (k, c) => Array.from({ length: c }, () => k);
  const mixed = up.contract(['gold', ...n('bfwler', 9)], S);
  assert.equal(mixed.top, 'gold');
  assert.equal(mixed.target, 'holo');
  // jede BFWler-Karte zählt nach Pack-Seltenheit nur 1100/2800 einer Gold-Karte
  const w = (k) => catalog.rarityByKey[k].weight;
  assert.ok(Math.abs(mixed.q - (1 + 9 * (w('gold') / w('bfwler'))) / 10) < 1e-9);
  assert.ok(mixed.chance < 0.5 && mixed.chance > 0.4, `1 Gold + 9 BFWler: ${mixed.chance}`);
  assert.ok(up.contract([...n('gold', 5), ...n('bfwler', 5)], S).chance > mixed.chance, 'mehr Gold, mehr Chance');
  assert.ok(up.contract(['gold', ...n('crumpled', 9)], S).chance < mixed.chance, 'Crumpled zählen noch weniger');
  assert.equal(up.contract(n('gold', 10), S).chance, 1);
  // Icon im Vertrag: es gibt nichts darüber
  assert.equal(up.contract(['icon', ...n('gold', 9)], S), null);
  assert.equal(up.contract(['sith', ...n('gold', 9)], S), null);
});

test('Kartenaufwertung: Wertgrenze gilt für jede Mischung – auch mit Glückstreffer und Jackpot', () => {
  const keys = up.ladder().filter((k) => up.nextRarity(k));
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const s of [S, { ...S, rueckgabe: 50, ausgleich: 40 }, { ...S, bonus: 500, jackpot: 200 }, { ...S, count: 5 }, { ...S, ausgleich: 0 }]) {
    for (let i = 0; i < 400; i++) {
      const mix = Array.from({ length: s.count }, () => keys[Math.floor(rand() * keys.length)]);
      const v = up.contract(mix, s);
      assert.ok(v, mix.join(','));
      assert.ok(v.ev <= (s.rueckgabe / 100) * v.value + 1e-6 || v.chance === 0, `${mix.join(',')}: ${v.ev} > ${v.value}`);
      assert.ok(v.ev < v.value, `${mix.join(',')}: nie Gewinn im Mittel (${v.ev} von ${v.value})`);
      assert.ok(v.floor <= v.ev + 1e-6 && v.floor === Math.floor((s.ausgleich / 100) * v.value));
      assert.ok(v.chance >= 0 && v.chance <= s.maxChance / 100);
    }
  }
});

test('Kartenaufwertung: Glückstreffer 0,09 %, Jackpot 0,01 % (Glitch/Icon, nie schlechter als das Ziel)', () => {
  const R = require('../public/js/aufwertung-regeln');
  const ten = Array.from({ length: 10 }, () => 'crumpled');
  const v = up.contract(ten, S);
  assert.equal(v.pBonus, 0.0009);
  assert.equal(v.pJackpot, 0.0001);
  assert.equal(v.bonus, 'gold');
  assert.deepEqual(v.jackpot.map((j) => j.key), ['glitch', 'icon']);
  const rand = mulberry(11);
  const kinds = { erfolg: 0, fehlschlag: 0, bonus: 0, jackpot: 0 };
  const N = 400000;
  for (let i = 0; i < N; i++) {
    const r = R.wurf(ten, v, rand);
    kinds[r.kind]++;
    if (r.kind === 'jackpot') assert.ok(['glitch', 'icon'].includes(r.rarity));
    if (r.kind === 'bonus') assert.equal(r.rarity, 'gold');
  }
  assert.ok(Math.abs(kinds.bonus / N - 0.0009) < 0.0003, `Glückstreffer ${kinds.bonus / N}`);
  assert.ok(Math.abs(kinds.jackpot / N - 0.0001) < 0.0001, `Jackpot ${kinds.jackpot / N}`);
  // Jackpot nie unter dem Ziel: bei Bockhaber → Glitch nur noch Icon, bei Glitch → Icon gar nicht
  assert.deepEqual(up.contract(Array.from({ length: 10 }, () => 'bockhaber'), S).jackpot.map((j) => j.key), ['icon']);
  const g = up.contract(Array.from({ length: 10 }, () => 'glitch'), S);
  assert.equal(g.pJackpot, 0);
  assert.equal(g.bonus, null, 'über Icon gibt es nichts (Sith kommt nie heraus)');
  // Fehlschlag: eine Karte der seltensten eingesetzten Seltenheit
  const mix = ['gold', ...Array.from({ length: 9 }, () => 'bfwler')];
  const vm = up.contract(mix, S);
  for (let i = 0; i < 200; i++) assert.equal(R.wurf(mix, { ...vm, chance: 0, pBonus: 0, pJackpot: 0 }, rand).rarity, 'gold');
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
  assert.deepEqual([S.bonus, S.jackpot], [9, 1], '0,09 % und 0,01 %');
  assert.throws(() => up.cleanSettings({ ...S, jackpot: 1001 }), /Jackpot/);
  assert.equal(S.open, false, 'erst nach Freigabe für alle');
  assert.equal(S.count, 10);
  assert.throws(() => up.cleanSettings({ ...S, count: 1 }), /Karten je Aufwertung/);
  assert.throws(() => up.cleanSettings({ ...S, maxChance: 101 }), /Erfolgschance/);
  assert.deepEqual(up.mergeSettings({ count: 'x' }), up.DEFAULTS);
  assert.equal(up.mergeSettings({ fehlend: 5 }).fehlend, 5);
  assert.equal(up.mayUse({ isAdmin: true }), true);
  assert.equal(up.mayUse({ isAdmin: false }), false);
});

test('Kartenaufwertung: Wertausgleich – nie mehr als 20 % Verlust, aber immer weniger als bei der Bank', () => {
  const R = require('../public/js/aufwertung-regeln');
  const sellOf = (k) => catalog.rarityByKey[k].sell;
  const n = (k, c) => Array.from({ length: c }, () => k);
  // 10 BFWler (130 €) → Gold (20 €): 84 € Ausgleich, zusammen 104 € = 80 %
  const v = up.contract(n('bfwler', 10), S);
  assert.equal(v.floor, 10400);
  assert.equal(R.ausgleich(v, sellOf('gold')), 8400);
  assert.equal(R.ausgleich(v, 1000000), 0, 'ist die Karte mehr wert, gibt es keinen Ausgleich');
  // jeder Ausgang zusammen mit dem Ausgleich: mindestens 80 %, mit dem Ausgleich nie über dem Bankwert des Einsatzes
  const rand = mulberry(5);
  const keys = up.ladder().filter((k) => up.nextRarity(k));
  for (let i = 0; i < 3000; i++) {
    const mix = Array.from({ length: 10 }, () => keys[Math.floor(rand() * keys.length)]);
    const c = up.contract(mix, S);
    const w = R.wurf(mix, c, rand);
    const back = sellOf(w.rarity) + R.ausgleich(c, sellOf(w.rarity));
    assert.ok(back >= 0.8 * c.value - 1, `${mix.join(',')} → ${w.rarity}: ${back} von ${c.value}`);
    assert.ok(R.ausgleich(c, sellOf(w.rarity)) < c.value, 'Spielgeld immer unter dem Bankwert');
  }
  // volle Stufen: im Schnitt 80–90 % zurück statt 16–44 %
  for (const r of keys) {
    const c = up.contract(n(r, 10), S);
    assert.ok(c.ev / c.value >= 0.8 - 1e-9 && c.ev / c.value <= 0.9 + 1e-9, `${r}: ${c.ev / c.value}`);
  }
  assert.throws(() => up.cleanSettings({ ...S, ausgleich: 95 }), /Mindestens zurück/);
});
